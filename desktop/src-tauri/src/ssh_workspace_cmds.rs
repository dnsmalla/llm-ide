//! Tauri commands for the server folder picker: browse the server's home folder, create a folder, open one, and
//! manage the recent folders of the saved server.
//!
//! The picker runs before any folder is open, so it needs a helper channel but no open folder. The recent folders
//! are filed under the saved server's key (`<user>@<host>:<port>`), the same key the recent servers use. Every
//! command runs its blocking work off the UI thread.

use llmide_workspace_core::{FsError, R};
use serde_json::Value;

use crate::prefs;
use crate::project::ProjectInfo;
use crate::workspace_backend::{self, LinkConnector};

/// Runs a blocking step off the UI thread and turns a failed task into an error the page can show.
async fn blocking<T, F>(f: F) -> R<T>
where
    T: Send + 'static,
    F: FnOnce() -> R<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") })?
}

/// The key the recent folders of the saved server are filed under.
fn current_server_key() -> String {
    let server = prefs::stored().remote_server;
    prefs::ssh_server_key(&server.user, &server.host, server.port)
}

/// Lists the folders in a folder on the server, under its home. `path` is `~` or an absolute path on the server.
#[tauri::command]
pub async fn remote_ssh_workspace_list_dirs(path: String, hidden: bool) -> R<Value> {
    blocking(move || workspace_backend::remote().list_dirs(&LinkConnector, &path, hidden)).await
}

/// Creates one folder inside a folder under the home. `name` is a single path component.
#[tauri::command]
pub async fn remote_ssh_workspace_mkdir(path: String, name: String) -> R<Value> {
    blocking(move || workspace_backend::remote().mkdir(&LinkConnector, &path, &name)).await
}

/// Remembers an opened server folder under the saved server. A failure to remember it does not undo the open.
fn remember_opened(info: &ProjectInfo) {
    if let Err(e) = prefs::record_ssh_recent_folder(&current_server_key(), &info.root) {
        eprintln!("ssh workspace: recent folder not saved: {}", e.code);
    }
}

/// Opens a folder on the server as the active project and remembers it under the saved server. A failure to
/// remember it does not undo the open.
#[tauri::command]
pub async fn remote_ssh_workspace_open(path: String) -> R<ProjectInfo> {
    blocking(move || {
        let info = workspace_backend::remote().open(&LinkConnector, &path)?;
        remember_opened(&info);
        Ok(info)
    })
    .await
}

/// New project on the server: creates `<parent>/<name>` on the server, then opens it like `remote_ssh_workspace_open`.
/// The helper refuses a name that exists and a parent outside the server home, and writes nothing in either case.
#[tauri::command]
pub async fn remote_ssh_project_create(parent: String, name: String) -> R<ProjectInfo> {
    blocking(move || {
        let info = workspace_backend::remote().project_create(&LinkConnector, &parent, &name)?;
        remember_opened(&info);
        Ok(info)
    })
    .await
}

/// Closes the open server folder and the helper channel. Nothing on the server is changed.
#[tauri::command]
pub async fn remote_ssh_workspace_close() -> R<()> {
    blocking(|| {
        workspace_backend::reset();
        Ok(())
    })
    .await
}

/// The recent folders of the saved server, most recent first.
#[tauri::command]
pub async fn remote_ssh_workspace_recent() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| prefs::ssh_recent_folders(&current_server_key()))
        .await
        .unwrap_or_default()
}

/// Removes one folder from the saved server's recent list. Nothing on the server is changed.
#[tauri::command]
pub async fn remote_ssh_workspace_forget(path: String) -> R<()> {
    blocking(move || prefs::forget_ssh_recent_folder(&current_server_key(), &path)).await
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// The commands the page calls, which must be registered in the three places a Tauri command needs.
    const COMMANDS: &[&str] = &[
        "remote_ssh_workspace_list_dirs",
        "remote_ssh_workspace_mkdir",
        "remote_ssh_workspace_open",
        "remote_ssh_workspace_close",
        "remote_ssh_workspace_recent",
        "remote_ssh_workspace_forget",
        "remote_ssh_project_create",
    ];

    #[test]
    fn every_workspace_command_is_registered() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let build = std::fs::read_to_string(root.join("build.rs")).unwrap();
        let grants = std::fs::read_to_string(root.join("capabilities").join("default.json")).unwrap();
        let lib = std::fs::read_to_string(root.join("src").join("lib.rs")).unwrap();
        for name in COMMANDS {
            assert!(build.contains(&format!("\"{name}\"")), "build.rs COMMANDS misses {name}");
            let grant = format!("\"allow-{}\"", name.replace('_', "-"));
            assert!(grants.contains(&grant), "default.json misses {grant}");
            assert!(lib.contains(&format!("ssh_workspace_cmds::{name},")), "lib.rs handler list misses {name}");
        }
    }
}
