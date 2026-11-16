//! Source Control (Changes) commands for the desktop host.
//!
//! The git logic lives in `llmide_workspace_core::scm`, which the SSH workspace helper serves too. This file keeps the
//! Tauri commands and the native confirmation that gates the destructive ones. The `pub use` keeps `crate::git_scm::X`
//! paths working for the rest of the crate.

use llmide_workspace_core::R;
pub use llmide_workspace_core::scm::*;

use crate::git::{blocking, blocking_scm};

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

/// One native destructive dialog at a time, and not more often than a person can read them: a page that
/// loops over `git_discard` / `git_checkout` gets `busy` / `rate_limited` instead of a stream of dialogs.
static DESTRUCTIVE_DIALOGS: crate::confirm::DialogGuard = crate::confirm::DialogGuard::new(1_500, 10);

#[tauri::command]
pub async fn git_diff_hunks(req: HunksReq) -> R<HunkDiff> {
    blocking_scm(move |s| diff_hunks(&s.repo, &s.to_repo(&req.path)?, req.staged)).await
}

#[tauri::command]
pub async fn git_stage_hunks(req: StageHunksReq) -> R<()> {
    blocking_scm(move |s| stage_hunks(&s.repo, &s.to_repo(&req.path)?, req.staged, &req.diff_id, &req.hunks)).await
}

#[tauri::command]
pub async fn git_stage_all(stage: bool) -> R<()> {
    blocking(move |root| stage_all(&root, stage)).await
}

#[tauri::command]
pub async fn git_discard(paths: Vec<String>) -> R<DiscardResult> {
    blocking_scm(move |s| {
        let paths = s.to_repo_all(&paths)?;
        DESTRUCTIVE_DIALOGS.run(|| discard(&s.repo, &paths, &native_ask("discard", false)))
    })
    .await
}

#[tauri::command]
pub async fn git_identity() -> R<Identity> {
    blocking(|root| identity(&root, &None)).await
}

#[tauri::command]
pub async fn git_commit(message: String) -> R<CommitResult> {
    blocking(move |root| commit(&root, &message, &None)).await
}

#[tauri::command]
pub async fn git_branches() -> R<BranchList> {
    blocking(|root| branches(&root)).await
}

#[tauri::command]
pub async fn git_checkout(name: String) -> R<()> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| checkout(&root, &name, &native_ask("checkout", false)))).await
}

#[tauri::command]
pub async fn git_create_branch(name: String) -> R<()> {
    blocking(move |root| create_branch(&root, &name)).await
}

#[tauri::command]
pub async fn git_tags() -> R<TagList> {
    blocking(|root| tags(&root)).await
}

#[tauri::command]
pub async fn git_log(req: LogReq) -> R<LogPage> {
    blocking(move |root| log(&root, req.skip, req.limit)).await
}

#[tauri::command]
pub async fn git_commit_files(hash: String) -> R<CommitDetail> {
    blocking_scm(move |s| {
        let mut detail = commit_files(&s.repo, &hash)?;
        for f in &mut detail.files {
            f.path = s.to_project(&f.path);
        }
        Ok(detail)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_diff(req: CommitDiffReq) -> R<CommitDiff> {
    blocking_scm(move |s| commit_diff(&s.repo, &req.hash, &s.to_repo(&req.path)?)).await
}

#[tauri::command]
pub async fn git_branch_delete(name: String, force: bool) -> R<BranchDelete> {
    blocking(move |root| {
        let ask = native_ask("branch_delete", force);
        DESTRUCTIVE_DIALOGS.run(|| branch_delete(&root, &name, force, &ask))
    })
    .await
}

#[tauri::command]
pub async fn git_tag_create(name: String, message: Option<String>, target: Option<String>) -> R<Tag> {
    blocking(move |root| tag_create(&root, &name, message.as_deref(), target.as_deref(), &None)).await
}

#[tauri::command]
pub async fn git_stash_list() -> R<StashList> {
    blocking(|root| stash_list(&root)).await
}

#[tauri::command]
pub async fn git_stash_push(req: StashPushReq) -> R<()> {
    blocking(move |root| stash_push(&root, &req.message, req.include_untracked, &None)).await
}

#[tauri::command]
pub async fn git_stash_apply(index: usize, hash: String) -> R<()> {
    blocking(move |root| stash_apply(&root, index, &hash)).await
}

#[tauri::command]
pub async fn git_stash_pop(index: usize, hash: String) -> R<()> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| stash_pop(&root, index, &hash, &native_ask("stash_pop", false)))).await
}

#[tauri::command]
pub async fn git_stash_drop(index: usize, hash: String) -> R<()> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| stash_drop(&root, index, &hash, &native_ask("stash_drop", false)))).await
}

#[tauri::command]
pub async fn git_merge(req: MergeReq) -> R<MergeOutcome> {
    blocking_scm(move |s| {
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
pub async fn git_merge_abort() -> R<()> {
    blocking(|root| DESTRUCTIVE_DIALOGS.run(|| merge_abort(&root, &native_ask("merge_abort", false)))).await
}

#[tauri::command]
pub async fn git_commit_amend(req: AmendReq) -> R<CommitResult> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| commit_amend(&root, req.message.as_deref(), req.force, &None, &native_ask("amend", false)))).await
}

#[tauri::command]
pub async fn git_discard_all(req: DiscardAllReq) -> R<DiscardAllResult> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| discard_all(&root, req.include_untracked, &native_ask("discard_all", false)))).await
}
