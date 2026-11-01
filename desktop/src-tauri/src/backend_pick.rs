//! Native pickers and detection for Server & Backend's source-checkout mode. The chosen paths are stored in prefs
//! and only used to spawn the Node backend; they are never interpolated into a shell.
use std::path::PathBuf;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackendPaths {
    pub node: String,
    pub dir: String,
}

#[tauri::command]
pub async fn backend_pick_node() -> Result<Option<String>, String> {
    let Some(file) = rfd::AsyncFileDialog::new().set_title("Choose the node binary").pick_file().await else {
        return Ok(None);
    };
    Ok(Some(file.path().to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn backend_pick_dir() -> Result<Option<String>, String> {
    let Some(dir) = rfd::AsyncFileDialog::new().set_title("Choose the extension folder (or the checkout)").pick_folder().await else {
        return Ok(None);
    };
    Ok(Some(dir.path().to_string_lossy().into_owned()))
}

/// Best-effort defaults: the node the app would use, and the checkout's `extension` folder (the app records its
/// source checkout for Apply & Rebuild; a dev binary can also be inside one).
#[tauri::command]
pub fn backend_detect() -> BackendPaths {
    let node = crate::core_host::node_binary();
    let dir = if let Ok(root) = crate::core_host::repo_root() {
        root.join("extension")
    } else if let Some(root) = crate::feature_rebuild::source_root() {
        root.join("extension")
    } else {
        PathBuf::new()
    };
    BackendPaths { node: node.to_string_lossy().into_owned(), dir: dir.to_string_lossy().into_owned() }
}
