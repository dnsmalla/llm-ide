//! Native pickers and detection for Server & Backend's source-checkout mode. The chosen paths are stored host-side
//! (the webview cannot set them) and only used to spawn the Node backend; they are never interpolated into a shell.
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
    let path = file.path().to_string_lossy().into_owned();
    crate::prefs::set_backend_paths(Some(path.clone()), None).map_err(|e| e.message)?;
    Ok(Some(path))
}

#[tauri::command]
pub async fn backend_pick_dir() -> Result<Option<String>, String> {
    let Some(dir) = rfd::AsyncFileDialog::new().set_title("Choose the extension folder (or the checkout)").pick_folder().await else {
        return Ok(None);
    };
    let path = dir.path().to_string_lossy().into_owned();
    crate::prefs::set_backend_paths(None, Some(path.clone())).map_err(|e| e.message)?;
    Ok(Some(path))
}

/// Best-effort defaults: the node the app would use, and the checkout's `extension` folder (the app records its
/// source checkout for Apply & Rebuild; a dev binary can also be inside one).
#[tauri::command]
pub async fn backend_detect() -> BackendPaths {
    tauri::async_runtime::spawn_blocking(detect_paths)
        .await
        .unwrap_or_else(|_| BackendPaths { node: String::new(), dir: String::new() })
}

fn detect_paths() -> BackendPaths {
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
