//! Desktop side of the graph-file read: the active project root is chosen by the host (environment or the opened
//! project), never by the webview. The confined read itself (`read_within`) is shared with the SSH helper and lives
//! in `llmide_workspace_core::project::graph`.

use std::path::PathBuf;

use llmide_workspace_core::{FsError, R};
use serde_json::json;

use crate::workspace_backend::{self, Connector, Remote};


pub(crate) use llmide_workspace_core::paths::fd_path;
pub(crate) use llmide_workspace_core::project::graph::read_within;

/// Used when neither `LLMIDE_POC_PROJECT_ROOT` nor `LLMIDE_POC_GRAPH` is set: the
/// spike's default project (the frontend's default graph path lives under it).
#[cfg(debug_assertions)]
const DEFAULT_PROJECT_REL: &str = "Desktop/LLM/code/affiliate";

/// The active project root: the folder opened through `project_open*` (host dialog).
/// Debug builds only fall back to `LLMIDE_POC_PROJECT_ROOT`, the parent of
/// `LLMIDE_POC_GRAPH`, then the spike's default project under `$HOME`; a release
/// build has no environment or default root, so nothing is readable until the user
/// opens a project.
/// SSH branch of `read_graph_file`: the helper reads `path` under the open server folder with `graph_read`.
/// The helper keeps the read inside that folder; the local root is never used.
pub(crate) fn ssh_read(remote: &Remote, connector: &dyn Connector, path: &str) -> R<String> {
    let answer = workspace_backend::project_call_with(remote, connector, "graph_read", json!({"path": path}))?;
    answer.as_str().map(str::to_string).ok_or_else(|| FsError {
        code: "bad_response",
        message: "The server sent an answer this app does not understand.".into(),
    })
}

pub fn project_root() -> Option<PathBuf> {
    if let Some(active) = crate::project::active_root() {
        return Some(active);
    }
    #[cfg(debug_assertions)]
    {
        let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        return env("LLMIDE_POC_PROJECT_ROOT")
            .or_else(|| env("LLMIDE_POC_GRAPH").and_then(|g| g.parent().map(std::path::Path::to_path_buf)))
            .or_else(|| env("HOME").map(|h| h.join(DEFAULT_PROJECT_REL)));
    }
    #[cfg(not(debug_assertions))]
    None
}
