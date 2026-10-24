//! Wire protocol between the web client and the Mac.
//!
//! Text frames carry JSON objects tagged by `t`. High-frequency pointer data
//! uses compact binary frames (see [`binary`]). `docs/PROTOCOL.md` documents
//! the format and `web/src/lib/protocol.ts` mirrors these types; keep all three
//! in sync and bump [`PROTOCOL_VERSION`] for incompatible changes.

use serde::{Deserialize, Serialize};

use crate::deck::Deck;
use crate::prefs::SavedSettings;

pub const PROTOCOL_VERSION: u32 = 1;

/// Binary frame layouts (little-endian).
pub mod binary {
    /// `[op, dx: f32, dy: f32]` relative pointer motion in points.
    pub const MOVE: u8 = 0x01;
    /// `[op, phase: u8, dx: f32, dy: f32]` continuous scroll in pixels.
    pub const SCROLL: u8 = 0x02;
    /// `[op, vx: f32, vy: f32]` release velocity (px/s) that starts momentum.
    pub const FLING: u8 = 0x03;
    /// `[op]` a finger touched the surface; stops momentum like a real trackpad.
    pub const TOUCH: u8 = 0x04;
    /// `[op, pcm: i16le...]` 16 kHz mono microphone audio for voice typing.
    pub const AUDIO: u8 = 0x10;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "camelCase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PressOp {
    Down,
    Up,
    Click,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "camelCase")]
pub enum MediaKey {
    VolumeUp,
    VolumeDown,
    Mute,
    BrightnessUp,
    BrightnessDown,
    PlayPause,
    Next,
    Previous,
    FastForward,
    Rewind,
    IlluminationUp,
    IlluminationDown,
    IlluminationToggle,
}

impl MediaKey {
    /// `NX_KEYTYPE_*` value from IOKit `ev_keymap.h`.
    pub fn nx_keytype(self) -> i32 {
        match self {
            MediaKey::VolumeUp => 0,
            MediaKey::VolumeDown => 1,
            MediaKey::BrightnessUp => 2,
            MediaKey::BrightnessDown => 3,
            MediaKey::Mute => 7,
            MediaKey::PlayPause => 16,
            MediaKey::Next => 17,
            MediaKey::Previous => 18,
            MediaKey::FastForward => 19,
            MediaKey::Rewind => 20,
            MediaKey::IlluminationUp => 21,
            MediaKey::IlluminationDown => 22,
            MediaKey::IlluminationToggle => 23,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "camelCase")]
pub enum AppOp {
    /// Launch or bring to front.
    #[default]
    Open,
    /// Hide when frontmost, otherwise bring to front.
    Toggle,
    Hide,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemAction {
    MissionControl,
    AppExpose,
    ShowDesktop,
    Launchpad,
    Spotlight,
    SpaceLeft,
    SpaceRight,
    AppSwitcher,
    LockScreen,
    SleepDisplay,
    Sleep,
    Screenshot,
    ScreenshotArea,
    ScreenshotTool,
    ForceQuit,
    EmojiPicker,
    CloseWindow,
    QuitApp,
    Minimize,
    HideApp,
    Fullscreen,
    Undo,
    Redo,
    Copy,
    Cut,
    Paste,
    SelectAll,
    Find,
    NewTab,
    CloseTab,
    NextTab,
    PreviousTab,
    Back,
    Forward,
    Reload,
    ZoomIn,
    ZoomOut,
    ActualSize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    /// A key with modifiers, e.g. ⌘⇧4. `code` is the ANSI position; `char`
    /// lets the Mac re-resolve letters for non-QWERTY layouts.
    Keys {
        code: u16,
        #[serde(default)]
        mods: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        char: Option<String>,
    },
    Text {
        text: String,
        #[serde(default)]
        enter: bool,
    },
    Media {
        key: MediaKey,
    },
    App {
        id: String,
        #[serde(default)]
        op: AppOp,
    },
    Url {
        url: String,
    },
    System {
        name: SystemAction,
    },
    /// Runs a macOS Shortcuts automation by name.
    Shortcut {
        name: String,
    },
    /// Runs a shell command. Disabled unless allowed in the Mac settings.
    Shell {
        command: String,
    },
    Mouse {
        button: MouseButton,
        #[serde(default = "one")]
        clicks: u8,
    },
    Delay {
        ms: u32,
    },
    Sequence {
        steps: Vec<Action>,
    },
}

fn one() -> u8 {
    1
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextMode {
    /// Unicode text events; independent of the Mac's keyboard layout.
    #[default]
    Unicode,
    /// Real key presses resolved through the Mac layout; works in apps that
    /// ignore Unicode events (games, VMs, remote desktops).
    Keystrokes,
    /// Put the text on the clipboard and press ⌘V, then restore the clipboard.
    Paste,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum AuthRequest {
    /// Reconnect with the token issued at pairing.
    Token { token: String },
    /// One-time code embedded in the pairing QR code.
    Pair { code: String },
    /// Six-digit PIN shown on the Mac.
    Pin { pin: String },
    /// Ask the person at the Mac to approve this device.
    Approve,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    Hello {
        v: u32,
        device: DeviceInfo,
        auth: AuthRequest,
        #[serde(default = "yes")]
        remember: bool,
    },
    Ping {
        #[serde(default)]
        id: u32,
    },
    /// Press or release a key. Modifiers in `mods` are held only for this key
    /// (one-shot "sticky" modifiers from the client).
    Key {
        code: u16,
        down: bool,
        #[serde(default)]
        mods: u16,
        #[serde(default = "yes")]
        repeat: bool,
    },
    /// Press and release a key with modifiers as one atomic combo.
    Tap {
        code: u16,
        #[serde(default)]
        mods: u16,
    },
    Button {
        button: MouseButton,
        op: PressOp,
        #[serde(default)]
        mods: u16,
    },
    Media {
        key: MediaKey,
        op: PressOp,
    },
    Text {
        text: String,
        #[serde(default)]
        mode: TextMode,
    },
    /// Live dictation correction: delete `delete` characters before the caret,
    /// then insert `insert`.
    Edit {
        delete: u32,
        insert: String,
    },
    Action {
        action: Action,
        #[serde(default)]
        id: Option<u32>,
    },
    /// Release every key and button this device holds.
    Release,
    Apps,
    AppAction {
        id: String,
        op: AppOp,
    },
    DeckSave {
        deck: Deck,
    },
    Volume {
        #[serde(default)]
        value: Option<f32>,
        #[serde(default)]
        muted: Option<bool>,
    },
    ClipboardSet {
        text: String,
    },
    ClipboardGet,
    VoiceStart {
        #[serde(default)]
        locale: Option<String>,
    },
    VoiceStop {
        #[serde(default)]
        cancel: bool,
    },
    /// This device's own phone settings, to keep on the Mac.
    SettingsSave {
        settings: serde_json::Value,
        updated_at: u64,
    },
    /// Other paired devices whose settings could be copied.
    SettingsList,
    SettingsCopy {
        from: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSource {
    pub id: String,
    pub name: String,
    pub model: String,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub name: String,
    pub version: String,
    pub os: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub voice: bool,
    pub shell: bool,
    pub secure: bool,
    pub permission: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct KeyCap {
    pub code: u16,
    pub base: String,
    pub shift: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub option: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub option_shift: String,
    /// Levels that start a dead-key sequence instead of typing: bit 0 base,
    /// 1 shift, 2 option, 3 option-shift. Their labels are for display only.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub dead: u8,
}

fn is_zero(value: &u8) -> bool {
    *value == 0
}

#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardLayout {
    pub id: String,
    pub name: String,
    /// True when the layout uses ISO geometry (extra key left of Z).
    pub iso: bool,
    pub keys: Vec<KeyCap>,
}

#[derive(Debug, Clone, PartialEq, Serialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub running: bool,
    pub active: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DenyReason {
    /// The trust token is unknown or was revoked; pair again.
    Unknown,
    WrongPin,
    /// The PIN isn't shown on the Mac right now, so it can't be used.
    PinClosed,
    ExpiredCode,
    Rejected,
    Blocked,
    Busy,
    Incompatible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, uniffi::Enum)]
#[serde(rename_all = "camelCase")]
pub enum VoiceState {
    Listening,
    Stopped,
    Unavailable,
    Error,
}

#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    Welcome {
        v: u32,
        host: HostInfo,
        /// Short-lived key for authenticated HTTP requests (app icons).
        session_key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        token: Option<String>,
        features: Features,
        deck: Deck,
        #[serde(skip_serializing_if = "Option::is_none")]
        layout: Option<KeyboardLayout>,
        #[serde(skip_serializing_if = "Option::is_none")]
        volume: Option<VolumeState>,
        paused: bool,
        /// The settings this device saved on the Mac earlier.
        #[serde(skip_serializing_if = "Option::is_none")]
        settings: Option<SavedSettings>,
    },
    Pending,
    Denied {
        reason: DenyReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_after: Option<u32>,
    },
    Pong {
        id: u32,
    },
    Apps {
        apps: Vec<AppEntry>,
    },
    AppsChanged,
    Deck {
        deck: Deck,
    },
    Layout {
        layout: KeyboardLayout,
    },
    Volume(VolumeState),
    /// The current output device has no software volume (e.g. HDMI).
    VolumeUnavailable,
    Paused {
        paused: bool,
    },
    Features {
        features: Features,
    },
    Notice {
        level: NoticeLevel,
        code: String,
        message: String,
    },
    Clipboard {
        text: String,
    },
    Voice {
        state: VoiceState,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(rename = "final")]
        is_final: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    ActionResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u32>,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    SettingsList {
        devices: Vec<SettingsSource>,
    },
    Settings(SavedSettings),
    Bye {
        reason: String,
        /// The Mac is only restarting its server, so the device should come
        /// back on its own. Otherwise it stays disconnected until the person
        /// using it reconnects.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        reconnect: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct VolumeState {
    pub value: f32,
    pub muted: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_client_messages() {
        let hello: ClientMessage = serde_json::from_str(
            r#"{"t":"hello","v":1,"device":{"id":"abc","name":"iPhone"},"auth":{"method":"pin","pin":"123456"}}"#,
        )
        .unwrap();
        assert!(matches!(hello, ClientMessage::Hello { remember: true, auth: AuthRequest::Pin { .. }, .. }));

        let key: ClientMessage = serde_json::from_str(r#"{"t":"key","code":0,"down":true}"#).unwrap();
        assert!(matches!(key, ClientMessage::Key { code: 0, down: true, mods: 0, repeat: true }));

        let action: ClientMessage = serde_json::from_str(
            r#"{"t":"action","action":{"kind":"sequence","steps":[{"kind":"keys","code":8,"mods":1},{"kind":"delay","ms":50},{"kind":"system","name":"missionControl"}]}}"#,
        )
        .unwrap();
        let ClientMessage::Action { action: Action::Sequence { steps }, .. } = action else {
            panic!("expected sequence");
        };
        assert_eq!(steps.len(), 3);

        let edit: ClientMessage = serde_json::from_str(r#"{"t":"edit","delete":2,"insert":"hé"}"#).unwrap();
        assert!(matches!(edit, ClientMessage::Edit { delete: 2, .. }));
    }

    #[test]
    fn rejects_unknown_messages() {
        assert!(serde_json::from_str::<ClientMessage>(r#"{"t":"rm -rf"}"#).is_err());
    }

    #[test]
    fn serializes_server_messages_with_camel_case_fields() {
        let json = serde_json::to_string(&ServerMessage::Denied { reason: DenyReason::WrongPin, retry_after: Some(4) })
            .unwrap();
        assert_eq!(json, r#"{"t":"denied","reason":"wrongPin","retryAfter":4}"#);

        let json = serde_json::to_string(&ServerMessage::Volume(VolumeState { value: 0.5, muted: false })).unwrap();
        assert_eq!(json, r#"{"t":"volume","value":0.5,"muted":false}"#);
        assert_eq!(serde_json::to_string(&ServerMessage::VolumeUnavailable).unwrap(), r#"{"t":"volumeUnavailable"}"#);

        let json = serde_json::to_string(&ServerMessage::Voice {
            state: VoiceState::Listening,
            text: Some("hi".into()),
            is_final: false,
            message: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"t":"voice","state":"listening","text":"hi","final":false}"#);

        let json = serde_json::to_string(&ServerMessage::Bye { reason: "x".into(), reconnect: false }).unwrap();
        assert_eq!(json, r#"{"t":"bye","reason":"x"}"#);
        let json = serde_json::to_string(&ServerMessage::Bye { reason: "x".into(), reconnect: true }).unwrap();
        assert_eq!(json, r#"{"t":"bye","reason":"x","reconnect":true}"#);
    }
}
