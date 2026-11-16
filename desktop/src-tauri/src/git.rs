//! Local git for the Explorer: the Tauri commands for status, diff, file-at-revision and stage/unstage.
//!
//! The git logic lives in `llmide_workspace_core::git`, which the SSH workspace helper serves too. This file keeps what
//! is specific to the host: the active-root lookup in `blocking_scm` and the commands. The `pub use` keeps
//! `crate::git::X` paths working for the rest of the crate.

use std::path::PathBuf;

use llmide_workspace_core::R;
pub use llmide_workspace_core::git::*;
use serde::Serialize;
use serde_json::Value;

use crate::workspace_backend::dispatch;

/// Runs a Source Control command against the repository the project resolves to. `args` is the UI's argument object,
/// sent unchanged in SSH mode; the local closure gets the repository root and never runs there.
pub(crate) async fn blocking_scm<T, F>(cmd: &'static str, args: Value, f: F) -> R<Value>
where
    T: Serialize + Send + 'static,
    F: FnOnce(ScmRoot) -> R<T> + Send + 'static,
{
    dispatch(cmd, args, move |root| f(scm_root(&root))).await
}

/// For commands that carry no file path: they run in the repository root.
pub(crate) async fn blocking<T, F>(cmd: &'static str, args: Value, f: F) -> R<Value>
where
    T: Serialize + Send + 'static,
    F: FnOnce(PathBuf) -> R<T> + Send + 'static,
{
    blocking_scm(cmd, args, move |s| f(s.repo)).await
}

#[tauri::command]
pub async fn git_status() -> R<Value> {
    blocking_scm("git_status", serde_json::json!({}), |s| {
        let mut st = status(&s.repo)?;
        for e in &mut st.entries {
            e.path = s.to_project(&e.path);
            e.orig_path = e.orig_path.as_deref().map(|p| s.to_project(p));
        }
        Ok(st)
    })
    .await
}

#[tauri::command]
pub async fn git_diff(req: DiffReq) -> R<Value> {
    let args = serde_json::json!({"req": req});
    blocking_scm("git_diff", args, move |s| diff(&s.repo, &s.to_repo(&req.path)?, req.staged)).await
}

#[tauri::command]
pub async fn git_show(req: ShowReq) -> R<Value> {
    let args = serde_json::json!({"req": req});
    blocking_scm("git_show", args, move |s| show(&s.repo, &s.to_repo(&req.path)?, &req.rev)).await
}

#[tauri::command]
pub async fn git_stage(req: StageReq) -> R<Value> {
    let args = serde_json::json!({"req": req});
    blocking_scm("git_stage", args, move |s| stage(&s.repo, &s.to_repo_all(&req.paths)?, req.stage)).await
}
