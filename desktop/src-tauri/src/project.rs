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
    // A watcher belongs to the root it was started for; its batches are relative to that old root.
    crate::fs_watch::stop_all();
    Ok(info(&root))
}

// ---- commands -------------------------------------------------------------------------------

fn data_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::fsutil::desktop_data_dir()
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

// ---- new project, close, recent management -------------------------------------------------

/// One entry of the recent list as the Welcome page shows it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RecentEntry {
    pub name: String,
    pub root: String,
    /// `ok`, `missing` (gone or not a folder, maybe an unmounted volume) or `refused` (too broad now).
    pub status: &'static str,
    /// Why an entry cannot be opened; plain text.
    pub reason: Option<String>,
    /// Index to pass to `project_open_recent` (only for `ok` entries).
    pub open_index: Option<usize>,
    /// Index in the stored list, for `project_forget_recent`.
    pub stored_index: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RecentList {
    pub entries: Vec<RecentEntry>,
    /// True when the stored list existed but could not be read (unreadable, oversized or not a list).
    pub reset: bool,
}

/// Raw list with a status per entry. Pure on a directory so it is testable.
pub fn recent_with_status(dir: &Path) -> RecentList {
    let f = recent_file(dir);
    let reset = match std::fs::metadata(&f) {
        Ok(m) if m.is_file() && m.len() <= RECENT_FILE_MAX_BYTES => {
            serde_json::from_str::<Vec<serde_json::Value>>(&std::fs::read_to_string(&f).unwrap_or_default()).is_err()
        }
        Ok(_) => true,
        Err(_) => false,
    };
    let mut open_index = 0usize;
    let entries = load_recent(dir)
        .into_iter()
        .enumerate()
        .map(|(stored_index, p)| {
            let path = Path::new(&p);
            match validate_root(path) {
                Ok(real) => {
                    let e = RecentEntry { name: display_name(&real), root: real.to_string_lossy().into_owned(), status: "ok", reason: None, open_index: Some(open_index), stored_index };
                    open_index += 1;
                    e
                }
                Err(err) => {
                    let (status, reason) = if !path.exists() {
                        let unmounted = path.components().nth(1).map(|c| c.as_os_str() == "Volumes").unwrap_or(false);
                        ("missing", if unmounted { "The volume is not mounted, or the folder was moved or deleted.".to_string() } else { "The folder was moved or deleted.".to_string() })
                    } else if err.contains("too broad") {
                        ("refused", "This folder is too broad to open as a project.".to_string())
                    } else {
                        ("missing", "This is no longer a folder.".to_string())
                    };
                    let name: String = path.file_name().and_then(|n| n.to_str()).unwrap_or("project").chars().filter(|c| !c.is_control()).take(NAME_MAX_CHARS).collect();
                    RecentEntry { name, root: p.chars().filter(|c| !c.is_control()).collect(), status, reason: Some(reason), open_index: None, stored_index }
                }
            }
        })
        .collect();
    RecentList { entries, reset }
}

/// Removes entry `index` from the stored list when it still names `root` (a stale index changes nothing).
/// Only the list is edited: no file or folder is touched.
pub fn forget_recent_in(dir: &Path, index: usize, root: &str) -> Result<bool, String> {
    let list = load_recent(dir);
    if list.get(index).map(String::as_str) != Some(root) {
        return Ok(false);
    }
    let mut next = list;
    next.remove(index);
    save_recent(dir, &next)?;
    Ok(true)
}

/// Clears the active project (the recent list is kept). Nothing on disk is touched.
fn deactivate() {
    if let Ok(mut g) = ACTIVE.lock() {
        *g = None;
    }
    crate::fs_watch::stop_all();
}

/// Recent projects with a status each, plus whether the stored list had to be ignored.
#[tauri::command]
pub fn project_recent_all(app: tauri::AppHandle) -> Result<RecentList, String> {
    Ok(recent_with_status(&data_dir(&app)?))
}

/// Drops one entry from the recent list (never deletes anything on disk). `false` when the list changed meanwhile.
#[tauri::command]
pub fn project_forget_recent(app: tauri::AppHandle, index: usize, root: String) -> Result<bool, String> {
    forget_recent_in(&data_dir(&app)?, index, &root)
}

/// Closes the active project: back to "no project". Never deletes or changes any file.
#[tauri::command]
pub fn project_close(app: tauri::AppHandle) {
    deactivate();
    crate::tray::set_project_label(&app, None);
}

/// New project: validates `name`, opens a host folder dialog for the PARENT, creates `<parent>/<name>`,
/// scaffolds it like the Mac app and makes it the active project. `None` when the user cancels.
#[tauri::command]
pub async fn project_create(app: tauri::AppHandle, name: String) -> Result<Option<ProjectInfo>, String> {
    let name = crate::project_scaffold::validate_name(&name)?;
    let picked = rfd::AsyncFileDialog::new()
        .set_title(format!("Choose where to create \"{name}\""))
        .pick_folder()
        .await;
    let Some(handle) = picked else { return Ok(None) };
    let root = crate::project_scaffold::create_project(handle.path(), &name)?;
    let info = activate(&data_dir(&app)?, &root)?;
    crate::tray::set_project_label(&app, Some(&info.name));
    Ok(Some(info))
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

    /// `ACTIVE` is process-global: tests that open projects take turns.
    static ACTIVE_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn activate_sets_root_persists_recent_and_revalidates() {
        let _turn = ACTIVE_TESTS.lock().unwrap_or_else(|p| p.into_inner());
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
    fn opening_a_project_stops_the_file_watcher_of_the_previous_one() {
        let _turn = ACTIVE_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("data-watch");
        let old = scratch("watch-old").join("proj");
        let new = scratch("watch-new").join("proj");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        activate(&dir, &old).unwrap();
        crate::fs_watch::install_for_test(&fs::canonicalize(&old).unwrap());
        assert!(crate::fs_watch::running());
        activate(&dir, &new).unwrap();
        assert!(!crate::fs_watch::running(), "the old root's watcher must not survive a project switch");
    }

    #[test]
    fn display_name_is_capped_and_clean() {
        let long = format!("/x/{}", "a".repeat(200));
        assert_eq!(display_name(Path::new(&long)).chars().count(), NAME_MAX_CHARS);
    }

    #[test]
    fn recent_status_marks_missing_and_refused_entries_and_numbers_open_indexes() {
        let dir = scratch("rs-data");
        let a = scratch("rs-a").join("alpha");
        let b = scratch("rs-b").join("beta");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let gone = scratch("rs-gone").join("gone");
        let list = vec![
            fs::canonicalize(&a).unwrap().to_string_lossy().into_owned(),
            gone.to_string_lossy().into_owned(),
            "/".to_string(),
            fs::canonicalize(&b).unwrap().to_string_lossy().into_owned(),
        ];
        save_recent(&dir, &list).unwrap();
        let r = recent_with_status(&dir);
        assert!(!r.reset);
        let st: Vec<_> = r.entries.iter().map(|e| e.status).collect();
        assert_eq!(st, ["ok", "missing", "refused", "ok"]);
        assert_eq!(r.entries.iter().map(|e| e.open_index).collect::<Vec<_>>(), [Some(0), None, None, Some(1)]);
        // the open index agrees with what project_open_recent resolves
        assert_eq!(valid_recent(&dir).len(), 2);
        assert_eq!(r.entries[3].name, "beta");
        assert!(r.entries[1].reason.as_deref().unwrap().contains("moved or deleted"));
        assert!(r.entries[2].reason.as_deref().unwrap().contains("too broad"));
        assert_eq!(r.entries.iter().map(|e| e.stored_index).collect::<Vec<_>>(), [0, 1, 2, 3]);
    }

    #[test]
    fn recent_reset_flag_covers_unreadable_oversized_and_non_list_files() {
        let dir = scratch("rs-reset");
        assert!(!recent_with_status(&dir).reset, "no file is not a reset");
        fs::write(recent_file(&dir), "{broken").unwrap();
        assert!(recent_with_status(&dir).reset);
        fs::write(recent_file(&dir), "{\"a\":1}").unwrap();
        assert!(recent_with_status(&dir).reset);
        fs::write(recent_file(&dir), vec![b' '; 70 * 1024]).unwrap();
        assert!(recent_with_status(&dir).reset);
        fs::write(recent_file(&dir), "[]").unwrap();
        assert!(!recent_with_status(&dir).reset);
    }

    #[test]
    fn forgetting_edits_the_list_only_and_ignores_stale_indexes() {
        let dir = scratch("rs-forget");
        let keep = scratch("rs-keep").join("proj");
        fs::create_dir_all(&keep).unwrap();
        fs::write(keep.join("data.txt"), "precious").unwrap();
        let root = fs::canonicalize(&keep).unwrap().to_string_lossy().into_owned();
        save_recent(&dir, &[root.clone(), "/p/other".to_string()]).unwrap();
        assert!(!forget_recent_in(&dir, 1, &root).unwrap(), "index names a different root: nothing changes");
        assert!(!forget_recent_in(&dir, 9, &root).unwrap());
        assert_eq!(load_recent(&dir).len(), 2);
        assert!(forget_recent_in(&dir, 0, &root).unwrap());
        assert_eq!(load_recent(&dir), vec!["/p/other".to_string()]);
        assert_eq!(fs::read_to_string(keep.join("data.txt")).unwrap(), "precious", "no file was touched");
    }

    #[test]
    fn closing_clears_the_active_root_and_keeps_the_recent_list() {
        let _turn = ACTIVE_TESTS.lock().unwrap_or_else(|p| p.into_inner());
        let dir = scratch("close-data");
        let proj = scratch("close").join("proj");
        fs::create_dir_all(&proj).unwrap();
        activate(&dir, &proj).unwrap();
        assert!(active_root().is_some());
        deactivate();
        assert!(active_root().is_none());
        assert_eq!(valid_recent(&dir).len(), 1);
        assert!(proj.is_dir());
    }
}
