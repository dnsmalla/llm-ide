//! Explorer change notifications for the active project root: the Tauri commands.
//!
//! The watcher itself (the OS notifier with a polling fallback, the non-recursive folder set, the debounced
//! and capped batches) lives in `llmide_workspace_core::watch`, shared with the SSH workspace helper. This
//! module keeps the one watcher of the desktop and connects its batches to the page's channel.

use std::sync::Mutex;

use tauri::ipc::Channel;

pub use llmide_workspace_core::watch::{WatchBatch, WatchStarted};
use llmide_workspace_core::watch::Watch;
use llmide_workspace_core::{FsError, R};

/// The one watcher of the desktop. Starting a new one drops the old, which stops its thread.
static WATCH: Mutex<Option<Watch>> = Mutex::new(None);

fn lock_error() -> FsError {
    FsError { code: "io", message: "watcher lock poisoned".into() }
}

/// Starts (replacing any previous) the watcher for the active root; batches arrive on `on_event`.
#[tauri::command]
pub fn fs_watch_start(on_event: Channel<WatchBatch>) -> R<WatchStarted> {
    let root = crate::fs_ops::active_root()?;
    let (w, mode) = Watch::start(&root, false, Box::new(move |b| {
        let _ = on_event.send(b);
    }))?;
    *WATCH.lock().map_err(|_| lock_error())? = Some(w);
    Ok(WatchStarted { mode })
}

#[tauri::command]
pub fn fs_watch_set(dirs: Vec<String>) -> R<()> {
    let mut g = WATCH.lock().map_err(|_| lock_error())?;
    match g.as_mut() {
        Some(w) => w.set_dirs(&dirs),
        None => Err(FsError { code: "no_watch", message: "the file watcher is not running".into() }),
    }
}

#[tauri::command]
pub fn fs_watch_stop() {
    if let Ok(mut g) = WATCH.lock() {
        *g = None;
    }
}

/// Called when the project changes or the app quits.
pub fn stop_all() {
    fs_watch_stop();
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
