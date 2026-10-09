//! Each paired device's phone settings, kept on the Mac so they survive a
//! cleared browser and can be copied to another device. The Mac stores them
//! as opaque JSON; only the phone app understands their contents.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store;

pub const MAX_SETTINGS_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSettings {
    pub settings: serde_json::Value,
    /// Milliseconds since 1970, set by the phone when the user changed something.
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    version: u32,
    id: String,
    #[serde(flatten)]
    saved: SavedSettings,
}

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum SettingsError {
    #[error("Settings must be an object.")]
    NotAnObject,
    #[error("These settings are too large to keep on the Mac.")]
    TooLarge,
}

#[derive(Default)]
pub struct DeviceSettings {
    dir: Option<PathBuf>,
    devices: HashMap<String, SavedSettings>,
}

impl DeviceSettings {
    pub fn load(dir: Option<PathBuf>) -> Self {
        let mut devices = HashMap::new();
        if let Some(entries) = dir.as_ref().and_then(|dir| fs::read_dir(dir).ok()) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "json")
                    && let Some(file) = store::load::<SettingsFile>(&path)
                    && file.version == 1
                    && path == file_path(dir.as_ref().unwrap(), &file.id)
                {
                    devices.insert(file.id, file.saved);
                }
            }
        }
        Self { dir, devices }
    }

    pub fn get(&self, id: &str) -> Option<&SavedSettings> {
        self.devices.get(id)
    }

    /// Keep `saved` for `id` unless the Mac already has newer settings.
    /// Returns whether anything changed.
    pub fn set(&mut self, id: &str, saved: SavedSettings) -> Result<bool, SettingsError> {
        if !saved.settings.is_object() {
            return Err(SettingsError::NotAnObject);
        }
        let size = serde_json::to_vec(&saved.settings).map(|v| v.len()).unwrap_or(usize::MAX);
        if size > MAX_SETTINGS_BYTES {
            return Err(SettingsError::TooLarge);
        }
        if self.devices.get(id).is_some_and(|old| old.updated_at > saved.updated_at || *old == saved) {
            return Ok(false);
        }
        if let Some(dir) = &self.dir {
            let file = SettingsFile { version: 1, id: id.to_string(), saved: saved.clone() };
            if let Err(err) = store::save(&file_path(dir, id), &file) {
                tracing::error!(%err, "could not save device settings");
            }
        }
        self.devices.insert(id.to_string(), saved);
        Ok(true)
    }

    pub fn remove(&mut self, id: &str) {
        if self.devices.remove(id).is_some()
            && let Some(dir) = &self.dir
        {
            let _ = fs::remove_file(file_path(dir, id));
        }
    }

    /// Forget settings of devices that are no longer paired.
    pub fn retain(&mut self, paired: &[String]) {
        let stale: Vec<String> = self.devices.keys().filter(|id| !paired.contains(id)).cloned().collect();
        for id in stale {
            self.remove(&id);
        }
    }
}

/// Device IDs come from the phone, so the file name is a hash of the ID
/// rather than the ID itself.
fn file_path(dir: &std::path::Path, id: &str) -> PathBuf {
    let digest = Sha256::digest(id.as_bytes());
    let name: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{name}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn saved(value: serde_json::Value, updated_at: u64) -> SavedSettings {
        SavedSettings { settings: value, updated_at }
    }

    #[test]
    fn keeps_the_newest_settings_per_device_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings");
        let mut store = DeviceSettings::load(Some(path.clone()));
        assert_eq!(store.set("phone", saved(json!({"theme": "dark"}), 10)), Ok(true));
        assert_eq!(store.set("phone", saved(json!({"theme": "light"}), 5)), Ok(false), "older copies lose");
        assert_eq!(
            store.set("phone", saved(json!({"theme": "dark"}), 10)),
            Ok(false),
            "identical copies are not rewritten"
        );
        assert_eq!(store.set("tablet", saved(json!({}), 1)), Ok(true));

        let mut store = DeviceSettings::load(Some(path.clone()));
        assert_eq!(store.get("phone").unwrap().settings, json!({"theme": "dark"}));
        store.retain(&["phone".to_string()]);
        assert!(store.get("tablet").is_none());
        store.remove("phone");
        assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
    }

    #[test]
    fn rejects_non_objects_and_oversized_settings() {
        let mut store = DeviceSettings::load(None);
        assert_eq!(store.set("a", saved(json!([1, 2]), 1)), Err(SettingsError::NotAnObject));
        let big = "x".repeat(MAX_SETTINGS_BYTES);
        assert_eq!(store.set("a", saved(json!({ "k": big }), 1)), Err(SettingsError::TooLarge));
        assert!(store.get("a").is_none());
    }
}
