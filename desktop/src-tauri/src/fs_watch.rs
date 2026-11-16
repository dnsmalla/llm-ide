//! Explorer change notifications for the active project root: the Tauri commands.
//!
//! The watcher itself (the OS notifier with a polling fallback, the non-recursive folder set, the debounced
//! and capped batches) lives in `llmide_workspace_core::watch`, shared with the SSH workspace helper. This
//! module keeps the one watcher of the desktop and connects its batches to the page's channel.

use std::sync::Mutex;

use std::sync::Arc;

use tauri::ipc::Channel;

pub use llmide_workspace_core::watch::WatchStarted;
use llmide_workspace_core::watch::Watch;
use llmide_workspace_core::{FsError, R};

use crate::workspace_backend::{self, LinkConnector, Sink};

/// The one watcher of the desktop. Starting a new one drops the old, which stops its thread.
static WATCH: Mutex<Option<Watch>> = Mutex::new(None);

fn lock_error() -> FsError {
    FsError { code: "io", message: "watcher lock poisoned".into() }
}

/// Starts (replacing any previous) the watcher for the active root; batches arrive on `on_event`. SSH mode watches
/// the server folder instead, and its batches go to the same channel.
#[tauri::command]
pub async fn fs_watch_start(on_event: Channel<serde_json::Value>) -> R<serde_json::Value> {
    if workspace_backend::is_ssh_mode() {
        let sink: Sink = Arc::new(move |data| {
            let _ = on_event.send(data);
        });
        return tauri::async_runtime::spawn_blocking(move || workspace_backend::remote().watch_start(&LinkConnector, sink))
            .await
            .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") })?;
    }
    let root = crate::fs_ops::active_root()?;
    let (w, mode) = Watch::start(&root, false, Box::new(move |b| {
        let _ = on_event.send(serde_json::to_value(&b).unwrap_or(serde_json::Value::Null));
    }))?;
    *WATCH.lock().map_err(|_| lock_error())? = Some(w);
    serde_json::to_value(&WatchStarted { mode }).map_err(|_| lock_error())
}

#[tauri::command]
pub async fn fs_watch_set(dirs: Vec<String>) -> R<()> {
    if workspace_backend::is_ssh_mode() {
        tauri::async_runtime::spawn_blocking(move || workspace_backend::remote().watch_set(&LinkConnector, dirs).map(|_| ()))
            .await
            .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") })?
    } else {
        let mut g = WATCH.lock().map_err(|_| lock_error())?;
        match g.as_mut() {
            Some(w) => w.set_dirs(&dirs),
            None => Err(FsError { code: "no_watch", message: "the file watcher is not running".into() }),
        }
    }
}

#[tauri::command]
pub async fn fs_watch_stop() -> R<()> {
    if workspace_backend::is_ssh_mode() {
        return tauri::async_runtime::spawn_blocking(|| workspace_backend::remote().watch_stop())
            .await
            .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") });
    }
    stop_local();
    Ok(())
}

fn stop_local() {
    if let Ok(mut g) = WATCH.lock() {
        *g = None;
    }
}

/// Called when the project changes or the app quits.
pub fn stop_all() {
    stop_local();
}

/// Is a watcher installed (for the root that was active when it started)?
#[cfg(test)]
pub(crate) fn running() -> bool {
    WATCH.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Installs a watcher on `root` with a no-op sink (project tests). Polling keeps it portable under test.
#[cfg(test)]
pub(crate) fn install_for_test(root: &std::path::Path) {
    let (w, _) = Watch::start(root, true, Box::new(|_| {})).expect("watch");
    *WATCH.lock().unwrap() = Some(w);
}
