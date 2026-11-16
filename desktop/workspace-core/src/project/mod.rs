//! Project scaffold and layout, shared by the desktop host and the SSH workspace helper.
//!
//! - `scaffold`: the New project folder, the project marker (`system/project.json`) and the write-if-absent
//!   scaffold that Rebuild also runs. A port of the Mac's `ProjectScaffolder`; the templates are byte-stable.
//! - `layout`: the read-only Paths and Memory views of a project root, and `is_project`, the marker check.
//! - `clone`: cloning a saved repository into `code/` (validation, the token rule, a cancellable git run).
//! - `existing_clone`: adopting a `code/` folder that is already a clone of the requested repository.
//! - `graph`: the confined read of a graph-kit `graph.json` inside a project root.

pub mod clone;
pub mod existing_clone;
pub mod graph;
pub mod layout;
pub mod scaffold;
