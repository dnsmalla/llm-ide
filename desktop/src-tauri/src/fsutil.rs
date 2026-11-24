//! Small filesystem helpers for the host's own state under the app data dir.
//!
//! - `private_dir`: creates the directory (0700 on unix) and refuses a symlink or
//!   a directory owned by another user, so a pre-planted path cannot redirect the
//!   host's DB, logs or settings.
//! - `write_private_atomic`: bounded, write-to-temp-then-rename, 0600.

use std::io::Write;
use std::path::{Path, PathBuf};

// The path rule lives in the core crate; this re-export keeps `crate::fsutil::plain_path` for the host.
pub use llmide_workspace_core::paths::{plain_path, plain_windows_path};

/// Creates `dir` (and parents) as a private directory and returns it.
pub fn private_dir(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("cannot stat {}: {e}", dir.display()))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!("{} is not a plain directory", dir.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        if meta.uid() != me {
            return Err(format!("{} is owned by another user", dir.display()));
        }
        if meta.mode() & 0o077 != 0 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("cannot restrict {}: {e}", dir.display()))?;
        }
    }
    Ok(dir.to_path_buf())
}

/// Writes `body` (at most `max` bytes) to `path` atomically with owner-only permissions.
pub fn write_private_atomic(path: &Path, body: &[u8], max: usize) -> Result<(), String> {
    if body.len() > max {
        return Err(format!("refusing to write {} bytes (limit {max})", body.len()));
    }
    // A name of its own per write: two writers of one file must never share (and rename away) a temp.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = path.with_extension(format!("{}.{}.tmp", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
    let written = f.write_all(body).and_then(|()| f.sync_all());
    drop(f);
    written.and_then(|()| std::fs::rename(&tmp, path)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Folder name of the desktop app's data. Deliberately NOT the Mac app's
/// `llm-ide/system`: the two apps must not open the same SQLite DB or secrets.
pub const DATA_DIR_NAME: &str = "llm-ide-desktop";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

pub const fn current_os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Mac
    } else if cfg!(windows) {
        Os::Windows
    } else {
        Os::Linux
    }
}

/// The stable per-OS data dir, from an env lookup (pure, so each OS is testable here):
/// `LLMIDE_DESKTOP_DATA_DIR` (absolute) wins, else
/// macOS `~/Library/Application Support/llm-ide-desktop`,
/// Windows `%LOCALAPPDATA%\llm-ide-desktop` (local, not roaming: it holds a SQLite DB),
/// Linux `$XDG_DATA_HOME` or `~/.local/share` + `/llm-ide-desktop`.
/// It does not follow the bundle identifier, so renaming the PoC identifier never orphans data.
pub fn data_dir_for(os: Os, env: &dyn Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    let get = |k: &str| env(k).filter(|v| !v.trim().is_empty());
    if let Some(p) = get("LLMIDE_DESKTOP_DATA_DIR") {
        let p = PathBuf::from(p);
        return if p.is_absolute() { Ok(p) } else { Err("LLMIDE_DESKTOP_DATA_DIR must be an absolute path".into()) };
    }
    let abs = |v: String, what: &str| {
        let p = PathBuf::from(v);
        if p.is_absolute() { Ok(p) } else { Err(format!("{what} is not an absolute path")) }
    };
    let base = match os {
        Os::Mac => abs(get("HOME").ok_or("HOME is not set")?, "HOME")?.join("Library").join("Application Support"),
        Os::Windows => abs(get("LOCALAPPDATA").ok_or("LOCALAPPDATA is not set")?, "LOCALAPPDATA")?,
        Os::Linux => match get("XDG_DATA_HOME").filter(|v| PathBuf::from(v).is_absolute()) {
            Some(x) => PathBuf::from(x),
            None => abs(get("HOME").ok_or("HOME is not set")?, "HOME")?.join(".local").join("share"),
        },
    };
    Ok(base.join(DATA_DIR_NAME))
}

/// The data dir for this machine and process environment. `private_dir` creates it (and a missing default base).
pub fn desktop_data_dir() -> Result<PathBuf, String> {
    data_dir_for(current_os(), &|k| std::env::var(k).ok())
}

fn data_dir_is_explicit() -> bool {
    std::env::var("LLMIDE_DESKTOP_DATA_DIR").map(|v| !v.trim().is_empty()).unwrap_or(false)
}

/// Whether the CONFIGURED app data root can be used. Only an EXPLICIT `LLMIDE_DESKTOP_DATA_DIR` is strict: a folder
/// whose parent is gone (an unplugged drive, a deleted folder) is unavailable and must not be recreated on another
/// disk, which would look like a fresh install. The platform default keeps its historical behaviour: its base
/// (Application Support / LOCALAPPDATA / XDG_DATA_HOME, e.g. a missing `~/.local/share`) is created.
/// This is for the data ROOT only — `private_dir` still creates nested folders under an existing root.
pub fn data_root_available(dir: &Path) -> Result<(), String> {
    data_root_available_for(dir, data_dir_is_explicit())
}

fn data_root_available_for(dir: &Path, explicit: bool) -> Result<(), String> {
    let Some(parent) = dir.parent().filter(|p| !p.as_os_str().is_empty()) else { return Ok(()) };
    if explicit {
        if !parent.exists() {
            return Err(format!(
                "Your data folder is not available: {}. Reconnect the drive or change the location in Settings.",
                dir.display()
            ));
        }
        return Ok(());
    }
    std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))
}

/// Holds the single-instance lock for the life of the process (drop releases it).
#[derive(Debug)]
pub struct InstanceLock(#[allow(dead_code)] std::fs::File);

/// Takes an exclusive, non-blocking lock on `<dir>/instance.lock`. `Err` means another
/// instance of the app is running with the same data dir: two first-run instances would
/// otherwise race to create (and overwrite) the keychain secrets and the DB.
pub fn acquire_instance_lock(dir: &Path) -> Result<InstanceLock, String> {
    let path = dir.join("instance.lock");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.share_mode(0); // exclusive open: a second instance gets a sharing violation
    }
    let f = opts.open(&path).map_err(|e| {
        if cfg!(windows) {
            "LLM-IDE is already running".to_string()
        } else {
            format!("cannot open {}: {e}", path.display())
        }
    })?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: flock on a descriptor we own; the lock dies with the descriptor.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("LLM-IDE is already running".into());
        }
    }
    Ok(InstanceLock(f))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[allow(dead_code)]
    fn scratch(name: &str) -> TempDirGuard {
        let d = std::env::temp_dir().join(format!("llmide-fs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        TempDirGuard(d)
    }

    #[cfg(unix)]
    #[test]
    fn private_dir_is_0700_even_if_it_existed_open() {
        use std::os::unix::fs::PermissionsExt;
        let d = scratch("perm");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        private_dir(&d).unwrap();
        assert_eq!(std::fs::metadata(&d).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn private_dir_refuses_a_symlink() {
        let target = scratch("target");
        std::fs::create_dir_all(&target).unwrap();
        let link = scratch("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(private_dir(&link).unwrap_err().contains("not a plain directory"));
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_is_0600_and_bounded() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("w");
        let d = private_dir(&root).unwrap();
        let f = d.join("x.json");
        write_private_atomic(&f, b"{}", 16).unwrap();
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read(&f).unwrap(), b"{}");
        assert!(write_private_atomic(&f, &[b'a'; 17], 16).is_err());
        assert_eq!(std::fs::read(&f).unwrap(), b"{}", "a refused write leaves the old file");
    }

    #[cfg(unix)]
    #[test]
    fn data_dir_is_stable_per_os_and_not_the_mac_apps() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
        };
        let mac = data_dir_for(Os::Mac, &env(&[("HOME", "/Users/a")])).unwrap();
        assert_eq!(mac, PathBuf::from("/Users/a/Library/Application Support/llm-ide-desktop"));
        assert!(!mac.to_string_lossy().ends_with("llm-ide/system"));
        let lin = data_dir_for(Os::Linux, &env(&[("HOME", "/home/a")])).unwrap();
        assert_eq!(lin, PathBuf::from("/home/a/.local/share/llm-ide-desktop"));
        let xdg = data_dir_for(Os::Linux, &env(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "/data")])).unwrap();
        assert_eq!(xdg, PathBuf::from("/data/llm-ide-desktop"));
        // A relative XDG_DATA_HOME is ignored per the XDG spec.
        let rel = data_dir_for(Os::Linux, &env(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "rel")])).unwrap();
        assert_eq!(rel, PathBuf::from("/home/a/.local/share/llm-ide-desktop"));
        assert!(data_dir_for(Os::Mac, &env(&[])).is_err());
        assert!(data_dir_for(Os::Mac, &env(&[("HOME", "relative")])).is_err());
        let over = data_dir_for(Os::Mac, &env(&[("HOME", "/Users/a"), ("LLMIDE_DESKTOP_DATA_DIR", "/tmp/x")])).unwrap();
        assert_eq!(over, PathBuf::from("/tmp/x"));
        assert!(data_dir_for(Os::Mac, &env(&[("LLMIDE_DESKTOP_DATA_DIR", "x")])).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_data_dir_is_local_appdata() {
        let env = |k: &str| (k == "LOCALAPPDATA").then(|| "C:\\Users\\a\\AppData\\Local".to_string());
        let p = data_dir_for(Os::Windows, &env).unwrap();
        assert!(p.ends_with(DATA_DIR_NAME));
    }

    #[cfg(unix)]
    #[test]
    fn a_second_instance_cannot_take_the_lock_until_the_first_drops_it() {
        let root = scratch("lock");
        let d = private_dir(&root).unwrap();
        let first = acquire_instance_lock(&d).unwrap();
        assert!(acquire_instance_lock(&d).unwrap_err().contains("already running"));
        drop(first);
        // A concurrently running test may be between fork and exec and briefly hold a copy
        // of the descriptor; the lock frees as soon as that exec closes it.
        let end = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while acquire_instance_lock(&d).is_err() {
            assert!(std::time::Instant::now() < end, "lock never released");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn the_explicit_data_root_refuses_a_missing_parent_instead_of_creating_it() {
        let root = std::env::temp_dir().join(format!("llmide-fsutil-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let target = root.join("gone").join("llmide-desktop");
        let err = data_root_available_for(&target, true).unwrap_err();
        assert!(err.contains("Your data folder is not available"), "{err}");
        assert!(err.contains("Reconnect the drive or change the location in Settings."), "{err}");
        assert!(!root.join("gone").exists(), "nothing was created");
        std::fs::create_dir_all(&root).unwrap();
        assert!(data_root_available_for(&root.join("llmide-desktop"), true).is_ok(), "an existing parent is fine");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn private_dir_still_creates_a_nested_chain_under_a_new_parent() {
        let root = std::env::temp_dir().join(format!("llmide-fsutil-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let made = private_dir(&root.join("a").join("b").join("c")).unwrap();
        assert!(made.is_dir(), "nested creation is unchanged");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_default_data_root_creates_its_missing_base() {
        let root = std::env::temp_dir().join(format!("llmide-fsutil-default-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("share").join("llmide-desktop");
        assert!(data_root_available_for(&dir, false).is_ok());
        assert!(root.join("share").is_dir(), "the platform base was created");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_writers_of_one_file_all_succeed_and_leave_one_whole_body() {
        let dir = std::env::temp_dir().join(format!("llmide-fsutil-race-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("state.json");
        let writers: Vec<_> = (0..8u8)
            .map(|i| { let f = f.clone(); std::thread::spawn(move || (0..50).all(|_| write_private_atomic(&f, &[b'a' + i; 4096], 4096).is_ok())) })
            .collect();
        assert!(writers.into_iter().all(|w| w.join().unwrap()), "no writer may lose its temp file to another");
        let body = std::fs::read(&f).unwrap();
        assert!(body.len() == 4096 && body.iter().all(|b| *b == body[0]));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temp file is left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
