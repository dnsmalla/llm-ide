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
}
