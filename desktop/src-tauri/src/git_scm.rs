//! Source Control (Changes) commands for the desktop host.
//!
//! The git logic lives in `llmide_workspace_core::scm`, which the SSH workspace helper serves too. This file keeps the
//! Tauri commands and the native confirmation that gates the destructive ones. The `pub use` keeps `crate::git_scm::X`
//! paths working for the rest of the crate.

use llmide_workspace_core::R;
pub use llmide_workspace_core::scm::*;
use serde_json::{json, Value};

use crate::git::{blocking, blocking_scm};
pub(crate) use crate::workspace_backend::DESTRUCTIVE_DIALOGS;

/// The native dialog for a destructive command. Its title and accept label come from `confirm_spec`, the table the
/// core crate keeps for every front end, so the wording cannot drift between copies. A command with no entry is
/// refused (`false`) rather than shown with no title.
fn native_ask(command: &str, force: bool) -> impl Fn(&str) -> bool {
    let spec = confirm_spec(command, force);
    move |text: &str| match spec {
        Some(dialog) => crate::confirm::ask(dialog.title, text, dialog.accept, true),
        None => false,
    }
}


#[tauri::command]
pub async fn git_diff_hunks(req: HunksReq) -> R<Value> {
    blocking_scm("git_diff_hunks", req, |r| json!({"req": r}), |s, req| diff_hunks(&s.repo, &s.to_repo(&req.path)?, req.staged)).await
}

#[tauri::command]
pub async fn git_stage_hunks(req: StageHunksReq) -> R<Value> {
    blocking_scm("git_stage_hunks", req, |r| json!({"req": r}), |s, req| {
        stage_hunks(&s.repo, &s.to_repo(&req.path)?, req.staged, &req.diff_id, &req.hunks)
    })
    .await
}

#[tauri::command]
pub async fn git_stage_all(stage: bool) -> R<Value> {
    blocking("git_stage_all", stage, |v| json!({"stage": v}), |root, stage| stage_all(&root, stage)).await
}

#[tauri::command]
pub async fn git_discard(paths: Vec<String>) -> R<Value> {
    blocking_scm("git_discard", paths, |p| json!({"paths": p}), |s, paths| {
        let paths = s.to_repo_all(&paths)?;
        DESTRUCTIVE_DIALOGS.run(|| discard(&s.repo, &paths, &native_ask("discard", false)))
    })
    .await
}

#[tauri::command]
pub async fn git_identity() -> R<Value> {
    blocking("git_identity", (), |_| json!({}), |root, ()| identity(&root, &None)).await
}

#[tauri::command]
pub async fn git_commit(message: String) -> R<Value> {
    blocking("git_commit", message, |m| json!({"message": m}), |root, message| commit(&root, &message, &None)).await
}

#[tauri::command]
pub async fn git_branches() -> R<Value> {
    blocking("git_branches", (), |_| json!({}), |root, ()| branches(&root)).await
}

#[tauri::command]
pub async fn git_checkout(name: String) -> R<Value> {
    blocking("git_checkout", name, |n| json!({"name": n}), |root, name| {
        DESTRUCTIVE_DIALOGS.run(|| checkout(&root, &name, &native_ask("checkout", false)))
    })
    .await
}

#[tauri::command]
pub async fn git_create_branch(name: String) -> R<Value> {
    blocking("git_create_branch", name, |n| json!({"name": n}), |root, name| create_branch(&root, &name)).await
}

#[tauri::command]
pub async fn git_tags() -> R<Value> {
    blocking("git_tags", (), |_| json!({}), |root, ()| tags(&root)).await
}

#[tauri::command]
pub async fn git_log(req: LogReq) -> R<Value> {
    blocking("git_log", req, |r| json!({"req": r}), |root, req| log(&root, req.skip, req.limit)).await
}

#[tauri::command]
pub async fn git_commit_files(hash: String) -> R<Value> {
    blocking_scm("git_commit_files", hash, |h| json!({"hash": h}), |s, hash| {
        let mut detail = commit_files(&s.repo, &hash)?;
        for f in &mut detail.files {
            f.path = s.to_project(&f.path);
        }
        Ok(detail)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_diff(req: CommitDiffReq) -> R<Value> {
    blocking_scm("git_commit_diff", req, |r| json!({"req": r}), |s, req| commit_diff(&s.repo, &req.hash, &s.to_repo(&req.path)?)).await
}

#[tauri::command]
pub async fn git_branch_delete(name: String, force: bool) -> R<Value> {
    blocking("git_branch_delete", (name, force), |(n, f)| json!({"name": n, "force": f}), |root, (name, force)| {
        let ask = native_ask("branch_delete", force);
        DESTRUCTIVE_DIALOGS.run(|| branch_delete(&root, &name, force, &ask))
    })
    .await
}

#[tauri::command]
pub async fn git_tag_create(name: String, message: Option<String>, target: Option<String>) -> R<Value> {
    blocking("git_tag_create", (name, message, target), |(n, m, t)| json!({"name": n, "message": m, "target": t}), |root, (name, message, target)| {
        tag_create(&root, &name, message.as_deref(), target.as_deref(), &None)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_list() -> R<Value> {
    blocking("git_stash_list", (), |_| json!({}), |root, ()| stash_list(&root)).await
}

#[tauri::command]
pub async fn git_stash_push(req: StashPushReq) -> R<Value> {
    blocking("git_stash_push", req, |r| json!({"req": r}), |root, req| stash_push(&root, &req.message, req.include_untracked, &None)).await
}

#[tauri::command]
pub async fn git_stash_apply(index: usize, hash: String) -> R<Value> {
    blocking("git_stash_apply", (index, hash), |(i, h)| json!({"index": i, "hash": h}), |root, (index, hash)| stash_apply(&root, index, &hash)).await
}

#[tauri::command]
pub async fn git_stash_pop(index: usize, hash: String) -> R<Value> {
    blocking("git_stash_pop", (index, hash), |(i, h)| json!({"index": i, "hash": h}), |root, (index, hash)| {
        DESTRUCTIVE_DIALOGS.run(|| stash_pop(&root, index, &hash, &native_ask("stash_pop", false)))
    })
    .await
}

#[tauri::command]
pub async fn git_stash_drop(index: usize, hash: String) -> R<Value> {
    blocking("git_stash_drop", (index, hash), |(i, h)| json!({"index": i, "hash": h}), |root, (index, hash)| {
        DESTRUCTIVE_DIALOGS.run(|| stash_drop(&root, index, &hash, &native_ask("stash_drop", false)))
    })
    .await
}

#[tauri::command]
pub async fn git_merge(req: MergeReq) -> R<Value> {
    blocking_scm("git_merge", req, |r| json!({"req": r}), |s, req| {
        let mode = merge_mode(req.mode.as_deref())?;
        let mut outcome = DESTRUCTIVE_DIALOGS.run(|| merge(&s.repo, &req.name, mode, &None, &native_ask("merge", false)))?;
        if let MergeOutcome::Conflicts { paths, .. } = &mut outcome {
            for p in paths.iter_mut() {
                *p = s.to_project(p);
            }
        }
        Ok(outcome)
    })
    .await
}

#[tauri::command]
pub async fn git_merge_abort() -> R<Value> {
    blocking("git_merge_abort", (), |_| json!({}), |root, ()| DESTRUCTIVE_DIALOGS.run(|| merge_abort(&root, &native_ask("merge_abort", false)))).await
}

#[tauri::command]
pub async fn git_commit_amend(req: AmendReq) -> R<Value> {
    blocking("git_commit_amend", req, |r| json!({"req": r}), |root, req| {
        DESTRUCTIVE_DIALOGS.run(|| commit_amend(&root, req.message.as_deref(), req.force, &None, &native_ask("amend", false)))
    })
    .await
}

#[tauri::command]
pub async fn git_discard_all(req: DiscardAllReq) -> R<Value> {
    blocking("git_discard_all", req, |r| json!({"req": r}), |root, req| {
        DESTRUCTIVE_DIALOGS.run(|| discard_all(&root, req.include_untracked, &native_ask("discard_all", false)))
    })
    .await
}
