//! End-to-end tests: a real server on a loopback port, a WebSocket client,
//! and an input engine that records the events it would post.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

use crate::api::{HostConfig, HostDelegate, HostEvent, LinkHost, NativeCommand};
use crate::host::{CoreHost, Shared};
use crate::input::{InputEngine, SharedRecorder, Synth};
use crate::keycodes::{KEY_COMMAND, KEY_Q, flags};
use crate::protocol::{AppEntry, AppOp};

#[derive(Default)]
struct MockDelegate {
    events: Mutex<Vec<HostEvent>>,
    opened: Mutex<Vec<String>>,
    voice: Mutex<Vec<&'static str>>,
    /// The next app list is slow and lists an app that has since quit.
    slow_stale_apps: std::sync::atomic::AtomicBool,
}

impl HostDelegate for MockDelegate {
    fn on_event(&self, event: HostEvent) {
        self.events.lock().unwrap().push(event);
    }
    fn list_apps(&self) -> Vec<AppEntry> {
        if self.slow_stale_apps.swap(false, std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(300));
            return vec![AppEntry {
                id: "com.quit".into(),
                name: "Quit".into(),
                running: true,
                active: false,
                hidden: false,
            }];
        }
        vec![AppEntry {
            id: "com.apple.Safari".into(),
            name: "Safari".into(),
            running: true,
            active: false,
            hidden: false,
        }]
    }
    fn app_icon(&self, _id: String, _size: u32) -> Option<Vec<u8>> {
        Some(b"\x89PNG".to_vec())
    }
    fn app_action(&self, id: String, _op: AppOp) -> bool {
        self.opened.lock().unwrap().push(id);
        true
    }
    fn open_url(&self, _url: String) -> bool {
        true
    }
    fn native(&self, _command: NativeCommand) -> bool {
        true
    }
    fn run_shortcut(&self, _name: String) -> bool {
        true
    }
    fn set_volume(&self, _value: Option<f32>, _muted: Option<bool>) {}
    fn clipboard_text(&self) -> Option<String> {
        Some("from mac".into())
    }
    fn set_clipboard_text(&self, _text: String) {}
    fn begin_paste(&self, _text: String) -> bool {
        true
    }
    fn end_paste(&self) {}
    fn voice_start(&self, _session: u64, _locale: Option<String>) -> bool {
        // Starting recognition is slow; a stop sent meanwhile must wait for it.
        std::thread::sleep(Duration::from_millis(100));
        self.voice.lock().unwrap().push("start");
        true
    }
    fn voice_audio(&self, _session: u64, _pcm: Vec<u8>) {}
    fn voice_stop(&self, _session: u64, _cancel: bool) {
        self.voice.lock().unwrap().push("stop");
    }
}

struct Fixture {
    host: CoreHost,
    config: HostConfig,
    delegate: Arc<MockDelegate>,
    recorder: SharedRecorder,
    port: u16,
    _dir: tempfile::TempDir,
    rt: tokio::runtime::Runtime,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let web = dir.path().join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html><title>CmdPalm</title>").unwrap();
    std::fs::write(web.join("assets/app-1234.js"), "console.log(1)").unwrap();
    let config = HostConfig {
        port: 0,
        data_dir: dir.path().join("data").to_string_lossy().into(),
        web_root: web.to_string_lossy().into(),
        host_name: "Test.local".into(),
        computer_name: "Test Mac".into(),
        app_version: "1.0.0".into(),
        link_host: LinkHost::HostName,
        allow_local_proxy: false,
        allow_pin: true,
        allow_approval: true,
        allow_shell: false,
        voice_available: true,
    };
    let recorder = SharedRecorder::default();
    let sink = recorder.clone();
    let engine = InputEngine::spawn(move || sink, Box::new(|_| {}));
    let delegate = Arc::new(MockDelegate::default());
    let shared = Arc::new(Shared::new(config.clone(), delegate.clone(), &engine, Box::new(|| true)));
    let host = CoreHost::with_shared(shared, Some(engine));
    let port = host.start().unwrap();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    Fixture { host, config, delegate, recorder, port, _dir: dir, rt }
}

type Client = tokio_tungstenite::WebSocketStream<TcpStream>;

async fn connect(port: u16) -> Client {
    let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let (ws, _) = tokio_tungstenite::client_async(format!("ws://127.0.0.1:{port}/ws"), tcp).await.unwrap();
    ws
}

async fn send(ws: &mut Client, value: Value) {
    ws.send(Message::text(value.to_string())).await.unwrap();
}

async fn recv(ws: &mut Client) -> Value {
    loop {
        let message =
            tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timed out").unwrap().unwrap();
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

async fn recv_kind(ws: &mut Client, kind: &str) -> Value {
    loop {
        let value = recv(ws).await;
        if value["t"] == kind {
            return value;
        }
    }
}

fn hello(device: &str, auth: Value) -> Value {
    json!({"t": "hello", "v": 1, "device": {"id": device, "name": "Test Phone", "model": "iPhone"}, "auth": auth})
}

#[test]
fn pin_pairing_then_token_reconnect() {
    let f = fixture();
    let pin = f.host.pairing_info().pin;
    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("phone-1", json!({"method": "pin", "pin": pin}))).await;
        assert_eq!(recv(&mut ws).await["reason"], "pinClosed", "the PIN only works while the Mac shows it");
    });
    f.host.set_pin_shown(true);
    let token = f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("phone-1", json!({"method": "pin", "pin": "000001"}))).await;
        assert_eq!(recv(&mut ws).await["reason"], "wrongPin");

        let mut ws = connect(f.port).await;
        send(&mut ws, hello("phone-1", json!({"method": "pin", "pin": pin}))).await;
        let welcome = recv(&mut ws).await;
        assert_eq!(welcome["t"], "welcome");
        assert_eq!(welcome["host"]["name"], "Test Mac");
        assert!(welcome["deck"]["pages"].as_array().unwrap().len() >= 2);
        welcome["token"].as_str().unwrap().to_string()
    });
    assert_ne!(f.host.pairing_info().pin, pin, "PIN is single-use");
    assert_eq!(f.host.trusted_devices().len(), 1);

    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("phone-1", json!({"method": "token", "token": token}))).await;
        let welcome = recv(&mut ws).await;
        assert_eq!(welcome["t"], "welcome");
        assert!(welcome.get("token").is_none(), "no new token on reconnect");

        send(&mut ws, json!({"t": "ping", "id": 7})).await;
        assert_eq!(recv_kind(&mut ws, "pong").await["id"], 7);

        send(&mut ws, json!({"t": "apps"})).await;
        assert_eq!(recv_kind(&mut ws, "apps").await["apps"][0]["name"], "Safari");

        send(&mut ws, json!({"t": "clipboardGet"})).await;
        assert_eq!(recv_kind(&mut ws, "clipboard").await["text"], "from mac");

        send(&mut ws, json!({"t": "action", "id": 3, "action": {"kind": "shell", "command": "true"}})).await;
        let result = recv_kind(&mut ws, "actionResult").await;
        assert_eq!(result["ok"], false, "shell is off by default");

        send(&mut ws, json!({"t": "action", "id": 4, "action": {"kind": "app", "id": "com.apple.Safari"}})).await;
        assert_eq!(recv_kind(&mut ws, "actionResult").await["ok"], true);
    });
    assert_eq!(f.delegate.opened.lock().unwrap().as_slice(), ["com.apple.Safari"]);

    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("phone-2", json!({"method": "token", "token": "forged"}))).await;
        assert_eq!(recv(&mut ws).await["reason"], "unknown");
    });
}

#[test]
fn combos_from_the_wire_reach_the_engine_and_release_on_disconnect() {
    let f = fixture();
    let code = f.host.pairing_info().link.split("#pair=").nth(1).unwrap().to_string();
    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("ipad", json!({"method": "pair", "code": code}))).await;
        assert_eq!(recv(&mut ws).await["t"], "welcome");
        // Hold ⌘ like a finger resting on the key, then tap Q.
        send(&mut ws, json!({"t": "key", "code": KEY_COMMAND, "down": true})).await;
        send(&mut ws, json!({"t": "tap", "code": KEY_Q})).await;
        // A click while ⌘ is held must carry the flag and must not release it.
        send(&mut ws, json!({"t": "button", "button": "left", "op": "click"})).await;
        send(&mut ws, json!({"t": "ping", "id": 1})).await;
        recv_kind(&mut ws, "pong").await;
        drop(ws);
    });
    std::thread::sleep(Duration::from_millis(300));
    let events = f.recorder.take();
    let q_down =
        events.iter().find(|e| matches!(e, Synth::Key { code, down: true, .. } if *code == KEY_Q)).expect("Q pressed");
    let Synth::Key { flags: q_flags, .. } = q_down else { unreachable!() };
    assert!(q_flags & flags::COMMAND != 0, "{events:?}");
    let click = events.iter().find(|e| matches!(e, Synth::Button { down: true, .. })).expect("clicked");
    let Synth::Button { flags: click_flags, .. } = click else { unreachable!() };
    assert!(click_flags & flags::COMMAND != 0, "⌘-click");
    let released = events.iter().rposition(
        |e| matches!(e, Synth::Flags { code, flags } if *code == KEY_COMMAND && flags & flags::COMMAND == 0),
    );
    let clicked = events.iter().position(|e| matches!(e, Synth::Button { down: false, .. })).unwrap();
    assert!(released.is_some_and(|r| r > clicked), "⌘ released only after the click, on disconnect: {events:?}");
}

#[test]
fn approval_flow() {
    let f = fixture();
    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("guest", json!({"method": "approve"}))).await;
        assert_eq!(recv(&mut ws).await["t"], "pending");
        let request = loop {
            let found = f.delegate.events.lock().unwrap().iter().find_map(|e| match e {
                HostEvent::ApprovalRequested { request } => Some(request.clone()),
                _ => None,
            });
            if let Some(request) = found {
                break request;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        assert_eq!(request.device_name, "Test Phone");
        f.host.respond_approval(request.id, true);
        assert_eq!(recv(&mut ws).await["t"], "welcome");
        assert_eq!(f.host.connected_devices().len(), 1);

        f.host.forget_device("guest".into());
        let bye = recv_kind(&mut ws, "bye").await;
        assert!(bye.get("reconnect").is_none(), "a removed device must not reconnect on its own");
    });
    assert!(f.host.trusted_devices().is_empty());
}

#[test]
fn serves_the_web_client_and_guards_icons() {
    let f = fixture();
    f.rt.block_on(async {
        let port = f.port;
        let get_from = |host: String, path: &'static str| async move {
            let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            tcp.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut out = Vec::new();
            tcp.read_to_end(&mut out).await.unwrap();
            String::from_utf8_lossy(&out).into_owned()
        };
        let get = |path: &'static str| get_from(format!("127.0.0.1:{port}"), path);
        assert!(get_from(format!("test.local:{port}"), "/").await.starts_with("HTTP/1.1 200"));
        let rebound = get_from(format!("attacker.example:{port}"), "/api/info").await;
        assert!(rebound.starts_with("HTTP/1.1 421"), "names that could be DNS-rebound are refused: {rebound}");
        let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        tcp.write_all(b"GET /api/info HTTP/1.1\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut out = Vec::new();
        tcp.read_to_end(&mut out).await.unwrap();
        assert!(out.starts_with(b"HTTP/1.1 421"), "requests without a Host header are refused");
        let index = get("/").await;
        assert!(index.starts_with("HTTP/1.1 200"), "{index}");
        assert!(index.contains("Cache-Control: no-cache") && index.contains("<title>CmdPalm"));
        let route = get("/settings").await;
        assert!(route.contains("<title>CmdPalm"), "client routes get the app shell");
        let asset = get("/assets/app-1234.js").await;
        assert!(asset.contains("immutable"));
        assert!(get("/assets/missing.js").await.starts_with("HTTP/1.1 404"));
        assert!(get("/../../etc/passwd").await.starts_with("HTTP/1.1 404"));
        assert!(get("/api/icon?id=com.apple.Safari&k=bogus").await.starts_with("HTTP/1.1 403"));
        let info = get("/api/info").await;
        assert!(info.contains("\"name\":\"Test Mac\""));
        assert!(get("/cmdpalm.crt").await.starts_with("HTTP/1.1 200"));
    });
}

#[test]
fn pause_refuses_everything_that_acts_on_the_mac() {
    let f = fixture();
    let code = f.host.pairing_info().link.split("#pair=").nth(1).unwrap().to_string();
    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("phone", json!({"method": "pair", "code": code}))).await;
        assert_eq!(recv(&mut ws).await["t"], "welcome");
        f.host.set_paused(true);
        assert_eq!(recv_kind(&mut ws, "paused").await["paused"], true);

        send(&mut ws, json!({"t": "action", "id": 1, "action": {"kind": "app", "id": "com.apple.Safari"}})).await;
        let result = recv_kind(&mut ws, "actionResult").await;
        assert_eq!(result["ok"], false);
        send(&mut ws, json!({"t": "clipboardGet"})).await;
        assert_eq!(recv_kind(&mut ws, "notice").await["code"], "paused");
        send(&mut ws, json!({"t": "text", "text": "hello", "mode": "unicode"})).await;
        assert_eq!(recv_kind(&mut ws, "notice").await["code"], "paused");
        send(&mut ws, json!({"t": "ping", "id": 2})).await;
        recv_kind(&mut ws, "pong").await;

        f.host.set_paused(false);
        recv_kind(&mut ws, "paused").await;
        send(&mut ws, json!({"t": "action", "id": 3, "action": {"kind": "app", "id": "com.apple.Safari"}})).await;
        assert_eq!(recv_kind(&mut ws, "actionResult").await["ok"], true);
    });
    assert_eq!(
        f.delegate.opened.lock().unwrap().as_slice(),
        ["com.apple.Safari"],
        "only the action after resuming ran"
    );
    assert!(!f.recorder.take().iter().any(|e| matches!(e, Synth::Text { .. })), "paused text is never typed");
}

#[test]
fn disconnect_and_restart_tell_the_phone_whether_to_come_back() {
    let f = fixture();
    let code = f.host.pairing_info().link.split("#pair=").nth(1).unwrap().to_string();
    let token = f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, json!({"t": "hello", "v": 1, "device": {"id": "tab", "name": "Tab", "model": "iPad"}, "auth": {"method": "pair", "code": code}, "remember": true})).await;
        let welcome = recv(&mut ws).await;
        let session = f.host.connected_devices()[0].session;
        f.host.disconnect(session);
        let bye = recv_kind(&mut ws, "bye").await;
        assert!(bye.get("reconnect").is_none(), "{bye}");
        welcome["token"].as_str().unwrap().to_string()
    });
    let mut ws = f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("tab", json!({"method": "token", "token": token}))).await;
        assert_eq!(recv(&mut ws).await["t"], "welcome");
        ws
    });
    f.host.stop();
    f.rt.block_on(async {
        assert_eq!(recv_kind(&mut ws, "bye").await["reconnect"], true);
    });
}

#[test]
fn only_local_host_names_are_served() {
    use crate::server::local_host;
    for ok in [
        "192.168.1.5:8790",
        "127.0.0.1",
        "[::1]:8790",
        "[fd7a:115c:a1e0::1]:8790",
        "localhost:8790",
        "Studio.local:8790",
        "studio.local.",
        "studio:8790",
        "studio.home.arpa",
        "studio.internal:8790",
    ] {
        assert!(local_host(ok), "{ok}");
    }
    for bad in [
        "evil.example:8790",
        "local",
        ".local",
        "studio.local.evil.example",
        "[evil]:80",
        "[::1]evil.example",
        "[::1]:port",
        "localhost.evil.example",
        "studio.ts.net",
        "studio.local.evil.example:8790",
        "home.arpa",
        "internal",
        "studio..local",
        "stu_dio",
        "",
    ] {
        assert!(!local_host(bad), "{bad}");
    }
}

#[test]
fn trusts_forwarded_headers_only_from_an_allowed_proxy_on_this_mac() {
    use crate::server::{client, parse_head};
    let head = b"GET /ws HTTP/1.1\r\nHost: mac.example.com\r\nX-Forwarded-For: 10.0.0.9, 10.8.0.3\r\nX-Forwarded-Proto: https\r\nX-Forwarded-Host: mac.example.com\r\n";
    let request = parse_head(head).unwrap();
    let loopback: std::net::IpAddr = "127.0.0.1".parse().unwrap();
    let phone: std::net::IpAddr = "10.8.0.3".parse().unwrap();
    let proxied = client(&request, loopback, false, true);
    assert_eq!(proxied.address, phone, "the proxy's own entry is the last one");
    assert!(proxied.secure);
    assert_eq!(proxied.host, Some("mac.example.com"));

    let off = client(&request, loopback, false, false);
    assert_eq!(off.address, loopback, "forwarded headers are ignored unless allowed");
    assert!(!off.secure);

    let lan: std::net::IpAddr = "192.168.1.20".parse().unwrap();
    let direct = client(&request, lan, false, true);
    assert_eq!(direct.address, lan, "a device on the network can't claim another address");
    assert!(!direct.secure);

    let ported = parse_head(b"GET / HTTP/1.1\r\nHost: mac.local\r\nX-Forwarded-For: [fd00::9]:51234\r\n").unwrap();
    assert_eq!(client(&ported, loopback, false, true).address, "fd00::9".parse::<std::net::IpAddr>().unwrap());

    let plain = parse_head(b"GET / HTTP/1.1\r\nHost: 127.0.0.1:8790\r\n").unwrap();
    assert_eq!(client(&plain, "::1".parse().unwrap(), true, true).address, "::1".parse::<std::net::IpAddr>().unwrap());
}

#[test]
fn works_behind_a_reverse_proxy_when_allowed() {
    let f = fixture();
    let mut config = f.config.clone();
    config.link_host = LinkHost::Custom { address: "https://mac.example.com".into() };
    f.host.update_config(config.clone());
    let code = f.host.pairing_info().link.split("#pair=").nth(1).unwrap().to_string();
    let port = f.port;
    let get = |extra: &'static str| async move {
        let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let head = format!("GET /api/info HTTP/1.1\r\n{extra}Connection: close\r\n\r\n");
        tcp.write_all(head.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        tcp.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    };
    let proxied = "Host: mac.example.com\r\nX-Forwarded-For: 10.8.0.3\r\nX-Forwarded-Proto: https\r\n";
    f.rt.block_on(async {
        let info = get(proxied).await;
        assert!(info.contains("\"secure\":false"), "not believed until allowed: {info}");
    });
    config.allow_local_proxy = true;
    f.host.update_config(config);
    f.rt.block_on(async {
        let info = get(proxied).await;
        assert!(info.starts_with("HTTP/1.1 200") && info.contains("\"secure\":true"), "{info}");
        let rewritten =
            get("Host: 127.0.0.1:8790\r\nX-Forwarded-For: 10.8.0.3\r\nX-Forwarded-Host: evil.example\r\n").await;
        assert!(rewritten.starts_with("HTTP/1.1 421"), "forwarded names are checked too: {rewritten}");

        let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(format!("ws://127.0.0.1:{port}/ws"))
            .header("Host", "mac.example.com")
            .header("Origin", "https://mac.example.com")
            .header("X-Forwarded-For", "fd00:8::42")
            .header("X-Forwarded-Proto", "https")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key())
            .body(())
            .unwrap();
        let (mut ws, _) = tokio_tungstenite::client_async(request, tcp).await.unwrap();
        send(&mut ws, hello("phone", json!({"method": "pair", "code": code}))).await;
        let welcome = recv(&mut ws).await;
        assert_eq!(welcome["t"], "welcome");
        assert_eq!(welcome["features"]["secure"], true, "HTTPS ended at the proxy still counts");
    });
    let device = &f.host.connected_devices()[0];
    assert_eq!(device.address, "fd00:8::42");
    assert!(device.secure);
}

#[test]
fn a_proxy_on_ipv6_loopback_gets_the_proxy_limit() {
    use crate::server::ConnectionSlot;
    let f = fixture();
    let mut config = f.config.clone();
    config.allow_local_proxy = true;
    let engine = InputEngine::spawn(SharedRecorder::default, Box::new(|_| {}));
    let shared = Arc::new(Shared::new(config, f.delegate.clone(), &engine, Box::new(|| true)));
    let loopback: std::net::IpAddr = "::1".parse().unwrap();
    let slots: Vec<_> = std::iter::from_fn(|| ConnectionSlot::take(&shared, loopback)).take(100).collect();
    assert_eq!(slots.len(), 64, "::1 is masked to its /64 only after the loopback check");
    drop(slots);
    let lan: std::net::IpAddr = "fd00::5".parse().unwrap();
    let slots: Vec<_> = std::iter::from_fn(|| ConnectionSlot::take(&shared, lan)).take(100).collect();
    assert_eq!(slots.len(), 16);
}

#[test]
fn requests_with_a_body_are_refused() {
    let f = fixture();
    f.rt.block_on(async {
        let mut tcp = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
        let smuggled = "GET /api/info HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 44\r\n\r\nGET /api/info HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        tcp.write_all(smuggled.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        tcp.read_to_end(&mut out).await.unwrap();
        let out = String::from_utf8_lossy(&out);
        assert!(out.starts_with("HTTP/1.1 400"), "{out}");
        assert_eq!(out.matches("HTTP/1.1").count(), 1, "the body is never read as a request: {out}");
    });
}

#[test]
fn abandoned_approval_requests_back_off() {
    let f = fixture();
    let ended =
        || f.delegate.events.lock().unwrap().iter().filter(|e| matches!(e, HostEvent::ApprovalEnded { .. })).count();
    f.rt.block_on(async {
        for attempt in 1..=3 {
            let mut ws = connect(f.port).await;
            send(&mut ws, hello("pest", json!({"method": "approve"}))).await;
            assert_eq!(recv(&mut ws).await["t"], "pending");
            drop(ws);
            while ended() < attempt {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("pest", json!({"method": "approve"}))).await;
        let denied = recv(&mut ws).await;
        assert_eq!(denied["reason"], "blocked", "{denied}");
        assert!(denied["retryAfter"].as_u64().is_some());
    });
}

#[test]
fn custom_pairing_addresses() {
    use crate::host::custom_link;
    let pair = |a: &str, b: &str| Some((a.to_string(), b.to_string()));
    assert_eq!(
        custom_link("https://Mac.example.com/", 8790),
        pair("https://Mac.example.com", "https://Mac.example.com"),
        "a URL keeps its own port, so a proxy on 443 works"
    );
    assert_eq!(custom_link(" studio.lan ", 8790), pair("http://studio.lan:8790", "https://studio.lan:8790"));
    assert_eq!(custom_link("studio.lan:9000", 8790), pair("http://studio.lan:9000", "https://studio.lan:9000"));
    assert_eq!(custom_link("http://10.0.0.2:8790", 1), pair("http://10.0.0.2:8790", "https://10.0.0.2:8790"));
    assert_eq!(
        custom_link("fd7a:115c:a1e0::1", 8790),
        pair("http://[fd7a:115c:a1e0::1]:8790", "https://[fd7a:115c:a1e0::1]:8790")
    );
    assert_eq!(custom_link("[::1]", 8790), pair("http://[::1]:8790", "https://[::1]:8790"));
    for bad in ["", "   ", "ftp://studio", "studio/path", "user@studio", "https://", "studio?x"] {
        assert_eq!(custom_link(bad, 8790), None, "{bad:?}");
    }

    let f = fixture();
    let mut config = f.config.clone();
    config.link_host = LinkHost::Custom { address: "https://cmdpalm.example.com".into() };
    f.host.update_config(config);
    let info = f.host.pairing_info();
    assert!(info.link.starts_with("https://cmdpalm.example.com/#pair="), "{}", info.link);
    assert_eq!(info.address, "https://cmdpalm.example.com");
    f.rt.block_on(async {
        let mut tcp = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
        tcp.write_all(b"GET /api/info HTTP/1.1\r\nHost: CMDPALM.example.com\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut out = Vec::new();
        tcp.read_to_end(&mut out).await.unwrap();
        assert!(out.starts_with(b"HTTP/1.1 200"), "the custom name is served: {}", String::from_utf8_lossy(&out));
    });

    let mut config = f.config.clone();
    config.link_host = LinkHost::Custom { address: "not a url/".into() };
    f.host.update_config(config);
    assert!(f.host.pairing_info().address.starts_with("http://Test.local:"), "an unusable address falls back");
}

#[test]
fn device_ids_must_be_plain_text() {
    let f = fixture();
    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello(" spaced ", json!({"method": "approve"}))).await;
        assert_eq!(recv(&mut ws).await["reason"], "incompatible");
    });
}

#[test]
fn phone_settings_are_kept_per_device_and_can_be_copied() {
    let f = fixture();
    let pair = |id: &'static str| {
        let code = f.host.pairing_info().link.split("#pair=").nth(1).unwrap().to_string();
        json!({"t": "hello", "v": 1, "device": {"id": id, "name": id, "model": "iPhone"}, "auth": {"method": "pair", "code": code}, "remember": true})
    };
    let token = f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, pair("phone")).await;
        let welcome = recv(&mut ws).await;
        assert!(welcome.get("settings").is_none());
        send(&mut ws, json!({"t": "settingsSave", "settings": {"theme": "light"}, "updatedAt": 20})).await;
        send(&mut ws, json!({"t": "settingsSave", "settings": [1], "updatedAt": 30})).await;
        assert_eq!(recv_kind(&mut ws, "notice").await["code"], "settings");
        welcome["token"].as_str().unwrap().to_string()
    });
    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("phone", json!({"method": "token", "token": token}))).await;
        let welcome = recv(&mut ws).await;
        assert_eq!(welcome["settings"], json!({"settings": {"theme": "light"}, "updatedAt": 20}));

        let mut tablet = connect(f.port).await;
        send(&mut tablet, pair("tablet")).await;
        assert_eq!(recv(&mut tablet).await["t"], "welcome");
        send(&mut tablet, json!({"t": "settingsList"})).await;
        let list = recv_kind(&mut tablet, "settingsList").await;
        assert_eq!(list["devices"], json!([{"id": "phone", "name": "Test Phone", "model": "iPhone", "updatedAt": 20}]));
        send(&mut tablet, json!({"t": "settingsCopy", "from": "phone"})).await;
        assert_eq!(recv_kind(&mut tablet, "settings").await["settings"]["theme"], "light");
    });
    f.host.forget_device("phone".into());
    f.rt.block_on(async {
        let mut tablet = connect(f.port).await;
        assert_eq!(f.host.trusted_devices().len(), 1);
        send(&mut tablet, pair("tablet")).await;
        recv_kind(&mut tablet, "welcome").await;
        send(&mut tablet, json!({"t": "settingsCopy", "from": "phone"})).await;
        assert_eq!(
            recv_kind(&mut tablet, "notice").await["code"],
            "settings",
            "forgetting a device drops its settings"
        );
    });
}

#[test]
fn voice_stops_after_it_starts_even_when_sent_right_away() {
    let f = fixture();
    let code = f.host.pairing_info().link.split("#pair=").nth(1).unwrap().to_string();
    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("phone", json!({"method": "pair", "code": code}))).await;
        assert_eq!(recv(&mut ws).await["t"], "welcome");
        send(&mut ws, json!({"t": "voiceStart"})).await;
        send(&mut ws, json!({"t": "voiceStop", "cancel": false})).await;
        send(&mut ws, json!({"t": "voiceStart"})).await;
        drop(ws);
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while f.delegate.voice.lock().unwrap().len() < 4 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        f.delegate.voice.lock().unwrap().as_slice(),
        ["start", "stop", "start", "stop"],
        "a disconnect stops the voice it left running"
    );
}

#[test]
fn a_slow_app_list_never_replaces_a_newer_one() {
    let f = fixture();
    let code = f.host.pairing_info().link.split("#pair=").nth(1).unwrap().to_string();
    f.delegate.slow_stale_apps.store(true, std::sync::atomic::Ordering::SeqCst);
    f.rt.block_on(async {
        let mut ws = connect(f.port).await;
        send(&mut ws, hello("phone", json!({"method": "pair", "code": code}))).await;
        assert_eq!(recv(&mut ws).await["t"], "welcome");
        send(&mut ws, json!({"t": "apps"})).await;
        // Let the first list start before the app quits and the phone asks again.
        tokio::time::sleep(Duration::from_millis(50)).await;
        send(&mut ws, json!({"t": "apps"})).await;
        assert_eq!(recv_kind(&mut ws, "apps").await["apps"][0]["name"], "Safari");
        tokio::time::sleep(Duration::from_millis(500)).await;
        send(&mut ws, json!({"t": "ping", "id": 1})).await;
        loop {
            let message = recv(&mut ws).await;
            assert_ne!(message["t"], "apps", "the older list arrived after the newer one: {message}");
            if message["t"] == "pong" {
                break;
            }
        }
    });
}
