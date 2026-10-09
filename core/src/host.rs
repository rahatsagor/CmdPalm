//! The [`CoreHost`] object Swift owns, and the state shared by server tasks.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, Weak};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot, watch};

use crate::api::{
    ApprovalRequest, ConnectedDevice, HostConfig, HostDelegate, HostError, HostEvent, PairingInfo, VoiceUpdate,
};
use crate::auth::{self, Pairing, TrustStore, TrustedDevice};
use crate::deck::Deck;
use crate::input::{Command, InputEngine, Interrupts, LayoutMap, Notice, SessionId, Tuning};
use crate::prefs::DeviceSettings;
use crate::protocol::{Features, KeyboardLayout, NoticeLevel, ServerMessage, VolumeState};
use crate::{server, store, tls};

#[allow(clippy::large_enum_variant)]
pub(crate) enum Outgoing {
    Message(ServerMessage),
    Close { reason: String, reconnect: bool },
}

pub(crate) const STOPPED_SHARING: &str = "The Mac stopped sharing.";

pub(crate) struct LiveSession {
    pub info: ConnectedDevice,
    /// Authorizes HTTP requests (app icons) made on behalf of this session.
    pub key: String,
    pub tx: mpsc::UnboundedSender<Outgoing>,
}

pub(crate) struct PendingApproval {
    pub request: ApprovalRequest,
    pub reply: oneshot::Sender<bool>,
}

pub(crate) struct State {
    pub trust: TrustStore,
    pub pairing: Pairing,
    pub deck: Deck,
    pub layout: Option<KeyboardLayout>,
    pub volume: Option<VolumeState>,
    pub paused: bool,
    pub sessions: HashMap<SessionId, LiveSession>,
    pub approvals: HashMap<u64, PendingApproval>,
}

pub(crate) type IconCache = HashMap<(String, u32), Arc<Vec<u8>>>;

pub(crate) struct Shared {
    pub config: RwLock<HostConfig>,
    pub delegate: Arc<dyn HostDelegate>,
    pub engine: Mutex<Sender<Command>>,
    pub interrupts: Arc<Interrupts>,
    /// Serializes clipboard swaps so overlapping pastes can't lose the
    /// clipboard the user had before.
    pub paste_lock: Mutex<()>,
    /// Keeps the saved deck file and the in-memory deck in step.
    pub deck_lock: Mutex<()>,
    /// Open connections per address; see `server::ConnectionSlot`.
    pub connections: Mutex<HashMap<IpAddr, usize>>,
    pub settings: Mutex<DeviceSettings>,
    state: Mutex<State>,
    pub tls: RwLock<Option<Arc<tls::Identity>>>,
    pub port: AtomicU16,
    next_id: AtomicU64,
    pub icons: Mutex<IconCache>,
    pub permission: Box<dyn Fn() -> bool + Send + Sync>,
}

impl Shared {
    pub(crate) fn new(
        config: HostConfig,
        delegate: Arc<dyn HostDelegate>,
        engine: &InputEngine,
        permission: Box<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        let dir = data_dir(&config);
        let trust = TrustStore::load(dir.as_ref().map(|d| d.join("devices.json")));
        let mut settings = DeviceSettings::load(dir.as_ref().map(|d| d.join("settings")));
        settings.retain(&trust.devices().into_iter().map(|d| d.id).collect::<Vec<_>>());
        let deck = dir
            .as_ref()
            .and_then(|d| store::load::<Deck>(&d.join("deck.json")))
            .filter(|deck| deck.validate().is_ok())
            .unwrap_or_default();
        Self {
            config: RwLock::new(config),
            delegate,
            engine: Mutex::new(engine.sender()),
            interrupts: engine.interrupts(),
            paste_lock: Mutex::new(()),
            deck_lock: Mutex::new(()),
            connections: Mutex::new(HashMap::new()),
            settings: Mutex::new(settings),
            state: Mutex::new(State {
                trust,
                pairing: Pairing::new(Instant::now()),
                deck,
                layout: None,
                volume: None,
                paused: false,
                sessions: HashMap::new(),
                approvals: HashMap::new(),
            }),
            tls: RwLock::new(None),
            port: AtomicU16::new(0),
            next_id: AtomicU64::new(1),
            icons: Mutex::new(HashMap::new()),
            permission,
        }
    }

    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn config(&self) -> HostConfig {
        self.config.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn engine(&self, command: Command) {
        let _ = self.engine.lock().unwrap_or_else(|p| p.into_inner()).send(command);
    }

    /// Wait until the engine has processed everything queued so far.
    pub fn flush_engine(&self) {
        let (tx, rx) = std::sync::mpsc::channel();
        self.engine(Command::Flush(tx));
        let _ = rx.recv_timeout(Duration::from_secs(5));
    }

    /// Call the delegate. Never call this while holding the state lock.
    pub fn emit(&self, event: HostEvent) {
        self.delegate.on_event(event);
    }

    pub fn broadcast(&self, message: ServerMessage) {
        for session in self.state().sessions.values() {
            let _ = session.tx.send(Outgoing::Message(message.clone()));
        }
    }

    pub fn send_to(&self, session: SessionId, message: ServerMessage) {
        if let Some(live) = self.state().sessions.get(&session) {
            let _ = live.tx.send(Outgoing::Message(message));
        }
    }

    /// Whether work started for `session` should stop: input is paused or the
    /// device has disconnected.
    pub fn device_settings(&self) -> MutexGuard<'_, DeviceSettings> {
        self.settings.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn should_stop(&self, session: SessionId) -> bool {
        self.interrupts.should_stop(session) || !self.state().sessions.contains_key(&session)
    }

    pub fn features(&self, secure: bool) -> Features {
        let config = self.config();
        Features { voice: config.voice_available, shell: config.allow_shell, secure, permission: (self.permission)() }
    }

    pub fn data_dir(&self) -> Option<PathBuf> {
        data_dir(&self.config())
    }

    pub fn session_key_valid(&self, key: &str) -> bool {
        !key.is_empty()
            && self.state().sessions.values().any(|s| auth::constant_time_eq(s.key.as_bytes(), key.as_bytes()))
    }

    fn notice(&self, notice: Notice) {
        let (session, code, message) = match notice {
            Notice::SecureInput(session) => (
                session,
                "secureInput",
                "A password field on the Mac is blocking typed input. Click outside it or type on the Mac.",
            ),
            Notice::NoPermission(session) => {
                (session, "permission", "CmdPalm needs Accessibility permission on the Mac to control it.")
            }
        };
        self.send_to(
            session,
            ServerMessage::Notice { level: NoticeLevel::Warning, code: code.into(), message: message.into() },
        );
        if matches!(notice, Notice::NoPermission(_)) {
            self.emit(HostEvent::Notice { message: message.into() });
        }
    }
}

fn data_dir(config: &HostConfig) -> Option<PathBuf> {
    (!config.data_dir.is_empty()).then(|| PathBuf::from(&config.data_dir))
}

/// LAN addresses a phone can reach, Wi-Fi and Ethernet first.
pub fn lan_addresses() -> Vec<IpAddr> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut found: Vec<(u8, IpAddr)> = interfaces
        .into_iter()
        .filter(|iface| !iface.is_loopback())
        .filter_map(|iface| {
            let IpAddr::V4(v4) = iface.ip() else { return None };
            if v4.is_link_local() || v4.is_unspecified() {
                return None;
            }
            let name = iface.name.as_str();
            let rank = if name.starts_with("en") {
                0
            } else if name.starts_with("bridge")
                || name.starts_with("utun")
                || name.starts_with("awdl")
                || name.starts_with("llw")
            {
                // VPNs, Internet Sharing and AirDrop interfaces are rarely what
                // a phone on the same Wi-Fi can reach.
                2
            } else {
                1
            };
            Some((rank, IpAddr::V4(v4)))
        })
        .collect();
    found.sort();
    found.dedup_by_key(|(_, ip)| *ip);
    found.into_iter().map(|(_, ip)| ip).collect()
}

struct Running {
    runtime: tokio::runtime::Runtime,
    shutdown: watch::Sender<bool>,
}

/// The CmdPalm host: owns the input engine and the local server.
#[derive(uniffi::Object)]
pub struct CoreHost {
    shared: Arc<Shared>,
    _engine: Option<InputEngine>,
    running: Mutex<Option<Running>>,
}

impl CoreHost {
    pub(crate) fn with_shared(shared: Arc<Shared>, engine: Option<InputEngine>) -> Self {
        Self { shared, _engine: engine, running: Mutex::new(None) }
    }

    fn running(&self) -> MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn close_sessions(&self, reason: &str, reconnect: bool) {
        let sessions: Vec<_> = self.shared.state().sessions.values().map(|s| s.tx.clone()).collect();
        for tx in sessions {
            let _ = tx.send(Outgoing::Close { reason: reason.into(), reconnect });
        }
    }

    fn close_device(&self, device_id: &str, reason: &str) {
        let sessions: Vec<_> = self
            .shared
            .state()
            .sessions
            .values()
            .filter(|s| s.info.device_id == device_id)
            .map(|s| s.tx.clone())
            .collect();
        for tx in sessions {
            let _ = tx.send(Outgoing::Close { reason: reason.into(), reconnect: false });
        }
    }
}

type Notify = Box<dyn Fn(Notice) + Send>;
type Permission = Box<dyn Fn() -> bool + Send + Sync>;

impl CoreHost {
    fn build(
        config: HostConfig,
        delegate: Arc<dyn HostDelegate>,
        engine: impl FnOnce(Notify) -> (InputEngine, Permission),
    ) -> Arc<Self> {
        let slot: Arc<OnceLock<Weak<Shared>>> = Arc::new(OnceLock::new());
        let notify_slot = slot.clone();
        let notify: Notify = Box::new(move |notice: Notice| {
            if let Some(shared) = notify_slot.get().and_then(Weak::upgrade) {
                shared.notice(notice);
            }
        });
        let (engine, permission) = engine(notify);
        let shared = Arc::new(Shared::new(config, delegate, &engine, permission));
        let _ = slot.set(Arc::downgrade(&shared));
        Arc::new(Self::with_shared(shared, Some(engine)))
    }

    /// A host that logs input instead of posting it (development and demos).
    pub fn dry_run(config: HostConfig, delegate: Arc<dyn HostDelegate>) -> Arc<Self> {
        Self::build(config, delegate, |notify| {
            (InputEngine::spawn(crate::input::LogSink::default, notify), Box::new(|| true))
        })
    }
}

#[uniffi::export]
impl CoreHost {
    #[uniffi::constructor]
    pub fn new(config: HostConfig, delegate: Arc<dyn HostDelegate>) -> Arc<Self> {
        #[cfg(target_os = "macos")]
        return Self::build(config, delegate, |notify| {
            (
                InputEngine::spawn(crate::input::mac::MacSink::new, notify),
                Box::new(crate::input::mac::has_post_permission),
            )
        });
        #[cfg(not(target_os = "macos"))]
        Self::dry_run(config, delegate)
    }

    /// Start serving. Returns the port in use.
    pub fn start(&self) -> Result<u16, HostError> {
        let mut running = self.running();
        if running.is_some() {
            return Ok(self.shared.port.load(Ordering::Relaxed));
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("cmdpalm-net")
            .enable_all()
            .build()
            .map_err(|e| HostError::new(format!("could not start the network runtime: {e}")))?;
        let (shutdown, shutdown_rx) = watch::channel(false);
        let shared = self.shared.clone();
        let (port, taken) = runtime.block_on(server::start(shared, shutdown_rx)).map_err(|e| {
            let message = e.to_string();
            self.shared.emit(HostEvent::Failed { message: message.clone() });
            HostError::new(message)
        })?;
        *running = Some(Running { runtime, shutdown });
        drop(running);
        self.shared.emit(HostEvent::Started { port, preferred_port_taken: taken });
        Ok(port)
    }

    pub fn stop(&self) {
        let Some(running) = self.running().take() else {
            return;
        };
        self.close_sessions(STOPPED_SHARING, true);
        let _ = running.shutdown.send(true);
        // Give sessions a moment to send their goodbye frames.
        std::thread::sleep(Duration::from_millis(100));
        running.runtime.shutdown_timeout(Duration::from_secs(1));
        // Session tasks may have been dropped mid-flight; release their input.
        let ids: Vec<SessionId> = self.shared.state().sessions.drain().map(|(id, _)| id).collect();
        for id in ids {
            self.shared.interrupts.end(id);
            self.shared.engine(Command::EndSession(id));
        }
        let approvals: Vec<u64> = self.shared.state().approvals.drain().map(|(id, _)| id).collect();
        for id in approvals {
            self.shared.emit(HostEvent::ApprovalEnded { id });
        }
        self.shared.emit(HostEvent::Stopped);
        self.shared.emit(HostEvent::SessionsChanged);
    }

    pub fn is_running(&self) -> bool {
        self.running().is_some()
    }

    pub fn update_config(&self, config: HostConfig) {
        let previous = self.shared.config();
        *self.shared.config.write().unwrap_or_else(|p| p.into_inner()) = config.clone();
        if previous.allow_shell != config.allow_shell || previous.voice_available != config.voice_available {
            let permission = (self.shared.permission)();
            let sessions: Vec<_> =
                self.shared.state().sessions.values().map(|s| (s.tx.clone(), s.info.secure)).collect();
            for (tx, secure) in sessions {
                let features =
                    Features { voice: config.voice_available, shell: config.allow_shell, secure, permission };
                let _ = tx.send(Outgoing::Message(ServerMessage::Features { features }));
            }
        }
        if previous.link_uses_host_name != config.link_uses_host_name || previous.host_name != config.host_name {
            self.shared.emit(HostEvent::PairingChanged);
        }
    }

    pub fn pairing_info(&self) -> PairingInfo {
        let config = self.shared.config();
        let port = self.shared.port.load(Ordering::Relaxed);
        let addresses = lan_addresses();
        let ip = addresses.first().map(IpAddr::to_string).unwrap_or_else(|| "127.0.0.1".into());
        let host = config.host_name.trim().trim_end_matches('.').to_string();
        let link_host = if config.link_uses_host_name && !host.is_empty() { host } else { ip };
        let mut state = self.shared.state();
        let now = Instant::now();
        state.pairing.refresh(now);
        let address = format!("http://{link_host}:{port}");
        let info = PairingInfo {
            link: format!("{address}/#pair={}", state.pairing.code()),
            secure_address: format!("https://{link_host}:{port}"),
            address,
            pin: state.pairing.pin().to_string(),
            expires_in_secs: state.pairing.expires_in(now).as_secs() as u32,
            port,
            addresses: addresses.iter().map(IpAddr::to_string).collect(),
            ca_fingerprint: String::new(),
        };
        drop(state);
        let fingerprint = self
            .shared
            .tls
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|id| id.ca_fingerprint.clone())
            .unwrap_or_default();
        PairingInfo { ca_fingerprint: fingerprint, ..info }
    }

    /// Invalidate the current QR code and PIN.
    pub fn renew_pairing(&self) {
        self.shared.state().pairing.rotate(Instant::now());
        self.shared.emit(HostEvent::PairingChanged);
    }

    pub fn connected_devices(&self) -> Vec<ConnectedDevice> {
        let mut list: Vec<_> = self.shared.state().sessions.values().map(|s| s.info.clone()).collect();
        list.sort_by_key(|d| d.connected_at);
        list
    }

    pub fn trusted_devices(&self) -> Vec<TrustedDevice> {
        self.shared
            .state()
            .trust
            .devices()
            .into_iter()
            .map(|d| TrustedDevice { name: auth::visible_name(&d.name), ..d })
            .collect()
    }

    pub fn forget_device(&self, id: String) {
        let removed = self.shared.state().trust.remove(&id);
        self.shared.device_settings().remove(&id);
        self.close_device(&id, "This device was removed on the Mac. Pair again to reconnect.");
        if removed {
            self.shared.emit(HostEvent::DevicesChanged);
        }
    }

    pub fn forget_all_devices(&self) {
        self.shared.state().trust.clear();
        self.shared.device_settings().retain(&[]);
        self.close_sessions("All devices were removed on the Mac. Pair again to reconnect.", false);
        self.shared.emit(HostEvent::DevicesChanged);
    }

    pub fn rename_device(&self, id: String, name: String) {
        if self.shared.state().trust.rename(&id, &name) {
            self.shared.emit(HostEvent::DevicesChanged);
        }
    }

    pub fn disconnect(&self, session: u64) {
        if let Some(live) = self.shared.state().sessions.get(&session) {
            let _ = live.tx.send(Outgoing::Close { reason: "Disconnected from the Mac.".into(), reconnect: false });
        }
    }

    pub fn respond_approval(&self, id: u64, allow: bool) {
        let pending = self.shared.state().approvals.remove(&id);
        if let Some(pending) = pending {
            let _ = pending.reply.send(allow);
            self.shared.emit(HostEvent::ApprovalEnded { id });
        }
    }

    /// Ignore all input from devices until resumed. Held keys are released.
    pub fn set_paused(&self, paused: bool) {
        {
            let mut state = self.shared.state();
            if state.paused == paused {
                return;
            }
            state.paused = paused;
        }
        self.shared.interrupts.set_paused(paused);
        self.shared.engine(Command::SetPaused(paused));
        self.shared.broadcast(ServerMessage::Paused { paused });
    }

    pub fn is_paused(&self) -> bool {
        self.shared.state().paused
    }

    /// The Mac's active keyboard layout changed.
    pub fn set_layout(&self, layout: KeyboardLayout) {
        self.shared.engine(Command::Layout(LayoutMap::from_layout(&layout)));
        self.shared.state().layout = Some(layout.clone());
        self.shared.broadcast(ServerMessage::Layout { layout });
    }

    pub fn set_volume_state(&self, value: f32, muted: bool) {
        let volume = VolumeState { value: value.clamp(0.0, 1.0), muted };
        {
            let mut state = self.shared.state();
            if state.volume == Some(volume) {
                return;
            }
            state.volume = Some(volume);
        }
        self.shared.broadcast(ServerMessage::Volume(volume));
    }

    pub fn clear_volume_state(&self) {
        if self.shared.state().volume.take().is_some() {
            self.shared.broadcast(ServerMessage::VolumeUnavailable);
        }
    }

    /// Apps launched, quit, hid or changed focus.
    pub fn apps_changed(&self) {
        self.shared.broadcast(ServerMessage::AppsChanged);
    }

    pub fn set_input_timing(&self, repeat_delay_ms: u32, repeat_interval_ms: u32, double_click_ms: u32) {
        let defaults = Tuning::default();
        let ms = |v: u32, lo: u64, hi: u64| Duration::from_millis((v as u64).clamp(lo, hi));
        self.shared.engine(Command::Tuning(Tuning {
            key_repeat_delay: ms(repeat_delay_ms, 100, 3_000),
            key_repeat_interval: ms(repeat_interval_ms, 15, 2_000),
            double_click_interval: ms(double_click_ms, 150, 5_000),
            ..defaults
        }));
    }

    /// Accessibility permission was granted or revoked.
    pub fn permission_changed(&self) {
        let permission = (self.shared.permission)();
        let config = self.shared.config();
        let sessions: Vec<_> = self.shared.state().sessions.values().map(|s| (s.tx.clone(), s.info.secure)).collect();
        for (tx, secure) in sessions {
            let features = Features { voice: config.voice_available, shell: config.allow_shell, secure, permission };
            let _ = tx.send(Outgoing::Message(ServerMessage::Features { features }));
        }
    }

    pub fn voice_update(&self, session: u64, update: VoiceUpdate) {
        self.shared.send_to(
            session,
            ServerMessage::Voice {
                state: update.state,
                text: update.text,
                is_final: update.is_final,
                message: update.message,
            },
        );
    }

    pub fn deck_json(&self) -> String {
        serde_json::to_string_pretty(&self.shared.state().deck).unwrap_or_default()
    }

    pub fn set_deck_json(&self, json: String) -> Result<(), HostError> {
        let deck: Deck = serde_json::from_str(&json).map_err(|e| HostError::new(format!("invalid deck: {e}")))?;
        server::save_deck(&self.shared, deck).map_err(|e| HostError::new(e.to_string()))
    }

    pub fn reset_deck(&self) {
        let _ = server::save_deck(&self.shared, Deck::default());
    }

    /// The CA certificate (DER) to install on devices for trusted HTTPS.
    pub fn ca_certificate(&self) -> Vec<u8> {
        self.shared
            .tls
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|id| id.ca_der.clone())
            .unwrap_or_default()
    }
}

impl Drop for CoreHost {
    fn drop(&mut self) {
        self.stop();
    }
}
