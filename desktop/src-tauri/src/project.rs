//! Native project open: a host-run folder dialog picks the active project root.
//!
//! Security model:
//! - The dialog is opened by the host (`rfd`), never by the webview, so no dialog
//!   plugin permission and no fs scope is granted to the page. The page can only
//!   ask "open a project"/"open recent #n"; it never supplies a path.
//! - The chosen folder is canonicalised, then refused if it is too broad
//!   (mirrors `isTooBroadRoot` + `isTooBroadTrustRoot` in
//!   `extension/core/broad-root.mjs`, so the desktop and the server agree).
//! - The accepted root is stored in process state and is the ONE root that
//!   `graph_file::project_root` (and so `read_graph_file`) uses.
//! - Recent projects: bounded list of root paths in the app data dir; no secrets.
//!   Entries are re-validated on every load/open, so a hand-edited file cannot
//!   widen access.
//! - Commands return only the chosen root and its display name.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// Most recent projects remembered.
pub const MAX_RECENT: usize = 10;
/// A recent-projects file larger than this is ignored.
const RECENT_FILE_MAX_BYTES: u64 = 64 * 1024;
/// Display names are capped (tray label, UI).
const NAME_MAX_CHARS: usize = 60;

static ACTIVE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The root accepted through `project_open*`, if any.
pub fn active_root() -> Option<PathBuf> {
    ACTIVE.lock().ok().and_then(|g| g.clone())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProjectInfo {
    pub name: String,
    pub root: String,
}

// ---- breadth rules (mirror of extension/core/broad-root.mjs) ----------------------------

/// Normalises a canonical path to forward slashes and strips the Windows verbatim
/// prefix (`\\?\C:\x` -> `C:/x`, `\\?\UNC\srv\share` -> `//srv/share`).
fn normalise(p: &str) -> String {
    let w = p.replace('\\', "/");
    if let Some(rest) = w.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    if let Some(rest) = w.strip_prefix("//?/") {
        return rest.to_string();
    }
    w
}

fn segments(w: &str) -> Vec<&str> {
    w.split('/').filter(|s| !s.is_empty()).collect()
}

fn is_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

const HOME_CONTAINERS: [&str; 8] =
    ["documents", "desktop", "downloads", "library", "movies", "music", "pictures", "public"];
const SYSTEM_TOPS: [&str; 9] =
    ["etc", "usr", "var", "bin", "sbin", "system", "library", "private", "opt"];

const SENSITIVE_SYSTEM_TREES: [&str; 4] = ["proc", "dev", "sys", "boot"];
const SECRET_HOME_DIRS: [&str; 3] = [".ssh", ".aws", ".gnupg"];

/// True when `real` (a canonical path) is too broad to be a project root: `/`, the
/// home directory, system trees, volumes, other users' homes, temp dirs, home
/// containers (Documents/Desktop/Downloads...), Windows drive/system/users trees and
/// UNC share roots. A project INSIDE a container (`~/Desktop/proj`) is fine.
/// `home` is the canonical home directory, when known.
pub fn is_too_broad(real: &str, home: Option<&str>) -> bool {
    if real.is_empty() {
        return true;
    }
    let w = normalise(real);
    let segs = segments(&w);
    let lower: Vec<String> = segs.iter().map(|s| s.to_lowercase()).collect();
    let norm = lower.join("/");
    let home_norm = home.map(|h| {
        segments(&normalise(h)).iter().map(|s| s.to_lowercase()).collect::<Vec<_>>().join("/")
    });

    // isTooBroadRoot
    if w == "/" || segs.len() <= 1 {
        return true;
    }
    if let Some(hn) = &home_norm {
        if !hn.is_empty() && &norm == hn {
            return true;
        }
    }
    if segs.len() <= 2 && !w.starts_with("//") && SYSTEM_TOPS.contains(&lower[0].as_str()) {
        // The JS list is case-sensitive ('/System', '/Library'); lower-casing is the
        // stricter reading and only matters on case-insensitive filesystems.
        return true;
    }

    // Credential and kernel trees (mirror of `inSensitiveTree` in broad-root.mjs).
    if SENSITIVE_SYSTEM_TREES.contains(&lower[0].as_str()) {
        return true;
    }
    if segs.len() == 1 && lower[0] == "root" {
        return true;
    }
    if lower.len() <= 6 && lower.len() >= 3 && lower[0] == "private" && lower[1] == "var" && lower[2] == "folders" {
        return true; // per-user temp roots themselves, not projects inside them
    }
    if let Some(hn) = &home_norm {
        if !hn.is_empty() {
            if let Some(rest) = norm.strip_prefix(&format!("{hn}/")) {
                let first = rest.split('/').next().unwrap_or("");
                if SECRET_HOME_DIRS.contains(&first) || (rest == ".config") {
                    return true;
                }
            }
        }
    }

    // isTooBroadTrustRoot
    if w.starts_with("//") && segs.len() <= 2 {
        return true; // UNC server or server/share root
    }
    if is_drive(segs[0]) {
        match lower[1].as_str() {
            "users" if segs.len() <= 3 => return true,
            "windows" => return true,
            "program files" | "program files (x86)" | "programdata" if segs.len() == 2 => {
                return true
            }
            _ => {}
        }
    }
    let top = lower[0].as_str();
    if top == "system" {
        return true;
    }
    if top == "volumes" && segs.len() <= 2 {
        return true;
    }
    if (top == "users" || top == "home") && segs.len() <= 2 {
        return true;
    }
    if ["tmp", "var/tmp", "private/tmp", "private/var/tmp"].contains(&norm.as_str()) {
        return true;
    }
    if let Some(hn) = &home_norm {
        if !hn.is_empty() {
            if let Some(rest) = norm.strip_prefix(&format!("{hn}/")) {
                if !rest.contains('/') && HOME_CONTAINERS.contains(&rest) {
                    return true;
                }
            }
        }
    }
    if (top == "users" || top == "home") && segs.len() == 3 && HOME_CONTAINERS.contains(&lower[2].as_str())
    {
        return true;
    }
    false
}

pub(crate) fn home_dir() -> Option<String> {
    let h = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let h = PathBuf::from(h);
    Some(std::fs::canonicalize(&h).unwrap_or(h).to_string_lossy().into_owned())
}

/// Canonicalises `chosen`, requires a directory, and refuses too-broad roots.
pub fn validate_root(chosen: &Path) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(chosen)
        .map_err(|e| format!("cannot resolve the chosen folder: {e}"))?;
    if !real.is_dir() {
        return Err("the chosen path is not a folder".into());
    }
    let s = real.to_string_lossy();
    if s.contains('\0') || is_too_broad(&s, home_dir().as_deref()) {
        return Err("that folder is too broad to open as a project; pick a project folder".into());
    }
    Ok(real)
}

fn display_name(root: &Path) -> String {
    let n = root.file_name().and_then(|n| n.to_str()).unwrap_or("project");
    n.chars().filter(|c| !c.is_control()).take(NAME_MAX_CHARS).collect()
}

fn info(root: &Path) -> ProjectInfo {
    ProjectInfo { name: display_name(root), root: root.to_string_lossy().into_owned() }
}

// ---- recent list --------------------------------------------------------------------------

/// Puts `new` first, drops duplicates, keeps at most `max`.
pub fn push_recent(list: &[String], new: &str, max: usize) -> Vec<String> {
    let mut out = vec![new.to_string()];
    out.extend(list.iter().filter(|p| p.as_str() != new).cloned());
    out.truncate(max);
    out
}

/// Parses the stored JSON array, ignoring non-strings, and caps its length.
pub fn parse_recent(json: &str, max: usize) -> Vec<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(json)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .take(max)
        .collect()
}

fn recent_file(dir: &Path) -> PathBuf {
    dir.join("recent-projects.json")
}

fn load_recent(dir: &Path) -> Vec<String> {
    let f = recent_file(dir);
    match std::fs::metadata(&f) {
        Ok(m) if m.is_file() && m.len() <= RECENT_FILE_MAX_BYTES => {
            parse_recent(&std::fs::read_to_string(&f).unwrap_or_default(), MAX_RECENT)
        }
        _ => Vec::new(),
    }
}

fn save_recent(dir: &Path, list: &[String]) -> Result<(), String> {
    crate::fsutil::private_dir(dir)?;
    let body = serde_json::to_string(list).map_err(|e| e.to_string())?;
    crate::fsutil::write_private_atomic(&recent_file(dir), body.as_bytes(), RECENT_FILE_MAX_BYTES as usize)
}

/// Recent entries that still validate (exist, are folders, not too broad).
fn valid_recent(dir: &Path) -> Vec<PathBuf> {
    load_recent(dir).iter().filter_map(|p| validate_root(Path::new(p)).ok()).collect()
}

/// Accepts `chosen` as the active root and records it as most recent.
fn activate(dir: &Path, chosen: &Path) -> Result<ProjectInfo, String> {
    let root = validate_root(chosen)?;
    let list = push_recent(&load_recent(dir), &root.to_string_lossy(), MAX_RECENT);
    // A failed history write must not block opening the project.
    if let Err(e) = save_recent(dir, &list) {
        eprintln!("project: recent list not saved: {e}");
    }
    if let Ok(mut g) = ACTIVE.lock() {
        *g = Some(root.clone());
    }
    Ok(info(&root))
}

// ---- commands -------------------------------------------------------------------------------

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Opens the native folder dialog; `None` when the user cancels.
#[tauri::command]
pub async fn project_open(app: tauri::AppHandle) -> Result<Option<ProjectInfo>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Open project folder")
        .pick_folder()
        .await;
    let Some(handle) = picked else { return Ok(None) };
    let info = activate(&data_dir(&app)?, handle.path())?;
    crate::tray::set_project_label(&app, Some(&info.name));
    Ok(Some(info))
}

/// Re-opens recent project `index` (as listed by `project_recent`).
#[tauri::command]
pub fn project_open_recent(app: tauri::AppHandle, index: usize) -> Result<ProjectInfo, String> {
    let dir = data_dir(&app)?;
    let list = valid_recent(&dir);
    let chosen = list.get(index).ok_or("no such recent project")?;
    let info = activate(&dir, chosen)?;
    crate::tray::set_project_label(&app, Some(&info.name));
    Ok(info)
}

#[tauri::command]
pub fn project_active() -> Option<ProjectInfo> {
    active_root().map(|r| info(&r))
}

#[tauri::command]
pub fn project_recent(app: tauri::AppHandle) -> Result<Vec<ProjectInfo>, String> {
    Ok(valid_recent(&data_dir(&app)?).iter().map(|r| info(r)).collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn credential_and_kernel_trees_match_the_server_list() {
        let h = Some("/Users/alice");
        for p in [
            "/Users/alice/.ssh", "/Users/alice/.ssh/keys", "/Users/alice/.aws", "/Users/alice/.gnupg/x",
            "/Users/alice/.config", "/proc", "/proc/1", "/dev", "/sys/kernel", "/boot", "/root",
            "/private/var/folders/ab/cdef", "/private/var/folders/ab/cdef/T",
        ] {
            assert!(is_too_broad(p, h), "{p} must be too broad");
        }
        for p in ["/Users/alice/.config/nvim", "/root/proj", "/private/var/folders/ab/cdef/T/proj"] {
            assert!(!is_too_broad(p, h), "{p} must be allowed");
        }
    }

    use super::*;
    use std::fs;

    const HOME: Option<&str> = Some("/Users/alice");

    fn broad(p: &str) -> bool {
        is_too_broad(p, HOME)
    }

    #[test]
    fn refuses_root_home_and_system_trees() {
        for p in ["/", "/Users", "/home", "/etc", "/usr", "/var", "/opt", "/private", "/Library", "/System",
                  "/System/Library", "/usr/local", "/Users/alice", "/Volumes", "/Volumes/disk", "/tmp",
                  "/private/tmp", "/var/tmp", "/Users/bob", "/home/bob", "/System/Volumes/Data"] {
            assert!(broad(p), "{p} must be too broad");
        }
    }

    #[test]
    fn refuses_home_containers_and_other_users_containers() {
        for p in ["/Users/alice/Documents", "/Users/alice/Desktop", "/Users/alice/Downloads",
                  "/Users/alice/Library", "/Users/alice/public", "/Users/bob/Documents", "/home/bob/Desktop"] {
            assert!(broad(p), "{p} must be too broad");
        }
    }

    #[test]
    fn allows_projects_inside_containers() {
        for p in ["/Users/alice/Desktop/LLM", "/Users/alice/code/app", "/Volumes/disk/proj",
                  "/home/bob/work/app", "/srv/app", "/opt/tools/proj", "/Users/alice/Documents/a"] {
            assert!(!broad(p), "{p} must be allowed");
        }
    }

    #[test]
    fn refuses_windows_trees_and_unc_roots() {
        for p in ["C:\\", "C:", "C:\\Users", "C:\\Users\\alice", "C:\\Windows", "C:\\Windows\\System32",
                  "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData",
                  "\\\\?\\C:\\Users\\alice", "\\\\srv\\share", "\\\\?\\UNC\\srv\\share", "\\\\srv"] {
            assert!(is_too_broad(p, Some("C:\\Users\\alice")), "{p} must be too broad");
        }
        for p in ["C:\\work\\app", "\\\\?\\C:\\Users\\alice\\code\\app", "\\\\srv\\share\\proj"] {
            assert!(!is_too_broad(p, Some("C:\\Users\\alice")), "{p} must be allowed");
        }
    }

    #[test]
    fn home_comparison_is_case_insensitive_and_empty_is_broad() {
        assert!(is_too_broad("/users/ALICE", HOME));
        assert!(is_too_broad("", HOME));
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-proj-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn validate_rejects_files_missing_and_root() {
        let d = scratch("v");
        let f = d.join("a.txt");
        fs::write(&f, "x").unwrap();
        assert!(validate_root(&f).is_err());
        assert!(validate_root(&d.join("nope")).is_err());
        assert!(validate_root(Path::new("/")).is_err());
        let proj = d.join("proj");
        fs::create_dir_all(&proj).unwrap();
        assert_eq!(validate_root(&proj).unwrap(), proj);
    }

    #[cfg(unix)]
    #[test]
    fn validate_canonicalises_symlinks_before_breadth_check() {
        let d = scratch("sl");
        std::os::unix::fs::symlink("/", d.join("rootlink")).unwrap();
        assert!(validate_root(&d.join("rootlink")).is_err());
    }

    #[test]
    fn recent_list_is_bounded_deduped_and_most_recent_first() {
        let mut l: Vec<String> = Vec::new();
        for i in 0..25 {
            l = push_recent(&l, &format!("/p/{i}"), MAX_RECENT);
        }
        assert_eq!(l.len(), MAX_RECENT);
        assert_eq!(l[0], "/p/24");
        l = push_recent(&l, "/p/20", MAX_RECENT);
        assert_eq!(l[0], "/p/20");
        assert_eq!(l.iter().filter(|p| *p == "/p/20").count(), 1);
        assert_eq!(l.len(), MAX_RECENT);
    }

    #[test]
    fn parse_recent_ignores_garbage_and_caps() {
        assert!(parse_recent("not json", 10).is_empty());
        assert_eq!(parse_recent("[1,\"/a\",null,\"/b\"]", 10), vec!["/a", "/b"]);
        let many = serde_json::to_string(&(0..50).map(|i| format!("/p/{i}")).collect::<Vec<_>>()).unwrap();
        assert_eq!(parse_recent(&many, MAX_RECENT).len(), MAX_RECENT);
    }

    #[test]
    fn activate_sets_root_persists_recent_and_revalidates() {
        let dir = scratch("data");
        let proj = scratch("act").join("proj");
        fs::create_dir_all(&proj).unwrap();
        let info = activate(&dir, &proj).unwrap();
        assert_eq!(info.name, "proj");
        assert_eq!(active_root().unwrap(), fs::canonicalize(&proj).unwrap());
        assert_eq!(valid_recent(&dir).len(), 1);
        // a hand-edited recent file naming "/" is dropped on load
        fs::write(recent_file(&dir), "[\"/\",\"/nonexistent-xyz\"]").unwrap();
        assert!(valid_recent(&dir).is_empty());
        // oversized file is ignored
        fs::write(recent_file(&dir), vec![b' '; 70 * 1024]).unwrap();
        assert!(load_recent(&dir).is_empty());
        // a too-broad pick is refused and leaves the active root unchanged
        assert!(activate(&dir, Path::new("/")).is_err());
        assert_eq!(active_root().unwrap(), fs::canonicalize(&proj).unwrap());
    }

    #[test]
    fn display_name_is_capped_and_clean() {
        let long = format!("/x/{}", "a".repeat(200));
        assert_eq!(display_name(Path::new(&long)).chars().count(), NAME_MAX_CHARS);
    }
}
