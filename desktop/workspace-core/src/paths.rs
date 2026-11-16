//! Project-root rules and real-path checks, shared by the desktop host and the SSH workspace helper.
//!
//! - `checked_root` canonicalises a folder and refuses it when it is too broad to be a project.
//! - `is_too_broad` is the breadth rule (mirror of `extension/core/broad-root.mjs`).
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
    if is_too_broad(&real.to_string_lossy(), home_dir().as_deref()) {
        return err("root_too_broad", "the project root is too broad");
    }
    Ok(real)
}

// ---- breadth rules (mirror of extension/core/broad-root.mjs) ----------------------------

/// Normalises a canonical path to forward slashes and strips the Windows verbatim
/// prefix (`\\?\C:\x` -> `C:/x`, `\\?\UNC\srv\share` -> `//srv/share`).
pub fn normalise(p: &str) -> String {
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
/// `home` is the canonical home directory, when known.
pub fn is_too_broad(real: &str, home: Option<&str>) -> bool {
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
