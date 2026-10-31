//! Read-only access to the user's notes folder (S-E, Library read side).
//!
//! The desktop reads notes AS FILES in the same folder the Mac app uses (the "one copy" is
//! the file; no notes API on the server). Security model, same shape as `project.rs` and
//! `graph_file.rs`:
//!
//! - The notes root is chosen by the host through a native folder dialog (`rfd`), never by
//!   the webview. It is canonicalised, refused when too broad (`project::is_too_broad`, the
//!   same list as the project root and the server), stored in the app data dir, and
//!   re-validated on every call, so a hand-edited settings file or a root swapped for a
//!   symlink to a broad directory cannot widen access.
//! - The webview only ever passes a RELATIVE path (`a/b/c.md`) that came from `notes_list`.
//!   Every segment is checked (no `..`, no empty segment, no NUL, no backslash), the path is
//!   canonicalised and must stay inside the canonical root, the file is opened once without
//!   following a symlink on the last component, its real location is read back from the
//!   descriptor (`F_GETPATH` / `/proc/self/fd`) and must still be inside the root, and the
//!   bytes are read from that same descriptor (the swap-between-check-and-read race closes).
//! - Read-only: there is no write, rename or delete command in this module.
//! - Bounded everywhere: page size, entries visited per call, directory depth, bytes per
//!   read, whole-file size, files and bytes per `notes_heads` batch. Symlinks are never
//!   followed while listing. Hidden files and directories are skipped, except the iCloud
//!   stub `.<name>.icloud`, which is listed as a placeholder (and never downloaded: a
//!   placeholder, or a macOS dataless file, is refused with `not_downloaded`).
//!
//! Errors are strings that start with a stable code (`no_root`, `outside_root`,
//! `not_found`, `not_downloaded`, `too_large`, `invalid_path`, `io`), then `: detail`.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// Entries returned per `notes_list` page, at most.
pub const MAX_PAGE: usize = 2000;
/// Files examined per `notes_list` call (matching or not), so a folder full of other files
/// cannot hold the call; the cursor then continues where it stopped.
pub const VISIT_BUDGET: usize = 20_000;
/// Deepest directory level listed.
pub const MAX_DEPTH: usize = 24;
/// Default and maximum bytes returned by one `notes_read`.
pub const READ_DEFAULT_BYTES: usize = 256 * 1024;
pub const READ_MAX_BYTES: usize = 1024 * 1024;
const READ_MIN_BYTES: usize = 4 * 1024;
/// Files larger than this are refused outright.
pub const FILE_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// `notes_heads`: files per call, bytes per file, and total bytes returned per call.
pub const HEADS_MAX_FILES: usize = 400;
pub const HEAD_MAX_BYTES: usize = 8 * 1024;
pub const HEADS_TOTAL_MAX: usize = 4 * 1024 * 1024;
const ROOT_FILE_MAX_BYTES: u64 = 16 * 1024;
const NAME_MAX_CHARS: usize = 60;
/// macOS `SF_DATALESS`: the file's data lives in the cloud (iCloud, File Provider).
#[cfg(target_os = "macos")]
const SF_DATALESS: u32 = 0x4000_0000;

static ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NotesRootInfo {
    pub name: String,
    pub root: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NoteEntry {
    /// Forward-slash path relative to the root (also on Windows).
    pub rel: String,
    pub size: u64,
    pub mtime_ms: i64,
    /// Not downloaded (iCloud stub or dataless file): listed, never read.
    pub placeholder: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ListPage {
    pub entries: Vec<NoteEntry>,
    /// Pass back to continue; `None` when the walk finished.
    pub next_cursor: Option<String>,
    /// Files examined in this call (for progress and benchmarks).
    pub visited: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ReadChunk {
    pub rel: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub offset: u64,
    pub text: String,
    /// Offset for the next chunk; `None` at the end of the file.
    pub next_offset: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NoteHead {
    pub rel: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub head: Option<String>,
    pub error: Option<String>,
}

fn err(code: &str, detail: impl std::fmt::Display) -> String {
    format!("{code}: {detail}")
}

// ---- root ------------------------------------------------------------------------------------

fn root_file(dir: &Path) -> PathBuf {
    dir.join("notes-root.json")
}

fn display_name(root: &Path) -> String {
    let n = root.file_name().and_then(|n| n.to_str()).unwrap_or("notes");
    n.chars().filter(|c| !c.is_control()).take(NAME_MAX_CHARS).collect()
}

fn info(root: &Path) -> NotesRootInfo {
    NotesRootInfo { name: display_name(root), root: root.to_string_lossy().into_owned() }
}

/// Canonicalises `p`, requires a folder and refuses a too-broad one.
pub fn validate_notes_root(p: &Path) -> Result<PathBuf, String> {
    crate::project::validate_root(p).map_err(|e| err("invalid_root", e))
}

fn load_root(dir: &Path) -> Option<PathBuf> {
    let f = root_file(dir);
    let m = std::fs::metadata(&f).ok()?;
    if !m.is_file() || m.len() > ROOT_FILE_MAX_BYTES {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&f).ok()?).ok()?;
    validate_notes_root(Path::new(v.get("root")?.as_str()?)).ok()
}

fn save_root(dir: &Path, root: &Path) -> Result<(), String> {
    crate::fsutil::private_dir(dir)?;
    let body = serde_json::json!({ "root": root.to_string_lossy() }).to_string();
    crate::fsutil::write_private_atomic(&root_file(dir), body.as_bytes(), ROOT_FILE_MAX_BYTES as usize)
}

/// The root to use now: the one accepted through `notes_root_choose` this session, else the
/// persisted one (re-validated), else (debug builds only) `LLMIDE_NOTES_ROOT`.
pub(crate) fn current_root() -> Result<PathBuf, String> {
    if let Some(r) = ROOT.lock().ok().and_then(|g| g.clone()) {
        return Ok(r);
    }
    if let Ok(dir) = crate::fsutil::desktop_data_dir() {
        if let Some(r) = load_root(&dir) {
            if let Ok(mut g) = ROOT.lock() {
                *g = Some(r.clone());
            }
            return Ok(r);
        }
    }
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("LLMIDE_NOTES_ROOT").filter(|v| !v.is_empty()) {
        return validate_notes_root(Path::new(&p));
    }
    Err(err("no_root", "no notes folder is configured"))
}

// ---- hardened open ---------------------------------------------------------------------------

/// Splits and checks a relative path from the webview.
fn rel_segments(rel: &str) -> Result<Vec<&str>, String> {
    if rel.is_empty() || rel.len() > 4096 || rel.contains('\0') || rel.contains('\\') || rel.starts_with('/') {
        return Err(err("invalid_path", "not a relative notes path"));
    }
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == ".." || s.contains(':')) {
        return Err(err("invalid_path", "not a relative notes path"));
    }
    Ok(segs)
}

pub(crate) fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| err("no_root", format!("notes folder is not available: {e}")))?;
    // Re-evaluated on every call: the root may have been swapped for a symlink to a broad directory.
    if crate::project::is_too_broad(&root.to_string_lossy(), crate::project::home_dir().as_deref()) {
        return Err(err("invalid_root", "the notes folder is too broad"));
    }
    Ok(root)
}

fn open_nofollow(p: &Path) -> Result<std::fs::File, String> {
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    opts.open(p).map_err(|e| err("io", format!("cannot open: {e}")))
}

#[cfg(target_os = "macos")]
fn fd_path(f: &std::fs::File) -> Option<PathBuf> {
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
fn fd_path(f: &std::fs::File) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd())).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn fd_path(_: &std::fs::File) -> Option<PathBuf> {
    None
}

#[cfg(target_os = "macos")]
fn is_dataless(m: &std::fs::Metadata) -> bool {
    use std::os::macos::fs::MetadataExt;
    m.st_flags() & SF_DATALESS != 0
}

#[cfg(not(target_os = "macos"))]
fn is_dataless(_: &std::fs::Metadata) -> bool {
    false
}

pub(crate) fn mtime_ms(m: &std::fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Opens `rel` inside `root` (see the module docs) and returns the open file and its metadata.
pub(crate) fn open_in_root(root: &Path, rel: &str) -> Result<(std::fs::File, std::fs::Metadata), String> {
    let segs = rel_segments(rel)?;
    let root = canonical_root(root)?;
    let mut joined = root.clone();
    for s in &segs {
        joined.push(s);
    }
    let canonical = match std::fs::canonicalize(&joined) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // An iCloud stub sits next to where the file would be: say so instead of "not found".
            if let (Some(parent), Some(name)) = (joined.parent(), joined.file_name().and_then(|n| n.to_str())) {
                if parent.join(format!(".{name}.icloud")).exists() {
                    return Err(err("not_downloaded", "the file is in iCloud and is not downloaded"));
                }
            }
            return Err(err("not_found", rel));
        }
        Err(e) => return Err(err("io", format!("cannot resolve {rel}: {e}"))),
    };
    if !canonical.starts_with(&root) {
        return Err(err("outside_root", "path is outside the notes folder"));
    }
    let file = open_nofollow(&canonical)?;
    // Verify what was actually opened, not the path resolved a moment ago.
    if let Some(real) = fd_path(&file) {
        if !real.starts_with(&root) {
            return Err(err("outside_root", "path is outside the notes folder"));
        }
    } else if cfg!(any(target_os = "macos", target_os = "linux")) {
        return Err(err("io", "cannot verify the opened file"));
    }
    let meta = file.metadata().map_err(|e| err("io", e))?;
    if !meta.is_file() {
        return Err(err("invalid_path", "not a regular file"));
    }
    // A hard link may be another name for a file outside the notes folder: its path says nothing about where
    // the bytes live, so it is never read (same rule as the project file reads).
    if crate::fs_ops::nlink(&meta) > 1 {
        return Err(err("hardlink", "the note has several hard links; refusing to read it"));
    }
    if is_dataless(&meta) {
        return Err(err("not_downloaded", "the file is in the cloud and is not downloaded"));
    }
    if meta.len() > FILE_MAX_BYTES {
        return Err(err("too_large", format!("{} bytes", meta.len())));
    }
    Ok((file, meta))
}

/// Trims a byte chunk to whole UTF-8 characters. An incomplete sequence at the END is cut
/// (the next chunk starts there) unless `at_eof`; invalid bytes elsewhere become U+FFFD.
/// Returns the text and how many bytes it consumed.
fn utf8_chunk(buf: &[u8], at_eof: bool) -> (String, usize) {
    match std::str::from_utf8(buf) {
        Ok(s) => (s.to_string(), buf.len()),
        Err(e) if e.error_len().is_none() && !at_eof && e.valid_up_to() > 0 => {
            let n = e.valid_up_to();
            (String::from_utf8_lossy(&buf[..n]).into_owned(), n)
        }
        Err(_) => (String::from_utf8_lossy(buf).into_owned(), buf.len()),
    }
}

// ---- read ------------------------------------------------------------------------------------

/// Reads up to `max_bytes` of `rel` starting at `offset`.
pub fn read_chunk(root: &Path, rel: &str, offset: u64, max_bytes: usize) -> Result<ReadChunk, String> {
    let max = max_bytes.clamp(READ_MIN_BYTES, READ_MAX_BYTES);
    let (mut file, meta) = open_in_root(root, rel)?;
    let size = meta.len();
    if offset > size {
        return Err(err("invalid_path", "offset is past the end of the file"));
    }
    file.seek(SeekFrom::Start(offset)).map_err(|e| err("io", e))?;
    let mut buf = Vec::with_capacity(max.min(size.saturating_sub(offset) as usize));
    // `take` bounds the read even if the file grows after fstat.
    file.take(max as u64).read_to_end(&mut buf).map_err(|e| err("io", format!("read failed: {e}")))?;
    let at_eof = offset + buf.len() as u64 >= size;
    let (text, used) = utf8_chunk(&buf, at_eof);
    let end = offset + used as u64;
    Ok(ReadChunk {
        rel: rel.to_string(),
        size,
        mtime_ms: mtime_ms(&meta),
        offset,
        text,
        next_offset: if end >= size { None } else { Some(end) },
    })
}

/// The first `head_max` bytes of each file (frontmatter and a little body), for classifying
/// and titling many notes without a read round trip each. Per-file failures are reported in
/// the entry, not as a whole-call error.
pub fn read_heads(root: &Path, rels: &[String], head_max: usize) -> Result<Vec<NoteHead>, String> {
    if rels.len() > HEADS_MAX_FILES {
        return Err(err("invalid_path", format!("at most {HEADS_MAX_FILES} files per call")));
    }
    let head_max = head_max.clamp(512, HEAD_MAX_BYTES);
    let mut out = Vec::with_capacity(rels.len());
    let mut total = 0usize;
    for rel in rels {
        if total >= HEADS_TOTAL_MAX {
            out.push(NoteHead { rel: rel.clone(), size: 0, mtime_ms: 0, head: None, error: Some(err("budget", "batch byte budget reached")) });
            continue;
        }
        let one = open_in_root(root, rel).and_then(|(file, meta)| {
            let mut buf = Vec::new();
            file.take(head_max as u64).read_to_end(&mut buf).map_err(|e| err("io", e))?;
            let at_eof = buf.len() as u64 >= meta.len();
            let (text, _) = utf8_chunk(&buf, at_eof);
            Ok((text, meta.len(), mtime_ms(&meta)))
        });
        match one {
            Ok((text, size, m)) => {
                total += text.len();
                out.push(NoteHead { rel: rel.clone(), size, mtime_ms: m, head: Some(text), error: None });
            }
            Err(e) => out.push(NoteHead { rel: rel.clone(), size: 0, mtime_ms: 0, head: None, error: Some(e) }),
        }
    }
    Ok(out)
}

// ---- list ------------------------------------------------------------------------------------

const NOTE_EXTS: [&str; 3] = ["md", "markdown", "txt"];

pub(crate) fn is_note_name(name: &str) -> bool {
    if name.ends_with(".partial.md") {
        return false;
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) => !stem.is_empty() && NOTE_EXTS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

struct Item {
    /// Effective name (the real name for an iCloud stub).
    name: String,
    is_dir: bool,
    stub: bool,
}

struct Walk {
    limit: usize,
    budget: usize,
    visited: usize,
    out: Vec<NoteEntry>,
    last: Option<String>,
    stopped: bool,
}

impl Walk {
    fn walk(&mut self, dir: &Path, rel: &str, depth: usize, cursor: &[&str]) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut items: Vec<Item> = Vec::new();
        for e in rd.flatten() {
            let Ok(name) = e.file_name().into_string() else { continue };
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue; // never followed while listing
            }
            if ft.is_dir() {
                if !name.starts_with('.') && name != "node_modules" {
                    items.push(Item { name, is_dir: true, stub: false });
                }
            } else if ft.is_file() {
                if let Some(real) = name.strip_prefix('.').and_then(|n| n.strip_suffix(".icloud")).filter(|n| !n.is_empty()) {
                    items.push(Item { name: real.to_string(), is_dir: false, stub: true });
                } else if !name.starts_with('.') {
                    items.push(Item { name, is_dir: false, stub: false });
                }
            }
        }
        // A real file beats its own stub; order by name so a cursor can resume by path.
        items.sort_by(|a, b| a.name.cmp(&b.name).then(a.stub.cmp(&b.stub)));
        items.dedup_by(|b, a| a.name == b.name && !a.is_dir && !b.is_dir);

        let mut cursor = cursor;
        for it in items {
            if let Some(c0) = cursor.first().copied() {
                if it.name.as_str() < c0 {
                    continue;
                }
                if it.name == c0 {
                    if it.is_dir && cursor.len() > 1 {
                        let child_rel = join_rel(rel, &it.name);
                        self.walk(&dir.join(&it.name), &child_rel, depth + 1, &cursor[1..]);
                        if self.stopped {
                            return;
                        }
                    }
                    cursor = &[];
                    continue;
                }
                cursor = &[]; // past the resume point: the rest of this directory is new
            }
            let child_rel = join_rel(rel, &it.name);
            if it.is_dir {
                if depth + 1 <= MAX_DEPTH {
                    self.walk(&dir.join(&it.name), &child_rel, depth + 1, &[]);
                    if self.stopped {
                        return;
                    }
                }
                continue;
            }
            self.visited += 1;
            self.last = Some(child_rel.clone());
            if is_note_name(&it.name) {
                let path = if it.stub { dir.join(format!(".{}.icloud", it.name)) } else { dir.join(&it.name) };
                if let Ok(m) = std::fs::symlink_metadata(&path) {
                    let placeholder = it.stub || is_dataless(&m);
                    self.out.push(NoteEntry {
                        rel: child_rel,
                        size: if placeholder { 0 } else { m.len() },
                        mtime_ms: mtime_ms(&m),
                        placeholder,
                    });
                }
            }
            if self.out.len() >= self.limit || self.visited >= self.budget {
                self.stopped = true;
                return;
            }
        }
    }
}

fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

/// One page of note files under `root`, in stable path order, resuming after `cursor`.
pub fn list_page(root: &Path, cursor: Option<&str>, limit: usize) -> Result<ListPage, String> {
    let root = canonical_root(root)?;
    let limit = limit.clamp(1, MAX_PAGE);
    let segs: Vec<&str> = match cursor {
        None | Some("") => Vec::new(),
        Some(c) => rel_segments(c).map_err(|_| err("invalid_path", "bad cursor"))?,
    };
    let mut w = Walk { limit, budget: VISIT_BUDGET, visited: 0, out: Vec::new(), last: None, stopped: false };
    w.walk(&root, "", 0, &segs);
    Ok(ListPage {
        entries: w.out,
        next_cursor: if w.stopped { w.last } else { None },
        visited: w.visited,
    })
}

// ---- commands --------------------------------------------------------------------------------

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| err("io", format!("notes task failed: {e}")))?
}

/// The configured notes folder, if any (re-validated).
#[tauri::command]
pub fn notes_root_get() -> Option<NotesRootInfo> {
    current_root().ok().map(|r| info(&r))
}

/// Opens the native folder dialog and stores the choice; `None` when cancelled.
#[tauri::command]
pub async fn notes_root_choose() -> Result<Option<NotesRootInfo>, String> {
    let picked = rfd::AsyncFileDialog::new().set_title("Choose notes folder").pick_folder().await;
    let Some(handle) = picked else { return Ok(None) };
    let root = validate_notes_root(handle.path())?;
    if let Ok(dir) = crate::fsutil::desktop_data_dir() {
        // A failed settings write must not block using the folder this session.
        if let Err(e) = save_root(&dir, &root) {
            eprintln!("notes: root not saved: {e}");
        }
    }
    if let Ok(mut g) = ROOT.lock() {
        *g = Some(root.clone());
    }
    Ok(Some(info(&root)))
}

/// Forgets the notes folder (the files are untouched).
#[tauri::command]
pub fn notes_root_clear() -> Result<(), String> {
    if let Ok(mut g) = ROOT.lock() {
        *g = None;
    }
    if let Ok(dir) = crate::fsutil::desktop_data_dir() {
        let _ = std::fs::remove_file(root_file(&dir));
    }
    Ok(())
}

#[tauri::command]
pub async fn notes_list(cursor: Option<String>, limit: Option<usize>) -> Result<ListPage, String> {
    let root = current_root()?;
    blocking(move || list_page(&root, cursor.as_deref(), limit.unwrap_or(MAX_PAGE))).await
}

#[tauri::command]
pub async fn notes_read(rel: String, offset: Option<u64>, max_bytes: Option<usize>) -> Result<ReadChunk, String> {
    let root = current_root()?;
    blocking(move || read_chunk(&root, &rel, offset.unwrap_or(0), max_bytes.unwrap_or(READ_DEFAULT_BYTES))).await
}

#[tauri::command]
pub async fn notes_heads(rels: Vec<String>, max_bytes: Option<usize>) -> Result<Vec<NoteHead>, String> {
    let root = current_root()?;
    blocking(move || read_heads(&root, &rels, max_bytes.unwrap_or(2048))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-notes-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        // Under the real temp dir (a deep path), never "too broad".
        fs::canonicalize(&d).unwrap().join("notes")
    }

    #[cfg(unix)]
    #[test]
    fn a_hard_linked_note_is_never_read() {
        let root = scratch("hardlink-read");
        let outside = root.parent().unwrap().join("outside-secret.md");
        fs::write(&outside, "secret outside the notes folder").unwrap();
        mk(&root, "plain.md", "fine");
        fs::hard_link(&outside, root.join("linked.md")).unwrap();
        assert!(open_in_root(&root, "plain.md").is_ok());
        assert_eq!(open_in_root(&root, "linked.md").unwrap_err().split(':').next().unwrap(), "hardlink");
    }

    fn mk(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn all(root: &Path, limit: usize) -> (Vec<String>, usize) {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            let p = list_page(root, cursor.as_deref(), limit).unwrap();
            pages += 1;
            out.extend(p.entries.into_iter().map(|e| e.rel));
            match p.next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
            assert!(pages < 100_000, "cursor must make progress");
        }
        (out, pages)
    }

    #[test]
    fn lists_note_files_in_stable_path_order_and_skips_the_rest() {
        let root = scratch("order");
        mk(&root, "source/meetings/2026/10/b.md", "b");
        mk(&root, "source/meetings/2026/10/a.md", "a");
        mk(&root, "llm-doc/emails/x.md", "x");
        mk(&root, "source/emails/raw.txt", "raw");
        mk(&root, "source/meetings/2026/10/c.partial.md", "p");
        mk(&root, "source/meetings/2026/10/image.png", "png");
        mk(&root, ".hidden/h.md", "h");
        mk(&root, "node_modules/n.md", "n");
        mk(&root, "README", "no ext");
        let (rels, _) = all(&root, 100);
        assert_eq!(
            rels,
            ["llm-doc/emails/x.md", "source/emails/raw.txt", "source/meetings/2026/10/a.md", "source/meetings/2026/10/b.md"]
        );
    }

    #[test]
    fn paging_never_repeats_or_drops_an_entry_at_any_page_size() {
        let root = scratch("paging");
        for d in 0..7 {
            for f in 0..13 {
                mk(&root, &format!("d{d:02}/sub{}/n{f:02}.md", f % 3), "x");
            }
            mk(&root, &format!("d{d:02}/top.md"), "x");
        }
        mk(&root, "zz.md", "x");
        let (expect, _) = all(&root, 2000);
        assert_eq!(expect.len(), 7 * 14 + 1);
        for size in [1, 2, 3, 7, 50, 91] {
            let (got, pages) = all(&root, size);
            assert_eq!(got, expect, "page size {size}");
            // A page that exactly fills the limit leaves one final empty page behind it.
            assert_eq!(pages, expect.len() / size + 1, "page size {size}");
        }
    }

    #[test]
    fn the_cursor_survives_the_last_file_being_deleted_between_pages() {
        let root = scratch("cursor-del");
        for n in ["a", "b", "c", "d"] {
            mk(&root, &format!("{n}.md"), "x");
        }
        let p1 = list_page(&root, None, 2).unwrap();
        assert_eq!(p1.entries.len(), 2);
        let cur = p1.next_cursor.unwrap();
        assert_eq!(cur, "b.md");
        fs::remove_file(root.join("b.md")).unwrap();
        let p2 = list_page(&root, Some(&cur), 10).unwrap();
        assert_eq!(p2.entries.iter().map(|e| e.rel.as_str()).collect::<Vec<_>>(), ["c.md", "d.md"]);
        assert!(p2.next_cursor.is_none());
    }

    #[test]
    fn a_huge_directory_pages_within_the_visit_budget() {
        let root = scratch("huge");
        fs::create_dir_all(&root).unwrap();
        for i in 0..2500 {
            fs::write(root.join(format!("n{i:05}.md")), "x").unwrap();
        }
        // Non-note files burn the visit budget without producing entries.
        for i in 0..300 {
            fs::write(root.join(format!("z{i:05}.bin")), "x").unwrap();
        }
        let (rels, pages) = all(&root, 1000);
        assert_eq!(rels.len(), 2500);
        assert_eq!(pages, 3);
        let p = list_page(&root, None, 5000).unwrap(); // limit is clamped to MAX_PAGE
        assert_eq!(p.entries.len(), MAX_PAGE);
    }

    #[test]
    fn unicode_names_and_spaces_round_trip() {
        let root = scratch("uni");
        mk(&root, "会議/2026-10-31 週次 レビュー.md", "日本語の本文 🚀");
        mk(&root, "café/naïve résumé.md", "x");
        let (rels, _) = all(&root, 100);
        assert_eq!(rels, ["café/naïve résumé.md", "会議/2026-10-31 週次 レビュー.md"]);
        let c = read_chunk(&root, "会議/2026-10-31 週次 レビュー.md", 0, 4096).unwrap();
        assert_eq!(c.text, "日本語の本文 🚀");
        assert!(c.next_offset.is_none());
    }

    #[test]
    fn icloud_stubs_are_listed_as_placeholders_and_refused_on_read() {
        let root = scratch("icloud");
        mk(&root, "a/.report.md.icloud", "stub");
        mk(&root, "a/real.md", "real");
        mk(&root, "a/.both.md.icloud", "stub");
        mk(&root, "a/both.md", "real");
        mk(&root, "a/.photo.png.icloud", "stub");
        let p = list_page(&root, None, 100).unwrap();
        let by: Vec<(String, bool)> = p.entries.iter().map(|e| (e.rel.clone(), e.placeholder)).collect();
        assert_eq!(
            by,
            [("a/both.md".to_string(), false), ("a/real.md".to_string(), false), ("a/report.md".to_string(), true)]
        );
        assert_eq!(p.entries[2].size, 0);
        let e = read_chunk(&root, "a/report.md", 0, 4096).unwrap_err();
        assert!(e.starts_with("not_downloaded:"), "{e}");
        assert_eq!(read_chunk(&root, "a/real.md", 0, 4096).unwrap().text, "real");
        assert!(read_chunk(&root, "a/missing.md", 0, 4096).unwrap_err().starts_with("not_found:"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_listed_and_cannot_escape_the_root() {
        let root = scratch("symlink");
        let outside = scratch("symlink-out");
        mk(&outside, "secret.md", "top secret");
        mk(&root, "ok.md", "ok");
        std::os::unix::fs::symlink(&outside, root.join("linkdir")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), root.join("link.md")).unwrap();
        let (rels, _) = all(&root, 100);
        assert_eq!(rels, ["ok.md"]);
        for rel in ["linkdir/secret.md", "link.md"] {
            let e = read_chunk(&root, rel, 0, 4096).unwrap_err();
            assert!(e.starts_with("outside_root:") || e.starts_with("io:"), "{rel}: {e}");
        }
        // The heads batch reports it per file, never reads it.
        let h = read_heads(&root, &["link.md".to_string(), "ok.md".to_string()], 2048).unwrap();
        assert!(h[0].head.is_none() && h[0].error.is_some());
        assert_eq!(h[1].head.as_deref(), Some("ok"));
    }

    #[cfg(unix)]
    #[test]
    fn open_refuses_a_symlink_on_the_last_component() {
        let d = scratch("nofollow");
        mk(&d, "real.md", "x");
        std::os::unix::fs::symlink(d.join("real.md"), d.join("link.md")).unwrap();
        assert!(open_nofollow(&d.join("link.md")).is_err());
        assert!(open_nofollow(&d.join("real.md")).is_ok());
    }

    #[test]
    fn hostile_relative_paths_are_rejected_before_touching_the_disk() {
        let root = scratch("hostile");
        mk(&root, "a.md", "x");
        for rel in ["", "/etc/passwd", "../a.md", "a/../a.md", "a//b.md", "./a.md", "a\\b.md", "a\0b.md", "C:/x.md", "a/./b.md"] {
            let e = read_chunk(&root, rel, 0, 4096).unwrap_err();
            assert!(e.starts_with("invalid_path:"), "{rel:?}: {e}");
        }
        assert!(list_page(&root, Some("../x"), 10).unwrap_err().starts_with("invalid_path:"));
    }

    #[test]
    fn a_missing_or_too_broad_root_is_refused() {
        let root = scratch("missing").join("nope");
        assert!(read_chunk(&root, "a.md", 0, 4096).unwrap_err().starts_with("no_root:"));
        assert!(list_page(&root, None, 10).is_err());
        for broad in ["/", "/usr", "/etc"] {
            let e = list_page(Path::new(broad), None, 10).unwrap_err();
            assert!(e.starts_with("invalid_root:") || e.starts_with("no_root:"), "{broad}: {e}");
        }
        assert!(validate_notes_root(Path::new("/")).is_err());
    }

    #[test]
    fn chunked_reads_reassemble_exactly_and_never_split_a_character() {
        let root = scratch("chunks");
        let body: String = "あいう𝄞e\u{301}x\n".repeat(1500); // multi-byte, 4-byte, combining
        mk(&root, "big.md", &body);
        let mut text = String::new();
        let mut offset = 0u64;
        let mut chunks = 0;
        loop {
            let c = read_chunk(&root, "big.md", offset, 4097).unwrap();
            assert!(!c.text.contains('\u{FFFD}'), "chunk {chunks} split a character");
            text.push_str(&c.text);
            chunks += 1;
            match c.next_offset {
                Some(n) => {
                    assert!(n > offset);
                    offset = n;
                }
                None => break,
            }
        }
        assert!(chunks > 3);
        assert_eq!(text, body);
    }

    #[test]
    fn invalid_utf8_is_replaced_not_fatal_and_offsets_are_bounded() {
        let root = scratch("badutf");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("bad.md"), [b'a', 0xff, 0xfe, b'b']).unwrap();
        let c = read_chunk(&root, "bad.md", 0, 4096).unwrap();
        assert_eq!(c.text, "a\u{FFFD}\u{FFFD}b");
        assert!(read_chunk(&root, "bad.md", 99, 4096).is_err());
        assert_eq!(read_chunk(&root, "bad.md", 4, 4096).unwrap().text, "");
    }

    #[test]
    fn oversize_files_are_refused_and_requested_sizes_are_clamped() {
        let root = scratch("caps");
        mk(&root, "a.md", &"x".repeat(10_000));
        let c = read_chunk(&root, "a.md", 0, 1).unwrap(); // clamped up to the minimum chunk
        assert_eq!(c.text.len(), READ_MIN_BYTES);
        assert_eq!(c.next_offset, Some(READ_MIN_BYTES as u64));
        let c = read_chunk(&root, "a.md", 0, usize::MAX).unwrap(); // clamped down
        assert_eq!(c.text.len(), 10_000);
        assert_eq!(FILE_MAX_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn heads_are_bounded_per_file_and_per_batch() {
        let root = scratch("heads");
        mk(&root, "a.md", &format!("---\ntitle: A\n---\n{}", "x".repeat(20_000)));
        let h = read_heads(&root, &["a.md".to_string(), "gone.md".to_string()], 100_000).unwrap();
        assert_eq!(h[0].head.as_ref().unwrap().len(), HEAD_MAX_BYTES);
        assert!(h[0].head.as_ref().unwrap().starts_with("---\ntitle: A"));
        assert!(h[1].error.as_ref().unwrap().starts_with("not_found:"));
        let many: Vec<String> = (0..=HEADS_MAX_FILES).map(|i| format!("n{i}.md")).collect();
        assert!(read_heads(&root, &many, 2048).is_err());
    }

    #[test]
    fn note_names() {
        for ok in ["a.md", "A.MD", "a.markdown", "raw.txt", "x.y.md"] {
            assert!(is_note_name(ok), "{ok}");
        }
        for bad in ["a.partial.md", ".md", "a", "a.png", "a.md.bak"] {
            assert!(!is_note_name(bad), "{bad}");
        }
    }

    /// 50k-note benchmark: `LLMIDE_NOTES_BENCH=1 cargo test --lib notes_fs -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_50k_notes() {
        let root = scratch("bench");
        let t = std::time::Instant::now();
        for m in 0..50 {
            let dir = root.join(format!("source/meetings/2026/{:02}", m % 12 + 1)).join(format!("g{m:02}"));
            fs::create_dir_all(&dir).unwrap();
            for i in 0..1000 {
                let body = format!(
                    "---\nid: m-{m}-{i}\ntitle: Meeting {m}-{i}\nstarted_at: '2026-10-01T10:00:00Z'\nparticipants:\n- Alice\n- Bob\nplatform: meet\nlanguage: en\ntldr: []\n---\n\n## Transcript\n\n[10:00:01] **Alice**: hello {i}\n"
                );
                fs::write(dir.join(format!("2026-10-01-m{i:04}.md")), body).unwrap();
            }
        }
        println!("BENCH notes create 50000: {} ms", t.elapsed().as_millis());
        let t = std::time::Instant::now();
        let (rels, pages) = all(&root, MAX_PAGE);
        println!("BENCH notes list 50000: {} ms in {pages} pages ({} entries)", t.elapsed().as_millis(), rels.len());
        assert_eq!(rels.len(), 50_000);
        let t = std::time::Instant::now();
        let mut got = 0;
        for chunk in rels.chunks(HEADS_MAX_FILES) {
            got += read_heads(&root, chunk, 2048).unwrap().iter().filter(|h| h.head.is_some()).count();
        }
        println!("BENCH notes heads 50000: {} ms ({got} heads)", t.elapsed().as_millis());
        assert_eq!(got, 50_000);
        let t = std::time::Instant::now();
        let p = list_page(&root, Some(&rels[49_000]), MAX_PAGE).unwrap();
        println!("BENCH notes resume near the end: {} ms ({} entries)", t.elapsed().as_millis(), p.entries.len());
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }
}
