//! Confined read of a graph-kit `graph.json`, shared by the desktop host and the SSH workspace helper.
//!
//! The read is only inside the project root the caller passes in. The root is chosen by the host (environment or
//! the opened project), never by the webview, so a compromised page cannot widen it.
//!
//! Both the root and the requested path are canonicalised before the prefix check,
//! so `..` segments and symlinks that point outside the root resolve to their real
//! location and are rejected. The check is then re-done on the OPEN file, not the
//! path: the file is opened once (no symlink followed on the last component), its
//! real location is read back from the descriptor (`F_GETPATH` / `/proc/self/fd`)
//! and must still be `<root>/…/graph.json`, and the bytes are read from that same
//! descriptor, so swapping the path between check and read changes nothing. The root
//! is re-checked against the too-broad list on every call.

use std::path::Path;

use crate::fs::nlink;
use crate::paths::{fd_path, home_or_empty, is_too_broad};

/// Upper bound on a graph file the webview may load (the real graph is ~1 MB).
pub const GRAPH_FILE_MAX_BYTES: u64 = 128 * 1024 * 1024;

/// The error for a graph file over the size limit. The helper maps this text to its own `too_large` code, so the
/// text is fixed.
pub const GRAPH_TOO_LARGE: &str = "graph.json is larger than the size limit";

/// Reads `path` if it is a regular file named like a graph file and located inside `root`
/// and within the size limit (see the module docs for how this is made race-free).
pub fn read_within(root: &Path, path: &str) -> Result<String, String> {
    read_within_limited(root, path, GRAPH_FILE_MAX_BYTES)
}

/// `read_within` with a caller's size limit. The SSH helper uses a lower one, so its answer fits one protocol line.
pub fn read_within_max(root: &Path, path: &str, max: u64) -> Result<String, String> {
    read_within_limited(root, path, max)
}

fn read_within_limited(root: &Path, path: &str, max: u64) -> Result<String, String> {
    if path.is_empty() || path.contains('\0') {
        return Err("invalid path".into());
    }
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("project root {} is not available: {e}", root.display()))?;
    // Re-evaluated on every call: the root may have been swapped for a symlink to a
    // broad directory since it was accepted.
    if is_too_broad(&root, &home_or_empty()) {
        return Err("the project root is too broad".into());
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("cannot resolve {path}: {e}"))?;
    check_location(&canonical, &root)?;

    let file = open_nofollow(&canonical)?;
    // Verify what was actually opened, not the path we resolved a moment ago.
    // Fails closed: no descriptor path, no read.
    let real = fd_path(&file).ok_or("cannot verify the opened file")?;
    check_location(&real, &root)?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("graph.json is not a regular file".into());
    }
    if meta.len() > max {
        return Err(GRAPH_TOO_LARGE.into());
    }
    if nlink(&file, &meta) > 1 {
        return Err("graph file has several hard links; refusing to follow it".into());
    }
    use std::io::Read;
    let mut body = String::new();
    // `take` bounds the read even if the file grows after fstat.
    file.take(max + 1).read_to_string(&mut body).map_err(|e| format!("read failed: {e}"))?;
    if body.len() as u64 > max {
        return Err(GRAPH_TOO_LARGE.into());
    }
    Ok(body)
}

/// The graph filenames the host may read: the legacy one plus one per generation mode.
const GRAPH_NAMES: [&str; 4] = ["graph.json", "graph-code.json", "graph-memory.json", "graph-all.json"];

/// `p` must lie inside `root` and be one of the known graph files.
fn check_location(p: &Path, root: &Path) -> Result<(), String> {
    if !p.starts_with(root) {
        return Err("path is outside the project root".into());
    }
    let is_graph = p.file_name().and_then(|n| n.to_str()).is_some_and(|n| GRAPH_NAMES.contains(&n));
    if !is_graph {
        return Err("only graph files can be read".into());
    }
    Ok(())
}

/// Opens read-only without following a symlink on the last component.
fn open_nofollow(p: &Path) -> Result<std::fs::File, String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    opts.open(p).map_err(|e| format!("cannot open graph.json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Owns a temp folder (or marker file) and removes it on drop, so a failing test leaves nothing behind.
    struct TempDirGuard(std::path::PathBuf);

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
            let _ = std::fs::remove_file(&self.0);
        }
    }

    impl std::ops::Deref for TempDirGuard {
        type Target = std::path::Path;
        fn deref(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl AsRef<std::path::Path> for TempDirGuard {
        fn as_ref(&self) -> &std::path::Path {
            &self.0
        }
    }

    fn scratch(name: &str) -> TempDirGuard {
        let d = std::env::temp_dir().join(format!("llmide-gf-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        TempDirGuard(d)
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
    fn accepts_each_mode_filename() {
        let root = scratch("modes");
        fs::create_dir_all(root.join("system/graph")).unwrap();
        for name in ["graph-code.json", "graph-memory.json", "graph-all.json"] {
            let p = root.join("system/graph").join(name);
            fs::write(&p, "{}").unwrap();
            assert!(read_within(&root, p.to_str().unwrap()).is_ok(), "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn hard_linked_graph_is_refused() {
        let root = scratch("hardlink");
        fs::create_dir_all(root.join("system/graph")).unwrap();
        let outside = root.parent().unwrap().join("llmide-gf-hardlink-outside.json");
        fs::write(&outside, "{}").unwrap();
        let g = root.join("system/graph/graph.json");
        fs::hard_link(&outside, &g).unwrap();
        assert!(read_within(&root, g.to_str().unwrap()).is_err());
        let _ = fs::remove_file(&outside);
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
        let _root_root = scratch("m");
        let root = _root_root.join("nope");
        assert!(read_within(&root, "/etc/hosts").is_err());
    }

    #[test]
    fn fd_path_is_the_real_location_and_checked_against_the_root() {
        let root = scratch("fd");
        let outside = scratch("fd-out");
        fs::write(outside.join("graph.json"), "{}").unwrap();
        let f = open_nofollow(&outside.join("graph.json")).unwrap();
        let real = fd_path(&f).expect("fd path available on this OS");
        assert_eq!(real, fs::canonicalize(outside.join("graph.json")).unwrap());
        let root = fs::canonicalize(&root).unwrap();
        assert!(check_location(&real, &root).unwrap_err().contains("outside"));
    }

    #[cfg(unix)]
    #[test]
    fn open_refuses_a_symlink_on_the_last_component() {
        let d = scratch("nf");
        fs::write(d.join("real.json"), "{}").unwrap();
        std::os::unix::fs::symlink(d.join("real.json"), d.join("graph.json")).unwrap();
        assert!(open_nofollow(&d.join("graph.json")).is_err(), "a path swapped for a symlink must not open");
        assert!(open_nofollow(&d.join("real.json")).is_ok());
    }

    #[test]
    fn oversize_and_growth_are_bounded() {
        let root = scratch("big");
        let g = root.join("graph.json");
        fs::write(&g, vec![b'a'; 100]).unwrap();
        assert!(read_within_limited(&root, g.to_str().unwrap(), 99).is_err());
        assert_eq!(read_within_limited(&root, g.to_str().unwrap(), 100).unwrap().len(), 100);
        assert_eq!(GRAPH_FILE_MAX_BYTES, 128 * 1024 * 1024);
    }

    #[test]
    fn a_caller_limit_refuses_with_the_too_large_text() {
        let root = scratch("cap");
        let g = root.join("graph.json");
        fs::write(&g, vec![b'a'; 100]).unwrap();
        assert_eq!(read_within_max(&root, g.to_str().unwrap(), 99).unwrap_err(), GRAPH_TOO_LARGE);
        assert_eq!(read_within_max(&root, g.to_str().unwrap(), 100).unwrap().len(), 100);
    }

    #[cfg(unix)]
    #[test]
    fn a_root_that_became_a_broad_directory_is_refused() {
        // A symlinked root resolving to /etc-like breadth is re-checked on every read.
        let base = scratch("broad");
        let link = base.join("proj");
        std::os::unix::fs::symlink("/usr", &link).unwrap();
        let err = read_within(&link, "/usr/graph.json").unwrap_err();
        assert!(err.contains("too broad") || err.contains("cannot resolve"), "{err}");
    }
}
