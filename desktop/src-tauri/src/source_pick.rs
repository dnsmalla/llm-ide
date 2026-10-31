//! Folder picker for the Library's "Repositories" source (S-I).
//!
//! The core indexes a local git repository by ABSOLUTE path (`POST /auth/me/repos`, `/kb/connect-git`),
//! and the webview must not invent absolute paths. This command opens the native folder dialog, so the
//! path the page relays to the core is one the user just picked, canonicalised and checked against the
//! same too-broad list as the project root (`project::validate_root`: home, `/`, system folders). It
//! grants nothing by itself: the core's per-user allow-list is still the gate for indexing.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PickedFolder {
    pub path: String,
    pub name: String,
}

/// Validates a chosen folder (canonical, a directory, not too broad) into what the page may relay.
pub fn picked(chosen: &std::path::Path) -> Result<PickedFolder, String> {
    let real = crate::project::validate_root(chosen).map_err(|e| format!("invalid_root: {e}"))?;
    let name = real
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("folder")
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect();
    Ok(PickedFolder { path: real.to_string_lossy().into_owned(), name })
}

/// Opens the native folder dialog; `None` when cancelled.
#[tauri::command]
pub async fn source_pick_folder() -> Result<Option<PickedFolder>, String> {
    let Some(handle) = rfd::AsyncFileDialog::new().set_title("Choose a repository folder").pick_folder().await else {
        return Ok(None);
    };
    picked(handle.path()).map(Some)
}

// ---- neutral folder choice (Settings "Add folder") ----------------------------------------------
//
// `pick_folder` changes no state (not the open project, not the notes folder). It opens the native
// dialog, validates the choice like a project root, and hands the page an OPAQUE single-use token plus
// the folder's display name. The path itself is only released by `pick_folder_redeem`, which accepts a
// token the host issued, once, within two minutes. So the page can never name a path the user did not
// just pick, and a token that leaks (a log, a stray message) is useless after one use or a short wait.

use std::sync::Mutex;

const TOKEN_TTL_MS: u64 = 120_000;
const MAX_TOKENS: usize = 8;
const TITLE_MAX_CHARS: usize = 80;

#[derive(Default)]
pub(crate) struct PickTable {
    entries: Vec<(String, PickedFolder, u64)>,
}

impl PickTable {
    /// Remembers a choice under `token`; the oldest entry goes when the table is full.
    pub(crate) fn insert(&mut self, token: String, folder: PickedFolder, now: u64) {
        self.entries.retain(|(_, _, t)| now.saturating_sub(*t) < TOKEN_TTL_MS);
        while self.entries.len() >= MAX_TOKENS {
            self.entries.remove(0);
        }
        self.entries.push((token, folder, now));
    }

    /// The folder for `token`, removing it (single use). `None` for unknown, used or expired tokens.
    pub(crate) fn redeem(&mut self, token: &str, now: u64) -> Option<PickedFolder> {
        let i = self.entries.iter().position(|(t, _, _)| crate::core_host::ct_eq(t, token))?;
        let (_, folder, at) = self.entries.remove(i);
        (now.saturating_sub(at) < TOKEN_TTL_MS).then_some(folder)
    }
}

static PICKS: Mutex<Option<PickTable>> = Mutex::new(None);
static PICK_LIMIT: crate::confirm::RateLimit = crate::confirm::RateLimit::new(300, 20);
static PICK_OPEN: Mutex<bool> = Mutex::new(false);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PickedChoice {
    pub token: String,
    pub name: String,
}

/// Native folder dialog with no side effect; `None` when cancelled.
#[tauri::command]
pub async fn pick_folder(title: Option<String>) -> Result<Option<PickedChoice>, String> {
    if !PICK_LIMIT.allow() {
        return Err("rate_limited: too many folder dialogs".into());
    }
    {
        let mut open = PICK_OPEN.lock().unwrap_or_else(|p| p.into_inner());
        if *open {
            return Err("busy: a folder dialog is already open".into());
        }
        *open = true;
    }
    let title = crate::confirm::sanitize_line(title.as_deref().unwrap_or(""), TITLE_MAX_CHARS);
    let title = if title.is_empty() { "Choose a folder".to_string() } else { title };
    let chosen = rfd::AsyncFileDialog::new().set_title(&title).pick_folder().await;
    *PICK_OPEN.lock().unwrap_or_else(|p| p.into_inner()) = false;
    let Some(handle) = chosen else { return Ok(None) };
    let folder = picked(handle.path())?;
    let token = crate::core_host::random_nonce()?;
    let name = folder.name.clone();
    PICKS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(PickTable::default).insert(token.clone(), folder, crate::confirm::now_ms());
    Ok(Some(PickedChoice { token, name }))
}

/// Releases the canonical path for a token from `pick_folder`, once.
#[tauri::command]
pub fn pick_folder_redeem(token: String) -> Result<PickedFolder, String> {
    if token.len() > 128 {
        return Err("unknown_token".into());
    }
    PICKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_or_insert_with(PickTable::default)
        .redeem(&token, crate::confirm::now_ms())
        .ok_or_else(|| "unknown_token: choose the folder again".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_project_folder_and_canonicalises() {
        let d = std::env::temp_dir().join(format!("llmide-pick-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("repo")).unwrap();
        let p = picked(&d.join("repo")).unwrap();
        assert_eq!(p.name, "repo");
        assert!(p.path.ends_with("repo"));
        assert_eq!(std::fs::canonicalize(&p.path).unwrap().to_string_lossy(), p.path);
    }

    #[test]
    fn refuses_broad_missing_and_non_folders() {
        assert!(picked(std::path::Path::new("/")).unwrap_err().starts_with("invalid_root"));
        if let Some(h) = crate::project::home_dir() {
            assert!(picked(std::path::Path::new(&h)).is_err(), "the home folder is too broad");
        }
        assert!(picked(std::path::Path::new("/definitely/not/here")).is_err());
        let f = std::env::temp_dir().join(format!("llmide-pick-file-{}", std::process::id()));
        std::fs::write(&f, b"x").unwrap();
        assert!(picked(&f).is_err());
    }

    #[test]
    fn a_token_redeems_once_and_expires() {
        let f = |n: &str| PickedFolder { path: format!("/p/{n}"), name: n.into() };
        let mut t = PickTable::default();
        t.insert("tok1".into(), f("a"), 1_000);
        assert!(t.redeem("nope", 1_001).is_none());
        assert_eq!(t.redeem("tok1", 1_001).unwrap().path, "/p/a");
        assert!(t.redeem("tok1", 1_002).is_none(), "single use");
        t.insert("tok2".into(), f("b"), 1_000);
        assert!(t.redeem("tok2", 1_000 + TOKEN_TTL_MS).is_none(), "expired");
    }

    #[test]
    fn the_table_is_bounded_and_drops_the_oldest() {
        let mut t = PickTable::default();
        for i in 0..(MAX_TOKENS + 3) {
            t.insert(format!("t{i}"), PickedFolder { path: format!("/p/{i}"), name: i.to_string() }, 10 + i as u64);
        }
        assert!(t.redeem("t0", 100).is_none() && t.redeem("t2", 100).is_none());
        assert!(t.redeem(&format!("t{}", MAX_TOKENS + 2), 100).is_some());
    }
}
