//! The desktop's `repo_clone` command: a thin wrapper over `llmide_workspace_core::project::clone`, which holds the
//! validation, the git invocation and the cancel handling. The token is handed to the core as a `Token` (redacted in
//! `Debug`) and never returned. This wrapper keeps the host state: the active project root.
//!
//! In SSH server mode the clone runs on the server: the helper gets the request on its stdin and reports through a
//! `clone` event, which `workspace_backend::Remote::clone_repo` waits for. The token goes only into that request.

use std::sync::atomic::AtomicBool;
use std::time::Duration;

// The desktop waits as long as the clone itself may run: one constant, shared with the core and the helper.
use llmide_workspace_core::project::clone::{plan, run, CloneRequest, CloneResult, Token, CLONE_CAP};
use serde_json::{json, Value};

use crate::workspace_backend::{self, Connector, Remote};

/// The local command has no cancel control, so its flag is never set. The SSH helper is the one that cancels.
static NEVER_CANCELLED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn repo_clone(provider: String, url: String, token: Option<String>, folder: Option<String>) -> Result<CloneResult, String> {
    if workspace_backend::is_ssh_mode() {
        return workspace_backend::on_blocking(move || {
            remote_clone_with(workspace_backend::remote(), &workspace_backend::LinkConnector, provider, url, token, folder, CLONE_CAP)
        })
        .await?;
    }
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

/// The helper's `repo_clone` request. An unusable token is dropped, as the local command does, so the clone runs
/// anonymously; `folder` is sent as `null` when absent. The token is placed here and nowhere else in the desktop.
pub(crate) fn clone_request(provider: String, url: String, token: Option<String>, folder: Option<String>) -> Value {
    let token = token.map(Token::from).filter(Token::is_usable);
    let mut req: Value = json!({"provider": provider, "url": url, "folder": folder});
    if let Some(token) = token.as_ref() {
        req["token"] = json!(token.expose());
    }
    req
}

/// SSH mode: the helper clones into the open server folder and the result is the local command's `{path, name}`.
pub(crate) fn remote_clone_with(
    remote: &Remote,
    connector: &dyn Connector,
    provider: String,
    url: String,
    token: Option<String>,
    folder: Option<String>,
    cap: Duration,
) -> Result<CloneResult, String> {
    let answer = remote.clone_repo(connector, clone_request(provider, url, token, folder), cap).map_err(|e| e.message)?;
    let field = |key: &str| answer.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    Ok(CloneResult { path: field("path"), name: field("name") })
}
