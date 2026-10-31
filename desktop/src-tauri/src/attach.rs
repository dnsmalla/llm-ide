//! Chat attachments: the host picks the files, the webview only ever sees opaque handles.
//!
//! - `attach_pick_files()` opens a native multi-file dialog (`rfd`, run by the host) and
//!   returns, per accepted file, ONLY `{ handle, name, size, mime }`: a random 128-bit token,
//!   the base name (control/bidi characters removed), the byte size and a mime guess from the
//!   extension. No path ever reaches the page, and the webview supplies none.
//! - Each pick is opened immediately and the OPEN DESCRIPTOR is what the handle owns, so a
//!   later swap of the path (rename, symlink) changes nothing: the path is canonicalised once,
//!   the final component is opened with `O_NOFOLLOW | O_NONBLOCK`, and the descriptor is
//!   `fstat`ed: only regular files are kept (devices, FIFOs, sockets, directories are refused
//!   without being read). A user-visible symlink is followed once at canonicalisation, which
//!   is what the user picked.
//! - `attach_read(handle, offset, len)` reads at most 4 MiB at an offset (positional read, no
//!   shared cursor) from the descriptor, never past the size recorded at pick time, so a file
//!   that grows after the pick cannot exceed the cap. Raw bytes come back as an IPC response.
//! - Limits: 25 MB per file, 100 MB of live handles in total, 64 handles, 20 files per pick.
//!   Over-limit files are listed in `rejected` with a reason and a name, never kept open.
//! - Lifetime: a handle lives 30 minutes from the pick, is dropped by `attach_release`, by a
//!   page reload (the webview that held the token is gone) and when the app quits.
//! - Nothing here logs; file names are never written anywhere.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Response;

use crate::confirm::{herr, RateLimit};
use crate::fs_ops::FsError;

pub const FILE_MAX_BYTES: u64 = 25 * 1024 * 1024;
pub const TOTAL_MAX_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_HANDLES: usize = 64;
pub const MAX_PER_PICK: usize = 20;
pub const CHUNK_MAX: u64 = 4 * 1024 * 1024;
pub const TTL: Duration = Duration::from_secs(30 * 60);
const NAME_MAX_CHARS: usize = 255;

static PICK_LIMIT: RateLimit = RateLimit::new(500, 20);

struct Picked {
    file: File,
    size: u64,
    created: Instant,
}

struct Store {
    map: HashMap<String, Picked>,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn with_store<T>(f: impl FnOnce(&mut Store) -> T) -> T {
    let mut g = STORE.lock().unwrap_or_else(|p| p.into_inner());
    f(g.get_or_insert_with(|| Store { map: HashMap::new() }))
}

impl Store {
    fn purge(&mut self, now: Instant) {
        self.map.retain(|_, p| now.saturating_duration_since(p.created) < TTL);
    }
    fn total(&self) -> u64 {
        self.map.values().map(|p| p.size).sum()
    }
}

/// Drops every handle (page reload, quit).
pub fn clear() {
    with_store(|s| s.map.clear());
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Attachment {
    pub handle: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Rejected {
    pub name: String,
    /// `not_regular`, `too_large`, `total_limit`, `too_many`, `unreadable`.
    pub reason: &'static str,
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct PickResult {
    pub files: Vec<Attachment>,
    pub rejected: Vec<Rejected>,
}

/// Base name with control and invisible format characters removed, capped.
fn display_name(p: &Path) -> String {
    let raw = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let s: String = raw.chars().filter(|c| !c.is_control() && !crate::tray::is_invisible_format(*c)).take(NAME_MAX_CHARS).collect();
    if s.is_empty() { "file".to_string() } else { s }
}

/// Mime type from the extension only (never sniffed, never trusted).
pub fn mime_guess(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "js" | "mjs" | "ts" | "tsx" | "jsx" | "rs" | "py" | "go" | "java" | "c" | "h" | "cpp" | "swift" | "sh" | "toml" | "css" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn open_nofollow(p: &Path) -> std::io::Result<File> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    o.open(p)
}

/// Opens one picked path for attachment: canonicalise, `O_NOFOLLOW` open, `fstat`, regular
/// file only. Returns the descriptor and its size.
fn open_picked(path: &Path) -> Result<(File, u64), &'static str> {
    let real = std::fs::canonicalize(path).map_err(|_| "unreadable")?;
    let f = open_nofollow(&real).map_err(|_| "unreadable")?;
    let meta = f.metadata().map_err(|_| "unreadable")?;
    if !meta.is_file() {
        return Err("not_regular");
    }
    Ok((f, meta.len()))
}

/// Registers the picked paths and builds the result. The paths are opened here; nothing about
/// them is returned except the sanitised base name.
pub(crate) fn register(paths: Vec<std::path::PathBuf>) -> PickResult {
    let mut out = PickResult::default();
    let now = Instant::now();
    with_store(|st| {
        st.purge(now);
        for (i, path) in paths.iter().enumerate() {
            let name = display_name(path);
            let mut reject = |reason: &'static str| out.rejected.push(Rejected { name: name.clone(), reason });
            if i >= MAX_PER_PICK || st.map.len() >= MAX_HANDLES {
                reject("too_many");
                continue;
            }
            let (file, size) = match open_picked(path) {
                Ok(v) => v,
                Err(r) => {
                    reject(r);
                    continue;
                }
            };
            if size > FILE_MAX_BYTES {
                reject("too_large");
                continue;
            }
            if st.total() + size > TOTAL_MAX_BYTES {
                reject("total_limit");
                continue;
            }
            let Some(handle) = new_handle() else {
                reject("unreadable");
                continue;
            };
            let mime = mime_guess(&name).to_string();
            st.map.insert(handle.clone(), Picked { file, size, created: now });
            out.files.push(Attachment { handle, name: name.clone(), size, mime });
        }
    });
    out
}

fn new_handle() -> Option<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).ok()?;
    Some(b.iter().map(|x| format!("{x:02x}")).collect())
}

#[cfg(unix)]
fn read_at(f: &File, buf: &mut [u8], off: u64) -> std::io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(f, buf, off)
}
#[cfg(windows)]
fn read_at(f: &File, buf: &mut [u8], off: u64) -> std::io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(f, buf, off)
}

/// Reads up to `len` (capped at `CHUNK_MAX`) bytes at `offset`, never past the pick-time size.
pub fn read_chunk(handle: &str, offset: u64, len: u64) -> Result<Vec<u8>, FsError> {
    with_store(|st| {
        st.purge(Instant::now());
        let Some(p) = st.map.get(handle) else {
            return Err(herr("no_handle", "unknown or expired attachment"));
        };
        if offset >= p.size {
            return Ok(Vec::new());
        }
        let want = len.min(CHUNK_MAX).min(p.size - offset) as usize;
        let mut buf = vec![0u8; want];
        let mut got = 0;
        while got < want {
            match read_at(&p.file, &mut buf[got..], offset + got as u64) {
                Ok(0) => break, // truncated since the pick
                Ok(n) => got += n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return Err(herr("io", "cannot read the attachment")),
            }
        }
        buf.truncate(got);
        Ok(buf)
    })
}

pub fn release(handle: &str) {
    with_store(|st| {
        st.map.remove(handle);
    });
}

// ---- Tauri commands ---------------------------------------------------------------------

/// Native multi-file dialog. Returns metadata and opaque handles only (no paths); an empty
/// result means the user cancelled.
#[tauri::command]
pub async fn attach_pick_files() -> Result<PickResult, FsError> {
    if !PICK_LIMIT.allow() {
        return Err(herr("rate_limited", "too many requests"));
    }
    tauri::async_runtime::spawn_blocking(|| {
        let picked = rfd::FileDialog::new().set_title("Attach files").pick_files().unwrap_or_default();
        register(picked)
    })
    .await
    .map_err(|e| herr("io", format!("task failed: {e}")))
}

/// Reads a bounded chunk (at most 4 MiB) of a picked file as raw bytes.
#[tauri::command]
pub async fn attach_read(handle: String, offset: u64, len: u64) -> Result<Response, FsError> {
    tauri::async_runtime::spawn_blocking(move || read_chunk(&handle, offset, len).map(Response::new))
        .await
        .map_err(|e| herr("io", format!("task failed: {e}")))?
}

/// Forgets a handle (closes its descriptor, frees its share of the total).
#[tauri::command]
pub fn attach_release(handle: String) {
    release(&handle);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("llmide-attach-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(&p).unwrap()
    }

    // The store is process-global: run the scenarios serially in one test.
    #[test]
    fn pick_read_limits_and_hardening() {
        clear();
        let d = scratch("main");
        let a = d.join("a\u{202E}.txt");
        std::fs::write(&a, b"hello world").unwrap();
        let big = d.join("big.bin");
        File::create(&big).unwrap().set_len(FILE_MAX_BYTES + 1).unwrap();
        let dir = d.join("folder");
        std::fs::create_dir(&dir).unwrap();

        let r = register(vec![a.clone(), big.clone(), dir.clone(), d.join("missing")]);
        assert_eq!(r.files.len(), 1);
        let f = &r.files[0];
        assert_eq!((f.name.as_str(), f.size, f.mime.as_str()), ("a.txt", 11, "text/plain"), "bidi stripped");
        assert_eq!(f.handle.len(), 32);
        assert!(!f.handle.contains('/') && !serde_json::to_string(&r).unwrap().contains(d.to_str().unwrap()), "no path leaks");
        let reasons: Vec<_> = r.rejected.iter().map(|x| (x.name.as_str(), x.reason)).collect();
        assert_eq!(reasons, vec![("big.bin", "too_large"), ("folder", "not_regular"), ("missing", "unreadable")]);

        // Bounded positional reads.
        assert_eq!(read_chunk(&f.handle, 0, 5).unwrap(), b"hello");
        assert_eq!(read_chunk(&f.handle, 6, 1000).unwrap(), b"world");
        assert_eq!(read_chunk(&f.handle, 11, 10).unwrap(), b"");
        assert_eq!(read_chunk(&f.handle, u64::MAX, 10).unwrap(), b"");
        assert_eq!(read_chunk("nope", 0, 1).unwrap_err().code, "no_handle");
        assert_eq!(read_chunk(&"0".repeat(32), 0, 1).unwrap_err().code, "no_handle");

        // A file that GROWS after the pick is still capped at the pick-time size.
        std::fs::write(&a, b"hello world and much more").unwrap();
        assert_eq!(read_chunk(&f.handle, 0, 1000).unwrap(), b"hello world");
        // Swapping the path afterwards does not redirect the handle.
        std::fs::remove_file(&a).unwrap();
        std::fs::write(&a, b"EVIL").unwrap();
        assert_eq!(read_chunk(&f.handle, 0, 5).unwrap(), b"hello");

        release(&f.handle);
        assert_eq!(read_chunk(&f.handle, 0, 1).unwrap_err().code, "no_handle");

        // Per-chunk cap.
        let c = d.join("chunky.bin");
        std::fs::write(&c, vec![7u8; (CHUNK_MAX + 10) as usize]).unwrap();
        let r = register(vec![c]);
        assert_eq!(read_chunk(&r.files[0].handle, 0, u64::MAX).unwrap().len() as u64, CHUNK_MAX);

        // Total cap: 25 MB files, the fifth no longer fits under 100 MB.
        clear();
        let mut paths = Vec::new();
        for i in 0..5 {
            let p = d.join(format!("t{i}.bin"));
            File::create(&p).unwrap().set_len(FILE_MAX_BYTES).unwrap();
            paths.push(p);
        }
        let r = register(paths);
        assert_eq!(r.files.len(), 4);
        assert_eq!(r.rejected, vec![Rejected { name: "t4.bin".into(), reason: "total_limit" }]);

        // Handle count / per-pick limits.
        clear();
        let e = d.join("e.txt");
        std::fs::write(&e, b"x").unwrap();
        let r = register(vec![e.clone(); MAX_PER_PICK + 3]);
        assert_eq!((r.files.len(), r.rejected.len()), (MAX_PER_PICK, 3));
        assert!(r.rejected.iter().all(|x| x.reason == "too_many"));
        clear();
        for _ in 0..4 {
            register(vec![e.clone(); MAX_PER_PICK]);
        }
        assert_eq!(with_store(|s| s.map.len()), MAX_HANDLES);

        // Expiry.
        clear();
        let r = register(vec![e.clone()]);
        with_store(|s| s.map.get_mut(&r.files[0].handle).unwrap().created = Instant::now() - TTL - Duration::from_secs(1));
        assert_eq!(read_chunk(&r.files[0].handle, 0, 1).unwrap_err().code, "no_handle");
        clear();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn devices_fifos_and_symlink_swaps_are_refused() {
        let d = scratch("unix");
        // A device and a FIFO are not regular files and are never read.
        assert_eq!(open_picked(Path::new("/dev/null")).unwrap_err(), "not_regular");
        let fifo = d.join("pipe");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert_eq!(open_picked(&fifo).unwrap_err(), "not_regular", "opened O_NONBLOCK, so no hang");
        // O_NOFOLLOW: a symlink at the final component of the canonical path is refused.
        let target = d.join("t.txt");
        std::fs::write(&target, b"x").unwrap();
        let link = d.join("l");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(open_nofollow(&link).is_err());
        // A picked symlink is resolved once, at canonicalisation.
        assert_eq!(open_picked(&link).unwrap().1, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn mime_is_from_the_extension_only() {
        assert_eq!(mime_guess("x.PDF"), "application/pdf");
        assert_eq!(mime_guess("x.tar.gz"), "application/octet-stream");
        assert_eq!(mime_guess("noext"), "application/octet-stream");
        assert_eq!(display_name(Path::new("/a/b/\u{202E}\u{0007}")), "file");
    }
}
