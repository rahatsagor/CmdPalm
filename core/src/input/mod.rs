//! Input injection.
//!
//! Every synthetic event is produced by a single engine thread ([`engine`]).
//! The engine owns all held-key, button, repeat and momentum state, so events
//! from several devices are serialized and a modifier can never be released by
//! one code path while another still relies on it. The engine emits abstract
//! [`Synth`] events into an [`EventSink`]; [`mac::MacSink`] turns them into
//! CGEvents, and tests use a recording sink to assert exact sequences.

pub mod engine;
#[cfg(target_os = "macos")]
pub mod mac;
pub mod text;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::keycodes::KeyCode;
use crate::protocol::{MediaKey, MouseButton, PressOp};

pub use engine::{InputEngine, Notice};

pub type SessionId = u64;

/// `kCGScrollWheelEventScrollPhase` values (`CGScrollPhase`).
pub mod scroll_phase {
    pub const NONE: u8 = 0;
    pub const BEGAN: u8 = 1;
    pub const CHANGED: u8 = 2;
    pub const ENDED: u8 = 4;
    pub const CANCELLED: u8 = 8;
    pub const MAY_BEGIN: u8 = 128;
}

/// `kCGScrollWheelEventMomentumPhase` values (`CGMomentumScrollPhase`).
pub mod momentum_phase {
    pub const NONE: u8 = 0;
    pub const BEGIN: u8 = 1;
    pub const CONTINUE: u8 = 2;
    pub const END: u8 = 3;
}

/// A platform-neutral synthetic event. `flags` never includes Caps Lock or
/// the non-coalesced bit; the sink adds those from live system state.
#[derive(Debug, Clone, PartialEq)]
pub enum Synth {
    /// A modifier key changed state (`kCGEventFlagsChanged`). `flags` is the
    /// modifier state *after* the change.
    Flags {
        code: KeyCode,
        flags: u64,
    },
    Key {
        code: KeyCode,
        down: bool,
        flags: u64,
        repeat: bool,
    },
    /// Unicode text injected as a single keyboard event.
    Text {
        text: String,
    },
    /// Relative pointer motion. `drag` names the held button, if any, so the
    /// sink posts the matching `*MouseDragged` event type.
    Move {
        dx: f64,
        dy: f64,
        flags: u64,
        drag: Option<MouseButton>,
    },
    Button {
        button: MouseButton,
        down: bool,
        clicks: i64,
        flags: u64,
    },
    Scroll {
        dx: f64,
        dy: f64,
        phase: u8,
        momentum: u8,
        flags: u64,
    },
    Media {
        key: MediaKey,
        down: bool,
    },
    ToggleCapsLock,
    Pause(Duration),
}

pub trait EventSink: 'static {
    fn post(&mut self, event: Synth);
    /// Current cursor location in global display points.
    fn cursor(&mut self) -> (f64, f64);
    /// Whether macOS currently lets this process post events.
    fn can_post(&mut self) -> bool {
        true
    }
    /// Whether a password field has enabled Secure Event Input, which makes
    /// macOS drop synthetic keystrokes.
    fn secure_input(&mut self) -> bool {
        false
    }
}

/// Discards events. Used where no window server is available.
#[derive(Debug, Default)]
pub struct NullSink;

impl EventSink for NullSink {
    fn post(&mut self, _event: Synth) {}
    fn cursor(&mut self) -> (f64, f64) {
        (0.0, 0.0)
    }
}

/// Logs events instead of posting them, for trying the client without
/// moving the real pointer.
#[derive(Default)]
pub struct LogSink {
    cursor: (f64, f64),
}

impl EventSink for LogSink {
    fn post(&mut self, event: Synth) {
        match event {
            Synth::Pause(_) => {}
            Synth::Move { .. } => tracing::trace!(target: "cmdpalm::synth", "{event:?}"),
            // Typing stays out of the default log, even in a dry run.
            Synth::Text { text } => {
                tracing::info!(target: "cmdpalm::synth", "Text({} characters)", text.chars().count())
            }
            Synth::Key { .. } => tracing::debug!(target: "cmdpalm::synth", "{event:?}"),
            _ => tracing::info!(target: "cmdpalm::synth", "{event:?}"),
        }
    }
    fn cursor(&mut self) -> (f64, f64) {
        self.cursor
    }
}

/// Records events for tests that run the engine on its own thread.
#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct SharedRecorder(pub std::sync::Arc<std::sync::Mutex<Vec<Synth>>>);

#[cfg(test)]
impl SharedRecorder {
    pub fn take(&self) -> Vec<Synth> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

#[cfg(test)]
impl EventSink for SharedRecorder {
    fn post(&mut self, event: Synth) {
        if !matches!(event, Synth::Pause(_)) {
            self.0.lock().unwrap().push(event);
        }
    }
    fn cursor(&mut self) -> (f64, f64) {
        (100.0, 100.0)
    }
}

/// System timing values the engine mirrors so synthetic input feels native.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tuning {
    pub key_repeat_delay: Duration,
    pub key_repeat_interval: Duration,
    pub double_click_interval: Duration,
    /// Exponential decay rate of scroll momentum, per second.
    pub momentum_friction: f64,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            key_repeat_delay: Duration::from_millis(500),
            key_repeat_interval: Duration::from_millis(83),
            double_click_interval: Duration::from_millis(500),
            momentum_friction: 2.6,
        }
    }
}

/// Character → (key code, wire modifiers) for the active Mac input source.
#[derive(Debug, Clone, Default)]
pub struct LayoutMap {
    pub chars: HashMap<char, (KeyCode, u8)>,
}

impl LayoutMap {
    pub fn from_layout(layout: &crate::protocol::KeyboardLayout) -> Self {
        use crate::keycodes::mods;
        let mut chars = HashMap::new();
        // Insert in reverse preference so the simplest chord wins.
        for cap in layout.keys.iter() {
            for (level, text, mask) in [
                (3, &cap.option_shift, mods::OPTION | mods::SHIFT),
                (2, &cap.option, mods::OPTION),
                (1, &cap.shift, mods::SHIFT),
                (0, &cap.base, 0),
            ] {
                if cap.dead & (1 << level) != 0 {
                    continue;
                }
                let mut it = text.chars();
                if let (Some(ch), None) = (it.next(), it.next())
                    && !ch.is_control()
                {
                    let entry = chars.entry(ch).or_insert((cap.code, mask));
                    if mask.count_ones() < entry.1.count_ones() {
                        *entry = (cap.code, mask);
                    }
                }
            }
        }
        Self { chars }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeMode {
    Unicode,
    Keystrokes,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    Key {
        code: KeyCode,
        down: bool,
        mods: u8,
        repeat: bool,
    },
    Tap {
        code: KeyCode,
        mods: u8,
    },
    /// A combo defined by character (e.g. ⌘Q). Resolved through the active
    /// layout so shortcuts follow the key labelled with that letter.
    CharTap {
        ch: char,
        fallback: KeyCode,
        mods: u8,
    },
    Button {
        button: MouseButton,
        op: PressOp,
        mods: u8,
    },
    Click {
        button: MouseButton,
        clicks: u8,
        mods: u8,
    },
    Move {
        dx: f64,
        dy: f64,
    },
    Scroll {
        phase: u8,
        dx: f64,
        dy: f64,
    },
    Fling {
        vx: f64,
        vy: f64,
    },
    Touch,
    Media {
        key: MediaKey,
        op: PressOp,
    },
    Text {
        text: String,
        mode: TypeMode,
    },
    Edit {
        delete: u32,
        insert: String,
    },
    ToggleCapsLock,
    ReleaseAll,
}

/// Stops long-running work (typing, deck sequences) without waiting for the
/// engine queue, which may be blocked behind that very work.
#[derive(Debug, Default)]
pub struct Interrupts {
    paused: AtomicBool,
    ended: Mutex<HashSet<SessionId>>,
}

impl Interrupts {
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Mark a session as gone. The engine forgets it after `EndSession`.
    pub fn end(&self, session: SessionId) {
        self.ended.lock().unwrap_or_else(|p| p.into_inner()).insert(session);
    }

    pub(crate) fn forget(&self, session: SessionId) {
        self.ended.lock().unwrap_or_else(|p| p.into_inner()).remove(&session);
    }

    pub fn should_stop(&self, session: SessionId) -> bool {
        self.paused() || self.ended.lock().unwrap_or_else(|p| p.into_inner()).contains(&session)
    }
}

pub enum Command {
    Input {
        session: SessionId,
        input: Input,
    },
    Alive(SessionId),
    EndSession(SessionId),
    SetPaused(bool),
    Tuning(Tuning),
    Layout(LayoutMap),
    /// Reply once all previously queued commands are processed.
    Flush(std::sync::mpsc::Sender<()>),
    Shutdown,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keycodes::mods;
    use crate::protocol::{KeyCap, KeyboardLayout};

    fn cap(code: u16, levels: [&str; 4], dead: u8) -> KeyCap {
        KeyCap {
            code,
            base: levels[0].into(),
            shift: levels[1].into(),
            option: levels[2].into(),
            option_shift: levels[3].into(),
            dead,
        }
    }

    fn layout(keys: Vec<KeyCap>) -> KeyboardLayout {
        KeyboardLayout { id: "test".into(), name: "Test".into(), iso: false, keys }
    }

    #[test]
    fn prefers_the_chord_with_fewest_modifiers() {
        let map = LayoutMap::from_layout(&layout(vec![
            cap(0, ["a", "A", "å", "Å"], 0),
            cap(18, ["1", "!", "¡", "⁄"], 0),
            cap(42, ["\\", "|", "«", "»"], 0),
            cap(50, ["`", "~", "`", "`"], 0),
        ]));
        assert_eq!(map.chars[&'a'], (0, 0));
        assert_eq!(map.chars[&'A'], (0, mods::SHIFT));
        assert_eq!(map.chars[&'å'], (0, mods::OPTION));
        assert_eq!(map.chars[&'Å'], (0, mods::OPTION | mods::SHIFT));
        assert_eq!(map.chars[&'!'], (18, mods::SHIFT));
        assert_eq!(map.chars[&'`'], (50, 0));
    }

    #[test]
    fn skips_dead_key_levels() {
        // Option-E on US layouts starts an acute accent sequence; typing it
        // as a keystroke would swallow the next character.
        let map = LayoutMap::from_layout(&layout(vec![
            cap(14, ["e", "E", "´", "´"], 0b0100),
            cap(32, ["u", "U", "¨", "¨"], 0b0100),
            cap(39, ["'", "\"", "æ", "Æ"], 0),
        ]));
        assert_eq!(map.chars[&'´'], (14, mods::OPTION | mods::SHIFT));
        assert_eq!(map.chars[&'¨'], (32, mods::OPTION | mods::SHIFT));
        assert_eq!(map.chars[&'e'], (14, 0));

        let all_dead = LayoutMap::from_layout(&layout(vec![cap(14, ["e", "E", "´", "´"], 0b1100)]));
        assert!(!all_dead.chars.contains_key(&'´'));
    }

    #[test]
    fn ignores_multi_character_and_control_output() {
        let map =
            LayoutMap::from_layout(&layout(vec![cap(36, ["\r", "\r", "", ""], 0), cap(0, ["ab", "A", "", ""], 0)]));
        assert!(!map.chars.contains_key(&'\r'));
        assert!(!map.chars.contains_key(&'a'));
        assert_eq!(map.chars[&'A'], (0, mods::SHIFT));
    }
}
