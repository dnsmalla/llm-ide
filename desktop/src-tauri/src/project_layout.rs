//! Read-only project layout for Settings > Paths and > Memory (the Tauri commands).
//!
//! Every path is derived from the ACTIVE project root the host accepted (`project::active_root`); the webview
//! never supplies one. The layout itself lives in `llmide_workspace_core::project::layout`, shared with the SSH helper.
//! "Show in Finder" goes through the existing `reveal_in_os`, which re-checks the path against the same root.
//!
//! In SSH server mode the same commands run on the server through the helper (`project_paths`, `project_memory`,
//! `project_rebuild`). Their JSON answers have the same shape as the local ones.

use std::path::PathBuf;

use llmide_workspace_core::project::layout;
use llmide_workspace_core::project::scaffold;
use llmide_workspace_core::R;
use serde::Serialize;
use serde_json::{json, Value};

use crate::workspace_backend::{self, CommandError, Connector, Remote};

fn active_root() -> Result<PathBuf, String> {
    crate::project::active_root().ok_or_else(|| "no project is open".to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("project layout task failed: {e}"))
}

/// SSH branch of `project_paths`: the helper's `project_paths` on the open server folder.
pub(crate) fn ssh_paths(remote: &Remote, connector: &dyn Connector) -> R<Value> {
    workspace_backend::project_call_with(remote, connector, "project_paths", json!({}))
}

/// SSH branch of `project_memory`: the helper's `project_memory` on the open server folder.
pub(crate) fn ssh_memory(remote: &Remote, connector: &dyn Connector) -> R<Value> {
    workspace_backend::project_call_with(remote, connector, "project_memory", json!({}))
}

/// SSH branch of Rebuild: the helper's `project_rebuild`, which runs the same scaffold on the open server folder.
pub(crate) fn ssh_rebuild(remote: &Remote, connector: &dyn Connector) -> R<Value> {
    workspace_backend::project_call_with(remote, connector, "project_rebuild", json!({}))
}

fn to_json<T: Serialize>(value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("cannot encode the result: {e}"))
}

#[tauri::command]
pub async fn project_paths() -> Result<Value, CommandError> {
    if workspace_backend::is_ssh_mode() {
        return Ok(workspace_backend::on_remote(ssh_paths).await?);
    }
    let root = active_root()?;
    Ok(to_json(&blocking(move || layout::paths(&root)).await?)?)
}

#[tauri::command]
pub async fn project_memory() -> Result<Value, CommandError> {
    if workspace_backend::is_ssh_mode() {
        return Ok(workspace_backend::on_remote(ssh_memory).await?);
    }
    let root = active_root()?;
    Ok(to_json(&blocking(move || layout::memory(&root)).await?)?)
}

/// Re-create missing canonical folders/files for the active project (the Mac's "Rebuild missing folders").
/// Idempotent: `scaffold::scaffold` only writes files that are absent, so user edits are never replaced.
/// In SSH mode the helper runs the same scaffold on the open server folder.
#[tauri::command]
pub async fn project_rebuild_folders() -> Result<(), CommandError> {
    if workspace_backend::is_ssh_mode() {
        workspace_backend::on_remote(ssh_rebuild).await?;
        return Ok(());
    }
    let root = active_root()?;
    Ok(blocking(move || scaffold::rebuild(&root)).await??)
}
