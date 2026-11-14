//! Manual synthetic transport/browser smoke helper. It serves H.264 fixture
//! frames through the normal WebRTC path without capturing a screen or posting input.
//!
//! Set `CMDPALM_DISPLAY_FIXTURE` to an Annex-B H.264 file containing AUD NALs
//! and an IDR in every frame, build `web/dist`, then run this example. Its
//! single JSON output line contains the selected port and pairing URL.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cmdpalm_core::api::{DisplayCommand, HostConfig, HostDelegate, HostEvent, LinkHost, NativeCommand};
use cmdpalm_core::host::CoreHost;
use cmdpalm_core::protocol::{AppEntry, AppOp, DisplayInfo};

const MAX_FIXTURE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 1024 * 1024;

struct Fixture {
    frames: Vec<Vec<u8>>,
    fps: u32,
}

struct OriginalFixture {
    png: Vec<u8>,
    width: u32,
    height: u32,
}

struct Feeder {
    session: u64,
    generation: u64,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
struct FeedState {
    latest_generation: Option<u64>,
    active: Option<Feeder>,
}

struct Delegate {
    host: Mutex<Weak<CoreHost>>,
    fixture: Arc<Fixture>,
    original_fixture: Option<Arc<OriginalFixture>>,
    feed: Mutex<FeedState>,
}

impl Delegate {
    fn host(&self) -> Option<Arc<CoreHost>> {
        self.host.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).upgrade()
    }

    fn stop_feeder(feeder: Feeder) {
        feeder.stop.store(true, Ordering::Release);
        feeder.thread.thread().unpark();
        let _ = feeder.thread.join();
    }

    fn start_feeder(&self, session: u64, generation: u64, original: bool) {
        let mut state = self.feed.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.latest_generation.is_some_and(|latest| generation <= latest) {
            return;
        }
        if let Some(previous) = state.active.take() {
            Self::stop_feeder(previous);
        }

        state.latest_generation = Some(generation);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let fixture = self.fixture.clone();
        let original_fixture = self.original_fixture.clone();
        let host = self.host.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let thread = thread::Builder::new()
            .name("cmdpalm-display-fixture".into())
            .spawn(move || {
                let mut frame_index = 0_u64;
                if original {
                    let Some(fixture) = original_fixture else { return };
                    let interval = Duration::from_secs(1);
                    let mut deadline = Instant::now();
                    while !stop_thread.load(Ordering::Acquire) {
                        let Some(host) = host.upgrade() else { return };
                        let timestamp_us = frame_index.saturating_mul(1_000_000);
                        let _ = host.display_frame(session, generation, fixture.png.clone(), timestamp_us, true);
                        frame_index = frame_index.saturating_add(1);
                        deadline += interval;
                        let delay = deadline.saturating_duration_since(Instant::now());
                        if !delay.is_zero() {
                            thread::park_timeout(delay);
                        }
                    }
                    return;
                }
                let interval = Duration::from_secs_f64(1.0 / f64::from(fixture.fps));
                let mut deadline = Instant::now();
                while !stop_thread.load(Ordering::Acquire) {
                    for frame in &fixture.frames {
                        if stop_thread.load(Ordering::Acquire) {
                            break;
                        }
                        let Some(host) = host.upgrade() else { return };
                        let timestamp_us = frame_index.saturating_mul(1_000_000) / u64::from(fixture.fps);
                        let _ = host.display_frame(session, generation, frame.clone(), timestamp_us, true);
                        frame_index = frame_index.saturating_add(1);
                        deadline += interval;
                        let delay = deadline.saturating_duration_since(Instant::now());
                        if !delay.is_zero() {
                            thread::park_timeout(delay);
                        }
                    }
                }
            })
            .expect("could not start synthetic display feeder");
        state.active = Some(Feeder { session, generation, stop, thread });
    }

    fn stop_feeder_for(&self, session: u64, generation: u64) {
        let mut state = self.feed.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(active) = state.active.as_ref()
            && active.session == session
            && active.generation == generation
            && let Some(feeder) = state.active.take()
        {
            Self::stop_feeder(feeder);
        }
    }
}

impl HostDelegate for Delegate {
    fn on_event(&self, event: HostEvent) {
        if let HostEvent::Paired { .. } = event {
            // This example intentionally grants only paired, remembered
            // devices so the browser smoke can reach its synthetic source.
            if let Some(host) = self.host() {
                for device in host.connected_devices().into_iter().filter(|device| device.remembered) {
                    host.set_display_allowed(device.device_id, true);
                }
            }
        }
    }

    fn list_apps(&self) -> Vec<AppEntry> {
        Vec::new()
    }

    fn app_icon(&self, _id: String, _size: u32) -> Option<Vec<u8>> {
        None
    }

    fn app_action(&self, _id: String, _op: AppOp) -> bool {
        false
    }

    fn open_url(&self, _url: String) -> bool {
        false
    }

    fn native(&self, _command: NativeCommand) -> bool {
        false
    }

    fn run_shortcut(&self, _name: String) -> bool {
        false
    }

    fn set_volume(&self, _value: Option<f32>, _muted: Option<bool>) {}

    fn clipboard_text(&self) -> Option<String> {
        None
    }

    fn set_clipboard_text(&self, _text: String) {}

    fn begin_paste(&self, _text: String) -> bool {
        false
    }

    fn end_paste(&self) {}

    fn voice_start(&self, _session: u64, _locale: Option<String>, _request_id: Option<u32>) -> bool {
        false
    }

    fn voice_audio(&self, _session: u64, _pcm: Vec<u8>) {}

    fn voice_stop(&self, _session: u64, _cancel: bool) {}

    fn display_command(&self, session: u64, command: DisplayCommand) {
        match command {
            DisplayCommand::List { request_id } => {
                if let Some(host) = self.host() {
                    host.display_sources(
                        session,
                        request_id,
                        vec![DisplayInfo {
                            id: "synthetic-display".into(),
                            name: "Test display".into(),
                            width: self.original_fixture.as_ref().map_or(640, |f| f.width),
                            height: self.original_fixture.as_ref().map_or(360, |f| f.height),
                            main: true,
                        }],
                        None,
                    );
                }
            }
            DisplayCommand::Start { generation, display_id, original, .. } => {
                if display_id == "synthetic-display" {
                    if original && self.original_fixture.is_none() {
                        // Advance the feeder generation and retire any previous
                        // stream even though this request cannot produce PNGs.
                        self.start_feeder(session, generation, original);
                        if let Some(host) = self.host() {
                            host.display_failed(
                                session,
                                generation,
                                "set CMDPALM_DISPLAY_IMAGE to a PNG fixture for original-resolution display testing"
                                    .into(),
                            );
                        }
                    } else {
                        self.start_feeder(session, generation, original);
                    }
                }
            }
            DisplayCommand::Stop { generation } => self.stop_feeder_for(session, generation),
            // Every fixture frame is an IDR, so periodic IDRs satisfy a key
            // frame request. Display settings and focus have no synthetic effect.
            DisplayCommand::Configure { .. } | DisplayCommand::KeyFrame { .. } | DisplayCommand::Focus { .. } => {}
        }
    }
}

fn start_code(bytes: &[u8], offset: usize) -> Option<usize> {
    if bytes.get(offset..offset + 4) == Some(&[0, 0, 0, 1]) {
        Some(4)
    } else if bytes.get(offset..offset + 3) == Some(&[0, 0, 1]) {
        Some(3)
    } else {
        None
    }
}

fn split_frames(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let first = (0..bytes.len())
        .find_map(|offset| start_code(bytes, offset).map(|length| (offset, length)))
        .ok_or_else(|| "fixture contains no Annex-B start code".to_owned())?;
    if bytes[..first.0].iter().any(|byte| *byte != 0) {
        return Err("fixture has nonzero data before its first Annex-B start code".into());
    }

    let mut starts = vec![(first.0, first.1)];
    let mut offset = first.0 + first.1;
    while offset < bytes.len() {
        if let Some(length) = start_code(bytes, offset) {
            starts.push((offset, length));
            offset += length;
        } else {
            offset += 1;
        }
    }

    let mut nals = Vec::with_capacity(starts.len());
    for (index, (start, code_len)) in starts.iter().copied().enumerate() {
        let mut end = starts.get(index + 1).map_or(bytes.len(), |(next, _)| *next);
        let payload = start + code_len;
        while end > payload && bytes[end - 1] == 0 {
            end -= 1;
        }
        if payload >= end {
            return Err("fixture contains an empty NAL unit".into());
        }
        nals.push(bytes[payload..end].to_vec());
    }

    let mut frames = Vec::new();
    let mut frame = Vec::new();
    let mut has_aud = false;
    let mut has_idr = false;
    for nal in nals {
        let kind = nal[0] & 0x1f;
        if kind == 9 {
            if has_aud {
                if !has_idr {
                    return Err("every fixture frame must contain an IDR NAL".into());
                }
                frames.push(std::mem::take(&mut frame));
                has_idr = false;
            }
            has_aud = true;
        }
        frame.extend_from_slice(&[0, 0, 0, 1]);
        frame.extend_from_slice(&nal);
        has_idr |= kind == 5;
    }
    if !has_aud {
        return Err("fixture contains no AUD NALs; frames cannot be split".into());
    }
    if !has_idr {
        return Err("every fixture frame must contain an IDR NAL".into());
    }
    frames.push(frame);

    if frames.iter().any(|frame| frame.len() > MAX_FRAME_BYTES) {
        return Err("a fixture frame exceeds the 1 MiB host frame limit".into());
    }
    Ok(frames)
}

fn load_fixture(path: &Path, fps: u32) -> Result<Fixture, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("could not read fixture metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("fixture path is not a regular file".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_FIXTURE_BYTES {
        return Err("fixture must be between 1 byte and 16 MiB".into());
    }
    let file = fs::File::open(path).map_err(|error| format!("could not open fixture: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FIXTURE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read fixture: {error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_FIXTURE_BYTES {
        return Err("fixture changed while being read or exceeded the 16 MiB limit".into());
    }
    let frames = split_frames(&bytes)?;
    Ok(Fixture { frames, fps })
}

fn load_original_fixture(path: &Path) -> Result<OriginalFixture, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("could not read PNG fixture metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("PNG fixture path is not a regular file".into());
    }
    if metadata.len() < 33 || metadata.len() > MAX_FIXTURE_BYTES {
        return Err("PNG fixture must be at least 33 bytes and no larger than 16 MiB".into());
    }
    let file = fs::File::open(path).map_err(|error| format!("could not open PNG fixture: {error}"))?;
    let mut png = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FIXTURE_BYTES + 1)
        .read_to_end(&mut png)
        .map_err(|error| format!("could not read PNG fixture: {error}"))?;
    if png.len() < 33 || png.len() as u64 > MAX_FIXTURE_BYTES {
        return Err("PNG fixture changed while being read or exceeded the 16 MiB limit".into());
    }
    if &png[..8] != b"\x89PNG\r\n\x1a\n" || png[8..12] != [0, 0, 0, 13] || &png[12..16] != b"IHDR" {
        return Err("PNG fixture must have the PNG signature and a 13-byte IHDR first chunk".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().expect("four-byte width"));
    let height = u32::from_be_bytes(png[20..24].try_into().expect("four-byte height"));
    if width == 0 || height == 0 || width > 3840 || height > 3840 || u64::from(width) * u64::from(height) > 3840 * 2160
    {
        return Err(format!("PNG dimensions {width}x{height} exceed the 3840x2160 pixel budget"));
    }
    Ok(OriginalFixture { png, width, height })
}

fn run() -> Result<(), String> {
    let fixture_path = std::env::var_os("CMDPALM_DISPLAY_FIXTURE")
        .map(PathBuf::from)
        .ok_or_else(|| "set CMDPALM_DISPLAY_FIXTURE to an Annex-B H.264 fixture path".to_owned())?;
    let fps = std::env::var("CMDPALM_DISPLAY_FPS")
        .unwrap_or_else(|_| "30".into())
        .parse::<u32>()
        .ok()
        .filter(|fps| (1..=60).contains(fps))
        .ok_or("CMDPALM_DISPLAY_FPS must be between 1 and 60")?;
    let fixture = Arc::new(load_fixture(&fixture_path, fps)?);
    let original_fixture = match std::env::var_os("CMDPALM_DISPLAY_IMAGE") {
        Some(path) => Some(Arc::new(load_original_fixture(&PathBuf::from(path))?)),
        None => None,
    };

    let port = match std::env::var("CMDPALM_PORT") {
        Ok(value) => {
            value.parse::<u16>().map_err(|_| "CMDPALM_PORT must be a valid port from 0 to 65535".to_owned())?
        }
        Err(std::env::VarError::NotPresent) => 0,
        Err(error) => return Err(format!("could not read CMDPALM_PORT: {error}")),
    };
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let web_root = repo.join("web").join("dist");
    if !web_root.join("index.html").is_file() {
        return Err(format!("built web client not found at {}; build web/dist first", web_root.display()));
    }
    let temporary =
        tempfile::tempdir().map_err(|error| format!("could not create temporary host data directory: {error}"))?;
    let data_dir = temporary.path().join("data");
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("could not create temporary host data directory: {error}"))?;

    let config = HostConfig {
        port,
        data_dir: data_dir.to_string_lossy().into_owned(),
        web_root: web_root.to_string_lossy().into_owned(),
        host_name: "localhost".into(),
        computer_name: "Display Test".into(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        link_host: LinkHost::HostName,
        allow_local_proxy: false,
        allow_pin: true,
        allow_approval: false,
        allow_shell: false,
        voice_available: false,
        display_enabled: true,
    };
    let delegate = Arc::new(Delegate {
        host: Mutex::new(Weak::new()),
        fixture,
        original_fixture,
        feed: Mutex::new(FeedState::default()),
    });
    let host = CoreHost::dry_run(config, delegate.clone());
    *delegate.host.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::downgrade(&host);
    host.set_pin_shown(true);
    let actual_port = host.start().map_err(|error| format!("could not start synthetic host: {error}"))?;
    let pairing = host.pairing_info();
    println!("{}", serde_json::json!({ "port": actual_port, "pairing_url": pairing.link, "fps": fps }));
    loop {
        thread::park();
    }
}

fn main() {
    cmdpalm_core::init_logging(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()));
    if let Err(error) = run() {
        eprintln!("display-smoke: {error}");
        std::process::exit(1);
    }
}
