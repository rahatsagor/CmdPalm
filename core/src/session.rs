//! One WebSocket connection from a device: authentication, then the control
//! loop that turns messages into input, actions and replies.

use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::actions::{self, Job};
use crate::api::{ApprovalRequest, ConnectedDevice, HostEvent};
use crate::auth::{self, Verdict};
use crate::deck::validate_action;
use crate::host::{LiveSession, Outgoing, PendingApproval, STOPPED_SHARING, Shared};
use crate::input::{Command, Input, SessionId, TypeMode};
use crate::keycodes::{MAX_KEYCODE, mods};
use crate::prefs::SavedSettings;
use crate::protocol::{
    Action, AuthRequest, ClientMessage, DenyReason, DeviceInfo, HostInfo, NoticeLevel, PROTOCOL_VERSION, ServerMessage,
    SettingsSource, TextMode, VoiceState, binary,
};
use crate::server::save_deck;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
/// Clients ping every two seconds; a connection silent this long is dead
/// (e.g. the phone locked or left Wi-Fi without closing the socket).
const DEAD_AFTER: Duration = Duration::from_secs(8);
const MAX_PENDING_APPROVALS: usize = 3;
const MAX_TEXT: usize = 64 * 1024;
const ACTION_QUEUE: usize = 32;
const MAX_IN_FLIGHT: usize = 8;
/// A device that stops reading would otherwise block the session loop, and
/// with it heartbeats, Disconnect and shutdown.
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
/// Voice starts a device may have waiting at once.
const MAX_VOICE_STARTS: usize = 4;

enum VoiceOp {
    Start(Option<String>),
    Stop { cancel: bool },
}

/// Runs voice starts and stops one at a time, in the order they arrived, so
/// a quick start then stop, or a disconnect during a start, can't end with
/// recognition still running. Exits once the session drops its sender.
async fn voice_worker(
    shared: Arc<Shared>,
    id: SessionId,
    mut ops: mpsc::UnboundedReceiver<VoiceOp>,
    starts: Arc<AtomicUsize>,
) {
    while let Some(op) = ops.recv().await {
        let shared = shared.clone();
        let starts = starts.clone();
        let _ = tokio::task::spawn_blocking(move || match op {
            VoiceOp::Start(locale) => {
                let started = shared.delegate.voice_start(id, locale);
                starts.fetch_sub(1, AtomicOrdering::SeqCst);
                if !started {
                    shared.send_to(
                        id,
                        voice(VoiceState::Unavailable, Some("Couldn't start speech recognition on the Mac.")),
                    );
                }
            }
            VoiceOp::Stop { cancel } => shared.delegate.voice_stop(id, cancel),
        })
        .await;
    }
}

type WsSink<S> = SplitSink<WebSocketStream<S>, Message>;
type WsStream<S> = SplitStream<WebSocketStream<S>>;

async fn send<S: AsyncRead + AsyncWrite + Unpin>(sink: &mut WsSink<S>, message: &ServerMessage) -> bool {
    match serde_json::to_string(message) {
        Ok(json) => matches!(timeout(SEND_TIMEOUT, sink.send(Message::text(json))).await, Ok(Ok(()))),
        Err(_) => true,
    }
}

async fn close<S: AsyncRead + AsyncWrite + Unpin>(sink: &mut WsSink<S>, message: ServerMessage) {
    if send(sink, &message).await {
        let _ = timeout(SEND_TIMEOUT, sink.close()).await;
    }
}

/// The next text message, answering transport-level pings on the way.
async fn next_message<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut WsStream<S>,
) -> Option<Result<ClientMessage, ()>> {
    loop {
        match stream.next().await? {
            Ok(Message::Text(text)) => return Some(serde_json::from_str(&text).map_err(|_| ())),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => continue,
        }
    }
}

struct Authorized {
    token: Option<String>,
    remembered: bool,
    newly_paired: bool,
    name: String,
}

struct Refusal(DenyReason, Option<Duration>);

fn deny(reason: DenyReason, retry: Option<Duration>) -> ServerMessage {
    ServerMessage::Denied { reason, retry_after: retry.map(|d| d.as_secs().max(1) as u32) }
}

pub(crate) async fn run<S>(
    shared: Arc<Shared>,
    ws: WebSocketStream<S>,
    peer: IpAddr,
    secure: bool,
    mut shutdown: watch::Receiver<bool>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let hello = match timeout(HELLO_TIMEOUT, next_message(&mut stream)).await {
        Ok(Some(Ok(message))) => message,
        _ => return close(&mut sink, bye("Expected a hello message.", false)).await,
    };
    let ClientMessage::Hello { v, device, auth, remember } = hello else {
        return close(&mut sink, bye("Expected a hello message.", false)).await;
    };
    if v != PROTOCOL_VERSION {
        return close(&mut sink, deny(DenyReason::Incompatible, None)).await;
    }
    if !valid_device_id(&device.id) {
        return close(&mut sink, deny(DenyReason::Incompatible, None)).await;
    }

    let authorized = match authenticate(&shared, &device, auth, remember, peer, &mut sink, &mut stream).await {
        Ok(authorized) => authorized,
        Err(Some(Refusal(reason, retry))) => return close(&mut sink, deny(reason, retry)).await,
        Err(None) => return,
    };

    let id = shared.next_id();
    let key = auth::random_token(18);
    let (tx, mut outgoing) = mpsc::unbounded_channel();
    let features = shared.features(secure);
    let config = shared.config();
    let saved_settings = if authorized.remembered { shared.device_settings().get(&device.id).cloned() } else { None };
    let welcome = {
        let mut state = shared.state();
        state.sessions.insert(
            id,
            LiveSession {
                info: ConnectedDevice {
                    session: id,
                    device_id: device.id.clone(),
                    name: authorized.name.clone(),
                    model: auth::clean(&device.model, 64),
                    address: peer.to_string(),
                    connected_at: auth::unix_now(),
                    secure,
                    remembered: authorized.remembered,
                },
                key: key.clone(),
                tx,
            },
        );
        ServerMessage::Welcome {
            v: PROTOCOL_VERSION,
            host: HostInfo {
                name: config.computer_name.clone(),
                version: config.app_version.clone(),
                os: "macOS".into(),
            },
            session_key: key,
            token: authorized.token,
            features,
            deck: state.deck.clone(),
            layout: state.layout.clone(),
            volume: state.volume,
            paused: state.paused,
            settings: saved_settings,
        }
    };
    if authorized.newly_paired {
        shared.emit(HostEvent::Paired { name: authorized.name.clone() });
        if authorized.remembered {
            shared.emit(HostEvent::DevicesChanged);
        }
    }
    shared.emit(HostEvent::SessionsChanged);
    tracing::info!(session = id, device = %authorized.name, %peer, secure, "device connected");

    let (jobs, job_rx) = mpsc::channel(ACTION_QUEUE);
    let worker = tokio::spawn(actions::worker(shared.clone(), id, job_rx));
    let (voice_ops, voice_rx) = mpsc::unbounded_channel();
    let voice_starts = Arc::new(AtomicUsize::new(0));
    tokio::spawn(voice_worker(shared.clone(), id, voice_rx, voice_starts.clone()));
    let mut conn = Connection {
        shared: shared.clone(),
        id,
        device_id: device.id.clone(),
        remembered: authorized.remembered,
        jobs,
        voice_ops,
        voice_starts,
        voice: false,
        last_heard: Instant::now(),
        in_flight: Arc::new(AtomicUsize::new(0)),
        apps_requested: 0,
        apps_sent: Arc::new(Mutex::new(0)),
    };

    if send(&mut sink, &welcome).await {
        let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                incoming = stream.next() => {
                    let Some(Ok(message)) = incoming else { break };
                    conn.last_heard = Instant::now();
                    let reply = match message {
                        Message::Text(text) => conn.text(&text),
                        Message::Binary(data) => { conn.binary(&data); None }
                        Message::Close(_) => break,
                        _ => { shared.engine(Command::Alive(id)); None }
                    };
                    if let Some(reply) = reply && !send(&mut sink, &reply).await {
                        break;
                    }
                }
                out = outgoing.recv() => match out {
                    Some(Outgoing::Message(message)) => if !send(&mut sink, &message).await { break },
                    Some(Outgoing::Close { reason, reconnect }) => {
                        let reason = if reason.trim().is_empty() { "Disconnected." } else { reason.as_str() };
                        close(&mut sink, bye(reason, reconnect)).await;
                        break;
                    }
                    None => break,
                },
                _ = heartbeat.tick() => {
                    if conn.last_heard.elapsed() > DEAD_AFTER {
                        tracing::info!(session = id, "device stopped responding");
                        break;
                    }
                }
                _ = shutdown.changed() => {
                    close(&mut sink, bye(STOPPED_SHARING, true)).await;
                    break;
                }
            }
        }
    }

    // Stop typing and running deck actions before releasing held input.
    shared.interrupts.end(id);
    shared.state().sessions.remove(&id);
    shared.engine(Command::EndSession(id));
    worker.abort();
    if conn.voice {
        let _ = conn.voice_ops.send(VoiceOp::Stop { cancel: true });
    }
    // Dropping the sender lets the voice worker finish what is queued, then exit.
    drop(conn);
    shared.emit(HostEvent::SessionsChanged);
    tracing::info!(session = id, "device disconnected");
}

/// `Err(None)` means the device went away; `Err(Some(m))` is a refusal.
async fn authenticate<S>(
    shared: &Arc<Shared>,
    device: &DeviceInfo,
    request: AuthRequest,
    remember: bool,
    peer: IpAddr,
    sink: &mut WsSink<S>,
    stream: &mut WsStream<S>,
) -> Result<Authorized, Option<Refusal>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let config = shared.config();
    let now = Instant::now();
    let fallback_name = || {
        let name = auth::clean(&device.name, 64);
        if name.is_empty() { "Unnamed device".to_string() } else { name }
    };
    let accept = |shared: &Shared| {
        let name = fallback_name();
        let token = remember.then(|| shared.state().trust.issue(device, peer));
        Ok(Authorized { token, remembered: remember, newly_paired: true, name })
    };
    match request {
        AuthRequest::Token { token } => {
            let found = shared.state().trust.verify(device, &token, peer);
            match found {
                Some(trusted) => Ok(Authorized {
                    token: None,
                    remembered: true,
                    newly_paired: false,
                    name: auth::visible_name(&trusted.name),
                }),
                None => Err(Some(Refusal(DenyReason::Unknown, None))),
            }
        }
        AuthRequest::Pair { code } => {
            let verdict = shared.state().pairing.check_code(&code, now);
            match verdict {
                Verdict::Accepted => {
                    shared.emit(HostEvent::PairingChanged);
                    accept(shared)
                }
                Verdict::Rejected | Verdict::Closed => Err(Some(Refusal(DenyReason::ExpiredCode, None))),
                Verdict::Locked(wait) => Err(Some(Refusal(DenyReason::Blocked, Some(wait)))),
            }
        }
        AuthRequest::Pin { pin } => {
            if !config.allow_pin {
                return Err(Some(Refusal(DenyReason::Rejected, None)));
            }
            let verdict = shared.state().pairing.check_pin(&pin, peer, now);
            match verdict {
                Verdict::Accepted => {
                    shared.emit(HostEvent::PairingChanged);
                    accept(shared)
                }
                Verdict::Rejected => Err(Some(Refusal(DenyReason::WrongPin, None))),
                Verdict::Closed => Err(Some(Refusal(DenyReason::PinClosed, None))),
                Verdict::Locked(wait) => {
                    shared.emit(HostEvent::PairingChanged);
                    Err(Some(Refusal(DenyReason::Blocked, Some(wait))))
                }
            }
        }
        AuthRequest::Approve => {
            if !config.allow_approval {
                return Err(Some(Refusal(DenyReason::Rejected, None)));
            }
            let id = shared.next_id();
            let (reply, decision) = oneshot::channel();
            let request = ApprovalRequest {
                id,
                device_name: fallback_name(),
                model: auth::clean(&device.model, 64),
                address: peer.to_string(),
            };
            {
                let mut state = shared.state();
                if let Some(wait) = state.pairing.approval_locked(peer, now) {
                    return Err(Some(Refusal(DenyReason::Blocked, Some(wait))));
                }
                // Counted like lockouts, so one IPv6 host can't fill every slot.
                let key = auth::throttle_key(peer);
                let waiting = |p: &PendingApproval| {
                    p.request.address.parse::<IpAddr>().is_ok_and(|address| auth::throttle_key(address) == key)
                };
                if state.approvals.len() >= MAX_PENDING_APPROVALS || state.approvals.values().any(waiting) {
                    return Err(Some(Refusal(DenyReason::Busy, None)));
                }
                state.approvals.insert(id, PendingApproval { request: request.clone(), reply });
            }
            shared.emit(HostEvent::ApprovalRequested { request });
            // A request that is shown and then abandoned counts as unanswered,
            // so connecting and leaving in a loop can't flood the Mac with prompts.
            let declined = || shared.state().pairing.approval_declined(peer, Instant::now());
            if !send(sink, &ServerMessage::Pending).await {
                cancel_approval(shared, id);
                declined();
                return Err(None);
            }
            let waited = timeout(APPROVAL_TIMEOUT, async {
                tokio::pin!(decision);
                loop {
                    tokio::select! {
                        answer = &mut decision => return Some(answer.unwrap_or(false)),
                        message = next_message(stream) => match message {
                            Some(Ok(ClientMessage::Ping { id })) => {
                                if !send(sink, &ServerMessage::Pong { id }).await { return None }
                            }
                            Some(_) => {}
                            None => return None,
                        }
                    }
                }
            })
            .await;
            match waited {
                Ok(Some(true)) => accept(shared),
                Ok(Some(false)) => {
                    declined();
                    Err(Some(Refusal(DenyReason::Rejected, None)))
                }
                Ok(None) => {
                    cancel_approval(shared, id);
                    declined();
                    Err(None)
                }
                Err(_) => {
                    cancel_approval(shared, id);
                    declined();
                    Err(Some(Refusal(DenyReason::Rejected, None)))
                }
            }
        }
    }
}

fn cancel_approval(shared: &Shared, id: u64) {
    if shared.state().approvals.remove(&id).is_some() {
        shared.emit(HostEvent::ApprovalEnded { id });
    }
}

struct Connection {
    shared: Arc<Shared>,
    id: SessionId,
    device_id: String,
    remembered: bool,
    jobs: mpsc::Sender<Job>,
    voice_ops: mpsc::UnboundedSender<VoiceOp>,
    voice_starts: Arc<AtomicUsize>,
    voice: bool,
    last_heard: Instant,
    in_flight: Arc<AtomicUsize>,
    /// App lists asked for, and the newest one sent. Lists are made on
    /// separate threads and can finish out of order.
    apps_requested: u64,
    apps_sent: Arc<Mutex<u64>>,
}

/// Device IDs are compared byte for byte when a remembered device returns,
/// so accept only IDs that survive storage unchanged.
fn valid_device_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_graphic())
}

fn bye(reason: &str, reconnect: bool) -> ServerMessage {
    ServerMessage::Bye { reason: reason.into(), reconnect }
}

fn valid_key(code: u16, m: u8) -> bool {
    code <= MAX_KEYCODE && m & !mods::ALL == 0
}

fn f32_at(data: &[u8], at: usize) -> Option<f64> {
    let bytes: [u8; 4] = data.get(at..at + 4)?.try_into().ok()?;
    let value = f32::from_le_bytes(bytes);
    value.is_finite().then_some(value as f64)
}

impl Connection {
    fn input(&self, input: Input) {
        self.shared.engine(Command::Input { session: self.id, input });
    }

    fn queue(&self, action: Action, id: Option<u32>) -> Option<ServerMessage> {
        if let Err(err) = validate_action(&action, 0) {
            return Some(ServerMessage::ActionResult { id, ok: false, message: Some(err.to_string()) });
        }
        match self.jobs.try_send(Job { action, id }) {
            Ok(()) => None,
            Err(_) => Some(ServerMessage::ActionResult {
                id,
                ok: false,
                message: Some("The Mac is still busy with earlier actions.".into()),
            }),
        }
    }

    /// Run work that may block on macOS. A device can only keep a few such
    /// jobs in flight, so a flood of requests can't pile up threads.
    fn blocking<F: FnOnce(&Shared) -> Option<ServerMessage> + Send + 'static>(&self, work: F) {
        if self.in_flight.fetch_add(1, AtomicOrdering::SeqCst) >= MAX_IN_FLIGHT {
            self.in_flight.fetch_sub(1, AtomicOrdering::SeqCst);
            self.shared.send_to(
                self.id,
                notice(NoticeLevel::Warning, "busy", "The Mac is still busy. Try again in a moment."),
            );
            return;
        }
        let shared = self.shared.clone();
        let id = self.id;
        struct Done(Arc<AtomicUsize>);
        impl Drop for Done {
            fn drop(&mut self) {
                self.0.fetch_sub(1, AtomicOrdering::SeqCst);
            }
        }
        let done = Done(self.in_flight.clone());
        tokio::task::spawn_blocking(move || {
            let _done = done;
            if let Some(reply) = work(&shared) {
                shared.send_to(id, reply);
            }
        });
    }

    fn text(&mut self, text: &str) -> Option<ServerMessage> {
        let Ok(message) = serde_json::from_str::<ClientMessage>(text) else {
            self.shared.engine(Command::Alive(self.id));
            tracing::debug!(session = self.id, "ignoring malformed message");
            return None;
        };
        if self.shared.interrupts.paused()
            && let Some(reply) = paused_reply(&message)
        {
            self.shared.engine(Command::Alive(self.id));
            return reply;
        }
        match message {
            ClientMessage::Hello { .. } => None,
            ClientMessage::Ping { id } => {
                self.shared.engine(Command::Alive(self.id));
                Some(ServerMessage::Pong { id })
            }
            ClientMessage::Key { code, down, mods, repeat } => {
                if valid_key(code, mods) {
                    self.input(Input::Key { code, down, mods, repeat });
                }
                None
            }
            ClientMessage::Tap { code, mods } => {
                if valid_key(code, mods) {
                    self.input(Input::Tap { code, mods });
                }
                None
            }
            ClientMessage::Button { button, op, mods } => {
                if mods & !mods::ALL == 0 {
                    self.input(Input::Button { button, op, mods });
                }
                None
            }
            ClientMessage::Media { key, op } => {
                self.input(Input::Media { key, op });
                None
            }
            ClientMessage::Text { text, mode } => {
                if text.len() > MAX_TEXT {
                    return Some(notice(NoticeLevel::Warning, "tooLong", "That text is too long to send at once."));
                }
                match mode {
                    TextMode::Unicode => self.input(Input::Text { text, mode: TypeMode::Unicode }),
                    TextMode::Keystrokes => self.input(Input::Text { text, mode: TypeMode::Keystrokes }),
                    TextMode::Paste => {
                        let id = self.id;
                        self.blocking(move |shared| {
                            actions::paste(shared, id, &text).err().map(|m| notice(NoticeLevel::Error, "paste", &m))
                        });
                    }
                }
                None
            }
            ClientMessage::Edit { delete, insert } => {
                if insert.len() > MAX_TEXT {
                    return Some(notice(NoticeLevel::Warning, "tooLong", "That text is too long to send at once."));
                }
                self.input(Input::Edit { delete, insert });
                None
            }
            ClientMessage::Action { action, id } => self.queue(action, id),
            ClientMessage::AppAction { id, op } => self.queue(Action::App { id, op }, None),
            ClientMessage::Release => {
                self.input(Input::ReleaseAll);
                None
            }
            ClientMessage::Apps => {
                // Quitting an app announces two changes (another app comes to
                // the front, then the app quits). If the first, slower list
                // were sent last, the app that quit would come back.
                self.apps_requested += 1;
                let request = self.apps_requested;
                let sent = self.apps_sent.clone();
                let id = self.id;
                self.blocking(move |shared| {
                    let apps = shared.delegate.list_apps();
                    let mut newest = sent.lock().unwrap_or_else(|p| p.into_inner());
                    if *newest < request {
                        *newest = request;
                        shared.send_to(id, ServerMessage::Apps { apps });
                    }
                    None
                });
                None
            }
            ClientMessage::DeckSave { deck } => match save_deck(&self.shared, deck) {
                Ok(()) => None,
                Err(err) => Some(notice(NoticeLevel::Error, "deck", &err.to_string())),
            },
            ClientMessage::Volume { value, muted } => {
                let value = value.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0));
                self.blocking(move |shared| {
                    shared.delegate.set_volume(value, muted);
                    None
                });
                None
            }
            ClientMessage::ClipboardSet { text } => {
                if text.len() > MAX_TEXT {
                    return Some(notice(NoticeLevel::Warning, "tooLong", "That text is too long to send at once."));
                }
                self.blocking(move |shared| {
                    shared.delegate.set_clipboard_text(text);
                    None
                });
                None
            }
            ClientMessage::ClipboardGet => {
                self.blocking(|shared| {
                    let text: String =
                        shared.delegate.clipboard_text().unwrap_or_default().chars().take(MAX_TEXT).collect();
                    Some(ServerMessage::Clipboard { text })
                });
                None
            }
            ClientMessage::VoiceStart { locale } => {
                if !self.shared.config().voice_available {
                    return Some(voice(
                        VoiceState::Unavailable,
                        Some("Speech recognition isn't available on this Mac."),
                    ));
                }
                let locale = locale
                    .filter(|l| l.len() <= 32 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
                if self.voice_starts.fetch_add(1, AtomicOrdering::SeqCst) >= MAX_VOICE_STARTS {
                    self.voice_starts.fetch_sub(1, AtomicOrdering::SeqCst);
                    return Some(voice(VoiceState::Unavailable, Some("The Mac is still busy. Try again in a moment.")));
                }
                if self.voice_ops.send(VoiceOp::Start(locale)).is_err() {
                    self.voice_starts.fetch_sub(1, AtomicOrdering::SeqCst);
                    return None;
                }
                self.voice = true;
                None
            }
            ClientMessage::SettingsSave { settings, updated_at } => {
                if !self.remembered {
                    return None;
                }
                let device = self.device_id.clone();
                self.blocking(move |shared| {
                    let saved = SavedSettings { settings, updated_at };
                    let mut store = shared.device_settings();
                    // The device may have been removed on the Mac since it sent
                    // these; saving them would bring its settings back.
                    if !shared.state().trust.contains(&device) {
                        return None;
                    }
                    store.set(&device, saved).err().map(|e| notice(NoticeLevel::Error, "settings", &e.to_string()))
                });
                None
            }
            // Only remembered devices keep settings on the Mac, so only they
            // may see and copy other devices' settings.
            ClientMessage::SettingsList if !self.remembered => {
                Some(ServerMessage::SettingsList { devices: Vec::new() })
            }
            ClientMessage::SettingsCopy { .. } if !self.remembered => Some(notice(
                NoticeLevel::Warning,
                "settings",
                "Pair with “Remember this device” turned on to copy settings from another device.",
            )),
            ClientMessage::SettingsList => {
                let devices = self.shared.state().trust.devices();
                let store = self.shared.device_settings();
                let mut list: Vec<SettingsSource> = devices
                    .into_iter()
                    .filter(|d| d.id != self.device_id)
                    .filter_map(|d| {
                        let saved = store.get(&d.id)?;
                        Some(SettingsSource {
                            name: auth::visible_name(&d.name),
                            model: d.model,
                            updated_at: saved.updated_at,
                            id: d.id,
                        })
                    })
                    .collect();
                list.sort_by_key(|d| std::cmp::Reverse(d.updated_at));
                Some(ServerMessage::SettingsList { devices: list })
            }
            ClientMessage::SettingsCopy { from } => match self.shared.device_settings().get(&from) {
                Some(saved) => Some(ServerMessage::Settings(saved.clone())),
                None => Some(notice(NoticeLevel::Warning, "settings", "Those settings are no longer on this Mac.")),
            },
            ClientMessage::VoiceStop { cancel } => {
                if std::mem::take(&mut self.voice) {
                    let _ = self.voice_ops.send(VoiceOp::Stop { cancel });
                }
                None
            }
        }
    }

    fn binary(&mut self, data: &[u8]) {
        let Some(&op) = data.first() else { return };
        let input = match (op, data.len()) {
            (binary::MOVE, 9) => f32_at(data, 1).zip(f32_at(data, 5)).map(|(dx, dy)| Input::Move { dx, dy }),
            (binary::SCROLL, 10) => {
                f32_at(data, 2).zip(f32_at(data, 6)).map(|(dx, dy)| Input::Scroll { phase: data[1], dx, dy })
            }
            (binary::FLING, 9) => f32_at(data, 1).zip(f32_at(data, 5)).map(|(vx, vy)| Input::Fling { vx, vy }),
            (binary::TOUCH, 1) => Some(Input::Touch),
            (binary::AUDIO, len) if len > 1 && len % 2 == 1 => {
                self.shared.engine(Command::Alive(self.id));
                if self.voice && !self.shared.interrupts.paused() {
                    self.shared.delegate.voice_audio(self.id, data[1..].to_vec());
                }
                None
            }
            _ => None,
        };
        match input {
            Some(input) => self.input(input),
            None => self.shared.engine(Command::Alive(self.id)),
        }
    }
}

const PAUSED: &str = "Control is paused on the Mac.";

/// While paused, everything that acts on the Mac is refused. `None` means the
/// message is still allowed; `Some(reply)` means it was refused.
fn paused_reply(message: &ClientMessage) -> Option<Option<ServerMessage>> {
    match message {
        ClientMessage::Hello { .. }
        | ClientMessage::Ping { .. }
        | ClientMessage::Release
        | ClientMessage::Apps
        | ClientMessage::DeckSave { .. }
        | ClientMessage::SettingsSave { .. }
        | ClientMessage::SettingsList
        | ClientMessage::SettingsCopy { .. }
        | ClientMessage::VoiceStop { .. } => None,
        ClientMessage::Action { id, .. } => {
            Some(Some(ServerMessage::ActionResult { id: *id, ok: false, message: Some(PAUSED.into()) }))
        }
        ClientMessage::AppAction { .. }
        | ClientMessage::Text { .. }
        | ClientMessage::ClipboardSet { .. }
        | ClientMessage::ClipboardGet => Some(Some(notice(NoticeLevel::Warning, "paused", PAUSED))),
        ClientMessage::VoiceStart { .. } => Some(Some(voice(VoiceState::Unavailable, Some(PAUSED)))),
        ClientMessage::Key { .. }
        | ClientMessage::Tap { .. }
        | ClientMessage::Button { .. }
        | ClientMessage::Media { .. }
        | ClientMessage::Edit { .. }
        | ClientMessage::Volume { .. } => Some(None),
    }
}

fn notice(level: NoticeLevel, code: &str, message: &str) -> ServerMessage {
    ServerMessage::Notice { level, code: code.into(), message: message.into() }
}

fn voice(state: VoiceState, message: Option<&str>) -> ServerMessage {
    ServerMessage::Voice { state, text: None, is_final: false, message: message.map(Into::into) }
}
