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

use tauri::ipc::Channel;

pub use llmide_workspace_core::search::{aborted_done, run_search, validate, Query, SearchEvent, Searches, Started};
use llmide_workspace_core::R;

use crate::fs_ops::active_root;

/// The desktop's one search registry. The core keeps the current id, the cancel flag and the run lock here.
static SEARCHES: Searches = Searches::new();

/// Validates the query (a bad pattern is an immediate `invalid_query` error), cancels any running
/// search and starts this one on a blocking thread. Events arrive on `on_event`.
#[tauri::command]
pub async fn project_search_start(req: Query, on_event: Channel<SearchEvent>) -> R<Started> {
    let root = active_root()?;
    validate(&req)?;
    let (id, cancel) = SEARCHES.begin();
    tauri::async_runtime::spawn_blocking(move || {
        let _running = SEARCHES.run_lock();
        // A newer search may have cancelled this one while it waited for the lock.
        if cancel.load(Ordering::Relaxed) {
            let _ = on_event.send(aborted_done(id));
            SEARCHES.finish(id);
            return;
        }
        let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut sink = |ev: SearchEvent| on_event.send(ev).is_ok();
            run_search(&root, &req, id, &cancel, &mut sink)
        }));
        // `Done` is always sent: on a late error (a path went away) and on a panic too.
        if !matches!(ran, Ok(Ok(()))) {
            let _ = on_event.send(aborted_done(id));
        }
        SEARCHES.finish(id);
    });
    Ok(Started { id })
}

#[tauri::command]
pub fn project_search_cancel(id: u64) {
    SEARCHES.cancel(id);
}
