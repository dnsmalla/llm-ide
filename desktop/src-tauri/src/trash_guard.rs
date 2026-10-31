//! The one way the host removes anything the user owns: move it to the OS trash, never delete it.
//!
//! - `Trasher` is the seam (tests inject a fake that moves into a folder or fails). There is no
//!   permanent-delete fallback on any path: when the trash cannot take the item the call fails with
//!   `trash_unavailable` and the item is left exactly where it was.
//! - `OsTrash` (macOS) uses the `NSFileManager` method of the pinned `trash` crate instead of the
//!   default Finder/AppleScript one: no Automation permission prompt, and a failure is an error, not a
//!   silent skip.
//! - Windows: `IFileOperation` + `FOF_ALLOWUNDO` silently DELETES PERMANENTLY on a drive without a Recycle
//!   Bin (removable, network, some virtual drives). `OsTrash` therefore refuses unless the item is on a
//!   FIXED local drive (`GetDriveTypeW`), see `windows_drive_has_recycle_bin`.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashError {
    /// Always `trash_unavailable` today.
    pub code: &'static str,
    pub message: String,
}

pub fn unavailable(message: impl Into<String>) -> TrashError {
    TrashError { code: "trash_unavailable", message: message.into() }
}

pub trait Trasher {
    /// Moves `path` to the trash. On `Err` the item MUST still exist unchanged.
    fn trash(&self, path: &Path) -> Result<(), TrashError>;
}

/// `GetDriveTypeW` value for a fixed local disk. Anything else (removable 2, remote 4, CD-ROM 5, RAM disk 6,
/// unknown 0/1) may have no Recycle Bin, where "move to the bin" becomes a permanent delete.
#[cfg_attr(not(windows), allow(dead_code))]
pub const DRIVE_FIXED: u32 = 3;

#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_drive_has_recycle_bin(drive_type: u32) -> bool {
    drive_type == DRIVE_FIXED
}

/// The real OS trash. Never a permanent delete.
pub struct OsTrash;

impl Trasher for OsTrash {
    fn trash(&self, path: &Path) -> Result<(), TrashError> {
        #[cfg(windows)]
        {
            if !windows_fixed_drive(path) {
                return Err(unavailable("this location has no Recycle Bin (removable or network drive); nothing was deleted"));
            }
        }
        let mut ctx = trash::TrashContext::default();
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            ctx.set_delete_method(DeleteMethod::NsFileManager);
        }
        ctx.delete(path).map_err(|e| unavailable(format!("cannot move to trash: {e}")))
    }
}

#[cfg(windows)]
fn windows_fixed_drive(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    let Ok(real) = std::fs::canonicalize(path) else { return false };
    let s = real.to_string_lossy().into_owned();
    // `\\?\C:\dir` (verbatim) or `C:\dir`; a UNC share (`\\?\UNC\...`) is a network drive.
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let b = s.as_bytes();
    if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' {
        return false;
    }
    let root: Vec<u16> = std::ffi::OsString::from(format!("{}:\\", b[0] as char)).encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: `root` is a valid NUL-terminated UTF-16 string for the duration of the call.
    let t = unsafe { GetDriveTypeW(root.as_ptr()) };
    windows_drive_has_recycle_bin(t)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    /// A trasher that records what it was asked to trash and optionally refuses.
    pub struct FakeTrash {
        pub refuse: bool,
        pub seen: RefCell<Vec<PathBuf>>,
        pub into: Option<PathBuf>,
    }

    impl FakeTrash {
        pub fn into(dir: &Path) -> Self {
            Self { refuse: false, seen: RefCell::new(Vec::new()), into: Some(dir.to_path_buf()) }
        }
        pub fn refusing() -> Self {
            Self { refuse: true, seen: RefCell::new(Vec::new()), into: None }
        }
    }

    impl Trasher for FakeTrash {
        fn trash(&self, path: &Path) -> Result<(), TrashError> {
            self.seen.borrow_mut().push(path.to_path_buf());
            if self.refuse {
                return Err(unavailable("no trash on this volume"));
            }
            let dir = self.into.as_ref().expect("fake trash dir");
            std::fs::create_dir_all(dir).map_err(|e| unavailable(e.to_string()))?;
            let name = format!("{}-{}", self.seen.borrow().len(), path.file_name().and_then(|n| n.to_str()).unwrap_or("x"));
            std::fs::rename(path, dir.join(name)).map_err(|e| unavailable(e.to_string()))
        }
    }

    #[test]
    fn only_a_fixed_drive_has_a_recycle_bin() {
        assert!(windows_drive_has_recycle_bin(DRIVE_FIXED));
        for t in [0u32, 1, 2, 4, 5, 6] {
            assert!(!windows_drive_has_recycle_bin(t), "drive type {t}");
        }
    }

    #[test]
    fn a_refusing_trash_is_an_error_with_a_stable_code() {
        let e = FakeTrash::refusing().trash(Path::new("/nonexistent/x")).unwrap_err();
        assert_eq!(e.code, "trash_unavailable");
    }
}
