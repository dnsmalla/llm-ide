//! Project setup on the server: New project (`project_create`), the Paths and Memory views of the open folder, and
//! Rebuild. The core does the file work. This module applies the server home rules, maps the core's messages to
//! wire codes and shapes the replies. Every write goes through the core's write-if-absent scaffold.

use std::path::Path;

use llmide_workspace_core::project::graph::{read_within_max, GRAPH_TOO_LARGE};
use llmide_workspace_core::project::{layout, scaffold};
use llmide_workspace_core::{err, FsError, R};
use serde_json::Value;

use crate::protocol::MAX_LINE_BYTES;
use llmide_workspace_core::wire::ProjectCreated;
use crate::session::{home_path, home_root, to_value, Session};

/// The largest graph file the helper reads. A real graph is about 1 MB, so this only refuses a file that could not
/// be sent back in one line anyway.
pub const GRAPH_MAX_FILE_BYTES: u64 = 48 * 1024 * 1024;

/// The room a graph answer needs around its text (the request id and the envelope). The answer must fit one line.
const ANSWER_ENVELOPE_BYTES: usize = 4096;

/// The text the desktop shows for a folder without `system/project.json`. Fixed, because the app matches the code.
pub const NOT_A_PROJECT_MESSAGE: &str = "This folder is not an LLM-IDE project.";

/// Creates `<parent>/<name>` and scaffolds it. The parent must be inside the server home, and the home itself is a
/// valid parent (`~/name` is a project, as it is locally). The core still refuses a target that is too broad.
/// Needs no open folder and opens none.
pub fn create(parent_raw: &str, name_raw: &str) -> R<Value> {
    let name = scaffold::validate_name(name_raw).map_err(|message| FsError { code: "invalid_name", message })?;
    let home = home_root()?;
    let parent = home_path(parent_raw)?;
    let (root, project) = scaffold::create_project(&parent, &name, &home).map_err(scaffold_error)?;
    to_value(&ProjectCreated { root: root.to_string_lossy().into_owned(), id: project.id, name: project.display_name })
}

/// The Paths card for the open folder. A folder without the project marker is still answered, with `isProject`
/// false, so the desktop can show its notice.
pub fn paths(session: &Session) -> R<Value> {
    to_value(&layout::paths(&session.root()?))
}

/// The Memory card for the open folder: the graph file (if any) and the plain files under `system/`.
pub fn memory(session: &Session) -> R<Value> {
    to_value(&layout::memory(&session.root()?))
}

/// Recreates the missing scaffold folders and files of an existing project. Refuses a folder without the marker
/// before anything is written, and never overwrites a file that exists.
pub fn rebuild(session: &Session) -> R<Value> {
    let root = session.root()?;
    if !layout::is_project(&root) {
        return err("not_a_project", NOT_A_PROJECT_MESSAGE);
    }
    scaffold::scaffold(&root, &layout::project_meta(&root)).map_err(scaffold_error)?;
    Ok(Value::Null)
}

/// The graph file under the open folder, as the answer `graph_read` sends. A file over 48 MiB is `too_large`, and so is
/// an answer whose JSON encoding would not fit one protocol line: the escapes can make the encoding longer than the file.
pub fn graph_read(root: &Path, path: &str) -> R<Value> {
    graph_read_capped(root, path, GRAPH_MAX_FILE_BYTES, MAX_LINE_BYTES - ANSWER_ENVELOPE_BYTES)
}

/// `graph_read` with the limits given, so a test can check the encoded-size rule with small numbers.
pub(crate) fn graph_read_capped(root: &Path, path: &str, max_file: u64, max_answer: usize) -> R<Value> {
    let body = read_within_max(root, path, max_file).map_err(|message| {
        let code = if message == GRAPH_TOO_LARGE { "too_large" } else { "graph_read_failed" };
        FsError { code, message }
    })?;
    let encoded_len = serde_json::to_string(&body).map_or(usize::MAX, |text| text.len());
    if encoded_len > max_answer {
        return err("too_large", GRAPH_TOO_LARGE);
    }
    Ok(Value::String(body))
}

/// Maps the core's scaffold messages to wire codes. The core reports plain text, so this matches the stable phrases
/// it uses. Any other failure is an I/O error.
fn scaffold_error(message: String) -> FsError {
    let code = if message.contains("already exists") {
        "already_exists"
    } else if message.contains("too broad") {
        "root_too_broad"
    } else {
        "io"
    };
    FsError { code, message }
}
