//! The local server: one port that speaks HTTP and HTTPS, serves the web
//! client and app icons, and upgrades `/ws` to the control WebSocket.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, UNIX_EPOCH};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocketConfig};

use crate::api::HostEvent;
use crate::deck::{Deck, DeckError};
use crate::host::{Shared, lan_addresses};
use crate::protocol::ServerMessage;
use crate::{auth, session, store, tls};

const PORT_ATTEMPTS: u16 = 20;
const HEAD_LIMIT: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const TLS_TIMEOUT: Duration = Duration::from_secs(10);
const ICON_CACHE_LIMIT: usize = 256;
/// Open connections, so idle sockets from one device can't use up the app's
/// file descriptors and lock out real phones.
const MAX_CONNECTIONS: usize = 128;
const MAX_CONNECTIONS_PER_ADDRESS: usize = 16;
/// One machine can use any number of IPv6 addresses in its /64, but phones
/// on the same home network share one too, so a /64 gets several devices' worth.
const MAX_CONNECTIONS_PER_PREFIX: usize = MAX_CONNECTIONS / 2;
const MAX_REQUESTS_PER_CONNECTION: usize = 200;
const MAX_KEEP_ALIVE: Duration = Duration::from_secs(120);
pub const MAX_MESSAGE: usize = 1 << 20;
const IDENTITY_CHECK: Duration = Duration::from_secs(60 * 60);
const IDENTITY_RETRY: Duration = Duration::from_secs(60);
/// A failed write of the trusted devices is tried again about once a minute.
const TRUST_RETRY_TICKS: u64 = 12;

#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error("The deck changed on another device. Review your edit and save again.")]
    Conflict,
    #[error(transparent)]
    Deck(#[from] DeckError),
    #[error("could not save the deck: {0}")]
    Io(#[from] std::io::Error),
}

/// Orders deck saves by when they were asked for.
pub(crate) fn deck_ticket(shared: &Shared) -> u64 {
    shared.deck_tickets.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

pub(crate) fn save_deck(shared: &Shared, deck: Deck) -> Result<(), SaveError> {
    save_deck_as(shared, deck, deck_ticket(shared))
}

/// Saves can run on separate threads and get here out of order. One older
/// than the deck already saved is dropped, as if it had come first.
pub(crate) fn save_deck_as(shared: &Shared, deck: Deck, ticket: u64) -> Result<(), SaveError> {
    save_deck_version(shared, deck, ticket, None).map(|_| ())
}

pub(crate) fn save_deck_version(
    shared: &Shared,
    deck: Deck,
    ticket: u64,
    revision: Option<u64>,
) -> Result<u64, SaveError> {
    deck.validate()?;
    let mut newest = shared.deck_lock.lock().unwrap_or_else(|p| p.into_inner());
    let current = shared.state().deck_revision;
    if revision.is_some_and(|base| base != current) {
        return Err(SaveError::Conflict);
    }
    if ticket < *newest {
        return if revision.is_some() { Err(SaveError::Conflict) } else { Ok(current) };
    }
    if let Some(dir) = shared.data_dir() {
        store::save(&dir.join("deck.json"), &deck)?;
    }
    *newest = ticket;
    let revision = {
        let mut state = shared.state();
        state.deck = deck.clone();
        state.deck_revision += 1;
        state.deck_revision
    };
    shared.broadcast(ServerMessage::Deck { deck, revision });
    Ok(revision)
}

fn bind(port: u16) -> std::io::Result<(TcpListener, Option<TcpListener>)> {
    let v4 = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))?;
    v4.set_nonblocking(true)?;
    let port = v4.local_addr()?.port();
    // Phones resolving `name.local` often try IPv6 first; listen there too
    // when possible so connections do not wait for a fallback.
    let v6 = (|| -> std::io::Result<std::net::TcpListener> {
        let socket = socket2::Socket::new(socket2::Domain::IPV6, socket2::Type::STREAM, None)?;
        socket.set_only_v6(true)?;
        socket.set_reuse_address(true)?;
        socket.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, port)).into())?;
        socket.listen(128)?;
        socket.set_nonblocking(true)?;
        Ok(socket.into())
    })()
    .inspect_err(|err| tracing::info!(%err, port, "not listening on IPv6"))
    .ok();
    Ok((TcpListener::from_std(v4)?, v6.and_then(|l| TcpListener::from_std(l).ok())))
}

pub(crate) async fn start(shared: Arc<Shared>, shutdown: watch::Receiver<bool>) -> std::io::Result<(u16, bool)> {
    let preferred = shared.config().port;
    let mut last_err = None;
    let mut bound = None;
    let attempts = if preferred == 0 { 1 } else { PORT_ATTEMPTS };
    for offset in 0..attempts {
        let Some(port) = preferred.checked_add(offset) else { break };
        match bind(port) {
            Ok(listeners) => {
                bound = Some(listeners);
                break;
            }
            Err(err) => last_err = Some(err),
        }
    }
    let Some((v4, v6)) = bound else {
        let err = last_err.unwrap_or_else(|| std::io::Error::other("no port available"));
        return Err(std::io::Error::new(err.kind(), format!("could not listen on port {preferred}: {err}")));
    };
    let port = v4.local_addr()?.port();
    shared.port.store(port, Ordering::Relaxed);

    let addresses = lan_addresses();
    let names = identity_names(&shared, &addresses);
    let identity_due = next_identity_check(refresh_identity(&shared, names.clone()).await);

    for listener in std::iter::once(v4).chain(v6) {
        tokio::spawn(accept_loop(shared.clone(), listener, shutdown.clone()));
    }
    tokio::spawn(housekeeping(shared.clone(), addresses, names, identity_due, shutdown));
    Ok((port, preferred != 0 && port != preferred))
}

/// Names the server certificate must cover right now.
fn identity_names(shared: &Shared, addresses: &[IpAddr]) -> Vec<String> {
    tls::server_names(&shared.config().host_name, addresses)
}

/// Create or reissue the TLS certificate for `names`. Returns whether HTTPS
/// is set up as well as it can be.
async fn refresh_identity(shared: &Arc<Shared>, names: Vec<String>) -> bool {
    let Some(dir) = shared.data_dir() else { return true };
    let result = tokio::task::spawn_blocking(move || tls::load_identity(&dir.join("tls"), &names)).await;
    match result {
        Ok(Ok(identity)) => {
            *shared.tls.write().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(identity));
            return true;
        }
        Ok(Err(err)) => tracing::error!(%err, "HTTPS is unavailable"),
        Err(err) => tracing::error!(%err, "certificate task failed"),
    }
    false
}

/// When to look at the certificate again: soon after a failure, and every so
/// often anyway, so a Mac that runs for months renews it before it expires.
fn next_identity_check(refreshed: bool) -> Instant {
    Instant::now() + if refreshed { IDENTITY_CHECK } else { IDENTITY_RETRY }
}

async fn housekeeping(
    shared: Arc<Shared>,
    mut addresses: Vec<IpAddr>,
    mut names: Vec<String>,
    mut identity_due: Instant,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut ticker = tokio::time::interval(Duration::from_secs(5));
    let mut ticks = 0u64;
    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = shutdown.changed() => return,
        }
        let rotated = shared.state().pairing.refresh(Instant::now());
        let current = lan_addresses();
        let moved = current != addresses;
        if moved {
            addresses = current;
        }
        // A new address, or the Mac renamed in System Settings, needs a
        // certificate that names it.
        let wanted = identity_names(&shared, &addresses);
        if wanted != names || Instant::now() >= identity_due {
            names = wanted;
            identity_due = next_identity_check(refresh_identity(&shared, names.clone()).await);
        }
        if rotated || moved {
            shared.emit(HostEvent::PairingChanged);
        }
        ticks += 1;
        if ticks.is_multiple_of(TRUST_RETRY_TICKS) && shared.trust_unsaved() {
            let saving = shared.clone();
            let _ = tokio::task::spawn_blocking(move || saving.save_trust()).await;
        }
    }
}

async fn accept_loop(shared: Arc<Shared>, listener: TcpListener, mut shutdown: watch::Receiver<bool>) {
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = shutdown.changed() => return,
        };
        match accepted {
            Ok((stream, peer)) => {
                let peer = peer.ip().to_canonical();
                let Some(slot) = ConnectionSlot::take(&shared, peer) else {
                    tracing::debug!(%peer, "too many connections; refusing");
                    continue;
                };
                let shared = shared.clone();
                let shutdown = shutdown.clone();
                tokio::spawn(async move {
                    let _slot = slot;
                    connection(shared, stream, peer, shutdown).await;
                });
            }
            Err(err) => {
                // EMFILE and friends: back off instead of spinning.
                tracing::warn!(%err, "accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

fn open_connections(shared: &Shared) -> usize {
    shared.connections.lock().unwrap_or_else(|p| p.into_inner()).values().sum()
}

/// Counts an open connection until dropped.
pub(crate) struct ConnectionSlot {
    shared: Arc<Shared>,
    peer: IpAddr,
}

impl ConnectionSlot {
    pub(crate) fn take(shared: &Arc<Shared>, peer: IpAddr) -> Option<Self> {
        // A reverse proxy on this Mac connects from loopback on behalf of
        // every phone that uses it.
        let proxy = peer.is_loopback() && shared.config().allow_local_proxy;
        let prefix = auth::throttle_key(peer);
        let mut open = shared.connections.lock().unwrap_or_else(|p| p.into_inner());
        let total: usize = open.values().sum();
        let in_prefix: usize = open.iter().filter(|(a, _)| auth::throttle_key(**a) == prefix).map(|(_, n)| n).sum();
        let limit = if proxy { MAX_CONNECTIONS / 2 } else { MAX_CONNECTIONS_PER_ADDRESS };
        let mine = open.entry(peer).or_insert(0);
        if total >= MAX_CONNECTIONS || in_prefix >= MAX_CONNECTIONS_PER_PREFIX || *mine >= limit {
            if *mine == 0 {
                open.remove(&peer);
            }
            return None;
        }
        *mine += 1;
        Some(Self { shared: shared.clone(), peer })
    }
}

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        let mut open = self.shared.connections.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(count) = open.get_mut(&self.peer) {
            *count -= 1;
            if *count == 0 {
                open.remove(&self.peer);
            }
        }
    }
}

async fn connection(shared: Arc<Shared>, stream: TcpStream, peer: IpAddr, shutdown: watch::Receiver<bool>) {
    let _ = stream.set_nodelay(true);
    let mut first = [0u8; 1];
    match timeout(HEAD_TIMEOUT, stream.peek(&mut first)).await {
        Ok(Ok(1)) => {}
        _ => return,
    }
    // 0x16 is a TLS handshake record; anything else is plain HTTP.
    if first[0] == 0x16 {
        let identity = shared.tls.read().unwrap_or_else(|p| p.into_inner()).clone();
        let Some(identity) = identity else { return };
        let acceptor = tokio_rustls::TlsAcceptor::from(identity.config.clone());
        match timeout(TLS_TIMEOUT, acceptor.accept(stream)).await {
            Ok(Ok(tls)) => serve(shared, tls, peer, true, shutdown).await,
            Ok(Err(err)) => tracing::debug!(%err, %peer, "TLS handshake failed"),
            Err(_) => tracing::debug!(%peer, "TLS handshake timed out"),
        }
    } else {
        serve(shared, stream, peer, false, shutdown).await;
    }
}

#[derive(Debug)]
pub(crate) struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub http10: bool,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn query(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn header_has_token(&self, name: &str, token: &str) -> bool {
        self.header(name).is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
    }

    fn keep_alive(&self) -> bool {
        if self.http10 {
            self.header_has_token("connection", "keep-alive")
        } else {
            !self.header_has_token("connection", "close")
        }
    }
}

pub(crate) fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = bytes.get(i + 1..i + 3)?;
                // from_str_radix would also take a sign, as in `%+1`.
                if !hex.iter().all(u8::is_ascii_hexdigit) {
                    return None;
                }
                let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
                out.push(value);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

pub(crate) fn parse_head(head: &[u8]) -> Option<Request> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let mut start = lines.next()?.split(' ');
    let method = start.next()?.to_string();
    let target = start.next()?;
    let version = start.next()?;
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || start.next().is_some()
        || method.is_empty()
        || !method.bytes().all(is_token)
        || !target.starts_with('/')
        || target.bytes().any(|b| b <= b' ' || b == 0x7f || b == b'#')
    {
        return None;
    }
    let (raw_path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    // `+` is literal in paths; only queries use it for spaces.
    let path = percent_decode(&raw_path.replace('+', "%2B"))?;
    let query = raw_query
        .split('&')
        .filter(|p| !p.is_empty())
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            Some((percent_decode(k)?, percent_decode(v)?))
        })
        .collect();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':')?;
        if name.is_empty() || !name.bytes().all(is_token) || value.bytes().any(|b| b.is_ascii_control() && b != b'\t') {
            return None;
        }
        headers.push((name.to_ascii_lowercase(), value.trim_matches([' ', '\t']).to_string()));
    }
    // A proxy in front could read a different copy of these than this server
    // does, which is how requests get smuggled past it.
    for name in ["host", "content-length", "transfer-encoding"] {
        if headers.iter().filter(|(k, _)| k == name).count() > 1 {
            return None;
        }
    }
    Some(Request { method, path, query, headers, http10: version == "HTTP/1.0" })
}

fn is_token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

/// Read one request head. Leftover bytes stay in `buf` for the next request.
async fn read_head<S: AsyncRead + Unpin>(stream: &mut S, buf: &mut Vec<u8>, first: bool) -> Option<Vec<u8>> {
    let deadline = if first { HEAD_TIMEOUT } else { IDLE_TIMEOUT };
    let read = async {
        let mut chunk = [0u8; 4096];
        // Only rescan the bytes that could complete a terminator.
        let mut scanned = 0;
        loop {
            if let Some(end) = buf[scanned..].windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + scanned) {
                if end > HEAD_LIMIT {
                    return None;
                }
                let head = buf[..end].to_vec();
                buf.drain(..end + 4);
                return Some(head);
            }
            scanned = buf.len().saturating_sub(3);
            if buf.len() > HEAD_LIMIT {
                return None;
            }
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    };
    timeout(deadline, read).await.ok().flatten()
}

#[derive(Debug)]
pub(crate) struct Response {
    status: u16,
    content_type: &'static str,
    body: Arc<Vec<u8>>,
    headers: Vec<(&'static str, String)>,
}

impl Response {
    fn new(status: u16, content_type: &'static str, body: impl Into<Arc<Vec<u8>>>) -> Self {
        Self { status, content_type, body: body.into(), headers: Vec::new() }
    }

    fn text(status: u16, text: &str) -> Self {
        Self::new(status, "text/plain; charset=utf-8", text.as_bytes().to_vec())
    }

    fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        304 => "Not Modified",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        421 => "Misdirected Request",
        426 => "Upgrade Required",
        _ => "Error",
    }
}

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

async fn write_response<S: AsyncWrite + Unpin>(
    stream: &mut S,
    response: &Response,
    head_only: bool,
    keep_alive: bool,
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: {}\r\n\
X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\n\
Content-Security-Policy: {CSP}\r\n",
        response.status,
        reason(response.status),
        response.content_type,
        response.body.len(),
        if keep_alive { "keep-alive" } else { "close" },
    );
    for (name, value) in &response.headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    timeout(WRITE_TIMEOUT, async {
        stream.write_all(head.as_bytes()).await?;
        if !head_only && response.status != 304 {
            stream.write_all(&response.body).await?;
        }
        stream.flush().await
    })
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "HTTP write timed out"))?
}

async fn serve<S>(shared: Arc<Shared>, mut stream: S, peer: IpAddr, secure: bool, shutdown: watch::Receiver<bool>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut buf = Vec::with_capacity(4096);
    let mut first = true;
    let opened = Instant::now();
    let mut served = 0usize;
    loop {
        let Some(head) = read_head(&mut stream, &mut buf, first).await else { return };
        first = false;
        let Some(request) = parse_head(&head) else {
            let _ = write_response(&mut stream, &Response::text(400, "Bad request"), false, false).await;
            return;
        };
        if request.method != "GET" && request.method != "HEAD" {
            let _ = write_response(&mut stream, &Response::text(405, "Method not allowed"), false, false).await;
            return;
        }
        // A body would be read as the next request on this connection, which
        // could smuggle forwarded headers past a proxy.
        if request.header("transfer-encoding").is_some() || request.header("content-length").is_some_and(|n| n != "0") {
            let _ = write_response(&mut stream, &Response::text(400, "Bad request"), false, false).await;
            return;
        }
        let client = client(&request, peer, secure, shared.config().allow_local_proxy);
        let Some(host) = client.host.filter(|host| known_host(&shared, host)) else {
            let _ = write_response(&mut stream, &Response::text(421, "Unknown host name"), false, false).await;
            return;
        };
        let (address, secure) = (client.address, client.secure);
        if request.path == "/ws" {
            match websocket_accept(&request, host, secure) {
                Ok(accept) => {
                    let reply = format!(
                        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                    );
                    let switched = timeout(WRITE_TIMEOUT, async {
                        stream.write_all(reply.as_bytes()).await?;
                        stream.flush().await
                    })
                    .await;
                    if !matches!(switched, Ok(Ok(()))) {
                        return;
                    }
                    let config = WebSocketConfig::default()
                        .max_message_size(Some(MAX_MESSAGE))
                        .max_frame_size(Some(MAX_MESSAGE));
                    let ws = WebSocketStream::from_partially_read(stream, buf, Role::Server, Some(config)).await;
                    session::run(shared, ws, address, secure, shutdown).await;
                }
                Err(response) => {
                    let _ = write_response(&mut stream, &response, false, false).await;
                }
            }
            return;
        }
        served += 1;
        // Keep-alive connections are recycled so idle sockets can't hold the
        // connection slots that phones need.
        let keep_alive = request.keep_alive()
            && served < MAX_REQUESTS_PER_CONNECTION
            && opened.elapsed() < MAX_KEEP_ALIVE
            && open_connections(&shared) < MAX_CONNECTIONS * 3 / 4;
        let response = route(&shared, &request, secure).await;
        if write_response(&mut stream, &response, request.method == "HEAD", keep_alive).await.is_err() || !keep_alive {
            return;
        }
    }
}

/// Private name suffixes that public DNS never answers for: Bonjour, home
/// networks (RFC 8375) and ICANN's private-use `.internal`.
const LOCAL_SUFFIXES: [&str; 3] = [".local", ".home.arpa", ".internal"];

/// Whether a `Host` header names this Mac the way a device on the network
/// would: an IP address, `localhost`, a single-label name from the local
/// network's DNS, or a name under [`LOCAL_SUFFIXES`]. Anything else is
/// a domain that could resolve to this Mac through DNS rebinding, which
/// would make another website same-origin with the server.
pub(crate) fn local_host(host: &str) -> bool {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split_once(']').is_some_and(|(ip, after)| {
            ip.parse::<Ipv6Addr>().is_ok()
                && (after.is_empty() || after.strip_prefix(':').is_some_and(|port| port.parse::<u16>().is_ok()))
        });
    }
    let name = host_name(host);
    if name.parse::<IpAddr>().is_ok() || name == "localhost" {
        return true;
    }
    let well_formed = name.split('.').all(|label| {
        !label.is_empty() && label.len() <= 63 && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    });
    if !well_formed {
        return false;
    }
    // Public DNS has no dotless names, so only the local network's resolver
    // can answer for one. Bare suffixes are not machine names.
    if !name.contains('.') {
        return !LOCAL_SUFFIXES.iter().any(|suffix| suffix[1..] == name);
    }
    LOCAL_SUFFIXES.iter().any(|suffix| name.ends_with(suffix) && name.len() > suffix.len())
}

/// The name in a `Host` header, lowercased, without its port or final dot.
pub(crate) fn host_name(host: &str) -> String {
    let name = host.rsplit_once(':').filter(|(_, port)| port.parse::<u16>().is_ok()).map_or(host, |(name, _)| name);
    name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase()
}

/// Whether the server answers requests for `host`: a local name, or the host
/// of the custom pairing address the person set on the Mac.
fn known_host(shared: &Shared, host: &str) -> bool {
    local_host(host) || crate::host::custom_host_name(&shared.config()).is_some_and(|name| host_name(host) == name)
}

/// Who a request is really from. When the person allows it, a reverse proxy
/// on this Mac (Caddy, nginx, a VPN's HTTPS proxy) connects over loopback and
/// names the phone in `X-Forwarded-*` headers. Browsers can't add those
/// headers to a WebSocket upgrade or a navigation, so a web page can't fake
/// them, but other programs on the Mac could, hence the opt-in.
#[derive(Debug, PartialEq)]
pub(crate) struct Client<'a> {
    pub address: IpAddr,
    pub secure: bool,
    /// The host name the phone used, for the `Host` and `Origin` checks.
    pub host: Option<&'a str>,
}

pub(crate) fn client(request: &Request, peer: IpAddr, secure: bool, allow_proxy: bool) -> Client<'_> {
    let host = request.header("host");
    // The last entry is the one added by the proxy that connected to us.
    let forwarded = (allow_proxy && peer.is_loopback())
        .then(|| request.header("x-forwarded-for"))
        .flatten()
        .and_then(|list| list.rsplit(',').next())
        .map(str::trim)
        // Some proxies add the port: `10.0.0.9:51234` or `[fd00::9]:51234`.
        .and_then(|ip| ip.parse::<IpAddr>().ok().or_else(|| ip.parse::<SocketAddr>().ok().map(|a| a.ip())));
    let Some(address) = forwarded else {
        return Client { address: peer, secure, host };
    };
    // Last entries here too: a proxy that appends would otherwise let the
    // phone pick the host used for the Host and Origin checks.
    let last = |value: &'static str| request.header(value).map(|v| v.rsplit(',').next().unwrap_or(v).trim());
    Client {
        address: address.to_canonical(),
        secure: secure || last("x-forwarded-proto").is_some_and(|proto| proto.eq_ignore_ascii_case("https")),
        host: last("x-forwarded-host").filter(|h| !h.is_empty()).or(host),
    }
}

/// Validate a WebSocket upgrade. Browsers always send `Origin`; requiring it
/// to match the host stops other web pages from talking to the server.
fn websocket_accept(request: &Request, host: &str, secure: bool) -> Result<String, Response> {
    if request.method != "GET" {
        return Err(Response::text(405, "Method not allowed"));
    }
    if !request.header_has_token("upgrade", "websocket") || !request.header_has_token("connection", "upgrade") {
        return Err(Response::text(426, "WebSocket upgrade required"));
    }
    if request.header("sec-websocket-version") != Some("13") {
        return Err(Response::text(400, "Unsupported WebSocket version").header("Sec-WebSocket-Version", "13"));
    }
    let Some(key) = request.header("sec-websocket-key") else {
        return Err(Response::text(400, "Missing WebSocket key"));
    };
    if let Some(origin) = request.header("origin")
        && !same_origin(origin, host, secure)
    {
        return Err(Response::text(403, "Cross-origin connections are not allowed"));
    }
    Ok(derive_accept_key(key.as_bytes()))
}

fn same_origin(origin: &str, host: &str, secure: bool) -> bool {
    use tokio_tungstenite::tungstenite::http::uri::Authority;
    let Some((scheme, origin_host)) = origin.split_once("://") else { return false };
    if !scheme.eq_ignore_ascii_case(if secure { "https" } else { "http" }) {
        return false;
    }
    if origin_host.contains(['/', '?', '#', '@']) || host.contains('@') {
        return false;
    }
    let (Ok(origin), Ok(host)) = (origin_host.parse::<Authority>(), host.parse::<Authority>()) else {
        return false;
    };
    let default_port = if secure { 443 } else { 80 };
    let port = |authority: &Authority| {
        if authority.port().is_some() { authority.port_u16() } else { Some(default_port) }
    };
    origin.host().eq_ignore_ascii_case(host.host()) && port(&origin).is_some() && port(&origin) == port(&host)
}

async fn route(shared: &Arc<Shared>, request: &Request, secure: bool) -> Response {
    match request.path.as_str() {
        "/api/info" => {
            let config = shared.config();
            let body = serde_json::json!({
                "name": config.computer_name,
                "version": config.app_version,
                "protocol": crate::protocol::PROTOCOL_VERSION,
                "secure": secure,
            });
            Response::new(200, "application/json", body.to_string().into_bytes()).header("Cache-Control", "no-store")
        }
        "/api/icon" => icon(shared, request).await,
        "/cmdpalm.crt" => {
            let der = shared.tls.read().unwrap_or_else(|p| p.into_inner()).as_ref().map(|id| id.ca_der.clone());
            match der {
                Some(der) => Response::new(200, "application/x-x509-ca-cert", der)
                    .header("Content-Disposition", "attachment; filename=\"CmdPalm.crt\"")
                    .header("Cache-Control", "no-store"),
                None => Response::text(404, "HTTPS is not available"),
            }
        }
        _ => static_file(&shared.config().web_root, request).await,
    }
}

async fn icon(shared: &Arc<Shared>, request: &Request) -> Response {
    if !shared.session_key_valid(request.query("k").unwrap_or_default()) {
        return Response::text(403, "Forbidden");
    }
    let Some(id) = request.query("id").filter(|id| !id.is_empty() && id.len() <= 512) else {
        return Response::text(400, "Missing app");
    };
    let requested: u32 = request.query("size").and_then(|s| s.parse().ok()).unwrap_or(128);
    let size = [64, 128, 256, 512].into_iter().find(|s| *s >= requested).unwrap_or(512);
    let key = (id.to_string(), size);
    let cached = shared.icons.lock().unwrap_or_else(|p| p.into_inner()).get(&key).cloned();
    let png = match cached {
        Some(png) => Some(png),
        None => {
            let delegate = shared.delegate.clone();
            let id = id.to_string();
            let fetched =
                tokio::task::spawn_blocking(move || delegate.app_icon(id, size)).await.ok().flatten().map(Arc::new);
            if let Some(png) = &fetched {
                let mut icons = shared.icons.lock().unwrap_or_else(|p| p.into_inner());
                if icons.len() >= ICON_CACHE_LIMIT {
                    icons.clear();
                }
                icons.insert(key, png.clone());
            }
            fetched
        }
    };
    match png {
        Some(png) => Response::new(200, "image/png", png).header("Cache-Control", "private, max-age=86400"),
        None => Response::text(404, "No icon"),
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Map a URL path to a file under `root`, refusing anything that could
/// escape it. `None` means "serve the app shell".
pub(crate) fn resolve_static(root: &Path, url_path: &str) -> Result<Option<PathBuf>, ()> {
    let mut path = root.to_path_buf();
    let mut last = "";
    for segment in url_path.split('/').filter(|s| !s.is_empty()) {
        if segment.starts_with('.') || segment.contains('\\') || segment.contains('\0') {
            return Err(());
        }
        path.push(segment);
        last = segment;
    }
    if last.is_empty() {
        return Ok(None);
    }
    Ok(Some(path))
}

const MISSING_CLIENT: &str = "<!doctype html><meta name=viewport content=\"width=device-width\"><title>CmdPalm</title>\
<body style=\"font:16px system-ui;padding:2rem\"><h1>CmdPalm</h1><p>The web client is missing from this build. \
Run <code>bun run build</code> in <code>web/</code>.</p>";

async fn static_file(root: &str, request: &Request) -> Response {
    let root = Path::new(root);
    let not_found = || Response::text(404, "Not found");
    let file = match resolve_static(root, &request.path) {
        Ok(file) => file,
        Err(()) => return not_found(),
    };
    let index = root.join("index.html");
    let (path, shell) = match file {
        Some(path) if tokio::fs::metadata(&path).await.map(|m| m.is_file()).unwrap_or(false) => (path, false),
        // Unknown extension-less paths are client-side routes.
        Some(path) if path.extension().is_none() => (index, true),
        Some(_) => return not_found(),
        None => (index, true),
    };
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return if shell {
            Response::new(200, "text/html; charset=utf-8", MISSING_CLIENT.as_bytes().to_vec())
        } else {
            not_found()
        };
    };
    let modified =
        metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    let etag = format!("\"{:x}-{:x}\"", metadata.len(), modified);
    // The app shell can be served for a missing path under /assets/, and must
    // never be cached as if it were a hashed file.
    let hashed = !shell && request.path.starts_with("/assets/");
    let cache = if hashed { "public, max-age=31536000, immutable" } else { "no-cache" };
    if request.header("if-none-match") == Some(etag.as_str()) {
        return Response::new(304, content_type(&path), Vec::new()).header("ETag", etag).header("Cache-Control", cache);
    }
    match tokio::fs::read(&path).await {
        Ok(body) => {
            let mut response =
                Response::new(200, content_type(&path), body).header("ETag", etag).header("Cache-Control", cache);
            if path.file_name().is_some_and(|n| n == "sw.js") {
                response = response.header("Service-Worker-Allowed", "/");
            }
            response
        }
        Err(_) => not_found(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_heads() {
        let request = parse_head(b"GET /api/icon?id=com.apple.Safari&size=128&k=a%2Bb HTTP/1.1\r\nHost: Mac.local:8790\r\nConnection: Upgrade, keep-alive\r\n").unwrap();
        assert_eq!(request.path, "/api/icon");
        assert_eq!(request.query("id"), Some("com.apple.Safari"));
        assert_eq!(request.query("k"), Some("a+b"));
        assert_eq!(request.header("host"), Some("Mac.local:8790"));
        assert!(request.header_has_token("connection", "upgrade"));
        assert!(request.keep_alive());
        assert!(parse_head(b"GET / SPDY/3\r\n").is_none());
        assert!(parse_head(b"GET / HTTP/1.1\r\nHost: mac.local\r\nHost: evil.example\r\n").is_none());
        assert!(
            parse_head(b"GET / HTTP/1.1\r\nHost: mac.local\r\nContent-Length: 0\r\ncontent-length: 40\r\n").is_none()
        );
        assert_eq!(percent_decode("%41%2b"), Some("A+".into()));
        assert_eq!(percent_decode("%+1"), None, "a sign is not a hex digit");
    }

    #[test]
    fn rejects_ambiguous_http_syntax_and_normalizes_only_default_origin_ports() {
        for head in [
            "GET / HTTP/1.1 extra\r\nHost: mac.local",
            "GET / HTTP/1.9\r\nHost: mac.local",
            "GET http://mac.local/ HTTP/1.1\r\nHost: mac.local",
            "GET / HTTP/1.1\r\nHost : mac.local",
            "GET / HTTP/1.1\r\nX-Forwarded-Host\t: mac.local",
            "GET / HTTP/1.1\r\nBad(Name: value",
            "GET / HTTP/1.1\r\nX-Test: a\nb",
        ] {
            assert!(parse_head(head.as_bytes()).is_none(), "{head:?}");
        }
        assert!(same_origin("https://mac.local", "mac.local:443", true));
        assert!(same_origin("http://mac.local:80", "MAC.local", false));
        assert!(same_origin("https://[::1]", "[::1]:443", true));
        for origin in [
            "http://mac.local",
            "https://mac.local:80",
            "https://mac.local.evil",
            "https://mac.local/path",
            "https://evil@mac.local",
            "null",
        ] {
            assert!(!same_origin(origin, "mac.local:443", true), "{origin}");
        }
    }

    #[test]
    fn static_paths_cannot_escape_the_root() {
        let root = Path::new("/srv/web");
        assert_eq!(resolve_static(root, "/"), Ok(None));
        assert_eq!(resolve_static(root, "/assets/app.js"), Ok(Some(PathBuf::from("/srv/web/assets/app.js"))));
        assert_eq!(resolve_static(root, "/../etc/passwd"), Err(()));
        let decoded = parse_head(b"GET /assets/..%2F..%2Fsecret HTTP/1.1\r\n").unwrap();
        assert_eq!(resolve_static(root, &decoded.path), Err(()), "decoded traversal is rejected");
        assert_eq!(resolve_static(root, "/.git/config"), Err(()));
    }

    #[test]
    fn websocket_upgrades_require_same_origin() {
        let base = "GET /ws HTTP/1.1\r\nHost: mac.local:8790\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
        let ok = parse_head(format!("{base}Origin: http://mac.local:8790\r\n").as_bytes()).unwrap();
        assert_eq!(websocket_accept(&ok, "mac.local:8790", false).unwrap(), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        let evil = parse_head(format!("{base}Origin: https://evil.example\r\n").as_bytes()).unwrap();
        assert_eq!(websocket_accept(&evil, "mac.local:8790", false).unwrap_err().status, 403);
        let head = parse_head(base.replacen("GET", "HEAD", 1).as_bytes()).unwrap();
        assert_eq!(websocket_accept(&head, "mac.local:8790", false).unwrap_err().status, 405);
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_http_writes_time_out() {
        use std::pin::Pin;
        use std::task::{Context, Poll};

        struct StalledWrite(std::io::Cursor<Vec<u8>>);
        impl AsyncRead for StalledWrite {
            fn poll_read(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                buf: &mut tokio::io::ReadBuf<'_>,
            ) -> Poll<std::io::Result<()>> {
                Pin::new(&mut self.0).poll_read(cx, buf)
            }
        }
        impl AsyncWrite for StalledWrite {
            fn poll_write(self: Pin<&mut Self>, _cx: &mut Context<'_>, _buf: &[u8]) -> Poll<std::io::Result<usize>> {
                Poll::Pending
            }
            fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
                Poll::Pending
            }
            fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
                Poll::Ready(Ok(()))
            }
        }

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<!doctype html>").unwrap();
        let config = crate::api::HostConfig {
            port: 0,
            data_dir: String::new(),
            web_root: dir.path().to_string_lossy().into(),
            host_name: "Test.local".into(),
            computer_name: "Test".into(),
            app_version: "1.0.0".into(),
            link_host: crate::api::LinkHost::HostName,
            allow_local_proxy: false,
            allow_pin: true,
            allow_approval: true,
            allow_shell: false,
            voice_available: false,
        };
        struct Noop;
        impl crate::api::HostDelegate for Noop {
            fn on_event(&self, _: crate::api::HostEvent) {}
            fn list_apps(&self) -> Vec<crate::protocol::AppEntry> {
                Vec::new()
            }
            fn app_icon(&self, _: String, _: u32) -> Option<Vec<u8>> {
                None
            }
            fn app_action(&self, _: String, _: crate::protocol::AppOp) -> bool {
                false
            }
            fn open_url(&self, _: String) -> bool {
                false
            }
            fn native(&self, _: crate::api::NativeCommand) -> bool {
                false
            }
            fn run_shortcut(&self, _: String) -> bool {
                false
            }
            fn set_volume(&self, _: Option<f32>, _: Option<bool>) {}
            fn clipboard_text(&self) -> Option<String> {
                None
            }
            fn set_clipboard_text(&self, _: String) {}
            fn begin_paste(&self, _: String) -> bool {
                false
            }
            fn end_paste(&self) {}
            fn voice_start(&self, _: u64, _: Option<String>, _: Option<u32>) -> bool {
                false
            }
            fn voice_audio(&self, _: u64, _: Vec<u8>) {}
            fn voice_stop(&self, _: u64, _: bool) {}
        }
        let engine = crate::input::InputEngine::spawn(|| crate::input::NullSink, Box::new(|_| {}));
        let shared = Arc::new(Shared::new(config, Arc::new(Noop), &engine, Box::new(|| true)));
        let (_tx, rx) = watch::channel(false);

        let get = StalledWrite(std::io::Cursor::new(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec()));
        assert!(
            timeout(
                Duration::from_secs(30),
                serve(shared.clone(), get, IpAddr::V4(Ipv4Addr::LOCALHOST), false, rx.clone())
            )
            .await
            .is_ok(),
            "a stalled HTTP response write must time out and release its connection"
        );

        let ws = StalledWrite(std::io::Cursor::new(
            b"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ************************\r\n\r\n".to_vec(),
        ));
        assert!(
            timeout(Duration::from_secs(30), serve(shared, ws, IpAddr::V4(Ipv4Addr::LOCALHOST), false, rx))
                .await
                .is_ok(),
            "a stalled WebSocket handshake write must time out and release its connection"
        );
    }
}
