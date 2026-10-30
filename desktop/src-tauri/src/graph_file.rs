//! `read_graph_file` core: reads a graph-kit `graph.json` only from inside the
//! active project root. The root is chosen by the host (environment), never by the
//! webview, so a compromised page cannot widen it.
//!
//! Both the root and the requested path are canonicalised before the prefix check,
//! so `..` segments and symlinks that point outside the root resolve to their real
//! location and are rejected.

use std::path::{Path, PathBuf};

/// Upper bound on a graph file the webview may load (the real graph is ~1 MB).
pub const GRAPH_FILE_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Used when neither `LLMIDE_POC_PROJECT_ROOT` nor `LLMIDE_POC_GRAPH` is set: the
/// spike's default project (the frontend's default graph path lives under it).
const DEFAULT_PROJECT_REL: &str = "Desktop/LLM/code/affiliate";

/// The active project root: `LLMIDE_POC_PROJECT_ROOT`, else the parent directory of
/// the `LLMIDE_POC_GRAPH` file, else the spike's default project under `$HOME`.
pub fn project_root() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    env("LLMIDE_POC_PROJECT_ROOT")
        .or_else(|| env("LLMIDE_POC_GRAPH").and_then(|g| g.parent().map(Path::to_path_buf)))
        .or_else(|| env("HOME").map(|h| h.join(DEFAULT_PROJECT_REL)))
}

/// Reads `path` if, after canonicalisation, it is a regular file named `graph.json`
/// located inside `root` and within the size limit.
pub fn read_within(root: &Path, path: &str) -> Result<String, String> {
    if path.is_empty() || path.contains('\0') {
        return Err("invalid path".into());
    }
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("project root {} is not available: {e}", root.display()))?;
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("cannot resolve {path}: {e}"))?;
    if !canonical.starts_with(&root) {
        return Err("path is outside the project root".into());
    }
    let is_graph = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "graph.json");
    if !is_graph {
        return Err("only files named graph.json can be read".into());
    }
    let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > GRAPH_FILE_MAX_BYTES {
        return Err("graph.json is not a regular file within the size limit".into());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("read failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-gf-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_graph_inside_root() {
        let root = scratch("ok");
        fs::create_dir_all(root.join("system/graph")).unwrap();
        let g = root.join("system/graph/graph.json");
        fs::write(&g, "{\"a\":1}").unwrap();
        assert_eq!(read_within(&root, g.to_str().unwrap()).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn rejects_other_filename() {
        let root = scratch("name");
        let f = root.join("secrets.json");
        fs::write(&f, "x").unwrap();
        assert!(read_within(&root, f.to_str().unwrap()).is_err());
    }

    #[test]
    fn rejects_graph_outside_root() {
        let root = scratch("in");
        let other = scratch("out");
        let g = other.join("graph.json");
        fs::write(&g, "{}").unwrap();
        let err = read_within(&root, g.to_str().unwrap()).unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn rejects_dotdot_traversal() {
        let root = scratch("dd");
        let other = scratch("dd-out");
        fs::write(other.join("graph.json"), "{}").unwrap();
        let sneaky = format!(
            "{}/../{}/graph.json",
            root.display(),
            other.file_name().unwrap().to_str().unwrap()
        );
        assert!(read_within(&root, &sneaky).unwrap_err().contains("outside"));
    }

    #[test]
    fn sibling_prefix_is_not_inside() {
        // /x/proj-evil must not pass a string-prefix check against /x/proj.
        let base = scratch("sib");
        let root = base.join("proj");
        let evil = base.join("proj-evil");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&evil).unwrap();
        fs::write(evil.join("graph.json"), "{}").unwrap();
        let p = evil.join("graph.json");
        assert!(read_within(&root, p.to_str().unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = scratch("sl");
        let other = scratch("sl-out");
        fs::write(other.join("graph.json"), "{}").unwrap();
        // directory symlink and file symlink, both pointing out of the root
        std::os::unix::fs::symlink(&other, root.join("linkdir")).unwrap();
        std::os::unix::fs::symlink(other.join("graph.json"), root.join("graph.json")).unwrap();
        assert!(read_within(&root, root.join("linkdir/graph.json").to_str().unwrap()).is_err());
        assert!(read_within(&root, root.join("graph.json").to_str().unwrap()).is_err());
    }

    #[test]
    fn rejects_empty_and_nul() {
        let root = scratch("e");
        assert!(read_within(&root, "").is_err());
        assert!(read_within(&root, "a\0b").is_err());
    }

    #[test]
    fn missing_root_is_an_error() {
        let root = scratch("m").join("nope");
        assert!(read_within(&root, "/etc/hosts").is_err());
    }
}
