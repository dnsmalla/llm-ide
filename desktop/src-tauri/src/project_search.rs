//! Project-wide text search for the Explorer's Search panel: the Tauri commands.
//!
//! The search itself (the walk, the matcher, the output bounds, cancellation) lives in
//! `llmide_workspace_core::search`, shared with the SSH workspace helper. This module adds what only the
//! desktop has: the active project root, the Tauri channel, and the guarantee that the page always gets a
//! closing `Done` event.
//!
//! - The root is `fs_ops::active_root()`, re-validated on every search. The webview sends only a query and
//!   relative globs / relative file names; every path returned is relative.
//! - One search at a time: starting one cancels the previous; `project_search_cancel` stops it.

use std::sync::atomic::Ordering;

use std::sync::Arc;

use tauri::ipc::Channel;

pub use llmide_workspace_core::search::{aborted_done, run_search, validate, Query, SearchEvent, Searches, Started};
use llmide_workspace_core::{FsError, R};

use crate::fs_ops::active_root;
use crate::workspace_backend::{self, LinkConnector, Sink};

/// The desktop's one search registry. The core keeps the current id, the cancel flag and the run lock here.
static SEARCHES: Searches = Searches::new();

/// Validates the query (a bad pattern is an immediate `invalid_query` error), cancels any running
/// search and starts this one on a blocking thread. Events arrive on `on_event`.
#[tauri::command]
pub async fn project_search_start(req: Query, on_event: Channel<serde_json::Value>) -> R<Started> {
    if workspace_backend::is_ssh_mode() {
        return remote_search_start(req, on_event).await;
    }
    let root = active_root()?;
    validate(&req)?;
    let (id, cancel) = SEARCHES.begin();
    tauri::async_runtime::spawn_blocking(move || {
        let _running = SEARCHES.run_lock();
        // A newer search may have cancelled this one while it waited for the lock.
        if cancel.load(Ordering::Relaxed) {
            let _ = on_event.send(serde_json::to_value(aborted_done(id)).unwrap_or(serde_json::Value::Null));
            SEARCHES.finish(id);
            return;
        }
        let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // The page gets the same JSON the helper sends, so the channel carries a value, not the enum.
        let mut sink = |ev: SearchEvent| on_event.send(serde_json::to_value(&ev).unwrap_or(serde_json::Value::Null)).is_ok();
            run_search(&root, &req, id, &cancel, &mut sink)
        }));
        // `Done` is always sent: on a late error (a path went away) and on a panic too.
        if !matches!(ran, Ok(Ok(()))) {
            let _ = on_event.send(serde_json::to_value(aborted_done(id)).unwrap_or(serde_json::Value::Null));
        }
        SEARCHES.finish(id);
    });
    Ok(Started { id })
}

/// SSH mode: the search runs on the server. Its events reach the page's channel as the helper sends them.
async fn remote_search_start(req: Query, on_event: Channel<serde_json::Value>) -> R<Started> {
    let query = serde_json::to_value(&req).map_err(|e| FsError { code: "internal", message: format!("cannot encode the search: {e}") })?;
    let sink: Sink = Arc::new(move |data| {
        let _ = on_event.send(data);
    });
    tauri::async_runtime::spawn_blocking(move || {
        let answer = workspace_backend::remote().search_start(&LinkConnector, query, sink)?;
        serde_json::from_value::<Started>(answer).map_err(|_| FsError { code: "bad_response", message: "The server sent an answer this app does not understand.".into() })
    })
    .await
    .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") })?
}

#[tauri::command]
pub async fn project_search_cancel(id: u64) {
    if !workspace_backend::is_ssh_mode() {
        SEARCHES.cancel(id);
        return;
    }
    let _ = tauri::async_runtime::spawn_blocking(move || workspace_backend::remote().search_cancel(id)).await;
}
