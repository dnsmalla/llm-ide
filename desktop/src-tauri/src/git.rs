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

/// Runs a Source Control command against the repository the project resolves to. `req` is the request the UI's
/// arguments describe; `args` builds that argument object, and runs only in SSH mode. The local closure gets the
/// repository and the request. Git never had the hub-mode refusal, so none is added here.
pub(crate) async fn blocking_scm<Q, T, A, F>(cmd: &'static str, req: Q, args: A, f: F) -> R<Value>
where
    Q: Send + 'static,
    T: Serialize + Send + 'static,
    A: FnOnce(&Q) -> Value + Send + 'static,
    F: FnOnce(ScmRoot, Q) -> R<T> + Send + 'static,
{
    dispatch(cmd, false, req, args, move |root, req| f(scm_root(&root), req)).await
}

/// For commands that carry no file path: they run in the repository root.
pub(crate) async fn blocking<Q, T, A, F>(cmd: &'static str, req: Q, args: A, f: F) -> R<Value>
where
    Q: Send + 'static,
    T: Serialize + Send + 'static,
    A: FnOnce(&Q) -> Value + Send + 'static,
    F: FnOnce(PathBuf, Q) -> R<T> + Send + 'static,
{
    blocking_scm(cmd, req, args, move |s, req| f(s.repo, req)).await
}

#[tauri::command]
pub async fn git_status() -> R<Value> {
    blocking_scm("git_status", (), |_| serde_json::json!({}), |s, ()| {
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
    blocking_scm("git_diff", req, |r| serde_json::json!({"req": r}), |s, req| diff(&s.repo, &s.to_repo(&req.path)?, req.staged)).await
}

#[tauri::command]
pub async fn git_show(req: ShowReq) -> R<Value> {
    blocking_scm("git_show", req, |r| serde_json::json!({"req": r}), |s, req| show(&s.repo, &s.to_repo(&req.path)?, &req.rev)).await
}

#[tauri::command]
pub async fn git_stage(req: StageReq) -> R<Value> {
    blocking_scm("git_stage", req, |r| serde_json::json!({"req": r}), |s, req| stage(&s.repo, &s.to_repo_all(&req.paths)?, req.stage)).await
}
