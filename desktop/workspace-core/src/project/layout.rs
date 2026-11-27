//! Read-only project layout for Settings > Paths and > Memory, and the project marker it reads.
//!
//! Every function takes the project root the caller has already accepted; nothing here writes, follows a path
//! outside the root, or lists more than a bounded set. The desktop and the SSH helper both call these.

use std::path::Path;

use serde::Serialize;

use super::scaffold::NewProject;

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
pub(crate) const MAX_MEMORY_FILES: usize = 200;

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
    /// The KB project id from system/project.json (the id meetings/plans are tagged with).
    pub id: String,
    pub folders: Vec<Folder>,
    /// True when `system/project.json` is a file. A folder without it is not an LLM-IDE project.
    pub is_project: bool,
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

/// True when `system/project.json` is a file. A directory of that name does not count.
pub fn is_project(root: &Path) -> bool {
    root.join("system/project.json").is_file()
}

/// The Paths card for a root: its id, the canonical folders and whether the folder is a project.
pub fn paths(root: &Path) -> Paths {
    Paths {
        root: root.to_string_lossy().into_owned(),
        id: project_meta(root).id,
        folders: folders(root),
        is_project: is_project(root),
    }
}

/// Files under `system/` that are safe to list: plain files, no dotfiles, no SQLite side files.
pub(crate) fn memory_files(root: &Path) -> Vec<MemoryFile> {
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

/// The Memory card for a root: the graph file (if any) and the plain files under `system/`.
pub fn memory(root: &Path) -> ProjectMemory {
    ProjectMemory { root: root.to_string_lossy().into_owned(), graph: graph(root), files: memory_files(root) }
}

/// The project marker's metadata, or a fresh identity derived from the folder name when the marker is missing.
/// Never invents a different display name when the marker exists.
pub fn project_meta(root: &Path) -> NewProject {
    let fallback_name = crate::text::folder_display_name(root);
    let text = std::fs::read_to_string(root.join("system/project.json")).unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let str_of = |key: &str| v.get(key).and_then(|x| x.as_str()).map(str::to_string);
    let language = v.get("settings").and_then(|s| s.get("language")).and_then(|x| x.as_str()).map(str::to_string);
    let mut p = NewProject::fresh(&str_of("displayName").unwrap_or(fallback_name));
    if let Some(id) = str_of("id") {
        if !id.is_empty() { p.id = id; }
    }
    if let Some(created) = str_of("createdAt") {
        if !created.is_empty() { p.created_iso = created; }
    }
    if let Some(lang) = language {
        if !lang.is_empty() { p.language = lang; }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

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
    fn project_meta_fallback_name_matches_open_time_scaffolding() {
        // Same plain folder must get one display name whether it was scaffolded on open or by Rebuild.
        let bare = scratch("bare-name");
        assert_eq!(project_meta(&bare).display_name, crate::text::folder_display_name(&bare));
        let _ = fs::remove_dir_all(&bare);
    }

    #[test]
    fn project_meta_preserves_the_marker_and_falls_back_to_the_folder_name() {
        let root = scratch("meta");
        fs::create_dir_all(root.join("system")).unwrap();
        fs::write(
            root.join("system/project.json"),
            r#"{"schemaVersion":1,"id":"p-123","displayName":"My Project","createdAt":"2026-10-01T00:00:00Z","settings":{"language":"ja"}}"#,
        ).unwrap();
        let p = project_meta(&root);
        assert_eq!(p.id, "p-123");
        assert_eq!(p.display_name, "My Project");
        assert_eq!(p.created_iso, "2026-10-01T00:00:00Z");
        assert_eq!(p.language, "ja");
        let bare = scratch("bare-meta");
        let q = project_meta(&bare);
        assert_eq!(q.display_name, crate::text::folder_display_name(&bare));
        assert!(!q.id.is_empty());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&bare);
    }

    #[test]
    fn rebuild_folders_recreates_missing_directories_without_touching_files() {
        let root = scratch("rebuild");
        fs::write(root.join("README.md"), "mine").unwrap();
        crate::project::scaffold::scaffold(&root, &project_meta(&root)).unwrap();
        assert!(root.join("code").is_dir());
        assert!(root.join("llm-doc/plans").is_dir());
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "mine", "existing files are never overwritten");
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

    #[test]
    fn is_project_needs_the_marker_file() {
        let root = scratch("is-project");
        assert!(!is_project(&root), "an empty folder is not a project");
        fs::create_dir_all(root.join("system/project.json")).unwrap();
        assert!(!is_project(&root), "a directory named like the marker is not a project");
        fs::remove_dir(root.join("system/project.json")).unwrap();
        fs::write(root.join("system/project.json"), "{}").unwrap();
        assert!(is_project(&root));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn paths_reports_is_project() {
        let root = scratch("paths-is-project");
        assert!(!paths(&root).is_project);
        let json = serde_json::to_value(paths(&root)).unwrap();
        assert_eq!(json["isProject"], false, "serialized camelCase");
        fs::create_dir_all(root.join("system")).unwrap();
        fs::write(root.join("system/project.json"), "{}").unwrap();
        assert!(paths(&root).is_project);
        assert_eq!(serde_json::to_value(paths(&root)).unwrap()["isProject"], true);
        let _ = fs::remove_dir_all(&root);
    }
}
