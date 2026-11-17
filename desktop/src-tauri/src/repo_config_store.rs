//! The saved repository list, kept as `repo-config.json` in the desktop data dir.
//!
//! Why a host file: the list used to live only in webview localStorage, which is lost when the webview's
//! storage is lost or when dev and packaged builds use different origins. The host file is the source of
//! truth; the webview copies it into localStorage at start-up.
//!
//! The file holds app configuration only (repositories, allowed operations, paths). Git and provider tokens
//! never go here: they stay in the core vault.

use std::path::{Path, PathBuf};

use crate::confirm::herr;
use crate::fs_ops::FsError;

pub const FILE_NAME: &str = "repo-config.json";
/// Larger than any realistic list (50 repositories per provider), small enough to refuse a runaway write.
pub const MAX_BYTES: usize = 256 * 1024;

fn file_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// The config must be a JSON object; the webview's decoder reads anything else as the defaults.
fn is_object(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).is_ok_and(|v| v.is_object())
}

/// `None` when the file does not exist yet. A file that is a symlink, too large or not a JSON object is refused
/// rather than read, so the webview keeps its own copy instead of replacing it with something unreadable.
pub fn load_in(dir: &Path) -> Result<Option<String>, FsError> {
    let path = file_in(dir);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(herr("io", format!("cannot read the saved repository list: {e}"))),
    };
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return Err(herr("repo_config_invalid", "the saved repository list is not readable"));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| herr("io", format!("cannot read the saved repository list: {e}")))?;
    if !is_object(&text) {
        return Err(herr("repo_config_invalid", "the saved repository list is not a JSON object"));
    }
    Ok(Some(text))
}

/// Replaces the file atomically (temp file, then rename, 0600). A refused write leaves the previous file.
pub fn save_in(dir: &Path, json: &str) -> Result<(), FsError> {
    if json.len() > MAX_BYTES {
        return Err(herr("repo_config_too_large", "the saved repository list is too large"));
    }
    if !is_object(json) {
        return Err(herr("repo_config_invalid", "the saved repository list must be a JSON object"));
    }
    crate::fsutil::private_dir(dir).map_err(|e| herr("io", e))?;
    crate::fsutil::write_private_atomic(&file_in(dir), json.as_bytes(), MAX_BYTES).map_err(|e| herr("io", e))
}

fn data_dir() -> Result<PathBuf, FsError> {
    let dir = crate::fsutil::desktop_data_dir().map_err(|e| herr("io", e))?;
    // An explicit data folder on a missing drive must not be recreated on another disk (see fsutil).
    crate::fsutil::data_root_available(&dir).map_err(|e| herr("io", e))?;
    Ok(dir)
}

/// Keeps the blocking file work off the command thread.
#[tauri::command]
pub async fn repo_config_load() -> Result<Option<String>, FsError> {
    tauri::async_runtime::spawn_blocking(|| load_in(&data_dir()?))
        .await
        .map_err(|e| herr("io", format!("repository list task failed: {e}")))?
}

#[tauri::command]
pub async fn repo_config_save(json: String) -> Result<(), FsError> {
    tauri::async_runtime::spawn_blocking(move || save_in(&data_dir()?, &json))
        .await
        .map_err(|e| herr("io", format!("repository list task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique folder under the system temp dir, removed on drop so a failing test leaves nothing behind.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!("llmide-repo-config-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            Self(p)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_missing_file_reads_as_none() {
        let s = Scratch::new("missing");
        assert_eq!(load_in(&s.0).unwrap(), None);
    }

    #[test]
    fn save_then_load_round_trips_the_text() {
        let s = Scratch::new("roundtrip");
        let body = r#"{"primary":null,"saved":{"gitlab":[],"github":[]}}"#;
        save_in(&s.0, body).unwrap();
        assert_eq!(load_in(&s.0).unwrap().as_deref(), Some(body));
    }

    #[test]
    fn only_a_json_object_is_accepted_in_either_direction() {
        let s = Scratch::new("shape");
        for bad in ["[]", "\"text\"", "not json", "null", ""] {
            assert!(save_in(&s.0, bad).is_err(), "{bad:?} must not be saved");
        }
        save_in(&s.0, "{}").unwrap();
        std::fs::write(file_in(&s.0), "[1,2]").unwrap();
        assert!(load_in(&s.0).is_err(), "a non-object file on disk is refused, not read as defaults");
    }

    #[test]
    fn an_oversized_write_is_refused_and_the_old_file_stays() {
        let s = Scratch::new("big");
        save_in(&s.0, "{}").unwrap();
        let big = format!("{{\"pad\":\"{}\"}}", "x".repeat(MAX_BYTES));
        assert!(save_in(&s.0, &big).is_err());
        assert_eq!(load_in(&s.0).unwrap().as_deref(), Some("{}"));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("perm");
        save_in(&s.0, "{}").unwrap();
        assert_eq!(std::fs::metadata(file_in(&s.0)).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_never_followed() {
        let s = Scratch::new("link");
        std::fs::create_dir_all(&s.0).unwrap();
        let target = s.0.join("elsewhere.json");
        std::fs::write(&target, "{\"secret\":true}").unwrap();
        std::os::unix::fs::symlink(&target, file_in(&s.0)).unwrap();
        assert!(load_in(&s.0).is_err());
    }
}
