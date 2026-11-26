//! Source Control (Changes) commands for the desktop host.
//!
//! The git logic lives in `llmide_workspace_core::scm` and the command table in `llmide_workspace_core::commands`,
//! which the SSH workspace helper serves too. This file keeps the Tauri commands; the native confirmation that gates
//! the destructive ones is the host's `ask` in `workspace_backend`, worded by the core's `confirm_spec`.

use llmide_workspace_core::scm::{
    AmendReq, CommitDiffReq, DiscardAllReq, HunksReq, LogReq, MergeReq, StageHunksReq, StashPushReq,
};
use llmide_workspace_core::R;
use serde_json::{json, Value};

use crate::workspace_backend::dispatch;

#[tauri::command]
pub async fn git_diff_hunks(req: HunksReq) -> R<Value> {
    dispatch("git_diff_hunks", false, json!({"req": req})).await
}

#[tauri::command]
pub async fn git_stage_hunks(req: StageHunksReq) -> R<Value> {
    dispatch("git_stage_hunks", false, json!({"req": req})).await
}

#[tauri::command]
pub async fn git_stage_all(stage: bool) -> R<Value> {
    dispatch("git_stage_all", false, json!({"stage": stage})).await
}

#[tauri::command]
pub async fn git_discard(paths: Vec<String>) -> R<Value> {
    dispatch("git_discard", false, json!({"paths": paths})).await
}

#[tauri::command]
pub async fn git_identity() -> R<Value> {
    dispatch("git_identity", false, json!({})).await
}

#[tauri::command]
pub async fn git_commit(message: String) -> R<Value> {
    dispatch("git_commit", false, json!({"message": message})).await
}

#[tauri::command]
pub async fn git_branches() -> R<Value> {
    dispatch("git_branches", false, json!({})).await
}

#[tauri::command]
pub async fn git_checkout(name: String) -> R<Value> {
    dispatch("git_checkout", false, json!({"name": name})).await
}

#[tauri::command]
pub async fn git_create_branch(name: String) -> R<Value> {
    dispatch("git_create_branch", false, json!({"name": name})).await
}

#[tauri::command]
pub async fn git_tags() -> R<Value> {
    dispatch("git_tags", false, json!({})).await
}

#[tauri::command]
pub async fn git_log(req: LogReq) -> R<Value> {
    dispatch("git_log", false, json!({"req": req})).await
}

#[tauri::command]
pub async fn git_commit_files(hash: String) -> R<Value> {
    dispatch("git_commit_files", false, json!({"hash": hash})).await
}

#[tauri::command]
pub async fn git_commit_diff(req: CommitDiffReq) -> R<Value> {
    dispatch("git_commit_diff", false, json!({"req": req})).await
}

#[tauri::command]
pub async fn git_branch_delete(name: String, force: bool) -> R<Value> {
    dispatch("git_branch_delete", false, json!({"name": name, "force": force})).await
}

#[tauri::command]
pub async fn git_tag_create(name: String, message: Option<String>, target: Option<String>) -> R<Value> {
    dispatch("git_tag_create", false, json!({"name": name, "message": message, "target": target})).await
}

#[tauri::command]
pub async fn git_stash_list() -> R<Value> {
    dispatch("git_stash_list", false, json!({})).await
}

#[tauri::command]
pub async fn git_stash_push(req: StashPushReq) -> R<Value> {
    dispatch("git_stash_push", false, json!({"req": req})).await
}

#[tauri::command]
pub async fn git_stash_apply(index: usize, hash: String) -> R<Value> {
    dispatch("git_stash_apply", false, json!({"index": index, "hash": hash})).await
}

#[tauri::command]
pub async fn git_stash_pop(index: usize, hash: String) -> R<Value> {
    dispatch("git_stash_pop", false, json!({"index": index, "hash": hash})).await
}

#[tauri::command]
pub async fn git_stash_drop(index: usize, hash: String) -> R<Value> {
    dispatch("git_stash_drop", false, json!({"index": index, "hash": hash})).await
}

#[tauri::command]
pub async fn git_merge(req: MergeReq) -> R<Value> {
    dispatch("git_merge", false, json!({"req": req})).await
}

#[tauri::command]
pub async fn git_merge_abort() -> R<Value> {
    dispatch("git_merge_abort", false, json!({})).await
}

#[tauri::command]
pub async fn git_commit_amend(req: AmendReq) -> R<Value> {
    dispatch("git_commit_amend", false, json!({"req": req})).await
}

#[tauri::command]
pub async fn git_discard_all(req: DiscardAllReq) -> R<Value> {
    dispatch("git_discard_all", false, json!({"req": req})).await
}
