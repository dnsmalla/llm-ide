//! Read and clear the core's log files for Settings > Server & Backend.
//!
//! The paths are fixed under the app data directory (`core/server.log`, the core's own live log, and
//! `core.log`, the host's redacted failure log; the newer one is shown); the webview never supplies one. Reads are bounded to a
//! tail so a long-running install cannot hand megabytes to the page. Text only: the page renders it escaped.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The tail kept for the viewer. The core resets its log on each start; the failure log is capped anyway.
pub const MAX_BYTES: u64 = 64 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CoreLog {
    /// Absolute path of the file that was read; empty when neither exists.
    pub path: String,
    /// The tail of that file, UTF-8 lossy (a log line cut by the cap is the caller's business).
    pub text: String,
    /// False when no log file exists yet (a healthy, quiet start writes nothing).
    pub exists: bool,
}

fn candidates() -> Result<[PathBuf; 2], String> {
    let data = crate::fsutil::desktop_data_dir()?;
    Ok([data.join("core").join("server.log"), data.join("core.log")])
}

/// The last [`MAX_BYTES`] of `path`, starting at a line boundary when the file was cut.
pub fn read_tail(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let len = f.metadata().map_err(|e| format!("cannot stat {}: {e}", path.display()))?.len();
    let cut = len > MAX_BYTES;
    if cut {
        f.seek(SeekFrom::Start(len - MAX_BYTES)).map_err(|e| format!("cannot seek {}: {e}", path.display()))?;
    }
    let mut buf = Vec::with_capacity(MAX_BYTES.min(len) as usize);
    f.take(MAX_BYTES).read_to_end(&mut buf).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if cut {
        if let Some(i) = text.find('\n') {
            text.drain(..=i);
        }
    }
    Ok(text)
}

/// True for a regular file that was not reached through a symlink (the app data dir is private, but this is
/// a fixed-path read/truncate, so it costs nothing to be strict).
fn plain_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|m| m.is_file() && !m.file_type().is_symlink()).unwrap_or(false)
}

/// The most recently modified existing candidate, with its tail; on a tie (or no readable mtime) the earlier
/// candidate wins. `core.log` is what every host failure message points at, so a failure newer than the core's
/// own `server.log` must be the one shown.
pub fn read_from(candidates: &[PathBuf]) -> Result<CoreLog, String> {
    let mut best: Option<(&PathBuf, Option<std::time::SystemTime>)> = None;
    for p in candidates.iter().filter(|p| plain_file(p)) {
        let modified = std::fs::metadata(p).and_then(|m| m.modified()).ok();
        if best.as_ref().map_or(true, |(_, cur)| modified > *cur) {
            best = Some((p, modified));
        }
    }
    match best {
        Some((p, _)) => Ok(CoreLog { path: p.to_string_lossy().into_owned(), text: read_tail(p)?, exists: true }),
        None => Ok(CoreLog { path: String::new(), text: String::new(), exists: false }),
    }
}

/// Truncates every existing candidate. Missing files are fine (nothing to clear).
pub fn clear_all(candidates: &[PathBuf]) -> Result<(), String> {
    for p in candidates {
        if !plain_file(p) {
            continue;
        }
        std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(p)
            .map_err(|e| format!("cannot clear {}: {e}", p.display()))?;
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("task failed: {e}"))?
}

#[tauri::command]
pub async fn core_log_read() -> Result<CoreLog, String> {
    blocking(|| read_from(&candidates()?)).await
}

#[tauri::command]
pub async fn core_log_clear() -> Result<(), String> {
    blocking(|| clear_all(&candidates()?)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-corelog-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_the_whole_small_file() {
        let d = scratch("small");
        let p = d.join("server.log");
        fs::write(&p, "{\"level\":\"warn\"}\n{\"level\":\"warn\"}\n").unwrap();
        assert_eq!(read_tail(&p).unwrap(), "{\"level\":\"warn\"}\n{\"level\":\"warn\"}\n");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_long_file_is_cut_to_a_bounded_tail_on_a_line_boundary() {
        let d = scratch("big");
        let p = d.join("server.log");
        let mut f = fs::File::create(&p).unwrap();
        // Lines of 13 bytes: the 64 KiB cut lands mid-line whatever the alignment, and the tail has to
        // start at the next complete line (never half a JSON record).
        for _ in 0..20_000 {
            f.write_all(b"0123456789abc\n").unwrap();
        }
        f.write_all(b"LAST-LINE\n").unwrap();
        drop(f);
        let text = read_tail(&p).unwrap();
        assert!(text.len() as u64 <= MAX_BYTES, "bounded");
        assert!(text.ends_with("LAST-LINE\n"));
        assert_eq!(text.lines().next(), Some("0123456789abc"), "the cut starts at a complete line");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn invalid_utf8_is_lossy_not_an_error() {
        let d = scratch("lossy");
        let p = d.join("server.log");
        fs::write(&p, [b'o', b'k', 0xff, b'\n']).unwrap();
        let text = read_tail(&p).unwrap();
        assert!(text.starts_with("ok"));
        assert!(text.contains('\u{fffd}'));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_files_report_absent_and_a_symlink_is_not_read_or_cleared() {
        let d = scratch("absent");
        let real = d.join("real.log");
        fs::write(&real, "secret\n").unwrap();
        let link = d.join("server.log");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let got = read_from(&[link.clone()]).unwrap();
        assert!(!got.exists, "a symlinked log is ignored");
        clear_all(&[link]).unwrap();
        #[cfg(unix)]
        assert_eq!(fs::read_to_string(&real).unwrap(), "secret\n", "the target was not truncated");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn clearing_truncates_each_existing_log() {
        let d = scratch("clear");
        let a = d.join("core.log");
        let b = d.join("server.log");
        fs::write(&a, "x".repeat(100)).unwrap();
        fs::write(&b, "y".repeat(50)).unwrap();
        let missing = d.join("missing.log");
        clear_all(&[a.clone(), b.clone(), missing]).unwrap();
        assert_eq!(fs::read(&a).unwrap().len(), 0);
        assert_eq!(fs::read(&b).unwrap().len(), 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_newer_candidate_wins_and_a_tie_goes_to_the_first() {
        let d = scratch("order");
        let a = d.join("core.log");
        let b = d.join("server.log");
        fs::write(&b, "second\n").unwrap();
        assert_eq!(read_from(&[a.clone(), b.clone()]).unwrap().path, b.to_string_lossy());
        fs::write(&a, "first\n").unwrap();
        let t0 = std::time::SystemTime::now();
        let set_mtime = |p: &PathBuf, t: std::time::SystemTime| {
            fs::OpenOptions::new().write(true).open(p).unwrap().set_modified(t).unwrap();
        };
        set_mtime(&a, t0);
        set_mtime(&b, t0);
        assert_eq!(read_from(&[a.clone(), b.clone()]).unwrap().path, a.to_string_lossy(), "a tie goes to the first");
        // server.log (listed first in production) older than core.log: the failure log is the one shown.
        set_mtime(&b, t0 - std::time::Duration::from_secs(60));
        let got = read_from(&[b.clone(), a.clone()]).unwrap();
        assert_eq!(got.path, a.to_string_lossy());
        assert_eq!(got.text, "first\n");
        // and the other way round: a healthy newer server.log wins over a stale failure log.
        set_mtime(&b, t0 + std::time::Duration::from_secs(60));
        assert_eq!(read_from(&[b.clone(), a.clone()]).unwrap().path, b.to_string_lossy());
        let _ = fs::remove_dir_all(&d);
    }
}
