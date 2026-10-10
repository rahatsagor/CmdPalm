//! The input engine: one thread, one source of truth for held input.
//!
//! Invariants that keep combos reliable:
//! * An OS-level key is pressed exactly once no matter how many devices or
//!   code paths hold it (reference counted in `os_keys`), and released only
//!   when the last holder lets go. No code path releases a key it did not
//!   press, so a stray "key up" can never latch tools like Hyperkey.
//! * Every keyboard, mouse and scroll event carries the flags of the
//!   modifiers currently held, so ⌘-click, ⇧-scroll and ⌥-drag work.
//! * Modifiers that a combo needs but are not already held are pressed just
//!   for that combo and released afterwards ("temporary" modifiers).
//! * A device that stops sending heartbeats has all of its input released.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::text::{Segment, segments};
use super::{
    Command, EventSink, Input, Interrupts, LayoutMap, SessionId, Synth, Tuning, TypeMode, momentum_phase, scroll_phase,
};
use crate::keycodes::{self, COMBO_PRESS_ORDER, KEY_CAPS_LOCK, KEY_DELETE, KEY_RETURN, KEY_TAB, KeyCode};
use crate::protocol::{MediaKey, MouseButton, PressOp};

/// Time for apps to observe a modifier change before the key that uses it.
pub const MOD_SETTLE: Duration = Duration::from_millis(8);
/// How long a tapped key stays down. Long enough for apps that poll key state.
pub const TAP_HOLD: Duration = Duration::from_millis(12);
/// Hold time per character when typing text as keystrokes.
pub const KEYSTROKE_HOLD: Duration = Duration::from_millis(2);
/// Gap between Unicode text events; some apps drop characters when flooded.
pub const TEXT_GAP: Duration = Duration::from_millis(2);
/// Release a device's held input when it has been silent this long.
pub const WATCHDOG_TIMEOUT: Duration = Duration::from_millis(3000);
const WATCHDOG_PERIOD: Duration = Duration::from_millis(250);
const MAX_REPEAT: Duration = Duration::from_secs(60);
/// Ended sessions remembered so late input for them is dropped.
const ENDED_MEMORY: usize = 256;
/// End a scroll gesture whose client stopped sending updates.
pub const SCROLL_STALE: Duration = Duration::from_millis(300);
const MOMENTUM_FRAME: Duration = Duration::from_micros(8333);
const MOMENTUM_START_SPEED: f64 = 80.0;
const MOMENTUM_STOP_SPEED: f64 = 12.0;
const MOMENTUM_MAX: Duration = Duration::from_secs(4);
const MOMENTUM_MAX_SPEED: f64 = 12_000.0;
/// How often paced pointer motion is posted (240 Hz).
pub const MOTION_FRAME: Duration = Duration::from_micros(4167);
const PACE_DEFAULT: f64 = 0.016;
const PACE_MIN: f64 = 0.004;
const PACE_MAX: f64 = 0.034;
/// A gap this long means the finger paused; it says nothing about the rate.
const PACE_IDLE: f64 = 0.1;
const CLICK_SLOP: f64 = 5.0;
const MAX_MOTION: f64 = 4_000.0;
const MAX_EDIT_DELETES: u32 = 4_096;
const NOTICE_INTERVAL: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Notice {
    /// Secure Event Input is on (a password field is focused); macOS drops
    /// synthetic keystrokes until it is turned off.
    SecureInput(SessionId),
    /// CmdPalm lacks Accessibility permission, so events are discarded.
    NoPermission(SessionId),
}

/// Handle to the engine thread. Dropping it releases all input and joins.
pub struct InputEngine {
    tx: Sender<Command>,
    interrupts: Arc<Interrupts>,
    thread: Option<JoinHandle<()>>,
}

impl InputEngine {
    pub fn spawn<S, F>(make_sink: F, notify: Box<dyn Fn(Notice) + Send>) -> Self
    where
        S: EventSink,
        F: FnOnce() -> S + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        let interrupts = Arc::new(Interrupts::default());
        let engine_interrupts = interrupts.clone();
        let thread = std::thread::Builder::new()
            .name("cmdpalm-input".into())
            .spawn(move || {
                #[cfg(target_os = "macos")]
                super::mac::raise_thread_qos();
                let mut engine = Engine::new(make_sink(), notify);
                engine.interrupts = engine_interrupts;
                engine.run(rx);
            })
            .expect("failed to spawn the input thread");
        Self { tx, interrupts, thread: Some(thread) }
    }

    pub fn sender(&self) -> Sender<Command> {
        self.tx.clone()
    }

    pub fn interrupts(&self) -> Arc<Interrupts> {
        self.interrupts.clone()
    }

    pub fn send(&self, command: Command) {
        let _ = self.tx.send(command);
    }

    /// Block until every command queued so far has been processed.
    pub fn flush(&self) {
        let (tx, rx) = mpsc::channel();
        if self.tx.send(Command::Flush(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(5));
        }
    }
}

impl Drop for InputEngine {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Session {
    /// Keys this session explicitly holds (down without a matching up).
    keys: BTreeSet<KeyCode>,
    /// Temporary modifiers pressed on behalf of a held key.
    temp: HashMap<KeyCode, Vec<KeyCode>>,
    /// Held mouse buttons and the temporary modifiers pressed for them.
    buttons: Vec<(MouseButton, Vec<KeyCode>)>,
    media: HashSet<MediaKey>,
    last_alive: Instant,
}

impl Session {
    fn new(now: Instant) -> Self {
        Self {
            keys: BTreeSet::new(),
            temp: HashMap::new(),
            buttons: Vec::new(),
            media: HashSet::new(),
            last_alive: now,
        }
    }

    fn holds_anything(&self) -> bool {
        !self.keys.is_empty() || !self.buttons.is_empty() || !self.media.is_empty()
    }
}

struct Repeat {
    session: SessionId,
    code: KeyCode,
    next: Instant,
    /// Repeat ends here even if the key is still held, so a lost key-up
    /// can't keep deleting text forever.
    until: Instant,
}

#[derive(Default)]
struct ClickTracker {
    button: Option<MouseButton>,
    at: Option<Instant>,
    pos: (f64, f64),
    count: i64,
}

impl ClickTracker {
    fn register(&mut self, button: MouseButton, pos: (f64, f64), now: Instant, interval: Duration) -> i64 {
        let continues = self.button == Some(button)
            && self.at.is_some_and(|at| now.duration_since(at) <= interval)
            && (pos.0 - self.pos.0).hypot(pos.1 - self.pos.1) <= CLICK_SLOP;
        self.count = if continues { self.count + 1 } else { 1 };
        self.button = Some(button);
        self.at = Some(now);
        self.pos = pos;
        self.count
    }

    fn current(&self, button: MouseButton) -> i64 {
        if self.button == Some(button) { self.count.max(1) } else { 1 }
    }
}

struct ScrollGesture {
    session: SessionId,
    last: Instant,
}

struct Momentum {
    vx: f64,
    vy: f64,
    last: Instant,
    started_at: Instant,
    began: bool,
}

/// Spreads each motion packet over the time until the next one is expected.
///
/// Wi-Fi delivers packets unevenly: two can land together and then none for
/// a frame. Posting each one as a single jump makes the cursor stutter even
/// when the finger moves steadily. Pacing adds roughly one packet interval
/// of delay (8–16 ms) and gives an even glide.
struct MotionPacer {
    remaining: (f64, f64),
    last_emit: Instant,
    deadline: Instant,
    last_input: Option<Instant>,
    /// Estimated seconds between packets.
    interval: f64,
}

impl MotionPacer {
    fn new(now: Instant) -> Self {
        Self { remaining: (0.0, 0.0), last_emit: now, deadline: now, last_input: None, interval: PACE_DEFAULT }
    }

    fn idle(&self) -> bool {
        self.remaining == (0.0, 0.0)
    }

    /// Queue a packet. Call `advance(now)` first so earlier motion keeps its pace.
    fn push(&mut self, dx: f64, dy: f64, now: Instant) {
        if let Some(last) = self.last_input {
            let gap = now.duration_since(last).as_secs_f64();
            if gap < PACE_IDLE {
                self.interval = (self.interval * 0.8 + gap * 0.2).clamp(PACE_MIN, PACE_MAX);
            }
        }
        self.last_input = Some(now);
        self.remaining.0 += dx;
        self.remaining.1 += dy;
        self.last_emit = now;
        self.deadline = now + Duration::from_secs_f64(self.interval);
    }

    /// Motion due by `now`.
    fn advance(&mut self, now: Instant) -> Option<(f64, f64)> {
        if self.idle() || now <= self.last_emit {
            return None;
        }
        let step = if now >= self.deadline {
            self.remaining
        } else {
            let span = self.deadline.duration_since(self.last_emit).as_secs_f64();
            let frac = now.duration_since(self.last_emit).as_secs_f64() / span;
            (self.remaining.0 * frac, self.remaining.1 * frac)
        };
        self.remaining.0 -= step.0;
        self.remaining.1 -= step.1;
        if now >= self.deadline {
            self.remaining = (0.0, 0.0);
        }
        self.last_emit = now;
        Some(step)
    }

    fn take(&mut self) -> Option<(f64, f64)> {
        if self.idle() {
            return None;
        }
        Some(std::mem::replace(&mut self.remaining, (0.0, 0.0)))
    }

    fn next_emit(&self) -> Option<Instant> {
        (!self.idle()).then(|| (self.last_emit + MOTION_FRAME).min(self.deadline))
    }
}

pub(crate) struct Engine<S: EventSink> {
    pub(crate) sink: S,
    notify: Box<dyn Fn(Notice) + Send>,
    tuning: Tuning,
    layout: LayoutMap,
    paused: bool,
    os_keys: BTreeMap<KeyCode, u32>,
    os_buttons: HashMap<MouseButton, u32>,
    sessions: HashMap<SessionId, Session>,
    repeat: Option<Repeat>,
    clicks: ClickTracker,
    scroll: Option<ScrollGesture>,
    momentum: Option<Momentum>,
    motion: MotionPacer,
    last_watchdog: Instant,
    last_notice: HashMap<Notice, Instant>,
    ended: VecDeque<SessionId>,
    pub(crate) interrupts: Arc<Interrupts>,
}

impl<S: EventSink> Engine<S> {
    pub(crate) fn new(sink: S, notify: Box<dyn Fn(Notice) + Send>) -> Self {
        Self {
            interrupts: Arc::new(Interrupts::default()),
            sink,
            notify,
            tuning: Tuning::default(),
            layout: LayoutMap::default(),
            paused: false,
            os_keys: BTreeMap::new(),
            os_buttons: HashMap::new(),
            sessions: HashMap::new(),
            repeat: None,
            clicks: ClickTracker::default(),
            scroll: None,
            momentum: None,
            motion: MotionPacer::new(Instant::now()),
            last_watchdog: Instant::now(),
            last_notice: HashMap::new(),
            ended: VecDeque::new(),
        }
    }

    fn run(&mut self, rx: Receiver<Command>) {
        loop {
            let now = Instant::now();
            let wait = self
                .next_deadline(now)
                .map(|deadline| deadline.saturating_duration_since(now))
                .unwrap_or(Duration::from_secs(1));
            match rx.recv_timeout(wait) {
                Ok(command) => {
                    if !self.handle(command, Instant::now()) {
                        break;
                    }
                    // Drain bursts (e.g. pointer moves) before running timers.
                    while let Ok(command) = rx.try_recv() {
                        if !self.handle(command, Instant::now()) {
                            self.release_everything();
                            return;
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            self.tick(Instant::now());
        }
        self.release_everything();
    }

    fn next_deadline(&self, now: Instant) -> Option<Instant> {
        let mut deadline: Option<Instant> = None;
        let mut consider = |at: Instant| {
            deadline = Some(deadline.map_or(at, |d| d.min(at)));
        };
        if let Some(repeat) = &self.repeat {
            consider(repeat.next);
        }
        if let Some(momentum) = &self.momentum {
            consider(momentum.last + MOMENTUM_FRAME);
        }
        if let Some(at) = self.motion.next_emit() {
            consider(at);
        }
        if let Some(scroll) = &self.scroll {
            consider(scroll.last + SCROLL_STALE);
        }
        if self.sessions.values().any(Session::holds_anything) {
            consider((self.last_watchdog + WATCHDOG_PERIOD).max(now));
        }
        deadline
    }

    /// Returns `false` when the engine should stop.
    pub(crate) fn handle(&mut self, command: Command, now: Instant) -> bool {
        match command {
            // A deck action can still be finishing after its device left.
            Command::Input { session, .. } | Command::Alive(session) if self.ended.contains(&session) => {}
            Command::Input { session, input } => {
                self.alive(session, now);
                self.input(session, input, now);
            }
            Command::Alive(session) => self.alive(session, now),
            Command::EndSession(session) => {
                if self.ended.len() >= ENDED_MEMORY {
                    self.ended.pop_front();
                }
                self.ended.push_back(session);
                // Finish the motion first, so a drag ends where the finger did.
                if !self.paused
                    && let Some((dx, dy)) = self.motion.take()
                {
                    self.post_move(dx, dy);
                }
                self.release_session(session);
                self.sessions.remove(&session);
                self.interrupts.forget(session);
                self.last_notice.retain(|notice, _| match notice {
                    Notice::SecureInput(id) | Notice::NoPermission(id) => *id != session,
                });
            }
            Command::SetPaused(paused) => {
                if paused && !self.paused {
                    self.motion.take();
                    self.release_everything();
                }
                self.paused = paused;
            }
            Command::Tuning(tuning) => self.tuning = tuning,
            Command::Layout(layout) => self.layout = layout,
            Command::Flush(reply) => {
                let _ = reply.send(());
            }
            Command::Shutdown => return false,
        }
        true
    }

    fn alive(&mut self, session: SessionId, now: Instant) {
        self.sessions.entry(session).or_insert_with(|| Session::new(now)).last_alive = now;
    }

    pub(crate) fn tick(&mut self, now: Instant) {
        if let Some((dx, dy)) = self.motion.advance(now) {
            self.post_move(dx, dy);
        }
        self.tick_repeat(now);
        self.tick_momentum(now);
        if let Some(scroll) = &self.scroll
            && now.duration_since(scroll.last) >= SCROLL_STALE
        {
            self.scroll = None;
            self.post_scroll(0.0, 0.0, scroll_phase::ENDED, momentum_phase::NONE);
        }
        if now.duration_since(self.last_watchdog) >= WATCHDOG_PERIOD {
            self.last_watchdog = now;
            let stale: Vec<SessionId> = self
                .sessions
                .iter()
                .filter(|(_, s)| s.holds_anything() && now.duration_since(s.last_alive) >= WATCHDOG_TIMEOUT)
                .map(|(id, _)| *id)
                .collect();
            for session in stale {
                tracing::warn!(session, "device went silent while holding input; releasing it");
                self.release_session(session);
            }
        }
    }

    fn input(&mut self, session: SessionId, input: Input, now: Instant) {
        if self.paused && input != Input::ReleaseAll {
            return;
        }
        // Clicks, keys and scrolls act where the pointer is meant to be now.
        if !matches!(input, Input::Move { .. })
            && let Some((dx, dy)) = self.motion.take()
        {
            self.post_move(dx, dy);
        }
        if !matches!(input, Input::ReleaseAll | Input::Touch) && !self.sink.can_post() {
            self.notice(Notice::NoPermission(session), now);
        }
        if matches!(
            input,
            Input::Key { down: true, .. }
                | Input::Tap { .. }
                | Input::CharTap { .. }
                | Input::Text { .. }
                | Input::Edit { .. }
        ) && self.sink.secure_input()
        {
            self.notice(Notice::SecureInput(session), now);
        }

        match input {
            Input::Key { code, down: true, mods, repeat } => self.key_down(session, code, mods, repeat, now),
            Input::Key { code, down: false, .. } => self.key_up(session, code),
            Input::Tap { code, mods } => self.tap(code, mods, TAP_HOLD),
            Input::CharTap { ch, fallback, mods } => {
                let code = self.resolve_char(ch).unwrap_or(fallback);
                self.tap(code, mods, TAP_HOLD);
            }
            Input::Button { button, op: PressOp::Down, mods } => self.button_down(session, button, mods, now),
            Input::Button { button, op: PressOp::Up, .. } => self.button_up(session, button),
            Input::Button { button, op: PressOp::Click, mods } => self.click(button, 1, mods, now),
            Input::Click { button, clicks, mods } => self.click(button, clicks, mods, now),
            Input::Move { dx, dy } => self.pointer_move(dx, dy, now),
            Input::Scroll { phase, dx, dy } => self.scroll(session, phase, dx, dy, now),
            Input::Fling { vx, vy } => self.fling(vx, vy, now),
            Input::Touch => self.stop_momentum(),
            Input::Media { key, op } => self.media(session, key, op),
            Input::Text { text, mode } => self.type_text(session, &text, mode),
            Input::Edit { delete, insert } => {
                for _ in 0..delete.min(MAX_EDIT_DELETES) {
                    if self.interrupts.should_stop(session) {
                        return;
                    }
                    self.tap(KEY_DELETE, 0, KEYSTROKE_HOLD);
                }
                self.type_text(session, &insert, TypeMode::Unicode);
            }
            Input::ToggleCapsLock => self.sink.post(Synth::ToggleCapsLock),
            Input::ReleaseAll => self.release_session(session),
        }
    }

    fn notice(&mut self, notice: Notice, now: Instant) {
        let due = self.last_notice.get(&notice).is_none_or(|at| now.duration_since(*at) >= NOTICE_INTERVAL);
        if due {
            self.last_notice.insert(notice, now);
            (self.notify)(notice);
        }
    }

    fn flags(&self) -> u64 {
        self.os_keys.keys().filter_map(|code| keycodes::modifier(*code)).fold(0, |acc, m| acc | m.flags)
    }

    fn held_wire_mods(&self) -> u8 {
        self.os_keys.keys().filter_map(|code| keycodes::modifier(*code)).fold(0, |acc, m| acc | m.wire)
    }

    fn press(&mut self, code: KeyCode) {
        let count = self.os_keys.entry(code).or_insert(0);
        *count += 1;
        if *count > 1 {
            return;
        }
        let event = if keycodes::is_modifier(code) {
            Synth::Flags { code, flags: self.flags() }
        } else {
            Synth::Key { code, down: true, flags: self.flags() | keycodes::intrinsic_flags(code), repeat: false }
        };
        self.sink.post(event);
    }

    fn release(&mut self, code: KeyCode) {
        let Some(count) = self.os_keys.get_mut(&code) else {
            return;
        };
        *count -= 1;
        if *count > 0 {
            return;
        }
        self.os_keys.remove(&code);
        let event = if keycodes::is_modifier(code) {
            Synth::Flags { code, flags: self.flags() }
        } else {
            Synth::Key { code, down: false, flags: self.flags() | keycodes::intrinsic_flags(code), repeat: false }
        };
        self.sink.post(event);
    }

    /// Press the modifiers in `mods` that are not already held.
    fn press_temp_mods(&mut self, mods: u8) -> Vec<KeyCode> {
        let missing = mods & keycodes::mods::ALL & !self.held_wire_mods();
        let mut pressed = Vec::new();
        for (bit, code) in COMBO_PRESS_ORDER {
            if missing & bit != 0 {
                self.press(code);
                pressed.push(code);
            }
        }
        if !pressed.is_empty() {
            self.sink.post(Synth::Pause(MOD_SETTLE));
        }
        pressed
    }

    fn release_temp_mods(&mut self, pressed: Vec<KeyCode>) {
        if pressed.is_empty() {
            return;
        }
        self.sink.post(Synth::Pause(MOD_SETTLE));
        for code in pressed.into_iter().rev() {
            self.release(code);
        }
    }

    fn key_down(&mut self, session: SessionId, code: KeyCode, mods: u8, repeat: bool, now: Instant) {
        if code == KEY_CAPS_LOCK {
            self.sink.post(Synth::ToggleCapsLock);
            return;
        }
        let Some(state) = self.sessions.get(&session) else {
            return;
        };
        if state.keys.contains(&code) {
            return;
        }
        if keycodes::is_modifier(code) {
            self.press(code);
        } else {
            let temp = self.press_temp_mods(mods);
            self.press(code);
            if !temp.is_empty() {
                self.session(session, now).temp.insert(code, temp);
            }
            self.repeat = repeat.then(|| Repeat {
                session,
                code,
                next: now + self.tuning.key_repeat_delay,
                until: now + MAX_REPEAT,
            });
        }
        self.session(session, now).keys.insert(code);
    }

    fn key_up(&mut self, session: SessionId, code: KeyCode) {
        let Some(state) = self.sessions.get_mut(&session) else {
            return;
        };
        if !state.keys.remove(&code) {
            return;
        }
        let temp = state.temp.remove(&code).unwrap_or_default();
        if self.repeat.as_ref().is_some_and(|r| r.session == session && r.code == code) {
            self.repeat = None;
        }
        self.release(code);
        self.release_temp_mods(temp);
    }

    fn tap(&mut self, code: KeyCode, mods: u8, hold: Duration) {
        if code == KEY_CAPS_LOCK {
            self.sink.post(Synth::ToggleCapsLock);
            return;
        }
        // A new key press stops auto-repeat of the previous one, as on hardware.
        self.repeat = None;
        let temp = if keycodes::is_modifier(code) { Vec::new() } else { self.press_temp_mods(mods) };
        self.press(code);
        self.sink.post(Synth::Pause(hold));
        self.release(code);
        self.release_temp_mods(temp);
    }

    fn resolve_char(&self, ch: char) -> Option<KeyCode> {
        let lower = ch.to_lowercase().next().unwrap_or(ch);
        match self.layout.chars.get(&lower) {
            Some((code, 0)) => Some(*code),
            _ => None,
        }
    }

    fn tick_repeat(&mut self, now: Instant) {
        let interval = self.tuning.key_repeat_interval.max(Duration::from_millis(15));
        let Some(repeat) = &mut self.repeat else {
            return;
        };
        if now < repeat.next {
            return;
        }
        if now >= repeat.until {
            self.repeat = None;
            return;
        }
        let code = repeat.code;
        // Never replay a burst after a stall; keep cadence from now.
        repeat.next =
            if now.duration_since(repeat.next) > interval * 3 { now + interval } else { repeat.next + interval };
        let flags = self.flags() | keycodes::intrinsic_flags(code);
        self.sink.post(Synth::Key { code, down: true, flags, repeat: true });
    }

    /// Long text can take minutes to type, so stop between pieces when the
    /// session ends or input is paused.
    fn type_text(&mut self, session: SessionId, text: &str, mode: TypeMode) {
        self.repeat = None;
        let mut first = true;
        for segment in segments(text) {
            if self.interrupts.should_stop(session) {
                return;
            }
            if !first {
                self.sink.post(Synth::Pause(TEXT_GAP));
            }
            first = false;
            match segment {
                Segment::Return => self.tap(KEY_RETURN, 0, KEYSTROKE_HOLD),
                Segment::Tab => self.tap(KEY_TAB, 0, KEYSTROKE_HOLD),
                Segment::Text(chunk) if mode == TypeMode::Keystrokes => {
                    let mut pending = String::new();
                    for ch in chunk.chars() {
                        if self.interrupts.should_stop(session) {
                            return;
                        }
                        match self.layout.chars.get(&ch).copied() {
                            Some((code, mods)) => {
                                if !pending.is_empty() {
                                    self.sink.post(Synth::Text { text: std::mem::take(&mut pending) });
                                }
                                self.tap(code, mods, KEYSTROKE_HOLD);
                            }
                            None => pending.push(ch),
                        }
                    }
                    if !pending.is_empty() {
                        self.sink.post(Synth::Text { text: pending });
                    }
                }
                Segment::Text(chunk) => self.sink.post(Synth::Text { text: chunk }),
            }
        }
    }

    fn held_button(&self) -> Option<MouseButton> {
        [MouseButton::Left, MouseButton::Right, MouseButton::Middle, MouseButton::Back, MouseButton::Forward]
            .into_iter()
            .find(|b| self.os_buttons.contains_key(b))
    }

    fn pointer_move(&mut self, dx: f64, dy: f64, now: Instant) {
        if !dx.is_finite() || !dy.is_finite() || (dx == 0.0 && dy == 0.0) {
            return;
        }
        if let Some((x, y)) = self.motion.advance(now) {
            self.post_move(x, y);
        }
        self.motion.push(dx.clamp(-MAX_MOTION, MAX_MOTION), dy.clamp(-MAX_MOTION, MAX_MOTION), now);
    }

    fn post_move(&mut self, dx: f64, dy: f64) {
        if dx == 0.0 && dy == 0.0 {
            return;
        }
        let flags = self.flags();
        let drag = self.held_button();
        self.sink.post(Synth::Move { dx, dy, flags, drag });
    }

    fn button_down(&mut self, session: SessionId, button: MouseButton, mods: u8, now: Instant) {
        let Some(state) = self.sessions.get(&session) else {
            return;
        };
        if state.buttons.iter().any(|(b, _)| *b == button) {
            return;
        }
        let temp = self.press_temp_mods(mods);
        let count = self.os_buttons.entry(button).or_insert(0);
        *count += 1;
        if *count == 1 {
            let pos = self.sink.cursor();
            let clicks = self.clicks.register(button, pos, now, self.tuning.double_click_interval);
            let flags = self.flags();
            self.sink.post(Synth::Button { button, down: true, clicks, flags });
        }
        self.session(session, now).buttons.push((button, temp));
    }

    fn button_up(&mut self, session: SessionId, button: MouseButton) {
        let Some(state) = self.sessions.get_mut(&session) else {
            return;
        };
        let Some(index) = state.buttons.iter().position(|(b, _)| *b == button) else {
            return;
        };
        let (_, temp) = state.buttons.remove(index);
        self.release_button(button);
        self.release_temp_mods(temp);
    }

    fn release_button(&mut self, button: MouseButton) {
        let Some(count) = self.os_buttons.get_mut(&button) else {
            return;
        };
        *count -= 1;
        if *count > 0 {
            return;
        }
        self.os_buttons.remove(&button);
        let clicks = self.clicks.current(button);
        let flags = self.flags();
        self.sink.post(Synth::Button { button, down: false, clicks, flags });
    }

    fn click(&mut self, button: MouseButton, clicks: u8, mods: u8, now: Instant) {
        if self.os_buttons.contains_key(&button) {
            // Already held (e.g. drag lock); a click would release someone else's press.
            return;
        }
        let temp = self.press_temp_mods(mods);
        let flags = self.flags();
        let pos = self.sink.cursor();
        let explicit = i64::from(clicks.clamp(1, 3));
        for n in 1..=explicit {
            let count = if explicit > 1 {
                n
            } else {
                self.clicks.register(button, pos, now, self.tuning.double_click_interval)
            };
            self.sink.post(Synth::Button { button, down: true, clicks: count, flags });
            self.sink.post(Synth::Button { button, down: false, clicks: count, flags });
        }
        if explicit > 1 {
            self.clicks = ClickTracker { button: Some(button), at: Some(now), pos, count: explicit };
        }
        self.release_temp_mods(temp);
    }

    fn post_scroll(&mut self, dx: f64, dy: f64, phase: u8, momentum: u8) {
        let flags = self.flags();
        self.sink.post(Synth::Scroll { dx, dy, phase, momentum, flags });
    }

    fn scroll(&mut self, session: SessionId, phase: u8, dx: f64, dy: f64, now: Instant) {
        if !dx.is_finite() || !dy.is_finite() {
            return;
        }
        let (dx, dy) = (dx.clamp(-MAX_MOTION, MAX_MOTION), dy.clamp(-MAX_MOTION, MAX_MOTION));
        self.stop_momentum();
        match phase {
            scroll_phase::BEGAN | scroll_phase::CHANGED => {
                let phase = if self.scroll.is_some() && phase == scroll_phase::CHANGED {
                    scroll_phase::CHANGED
                } else {
                    scroll_phase::BEGAN
                };
                self.scroll = Some(ScrollGesture { session, last: now });
                self.post_scroll(dx, dy, phase, momentum_phase::NONE);
            }
            scroll_phase::ENDED | scroll_phase::CANCELLED => {
                if self.scroll.take().is_some() {
                    self.post_scroll(0.0, 0.0, phase, momentum_phase::NONE);
                }
            }
            scroll_phase::NONE => self.post_scroll(dx, dy, scroll_phase::NONE, momentum_phase::NONE),
            _ => {}
        }
    }

    fn fling(&mut self, vx: f64, vy: f64, now: Instant) {
        if !vx.is_finite() || !vy.is_finite() {
            return;
        }
        if self.scroll.take().is_some() {
            self.post_scroll(0.0, 0.0, scroll_phase::ENDED, momentum_phase::NONE);
        }
        let speed = vx.hypot(vy);
        if speed < MOMENTUM_START_SPEED {
            return;
        }
        let scale = (MOMENTUM_MAX_SPEED / speed).min(1.0);
        self.momentum = Some(Momentum { vx: vx * scale, vy: vy * scale, last: now, started_at: now, began: false });
    }

    fn stop_momentum(&mut self) {
        if let Some(momentum) = self.momentum.take()
            && momentum.began
        {
            self.post_scroll(0.0, 0.0, scroll_phase::NONE, momentum_phase::END);
        }
    }

    fn tick_momentum(&mut self, now: Instant) {
        let friction = self.tuning.momentum_friction.max(0.1);
        let Some(m) = &mut self.momentum else {
            return;
        };
        let dt = now.duration_since(m.last).as_secs_f64();
        if dt < MOMENTUM_FRAME.as_secs_f64() * 0.5 {
            return;
        }
        m.last = now;
        let decay = (-friction * dt).exp();
        m.vx *= decay;
        m.vy *= decay;
        let speed = m.vx.hypot(m.vy);
        if speed < MOMENTUM_STOP_SPEED || now.duration_since(m.started_at) > MOMENTUM_MAX {
            self.stop_momentum();
            return;
        }
        let (dx, dy) = (m.vx * dt, m.vy * dt);
        let phase = if m.began { momentum_phase::CONTINUE } else { momentum_phase::BEGIN };
        m.began = true;
        self.post_scroll(dx, dy, scroll_phase::NONE, phase);
    }

    fn media(&mut self, session: SessionId, key: MediaKey, op: PressOp) {
        let Some(state) = self.sessions.get_mut(&session) else {
            return;
        };
        match op {
            PressOp::Down => {
                if state.media.insert(key) {
                    self.sink.post(Synth::Media { key, down: true });
                }
            }
            PressOp::Up => {
                if state.media.remove(&key) {
                    self.sink.post(Synth::Media { key, down: false });
                }
            }
            PressOp::Click => {
                if !state.media.contains(&key) {
                    self.sink.post(Synth::Media { key, down: true });
                    self.sink.post(Synth::Media { key, down: false });
                }
            }
        }
    }

    fn session(&mut self, id: SessionId, now: Instant) -> &mut Session {
        self.sessions.entry(id).or_insert_with(|| Session::new(now))
    }

    fn release_session(&mut self, id: SessionId) {
        if self.repeat.as_ref().is_some_and(|r| r.session == id) {
            self.repeat = None;
        }
        if self.scroll.as_ref().is_some_and(|s| s.session == id) {
            self.scroll = None;
            self.post_scroll(0.0, 0.0, scroll_phase::CANCELLED, momentum_phase::NONE);
        }
        let Some(state) = self.sessions.get_mut(&id) else {
            return;
        };
        let keys = std::mem::take(&mut state.keys);
        let mut temp = std::mem::take(&mut state.temp);
        let buttons = std::mem::take(&mut state.buttons);
        let media = std::mem::take(&mut state.media);

        // Ordinary keys first, while their modifiers are still down.
        for code in keys.iter().copied().filter(|c| !keycodes::is_modifier(*c)) {
            self.release(code);
            self.release_temp_mods(temp.remove(&code).unwrap_or_default());
        }
        for (button, temp) in buttons {
            self.release_button(button);
            self.release_temp_mods(temp);
        }
        for key in media {
            self.sink.post(Synth::Media { key, down: false });
        }
        for code in keys.iter().rev().copied().filter(|c| keycodes::is_modifier(*c)) {
            self.release(code);
        }
    }

    fn release_everything(&mut self) {
        self.stop_momentum();
        let ids: Vec<SessionId> = self.sessions.keys().copied().collect();
        for id in ids {
            self.release_session(id);
        }
    }

    #[cfg(test)]
    pub(crate) fn os_keys_held(&self) -> Vec<KeyCode> {
        self.os_keys.keys().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keycodes::{flags as f, mods, *};
    use crate::protocol::{KeyCap, KeyboardLayout};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Recorder {
        events: Vec<Synth>,
        cursor: (f64, f64),
    }

    impl EventSink for Recorder {
        fn post(&mut self, event: Synth) {
            self.events.push(event);
        }
        fn cursor(&mut self) -> (f64, f64) {
            self.cursor
        }
    }

    struct Harness {
        engine: Engine<Recorder>,
        now: Instant,
        notices: Arc<Mutex<Vec<Notice>>>,
    }

    const A: SessionId = 1;
    const B: SessionId = 2;
    const CMD: u64 = f::COMMAND | f::DEVICE_LEFT_COMMAND;
    const SHIFT: u64 = f::SHIFT | f::DEVICE_LEFT_SHIFT;

    impl Harness {
        fn new() -> Self {
            let notices = Arc::new(Mutex::new(Vec::new()));
            let sink_notices = notices.clone();
            let mut h = Self {
                engine: Engine::new(Recorder::default(), Box::new(move |n| sink_notices.lock().unwrap().push(n))),
                now: Instant::now(),
                notices,
            };
            h.cmd(Command::Alive(A));
            h.cmd(Command::Alive(B));
            h
        }
        fn cmd(&mut self, command: Command) {
            self.engine.handle(command, self.now);
        }
        fn input(&mut self, session: SessionId, input: Input) {
            self.cmd(Command::Input { session, input });
        }
        fn key(&mut self, session: SessionId, code: KeyCode, down: bool) {
            self.input(session, Input::Key { code, down, mods: 0, repeat: false });
        }
        fn advance(&mut self, ms: u64) {
            self.now += Duration::from_millis(ms);
            self.engine.tick(self.now);
        }
        /// Events since the last call, without pauses.
        fn take(&mut self) -> Vec<Synth> {
            std::mem::take(&mut self.engine.sink.events).into_iter().filter(|e| !matches!(e, Synth::Pause(_))).collect()
        }
        fn take_raw(&mut self) -> Vec<Synth> {
            std::mem::take(&mut self.engine.sink.events)
        }
    }

    fn flags_ev(code: KeyCode, flags: u64) -> Synth {
        Synth::Flags { code, flags }
    }
    fn key_ev(code: KeyCode, down: bool, flags: u64) -> Synth {
        Synth::Key { code, down, flags, repeat: false }
    }

    #[test]
    fn combo_presses_missing_modifiers_with_settle_time() {
        let mut h = Harness::new();
        h.input(A, Input::Tap { code: KEY_C, mods: mods::COMMAND });
        assert_eq!(
            h.take_raw(),
            vec![
                flags_ev(KEY_COMMAND, CMD),
                Synth::Pause(MOD_SETTLE),
                key_ev(KEY_C, true, CMD),
                Synth::Pause(TAP_HOLD),
                key_ev(KEY_C, false, CMD),
                Synth::Pause(MOD_SETTLE),
                flags_ev(KEY_COMMAND, 0),
            ]
        );
        assert!(h.engine.os_keys_held().is_empty());
    }

    #[test]
    fn multi_modifier_combo_uses_cumulative_flags_and_reverse_release() {
        let mut h = Harness::new();
        h.input(A, Input::Tap { code: KEY_4, mods: mods::COMMAND | mods::SHIFT });
        assert_eq!(
            h.take(),
            vec![
                flags_ev(KEY_SHIFT, SHIFT),
                flags_ev(KEY_COMMAND, SHIFT | CMD),
                key_ev(KEY_4, true, SHIFT | CMD),
                key_ev(KEY_4, false, SHIFT | CMD),
                flags_ev(KEY_COMMAND, SHIFT),
                flags_ev(KEY_SHIFT, 0),
            ]
        );
    }

    #[test]
    fn held_modifier_is_reused_not_pressed_again() {
        let mut h = Harness::new();
        h.key(A, KEY_COMMAND, true);
        assert_eq!(h.take(), vec![flags_ev(KEY_COMMAND, CMD)]);
        // The client may or may not repeat the held modifier in `mods`.
        h.input(A, Input::Tap { code: KEY_C, mods: 0 });
        h.input(A, Input::Tap { code: KEY_V, mods: mods::COMMAND });
        assert_eq!(
            h.take(),
            vec![
                key_ev(KEY_C, true, CMD),
                key_ev(KEY_C, false, CMD),
                key_ev(KEY_V, true, CMD),
                key_ev(KEY_V, false, CMD),
            ]
        );
        h.key(A, KEY_COMMAND, false);
        assert_eq!(h.take(), vec![flags_ev(KEY_COMMAND, 0)]);
    }

    #[test]
    fn command_tab_switcher_holds_command_across_taps() {
        let mut h = Harness::new();
        h.key(A, KEY_COMMAND, true);
        for _ in 0..3 {
            h.input(A, Input::Tap { code: KEY_TAB, mods: 0 });
        }
        h.key(A, KEY_COMMAND, false);
        let events = h.take();
        let flag_events = events.iter().filter(|e| matches!(e, Synth::Flags { .. })).count();
        assert_eq!(flag_events, 2, "command must be pressed once and released once: {events:?}");
        assert_eq!(
            events.iter().filter(|e| matches!(e, Synth::Key { code: KEY_TAB, down: true, flags: CMD, .. })).count(),
            3
        );
    }

    #[test]
    fn clicks_and_scrolls_keep_held_modifiers_and_carry_their_flags() {
        let mut h = Harness::new();
        h.key(A, KEY_COMMAND, true);
        h.take();
        h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Click, mods: 0 });
        h.input(A, Input::Scroll { phase: scroll_phase::BEGAN, dx: 0.0, dy: 4.0 });
        h.input(A, Input::Move { dx: 3.0, dy: 1.0 });
        h.input(A, Input::Text { text: "x".into(), mode: TypeMode::Unicode });
        let events = h.take();
        assert!(events.iter().all(|e| !matches!(e, Synth::Flags { .. })), "nothing may release ⌘: {events:?}");
        assert!(matches!(events[0], Synth::Button { down: true, flags: CMD, clicks: 1, .. }));
        assert!(matches!(events[2], Synth::Scroll { flags: CMD, phase: scroll_phase::BEGAN, .. }));
        assert!(matches!(events[3], Synth::Move { flags: CMD, drag: None, .. }));
        assert_eq!(h.engine.os_keys_held(), vec![KEY_COMMAND]);
    }

    #[test]
    fn one_shot_modifiers_on_click_are_temporary() {
        let mut h = Harness::new();
        h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Click, mods: mods::COMMAND });
        let events = h.take();
        assert_eq!(events.first(), Some(&flags_ev(KEY_COMMAND, CMD)));
        assert_eq!(events.last(), Some(&flags_ev(KEY_COMMAND, 0)));
        assert!(matches!(events[1], Synth::Button { down: true, flags: CMD, .. }));
    }

    #[test]
    fn sticky_modifier_on_key_down_is_held_until_key_up() {
        let mut h = Harness::new();
        h.input(A, Input::Key { code: KEY_A, down: true, mods: mods::SHIFT, repeat: false });
        assert_eq!(h.take(), vec![flags_ev(KEY_SHIFT, SHIFT), key_ev(KEY_A, true, SHIFT)]);
        h.key(A, KEY_A, false);
        assert_eq!(h.take(), vec![key_ev(KEY_A, false, SHIFT), flags_ev(KEY_SHIFT, 0)]);
    }

    #[test]
    fn right_side_modifiers_keep_their_device_bit() {
        let mut h = Harness::new();
        h.key(A, KEY_RIGHT_COMMAND, true);
        h.input(A, Input::Tap { code: KEY_Q, mods: mods::COMMAND });
        let right = f::COMMAND | f::DEVICE_RIGHT_COMMAND;
        assert_eq!(
            h.take(),
            vec![flags_ev(KEY_RIGHT_COMMAND, right), key_ev(KEY_Q, true, right), key_ev(KEY_Q, false, right)]
        );
    }

    #[test]
    fn stray_releases_and_duplicate_presses_are_ignored() {
        let mut h = Harness::new();
        h.key(A, KEY_CONTROL, false);
        h.key(A, KEY_A, false);
        assert!(h.take().is_empty(), "never release a key we did not press");
        h.key(A, KEY_CONTROL, true);
        h.key(A, KEY_CONTROL, true);
        assert_eq!(h.take().len(), 1);
    }

    #[test]
    fn modifiers_are_reference_counted_across_devices() {
        let mut h = Harness::new();
        h.key(A, KEY_COMMAND, true);
        h.key(B, KEY_COMMAND, true);
        h.key(A, KEY_COMMAND, false);
        assert_eq!(h.take(), vec![flags_ev(KEY_COMMAND, CMD)]);
        h.key(B, KEY_COMMAND, false);
        assert_eq!(h.take(), vec![flags_ev(KEY_COMMAND, 0)]);
    }

    #[test]
    fn ending_a_session_releases_keys_then_modifiers() {
        let mut h = Harness::new();
        h.key(A, KEY_COMMAND, true);
        h.key(A, KEY_SHIFT, true);
        h.key(A, KEY_A, true);
        h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Down, mods: 0 });
        h.input(A, Input::Media { key: MediaKey::FastForward, op: PressOp::Down });
        h.take();
        h.cmd(Command::EndSession(A));
        let events = h.take();
        assert_eq!(events[0], key_ev(KEY_A, false, CMD | SHIFT));
        assert!(matches!(events[1], Synth::Button { down: false, .. }));
        assert_eq!(events[2], Synth::Media { key: MediaKey::FastForward, down: false });
        assert_eq!(events[3], flags_ev(KEY_SHIFT, CMD));
        assert_eq!(events[4], flags_ev(KEY_COMMAND, 0));
        assert!(h.engine.os_keys_held().is_empty());
    }

    #[test]
    fn watchdog_releases_silent_devices() {
        let mut h = Harness::new();
        h.key(A, KEY_OPTION, true);
        h.take();
        h.advance(1000);
        h.cmd(Command::Alive(A));
        h.advance(2500);
        assert!(h.take().is_empty(), "heartbeats keep input held");
        h.advance(600);
        assert_eq!(h.take(), vec![flags_ev(KEY_OPTION, 0)]);
    }

    #[test]
    fn pausing_releases_and_blocks_input() {
        let mut h = Harness::new();
        h.key(A, KEY_COMMAND, true);
        h.take();
        h.cmd(Command::SetPaused(true));
        assert_eq!(h.take(), vec![flags_ev(KEY_COMMAND, 0)]);
        h.input(A, Input::Tap { code: KEY_A, mods: 0 });
        assert!(h.take().is_empty());
        h.cmd(Command::SetPaused(false));
        h.input(A, Input::Tap { code: KEY_A, mods: 0 });
        assert_eq!(h.take().len(), 2);
    }

    #[test]
    fn held_keys_auto_repeat_with_system_timing() {
        let mut h = Harness::new();
        h.cmd(Command::Tuning(Tuning {
            key_repeat_delay: Duration::from_millis(300),
            key_repeat_interval: Duration::from_millis(50),
            ..Tuning::default()
        }));
        h.input(A, Input::Key { code: KEY_DELETE, down: true, mods: 0, repeat: true });
        h.take();
        h.advance(299);
        assert!(h.take().is_empty());
        h.advance(1);
        h.advance(50);
        h.advance(50);
        let repeats = h.take();
        assert_eq!(repeats.len(), 3);
        assert!(repeats.iter().all(|e| matches!(e, Synth::Key { code: KEY_DELETE, down: true, repeat: true, .. })));
        h.key(A, KEY_DELETE, false);
        h.advance(200);
        assert_eq!(h.take(), vec![key_ev(KEY_DELETE, false, 0)]);
    }

    #[test]
    fn tapping_another_key_stops_repeat() {
        let mut h = Harness::new();
        h.input(A, Input::Key { code: KEY_A, down: true, mods: 0, repeat: true });
        h.input(A, Input::Tap { code: KEY_C, mods: 0 });
        h.take();
        h.advance(2000);
        assert!(h.take().iter().all(|e| !matches!(e, Synth::Key { repeat: true, .. })));
    }

    #[test]
    fn clicks_count_like_the_system() {
        let mut h = Harness::new();
        let click = |h: &mut Harness| {
            h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Click, mods: 0 });
            match h.take()[0] {
                Synth::Button { clicks, .. } => clicks,
                ref other => panic!("{other:?}"),
            }
        };
        assert_eq!(click(&mut h), 1);
        h.advance(100);
        assert_eq!(click(&mut h), 2);
        h.advance(100);
        assert_eq!(click(&mut h), 3);
        h.advance(600);
        assert_eq!(click(&mut h), 1);
        h.advance(100);
        h.engine.sink.cursor = (40.0, 0.0);
        assert_eq!(click(&mut h), 1, "moving away starts a new click sequence");
    }

    #[test]
    fn double_tap_and_hold_drags_with_click_count_two() {
        let mut h = Harness::new();
        h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Click, mods: 0 });
        h.advance(120);
        h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Down, mods: 0 });
        h.input(A, Input::Move { dx: 10.0, dy: 0.0 });
        h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Up, mods: 0 });
        let events = h.take();
        assert!(matches!(events[2], Synth::Button { down: true, clicks: 2, .. }));
        assert!(matches!(events[3], Synth::Move { drag: Some(MouseButton::Left), .. }));
        assert!(matches!(events[4], Synth::Button { down: false, clicks: 2, .. }));
    }

    fn moved(events: &[Synth]) -> (f64, f64, usize) {
        events.iter().fold((0.0, 0.0, 0), |(x, y, n), e| match e {
            Synth::Move { dx, dy, .. } => (x + dx, y + dy, n + 1),
            _ => (x, y, n),
        })
    }

    #[test]
    fn bunched_motion_is_spread_out_and_none_is_lost() {
        let mut h = Harness::new();
        // A steady 60 Hz stream establishes the packet interval.
        for _ in 0..10 {
            h.input(A, Input::Move { dx: 6.0, dy: -3.0 });
            for _ in 0..4 {
                h.advance(4);
            }
        }
        h.take();
        // Two packets arrive together, as happens on Wi-Fi.
        h.input(A, Input::Move { dx: 6.0, dy: 0.0 });
        h.input(A, Input::Move { dx: 6.0, dy: 0.0 });
        let (x, _, _) = moved(&h.take());
        assert!(x < 1.0, "a burst must not jump at once: {x}");
        let mut steps = 0;
        for _ in 0..10 {
            h.advance(4);
            if !h.engine.sink.events.is_empty() {
                steps += 1;
            }
        }
        let (x, y, _) = moved(&h.take());
        assert!(steps >= 3, "motion is posted over several frames: {steps}");
        assert!((x - 12.0).abs() < 1e-9 && y.abs() < 1e-9, "all motion arrives: {x},{y}");
    }

    #[test]
    fn a_click_first_posts_motion_still_in_flight() {
        let mut h = Harness::new();
        h.input(A, Input::Move { dx: 20.0, dy: 10.0 });
        h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Click, mods: 0 });
        let events = h.take();
        let (x, y, _) = moved(&events);
        assert_eq!((x, y), (20.0, 10.0));
        assert!(matches!(events.last(), Some(Synth::Button { down: false, .. })));
        assert!(matches!(events[events.len() - 3], Synth::Move { .. }));
    }

    #[test]
    fn a_disconnect_mid_drag_finishes_the_motion_before_letting_go() {
        let mut h = Harness::new();
        h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Down, mods: 0 });
        h.input(A, Input::Move { dx: 20.0, dy: 0.0 });
        h.cmd(Command::EndSession(A));
        h.advance(50);
        let events = h.take();
        assert_eq!(moved(&events).0, 20.0);
        let up = events.iter().position(|e| matches!(e, Synth::Button { down: false, .. })).unwrap();
        assert!(events[..up].iter().any(|e| matches!(e, Synth::Move { drag: Some(MouseButton::Left), .. })));
        assert!(!events[up..].iter().any(|e| matches!(e, Synth::Move { .. })));
    }

    #[test]
    fn pausing_drops_motion_in_flight() {
        let mut h = Harness::new();
        h.input(A, Input::Move { dx: 20.0, dy: 0.0 });
        h.cmd(Command::SetPaused(true));
        h.advance(50);
        assert_eq!(moved(&h.take()).2, 0);
    }

    #[test]
    fn explicit_double_click_counts_up() {
        let mut h = Harness::new();
        h.input(A, Input::Click { button: MouseButton::Left, clicks: 2, mods: 0 });
        let counts: Vec<i64> = h
            .take()
            .into_iter()
            .filter_map(|e| match e {
                Synth::Button { clicks, .. } => Some(clicks),
                _ => None,
            })
            .collect();
        assert_eq!(counts, vec![1, 1, 2, 2]);
    }

    #[test]
    fn scroll_phases_are_completed_and_momentum_follows_a_fling() {
        let mut h = Harness::new();
        h.input(A, Input::Scroll { phase: scroll_phase::CHANGED, dx: 0.0, dy: 5.0 });
        h.input(A, Input::Scroll { phase: scroll_phase::CHANGED, dx: 0.0, dy: 5.0 });
        h.input(A, Input::Fling { vx: 0.0, vy: 1500.0 });
        let phases: Vec<(u8, u8)> = h
            .take()
            .into_iter()
            .filter_map(|e| match e {
                Synth::Scroll { phase, momentum, .. } => Some((phase, momentum)),
                _ => None,
            })
            .collect();
        assert_eq!(phases, vec![(1, 0), (2, 0), (4, 0)]);

        h.advance(8);
        h.advance(8);
        let events = h.take();
        assert!(matches!(events[0], Synth::Scroll { momentum: momentum_phase::BEGIN, dy, .. } if dy > 0.0));
        assert!(matches!(events[1], Synth::Scroll { momentum: momentum_phase::CONTINUE, .. }));

        h.input(A, Input::Touch);
        assert_eq!(
            h.take(),
            vec![Synth::Scroll { dx: 0.0, dy: 0.0, phase: 0, momentum: momentum_phase::END, flags: 0 }]
        );
    }

    #[test]
    fn momentum_decays_to_a_stop() {
        let mut h = Harness::new();
        h.input(A, Input::Fling { vx: 0.0, vy: 900.0 });
        for _ in 0..1000 {
            h.advance(8);
        }
        let events = h.take();
        assert!(matches!(events.last(), Some(Synth::Scroll { momentum: momentum_phase::END, .. })));
        assert!(h.engine.momentum.is_none());
    }

    #[test]
    fn abandoned_scroll_gesture_is_ended() {
        let mut h = Harness::new();
        h.input(A, Input::Scroll { phase: scroll_phase::BEGAN, dx: 0.0, dy: 1.0 });
        h.take();
        h.advance(400);
        assert!(matches!(h.take()[..], [Synth::Scroll { phase: scroll_phase::ENDED, .. }]));
    }

    #[test]
    fn char_combos_follow_the_mac_layout() {
        let mut h = Harness::new();
        // AZERTY: the key labelled "q" sits at the ANSI "a" position.
        let layout = KeyboardLayout {
            id: "fr".into(),
            name: "French".into(),
            iso: true,
            keys: vec![
                KeyCap {
                    code: KEY_A,
                    base: "q".into(),
                    shift: "Q".into(),
                    option: String::new(),
                    option_shift: String::new(),
                    dead: 0,
                },
                KeyCap {
                    code: KEY_Q,
                    base: "a".into(),
                    shift: "A".into(),
                    option: String::new(),
                    option_shift: String::new(),
                    dead: 0,
                },
            ],
        };
        h.cmd(Command::Layout(LayoutMap::from_layout(&layout)));
        h.input(A, Input::CharTap { ch: 'Q', fallback: KEY_Q, mods: mods::COMMAND });
        let events = h.take();
        assert!(events.contains(&key_ev(KEY_A, true, CMD)), "{events:?}");
        h.input(A, Input::CharTap { ch: 'z', fallback: 0x06, mods: mods::COMMAND });
        assert!(h.take().contains(&key_ev(0x06, true, CMD)), "unknown chars fall back to ANSI");
    }

    #[test]
    fn keystroke_typing_uses_layout_and_unicode_fallback() {
        let mut h = Harness::new();
        let layout = KeyboardLayout {
            id: "us".into(),
            name: "US".into(),
            iso: false,
            keys: vec![KeyCap {
                code: KEY_A,
                base: "a".into(),
                shift: "A".into(),
                option: "å".into(),
                option_shift: "Å".into(),
                dead: 0,
            }],
        };
        h.cmd(Command::Layout(LayoutMap::from_layout(&layout)));
        h.input(A, Input::Text { text: "aA😀\n".into(), mode: TypeMode::Keystrokes });
        assert_eq!(
            h.take(),
            vec![
                key_ev(KEY_A, true, 0),
                key_ev(KEY_A, false, 0),
                flags_ev(KEY_SHIFT, SHIFT),
                key_ev(KEY_A, true, SHIFT),
                key_ev(KEY_A, false, SHIFT),
                flags_ev(KEY_SHIFT, 0),
                Synth::Text { text: "😀".into() },
                key_ev(KEY_RETURN, true, 0),
                key_ev(KEY_RETURN, false, 0),
            ]
        );
    }

    #[test]
    fn dictation_edits_delete_then_insert() {
        let mut h = Harness::new();
        h.input(A, Input::Edit { delete: 2, insert: "lo".into() });
        assert_eq!(
            h.take(),
            vec![
                key_ev(KEY_DELETE, true, 0),
                key_ev(KEY_DELETE, false, 0),
                key_ev(KEY_DELETE, true, 0),
                key_ev(KEY_DELETE, false, 0),
                Synth::Text { text: "lo".into() },
            ]
        );
    }

    #[test]
    fn arrows_with_control_carry_fn_and_keypad_bits() {
        let mut h = Harness::new();
        h.input(A, Input::Tap { code: KEY_LEFT, mods: mods::CONTROL });
        let ctrl = f::CONTROL | f::DEVICE_LEFT_CONTROL;
        assert!(h.take().contains(&key_ev(KEY_LEFT, true, ctrl | f::SECONDARY_FN | f::NUMERIC_PAD)));
    }

    #[test]
    fn caps_lock_toggles_instead_of_holding() {
        let mut h = Harness::new();
        h.key(A, KEY_CAPS_LOCK, true);
        h.key(A, KEY_CAPS_LOCK, false);
        assert_eq!(h.take(), vec![Synth::ToggleCapsLock]);
        assert!(h.engine.os_keys_held().is_empty());
    }

    #[test]
    fn lone_modifier_tap_presses_and_releases() {
        let mut h = Harness::new();
        h.input(A, Input::Tap { code: KEY_FUNCTION, mods: 0 });
        assert_eq!(h.take(), vec![flags_ev(KEY_FUNCTION, f::SECONDARY_FN), flags_ev(KEY_FUNCTION, 0)]);
    }

    #[test]
    fn media_keys_are_released_with_the_session() {
        let mut h = Harness::new();
        h.input(A, Input::Media { key: MediaKey::VolumeUp, op: PressOp::Click });
        assert_eq!(
            h.take(),
            vec![
                Synth::Media { key: MediaKey::VolumeUp, down: true },
                Synth::Media { key: MediaKey::VolumeUp, down: false }
            ]
        );
    }

    #[test]
    fn drag_lock_blocks_conflicting_clicks() {
        let mut h = Harness::new();
        h.input(A, Input::Button { button: MouseButton::Left, op: PressOp::Down, mods: 0 });
        h.input(B, Input::Button { button: MouseButton::Left, op: PressOp::Click, mods: 0 });
        assert_eq!(h.take().len(), 1, "a click must not release a held drag");
    }

    #[test]
    fn missing_permission_is_reported_once_per_interval() {
        struct Denied(Recorder);
        impl EventSink for Denied {
            fn post(&mut self, e: Synth) {
                self.0.post(e)
            }
            fn cursor(&mut self) -> (f64, f64) {
                (0.0, 0.0)
            }
            fn can_post(&mut self) -> bool {
                false
            }
        }
        let notices = Arc::new(Mutex::new(Vec::new()));
        let n2 = notices.clone();
        let mut engine = Engine::new(Denied(Recorder::default()), Box::new(move |n| n2.lock().unwrap().push(n)));
        let now = Instant::now();
        for _ in 0..5 {
            engine.handle(Command::Input { session: A, input: Input::Tap { code: KEY_A, mods: 0 } }, now);
        }
        assert_eq!(*notices.lock().unwrap(), vec![Notice::NoPermission(A)]);
        let _ = Harness::new().notices;
    }

    #[test]
    fn long_typing_stops_when_the_session_ends_or_input_pauses() {
        // Ends the session from "another thread" once the first piece is typed,
        // the way a disconnect arrives while the engine is busy typing.
        struct Interrupting {
            events: Vec<Synth>,
            interrupts: Arc<Interrupts>,
            pause: bool,
        }
        impl EventSink for Interrupting {
            fn post(&mut self, e: Synth) {
                if matches!(e, Synth::Text { .. } | Synth::Key { down: true, .. }) {
                    if self.pause {
                        self.interrupts.set_paused(true);
                    } else {
                        self.interrupts.end(A);
                    }
                }
                self.events.push(e);
            }
            fn cursor(&mut self) -> (f64, f64) {
                (0.0, 0.0)
            }
        }
        let text = "word ".repeat(200);
        for (pause, mode) in [(false, TypeMode::Unicode), (true, TypeMode::Keystrokes)] {
            let interrupts = Arc::new(Interrupts::default());
            let sink = Interrupting { events: Vec::new(), interrupts: interrupts.clone(), pause };
            let mut engine = Engine::new(sink, Box::new(|_| {}));
            engine.interrupts = interrupts.clone();
            engine.layout.chars.insert('w', (KEY_A, 0));
            let now = Instant::now();
            engine.handle(Command::Input { session: A, input: Input::Text { text: text.clone(), mode } }, now);
            let typed =
                engine.sink.events.iter().filter(|e| matches!(e, Synth::Text { .. } | Synth::Key { down: true, .. }));
            assert_eq!(typed.count(), 1, "stops after the piece in progress: {:?}", engine.sink.events);
            assert!(engine.os_keys_held().is_empty());

            if !pause {
                engine.handle(Command::EndSession(A), now);
                assert!(!interrupts.should_stop(A), "the engine forgets ended sessions");
                let before = engine.sink.events.len();
                let late = Input::Text { text: "late".into(), mode: TypeMode::Unicode };
                engine.handle(Command::Input { session: A, input: late }, now);
                assert_eq!(engine.sink.events.len(), before, "input for an ended session is dropped");
                assert!(!engine.sessions.contains_key(&A));
            }
        }
    }

    #[test]
    fn key_repeat_stops_after_a_minute() {
        let mut engine = Engine::new(Recorder::default(), Box::new(|_| {}));
        let now = Instant::now();
        engine.handle(
            Command::Input { session: A, input: Input::Key { code: KEY_A, down: true, mods: 0, repeat: true } },
            now,
        );
        // The device stays connected, only its key-up never arrives.
        let mut at = now;
        while at < now + MAX_REPEAT - Duration::from_secs(1) {
            at += Duration::from_millis(500);
            engine.handle(Command::Alive(A), at);
            engine.tick(at);
        }
        assert!(engine.repeat.is_some());
        at += Duration::from_secs(2);
        engine.handle(Command::Alive(A), at);
        engine.tick(at);
        assert!(engine.repeat.is_none(), "a lost key-up can't repeat forever");
    }
}
