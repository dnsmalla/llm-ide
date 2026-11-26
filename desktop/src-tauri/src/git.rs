//! Local git for the Explorer: the Tauri commands for status, diff, file-at-revision and stage/unstage.
//!
//! The git logic lives in `llmide_workspace_core::git` and the command table in `llmide_workspace_core::commands`,
//! which the SSH workspace helper serves too. This file keeps the Tauri commands, each of which sends the UI's
//! argument object to `workspace_backend::dispatch`. The `pub use` keeps `crate::git::X` paths working for the
//! rest of the crate.

use llmide_workspace_core::R;
pub use llmide_workspace_core::git::*;
use serde_json::{json, Value};

use crate::workspace_backend::dispatch;

#[tauri::command]
pub async fn git_status() -> R<Value> {
    dispatch("git_status", false, json!({})).await
}

#[tauri::command]
pub async fn git_diff(req: DiffReq) -> R<Value> {
    dispatch("git_diff", false, json!({"req": req})).await
}

#[tauri::command]
pub async fn git_show(req: ShowReq) -> R<Value> {
    dispatch("git_show", false, json!({"req": req})).await
}

#[tauri::command]
pub async fn git_stage(req: StageReq) -> R<Value> {
    dispatch("git_stage", false, json!({"req": req})).await
}
