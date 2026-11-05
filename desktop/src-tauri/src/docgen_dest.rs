//! Persistent Doc Gen output folder, chosen only through the host's folder picker.
//!
//! The webview never supplies an absolute path. The chosen directory is stored in the app's private data dir
//! (0600) and every save is a single, sanitized filename inside it. A save never follows a symlink and never
//! overwrites a file without the hash returned by the previous write.
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::chat_hash::Sha256;
use crate::fs_ops::FsError;

const FILE: &str = "docgen-destination.json";
const MAX_BYTES: usize = 64 * 1024 * 1024;

static DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    pub name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSaved {
    /// Display name only; the webview never receives a path.
    pub name: String,
    pub hash: String,
    pub size: usize,
}

#[derive(Deserialize, Serialize)]
struct Stored {
    dir: String,
}

fn config_path() -> Option<PathBuf> {
    let base = crate::fsutil::desktop_data_dir().ok()?;
    let dir = crate::fsutil::private_dir(&base).ok()?;
    Some(dir.join(FILE))
}

fn load() -> Option<PathBuf> {
    let text = std::fs::read_to_string(config_path()?).ok()?;
    let stored: Stored = serde_json::from_str(&text).ok()?;
    let path = PathBuf::from(stored.dir);
    path.is_dir().then_some(path)
}

fn state() -> &'static Mutex<Option<PathBuf>> {
    DIR.get_or_init(|| Mutex::new(load()))
}

fn current() -> Option<PathBuf> {
    let mut slot = state().lock().ok()?;
    if slot.is_none() { *slot = load(); }
    slot.clone()
}

fn set_current(path: Option<&Path>) -> Result<(), String> {
    let mut slot = state().lock().map_err(|_| "destination state unavailable".to_string())?;
    match path {
        Some(p) => {
            let body = serde_json::to_vec(&Stored { dir: p.to_string_lossy().into_owned() }).map_err(|e| e.to_string())?;
            if let Some(file) = config_path() { crate::fsutil::write_private_atomic(&file, &body, 4096)?; }
            *slot = Some(p.to_path_buf());
        }
        None => {
            if let Some(file) = config_path() { let _ = std::fs::remove_file(file); }
            *slot = None;
        }
    }
    Ok(())
}

fn name_of(path: &Path) -> String {
    path.file_name().and_then(|n| n.to_str()).map(str::to_string).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn safe_name(raw: &str) -> Result<String, FsError> {
    let mut out: String = raw.chars().filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != ':').collect();
    out = out.trim().trim_start_matches('.').trim().to_string();
    if out.is_empty() { out = "document".into(); }
    if !out.to_ascii_lowercase().ends_with(".md") { out.push_str(".md"); }
    let out: String = out.chars().take(160).collect();
    if out == "." || out == ".." { return Err(FsError { code: "invalid_path", message: "invalid file name".into() }); }
    Ok(out)
}

fn hash_file(path: &Path) -> Result<String, FsError> {
    let bytes = std::fs::read(path).map_err(|e| FsError { code: "io", message: format!("cannot read {path:?}: {e}") })?;
    let mut h = Sha256::new(); h.update(&bytes); Ok(h.finish_hex())
}

fn write_one(dir: &Path, name: &str, text: &str, expected_hash: Option<&str>) -> Result<ExternalSaved, FsError> {
    if text.len() > MAX_BYTES { return Err(FsError { code: "too_large", message: "the document is too large to save".into() }); }
    if !dir.is_dir() { return Err(FsError { code: "not_found", message: "the chosen output folder is missing".into() }); }
    let name = safe_name(name)?;
    let target = dir.join(&name);
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() { return Err(FsError { code: "invalid_path", message: "refusing to write through a symlink".into() }); }
        if expected_hash.is_none() { return Err(FsError { code: "exists", message: "a file with that name exists".into() }); }
    }
    if let Some(expected) = expected_hash {
        let actual = hash_file(&target)?;
        if actual != expected { return Err(FsError { code: "conflict", message: "the file changed on disk".into() }); }
    }
    let partial = target.with_extension("md.partial");
    std::fs::write(&partial, text.as_bytes()).map_err(|e| FsError { code: "io", message: format!("cannot write the document: {e}") })?;
    std::fs::rename(&partial, &target).map_err(|e| FsError { code: "io", message: format!("cannot install the document: {e}") })?;
    let hash = hash_file(&target)?;
    Ok(ExternalSaved { name, hash, size: text.len() })
}

#[tauri::command]
pub async fn docgen_destination_status() -> Result<Option<Destination>, FsError> {
    Ok(current().map(|p| Destination { name: name_of(&p) }))
}

#[tauri::command]
pub async fn docgen_destination_pick() -> Result<Option<Destination>, FsError> {
    let Some(folder) = rfd::AsyncFileDialog::new().set_title("Choose output folder").pick_folder().await else { return Ok(None); };
    let path = folder.path().to_path_buf();
    let canonical = std::fs::canonicalize(&path).map_err(|e| FsError { code: "not_found", message: format!("cannot use that folder: {e}") })?;
    if !canonical.is_dir() { return Err(FsError { code: "invalid_path", message: "choose a folder".into() }); }
    set_current(Some(&canonical)).map_err(|e| FsError { code: "io", message: e })?;
    Ok(Some(Destination { name: name_of(&canonical) }))
}

#[tauri::command]
pub async fn docgen_destination_clear() -> Result<(), FsError> {
    set_current(None).map_err(|e| FsError { code: "io", message: e })
}

#[tauri::command]
pub async fn docgen_save_external(name: String, text: String, expected_hash: Option<String>) -> Result<ExternalSaved, FsError> {
    let dir = current().ok_or_else(|| FsError { code: "no_destination", message: "choose an output folder first".into() })?;
    write_one(&dir, &name, &text, expected_hash.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-docgen-dest-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&d).unwrap(); d
    }

    #[test]
    fn names_are_single_plain_markdown_files() {
        assert_eq!(safe_name("a/b:c").unwrap(), "abc.md");
        assert_eq!(safe_name("..").unwrap(), "document.md");
        assert_eq!(safe_name("plan.MD").unwrap(), "plan.MD");
    }

    #[test]
    fn writes_are_create_only_then_compare_and_swap() {
        let d = tmp();
        let a = write_one(&d, "x", "one", None).unwrap();
        assert_eq!(a.name, "x.md");
        assert!(write_one(&d, "x", "two", None).is_err(), "new save never overwrites");
        let b = write_one(&d, "x", "two", Some(&a.hash)).unwrap();
        assert_ne!(a.hash, b.hash);
        assert!(write_one(&d, "x", "three", Some(&a.hash)).is_err(), "stale hash is a conflict");
        assert_eq!(fs::read_to_string(d.join("x.md")).unwrap(), "two");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn a_symlink_target_is_refused() {
        let d = tmp();
        let outside = d.join("outside.md"); fs::write(&outside, "keep").unwrap();
        #[cfg(unix)] std::os::unix::fs::symlink(&outside, d.join("link.md")).unwrap();
        #[cfg(unix)] assert!(write_one(&d, "link", "x", None).is_err());
        fs::remove_dir_all(&d).unwrap();
    }
}
