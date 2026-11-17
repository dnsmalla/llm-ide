//! Deletes disk leftovers of the retired Swift Mac app (removed 2026-11-06) that nothing reads
//! any more and nothing else would ever delete.
//!
//! `~/Library/Application Support/llm-ide/rebuild-staging` was the Mac app's feature-rebuild
//! stage dir: its `rebuild-swap.sh` moved only the `.app` out, so the stripped binary's dSYM
//! (~110 MB) stayed there until the NEXT rebuild wiped it. With the app gone, that never comes.
//! The rest of `llm-ide/` is left alone: legacy import and the add-on migration still read it.

use std::path::Path;

/// Remove `<support>/llm-ide/rebuild-staging` if it is a real directory. A symlink is never
/// followed or removed (it could point at data that is not ours). Returns whether it deleted.
pub(crate) fn remove_mac_rebuild_staging_in(support: &Path) -> Result<bool, String> {
    let staging = support.join("llm-ide").join("rebuild-staging");
    match std::fs::symlink_metadata(&staging) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&staging)
            .map(|()| true)
            .map_err(|e| format!("cannot delete {}: {e}", staging.display())),
        Ok(_) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("cannot inspect {}: {e}", staging.display())),
    }
}

/// The spawn-path wrapper: macOS only (the Mac app never ran elsewhere), HOME resolved once.
pub(crate) fn remove_mac_rebuild_staging() -> Result<bool, String> {
    if crate::fsutil::current_os() != crate::fsutil::Os::Mac { return Ok(false); }
    let home = std::env::var("HOME").map(std::path::PathBuf::from).ok().filter(|p| p.is_absolute())
        .ok_or("HOME is not set")?;
    remove_mac_rebuild_staging_in(&home.join("Library").join("Application Support"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_support(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("llmide-retired-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("llm-ide")).unwrap();
        dir
    }

    #[test]
    fn deletes_the_staging_dir_and_keeps_its_siblings() {
        let support = temp_support("del");
        let dsym = support.join("llm-ide/rebuild-staging/LlmIdeMac.app.dSYM/Contents");
        std::fs::create_dir_all(&dsym).unwrap();
        std::fs::write(dsym.join("Info.plist"), b"x").unwrap();
        std::fs::create_dir_all(support.join("llm-ide/plugins")).unwrap();
        assert_eq!(remove_mac_rebuild_staging_in(&support), Ok(true));
        assert!(!support.join("llm-ide/rebuild-staging").exists());
        assert!(support.join("llm-ide/plugins").exists());
        assert_eq!(remove_mac_rebuild_staging_in(&support), Ok(false));
        let _ = std::fs::remove_dir_all(&support);
    }

    #[test]
    fn a_missing_folder_is_a_no_op() {
        let support = temp_support("none");
        assert_eq!(remove_mac_rebuild_staging_in(&support.join("absent")), Ok(false));
        let _ = std::fs::remove_dir_all(&support);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_neither_followed_nor_removed() {
        let support = temp_support("link");
        let target = support.join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep"), b"x").unwrap();
        std::os::unix::fs::symlink(&target, support.join("llm-ide/rebuild-staging")).unwrap();
        assert_eq!(remove_mac_rebuild_staging_in(&support), Ok(false));
        assert!(target.join("keep").exists());
        let _ = std::fs::remove_dir_all(&support);
    }
}
