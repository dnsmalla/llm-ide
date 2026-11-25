//! The desktop's `repo_clone` command: a thin wrapper over `llmide_workspace_core::project::clone`, which holds the
//! validation, the git invocation and the cancel handling. The token is handed to the core as a `Token` (redacted in
//! `Debug`) and never returned. This wrapper keeps the host state: the active project root.
//!
//! In SSH server mode the clone runs on the server: the helper gets the request on its stdin and reports through a
//! `clone` event, which `workspace_backend::Remote::clone_repo` waits for. The token goes only into that request.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

// The desktop waits as long as the clone itself may run: one constant, shared with the core and the helper.
use llmide_workspace_core::project::clone::{plan, run, CloneRequest, CloneResult, Token, CLONE_CAP};
use llmide_workspace_core::project::existing_clone::adopt_existing;
use llmide_workspace_core::R;
use serde_json::{json, Value};

use crate::workspace_backend::{self, Connector, Remote};

/// The local clone's cancel flag. No UI control sets it; only `cancel_for_exit` does, so a clone does not outlive
/// the app. The SSH helper has its own cancel.
static LOCAL_CANCEL: AtomicBool = AtomicBool::new(false);

/// Local clones in flight, so `cancel_for_exit` knows whether there is one to wait for.
static LOCAL_RUNNING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Stops a running local clone on app exit and waits up to 2 s for it to end: the clone polls the flag every
/// 100 ms, then kills git and removes the partial folder, and the process must not exit before that.
pub(crate) fn cancel_for_exit() {
    use std::sync::atomic::Ordering::SeqCst;
    LOCAL_CANCEL.store(true, SeqCst);
    for _ in 0..20 {
        if LOCAL_RUNNING.load(SeqCst) == 0 { return; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// `grant` is the server's single-use clone grant. It is used only in SSH mode, where the helper redeems it for the
/// saved token; local mode ignores it because the Mac's own git credentials are used there (Settings → Save token fills them via
/// `git_credential_save`).
#[tauri::command]
pub async fn repo_clone(
    provider: String,
    url: String,
    token: Option<String>,
    folder: Option<String>,
    grant: Option<String>,
) -> Result<CloneResult, workspace_backend::CommandError> {
    if workspace_backend::is_ssh_mode() {
        return Ok(workspace_backend::on_blocking(move || {
            remote_clone_with(workspace_backend::remote(), &workspace_backend::LinkConnector, provider, url, token, folder, grant, CLONE_CAP)
        })
        .await??);
    }
    // Local mode never redeems a grant: it uses the Mac's git credentials, which Save token fills through
    // `git_credential_save`, so `grant` stays unset here.
    let req = CloneRequest { provider, url, token: token.map(Token::from), folder, grant: None };
    let root = crate::project::active_root().ok_or_else(|| "open a project before cloning a repository".to_string())?;
    if crate::fs_ops::checked_root(&root).is_err() {
        return Err("the project folder is not usable".to_string().into());
    }
    let done = tauri::async_runtime::spawn_blocking(move || {
        let git = llmide_workspace_core::git::git_binary().ok_or_else(|| "git was not found on PATH".to_string())?;
        local_clone(&root, &req, &git)
    })
    .await
    .map_err(|e| format!("clone task failed: {e}"))?;
    Ok(done?)
}

/// Clones into `<root>/code/`. A destination that is already a clone of the same repository is returned as the
/// result, so the caller records its path; any other refusal (another repository there, a bad URL) stands.
fn local_clone(root: &Path, req: &CloneRequest, git: &Path) -> Result<CloneResult, String> {
    use std::sync::atomic::Ordering::SeqCst;
    struct Running;
    impl Drop for Running {
        fn drop(&mut self) { LOCAL_RUNNING.fetch_sub(1, SeqCst); }
    }
    LOCAL_CANCEL.store(false, SeqCst);
    LOCAL_RUNNING.fetch_add(1, SeqCst);
    let _running = Running;
    match plan(root, req) {
        Ok(clone_plan) => run(&clone_plan, req.token.as_ref(), &LOCAL_CANCEL, git),
        Err(refusal) => adopt_existing(root, req, git).ok_or(refusal),
    }
}

/// The helper's `repo_clone` request. An unusable token is dropped, as the local command does, so the clone runs
/// anonymously; `folder` is sent as `null` when absent. The token is placed here and nowhere else in the desktop.
/// The grant is sent only when no usable token was typed: a typed token always wins, and the helper never sees both.
pub(crate) fn clone_request(
    provider: String,
    url: String,
    token: Option<String>,
    folder: Option<String>,
    grant: Option<String>,
) -> Value {
    let token = token.map(Token::from).filter(Token::is_usable);
    let mut req: Value = json!({"provider": provider, "url": url, "folder": folder});
    if let Some(token) = token.as_ref() {
        req["token"] = json!(token.expose());
    } else if let Some(grant) = grant {
        req["grant"] = json!(grant);
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
    grant: Option<String>,
    cap: Duration,
) -> R<CloneResult> {
    let answer = remote.clone_repo(connector, clone_request(provider, url, token, folder, grant), cap)?;
    let field = |key: &str| answer.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    Ok(CloneResult { path: field("path"), name: field("name") })
}
