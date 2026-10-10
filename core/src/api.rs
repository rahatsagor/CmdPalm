//! Types shared with Swift through UniFFI.

use crate::protocol::{AppEntry, AppOp, VoiceState};

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct HostConfig {
    /// Preferred TCP port. If it is taken the next free port is used.
    pub port: u16,
    /// Where pairing data, the deck and certificates are stored.
    pub data_dir: String,
    /// Directory containing the built web client.
    pub web_root: String,
    /// Bonjour host name, e.g. `Studio.local`.
    pub host_name: String,
    /// The Mac's display name shown on the phone.
    pub computer_name: String,
    pub app_version: String,
    /// Address used in the pairing link: the Bonjour name (survives IP
    /// changes) or the current IP address (works on networks without mDNS).
    pub link_uses_host_name: bool,
    pub allow_pin: bool,
    pub allow_approval: bool,
    /// Lets deck buttons run shell commands. Off by default.
    pub allow_shell: bool,
    /// Whether the Mac can transcribe speech streamed from the phone.
    pub voice_available: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PairingInfo {
    /// Link encoded in the QR code. Contains the one-time pairing code in the
    /// URL fragment so it never reaches server logs or proxies.
    pub link: String,
    /// Address to type by hand, without the pairing code.
    pub address: String,
    pub secure_address: String,
    pub pin: String,
    pub expires_in_secs: u32,
    pub port: u16,
    pub addresses: Vec<String>,
    pub ca_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ConnectedDevice {
    pub session: u64,
    pub device_id: String,
    pub name: String,
    pub model: String,
    pub address: String,
    pub connected_at: i64,
    pub secure: bool,
    pub remembered: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ApprovalRequest {
    pub id: u64,
    pub device_name: String,
    pub model: String,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum HostEvent {
    Started {
        port: u16,
        preferred_port_taken: bool,
    },
    Stopped,
    Failed {
        message: String,
    },
    SessionsChanged,
    DevicesChanged,
    PairingChanged,
    ApprovalRequested {
        request: ApprovalRequest,
    },
    /// The request was answered elsewhere or the device gave up.
    ApprovalEnded {
        id: u64,
    },
    Paired {
        name: String,
    },
    /// Something the person at the Mac should know (e.g. missing permission).
    Notice {
        message: String,
    },
}

/// Actions that need AppKit or other system services.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum NativeCommand {
    MissionControl,
    Launchpad,
    LockScreen,
    SleepDisplay,
    Sleep,
}

/// Implemented in Swift. Called from background threads; implementations
/// must be thread-safe and must not call back into [`crate::host::CoreHost`]
/// synchronously from the main thread while waiting on these calls.
#[uniffi::export(with_foreign)]
pub trait HostDelegate: Send + Sync {
    fn on_event(&self, event: HostEvent);
    fn list_apps(&self) -> Vec<AppEntry>;
    /// PNG data for an app icon at `size` pixels.
    fn app_icon(&self, id: String, size: u32) -> Option<Vec<u8>>;
    fn app_action(&self, id: String, op: AppOp) -> bool;
    fn open_url(&self, url: String) -> bool;
    fn native(&self, command: NativeCommand) -> bool;
    fn run_shortcut(&self, name: String) -> bool;
    fn set_volume(&self, value: Option<f32>, muted: Option<bool>);
    fn clipboard_text(&self) -> Option<String>;
    fn set_clipboard_text(&self, text: String);
    /// Save the clipboard and replace it with `text` for a paste.
    fn begin_paste(&self, text: String) -> bool;
    /// Restore the clipboard saved by [`HostDelegate::begin_paste`].
    fn end_paste(&self);
    fn voice_start(&self, session: u64, locale: Option<String>) -> bool;
    /// 16 kHz mono signed 16-bit little-endian PCM.
    fn voice_audio(&self, session: u64, pcm: Vec<u8>);
    fn voice_stop(&self, session: u64, cancel: bool);
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct VoiceUpdate {
    pub state: VoiceState,
    pub text: Option<String>,
    pub is_final: bool,
    pub message: Option<String>,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum HostError {
    #[error("{message}")]
    Failed { message: String },
}

impl HostError {
    pub fn new(message: impl Into<String>) -> Self {
        HostError::Failed { message: message.into() }
    }
}
