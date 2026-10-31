//! Read-only project layout for Settings > Paths and > Memory.
//!
//! Every path is derived from the ACTIVE project root the host accepted (`project::active_root`); the webview
//! never supplies one. Nothing here writes, follows a path outside the root, or lists more than a bounded set.
//! "Show in Finder" goes through the existing `reveal_in_os`, which re-checks the path against the same root.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The canonical folders the Mac's Paths card talks about, relative to the project root.
pub const LAYOUT: &[&str] = &[
    "source",
    "source/meetings",
    "source/emails",
    "source/documents",
    "code",
    "data",
    "llm-doc",
    "llm-doc/plans",
    "llm-doc/generated",
    "templates",
    "commands",
    "system",
];

/// How many entries the Memory list may return.
pub const MAX_MEMORY_FILES: usize = 200;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Folder {
    /// The project-relative path, which is also the row title.
    pub name: String,
    pub exists: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    pub root: String,
    pub folders: Vec<Folder>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    /// File name only (never a path the page supplied).
    pub name: String,
    /// Project-relative path for `reveal_in_os`.
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphFile {
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemory {
    pub root: String,
    /// The first graph.json that exists (`system/graph/graph.json`, then `system/graph.json`), if any.
    pub graph: Option<GraphFile>,
    /// Direct children of `system/` that are plain files, newest name order, bounded.
    pub files: Vec<MemoryFile>,
}

fn folder(root: &Path, rel: &str) -> Folder {
    Folder { name: rel.to_string(), exists: root.join(rel).is_dir() }
}

/// The layout for a project root (pure; the command resolves the root).
pub fn folders(root: &Path) -> Vec<Folder> {
    LAYOUT.iter().map(|rel| folder(root, rel)).collect()
}

/// Files under `system/` that are safe to list: plain files, no dotfiles, no SQLite side files.
pub fn memory_files(root: &Path) -> Vec<MemoryFile> {
    let dir = root.join("system");
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<MemoryFile> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || is_db_file(&name) {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        out.push(MemoryFile { name: name.clone(), path: format!("system/{name}"), size_bytes: md.len() });
        if out.len() >= MAX_MEMORY_FILES {
            break;
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn is_db_file(name: &str) -> bool {
    name.ends_with(".db") || name.ends_with(".db-wal") || name.ends_with(".db-shm") || name.ends_with(".db-journal")
}

fn graph(root: &Path) -> Option<GraphFile> {
    for rel in ["system/graph/graph.json", "system/graph.json"] {
        let p = root.join(rel);
        if let Ok(md) = std::fs::metadata(&p) {
            if md.is_file() {
                return Some(GraphFile { path: rel.to_string(), size_bytes: md.len() });
            }
        }
    }
    None
}

pub fn memory(root: &Path) -> ProjectMemory {
    ProjectMemory { root: root.to_string_lossy().into_owned(), graph: graph(root), files: memory_files(root) }
}

fn active_root() -> Result<PathBuf, String> {
    crate::project::active_root().ok_or_else(|| "no project is open".to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(f).await.unwrap_or_else(|e| panic!("project layout task failed: {e}"))
}

#[tauri::command]
pub async fn project_paths() -> Result<Paths, String> {
    let root = active_root()?;
    Ok(blocking(move || Paths { root: root.to_string_lossy().into_owned(), folders: folders(&root) }).await)
}

#[tauri::command]
pub async fn project_memory() -> Result<ProjectMemory, String> {
    let root = active_root()?;
    Ok(blocking(move || memory(&root)).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-layout-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn every_layout_folder_is_reported_with_its_real_state() {
        let root = scratch("folders");
        fs::create_dir_all(root.join("system")).unwrap();
        fs::create_dir_all(root.join("llm-doc/plans")).unwrap();
        let rows = folders(&root);
        assert_eq!(rows.len(), LAYOUT.len());
        let get = |n: &str| rows.iter().find(|r| r.name == n).unwrap().exists;
        assert!(get("system"));
        assert!(get("llm-doc/plans"));
        assert!(get("llm-doc"), "a parent that exists is reported even when not listed itself");
        assert!(!get("source/meetings"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn memory_lists_plain_files_and_hides_databases_dotfiles_and_folders() {
        let root = scratch("memory");
        fs::create_dir_all(root.join("system/graph")).unwrap();
        fs::write(root.join("system/project.json"), "{}").unwrap();
        fs::write(root.join("system/memory.json"), "abc").unwrap();
        fs::write(root.join("system/data.db"), "x").unwrap();
        fs::write(root.join("system/data.db-wal"), "x").unwrap();
        fs::write(root.join("system/.hidden"), "x").unwrap();
        let names: Vec<String> = memory_files(&root).into_iter().map(|f| f.name).collect();
        assert_eq!(names, ["memory.json", "project.json"]);
        let files = memory_files(&root);
        assert_eq!(files[0].path, "system/memory.json");
        assert_eq!(files[0].size_bytes, 3);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_graph_is_found_in_either_candidate_and_reports_its_size() {
        let root = scratch("graph");
        fs::create_dir_all(root.join("system")).unwrap();
        assert_eq!(graph(&root), None);
        fs::write(root.join("system/graph.json"), "0123456789").unwrap();
        let g = graph(&root).unwrap();
        assert_eq!(g.path, "system/graph.json");
        assert_eq!(g.size_bytes, 10);
        fs::create_dir_all(root.join("system/graph")).unwrap();
        fs::write(root.join("system/graph/graph.json"), "{}").unwrap();
        assert_eq!(graph(&root).unwrap().path, "system/graph/graph.json", "the nested candidate wins");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_project_reports_no_graph_and_no_memory_files() {
        let root = scratch("empty");
        let m = memory(&root);
        assert!(m.graph.is_none());
        assert!(m.files.is_empty());
        assert_eq!(m.root, root.to_string_lossy());
        let _ = fs::remove_dir_all(&root);
    }
}
