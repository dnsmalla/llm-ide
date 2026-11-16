//! Local git for the Explorer: the Tauri commands for status, diff, file-at-revision and stage/unstage.
//!
//! The git logic lives in `llmide_workspace_core::git`, which the SSH workspace helper serves too. This file keeps what
//! is specific to the host: the active-root lookup in `blocking_scm` and the commands. The `pub use` keeps
//! `crate::git::X` paths working for the rest of the crate.

use std::path::PathBuf;

use llmide_workspace_core::{FsError, R};
pub use llmide_workspace_core::git::*;

pub(crate) async fn blocking_scm<T, F>(f: F) -> R<T>
where
    T: Send + 'static,
    F: FnOnce(ScmRoot) -> R<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(scm_root(&crate::fs_ops::active_root()?)))
        .await
        .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") })?
}

/// For commands that carry no file path: they run in the repository root.
pub(crate) async fn blocking<T, F>(f: F) -> R<T>
where
    T: Send + 'static,
    F: FnOnce(PathBuf) -> R<T> + Send + 'static,
{
    blocking_scm(move |s| f(s.repo)).await
}
#[tauri::command]
pub async fn git_status() -> R<GitStatus> {
    blocking_scm(|s| {
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
pub async fn git_diff(req: DiffReq) -> R<DiffResult> {
    blocking_scm(move |s| diff(&s.repo, &s.to_repo(&req.path)?, req.staged)).await
}

#[tauri::command]
pub async fn git_show(req: ShowReq) -> R<ShowResult> {
    blocking_scm(move |s| show(&s.repo, &s.to_repo(&req.path)?, &req.rev)).await
}

#[tauri::command]
pub async fn git_stage(req: StageReq) -> R<()> {
    blocking_scm(move |s| stage(&s.repo, &s.to_repo_all(&req.paths)?, req.stage)).await
}
