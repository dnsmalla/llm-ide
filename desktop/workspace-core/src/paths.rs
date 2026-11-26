//! Project-root rules and real-path checks, shared by the desktop host and the SSH workspace helper.
//!
//! - `checked_root` canonicalises a folder and refuses it when it is too broad to be a project.
//! - `validate_root` is the same check for a folder the caller names, with the home directory passed in.
//! - `is_too_broad` is the breadth rule (mirror of `extension/core/broad-root.mjs`), home passed in.
//! - `fd_path` reads the real location of an OPEN file, so a check made on the path can be confirmed on the
//!   descriptor that is actually read.

use std::path::{Path, PathBuf};

use crate::{err, io_err, R};

/// Canonicalises `root` and refuses a root that is (now) too broad.
pub fn checked_root(root: &Path) -> R<PathBuf> {
    let real = std::fs::canonicalize(root).map_err(|e| io_err("project root is not available", e))?;
    if !real.is_dir() {
        return err("no_project", "project root is not a directory");
    }
    if is_too_broad(&real, &home_or_empty()) {
        return err("root_too_broad", "the project root is too broad");
    }
    Ok(real)
}

// ---- breadth rules (mirror of extension/core/broad-root.mjs) ----------------------------

/// Normalises a canonical path to forward slashes and strips the Windows verbatim
/// prefix (`\\?\C:\x` -> `C:/x`, `\\?\UNC\srv\share` -> `//srv/share`).
pub(crate) fn normalise(p: &str) -> String {
    let w = p.replace('\\', "/");
    if let Some(rest) = w.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    if let Some(rest) = w.strip_prefix("//?/") {
        return rest.to_string();
    }
    w
}

fn segments(w: &str) -> Vec<&str> {
    w.split('/').filter(|s| !s.is_empty()).collect()
}

fn is_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

const HOME_CONTAINERS: [&str; 8] =
    ["documents", "desktop", "downloads", "library", "movies", "music", "pictures", "public"];
const SYSTEM_TOPS: [&str; 9] =
    ["etc", "usr", "var", "bin", "sbin", "system", "library", "private", "opt"];

const SENSITIVE_SYSTEM_TREES: [&str; 4] = ["proc", "dev", "sys", "boot"];
const SECRET_HOME_DIRS: [&str; 3] = [".ssh", ".aws", ".gnupg"];

/// True when `real` (a canonical path) is too broad to be a project root: `/`, the
/// home directory, system trees, volumes, other users' homes, temp dirs, home
/// containers (Documents/Desktop/Downloads...), Windows drive/system/users trees and
/// UNC share roots. A project INSIDE a container (`~/Desktop/proj`) is fine.
/// `home` is the canonical home directory; an empty path means the home is unknown.
pub fn is_too_broad(path: &Path, home: &Path) -> bool {
    let home_text = home.to_string_lossy();
    let home_opt = (!home_text.is_empty()).then_some(&*home_text);
    too_broad_text(&path.to_string_lossy(), home_opt)
}

/// Canonicalises `chosen`, requires a directory, and refuses a root that is too broad for `home`.
///
/// `home` is the canonical home directory, or an empty path when unknown (the home-relative rules then do
/// not apply, the system-wide rules still do). Error texts are shown to the user, so they stay stable.
pub fn validate_root(chosen: &Path, home: &Path) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(chosen).map_err(|e| format!("cannot resolve the chosen folder: {e}"))?;
    if !real.is_dir() {
        return Err("the chosen path is not a folder".into());
    }
    let s = real.to_string_lossy();
    if s.contains('\0') || is_too_broad(&real, home) {
        return Err("that folder is too broad to open as a project; pick a project folder".into());
    }
    Ok(real)
}

/// The canonical home directory as a path, or an empty path when it is unknown.
pub fn home_or_empty() -> PathBuf {
    home_dir().map(PathBuf::from).unwrap_or_default()
}

fn too_broad_text(real: &str, home: Option<&str>) -> bool {
    if real.is_empty() {
        return true;
    }
    let w = normalise(real);
    let segs = segments(&w);
    let lower: Vec<String> = segs.iter().map(|s| s.to_lowercase()).collect();
    let norm = lower.join("/");
    let home_norm = home.map(|h| {
        segments(&normalise(h)).iter().map(|s| s.to_lowercase()).collect::<Vec<_>>().join("/")
    });

    // isTooBroadRoot
    if w == "/" || segs.len() <= 1 {
        return true;
    }
    if let Some(hn) = &home_norm {
        if !hn.is_empty() && &norm == hn {
            return true;
        }
    }
    if segs.len() <= 2 && !w.starts_with("//") && SYSTEM_TOPS.contains(&lower[0].as_str()) {
        // The JS list is case-sensitive ('/System', '/Library'); lower-casing is the
        // stricter reading and only matters on case-insensitive filesystems.
        return true;
    }

    // Credential and kernel trees (mirror of `inSensitiveTree` in broad-root.mjs).
    if SENSITIVE_SYSTEM_TREES.contains(&lower[0].as_str()) {
        return true;
    }
    if segs.len() == 1 && lower[0] == "root" {
        return true;
    }
    if lower.len() <= 6 && lower.len() >= 3 && lower[0] == "private" && lower[1] == "var" && lower[2] == "folders" {
        return true; // per-user temp roots themselves, not projects inside them
    }
    if let Some(hn) = &home_norm {
        if !hn.is_empty() {
            if let Some(rest) = norm.strip_prefix(&format!("{hn}/")) {
                let first = rest.split('/').next().unwrap_or("");
                if SECRET_HOME_DIRS.contains(&first) || (rest == ".config") {
                    return true;
                }
            }
        }
    }

    // isTooBroadTrustRoot
    if w.starts_with("//") && segs.len() <= 2 {
        return true; // UNC server or server/share root
    }
    if is_drive(segs[0]) {
        match lower[1].as_str() {
            "users" if segs.len() <= 3 => return true,
            "windows" => return true,
            "program files" | "program files (x86)" | "programdata" if segs.len() == 2 => {
                return true
            }
            _ => {}
        }
    }
    let top = lower[0].as_str();
    if top == "system" {
        return true;
    }
    if top == "volumes" && segs.len() <= 2 {
        return true;
    }
    if (top == "users" || top == "home") && segs.len() <= 2 {
        return true;
    }
    if ["tmp", "var/tmp", "private/tmp", "private/var/tmp"].contains(&norm.as_str()) {
        return true;
    }
    if let Some(hn) = &home_norm {
        if !hn.is_empty() {
            if let Some(rest) = norm.strip_prefix(&format!("{hn}/")) {
                if !rest.contains('/') && HOME_CONTAINERS.contains(&rest) {
                    return true;
                }
            }
        }
    }
    if (top == "users" || top == "home") && segs.len() == 3 && HOME_CONTAINERS.contains(&lower[2].as_str())
    {
        return true;
    }
    false
}

pub fn home_dir() -> Option<String> {
    let h = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let h = PathBuf::from(h);
    Some(std::fs::canonicalize(&h).unwrap_or(h).to_string_lossy().into_owned())
}

/// The real path of an open file, from its descriptor.
#[cfg(target_os = "macos")]
pub fn fd_path(f: &std::fs::File) -> Option<PathBuf> {
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
pub fn fd_path(f: &std::fs::File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd())).ok()
}

/// The final path of the open handle, in the same `\\?\C:\...` form `std::fs::canonicalize` returns, so it
/// compares directly with a canonical root.
#[cfg(windows)]
pub fn fd_path(f: &std::fs::File) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS};
    let mut buf = vec![0u16; 512];
    loop {
        // SAFETY: the handle is open for as long as `f` lives; `buf` holds `buf.len()` u16s.
        let n = unsafe { GetFinalPathNameByHandleW(f.as_raw_handle(), buf.as_mut_ptr(), buf.len() as u32, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) } as usize;
        if n == 0 {
            return None;
        }
        if n < buf.len() {
            return Some(PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])));
        }
        if n > 32_768 {
            return None;
        }
        // Too small: `n` is the size needed, terminating NUL included.
        buf.resize(n, 0);
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn fd_path(_: &std::fs::File) -> Option<PathBuf> {
    None
}

/// Strips the `\\?\` verbatim prefix `canonicalize` adds on Windows: `\\?\C:\x` -> `C:\x`,
/// `\\?\UNC\srv\share` -> `\\srv\share`, but only when the plain form names the same path. Win32 trims a
/// trailing dot or space, maps `nul`/`con`/... to devices, treats `/` as a separator and stops at MAX_PATH, so a
/// verbatim path with any of those stays verbatim (same rule as the `dunce` crate). Pure string form, so it is
/// testable on every host.
pub fn plain_windows_path(p: &str) -> String {
    let (plain, rest) = if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        (format!(r"\\{rest}"), rest)
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        // Only a drive path (`C:\...`); `\\?\Volume{...}` and `\\?\GLOBALROOT` have no plain form.
        if !(b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\') {
            return p.to_string();
        }
        (rest.to_string(), &rest[3..])
    } else {
        return p.to_string();
    };
    let reserved = |c: &str| {
        let base = c.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || (base.len() == 4 && (base.starts_with("COM") || base.starts_with("LPT")) && base.as_bytes()[3].is_ascii_digit())
    };
    let parts: Vec<&str> = rest.split('\\').collect();
    let last = parts.len().saturating_sub(1);
    let safe = plain.len() < 260
        && !rest.contains('/')
        && parts.iter().enumerate().all(|(i, c)| {
            if c.is_empty() {
                return i == last; // only a trailing separator (`C:\`)
            }
            !c.ends_with(['.', ' ']) && !reserved(c)
        });
    if safe { plain } else { p.to_string() }
}

/// `p` without the Windows verbatim prefix (unchanged elsewhere). Git (MSYS) and `cmd.exe` cannot use a
/// `\\?\` path as an argument or working directory; compare canonical paths, then hand out this form.
pub fn plain_path(p: &Path) -> PathBuf {
    match p.to_str() {
        Some(s) if cfg!(windows) => PathBuf::from(plain_windows_path(s)),
        _ => p.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefixes_are_stripped() {
        assert_eq!(plain_windows_path(r"\\?\C:\Users\a"), r"C:\Users\a");
        assert_eq!(plain_windows_path(r"\\?\UNC\srv\share\p"), r"\\srv\share\p");
        assert_eq!(plain_windows_path(r"C:\x"), r"C:\x");
        assert_eq!(plain_windows_path("/usr/x"), "/usr/x");
        assert_eq!(plain_windows_path(r"\\?\C:\"), r"C:\");
        // No plain spelling for these: they stay verbatim.
        for keep in [
            r"\\?\C:\a.\b", r"\\?\C:\a \b", r"\\?\C:\x\nul", r"\\?\C:\x\COM1.txt", r"\\?\C:\a/b", r"\\?\C:\a\\b",
            r"\\?\Volume{1}\x", r"\\?\UNC\srv\share\x.", r"\\?\C:\a.",
        ] {
            assert_eq!(plain_windows_path(keep), keep);
        }
        let long = format!(r"\\?\C:\{}", "a\\".repeat(130));
        assert_eq!(plain_windows_path(&long), long, "over MAX_PATH");
        let canon = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let plain = plain_path(&canon);
        assert!(!plain.to_string_lossy().starts_with(r"\\?\"), "{plain:?}");
        assert_eq!(std::fs::canonicalize(&plain).unwrap(), canon, "same folder");
    }

    /// A real folder whose name ends in a dot (only the verbatim API can make one) keeps its `\\?\` form.
    #[cfg(windows)]
    #[test]
    fn a_trailing_dot_folder_stays_verbatim() {
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("llmide-fs-{}-dot", std::process::id()));
        let dotted = PathBuf::from(format!("{}.", base.display()));
        let _ = std::fs::remove_dir_all(&dotted);
        std::fs::create_dir_all(&dotted).unwrap();
        assert_eq!(plain_path(&dotted), dotted, "the plain form would name {base:?}");
        assert!(!base.exists());
        std::fs::remove_dir_all(&dotted).unwrap();
    }

    fn too_broad(p: &str, home: Option<&str>) -> bool {
        is_too_broad(Path::new(p), Path::new(home.unwrap_or("")))
    }

    fn validate(p: &Path) -> Result<PathBuf, String> {
        validate_root(p, Path::new(""))
    }

    #[test]
    fn credential_and_kernel_trees_match_the_server_list() {
        let h = Some("/Users/alice");
        for p in [
            "/Users/alice/.ssh", "/Users/alice/.ssh/keys", "/Users/alice/.aws", "/Users/alice/.gnupg/x",
            "/Users/alice/.config", "/proc", "/proc/1", "/dev", "/sys/kernel", "/boot", "/root",
            "/private/var/folders/ab/cdef", "/private/var/folders/ab/cdef/T",
        ] {
            assert!(too_broad(p, h), "{p} must be too broad");
        }
        for p in ["/Users/alice/.config/nvim", "/root/proj", "/private/var/folders/ab/cdef/T/proj"] {
            assert!(!too_broad(p, h), "{p} must be allowed");
        }
    }

    use std::fs;

    const HOME: Option<&str> = Some("/Users/alice");

    fn broad(p: &str) -> bool {
        too_broad(p, HOME)
    }

    #[test]
    fn refuses_root_home_and_system_trees() {
        for p in ["/", "/Users", "/home", "/etc", "/usr", "/var", "/opt", "/private", "/Library", "/System",
                  "/System/Library", "/usr/local", "/Users/alice", "/Volumes", "/Volumes/disk", "/tmp",
                  "/private/tmp", "/var/tmp", "/Users/bob", "/home/bob", "/System/Volumes/Data"] {
            assert!(broad(p), "{p} must be too broad");
        }
    }

    #[test]
    fn refuses_home_containers_and_other_users_containers() {
        for p in ["/Users/alice/Documents", "/Users/alice/Desktop", "/Users/alice/Downloads",
                  "/Users/alice/Library", "/Users/alice/public", "/Users/bob/Documents", "/home/bob/Desktop"] {
            assert!(broad(p), "{p} must be too broad");
        }
    }

    #[test]
    fn allows_projects_inside_containers() {
        for p in ["/Users/alice/Desktop/LLM", "/Users/alice/code/app", "/Volumes/disk/proj",
                  "/home/bob/work/app", "/srv/app", "/opt/tools/proj", "/Users/alice/Documents/a"] {
            assert!(!broad(p), "{p} must be allowed");
        }
    }

    #[test]
    fn refuses_windows_trees_and_unc_roots() {
        for p in ["C:\\", "C:", "C:\\Users", "C:\\Users\\alice", "C:\\Windows", "C:\\Windows\\System32",
                  "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData",
                  "\\\\?\\C:\\Users\\alice", "\\\\srv\\share", "\\\\?\\UNC\\srv\\share", "\\\\srv"] {
            assert!(too_broad(p, Some("C:\\Users\\alice")), "{p} must be too broad");
        }
        for p in ["C:\\work\\app", "\\\\?\\C:\\Users\\alice\\code\\app", "\\\\srv\\share\\proj"] {
            assert!(!too_broad(p, Some("C:\\Users\\alice")), "{p} must be allowed");
        }
    }

    #[test]
    fn home_comparison_is_case_insensitive_and_empty_is_broad() {
        assert!(too_broad("/users/ALICE", HOME));
        assert!(too_broad("", HOME));
    }

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
        let d = std::env::temp_dir().join(format!("llmide-proj-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        TempDirGuard(fs::canonicalize(&d).unwrap())
    }

    #[test]
    fn validate_rejects_files_missing_and_root() {
        let d = scratch("v");
        let f = d.join("a.txt");
        fs::write(&f, "x").unwrap();
        assert!(validate(&f).is_err());
        assert!(validate(&d.join("nope")).is_err());
        assert!(validate(Path::new("/")).is_err());
        let proj = d.join("proj");
        fs::create_dir_all(&proj).unwrap();
        assert_eq!(validate(&proj).unwrap(), proj);
    }

    #[cfg(unix)]
    #[test]
    fn validate_canonicalises_symlinks_before_breadth_check() {
        let d = scratch("sl");
        std::os::unix::fs::symlink("/", d.join("rootlink")).unwrap();
        assert!(validate(&d.join("rootlink")).is_err());
    }
}
