//! Explorer file operations, confined to the host's active project root.
//!
//! Security model (same family as `graph_file.rs`):
//! - The root is `project::active_root()` (chosen through the host folder dialog), re-read,
//!   re-canonicalised and re-checked against the too-broad list on EVERY call. The webview
//!   only ever sends paths RELATIVE to that root; every path returned is relative too.
//! - A relative path is validated lexically (no `..`, no absolute/drive/UNC, no NUL, no
//!   backslash, bounded length) and then canonicalised; the result must lie inside the root,
//!   so symlinks that point out of the root are rejected.
//! - Files are opened once, without following a symlink on the last component, with
//!   `O_NONBLOCK` (a FIFO cannot hang the host). The REAL location of the open descriptor
//!   (`F_GETPATH` / `/proc/self/fd`) is re-checked against the root and the descriptor is
//!   `fstat`ed: only regular files, and (unix) never a file with more than one hard link, since
//!   a hard link planted into the tree would alias a file outside it. All reads come from that
//!   descriptor, so swapping the path after the check changes nothing.
//! - Directory listings re-canonicalise after reading and fail if the directory moved.
//! - Writes are atomic (temp file in the same directory, fsync, rename, directory fsync, mode
//!   preserved) and optimistic: the caller sends the content hash it read; a different hash on
//!   disk is a `conflict` unless `force`. Create / rename never overwrite (`RENAME_EXCL` /
//!   `RENAME_NOREPLACE` where the OS has it). Delete goes to the OS trash and never falls back
//!   to a permanent delete.
//! - Every operation has a size/count limit (see the constants).

use std::fs::{File, Metadata};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_PATH_LEN: usize = 4096;
pub const LIST_DEFAULT_LIMIT: usize = 1000;
pub const LIST_MAX_LIMIT: usize = 5000;
/// A directory with more entries than this is refused (listing it would pin memory).
pub const LIST_SCAN_CAP: usize = 1_000_000;
pub const READ_DEFAULT_MAX: u64 = 5 * 1024 * 1024;
pub const READ_HARD_MAX: u64 = 32 * 1024 * 1024;
pub const RANGE_MAX: u64 = 1024 * 1024;
pub const WRITE_MAX: usize = 64 * 1024 * 1024;
const BINARY_SNIFF: usize = 8192;

#[derive(Serialize, Debug)]
pub struct FsError {
    pub code: &'static str,
    pub message: String,
}
pub type R<T> = Result<T, FsError>;

fn err<T>(code: &'static str, message: impl Into<String>) -> R<T> {
    Err(FsError { code, message: message.into() })
}
fn io_err(what: &str, e: std::io::Error) -> FsError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "not_found",
        std::io::ErrorKind::AlreadyExists => "exists",
        std::io::ErrorKind::PermissionDenied => "permission_denied",
        _ => "io",
    };
    FsError { code, message: format!("{what}: {e}") }
}

// ---- root + path resolution ------------------------------------------------------------

/// The canonical active root, re-validated now.
pub fn active_root() -> R<PathBuf> {
    let Some(root) = crate::project::active_root() else {
        return err("no_project", "no project is open");
    };
    checked_root(&root)
}

/// Canonicalises `root` and refuses a root that is (now) too broad.
pub fn checked_root(root: &Path) -> R<PathBuf> {
    let real = std::fs::canonicalize(root).map_err(|e| io_err("project root is not available", e))?;
    if !real.is_dir() {
        return err("no_project", "project root is not a directory");
    }
    if crate::project::is_too_broad(&real.to_string_lossy(), crate::project::home_dir().as_deref()) {
        return err("root_too_broad", "the project root is too broad");
    }
    Ok(real)
}

const WIN_RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
    "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Lexical validation of a client path: `""` is the root; otherwise `a/b/c`.
pub fn split_rel(rel: &str) -> R<Vec<&str>> {
    if rel.len() > MAX_PATH_LEN {
        return err("invalid_path", "path too long");
    }
    if rel.contains('\0') || rel.contains('\\') {
        return err("invalid_path", "path contains a forbidden character");
    }
    if rel.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return err("invalid_path", "path must be relative, normalised and inside the project");
        }
        out.push(part);
    }
    Ok(out)
}

/// A single new file/folder name (create / rename target).
pub fn valid_name(name: &str) -> R<()> {
    if name.is_empty() || name.len() > 255 || name == "." || name == ".." {
        return err("invalid_path", "invalid name");
    }
    if name.contains(['/', '\\', '\0']) || name.chars().any(|c| c.is_control()) {
        return err("invalid_path", "name contains a forbidden character");
    }
    if cfg!(windows) {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with('.') || name.ends_with(' ') {
            return err("invalid_path", "name is not valid on Windows");
        }
        let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
        if WIN_RESERVED.contains(&stem.as_str()) {
            return err("invalid_path", "name is a reserved device name on Windows");
        }
    }
    Ok(())
}

fn join(root: &Path, parts: &[&str]) -> PathBuf {
    let mut p = root.to_path_buf();
    for s in parts {
        p.push(s);
    }
    p
}

fn inside(p: &Path, root: &Path) -> bool {
    p.starts_with(root)
}

/// Canonical path of an EXISTING entry, required to lie inside the root.
pub fn resolve_existing(root: &Path, rel: &str) -> R<PathBuf> {
    let parts = split_rel(rel)?;
    let real = std::fs::canonicalize(join(root, &parts)).map_err(|e| io_err("cannot resolve path", e))?;
    if !inside(&real, root) {
        return err("outside_root", "path resolves outside the project root");
    }
    Ok(real)
}

/// Canonical PARENT of a not-yet-existing entry plus its (validated) name.
fn resolve_new(root: &Path, rel: &str) -> R<(PathBuf, String)> {
    let parts = split_rel(rel)?;
    let Some((name, parent_parts)) = parts.split_last() else {
        return err("invalid_path", "the project root itself cannot be the target");
    };
    valid_name(name)?;
    let parent = std::fs::canonicalize(join(root, parent_parts)).map_err(|e| io_err("cannot resolve parent folder", e))?;
    if !inside(&parent, root) {
        return err("outside_root", "path resolves outside the project root");
    }
    if !parent.is_dir() {
        return err("not_a_directory", "parent is not a folder");
    }
    Ok((parent, (*name).to_string()))
}

pub fn rel_of(root: &Path, abs: &Path) -> String {
    let rel = abs.strip_prefix(root).unwrap_or(abs);
    let mut out = String::new();
    for c in rel.components() {
        if let Component::Normal(s) = c {
            if !out.is_empty() {
                out.push('/');
            }
            out.push_str(&s.to_string_lossy());
        }
    }
    out
}

/// True for a path component git treats as its metadata folder: `.git` in any case, with
/// NTFS trailing dots/spaces, the `GIT~1` short name, and HFS+/APFS ignorable code points.
pub fn is_git_component(name: &str) -> bool {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(*c, '\u{200c}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{206a}'..='\u{206f}' | '\u{feff}'))
        .collect();
    let t = cleaned.trim_end_matches(['.', ' ']).to_lowercase();
    t == ".git" || t == "git~1"
}

fn protected<T>() -> R<T> {
    err("protected_path", "git metadata (.git) cannot be changed from the editor")
}

/// Refuses a client path with a `.git` component anywhere (checked before anything touches disk).
pub fn deny_git_rel(rel: &str) -> R<()> {
    if rel.split('/').any(is_git_component) {
        return protected();
    }
    Ok(())
}

/// Refuses a RESOLVED absolute path whose in-root part has a `.git` component (catches symlinks).
fn deny_git_abs(root: &Path, abs: &Path) -> R<()> {
    deny_git_rel(&rel_of(root, abs))
}

// ---- verified file open ---------------------------------------------------------------

pub(crate) fn open_nofollow(p: &Path, write: bool) -> std::io::Result<File> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    if write {
        o.write(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    o.open(p)
}

#[cfg(unix)]
pub(crate) fn nlink(m: &Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    m.nlink()
}
#[cfg(not(unix))]
pub(crate) fn nlink(_: &Metadata) -> u64 {
    1
}

/// Opens `canonical` (already inside the root) and verifies the OPEN descriptor.
fn open_verified(root: &Path, canonical: &Path) -> R<(File, Metadata)> {
    let f = open_nofollow(canonical, false).map_err(|e| io_err("cannot open file", e))?;
    match crate::graph_file::fd_path(&f) {
        Some(real) => {
            if !inside(&real, root) {
                return err("outside_root", "opened file is outside the project root");
            }
        }
        None if cfg!(any(target_os = "macos", target_os = "linux")) => {
            return err("outside_root", "cannot verify the opened file");
        }
        None => {}
    }
    let meta = f.metadata().map_err(|e| io_err("cannot stat file", e))?;
    if !meta.is_file() {
        return err("not_regular", "not a regular file");
    }
    if nlink(&meta) > 1 {
        return err("hardlink", "file has several hard links; refusing to follow it");
    }
    Ok((f, meta))
}

fn mtime_ms(m: &Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

fn sha_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- list_dir ------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default)]
pub struct ListReq {
    pub path: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub show_hidden: bool,
    /// Mark entries matched by `.gitignore` (`ignored: true`).
    #[serde(default)]
    pub gitignore: bool,
    /// Drop entries matched by `.gitignore` (implies `gitignore`).
    #[serde(default)]
    pub hide_ignored: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    /// Relative to the project root, `/` separated.
    pub path: String,
    /// `dir`, `file` or `other` (broken symlink, socket, device).
    pub kind: &'static str,
    pub symlink: bool,
    pub hidden: bool,
    pub ignored: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Serialize, Debug)]
pub struct ListResult {
    pub path: String,
    pub entries: Vec<Entry>,
    /// Entries that pass the filters (the page is a slice of these).
    pub total: usize,
    pub next_offset: Option<usize>,
    /// Entries whose names are not valid UTF-8 (not listed).
    pub skipped: usize,
}

struct Raw {
    name: String,
    is_dir: bool,
}

fn ignore_chain(root: &Path, dir: &Path) -> Vec<ignore::gitignore::Gitignore> {
    // root .git/info/exclude first (lowest priority), then .gitignore from root down to `dir`.
    let mut chain = Vec::new();
    let mut b = ignore::gitignore::GitignoreBuilder::new(root);
    let _ = b.add(root.join(".git").join("info").join("exclude"));
    if let Ok(g) = b.build() {
        chain.push(g);
    }
    let rel = dir.strip_prefix(root).unwrap_or(Path::new(""));
    let mut cur = root.to_path_buf();
    let mut levels = vec![cur.clone()];
    for c in rel.components() {
        cur.push(c);
        levels.push(cur.clone());
    }
    for level in levels {
        let f = level.join(".gitignore");
        if f.is_file() {
            let mut b = ignore::gitignore::GitignoreBuilder::new(&level);
            let _ = b.add(&f);
            if let Ok(g) = b.build() {
                chain.push(g);
            }
        }
    }
    chain
}

fn is_ignored(chain: &[ignore::gitignore::Gitignore], path: &Path, is_dir: bool) -> bool {
    for g in chain.iter().rev() {
        if !path.starts_with(g.path()) {
            continue;
        }
        match g.matched(path, is_dir) {
            ignore::Match::Ignore(_) => return true,
            ignore::Match::Whitelist(_) => return false,
            ignore::Match::None => {}
        }
    }
    false
}

fn sort_key(r: &Raw) -> (bool, String) {
    (!r.is_dir, r.name.to_lowercase())
}


type RawList = (std::sync::Arc<Vec<Raw>>, usize);
type CacheKey = (PathBuf, bool, bool, bool);
static LIST_CACHE: std::sync::Mutex<Vec<(CacheKey, Option<std::time::SystemTime>, RawList)>> = std::sync::Mutex::new(Vec::new());
/// Sorted snapshots kept (most recent last); each is bounded by LIST_SCAN_CAP names.
const LIST_CACHE_SLOTS: usize = 3;

fn cache_get(key: &CacheKey, mtime: Option<std::time::SystemTime>) -> Option<RawList> {
    let c = LIST_CACHE.lock().ok()?;
    c.iter().find(|(k, m, _)| k == key && *m == mtime && mtime.is_some()).map(|(_, _, v)| (v.0.clone(), v.1))
}

fn cache_put(key: CacheKey, mtime: Option<std::time::SystemTime>, v: &RawList) {
    if let Ok(mut c) = LIST_CACHE.lock() {
        c.retain(|(k, _, _)| *k != key);
        if c.len() >= LIST_CACHE_SLOTS {
            c.remove(0);
        }
        c.push((key, mtime, (v.0.clone(), v.1)));
    }
}

fn build_raws(
    dir: &Path,
    req: &ListReq,
    chain: &[ignore::gitignore::Gitignore],
    dir_hidden_by_ignore: bool,
) -> R<RawList> {
    let rd = std::fs::read_dir(dir).map_err(|e| io_err("cannot list folder", e))?;
    let mut raws: Vec<Raw> = Vec::new();
    let mut skipped = 0usize;
    let mut scanned = 0usize;
    for ent in rd {
        scanned += 1;
        if scanned > LIST_SCAN_CAP {
            return err("too_large", "folder has too many entries to list");
        }
        let Ok(ent) = ent else { continue };
        let Ok(name) = ent.file_name().into_string() else {
            skipped += 1;
            continue;
        };
        if !req.show_hidden && name.starts_with('.') {
            continue;
        }
        // d_type from the directory entry; a symlink is resolved on the page below.
        let ft = ent.file_type().ok();
        let is_dir = ft.is_some_and(|t| t.is_dir());
        let is_link = ft.is_some_and(|t| t.is_symlink());
        if req.hide_ignored {
            let target_dir = if is_link { dir.join(&name).is_dir() } else { is_dir };
            if dir_hidden_by_ignore || is_ignored(chain, &dir.join(&name), target_dir) {
                continue;
            }
        }
        raws.push(Raw { name, is_dir: is_dir || (is_link && dir.join(&ent.file_name()).is_dir()) });
    }
    raws.sort_by_key(sort_key);

    Ok((std::sync::Arc::new(raws), skipped))
}

pub fn list_dir(root: &Path, req: &ListReq) -> R<ListResult> {
    let dir = resolve_existing(root, &req.path)?;
    if !dir.is_dir() {
        return err("not_a_directory", "not a folder");
    }
    let limit = req.limit.unwrap_or(LIST_DEFAULT_LIMIT).clamp(1, LIST_MAX_LIMIT);

    let gi = req.gitignore || req.hide_ignored;
    let chain = if gi { ignore_chain(root, &dir) } else { Vec::new() };
    let dir_hidden_by_ignore = gi && !dir.as_os_str().is_empty() && dir != *root && {
        let parent_chain = ignore_chain(root, dir.parent().unwrap_or(root));
        is_ignored(&parent_chain, &dir, true)
    };

    let dir_mtime = std::fs::metadata(&dir).and_then(|m| m.modified()).ok();
    let key = (dir.clone(), req.show_hidden, gi, req.hide_ignored);
    // Paging a big folder must not re-read and re-sort it per page: offset 0 always rebuilds,
    // later pages reuse the sorted snapshot while the folder's mtime is unchanged.
    let cached = if req.offset > 0 { cache_get(&key, dir_mtime) } else { None };
    let (raws, skipped) = match cached {
        Some(hit) => hit,
        None => {
            let built = build_raws(&dir, req, &chain, dir_hidden_by_ignore)?;
            cache_put(key, dir_mtime, &built);
            built
        }
    };
    // The directory must not have been swapped for a link while we read it.
    let again = std::fs::canonicalize(&dir).map_err(|e| io_err("folder vanished", e))?;
    if again != dir {
        return err("changed", "folder changed while listing");
    }

    let total = raws.len();
    let start = req.offset.min(total);
    let end = (start + limit).min(total);
    let mut entries = Vec::with_capacity(end - start);
    for r in &raws[start..end] {
        let p = dir.join(&r.name);
        let lm = std::fs::symlink_metadata(&p).ok();
        let symlink = lm.as_ref().is_some_and(|m| m.file_type().is_symlink());
        // Never `metadata()` on a link: that would report the size, mtime and kind of a target outside the
        // project. A link whose target resolves INSIDE the root shows that target (without following any
        // further link); any other link shows as "other" with the link's own (empty) metadata.
        let meta = if symlink {
            match std::fs::canonicalize(&p) {
                Ok(t) if inside(&t, root) => std::fs::symlink_metadata(&t).ok(),
                _ => None,
            }
        } else {
            lm
        };
        let kind = match &meta {
            Some(m) if m.is_dir() => "dir",
            Some(m) if m.is_file() => "file",
            _ => "other",
        };
        let ignored = gi && (dir_hidden_by_ignore || is_ignored(&chain, &p, kind == "dir"));
        entries.push(Entry {
            hidden: r.name.starts_with('.'),
            path: rel_of(root, &p),
            kind,
            symlink,
            ignored,
            size: meta.as_ref().map_or(0, |m| if m.is_file() { m.len() } else { 0 }),
            mtime_ms: meta.as_ref().map_or(0, mtime_ms),
            name: r.name.clone(),
        });
    }
    Ok(ListResult {
        path: rel_of(root, &dir),
        entries,
        total,
        next_offset: (end < total).then_some(end),
        skipped,
    })
}

// ---- read ----------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default)]
pub struct ReadReq {
    pub path: String,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Serialize, Debug)]
pub struct ReadResult {
    pub path: String,
    /// `ok`, `binary` or `too_large` (no text in the last two).
    pub status: &'static str,
    pub size: u64,
    pub mtime_ms: u64,
    pub hash: Option<String>,
    pub text: Option<String>,
    /// `utf-8`, `utf-16le`, `utf-16be` or `unknown` (decoded lossily, read-only).
    pub encoding: &'static str,
    pub bom: bool,
    /// `lf`, `crlf`, `cr`, `mixed` or `none`.
    pub eol: &'static str,
    pub read_only: bool,
}

fn eol_of(text: &str) -> &'static str {
    let (mut lf, mut crlf, mut cr) = (0usize, 0usize, 0usize);
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\r' if b.get(i + 1) == Some(&b'\n') => {
                crlf += 1;
                i += 1;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    match (lf > 0, crlf > 0, cr > 0) {
        (false, false, false) => "none",
        (true, false, false) => "lf",
        (false, true, false) => "crlf",
        (false, false, true) => "cr",
        _ => "mixed",
    }
}

/// Decodes file bytes; `None` text means binary.
pub fn decode(bytes: &[u8]) -> (Option<String>, &'static str, bool, bool) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return match std::str::from_utf8(rest) {
            Ok(s) => (Some(s.to_string()), "utf-8", true, false),
            Err(_) => (Some(String::from_utf8_lossy(rest).into_owned()), "unknown", true, true),
        };
    }
    for (bom, le, name) in [([0xFFu8, 0xFE], true, "utf-16le"), ([0xFE, 0xFF], false, "utf-16be")] {
        if bytes.starts_with(&bom) && !(le && bytes.starts_with(&[0xFF, 0xFE, 0, 0])) {
            let body = &bytes[2..];
            if body.len() % 2 != 0 {
                return (None, "unknown", true, true);
            }
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
                .collect();
            return match String::from_utf16(&units) {
                Ok(s) => (Some(s), name, true, false),
                Err(_) => (Some(String::from_utf16_lossy(&units)), "unknown", true, true),
            };
        }
    }
    if bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) {
        return (None, "unknown", false, true);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (Some(s.to_string()), "utf-8", false, false),
        Err(_) => (Some(String::from_utf8_lossy(bytes).into_owned()), "unknown", false, true),
    }
}

pub fn read_file(root: &Path, req: &ReadReq) -> R<ReadResult> {
    let canonical = resolve_existing(root, &req.path)?;
    let (f, meta) = open_verified(root, &canonical)?;
    let max = req.max_bytes.unwrap_or(READ_DEFAULT_MAX).min(READ_HARD_MAX);
    let size = meta.len();
    let base = |status, text, encoding, bom, eol, read_only, hash| ReadResult {
        path: rel_of(root, &canonical),
        status,
        size,
        mtime_ms: mtime_ms(&meta),
        hash,
        text,
        encoding,
        bom,
        eol,
        read_only,
    };
    if size > max {
        return Ok(base("too_large", None, "unknown", false, "none", true, None));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    // `take` bounds the read even if the file grows after fstat.
    f.take(max + 1).read_to_end(&mut bytes).map_err(|e| io_err("read failed", e))?;
    if bytes.len() as u64 > max {
        return Ok(base("too_large", None, "unknown", false, "none", true, None));
    }
    let hash = Some(sha_hex(&bytes));
    let (text, encoding, bom, lossy) = decode(&bytes);
    Ok(match text {
        None => base("binary", None, "unknown", bom, "none", true, hash),
        Some(t) => {
            let eol = eol_of(&t);
            base("ok", Some(t), encoding, bom, eol, lossy, hash)
        }
    })
}

#[derive(Deserialize, Debug)]
pub struct RangeReq {
    pub path: String,
    pub offset: u64,
    pub length: u64,
}

#[derive(Serialize, Debug)]
pub struct RangeResult {
    pub path: String,
    pub offset: u64,
    pub size: u64,
    pub mtime_ms: u64,
    /// Lossy UTF-8 of the byte range (always read-only in the UI).
    pub text: String,
    pub next_offset: Option<u64>,
    pub binary: bool,
}

/// "Open anyway" for a refused large file: a bounded byte range, never the whole file.
pub fn read_range(root: &Path, req: &RangeReq) -> R<RangeResult> {
    use std::io::{Seek, SeekFrom};
    let canonical = resolve_existing(root, &req.path)?;
    let (mut f, meta) = open_verified(root, &canonical)?;
    let size = meta.len();
    let length = req.length.clamp(1, RANGE_MAX);
    let offset = req.offset.min(size);
    f.seek(SeekFrom::Start(offset)).map_err(|e| io_err("seek failed", e))?;
    let mut buf = Vec::new();
    f.take(length).read_to_end(&mut buf).map_err(|e| io_err("read failed", e))?;
    let end = offset + buf.len() as u64;
    let binary = buf[..buf.len().min(BINARY_SNIFF)].contains(&0);
    Ok(RangeResult {
        path: rel_of(root, &canonical),
        offset,
        size,
        mtime_ms: mtime_ms(&meta),
        text: if binary { String::new() } else { String::from_utf8_lossy(&buf).into_owned() },
        next_offset: (end < size).then_some(end),
        binary,
    })
}

// ---- write (atomic, optimistic) -----------------------------------------------------------

#[derive(Deserialize, Debug)]
pub struct WriteReq {
    pub path: String,
    pub text: String,
    #[serde(default = "default_encoding")]
    pub encoding: String,
    #[serde(default)]
    pub bom: bool,
    /// Hash the editor last read or wrote. `None`: the file must not exist yet.
    #[serde(default)]
    pub expected_hash: Option<String>,
    /// Overwrite whatever is on disk ("keep mine").
    #[serde(default)]
    pub force: bool,
}

fn default_encoding() -> String {
    "utf-8".into()
}

#[derive(Serialize, Debug)]
pub struct WriteResult {
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub hash: String,
}

pub fn encode(text: &str, encoding: &str, bom: bool) -> R<Vec<u8>> {
    match encoding {
        "utf-8" => {
            let mut v = Vec::with_capacity(text.len() + 3);
            if bom {
                v.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            v.extend_from_slice(text.as_bytes());
            Ok(v)
        }
        "utf-16le" | "utf-16be" => {
            let le = encoding == "utf-16le";
            let mut v = Vec::with_capacity(text.len() * 2 + 2);
            if bom {
                v.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
            }
            for u in text.encode_utf16() {
                v.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
            }
            Ok(v)
        }
        _ => err("unsupported_encoding", "only utf-8 and utf-16 files can be saved"),
    }
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn tmp_path(dir: &Path, name: &str) -> PathBuf {
    let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    // Hidden, same directory (same filesystem, so rename is atomic), unique per process+call.
    dir.join(format!(".{}.llmide-{}-{n}.tmp", name.chars().take(100).collect::<String>(), std::process::id()))
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

fn current_hash(root: &Path, canonical: &Path) -> R<String> {
    let (f, meta) = open_verified(root, canonical)?;
    if meta.len() as usize > WRITE_MAX {
        return err("too_large", "file on disk is too large to compare");
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    f.take(WRITE_MAX as u64 + 1).read_to_end(&mut bytes).map_err(|e| io_err("read failed", e))?;
    Ok(sha_hex(&bytes))
}

pub fn write_file(root: &Path, req: &WriteReq) -> R<WriteResult> {
    deny_git_rel(&req.path)?;
    let bytes = encode(&req.text, &req.encoding, req.bom)?;
    if bytes.len() > WRITE_MAX {
        return err("too_large", "file is too large to save from the editor");
    }
    // Existing file: write through to its real (in-root) location. New file: parent + name.
    let existing = match resolve_existing(root, &req.path) {
        Ok(p) => Some(p),
        Err(e) if e.code == "not_found" => None,
        Err(e) => return Err(e),
    };
    let (target, dir, name, orig_meta) = match existing {
        Some(real) => {
            deny_git_abs(root, &real)?;
            let (_, meta) = open_verified(root, &real)?;
            if !req.force {
                match &req.expected_hash {
                    Some(h) if *h == current_hash(root, &real)? => {}
                    Some(_) => return err("conflict", "the file changed on disk since it was opened"),
                    None => return err("exists", "the file already exists"),
                }
            }
            let dir = real.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf());
            let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            (real, dir, name, Some(meta))
        }
        None => {
            if req.expected_hash.is_some() && !req.force {
                return err("conflict", "the file was deleted on disk");
            }
            let (dir, name) = resolve_new(root, &req.path)?;
            deny_git_abs(root, &dir.join(&name))?;
            (dir.join(&name), dir, name, None)
        }
    };

    let tmp = tmp_path(&dir, &name);
    let cleanup = |e: FsError| {
        let _ = std::fs::remove_file(&tmp);
        e
    };
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o666).custom_flags(libc::O_NOFOLLOW);
    }
    let mut f = o.open(&tmp).map_err(|e| io_err("cannot create temp file", e))?;
    f.write_all(&bytes).and_then(|()| f.sync_all()).map_err(|e| cleanup(io_err("write failed", e)))?;
    if let Some(m) = &orig_meta {
        let _ = std::fs::set_permissions(&tmp, m.permissions());
    }
    drop(f);

    // Narrow the race window: re-check right before the rename.
    if !req.force {
        if let Some(h) = &req.expected_hash {
            if target.exists() && *h != current_hash(root, &target).map_err(cleanup)? {
                return Err(cleanup(FsError { code: "conflict", message: "the file changed on disk since it was opened".into() }));
            }
        }
    }
    // The directory must still be inside the root (it could have been swapped for a link).
    match std::fs::canonicalize(&dir) {
        Ok(d) if inside(&d, root) && d == dir => {}
        _ => return Err(cleanup(FsError { code: "outside_root", message: "folder changed while saving".into() })),
    }
    if orig_meta.is_none() && std::fs::symlink_metadata(&target).is_ok() {
        return Err(cleanup(FsError { code: "exists", message: "the file was created on disk meanwhile".into() }));
    }
    if orig_meta.is_none() {
        // A NEW file must never replace one that appeared since the check above: no-replace rename.
        rename_noreplace(&tmp, &target).map_err(|e| {
            let c = if e.kind() == std::io::ErrorKind::AlreadyExists { FsError { code: "exists", message: "the file was created on disk meanwhile".into() } } else { io_err("cannot create file", e) };
            cleanup(c)
        })?;
    } else {
        std::fs::rename(&tmp, &target).map_err(|e| cleanup(io_err("cannot replace file", e)))?;
    }
    sync_dir(&dir);
    let meta = std::fs::metadata(&target).map_err(|e| io_err("cannot stat file", e))?;
    Ok(WriteResult { path: rel_of(root, &target), size: meta.len(), mtime_ms: mtime_ms(&meta), hash: sha_hex(&bytes) })
}

// ---- create / rename / delete ----------------------------------------------------------

#[derive(Deserialize, Debug)]
pub struct CreateReq {
    pub path: String,
    /// `file` or `dir`.
    pub kind: String,
}

pub fn create(root: &Path, req: &CreateReq) -> R<String> {
    deny_git_rel(&req.path)?;
    let (dir, name) = resolve_new(root, &req.path)?;
    let target = dir.join(&name);
    deny_git_abs(root, &target)?;
    match req.kind.as_str() {
        "file" => {
            let mut o = std::fs::OpenOptions::new();
            o.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o666).custom_flags(libc::O_NOFOLLOW);
            }
            o.open(&target).map_err(|e| io_err("cannot create file", e))?;
        }
        "dir" => std::fs::create_dir(&target).map_err(|e| io_err("cannot create folder", e))?,
        _ => return err("invalid_path", "kind must be file or dir"),
    }
    // Verify where it really landed; undo if the parent was swapped meanwhile.
    match std::fs::canonicalize(&target) {
        Ok(real) if inside(&real, root) => Ok(rel_of(root, &real)),
        _ => {
            let _ = std::fs::remove_file(&target).or_else(|_| std::fs::remove_dir(&target));
            err("outside_root", "created entry resolved outside the project root")
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let a = CString::new(from.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let b = CString::new(to.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: both pointers are valid NUL-terminated strings for the duration of the call.
    #[cfg(target_os = "macos")]
    let rc = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let rc = unsafe {
        libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, a.as_ptr(), libc::AT_FDCWD, b.as_ptr(), 1 as libc::c_uint /* RENAME_NOREPLACE */)
            as libc::c_int
    };
    if rc == 0 {
        return Ok(());
    }
    let e = std::io::Error::last_os_error();
    // Filesystem without the flag.
    if matches!(e.raw_os_error(), Some(libc::EINVAL) | Some(libc::ENOTSUP) | Some(libc::ENOSYS)) {
        return link_unlink(from, to);
    }
    Err(e)
}

/// No-replace move without `RENAME_EXCL`: `link()` fails with `AlreadyExists` atomically when `to` exists, then
/// the old name is removed. A directory cannot be hard-linked, so it still goes through check-then-rename
/// (a narrow race on filesystems without the flag; directories are moved by user action only).
#[cfg(unix)]
fn link_unlink(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(from)?.is_dir() {
        if std::fs::symlink_metadata(to).is_ok() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
        }
        return std::fs::rename(from, to);
    }
    std::fs::hard_link(from, to)?;
    std::fs::remove_file(from)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_noreplace(from: &Path, to: &Path) -> std::io::Result<()> {
    // std::fs::rename on Windows fails if the destination exists (a directory) or replaces it (a file),
    // so check first.
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    std::fs::rename(from, to)
}

fn same_entry(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(x), Ok(y)) = (std::fs::symlink_metadata(a), std::fs::symlink_metadata(b)) {
            return x.dev() == y.dev() && x.ino() == y.ino();
        }
        false
    }
    #[cfg(not(unix))]
    {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
}

#[derive(Deserialize, Debug)]
pub struct RenameReq {
    pub from: String,
    pub to: String,
}

/// The source is addressed WITHOUT resolving a final symlink (a link is renamed, not its target).
fn resolve_entry(root: &Path, rel: &str) -> R<PathBuf> {
    deny_git_rel(rel)?;
    let (dir, name) = resolve_new(root, rel)?;
    let p = dir.join(name);
    deny_git_abs(root, &p)?;
    if std::fs::symlink_metadata(&p).is_err() {
        return err("not_found", "no such file or folder");
    }
    Ok(p)
}

pub fn rename(root: &Path, req: &RenameReq) -> R<String> {
    let from = resolve_entry(root, &req.from)?;
    deny_git_rel(&req.to)?;
    let (to_dir, to_name) = resolve_new(root, &req.to)?;
    let to = to_dir.join(&to_name);
    deny_git_abs(root, &to)?;
    // A folder cannot move into itself.
    if to.starts_with(&from) && to != from {
        return err("invalid_path", "cannot move a folder into itself");
    }
    if same_entry(&from, &to) {
        // Case-only rename on a case-insensitive filesystem (or a no-op).
        if from != to {
            std::fs::rename(&from, &to).map_err(|e| io_err("cannot rename", e))?;
        }
    } else {
        rename_noreplace(&from, &to).map_err(|e| io_err("cannot rename", e))?;
    }
    Ok(rel_of(root, &to))
}

/// Moves the entry to the OS trash. Never deletes permanently, never follows a final symlink.
pub fn delete(root: &Path, rel: &str) -> R<()> {
    delete_with(root, rel, &crate::trash_guard::OsTrash)
}

/// `delete` through an injectable trash. There is no permanent-delete fallback: a refusing trash leaves the
/// entry untouched and the error is `trash_unavailable`.
pub fn delete_with(root: &Path, rel: &str, trasher: &dyn crate::trash_guard::Trasher) -> R<()> {
    let target = resolve_entry(root, rel)?;
    trasher.trash(&target).map_err(|e| FsError { code: e.code, message: e.message })
}

// ---- Tauri commands ---------------------------------------------------------------------

async fn blocking<T, F>(f: F) -> R<T>
where
    T: Send + 'static,
    F: FnOnce(PathBuf) -> R<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let root = active_root()?;
        f(root)
    })
    .await
    .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") })?
}

#[tauri::command]
pub async fn fs_list_dir(req: ListReq) -> R<ListResult> {
    blocking(move |root| list_dir(&root, &req)).await
}

#[tauri::command]
pub async fn fs_read_file(req: ReadReq) -> R<ReadResult> {
    blocking(move |root| read_file(&root, &req)).await
}

#[tauri::command]
pub async fn fs_read_range(req: RangeReq) -> R<RangeResult> {
    blocking(move |root| read_range(&root, &req)).await
}

#[tauri::command]
pub async fn fs_write_file(req: WriteReq) -> R<WriteResult> {
    blocking(move |root| write_file(&root, &req)).await
}

#[tauri::command]
pub async fn fs_create(req: CreateReq) -> R<String> {
    blocking(move |root| create(&root, &req)).await
}

#[tauri::command]
pub async fn fs_rename(req: RenameReq) -> R<String> {
    blocking(move |root| rename(&root, &req)).await
}

#[tauri::command]
pub async fn fs_delete(path: String) -> R<()> {
    blocking(move |root| delete(&root, &path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-fs-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }
    fn lr(path: &str) -> ListReq {
        ListReq { path: path.into(), ..Default::default() }
    }
    fn wr(path: &str, text: &str, hash: Option<&str>) -> WriteReq {
        WriteReq { path: path.into(), text: text.into(), encoding: "utf-8".into(), bom: false, expected_hash: hash.map(String::from), force: false }
    }
    fn code<T: std::fmt::Debug>(r: R<T>) -> &'static str {
        r.unwrap_err().code
    }

    #[test]
    fn rejects_lexically_bad_paths() {
        let root = scratch("lex");
        for bad in ["../x", "a/../b", "/etc/passwd", "a//b", "a/./b", "a\\b", "a\0b", &"x/".repeat(3000)] {
            assert_eq!(code(list_dir(&root, &lr(bad))), "invalid_path", "{bad:?}");
        }
    }

    #[test]
    fn lists_sorted_relative_with_paging() {
        let root = scratch("list");
        fs::create_dir(root.join("zdir")).unwrap();
        fs::create_dir(root.join("Adir")).unwrap();
        for n in ["b.txt", "A.txt", "c.txt", ".hidden"] {
            fs::write(root.join(n), "x").unwrap();
        }
        let r = list_dir(&root, &ListReq { limit: Some(3), ..lr("") }).unwrap();
        let names: Vec<_> = r.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Adir", "zdir", "A.txt"]);
        assert_eq!(r.total, 5);
        assert_eq!(r.next_offset, Some(3));
        assert_eq!(r.entries[0].path, "Adir");
        let r2 = list_dir(&root, &ListReq { offset: 2, limit: Some(10), show_hidden: true, ..lr("") }).unwrap();
        assert_eq!(r2.total, 6);
        assert!(r2.entries.iter().any(|e| e.name == ".hidden" && e.hidden));
        assert_eq!(r2.next_offset, None);
        let sub = list_dir(&root, &lr("Adir")).unwrap();
        assert!(sub.entries.is_empty());
    }

    #[test]
    fn unicode_and_long_names() {
        let root = scratch("uni");
        let long = "n".repeat(200);
        for n in ["日本語.md", "emoji-🦀.rs", "e\u{301}.txt", long.as_str()] {
            fs::write(root.join(n), "x").unwrap();
        }
        let r = list_dir(&root, &lr("")).unwrap();
        assert_eq!(r.total, 4);
        let got = read_file(&root, &ReadReq { path: "日本語.md".into(), max_bytes: None }).unwrap();
        assert_eq!(got.text.as_deref(), Some("x"));
        // Deep nesting stays addressable.
        let mut rel = String::new();
        let mut p = root.clone();
        for i in 0..30 {
            rel.push_str(&format!("d{i:02}/"));
            p.push(format!("d{i:02}"));
        }
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("f.txt"), "deep").unwrap();
        rel.push_str("f.txt");
        assert_eq!(read_file(&root, &ReadReq { path: rel, max_bytes: None }).unwrap().text.as_deref(), Some("deep"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escapes_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = scratch("sl");
        let out = scratch("sl-out");
        fs::write(out.join("secret.txt"), "top secret").unwrap();
        fs::create_dir(out.join("dir")).unwrap();
        symlink(out.join("secret.txt"), root.join("link-file")).unwrap();
        symlink(&out, root.join("link-dir")).unwrap();
        symlink("../../../../etc/passwd", root.join("rel-link")).unwrap();
        assert_eq!(code(read_file(&root, &ReadReq { path: "link-file".into(), max_bytes: None })), "outside_root");
        assert_eq!(code(read_file(&root, &ReadReq { path: "link-dir/secret.txt".into(), max_bytes: None })), "outside_root");
        assert_eq!(code(list_dir(&root, &lr("link-dir"))), "outside_root");
        assert!(read_file(&root, &ReadReq { path: "rel-link".into(), max_bytes: None }).is_err());
        assert_eq!(code(write_file(&root, &WriteReq { force: true, ..wr("link-file", "pwn", None) })), "outside_root");
        assert_eq!(fs::read_to_string(out.join("secret.txt")).unwrap(), "top secret");
        assert_eq!(code(create(&root, &CreateReq { path: "link-dir/new.txt".into(), kind: "file".into() })), "outside_root");
        assert!(!out.join("new.txt").exists());
        // The link entry itself is listed (not followed) and can be renamed within the root.
        let l = list_dir(&root, &lr("")).unwrap();
        // (its target is outside the root, so the listing does not describe it: kind "other", no size)
        assert!(l.entries.iter().any(|e| e.name == "link-file" && e.symlink && e.kind == "other" && e.size == 0));
        assert_eq!(rename(&root, &RenameReq { from: "link-file".into(), to: "renamed-link".into() }).unwrap(), "renamed-link");
        assert!(fs::symlink_metadata(root.join("renamed-link")).unwrap().file_type().is_symlink());
        // A link that stays inside the root works.
        fs::write(root.join("real.txt"), "ok").unwrap();
        symlink(root.join("real.txt"), root.join("inner-link")).unwrap();
        assert_eq!(read_file(&root, &ReadReq { path: "inner-link".into(), max_bytes: None }).unwrap().text.as_deref(), Some("ok"));
    }

    #[cfg(unix)]
    #[test]
    fn fifo_and_hardlink_are_refused() {
        let root = scratch("fifo");
        let c = std::ffi::CString::new(root.join("pipe").to_str().unwrap()).unwrap();
        // SAFETY: valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert_eq!(code(read_file(&root, &ReadReq { path: "pipe".into(), max_bytes: None })), "not_regular");
        let out = scratch("fifo-out");
        fs::write(out.join("outside.txt"), "x").unwrap();
        fs::hard_link(out.join("outside.txt"), root.join("alias.txt")).unwrap();
        assert_eq!(code(read_file(&root, &ReadReq { path: "alias.txt".into(), max_bytes: None })), "hardlink");
        assert_eq!(code(write_file(&root, &WriteReq { force: true, ..wr("alias.txt", "y", None) })), "hardlink");
        assert_eq!(fs::read_to_string(out.join("outside.txt")).unwrap(), "x");
    }

    #[cfg(unix)]
    #[test]
    fn swapped_parent_is_not_followed_toctou() {
        // A directory replaced by a symlink to outside AFTER validation is caught by the
        // post-write / post-create re-verification.
        use std::os::unix::fs::symlink;
        let root = scratch("toc");
        let out = scratch("toc-out");
        fs::create_dir(root.join("d")).unwrap();
        // Simulate the swap having already happened: resolve_new canonicalises, so the escape is seen.
        fs::remove_dir(root.join("d")).unwrap();
        symlink(&out, root.join("d")).unwrap();
        assert_eq!(code(write_file(&root, &wr("d/new.txt", "x", None))), "outside_root");
        assert!(!out.join("new.txt").exists());
    }

    #[test]
    fn read_detects_binary_encoding_and_large() {
        let root = scratch("read");
        fs::write(root.join("bin.dat"), [0u8, 1, 2, 3, 0xFF]).unwrap();
        fs::write(root.join("a.txt"), "hi\r\nthere\r\n").unwrap();
        fs::write(root.join("bom.txt"), [0xEF, 0xBB, 0xBF, b'o', b'k']).unwrap();
        fs::write(root.join("latin.txt"), [b'a', 0xE9, b'b']).unwrap();
        let u16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("hé".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        fs::write(root.join("u16.txt"), u16).unwrap();
        fs::write(root.join("big.txt"), vec![b'a'; 4096]).unwrap();
        let rd = |p: &str, max| read_file(&root, &ReadReq { path: p.into(), max_bytes: max }).unwrap();
        assert_eq!(rd("bin.dat", None).status, "binary");
        let a = rd("a.txt", None);
        assert_eq!((a.status, a.eol, a.encoding, a.read_only), ("ok", "crlf", "utf-8", false));
        let b = rd("bom.txt", None);
        assert!(b.bom && b.text.as_deref() == Some("ok"));
        let l = rd("latin.txt", None);
        assert!(l.read_only && l.encoding == "unknown");
        let u = rd("u16.txt", None);
        assert_eq!((u.encoding, u.text.as_deref()), ("utf-16le", Some("hé")));
        let big = rd("big.txt", Some(1000));
        assert_eq!((big.status, big.text, big.size), ("too_large", None, 4096));
        // Range read for "open anyway".
        let r = read_range(&root, &RangeReq { path: "big.txt".into(), offset: 4000, length: 500 }).unwrap();
        assert_eq!((r.text.len(), r.next_offset), (96, None));
        let r = read_range(&root, &RangeReq { path: "big.txt".into(), offset: 0, length: 1000 }).unwrap();
        assert_eq!(r.next_offset, Some(1000));
    }

    #[test]
    fn write_is_atomic_optimistic_and_preserves_mode() {
        let root = scratch("write");
        let w = write_file(&root, &wr("new.txt", "one", None)).unwrap();
        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "one");
        // Creating over an existing file without a hash is refused.
        assert_eq!(code(write_file(&root, &wr("new.txt", "x", None))), "exists");
        let w2 = write_file(&root, &wr("new.txt", "two", Some(&w.hash))).unwrap();
        // Stale hash: someone else wrote in between.
        fs::write(root.join("new.txt"), "external").unwrap();
        assert_eq!(code(write_file(&root, &wr("new.txt", "three", Some(&w2.hash)))), "conflict");
        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "external");
        // touched-but-same-content is not a conflict (mtime changes, hash does not).
        let h = sha_hex(b"external");
        write_file(&root, &wr("new.txt", "four", Some(&h))).unwrap();
        // "keep mine"
        write_file(&root, &WriteReq { force: true, ..wr("new.txt", "mine", Some("deadbeef")) }).unwrap();
        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "mine");
        // Deleted on disk while open.
        fs::remove_file(root.join("new.txt")).unwrap();
        assert_eq!(code(write_file(&root, &wr("new.txt", "x", Some(&h)))), "conflict");
        // No temp files linger.
        assert!(fs::read_dir(&root).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains(".llmide-")));
        // Encodings round trip.
        let w = write_file(&root, &WriteReq { encoding: "utf-16le".into(), bom: true, ..wr("u.txt", "hé", None) }).unwrap();
        let r = read_file(&root, &ReadReq { path: "u.txt".into(), max_bytes: None }).unwrap();
        assert_eq!((r.text.as_deref(), r.encoding, r.hash.as_deref()), (Some("hé"), "utf-16le", Some(w.hash.as_str())));
        assert_eq!(code(write_file(&root, &WriteReq { encoding: "latin1".into(), ..wr("l.txt", "x", None) })), "unsupported_encoding");
    }

    #[cfg(unix)]
    #[test]
    fn write_preserves_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("mode");
        fs::write(root.join("run.sh"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        let h = sha_hex(b"#!/bin/sh\n");
        write_file(&root, &wr("run.sh", "#!/bin/sh\necho\n", Some(&h))).unwrap();
        assert_eq!(fs::metadata(root.join("run.sh")).unwrap().permissions().mode() & 0o777, 0o755);
    }

    #[test]
    fn create_rename_never_overwrite() {
        let root = scratch("ops");
        create(&root, &CreateReq { path: "a".into(), kind: "dir".into() }).unwrap();
        create(&root, &CreateReq { path: "a/f.txt".into(), kind: "file".into() }).unwrap();
        assert_eq!(code(create(&root, &CreateReq { path: "a/f.txt".into(), kind: "file".into() })), "exists");
        assert_eq!(code(create(&root, &CreateReq { path: "x/y/z.txt".into(), kind: "file".into() })), "not_found");
        assert_eq!(code(create(&root, &CreateReq { path: "bad\u{7}name".into(), kind: "file".into() })), "invalid_path");
        create(&root, &CreateReq { path: "g.txt".into(), kind: "file".into() }).unwrap();
        assert_eq!(code(rename(&root, &RenameReq { from: "g.txt".into(), to: "a/f.txt".into() })), "exists");
        assert_eq!(rename(&root, &RenameReq { from: "g.txt".into(), to: "a/h.txt".into() }).unwrap(), "a/h.txt");
        assert_eq!(code(rename(&root, &RenameReq { from: "a".into(), to: "a/sub".into() })), "invalid_path");
        assert_eq!(code(rename(&root, &RenameReq { from: "missing".into(), to: "m2".into() })), "not_found");
        assert_eq!(code(rename(&root, &RenameReq { from: "".into(), to: "r".into() })), "invalid_path");
        // Case-only rename works on both case-sensitive and insensitive filesystems.
        assert_eq!(rename(&root, &RenameReq { from: "a".into(), to: "A".into() }).unwrap(), "A");
        assert!(list_dir(&root, &lr("")).unwrap().entries.iter().any(|e| e.name == "A"));
    }

    #[test]
    fn git_metadata_is_never_mutable_from_the_webview() {
        let root = scratch("dotgit");
        fs::create_dir_all(root.join(".git/hooks")).unwrap();
        fs::write(root.join(".git/config"), "[core]\n").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/f.txt"), "x").unwrap();
        for p in [".git/config", ".GIT/config", ".Git/hooks/pre-commit", "sub/.git/config", ".git ", ".git.", "GIT~1/config", ".g\u{200c}it/config"] {
            assert_eq!(code(write_file(&root, &wr(p, "[core]\nfsmonitor=x\n", None))), "protected_path", "write {p:?}");
            assert_eq!(code(create(&root, &CreateReq { path: p.into(), kind: "file".into() })), "protected_path", "create {p:?}");
            assert_eq!(code(rename(&root, &RenameReq { from: "sub/f.txt".into(), to: p.into() })), "protected_path", "rename target {p:?}");
        }
        assert_eq!(code(create(&root, &CreateReq { path: ".git".into(), kind: "dir".into() })), "protected_path");
        assert_eq!(code(rename(&root, &RenameReq { from: ".git".into(), to: "gone".into() })), "protected_path");
        assert_eq!(code(rename(&root, &RenameReq { from: ".git/config".into(), to: "c".into() })), "protected_path");
        assert_eq!(code(delete(&root, ".git")), "protected_path");
        assert_eq!(code(delete(&root, ".git/hooks")), "protected_path");
        assert_eq!(fs::read_to_string(root.join(".git/config")).unwrap(), "[core]\n");
        // .gitignore and friends are ordinary files.
        write_file(&root, &wr(".gitignore", "x\n", None)).unwrap();
        write_file(&root, &wr(".gitattributes", "* text\n", None)).unwrap_or_else(|e| panic!("{e:?}"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_into_git_metadata_are_protected_too() {
        let root = scratch("dotgit-link");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "[core]\n").unwrap();
        std::os::unix::fs::symlink(root.join(".git/config"), root.join("alias")).unwrap();
        std::os::unix::fs::symlink(root.join(".git"), root.join("d")).unwrap();
        assert_eq!(code(write_file(&root, &wr("alias", "x", Some("0")))), "protected_path");
        assert_eq!(code(write_file(&root, &WriteReq { force: true, ..wr("alias", "x", None) })), "protected_path");
        assert_eq!(code(write_file(&root, &wr("d/hooks-new", "x", None))), "protected_path");
        assert_eq!(fs::read_to_string(root.join(".git/config")).unwrap(), "[core]\n");
    }

    #[cfg(unix)]
    #[test]
    fn listing_a_link_never_reports_metadata_of_an_outside_target() {
        let root = scratch("list-link");
        let outside = scratch("list-link-out");
        fs::write(outside.join("big.bin"), vec![0u8; 12345]).unwrap();
        fs::create_dir(outside.join("secretdir")).unwrap();
        fs::write(root.join("in.txt"), "inside").unwrap();
        std::os::unix::fs::symlink(outside.join("big.bin"), root.join("to-file")).unwrap();
        std::os::unix::fs::symlink(outside.join("secretdir"), root.join("to-dir")).unwrap();
        std::os::unix::fs::symlink(root.join("in.txt"), root.join("to-inside")).unwrap();
        std::os::unix::fs::symlink("/definitely/missing", root.join("dangling")).unwrap();
        let l = list_dir(&root, &lr("")).unwrap();
        let get = |n: &str| l.entries.iter().find(|e| e.name == n).unwrap();
        for out in ["to-file", "to-dir", "dangling"] {
            let e = get(out);
            assert!(e.symlink && e.kind == "other" && e.size == 0, "{out}: {} {} {}", e.kind, e.size, e.symlink);
        }
        let inside = get("to-inside");
        assert!(inside.symlink && inside.kind == "file" && inside.size == 6);
    }

    #[test]
    fn a_new_file_never_replaces_one_created_meanwhile() {
        let root = scratch("noreplace");
        fs::write(root.join("src.tmp"), "new").unwrap();
        fs::write(root.join("dst.txt"), "theirs").unwrap();
        let e = rename_noreplace(&root.join("src.tmp"), &root.join("dst.txt")).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(root.join("dst.txt")).unwrap(), "theirs");
        assert_eq!(fs::read_to_string(root.join("src.tmp")).unwrap(), "new", "the source stays for cleanup");
        rename_noreplace(&root.join("src.tmp"), &root.join("fresh.txt")).unwrap();
        assert_eq!(fs::read_to_string(root.join("fresh.txt")).unwrap(), "new");
        assert!(!root.join("src.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_no_rename_excl_fallback_uses_link_and_is_atomic_for_files() {
        let root = scratch("linkfallback");
        fs::write(root.join("a"), "A").unwrap();
        fs::write(root.join("b"), "B").unwrap();
        assert_eq!(link_unlink(&root.join("a"), &root.join("b")).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(root.join("b")).unwrap(), "B");
        assert_eq!(fs::read_to_string(root.join("a")).unwrap(), "A");
        link_unlink(&root.join("a"), &root.join("c")).unwrap();
        assert_eq!(fs::read_to_string(root.join("c")).unwrap(), "A");
        assert!(!root.join("a").exists());
        // a dangling symlink at the target counts as taken
        std::os::unix::fs::symlink("/nonexistent", root.join("dangling")).unwrap();
        fs::write(root.join("d"), "D").unwrap();
        assert_eq!(link_unlink(&root.join("d"), &root.join("dangling")).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        // folders: check-then-rename
        fs::create_dir(root.join("dir1")).unwrap();
        fs::create_dir(root.join("dir2")).unwrap();
        assert_eq!(link_unlink(&root.join("dir1"), &root.join("dir2")).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        link_unlink(&root.join("dir1"), &root.join("dir3")).unwrap();
        assert!(root.join("dir3").is_dir());
    }

    #[test]
    fn delete_never_falls_back_to_a_permanent_delete() {
        use crate::trash_guard::tests::FakeTrash;
        let root = scratch("del-fake");
        fs::write(root.join("keep.txt"), "precious").unwrap();
        fs::create_dir(root.join("dir")).unwrap();
        fs::write(root.join("dir/inner.txt"), "inner").unwrap();
        // A trash that cannot take the item: error, and the item is exactly where it was.
        let refusing = FakeTrash::refusing();
        assert_eq!(code(delete_with(&root, "keep.txt", &refusing)), "trash_unavailable");
        assert_eq!(code(delete_with(&root, "dir", &refusing)), "trash_unavailable");
        assert_eq!(fs::read_to_string(root.join("keep.txt")).unwrap(), "precious");
        assert_eq!(fs::read_to_string(root.join("dir/inner.txt")).unwrap(), "inner");
        assert_eq!(refusing.seen.borrow().len(), 2, "the trash was the only thing asked");
        // A working trash receives the item (moved, content intact), nothing is removed otherwise.
        let bin = scratch("del-bin");
        let ok = FakeTrash::into(&bin);
        delete_with(&root, "keep.txt", &ok).unwrap();
        assert!(!root.join("keep.txt").exists());
        assert_eq!(fs::read_to_string(bin.join("1-keep.txt")).unwrap(), "precious");
        // A symlink is trashed itself, never its target.
        #[cfg(unix)]
        {
            let outside = scratch("del-outside");
            fs::write(outside.join("target.txt"), "t").unwrap();
            std::os::unix::fs::symlink(outside.join("target.txt"), root.join("lnk")).unwrap();
            delete_with(&root, "lnk", &ok).unwrap();
            assert_eq!(fs::read_to_string(outside.join("target.txt")).unwrap(), "t");
        }
    }

    #[test]
    fn delete_refuses_root_and_missing() {
        let root = scratch("del");
        assert_eq!(code(delete(&root, "")), "invalid_path");
        assert_eq!(code(delete(&root, "nope")), "not_found");
        assert_eq!(code(delete(&root, "../x")), "invalid_path");
    }

    #[test]
    fn gitignore_marks_and_hides() {
        let root = scratch("gi");
        fs::write(root.join(".gitignore"), "*.log\nbuild/\n").unwrap();
        fs::create_dir(root.join("build")).unwrap();
        fs::write(root.join("build/out.txt"), "x").unwrap();
        fs::write(root.join("a.log"), "x").unwrap();
        fs::write(root.join("a.txt"), "x").unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/.gitignore"), "gen.rs\n").unwrap();
        fs::write(root.join("src/gen.rs"), "x").unwrap();
        fs::write(root.join("src/main.rs"), "x").unwrap();
        let marked = list_dir(&root, &ListReq { gitignore: true, show_hidden: true, ..lr("") }).unwrap();
        let flag = |n: &str| marked.entries.iter().find(|e| e.name == n).unwrap().ignored;
        assert!(flag("build") && flag("a.log") && !flag("a.txt") && !flag("src"));
        let hidden = list_dir(&root, &ListReq { hide_ignored: true, ..lr("") }).unwrap();
        assert_eq!(hidden.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["src", "a.txt"]);
        let inner = list_dir(&root, &ListReq { hide_ignored: true, show_hidden: true, ..lr("src") }).unwrap();
        assert_eq!(inner.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), [".gitignore", "main.rs"]);
        // Inside an ignored directory everything is marked ignored.
        let inside_ignored = list_dir(&root, &ListReq { gitignore: true, ..lr("build") }).unwrap();
        assert!(inside_ignored.entries.iter().all(|e| e.ignored));
    }

    /// 100k entries: paging must stay cheap. Run with `--ignored --nocapture` for the numbers.
    #[test]
    #[ignore = "benchmark"]
    fn bench_100k_listing() {
        let root = scratch("bench");
        let t = std::time::Instant::now();
        for i in 0..100_000 {
            fs::File::create(root.join(format!("file-{i:06}.txt"))).unwrap();
        }
        eprintln!("BENCH create 100k files: {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let first = list_dir(&root, &ListReq { limit: Some(500), ..lr("") }).unwrap();
        eprintln!("BENCH first page (500 of {}): {:?}", first.total, t.elapsed());
        let t = std::time::Instant::now();
        let mut off = 0;
        let mut pages = 0;
        while let Some(n) = list_dir(&root, &ListReq { offset: off, limit: Some(1000), ..lr("") }).unwrap().next_offset {
            off = n;
            pages += 1;
        }
        eprintln!("BENCH all {} pages: {:?}", pages + 1, t.elapsed());
        assert_eq!(first.total, 100_000);
    }
}
