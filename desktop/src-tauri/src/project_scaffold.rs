//! New project for the desktop: a thin wrapper over `llmide_workspace_core::project::scaffold`, where the scaffold
//! moved so the SSH workspace helper runs the same code. The desktop supplies its own home directory.

use std::path::{Path, PathBuf};

pub use llmide_workspace_core::project::scaffold::{scaffold, validate_name, NewProject};

/// Creates `<parent>/<name>` and scaffolds it. Returns the canonical project root.
pub fn create_project(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let (root, _) = llmide_workspace_core::project::scaffold::create_project(parent, name, &crate::project::local_home())?;
    Ok(root)
}
