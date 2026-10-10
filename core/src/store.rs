//! Small JSON files in the app's data directory, written atomically.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde::de::DeserializeOwned;

pub fn load<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            tracing::warn!(path = %path.display(), %err, "could not read file");
            return None;
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => Some(value),
        Err(err) => {
            // Keep the unreadable file for inspection instead of overwriting it.
            let backup = path.with_extension("corrupt.json");
            // serde's message can quote file contents, such as a deck snippet.
            let kind = format!("{:?}", err.classify());
            tracing::error!(path = %path.display(), kind, line = err.line(), column = err.column(), "ignoring corrupt file");
            let _ = fs::rename(path, backup);
            None
        }
    }
}

/// Write via a temporary file and rename so a crash never leaves a truncated
/// file. Files are private to the user because they may contain token hashes.
pub fn save<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    let tmp = temp_path(path);
    {
        let mut file = open_private(&tmp)?;
        file.write_all(&json)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

pub fn save_bytes(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = temp_path(path);
    {
        let mut file = open_private(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// A temporary name no other concurrent save uses, so two writers can never
/// interleave bytes in the same file before renaming it into place.
fn temp_path(path: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.{n}.tmp", std::process::id()));
    path.with_file_name(name)
}

fn open_private(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_quarantines_corrupt_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/value.json");
        save(&path, &vec![1, 2, 3]).unwrap();
        assert_eq!(load::<Vec<i32>>(&path), Some(vec![1, 2, 3]));

        fs::write(&path, b"{not json").unwrap();
        assert_eq!(load::<Vec<i32>>(&path), None);
        assert!(path.with_extension("corrupt.json").exists());
        assert!(!path.exists());
    }
}
