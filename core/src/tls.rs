//! HTTPS for the local server.
//!
//! Browsers only allow the microphone (and installable web apps) on secure
//! origins, so the server also speaks TLS on the same port. CmdPalm creates a
//! private certificate authority once and issues a short-lived server
//! certificate for the Mac's current names and addresses. Installing the CA
//! on the phone (served at `/cmdpalm.crt`) removes the browser warning.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rcgen::{
    BasicConstraints, CertificateParams, CidrSubnet, DistinguishedName, DnType, ExtendedKeyUsagePurpose,
    GeneralSubtree, IsCa, Issuer, KeyPair, KeyUsagePurpose, NameConstraints,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use tokio_rustls::rustls::{self, pki_types};

use crate::store;

/// Apple rejects trusted server certificates valid for more than 398 days.
const LEAF_DAYS: i64 = 397;
const RENEW_BEFORE_DAYS: i64 = 30;
const CA_YEARS: i64 = 10;

/// The only names the authority may vouch for. The CA is installed as a root
/// on phones, so these constraints keep its key from being usable against
/// public websites if it ever leaked from the Mac.
const PERMITTED_DOMAINS: [&str; 2] = ["local", "localhost"];
const PERMITTED_V4: [([u8; 4], u8); 6] = [
    ([10, 0, 0, 0], 8),
    ([172, 16, 0, 0], 12),
    ([192, 168, 0, 0], 16),
    // Carrier-grade NAT, used by Tailscale and some mobile hotspots.
    ([100, 64, 0, 0], 10),
    ([169, 254, 0, 0], 16),
    ([127, 0, 0, 0], 8),
];

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("certificate error: {0}")]
    Rcgen(#[from] rcgen::Error),
    #[error("TLS error: {0}")]
    Rustls(#[from] rustls::Error),
    #[error("could not save the certificate: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Meta {
    ca_name: String,
    ca_expires: i64,
    leaf_names: Vec<String>,
    leaf_expires: i64,
}

pub struct Identity {
    pub config: Arc<rustls::ServerConfig>,
    /// DER-encoded CA certificate for installing on devices.
    pub ca_der: Vec<u8>,
    /// SHA-256 fingerprint of the CA, as colon-separated hex.
    pub ca_fingerprint: String,
}

struct Paths {
    meta: PathBuf,
    ca_key: PathBuf,
    ca_cert: PathBuf,
    leaf_key: PathBuf,
    leaf_cert: PathBuf,
}

impl Paths {
    fn new(dir: &Path) -> Self {
        Self {
            meta: dir.join("tls.json"),
            ca_key: dir.join("ca-key.pem"),
            ca_cert: dir.join("ca.der"),
            leaf_key: dir.join("server-key.pem"),
            leaf_cert: dir.join("server.der"),
        }
    }
}

fn ca_params(name: &str, expires: OffsetDateTime) -> CertificateParams {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, name);
    dn.push(DnType::OrganizationName, "CmdPalm");
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
    params.name_constraints = Some(NameConstraints {
        permitted_subtrees: PERMITTED_DOMAINS
            .iter()
            .map(|domain| GeneralSubtree::DnsName(domain.to_string()))
            .chain(PERMITTED_V4.iter().map(|(network, prefix)| {
                GeneralSubtree::IpAddress(CidrSubnet::V4(*network, (u32::MAX << (32 - prefix)).to_be_bytes()))
            }))
            .collect(),
        excluded_subtrees: vec![],
    });
    params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
    params.not_after = expires;
    params
}

/// Whether the authority's name constraints allow `name`.
fn permitted(name: &str) -> bool {
    match name.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => PERMITTED_V4.iter().any(|(network, prefix)| {
            let mask = u32::MAX << (32 - prefix);
            u32::from(ip) & mask == u32::from_be_bytes(*network)
        }),
        Ok(IpAddr::V6(_)) => false,
        Err(_) => PERMITTED_DOMAINS.iter().any(|domain| name == *domain || name.ends_with(&format!(".{domain}"))),
    }
}

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Names the server certificate must cover: the Bonjour name, localhost and
/// every current LAN address the authority is allowed to vouch for.
pub fn server_names(host_name: &str, addresses: &[IpAddr]) -> Vec<String> {
    let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    let host = host_name.trim().trim_end_matches('.');
    if !host.is_empty() {
        names.push(host.to_ascii_lowercase());
    }
    names.extend(addresses.iter().map(IpAddr::to_string));
    names.retain(|name| permitted(name));
    names.sort();
    names.dedup();
    names
}

/// Load or create the CA and a server certificate covering `names`.
pub fn load_identity(dir: &Path, names: &[String]) -> Result<Identity, TlsError> {
    let paths = Paths::new(dir);
    let now = OffsetDateTime::now_utc();
    let renew_cutoff = (now + Duration::days(RENEW_BEFORE_DAYS)).unix_timestamp();

    let mut meta = store::load::<Meta>(&paths.meta);
    let ca_key = std::fs::read_to_string(&paths.ca_key).ok().and_then(|pem| KeyPair::from_pem(&pem).ok());
    let ca_der = std::fs::read(&paths.ca_cert).ok();

    let (ca_key, ca_der, mut current) = match (ca_key, ca_der, meta.take()) {
        (Some(key), Some(der), Some(meta)) if meta.ca_expires > renew_cutoff => (key, der, meta),
        _ => {
            let key = KeyPair::generate()?;
            let suffix = &crate::auth::random_token(4)[..4];
            let name = format!("CmdPalm Local Authority {suffix}");
            let expires = now + Duration::days(365 * CA_YEARS);
            let cert = ca_params(&name, expires).self_signed(&key)?;
            store::save_bytes(&paths.ca_key, key.serialize_pem().as_bytes())?;
            store::save_bytes(&paths.ca_cert, cert.der())?;
            let meta =
                Meta { ca_name: name, ca_expires: expires.unix_timestamp(), leaf_names: vec![], leaf_expires: 0 };
            (key, cert.der().to_vec(), meta)
        }
    };

    let leaf_key = std::fs::read_to_string(&paths.leaf_key).ok().and_then(|pem| KeyPair::from_pem(&pem).ok());
    let leaf_der = std::fs::read(&paths.leaf_cert).ok();
    let (leaf_key, leaf_der) = match (leaf_key, leaf_der) {
        (Some(key), Some(der)) if current.leaf_names == names && current.leaf_expires > renew_cutoff => (key, der),
        _ => {
            let key = KeyPair::generate()?;
            let mut params = CertificateParams::new(names.to_vec())?;
            let mut dn = DistinguishedName::new();
            dn.push(
                DnType::CommonName,
                names.iter().find(|n| n.ends_with(".local")).cloned().unwrap_or_else(|| "CmdPalm".into()),
            );
            params.distinguished_name = dn;
            params.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
            params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
            params.use_authority_key_identifier_extension = true;
            params.not_before = now - Duration::days(1);
            let expires = now + Duration::days(LEAF_DAYS);
            params.not_after = expires;
            let issuer = Issuer::new(
                ca_params(&current.ca_name, OffsetDateTime::from_unix_timestamp(current.ca_expires).unwrap_or(expires)),
                &ca_key,
            );
            let cert = params.signed_by(&key, &issuer)?;
            store::save_bytes(&paths.leaf_key, key.serialize_pem().as_bytes())?;
            store::save_bytes(&paths.leaf_cert, cert.der())?;
            current.leaf_names = names.to_vec();
            current.leaf_expires = expires.unix_timestamp();
            (key, cert.der().to_vec())
        }
    };
    store::save(&paths.meta, &current)?;

    let chain = vec![pki_types::CertificateDer::from(leaf_der), pki_types::CertificateDer::from(ca_der.clone())];
    let key = pki_types::PrivateKeyDer::Pkcs8(pki_types::PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(chain, key)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];

    Ok(Identity { config: Arc::new(config), ca_fingerprint: fingerprint(&ca_der), ca_der })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn reuses_the_authority_and_reissues_for_new_addresses() {
        let dir = tempfile::tempdir().unwrap();
        let names = server_names("Studio.local.", &[IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5))]);
        assert!(names.contains(&"studio.local".to_string()));

        let first = load_identity(dir.path(), &names).unwrap();
        let leaf_before = std::fs::read(dir.path().join("server.der")).unwrap();
        let again = load_identity(dir.path(), &names).unwrap();
        assert_eq!(first.ca_fingerprint, again.ca_fingerprint);
        assert_eq!(leaf_before, std::fs::read(dir.path().join("server.der")).unwrap());

        let moved = server_names("Studio.local", &[IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9))]);
        let third = load_identity(dir.path(), &moved).unwrap();
        assert_eq!(first.ca_fingerprint, third.ca_fingerprint, "devices keep trusting the same CA");
        assert_ne!(leaf_before, std::fs::read(dir.path().join("server.der")).unwrap());
    }

    #[test]
    fn covers_only_names_the_authority_may_vouch_for() {
        let addresses = [
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)),
            IpAddr::V4(Ipv4Addr::new(172, 31, 0, 2)),
            IpAddr::V4(Ipv4Addr::new(100, 101, 2, 3)),
            IpAddr::V4(Ipv4Addr::new(172, 32, 0, 2)),
            IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
        ];
        assert_eq!(
            server_names("Studio.local", &addresses),
            ["100.101.2.3", "127.0.0.1", "172.31.0.2", "192.168.1.5", "localhost", "studio.local"]
        );
        assert!(!server_names("studio.example.com", &[]).contains(&"studio.example.com".to_string()));
        assert!(!permitted("notlocal"));
    }
}
