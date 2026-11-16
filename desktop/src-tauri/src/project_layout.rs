//! Read-only project layout for Settings > Paths and > Memory (the Tauri commands).
//!
//! Every path is derived from the ACTIVE project root the host accepted (`project::active_root`); the webview
//! never supplies one. The layout itself lives in `llmide_workspace_core::project::layout`, shared with the SSH helper.
//! "Show in Finder" goes through the existing `reveal_in_os`, which re-checks the path against the same root.

use std::path::PathBuf;

use llmide_workspace_core::project::layout::{self, Paths, ProjectMemory};
use llmide_workspace_core::project::scaffold;

fn active_root() -> Result<PathBuf, String> {
    crate::project::active_root().ok_or_else(|| "no project is open".to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("project layout task failed: {e}"))
}

#[tauri::command]
pub async fn project_paths() -> Result<Paths, String> {
    let root = active_root()?;
    blocking(move || layout::paths(&root)).await
}

#[tauri::command]
pub async fn project_memory() -> Result<ProjectMemory, String> {
    let root = active_root()?;
    blocking(move || layout::memory(&root)).await
}

/// Re-create missing canonical folders/files for the active project (the Mac's "Rebuild missing folders").
/// Idempotent: `scaffold::scaffold` only writes files that are absent, so user edits are never replaced.
#[tauri::command]
pub async fn project_rebuild_folders() -> Result<(), String> {
    let root = active_root()?;
    blocking(move || scaffold::scaffold(&root, &layout::project_meta(&root))).await?
}
