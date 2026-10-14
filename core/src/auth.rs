//! Pairing and trusted devices.
//!
//! A device proves itself once — with the one-time code in the QR shown on
//! the Mac, the six-digit PIN, or by being approved at the Mac — and receives
//! a random token. Only a SHA-256 hash of each token is stored. The PIN only
//! works while the Mac shows it, and failed attempts are rate limited per
//! address (per /64 for IPv6) and globally.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::protocol::DeviceInfo;
use crate::store;

pub const CODE_LIFETIME: Duration = Duration::from_secs(10 * 60);
const MAX_FAILURES_PER_ADDRESS: u32 = 5;
const FIRST_LOCKOUT: Duration = Duration::from_secs(30);
const MAX_LOCKOUT: Duration = Duration::from_secs(15 * 60);
const GLOBAL_WINDOW: Duration = Duration::from_secs(60);
const GLOBAL_MAX_FAILURES: usize = 20;
const MAX_DECLINES_PER_ADDRESS: u32 = 3;
/// How long failures from an address count toward its next lockout.
const FAILURE_MEMORY: Duration = Duration::from_secs(60 * 60);
/// How long the PIN still works after the Mac stops showing it.
const PIN_GRACE: Duration = Duration::from_secs(3 * 60);
const MAX_DEVICES: usize = 64;
const MAX_TRACKED_ADDRESSES: usize = 1024;
const LAST_SEEN_SAVE_INTERVAL: i64 = 60 * 60;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct TrustedDevice {
    pub id: String,
    pub name: String,
    pub model: String,
    /// Unix seconds.
    pub paired_at: i64,
    pub last_seen: i64,
    pub last_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDevice {
    #[serde(flatten)]
    device: TrustedDevice,
    token_hash: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustFile {
    version: u32,
    devices: Vec<StoredDevice>,
}

pub struct TrustStore {
    path: Option<PathBuf>,
    devices: Vec<StoredDevice>,
}

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compare without short-circuiting so timing does not reveal a prefix match.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rng().fill(&mut buf[..]);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Invisible formatting characters (zero-width, bidi overrides) would let a
/// device name or model look like something else in pairing prompts.
fn is_invisible(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}')
}

/// Text from a device, safe to show on the Mac.
pub(crate) fn clean(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control() && !is_invisible(*c)).take(max).collect::<String>().trim().to_string()
}

impl TrustStore {
    pub fn load(path: Option<PathBuf>) -> Self {
        let devices = path.as_deref().and_then(store::load::<TrustFile>).map(|file| file.devices).unwrap_or_default();
        Self { path, devices }
    }

    fn save(&self) {
        if let Some(path) = &self.path {
            let file = TrustFile { version: 1, devices: self.devices.clone() };
            if let Err(err) = store::save(path, &file) {
                tracing::error!(%err, "could not save trusted devices");
            }
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.devices.iter().any(|d| d.device.id == id)
    }

    pub fn devices(&self) -> Vec<TrustedDevice> {
        let mut list: Vec<_> = self.devices.iter().map(|d| d.device.clone()).collect();
        list.sort_by_key(|d| std::cmp::Reverse(d.last_seen));
        list
    }

    /// Trust `info` and return its new token. Re-pairing a known device
    /// replaces its old token.
    pub fn issue(&mut self, info: &DeviceInfo, address: IpAddr) -> String {
        let token = random_token(32);
        let now = unix_now();
        self.devices.retain(|d| d.device.id != info.id);
        if self.devices.len() >= MAX_DEVICES
            && let Some(oldest) =
                self.devices.iter().enumerate().min_by_key(|(_, d)| d.device.last_seen).map(|(i, _)| i)
        {
            self.devices.remove(oldest);
        }
        self.devices.push(StoredDevice {
            device: TrustedDevice {
                id: clean(&info.id, 128),
                name: display_name(info),
                model: clean(&info.model, 64),
                paired_at: now,
                last_seen: now,
                last_address: address.to_string(),
            },
            token_hash: hash_token(&token),
        });
        self.save();
        token
    }

    /// Check a reconnecting device's token and refresh its details.
    pub fn verify(&mut self, info: &DeviceInfo, token: &str, address: IpAddr) -> Option<TrustedDevice> {
        let hash = hash_token(token);
        let device = self
            .devices
            .iter_mut()
            .find(|d| constant_time_eq(d.token_hash.as_bytes(), hash.as_bytes()) && d.device.id == info.id)?;
        let now = unix_now();
        let address = address.to_string();
        // Saving syncs to disk, which can take a while; skip it when only the
        // last-seen time moved a little. The in-memory value stays current.
        let mut changed =
            now - device.device.last_seen >= LAST_SEEN_SAVE_INTERVAL || device.device.last_address != address;
        device.device.last_seen = now;
        device.device.last_address = address;
        let name = display_name(info);
        if !name.is_empty() && device.device.name != name && !device_was_renamed(&device.device) {
            device.device.name = name;
            changed = true;
        }
        let found = device.device.clone();
        if changed {
            self.save();
        }
        Some(found)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|d| d.device.id != id);
        let removed = self.devices.len() != before;
        if removed {
            self.save();
        }
        removed
    }

    pub fn rename(&mut self, id: &str, name: &str) -> bool {
        let Some(device) = self.devices.iter_mut().find(|d| d.device.id == id) else {
            return false;
        };
        device.device.name = format!("{RENAMED_MARK}{}", clean(name, 64));
        self.save();
        true
    }

    pub fn clear(&mut self) {
        self.devices.clear();
        self.save();
    }
}

/// Names set on the Mac are marked so the device's own name never overrides
/// them. The mark is stripped before display.
const RENAMED_MARK: &str = "\u{200B}";

fn device_was_renamed(device: &TrustedDevice) -> bool {
    device.name.starts_with(RENAMED_MARK)
}

pub fn visible_name(name: &str) -> String {
    name.trim_start_matches(RENAMED_MARK).to_string()
}

fn display_name(info: &DeviceInfo) -> String {
    let name = clean(&info.name, 64);
    if name.is_empty() { "Unnamed device".into() } else { name }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Accepted,
    Rejected,
    /// Too many failures; retry after this long.
    Locked(Duration),
    /// The PIN isn't on screen on the Mac, so it can't be entered.
    Closed,
}

#[derive(Default)]
struct Failures {
    count: u32,
    lockouts: u32,
    locked_until: Option<Instant>,
    last: Option<Instant>,
}

impl Failures {
    /// Count one failure; returns the lockout when this one triggers it.
    /// After a quiet hour the count starts over, so occasional typos days
    /// apart don't add up to ever longer lockouts.
    fn add(&mut self, limit: u32, now: Instant) -> Option<Duration> {
        let quiet = self.last.is_some_and(|last| now.duration_since(last) >= FAILURE_MEMORY);
        if quiet && self.locked(now).is_none() {
            *self = Self::default();
        }
        self.last = Some(now);
        self.count += 1;
        if self.count < limit {
            return None;
        }
        let lockout = FIRST_LOCKOUT.saturating_mul(1 << self.lockouts.min(10)).min(MAX_LOCKOUT);
        self.lockouts += 1;
        self.count = 0;
        self.locked_until = Some(now + lockout);
        Some(lockout)
    }

    fn locked(&self, now: Instant) -> Option<Duration> {
        let until = self.locked_until?;
        (until > now).then(|| until - now)
    }
}

/// One machine can hold any number of IPv6 addresses in its /64, so
/// failures are counted per /64 there.
pub(crate) fn throttle_key(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(Ipv6Addr::from(v6.to_bits() & !((1u128 << 64) - 1))),
        },
        v4 => v4,
    }
}

/// One-time pairing code, rotating PIN, and failure throttling.
pub struct Pairing {
    code: String,
    pin: String,
    issued: Instant,
    failures: HashMap<IpAddr, Failures>,
    recent_failures: Vec<Instant>,
    declined: HashMap<IpAddr, Failures>,
    pin_shown: bool,
    pin_open_until: Option<Instant>,
}

impl Pairing {
    pub fn new(now: Instant) -> Self {
        let mut pairing = Self {
            code: String::new(),
            pin: String::new(),
            issued: now,
            failures: HashMap::new(),
            recent_failures: Vec::new(),
            declined: HashMap::new(),
            pin_shown: false,
            pin_open_until: None,
        };
        pairing.rotate(now);
        pairing
    }

    /// The Mac reports whether the PIN is on screen. It is accepted while it
    /// is, and for a short while after, so nobody can guess it unseen.
    pub fn set_pin_shown(&mut self, shown: bool, now: Instant) {
        if self.pin_shown && !shown {
            self.pin_open_until = Some(now + PIN_GRACE);
        }
        self.pin_shown = shown;
    }

    fn pin_open(&self, now: Instant) -> bool {
        self.pin_shown || self.pin_open_until.is_some_and(|until| until > now)
    }

    pub fn rotate(&mut self, now: Instant) {
        self.code = random_token(18);
        self.rotate_pin();
        self.issued = now;
    }

    fn rotate_pin(&mut self) {
        let mut rng = rand::rng();
        self.pin = loop {
            let pin = format!("{:06}", rng.random_range(0..1_000_000u32));
            let digits = pin.as_bytes();
            let all_same = digits.iter().all(|d| *d == digits[0]);
            let sequential = digits.windows(2).all(|w| w[1] == w[0] + 1) || digits.windows(2).all(|w| w[0] == w[1] + 1);
            if !all_same && !sequential {
                break pin;
            }
        };
    }

    /// Rotate if the current code expired. Returns true when it changed.
    pub fn refresh(&mut self, now: Instant) -> bool {
        if now.duration_since(self.issued) >= CODE_LIFETIME {
            self.rotate(now);
            return true;
        }
        false
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn pin(&self) -> &str {
        &self.pin
    }

    pub fn expires_in(&self, now: Instant) -> Duration {
        CODE_LIFETIME.saturating_sub(now.duration_since(self.issued))
    }

    pub fn locked(&mut self, address: IpAddr, now: Instant) -> Option<Duration> {
        self.recent_failures.retain(|at| now.duration_since(*at) < GLOBAL_WINDOW);
        if self.recent_failures.len() >= GLOBAL_MAX_FAILURES {
            let oldest = self.recent_failures[0];
            return Some(GLOBAL_WINDOW.saturating_sub(now.duration_since(oldest)).max(Duration::from_secs(1)));
        }
        self.failures.get(&throttle_key(address))?.locked(now)
    }

    /// Approval requests from an address that keeps getting declined (or
    /// ignored) wait before they can ask again.
    pub fn approval_locked(&mut self, address: IpAddr, now: Instant) -> Option<Duration> {
        if let Some(wait) = self.locked(address, now) {
            return Some(wait);
        }
        self.declined.get(&throttle_key(address))?.locked(now)
    }

    pub fn approval_declined(&mut self, address: IpAddr, now: Instant) {
        if self.declined.len() >= MAX_TRACKED_ADDRESSES {
            self.declined.retain(|_, f| f.locked(now).is_some());
        }
        self.declined.entry(throttle_key(address)).or_default().add(MAX_DECLINES_PER_ADDRESS, now);
    }

    /// The QR code is too long to guess, so a wrong one is never counted as
    /// a failure, and PIN guessing elsewhere can't block pairing by QR code.
    pub fn check_code(&mut self, code: &str, now: Instant) -> Verdict {
        self.refresh(now);
        if !code.is_empty() && constant_time_eq(code.as_bytes(), self.code.as_bytes()) {
            self.rotate(now);
            return Verdict::Accepted;
        }
        Verdict::Rejected
    }

    pub fn check_pin(&mut self, pin: &str, address: IpAddr, now: Instant) -> Verdict {
        let pin: String = pin.chars().filter(|c| c.is_ascii_digit()).collect();
        // Nothing can be learned while the PIN is hidden, so this isn't
        // counted as a guess.
        if !self.pin_open(now) {
            return Verdict::Closed;
        }
        self.prune(now);
        if let Some(wait) = self.locked(address, now) {
            return Verdict::Locked(wait);
        }
        if self.refresh(now) {
            // The code the device saw has expired.
            return self.fail(address, now);
        }
        if !pin.is_empty() && constant_time_eq(pin.as_bytes(), self.pin.as_bytes()) {
            self.failures.remove(&throttle_key(address));
            // Codes are single use.
            self.rotate(now);
            return Verdict::Accepted;
        }
        self.fail(address, now)
    }

    fn fail(&mut self, address: IpAddr, now: Instant) -> Verdict {
        self.recent_failures.push(now);
        let entry = self.failures.entry(throttle_key(address)).or_default();
        if let Some(lockout) = entry.add(MAX_FAILURES_PER_ADDRESS, now) {
            // A wrong guess against a locked PIN reveals nothing, but rotate
            // anyway so a slow attacker cannot keep guessing the same PIN. The
            // QR code stays, so the code on screen keeps working.
            self.rotate_pin();
            return Verdict::Locked(lockout);
        }
        Verdict::Rejected
    }

    /// Forget addresses that aren't locked out once many are tracked, so the
    /// table can't grow without bound. The global limit still applies.
    fn prune(&mut self, now: Instant) {
        if self.failures.len() < MAX_TRACKED_ADDRESSES {
            return;
        }
        self.failures.retain(|_, f| f.locked(now).is_some());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn device(id: &str) -> DeviceInfo {
        DeviceInfo { id: id.into(), name: "Alex’s iPhone".into(), model: "iPhone".into() }
    }

    const PHONE: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
    const OTHER: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 21));

    #[test]
    fn tokens_are_hashed_and_verified_per_device() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.json");
        let mut trust = TrustStore::load(Some(path.clone()));
        let token = trust.issue(&device("a"), PHONE);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains(&token), "raw tokens must never be stored");

        let mut trust = TrustStore::load(Some(path));
        assert!(trust.verify(&device("a"), &token, PHONE).is_some());
        assert!(trust.verify(&device("b"), &token, PHONE).is_none(), "token is bound to its device");
        assert!(trust.verify(&device("a"), "nope", PHONE).is_none());

        let second = trust.issue(&device("a"), PHONE);
        assert!(trust.verify(&device("a"), &token, PHONE).is_none(), "re-pairing revokes the old token");
        assert!(trust.verify(&device("a"), &second, PHONE).is_some());

        assert!(trust.remove("a"));
        assert!(trust.verify(&device("a"), &second, PHONE).is_none());
    }

    #[test]
    fn renamed_devices_keep_their_mac_side_name() {
        let mut trust = TrustStore::load(None);
        let token = trust.issue(&device("a"), PHONE);
        trust.rename("a", "Kitchen iPad");
        let found = trust.verify(&device("a"), &token, PHONE).unwrap();
        assert_eq!(visible_name(&found.name), "Kitchen iPad");
    }

    #[test]
    fn codes_are_single_use() {
        let now = Instant::now();
        let mut pairing = Pairing::new(now);
        let code = pairing.code().to_string();
        let pin = pairing.pin().to_string();
        assert_eq!(pin.len(), 6);
        assert_eq!(pairing.check_code(&code, now), Verdict::Accepted);
        assert_eq!(pairing.check_code(&code, now), Verdict::Rejected);
        assert_ne!(pairing.pin(), pin, "PIN rotates after pairing");
    }

    fn shown(now: Instant) -> Pairing {
        let mut pairing = Pairing::new(now);
        pairing.set_pin_shown(true, now);
        pairing
    }

    #[test]
    fn pin_works_only_while_shown_and_shortly_after() {
        let now = Instant::now();
        let mut pairing = Pairing::new(now);
        let pin = pairing.pin().to_string();
        assert_eq!(pairing.check_pin(&pin, PHONE, now), Verdict::Closed);
        assert_eq!(pairing.check_pin("000000", PHONE, now), Verdict::Closed);
        assert!(pairing.locked(PHONE, now).is_none(), "hidden-PIN attempts aren't counted");

        pairing.set_pin_shown(true, now);
        pairing.set_pin_shown(false, now);
        let soon = now + PIN_GRACE - Duration::from_secs(1);
        assert_eq!(pairing.check_pin(&pin, PHONE, soon), Verdict::Accepted);

        let later = now + PIN_GRACE + Duration::from_secs(1);
        let pin = pairing.pin().to_string();
        assert_eq!(pairing.check_pin(&pin, PHONE, later), Verdict::Closed);
    }

    #[test]
    fn ipv6_failures_are_counted_per_prefix() {
        let now = Instant::now();
        let mut pairing = shown(now);
        for i in 0..MAX_FAILURES_PER_ADDRESS {
            let address: IpAddr = format!("2001:db8:1:2::{:x}", i + 1).parse().unwrap();
            pairing.check_pin("000000", address, now);
        }
        let fresh: IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
        assert!(matches!(pairing.check_pin("000000", fresh, now), Verdict::Locked(_)));
        let elsewhere: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        let pin = pairing.pin().to_string();
        assert_eq!(pairing.check_pin(&pin, elsewhere, now), Verdict::Accepted);
    }

    #[test]
    fn old_failures_are_forgotten() {
        let start = Instant::now();
        let mut failures = Failures::default();
        // A typo now and then never adds up to a lockout.
        for day in 0..10u64 {
            let at = start + Duration::from_secs(day * 24 * 60 * 60);
            assert_eq!(failures.add(MAX_FAILURES_PER_ADDRESS, at), None);
        }
        // A lockout escalates while guesses keep coming, then resets once quiet.
        let mut now = start + Duration::from_secs(30 * 24 * 60 * 60);
        let mut lockouts = Vec::new();
        for _ in 0..2 {
            for _ in 0..MAX_FAILURES_PER_ADDRESS {
                if let Some(lockout) = failures.add(MAX_FAILURES_PER_ADDRESS, now) {
                    lockouts.push(lockout);
                    now += lockout;
                }
            }
        }
        assert_eq!(lockouts, [FIRST_LOCKOUT, FIRST_LOCKOUT * 2]);
        now += FAILURE_MEMORY;
        for _ in 0..MAX_FAILURES_PER_ADDRESS - 1 {
            assert_eq!(failures.add(MAX_FAILURES_PER_ADDRESS, now), None);
        }
        assert_eq!(failures.add(MAX_FAILURES_PER_ADDRESS, now), Some(FIRST_LOCKOUT));
    }

    #[test]
    fn declined_approvals_back_off() {
        let now = Instant::now();
        let mut pairing = Pairing::new(now);
        for _ in 0..MAX_DECLINES_PER_ADDRESS {
            assert!(pairing.approval_locked(PHONE, now).is_none());
            pairing.approval_declined(PHONE, now);
        }
        assert_eq!(pairing.approval_locked(PHONE, now), Some(FIRST_LOCKOUT));
        assert!(pairing.approval_locked(OTHER, now).is_none());
        assert!(pairing.approval_locked(PHONE, now + FIRST_LOCKOUT).is_none());
    }

    #[test]
    fn device_text_drops_invisible_characters() {
        assert_eq!(clean("Al\u{202E}ex\u{200B}’s\nPhone\u{FEFF}", 64), "Alex’sPhone");
        assert_eq!(clean("  \u{200D} ", 64), "");
    }

    #[test]
    fn expired_codes_are_rejected() {
        let now = Instant::now();
        let mut pairing = shown(now);
        let pin = pairing.pin().to_string();
        let later = now + CODE_LIFETIME + Duration::from_secs(1);
        assert_eq!(pairing.check_pin(&pin, PHONE, later), Verdict::Rejected);
    }

    #[test]
    fn guessing_is_throttled_per_address_and_globally() {
        let now = Instant::now();
        let mut pairing = shown(now);
        for _ in 0..MAX_FAILURES_PER_ADDRESS - 1 {
            assert_eq!(pairing.check_pin("000000", PHONE, now), Verdict::Rejected);
        }
        assert_eq!(pairing.check_pin("000000", PHONE, now), Verdict::Locked(FIRST_LOCKOUT));
        let pin = pairing.pin().to_string();
        assert!(matches!(pairing.check_pin(&pin, PHONE, now), Verdict::Locked(_)), "locked even with the right PIN");
        assert_eq!(pairing.check_pin(&pin, OTHER, now), Verdict::Accepted, "other devices are unaffected");

        let after = now + FIRST_LOCKOUT;
        let pin = pairing.pin().to_string();
        assert_eq!(pairing.check_pin(&pin, PHONE, after), Verdict::Accepted);

        let mut pairing = shown(now);
        for i in 0..GLOBAL_MAX_FAILURES {
            let address = IpAddr::V4(Ipv4Addr::new(10, 0, (i / 250) as u8, (i % 250) as u8));
            pairing.check_pin("000000", address, now);
        }
        assert!(matches!(pairing.check_pin("000000", PHONE, now), Verdict::Locked(_)));
    }

    #[test]
    fn pins_avoid_trivial_patterns() {
        let now = Instant::now();
        let mut pairing = Pairing::new(now);
        for _ in 0..500 {
            pairing.rotate(now);
            assert_ne!(pairing.pin(), "123456");
            assert_ne!(pairing.pin(), "000000");
        }
    }
}
