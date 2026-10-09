//! Runs the CmdPalm host without the Mac app, for working on the web client.
//!
//!     cargo run -p cmdpalm-core --example dev-host            # logs input
//!     cargo run -p cmdpalm-core --example dev-host -- --live  # really moves the pointer
//!
//! Set CMDPALM_NAME to change the Mac name shown on the phone.
//!
//! Then `cd web && bun run dev` and open the printed pairing link (or the
//! Vite URL and enter the PIN).

use std::sync::{Arc, Mutex};

use cmdpalm_core::api::{HostConfig, HostDelegate, HostEvent, NativeCommand};
use cmdpalm_core::host::CoreHost;
use cmdpalm_core::protocol::{AppEntry, AppOp};

struct Delegate {
    volume: Mutex<(f32, bool)>,
    clipboard: Mutex<String>,
}

impl HostDelegate for Delegate {
    fn on_event(&self, event: HostEvent) {
        println!("event: {event:?}");
    }
    fn list_apps(&self) -> Vec<AppEntry> {
        [
            ("com.apple.Safari", "Safari", true, true),
            ("com.apple.finder", "Finder", true, false),
            ("com.apple.Music", "Music", true, false),
            ("com.apple.Notes", "Notes", false, false),
            ("com.apple.Terminal", "Terminal", false, false),
        ]
        .into_iter()
        .map(|(id, name, running, active)| AppEntry {
            id: id.into(),
            name: name.into(),
            running,
            active,
            hidden: false,
        })
        .collect()
    }
    fn app_icon(&self, _id: String, _size: u32) -> Option<Vec<u8>> {
        None
    }
    fn app_action(&self, id: String, op: AppOp) -> bool {
        println!("app: {op:?} {id}");
        true
    }
    fn open_url(&self, url: String) -> bool {
        println!("open: {url}");
        true
    }
    fn native(&self, command: NativeCommand) -> bool {
        println!("native: {command:?}");
        true
    }
    fn run_shortcut(&self, name: String) -> bool {
        println!("shortcut: {name}");
        true
    }
    fn set_volume(&self, value: Option<f32>, muted: Option<bool>) {
        let mut volume = self.volume.lock().unwrap();
        if let Some(value) = value {
            volume.0 = value;
        }
        if let Some(muted) = muted {
            volume.1 = muted;
        }
        println!("volume: {volume:?}");
    }
    fn clipboard_text(&self) -> Option<String> {
        Some(self.clipboard.lock().unwrap().clone())
    }
    fn set_clipboard_text(&self, text: String) {
        *self.clipboard.lock().unwrap() = text;
    }
    fn begin_paste(&self, text: String) -> bool {
        println!("paste: {text:?}");
        true
    }
    fn end_paste(&self) {}
    fn voice_start(&self, _session: u64, _locale: Option<String>) -> bool {
        false
    }
    fn voice_audio(&self, _session: u64, _pcm: Vec<u8>) {}
    fn voice_stop(&self, _session: u64, _cancel: bool) {}
}

fn main() {
    let live = std::env::args().any(|a| a == "--live");
    cmdpalm_core::init_logging(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,cmdpalm::synth=info".into()));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let data_dir = std::env::temp_dir().join("cmdpalm-dev-host");
    let config = HostConfig {
        port: std::env::var("CMDPALM_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8790),
        data_dir: data_dir.to_string_lossy().into(),
        web_root: root.join("web/dist").to_string_lossy().into(),
        host_name: String::new(),
        computer_name: std::env::var("CMDPALM_NAME").unwrap_or_else(|_| "Dev Host".into()),
        app_version: env!("CARGO_PKG_VERSION").into(),
        link_uses_host_name: false,
        allow_pin: true,
        allow_approval: false,
        allow_shell: false,
        voice_available: false,
    };
    let delegate = Arc::new(Delegate { volume: Mutex::new((0.5, false)), clipboard: Mutex::new(String::new()) });
    let host = if live { CoreHost::new(config, delegate) } else { CoreHost::dry_run(config, delegate) };
    match host.start() {
        Ok(port) => {
            let info = host.pairing_info();
            println!("\nCmdPalm dev host on port {port} ({})", if live { "LIVE input" } else { "dry run" });
            println!("  link: {}\n  PIN:  {}\n", info.link, info.pin);
        }
        Err(err) => {
            eprintln!("could not start: {err}");
            std::process::exit(1);
        }
    }
    loop {
        std::thread::park();
    }
}
