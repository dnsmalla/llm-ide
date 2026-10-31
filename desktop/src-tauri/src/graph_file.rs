//! `read_graph_file` core: reads a graph-kit `graph.json` only from inside the
//! active project root. The root is chosen by the host (environment), never by the
//! webview, so a compromised page cannot widen it.
//!
//! Both the root and the requested path are canonicalised before the prefix check,
//! so `..` segments and symlinks that point outside the root resolve to their real
//! location and are rejected. The check is then re-done on the OPEN file, not the
//! path: the file is opened once (no symlink followed on the last component), its
//! real location is read back from the descriptor (`F_GETPATH` / `/proc/self/fd`)
//! and must still be `<root>/…/graph.json`, and the bytes are read from that same
//! descriptor, so swapping the path between check and read changes nothing. The root
//! is re-checked against the too-broad list on every call.

use std::path::{Path, PathBuf};

/// Upper bound on a graph file the webview may load (the real graph is ~1 MB).
pub const GRAPH_FILE_MAX_BYTES: u64 = 32 * 1024 * 1024;

/// Used when neither `LLMIDE_POC_PROJECT_ROOT` nor `LLMIDE_POC_GRAPH` is set: the
/// spike's default project (the frontend's default graph path lives under it).
const DEFAULT_PROJECT_REL: &str = "Desktop/LLM/code/affiliate";

/// The active project root: the folder opened through `project_open*` (host dialog).
/// Debug builds only fall back to `LLMIDE_POC_PROJECT_ROOT`, the parent of
/// `LLMIDE_POC_GRAPH`, then the spike's default project under `$HOME`; a release
/// build has no environment or default root, so nothing is readable until the user
/// opens a project.
pub fn project_root() -> Option<PathBuf> {
    if let Some(active) = crate::project::active_root() {
        return Some(active);
    }
    #[cfg(debug_assertions)]
    {
        let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        return env("LLMIDE_POC_PROJECT_ROOT")
            .or_else(|| env("LLMIDE_POC_GRAPH").and_then(|g| g.parent().map(Path::to_path_buf)))
            .or_else(|| env("HOME").map(|h| h.join(DEFAULT_PROJECT_REL)));
    }
    #[cfg(not(debug_assertions))]
    None
}

/// Reads `path` if it is a regular file named `graph.json` located inside `root`
/// and within the size limit (see the module docs for how this is made race-free).
pub fn read_within(root: &Path, path: &str) -> Result<String, String> {
    read_within_limited(root, path, GRAPH_FILE_MAX_BYTES)
}

fn read_within_limited(root: &Path, path: &str, max: u64) -> Result<String, String> {
    if path.is_empty() || path.contains('\0') {
        return Err("invalid path".into());
    }
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("project root {} is not available: {e}", root.display()))?;
    // Re-evaluated on every call: the root may have been swapped for a symlink to a
    // broad directory since it was accepted.
    let root_str = root.to_string_lossy();
    if crate::project::is_too_broad(&root_str, crate::project::home_dir().as_deref()) {
        return Err("the project root is too broad".into());
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("cannot resolve {path}: {e}"))?;
    check_location(&canonical, &root)?;

    let file = open_nofollow(&canonical)?;
    // Verify what was actually opened, not the path we resolved a moment ago.
    if let Some(real) = fd_path(&file) {
        check_location(&real, &root)?;
    } else if cfg!(any(target_os = "macos", target_os = "linux")) {
        return Err("cannot verify the opened file".into());
    }
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > max {
        return Err("graph.json is not a regular file within the size limit".into());
    }
    use std::io::Read;
    let mut body = String::new();
    // `take` bounds the read even if the file grows after fstat.
    file.take(max + 1).read_to_string(&mut body).map_err(|e| format!("read failed: {e}"))?;
    if body.len() as u64 > max {
        return Err("graph.json is not a regular file within the size limit".into());
    }
    Ok(body)
}

/// `p` must lie inside `root` and be named `graph.json`.
fn check_location(p: &Path, root: &Path) -> Result<(), String> {
    if !p.starts_with(root) {
        return Err("path is outside the project root".into());
    }
    let is_graph = p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == "graph.json");
    if !is_graph {
        return Err("only files named graph.json can be read".into());
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

/// The real path of an open file, from its descriptor.
#[cfg(target_os = "macos")]
pub(crate) fn fd_path(f: &std::fs::File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut buf = [0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes a NUL-terminated path of at most PATH_MAX bytes into buf.
    let rc = unsafe { libc::fcntl(f.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc == -1 {
        return None;
    }
    let len = buf.iter().position(|&b| b == 0)?;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..len])))
}

#[cfg(target_os = "linux")]
pub(crate) fn fd_path(f: &std::fs::File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd())).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn fd_path(_: &std::fs::File) -> Option<PathBuf> {
    None
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
        assert_eq!(GRAPH_FILE_MAX_BYTES, 32 * 1024 * 1024);
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
