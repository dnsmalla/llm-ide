//! The desktop's `repo_clone` command: a thin wrapper over `llmide_workspace_core::project::clone`, which holds the
//! validation, the git invocation and the cancel handling. The token is handed to the core as a `Token` (redacted in
//! `Debug`) and never returned. This wrapper keeps the host state: the SSH-mode refusal and the active project root.

use std::sync::atomic::AtomicBool;

use llmide_workspace_core::project::clone::{plan, run, CloneRequest, CloneResult, Token};

/// The local command has no cancel control, so its flag is never set. The SSH helper is the one that cancels.
static NEVER_CANCELLED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn repo_clone(provider: String, url: String, token: Option<String>, folder: Option<String>) -> Result<CloneResult, String> {
    crate::workspace_backend::refuse_in_ssh_mode().map_err(|e| e.message)?;
    let req = CloneRequest { provider, url, token: token.map(Token::from), folder };
    let root = crate::project::active_root().ok_or_else(|| "open a project before cloning a repository".to_string())?;
    if crate::fs_ops::checked_root(&root).is_err() {
        return Err("the project folder is not usable".into());
    }
    let clone_plan = plan(&root, &req)?;
    tauri::async_runtime::spawn_blocking(move || {
        let git = llmide_workspace_core::git::git_binary().ok_or_else(|| "git was not found on PATH".to_string())?;
        run(&clone_plan, req.token.as_ref(), &NEVER_CANCELLED, &git)
    })
    .await
    .map_err(|e| format!("clone task failed: {e}"))?
}
