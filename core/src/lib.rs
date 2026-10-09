//! CmdPalm host core.
//!
//! The Mac app embeds this crate as a static library. It runs the local web
//! server the phone connects to, handles pairing, and turns client messages
//! into macOS input events. Everything that needs AppKit (apps, icons, volume,
//! speech, clipboard) is delegated back to Swift through [`api::HostDelegate`].

uniffi::setup_scaffolding!();

mod actions;
pub mod api;
pub mod auth;
pub mod deck;
pub mod host;
pub mod input;
pub mod keycodes;
mod prefs;
pub mod protocol;
mod server;
mod session;
mod store;
pub mod tls;

pub use api::{HostConfig, HostDelegate, HostError, HostEvent};
pub use host::CoreHost;

/// Version of the core library, for diagnostics.
#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Route `tracing` output to stderr (and so to Console.app via the app's
/// log capture). `filter` uses `RUST_LOG` syntax, e.g. `info,cmdpalm_core=debug`.
#[uniffi::export]
pub fn init_logging(filter: String) {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_new(&filter).unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_target(false).with_ansi(false).try_init();
}

#[cfg(test)]
mod tests;
