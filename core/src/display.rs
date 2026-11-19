//! A single, explicitly authorized screen viewer. Encoded frames never enter
//! the control socket's queue. Every start has a host-generated generation so
//! callbacks from an old capture cannot reach a replacement viewer.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use str0m::bwe::{Bitrate, BweKind};
use str0m::change::SdpOffer;
use str0m::format::Codec;
use str0m::media::{Direction, MediaKind, MediaTime};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::{Notify, mpsc, watch};

use crate::api::{DisplayApprovalRequest, DisplayCommand, DisplayProfile, HostEvent};
use crate::host::{Outgoing, Shared};
use crate::protocol::{DisplayInfo, DisplayQuality, ServerMessage};

const LEASE: Duration = Duration::from_secs(4);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_FRAME: usize = 1024 * 1024;
const MAX_IMAGE: usize = 16 * 1024 * 1024;
const ACCESS_TIMEOUT: Duration = Duration::from_secs(60);
const SEND_FAILURE_LIMIT: Duration = Duration::from_secs(5);
const LIST_REPEAT: Duration = Duration::from_millis(300);
const LIST_TIMEOUT: Duration = Duration::from_secs(8);

struct AccessRequest {
    native: DisplayApprovalRequest,
    client: u32,
    epoch: u64,
    created: Instant,
}

#[derive(Default)]
struct AccessRequests {
    pending: HashMap<u64, AccessRequest>,
    last: HashMap<String, Instant>,
    last_prompt: Option<Instant>,
}

struct Frame {
    data: Vec<u8>,
    timestamp_us: u64,
    queued: Instant,
    keyframe: bool,
}

/// HD text keeps only the newest waiting picture. A still screen sends no
/// further updates, so dropping the newest would leave the phone out of date.
#[derive(Default)]
struct Latest {
    frame: Mutex<Option<Frame>>,
    ready: Notify,
}

impl Latest {
    fn replace(&self, frame: Frame) {
        *self.frame.lock().unwrap_or_else(|p| p.into_inner()) = Some(frame);
        self.ready.notify_one();
    }

    fn take(&self) -> Option<Frame> {
        self.frame.lock().unwrap_or_else(|p| p.into_inner()).take()
    }
}

struct Active {
    session: u64,
    request: u32,
    generation: u64,
    original: bool,
    alive: Instant,
    frames: mpsc::Sender<Frame>,
    latest: Arc<Latest>,
    cancel: watch::Sender<bool>,
    stopped: Arc<AtomicBool>,
    needs_keyframe: Arc<AtomicBool>,
}

struct Sources {
    /// The phone's newest request, which receives the answer.
    request: u32,
    /// The request the Mac app is answering.
    native: u32,
    ids: HashSet<String>,
    displays: Vec<DisplayInfo>,
    message: Option<String>,
    requested: Instant,
    pending: bool,
}

pub(crate) struct DisplayHub {
    active: Mutex<Option<Active>>,
    /// The last authorized list, including the request still in flight.
    sources: Mutex<HashMap<u64, Sources>>,
    requests: Mutex<AccessRequests>,
    awake: AtomicBool,
}

impl Default for DisplayHub {
    fn default() -> Self {
        Self {
            active: Mutex::new(None),
            sources: Mutex::new(HashMap::new()),
            requests: Mutex::new(AccessRequests::default()),
            awake: AtomicBool::new(true),
        }
    }
}

pub(crate) fn access_state(id: u32, state: &str, message: &str) -> ServerMessage {
    ServerMessage::DisplayRequest { id, state: state.into(), message: Some(message.into()) }
}

pub(crate) fn state(id: u32, value: &str, message: Option<&str>) -> ServerMessage {
    ServerMessage::DisplayState { id, state: value.into(), sdp: None, message: message.map(Into::into) }
}

pub(crate) fn access(shared: &Shared, session: u64) -> Result<(), &'static str> {
    if !shared.displays.awake.load(Ordering::Acquire) {
        return Err("Unlock or wake the Mac, then try again.");
    }
    if !shared.config().display_enabled {
        return Err("Screen mirroring is off. On the Mac, open CmdPalm Settings → General → Display.");
    }
    let state = shared.state();
    if state.paused {
        return Err("Screen mirroring is paused on the Mac.");
    }
    match state.sessions.get(&session) {
        Some(live)
            if live.info.display_allowed
                && (!live.info.remembered || state.trust.display_allowed(&live.info.device_id)) =>
        {
            Ok(())
        }
        Some(_) => Err("Allow screen mirroring for this device in CmdPalm Settings → Devices on the Mac."),
        None => Err("The device is no longer connected."),
    }
}

impl DisplayHub {
    pub(crate) fn request_access(&self, shared: Arc<Shared>, session: u64, client: u32) {
        let refuse = |message| shared.send_to(session, access_state(client, "error", message));
        if !self.awake.load(Ordering::Acquire) {
            refuse("Unlock or wake the Mac before requesting access.");
            return;
        }
        let state = shared.state();
        if state.paused {
            drop(state);
            refuse("Screen mirroring is paused on the Mac.");
            return;
        }
        let Some(live) = state.sessions.get(&session) else { return };
        let mut requests = self.requests.lock().unwrap_or_else(|p| p.into_inner());
        if !self.awake.load(Ordering::Acquire) {
            drop(requests);
            drop(state);
            refuse("Unlock or wake the Mac before requesting access.");
            return;
        }
        if requests.pending.contains_key(&session) {
            drop(requests);
            drop(state);
            refuse("An access request is already waiting on the Mac.");
            return;
        }
        requests.last.retain(|_, last| last.elapsed() < Duration::from_secs(300));
        let rate_key = format!("{}\0{}", live.info.device_id, live.info.address);
        if requests.pending.len() >= 8
            || requests.last.len() >= 128
            || requests.last.get(&rate_key).is_some_and(|last| last.elapsed() < Duration::from_secs(30))
            || requests.last_prompt.is_some_and(|last| last.elapsed() < Duration::from_secs(3))
        {
            drop(requests);
            drop(state);
            refuse("Wait a moment before requesting screen access again.");
            return;
        }
        let id = shared.next_id();
        let request = DisplayApprovalRequest {
            id,
            session,
            device_name: live.info.name.clone(),
            model: live.info.model.clone(),
            address: live.info.address.clone(),
            remembered: live.info.remembered,
        };
        requests.last.insert(rate_key, Instant::now());
        requests.last_prompt = Some(Instant::now());
        requests.pending.insert(
            session,
            AccessRequest { native: request.clone(), client, epoch: live.display_epoch, created: Instant::now() },
        );
        // Queue Pending before cancellation can take the request. Native events
        // are notifications; their receiver reads the authoritative pending list.
        let _ = live.tx.send(Outgoing::Message(access_state(
            client,
            "pending",
            "Approve screen mirroring on the Mac. This request expires in one minute.",
        )));
        drop(requests);
        drop(state);
        shared.emit(HostEvent::DisplayApprovalRequested { request });
        tokio::spawn(async move {
            tokio::time::sleep(ACCESS_TIMEOUT).await;
            shared.displays.expire_access(&shared, session, id);
        });
    }

    pub(crate) fn pending_access(&self) -> Vec<DisplayApprovalRequest> {
        let requests = self.requests.lock().unwrap_or_else(|p| p.into_inner());
        let mut pending: Vec<_> = requests
            .pending
            .values()
            .filter(|r| r.created.elapsed() < ACCESS_TIMEOUT)
            .map(|r| r.native.clone())
            .collect();
        pending.sort_by_key(|r| r.id);
        pending
    }

    fn expire_access(&self, shared: &Shared, session: u64, id: u64) {
        let request = {
            let mut requests = self.requests.lock().unwrap_or_else(|p| p.into_inner());
            if requests.pending.get(&session).is_some_and(|r| r.native.id == id) {
                requests.pending.remove(&session)
            } else {
                None
            }
        };
        if let Some(request) = request {
            shared.send_to(
                session,
                access_state(
                    request.client,
                    "expired",
                    "The access request expired. Ask again when someone is at the Mac.",
                ),
            );
            shared.emit(HostEvent::DisplayApprovalEnded { id });
        }
    }

    pub(crate) fn cancel_access(
        &self,
        shared: &Shared,
        session: Option<u64>,
        client: Option<u32>,
        status: &str,
        message: &str,
    ) {
        let removed = {
            let mut requests = self.requests.lock().unwrap_or_else(|p| p.into_inner());
            let ids: Vec<_> = requests
                .pending
                .iter()
                .filter(|(id, r)| session.is_none_or(|s| s == **id) && client.is_none_or(|c| c == r.client))
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter().filter_map(|id| requests.pending.remove(&id)).collect::<Vec<_>>()
        };
        for request in removed {
            shared.send_to(request.native.session, access_state(request.client, status, message));
            shared.emit(HostEvent::DisplayApprovalEnded { id: request.native.id });
        }
    }

    pub(crate) fn respond_access(&self, shared: &Shared, id: u64, allow: bool) -> bool {
        let mut state = shared.state();
        let mut requests = self.requests.lock().unwrap_or_else(|p| p.into_inner());
        let Some(session) = requests.pending.iter().find(|(_, r)| r.native.id == id).map(|(session, _)| *session)
        else {
            return false;
        };
        let request = requests.pending.remove(&session).unwrap();
        let valid = self.awake.load(Ordering::Acquire)
            && !state.paused
            && request.created.elapsed() < ACCESS_TIMEOUT
            && state.sessions.get(&session).is_some_and(|live| {
                live.display_epoch == request.epoch
                    && (!live.info.remembered || state.trust.contains(&live.info.device_id))
            });
        let mut affected = vec![];
        if valid && allow {
            if request.native.remembered {
                let device = state.sessions[&session].info.device_id.clone();
                state.trust.set_display_allowed(&device, true);
                for live in
                    state.sessions.values_mut().filter(|live| live.info.remembered && live.info.device_id == device)
                {
                    live.info.display_allowed = true;
                    affected.push(live.info.session);
                }
            } else if let Some(live) = state.sessions.get_mut(&session) {
                live.info.display_allowed = true;
                affected.push(session);
            }
        }
        drop(requests);
        drop(state);
        shared.emit(HostEvent::DisplayApprovalEnded { id });
        for session in affected {
            shared.send_to(session, ServerMessage::DisplayAccess { allowed: true });
        }
        let (status, message) = if !valid {
            ("expired", "This access request is no longer valid. Ask again from the phone.")
        } else if allow {
            ("allowed", "Screen mirroring was approved on the Mac. Refresh the display list when ready.")
        } else {
            ("denied", "Screen mirroring was declined on the Mac.")
        };
        shared.send_to(session, access_state(request.client, status, message));
        if valid && allow {
            shared.save_trust();
            shared.emit(HostEvent::DevicesChanged);
        }
        valid
    }

    pub(crate) fn set_awake(&self, shared: &Shared, awake: bool) {
        self.awake.store(awake, Ordering::Release);
        if !awake {
            self.cancel(shared, None, None, "Screen mirroring stopped. Unlock or wake the Mac to continue.");
            self.cancel_access(shared, None, None, "cancelled", "Unlock or wake the Mac, then ask again.");
        }
    }

    pub(crate) fn list(&self, shared: &Shared, session: u64, request: u32) {
        if let Err(message) = access(shared, session) {
            let can_request = self.awake.load(Ordering::Acquire) && !shared.state().paused;
            shared.send_to(
                session,
                ServerMessage::Displays { id: request, displays: vec![], can_request, message: Some(message.into()) },
            );
            return;
        }
        let mut sources = self.sources.lock().unwrap_or_else(|p| p.into_inner());
        // Repeated requests never start overlapping native queries, and never
        // answer with an empty list that would hide the displays on the phone.
        if let Some(source) = sources.get_mut(&session) {
            if source.pending && source.requested.elapsed() < LIST_TIMEOUT {
                source.request = request;
                return;
            }
            if !source.pending && source.requested.elapsed() < LIST_REPEAT {
                let reply = ServerMessage::Displays {
                    id: request,
                    displays: source.displays.clone(),
                    can_request: false,
                    message: source.message.clone(),
                };
                drop(sources);
                shared.send_to(session, reply);
                return;
            }
        }
        sources.insert(
            session,
            Sources {
                request,
                native: request,
                ids: HashSet::new(),
                displays: vec![],
                message: None,
                requested: Instant::now(),
                pending: true,
            },
        );
        drop(sources);
        shared.delegate.display_command(session, DisplayCommand::List { request_id: request });
    }

    pub(crate) fn sources(
        &self,
        shared: &Shared,
        session: u64,
        request: u32,
        displays: Vec<DisplayInfo>,
        message: Option<String>,
    ) {
        if access(shared, session).is_err() {
            return;
        }
        let mut sources = self.sources.lock().unwrap_or_else(|p| p.into_inner());
        let Some(source) = sources.get_mut(&session) else { return };
        if source.native != request || !source.pending {
            return;
        }
        let displays: Vec<_> = displays
            .into_iter()
            .filter(|d| !d.id.is_empty() && d.id.len() <= 128 && d.width > 0 && d.height > 0)
            .take(32)
            .collect();
        source.ids = displays.iter().map(|d| d.id.clone()).collect();
        source.displays = displays.clone();
        source.message = message.clone();
        source.pending = false;
        let id = source.request;
        drop(sources);
        shared.send_to(session, ServerMessage::Displays { id, displays, can_request: false, message });
    }

    pub(crate) fn alive(&self, session: u64, request: u32) {
        let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(active) = active.as_mut().filter(|a| a.session == session && a.request == request) {
            active.alive = Instant::now();
        }
    }

    pub(crate) fn focus(&self, shared: &Shared, session: u64, request: u32) {
        if access(shared, session).is_err() || !(shared.permission)() {
            return;
        }
        let generation = self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .filter(|a| a.session == session && a.request == request)
            .map(|a| a.generation);
        if let Some(generation) = generation {
            shared.delegate.display_command(session, DisplayCommand::Focus { generation });
        }
    }

    pub(crate) fn cancel(&self, shared: &Shared, session: Option<u64>, request: Option<u32>, message: &str) {
        self.cancel_matching(shared, session, request, None, message);
    }

    fn cancel_matching(
        &self,
        shared: &Shared,
        session: Option<u64>,
        request: Option<u32>,
        generation: Option<u64>,
        message: &str,
    ) {
        let active = {
            let mut guard = self.active.lock().unwrap_or_else(|p| p.into_inner());
            if guard.as_ref().is_some_and(|a| {
                session.is_none_or(|s| s == a.session)
                    && request.is_none_or(|r| r == a.request)
                    && generation.is_none_or(|g| g == a.generation)
            }) {
                guard.take()
            } else {
                None
            }
        };
        if let Some(active) = active {
            active.stopped.store(true, Ordering::SeqCst);
            let _ = active.cancel.send(true);
            shared.delegate.display_command(active.session, DisplayCommand::Stop { generation: active.generation });
            shared.send_to(active.session, state(active.request, "stopped", Some(message)));
        }
    }

    pub(crate) fn forget(&self, shared: &Shared, session: u64) {
        self.cancel_access(shared, Some(session), None, "cancelled", "This device's access request was cancelled.");
        self.cancel(shared, Some(session), None, "Screen mirroring stopped.");
        self.sources.lock().unwrap_or_else(|p| p.into_inner()).remove(&session);
    }

    pub(crate) fn frame(
        &self,
        shared: &Shared,
        session: u64,
        generation: u64,
        data: Vec<u8>,
        timestamp_us: u64,
        keyframe: bool,
    ) -> bool {
        if data.is_empty() || data.len() > MAX_IMAGE || access(shared, session).is_err() {
            return false;
        }
        let guard = self.active.lock().unwrap_or_else(|p| p.into_inner());
        let Some(active) =
            guard.as_ref().filter(|a| a.session == session && a.generation == generation && a.alive.elapsed() <= LEASE)
        else {
            return false;
        };
        if active.original {
            active.latest.replace(Frame { data, timestamp_us, queued: Instant::now(), keyframe });
            return true;
        }
        if data.len() > MAX_FRAME {
            return false;
        }
        if active.needs_keyframe.load(Ordering::Acquire) && !keyframe {
            return false;
        }
        match active.frames.try_send(Frame { data, timestamp_us, queued: Instant::now(), keyframe }) {
            Ok(()) => {
                if keyframe {
                    active.needs_keyframe.store(false, Ordering::Release);
                }
                true
            }
            Err(_) => {
                active.needs_keyframe.store(true, Ordering::Release);
                false
            }
        }
    }

    pub(crate) fn failed(&self, shared: &Shared, session: u64, generation: u64, message: &str) {
        // Match and remove under one lock: a replacement viewer can reuse
        // its client's request ID between a generation lookup and a cancel.
        self.cancel_matching(shared, Some(session), None, Some(generation), message);
    }
}

pub(crate) fn start(
    shared: Arc<Shared>,
    session: u64,
    request: u32,
    display_id: String,
    sdp: String,
    quality: DisplayQuality,
) {
    let refuse = |message: &str| shared.send_to(session, state(request, "error", Some(message)));
    if let Err(message) = access(&shared, session) {
        refuse(message);
        return;
    }
    if sdp.len() > 64 * 1024
        || sdp.lines().filter(|line| line.starts_with("m=")).count() != 1
        || !sdp.lines().any(|line| {
            line.starts_with(if quality == DisplayQuality::Original { "m=application " } else { "m=video " })
        })
    {
        refuse("The browser sent an unsupported video offer.");
        return;
    }
    let listed = shared
        .displays
        .sources
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&session)
        .is_some_and(|source| source.ids.contains(&display_id));
    if !listed {
        refuse("Refresh the display list and select an available display.");
        return;
    }
    // Reserve before spawning: simultaneous requests cannot each open an encoder.
    let mut guard = shared.displays.active.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_some() {
        drop(guard);
        refuse("A device is already viewing a display. Stop that view before starting another.");
        return;
    }
    let generation = shared.next_id();
    let original = quality == DisplayQuality::Original;
    let (tx, rx) = mpsc::channel(2);
    let latest = Arc::new(Latest::default());
    let (cancel, cancelled) = watch::channel(false);
    let stopped = Arc::new(AtomicBool::new(false));
    let needs_keyframe = Arc::new(AtomicBool::new(true));
    *guard = Some(Active {
        session,
        request,
        generation,
        original,
        alive: Instant::now(),
        frames: tx,
        latest: latest.clone(),
        cancel,
        stopped: stopped.clone(),
        needs_keyframe: needs_keyframe.clone(),
    });
    drop(guard);
    shared.send_to(session, state(request, "connecting", None));
    tokio::spawn(async move {
        let result = run(
            &shared,
            session,
            request,
            generation,
            display_id,
            sdp,
            quality,
            rx,
            &latest,
            cancelled,
            &stopped,
            &needs_keyframe,
        )
        .await;
        let message = result.err().unwrap_or_else(|| "Screen mirroring stopped.".into());
        shared.displays.failed(&shared, session, generation, &message);
    });
}

/// Conservative receiver limits, including the macroblock rate. Many phone
/// offers advertise level 3.1 even when their hardware can decode more.
/// Desktop streams are idle when still, so higher LAN ceilings improve scrolling
/// without raising idle bandwidth; BWE scales down on slower links.
fn capture_limits(quality: DisplayQuality, level: u8) -> (u32, u32, u32) {
    if quality == DisplayQuality::Original {
        return (3840, 1, 0);
    }
    if level < 31 {
        return (352, 15, 400_000);
    }
    match quality {
        DisplayQuality::Auto if level >= 32 => (1280, 60, 8_000_000),
        DisplayQuality::Auto => (896, 60, 4_500_000),
        DisplayQuality::Battery => (960, 30, 2_000_000),
        DisplayQuality::Sharp if level >= 40 => (1920, 30, 12_000_000),
        DisplayQuality::Sharp => (1280, 30, 6_000_000),
        DisplayQuality::Original => unreachable!(),
    }
}

fn h264_profile(profile_level_id: Option<u32>) -> (u8, DisplayProfile) {
    match profile_level_id.unwrap_or(0x42e01f) >> 8 {
        0x640c => (3, DisplayProfile::ConstrainedHigh),
        0x6400 => (2, DisplayProfile::ConstrainedHigh),
        0x4d00 => (1, DisplayProfile::Main),
        _ => (0, DisplayProfile::ConstrainedBaseline),
    }
}

fn receiver_level(sdp: &str, pt: u8) -> u8 {
    let prefix = format!("a=fmtp:{pt} ");
    sdp.lines()
        .find_map(|line| line.trim().strip_prefix(&prefix))
        .and_then(|params| params.split(';').find_map(|param| param.trim().strip_prefix("profile-level-id=")))
        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
        .map(|value| value as u8)
        .unwrap_or(31)
}

struct Endpoint {
    address: SocketAddr,
    socket: Arc<UdpSocket>,
}

struct Datagram {
    source: SocketAddr,
    destination: SocketAddr,
    bytes: Vec<u8>,
}

fn rank_endpoint(name: &str, ip: IpAddr) -> Option<(u8, bool, IpAddr)> {
    if ip.is_unspecified() || ip.is_multicast() {
        return None;
    }
    match ip {
        IpAddr::V4(v4) if v4.is_link_local() => return None,
        IpAddr::V6(v6) if v6.is_unicast_link_local() => return None,
        _ => {}
    }
    let tier = if ip.is_loopback() {
        3
    } else if name.starts_with("en") {
        0
    } else if crate::host::VPN_INTERFACES.iter().any(|prefix| name.starts_with(prefix))
        || name.starts_with("bridge")
        || name.starts_with("awdl")
        || name.starts_with("llw")
    {
        2
    } else {
        1
    };
    Some((tier, ip.is_ipv6(), ip))
}

async fn endpoints() -> Result<Vec<Endpoint>, String> {
    let mut ranked: Vec<((u8, bool, IpAddr), IpAddr)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|iface| {
            let ip = iface.ip();
            rank_endpoint(&iface.name, ip).map(|key| (key, ip))
        })
        .collect();
    for ip in [IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)] {
        if let Some(key) = rank_endpoint("lo0", ip) {
            ranked.push((key, ip));
        }
    }
    ranked.sort_by_key(|(key, _)| *key);
    let mut seen = HashSet::new();
    let mut endpoints = Vec::new();
    for (_, ip) in ranked {
        if !seen.insert(ip) {
            continue;
        }
        if seen.len() > 32 {
            break;
        }
        if let Ok(socket) = UdpSocket::bind(SocketAddr::new(ip, 0)).await {
            let address = socket.local_addr().map_err(|e| e.to_string())?;
            endpoints.push(Endpoint { address, socket: Arc::new(socket) });
        }
    }
    if endpoints.is_empty() {
        return Err("The Mac could not open a local video connection.".into());
    }
    Ok(endpoints)
}

#[allow(clippy::too_many_arguments)]
async fn run(
    shared: &Shared,
    session: u64,
    request: u32,
    generation: u64,
    display_id: String,
    offer_text: String,
    quality: DisplayQuality,
    mut frames: mpsc::Receiver<Frame>,
    latest: &Latest,
    mut cancelled: watch::Receiver<bool>,
    stopped: &AtomicBool,
    needs_keyframe: &AtomicBool,
) -> Result<(), String> {
    if stopped.load(Ordering::Acquire) {
        return Ok(());
    }
    let original = quality == DisplayQuality::Original;
    let endpoints = endpoints().await?;
    let (incoming, mut datagrams) = mpsc::channel(32);
    // Exact bindings preserve the local destination needed by ICE, including
    // multi-interface VPN and IPv6 paths. JoinSet aborts all readers on exit.
    let mut readers = tokio::task::JoinSet::new();
    for endpoint in &endpoints {
        let socket = endpoint.socket.clone();
        let destination = endpoint.address;
        let incoming = incoming.clone();
        readers.spawn(async move {
            let mut buffer = [0; 8192];
            loop {
                match socket.recv_from(&mut buffer).await {
                    Ok((size, source)) => {
                        if incoming
                            .send(Datagram { source, destination, bytes: buffer[..size].to_vec() })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    // Transient ICMP/socket errors (such as ConnectionReset or
                    // ConnectionRefused from an unreachable candidate) must not
                    // end the reader for this socket.
                    Err(err)
                        if matches!(
                            err.kind(),
                            std::io::ErrorKind::WouldBlock
                                | std::io::ErrorKind::Interrupted
                                | std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionRefused
                                | std::io::ErrorKind::ConnectionAborted
                                | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            }
        });
    }
    drop(incoming);
    let mut builder = Rtc::builder()
        .set_ice_lite(true)
        .set_send_buffer_video(1024)
        .set_sctp_max_message_size(1024)
        .set_sctp_max_buffered_amount(128 * 1024)
        .enable_bwe(Some(Bitrate::mbps(4)))
        .set_stats_interval(Some(Duration::from_secs(1)));
    builder.codec_config().clear();
    // Prefer CABAC-capable H.264 profiles (no B-frames) when the browser
    // offers them, falling back to Constrained Baseline. The receiver's
    // offered level determines capture limits below.
    builder.codec_config().add_h264(114.into(), Some(115.into()), true, 0x640c2a);
    builder.codec_config().add_h264(112.into(), Some(113.into()), true, 0x64002a);
    builder.codec_config().add_h264(123.into(), Some(119.into()), true, 0x4d002a);
    builder.codec_config().add_h264(108.into(), Some(109.into()), true, 0x42e02a);
    let started = Instant::now();
    let mut rtc = builder.build(started);
    for endpoint in &endpoints {
        let candidate = Candidate::host(endpoint.address, "udp").map_err(|e| e.to_string())?;
        rtc.add_local_candidate(candidate);
        loop {
            match rtc.poll_output().map_err(|e| e.to_string())? {
                Output::Timeout(_) => break,
                _ => continue,
            }
        }
    }
    let offer = SdpOffer::from_sdp_string(&offer_text).map_err(|_| "The browser's video offer could not be read.")?;
    let answer =
        rtc.sdp_api().accept_offer(offer).map_err(|_| "The browser could not negotiate compatible H.264 video.")?;
    shared.send_to(
        session,
        ServerMessage::DisplayState {
            id: request,
            state: "answer".into(),
            sdp: Some(answer.to_sdp_string()),
            message: None,
        },
    );
    let mut media = None;
    let mut connected = false;
    let mut capture_started = false;
    let mut image_channel = None;
    let mut image_transfer: Option<(Frame, u32, usize, Instant)> = None;
    let mut image_sequence = 0u32;
    let mut maximum_bitrate = 3_000_000;
    let mut current_bitrate = maximum_bitrate;
    let mut maximum_fps = 60;
    let mut last_config = Instant::now();
    let mut last_keyframe = Instant::now() - Duration::from_secs(1);
    let mut waiting_for_keyframe = true;
    let mut frames_sent = 0u64;
    let mut send_failing: Option<Instant> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    loop {
        if stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        access(shared, session).map_err(str::to_string)?;
        let alive = shared
            .displays
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|a| a.generation == generation && a.alive.elapsed() <= LEASE);
        if !alive {
            return Err("Viewing stopped because the phone is no longer active.".into());
        }
        if !connected && started.elapsed() > CONNECT_TIMEOUT {
            return Err("Video could not reach the phone. Check that the network or VPN allows a direct UDP connection to the Mac.".into());
        }
        if original
            && connected
            && image_transfer.is_none()
            && let Some(frame) = latest.take()
        {
            image_sequence = image_sequence.wrapping_add(1);
            image_transfer = Some((frame, image_sequence, 0, Instant::now()));
        }
        if let (Some(channel), Some((frame, sequence, offset, began))) = (image_channel, image_transfer.as_mut()) {
            if began.elapsed() > Duration::from_secs(12) {
                return Err("HD text could not keep up with the connection. Choose Sharper text and try again.".into());
            }
            if let Some(mut channel) = rtc.channel(channel) {
                // One in-flight picture, the newest waiting picture, and 128 KiB of SCTP
                // buffering. Chunk writes yield regularly to network input and cancellation.
                for _ in 0..4 {
                    if *offset == frame.data.len() || channel.buffered_amount() >= 64 * 1024 {
                        break;
                    }
                    let end = (*offset + 16 * 1024 - 16).min(frame.data.len());
                    let mut chunk = Vec::with_capacity(16 + end - *offset);
                    chunk.extend_from_slice(b"CPNG");
                    chunk.extend_from_slice(&sequence.to_le_bytes());
                    chunk.extend_from_slice(&(frame.data.len() as u32).to_le_bytes());
                    chunk.extend_from_slice(&(*offset as u32).to_le_bytes());
                    chunk.extend_from_slice(&frame.data[*offset..end]);
                    if !channel.write(true, &chunk).map_err(|e| e.to_string())? {
                        break;
                    }
                    *offset = end;
                }
            }
            if *offset == frame.data.len() {
                image_transfer = None;
            }
        }
        let deadline = loop {
            if stopped.load(Ordering::Acquire) {
                return Ok(());
            }
            match rtc.poll_output().map_err(|e| e.to_string())? {
                Output::Timeout(deadline) => break deadline,
                Output::Transmit(packet) => {
                    let endpoint = endpoints
                        .iter()
                        .find(|endpoint| endpoint.address == packet.source)
                        .ok_or("The selected network interface is no longer available.")?;
                    tokio::select! {
                        _ = cancelled.changed() => return Ok(()),
                        result = tokio::time::timeout(Duration::from_millis(500), endpoint.socket.send_to(&packet.contents, packet.destination)) => {
                            // A roaming phone or a full interface queue fails single sends.
                            // WebRTC recovers from loss; only a lasting failure ends the view.
                            match result.map_err(|_| "The video connection stalled. Try Save battery or a faster network.")? {
                                Ok(_) => send_failing = None,
                                Err(_) if send_failing.get_or_insert_with(Instant::now).elapsed() > SEND_FAILURE_LIMIT => {
                                    return Err("The video connection was interrupted.".into());
                                }
                                Err(_) => {}
                            }
                        }
                    }
                }
                Output::Event(Event::MediaAdded(added)) if added.kind == MediaKind::Video => {
                    if added.direction != Direction::SendOnly {
                        return Err("The browser requested an unsupported video connection.".into());
                    }
                    let chosen = rtc.writer(added.mid).and_then(|writer| {
                        writer
                            .payload_params()
                            .filter(|p| p.spec().codec == Codec::H264)
                            .max_by_key(|p| h264_profile(p.spec().format.profile_level_id).0)
                            .map(|p| (p.pt(), h264_profile(p.spec().format.profile_level_id).1))
                    });
                    let Some((pt, profile)) = chosen else {
                        return Err("This browser did not offer compatible H.264 video.".into());
                    };
                    let level = receiver_level(&offer_text, *pt);
                    let (dimension, fps, bitrate) = capture_limits(quality, level);
                    media = Some((added.mid, pt, dimension, profile));
                    maximum_bitrate = bitrate;
                    current_bitrate = bitrate;
                    maximum_fps = fps;
                    let initial_bwe = bitrate.min(6_000_000) as u64;
                    rtc.bwe().reset(Bitrate::bps(initial_bwe));
                    rtc.bwe().set_bitrate(Bitrate::ZERO, Bitrate::bps(bitrate as u64));
                }
                Output::Event(Event::Connected) => {
                    connected = true;
                }
                Output::Event(Event::ChannelOpen(id, label)) => {
                    if !original || image_channel.is_some() || label != "cmdpalm.original" {
                        return Err("The browser opened an unsupported data connection.".into());
                    }
                    image_channel = Some(id);
                }
                Output::Event(Event::ChannelClose(id)) if Some(id) == image_channel => {
                    return Err("The HD text connection ended. Start viewing again.".into());
                }
                Output::Event(Event::ChannelData(_)) => {
                    return Err("The HD text connection only receives pictures on the phone.".into());
                }
                Output::Event(Event::Closed) => {
                    return Err("The video connection ended. Start viewing again when the phone is ready.".into());
                }
                Output::Event(Event::KeyframeRequest(_)) => {
                    if last_keyframe.elapsed() > Duration::from_millis(250) {
                        shared.delegate.display_command(session, DisplayCommand::KeyFrame { generation });
                        last_keyframe = Instant::now();
                    }
                }
                Output::Event(Event::EgressBitrateEstimate(estimate)) => {
                    if original || frames_sent == 0 {
                        continue;
                    }
                    let estimate = match estimate {
                        BweKind::Twcc { estimate, .. } | BweKind::Remb { estimate, .. } => estimate,
                        _ => continue,
                    };
                    let bitrate = ((estimate.as_u64() * 8 / 10).min(maximum_bitrate as u64) as u32).max(250_000);
                    let decreasing = bitrate < current_bitrate;
                    let cooldown = if decreasing { Duration::from_millis(400) } else { Duration::from_secs(1) };
                    let threshold = if decreasing { current_bitrate * 3 / 20 } else { current_bitrate / 5 };
                    if connected
                        && last_config.elapsed() >= cooldown
                        && bitrate.abs_diff(current_bitrate) > threshold
                    {
                        current_bitrate = bitrate;
                        let fps = if bitrate < 800_000 {
                            maximum_fps.min(15)
                        } else if bitrate < 1_800_000 {
                            maximum_fps.min(30)
                        } else {
                            maximum_fps
                        };
                        shared
                            .delegate
                            .display_command(session, DisplayCommand::Configure { generation, fps, bitrate });
                        last_config = Instant::now();
                    }
                }
                Output::Event(_) => {}
            }
            // Connected can precede MediaAdded. Start only after both events,
            // rather than assuming a particular event ordering from WebRTC.
            if connected && original && !capture_started && image_channel.is_some() {
                capture_started = true;
                shared.delegate.display_command(
                    session,
                    DisplayCommand::Start {
                        generation,
                        display_id: display_id.clone(),
                        max_dimension: 3840,
                        fps: 1,
                        bitrate: 0,
                        original: true,
                        profile: DisplayProfile::ConstrainedBaseline,
                    },
                );
                shared.send_to(session, state(request, "streaming", None));
            }
            if !original
                && connected
                && !capture_started
                && let Some((_, _, max_dimension, profile)) = media
            {
                capture_started = true;
                shared.delegate.display_command(
                    session,
                    DisplayCommand::Start {
                        generation,
                        display_id: display_id.clone(),
                        max_dimension,
                        fps: maximum_fps,
                        bitrate: current_bitrate,
                        original: false,
                        profile,
                    },
                );
                shared.send_to(session, state(request, "streaming", None));
            }
        };
        tokio::select! {
            _ = cancelled.changed() => return Ok(()),
            _ = tick.tick() => {},
            received = datagrams.recv() => {
                let packet = received.ok_or("The video connection was interrupted.")?;
                if let Ok(receive) = Receive::new(Protocol::Udp, packet.source, packet.destination, &packet.bytes) {
                    let input = Input::Receive(Instant::now(), receive);
                    // Unauthenticated or malformed UDP must not terminate an
                    // otherwise valid viewer. Drain any state changes next.
                    if rtc.accepts(&input) { let _ = rtc.handle_input(input); }
                }
            }
            // Only a wake-up: the next pass takes the newest picture itself.
            _ = latest.ready.notified(), if original && connected && image_transfer.is_none() => {}
            Some(frame) = frames.recv(), if connected && !original => {
                if frame.queued.elapsed() > Duration::from_millis(150) {
                    waiting_for_keyframe = true;
                    needs_keyframe.store(true, Ordering::Release);
                    if last_keyframe.elapsed() > Duration::from_millis(500) {
                        shared.delegate.display_command(session, DisplayCommand::KeyFrame { generation });
                        last_keyframe = Instant::now();
                    }
                    continue;
                }
                if waiting_for_keyframe && !frame.keyframe { continue; }
                if frame.keyframe { waiting_for_keyframe = false; }
                if let Some((mid, pt, _, _)) = media {
                    rtc.writer(mid).ok_or("The video track ended.")?.write(pt, Instant::now(), MediaTime::from_micros(frame.timestamp_us), frame.data).map_err(|e| e.to_string())?;
                    frames_sent += 1;
                }
            }
            _ = tokio::time::sleep_until(deadline.into()) => { rtc.handle_input(Input::Timeout(Instant::now())).map_err(|e| e.to_string())?; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn levels_limit_resolution_and_macroblock_rate() {
        assert_eq!(capture_limits(DisplayQuality::Auto, 31), (896, 60, 4_500_000));
        assert_eq!(capture_limits(DisplayQuality::Auto, 32), (1280, 60, 8_000_000));
        assert_eq!(capture_limits(DisplayQuality::Battery, 31), (960, 30, 2_000_000));
        assert_eq!(capture_limits(DisplayQuality::Sharp, 31), (1280, 30, 6_000_000));
        assert_eq!(capture_limits(DisplayQuality::Sharp, 40), (1920, 30, 12_000_000));
        assert_eq!(capture_limits(DisplayQuality::Original, 31), (3840, 1, 0));
        assert_eq!(receiver_level("a=fmtp:108 packetization-mode=1; profile-level-id=42e020\r\n", 108), 32);
        assert_eq!(receiver_level("a=fmtp:109 profile-level-id=42e02a\r\n", 108), 31);
    }

    #[test]
    fn h264_profile_ranking_prefers_cabac_profiles_over_baseline() {
        let ch = h264_profile(Some(0x640c2a));
        let high = h264_profile(Some(0x64002a));
        let main = h264_profile(Some(0x4d002a));
        let cb = h264_profile(Some(0x42e01f));
        let unknown = h264_profile(None);

        assert_eq!(ch.1, DisplayProfile::ConstrainedHigh);
        assert_eq!(high.1, DisplayProfile::ConstrainedHigh);
        assert_eq!(main.1, DisplayProfile::Main);
        assert_eq!(cb.1, DisplayProfile::ConstrainedBaseline);
        assert_eq!(unknown.1, DisplayProfile::ConstrainedBaseline);
        assert!(ch.0 > high.0 && high.0 > main.0 && main.0 > cb.0);
    }

    #[test]
    fn endpoint_ranking_excludes_link_local_and_prefers_lan() {
        assert_eq!(rank_endpoint("en0", IpAddr::V4(Ipv4Addr::new(169, 254, 1, 2))), None);
        assert_eq!(rank_endpoint("en0", "fe80::1".parse().unwrap()), None);
        assert_eq!(rank_endpoint("en0", IpAddr::V4(Ipv4Addr::UNSPECIFIED)), None);
        assert_eq!(rank_endpoint("en0", IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1))), None);

        let lan4 = rank_endpoint("en0", "192.168.1.10".parse().unwrap()).unwrap();
        let lan6 = rank_endpoint("en0", "fd00::1".parse().unwrap()).unwrap();
        let other = rank_endpoint("p2p0", "172.16.0.5".parse().unwrap()).unwrap();
        let vpn = rank_endpoint("utun4", "10.8.0.2".parse().unwrap()).unwrap();
        let awdl = rank_endpoint("awdl0", "fd00::2".parse().unwrap()).unwrap();
        let llw = rank_endpoint("llw0", "fd00::3".parse().unwrap()).unwrap();
        let bridge = rank_endpoint("bridge100", "192.168.64.1".parse().unwrap()).unwrap();
        let lo4 = rank_endpoint("lo0", IpAddr::V4(Ipv4Addr::LOCALHOST)).unwrap();
        let lo6 = rank_endpoint("lo0", IpAddr::V6(Ipv6Addr::LOCALHOST)).unwrap();

        assert!(lan4 < lan6);
        assert!(lan6 < other);
        assert!(other < vpn);
        assert!(other < awdl);
        assert!(other < llw);
        assert!(other < bridge);
        assert!(vpn < lo4);
        assert!(awdl < lo4);
        assert!(lo4 < lo6);
    }
}
