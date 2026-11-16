//! Project scaffold and layout, shared by the desktop host and the SSH workspace helper.
//!
//! - `scaffold`: the New project folder, the project marker (`system/project.json`) and the write-if-absent
//!   scaffold that Rebuild also runs. A port of the Mac's `ProjectScaffolder`; the templates are byte-stable.
//! - `layout`: the read-only Paths and Memory views of a project root, and `is_project`, the marker check.

pub mod layout;
pub mod scaffold;
