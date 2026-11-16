//! Explorer file commands for the desktop host.
//!
//! Each `#[tauri::command]` here runs the Tauri-free logic in `llmide_workspace_core` against the host's active
//! project root. That logic lives in the core crate so the SSH workspace helper serves the same code, and its
//! security model is documented there (`fs`, `paths`, `trash`). What stays in the desktop is the host state (the
//! active root) and the commands. The re-exports keep `crate::fs_ops::X` working for the other modules.

use std::path::PathBuf;

use llmide_workspace_core::err;
pub use llmide_workspace_core::fs::*;
pub use llmide_workspace_core::paths::checked_root;
pub use llmide_workspace_core::{FsError, R};

use crate::workspace_backend::dispatch;

/// The canonical active root, re-validated now. The active project is host state, so it is read here
/// and only the root check itself is shared.
pub fn active_root() -> R<PathBuf> {
    let Some(root) = crate::project::active_root() else {
        return err("no_project", "no project is open");
    };
    checked_root(&root)
}

/// Runs a local-only command (a PDF in this computer's viewer). It refuses in SSH mode, and it never reaches the server.
async fn local_only<T, F>(f: F) -> R<T>
where
    T: Send + 'static,
    F: FnOnce(PathBuf) -> R<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        crate::core_host::require_local_mode()?;
        let root = active_root()?;
        f(root)
    })
    .await
    .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") })?
}

/// The Explorer file commands. Local and hub run them on this computer's project; SSH mode runs the same command on
/// the server (`workspace_backend::dispatch`). The argument object is what the UI sends, so the helper reads the same keys.
#[tauri::command]
pub async fn fs_list_dir(req: ListReq) -> R<serde_json::Value> {
    dispatch("fs_list_dir", true, req, |r| serde_json::json!({"req": r}), |root, req| list_dir(&root, &req)).await
}

#[tauri::command]
pub async fn fs_read_file(req: ReadReq) -> R<serde_json::Value> {
    dispatch("fs_read_file", true, req, |r| serde_json::json!({"req": r}), |root, req| read_file(&root, &req)).await
}

#[tauri::command]
pub async fn fs_read_image(path: String) -> R<serde_json::Value> {
    dispatch("fs_read_image", true, path, |v| serde_json::json!({"path": v}), |root, path| read_image(&root, &path)).await
}

#[tauri::command]
pub async fn fs_read_range(req: RangeReq) -> R<serde_json::Value> {
    dispatch("fs_read_range", true, req, |r| serde_json::json!({"req": r}), |root, req| read_range(&root, &req)).await
}

#[tauri::command]
pub async fn fs_write_file(req: WriteReq) -> R<serde_json::Value> {
    dispatch("fs_write_file", true, req, |r| serde_json::json!({"req": r}), |root, req| write_file(&root, &req)).await
}

#[tauri::command]
pub async fn fs_create(req: CreateReq) -> R<serde_json::Value> {
    dispatch("fs_create", true, req, |r| serde_json::json!({"req": r}), |root, req| create(&root, &req)).await
}

#[tauri::command]
pub async fn fs_rename(req: RenameReq) -> R<serde_json::Value> {
    dispatch("fs_rename", true, req, |r| serde_json::json!({"req": r}), |root, req| rename(&root, &req)).await
}

/// Opens a PDF inside the active project with the OS viewer. The page never supplies an arbitrary path and
/// only `.pdf` is accepted; the host resolves/confines it first. This is the desktop's Quick Look equivalent —
/// the webview does not embed PDFs. SSH mode refuses it: the viewer would open on this computer, not the server.
#[tauri::command]
pub async fn fs_open_pdf(path: String) -> R<()> {
    local_only(move |root| {
        let p = resolve_existing(&root, &path)?;
        if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("pdf")) != Some(true) {
            return err("invalid_path", "only PDF files can be opened in the system viewer");
        }
        // os_open::spawn scrubs the environment (the host holds secrets) and reaps the child; a bare
        // Command::spawn did neither. `p` is canonical and absolute, so it cannot read as an option.
        // The plain form: a canonical Windows path carries a `\\?\` prefix that the shell's file handler rejects.
        let inv = crate::os_open::open_url_invocation(crate::fsutil::current_os(), &crate::fsutil::plain_path(&p).to_string_lossy());
        crate::os_open::spawn(&inv).map_err(|e| FsError { code: e.code, message: e.message })?;
        Ok(())
    }).await
}

#[tauri::command]
pub async fn fs_copy(req: CopyReq) -> R<serde_json::Value> {
    dispatch("fs_copy", true, req, |r| serde_json::json!({"req": r}), |root, req| copy(&root, &req)).await
}

#[tauri::command]
pub async fn fs_delete(path: String) -> R<serde_json::Value> {
    dispatch("fs_delete", true, path, |v| serde_json::json!({"path": v}), |root, path| delete(&root, &path)).await
}
