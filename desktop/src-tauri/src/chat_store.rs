//! Desktop chat store: one file per chat, in the Mac app's own `sessions/<UUID>.json` format.
//!
//! "One stored copy" (data-lifecycle, plan section 4): on macOS the desktop app reads and writes
//! the Mac app's `~/Library/Application Support/llm-ide/sessions/` in place; on Windows and Linux
//! the same layout lives in `<desktop data dir>/chats/<userId>/`. Nothing here is a second format:
//! a file written by this module decodes in the Swift `ChatSession` and the other way round
//! (see `schema/chat-session/` fixtures and the round-trip tests below).
//!
//! On-disk format (Swift `JSONEncoder` defaults): one JSON object per chat with `storeVersion`
//! (2), `id` (upper-case UUID, equal to the file name), `scope` (`explorer|conflicts|visual|docGen|quick`),
//! `title`, `createdAt` / `lastUsedAt` (Double seconds since 2001-01-01 UTC, the Foundation reference
//! date), `messages` (array of `ChatMessage` objects, kept verbatim here), and optional `engine`,
//! `projectId`, `meetingId`, `ownerUserId`, `origin`, `archive {hash,count}`, `route`. Unknown keys
//! are preserved on rewrite. A file is only ever replaced by an atomic rename.
//!
//! Security and safety rules:
//! - the webview never supplies a path: ids must parse as UUIDs and the user id as a short
//!   `[A-Za-z0-9._-]` segment, so no id can leave the store directory;
//! - files owned by another user (`ownerUserId`) are invisible and never overwritten;
//! - an id in `pending-deletes.json` (the Mac's tombstone file, same format) is hidden, refused on
//!   save, and a resurrected file is removed (delete wins, both ways);
//! - a writer holds an advisory lock file (`chat-store.lock`, pid + process start time, stale
//!   recovery) and every overwrite is compare-and-swap on a revision (mtime ns + size + inode),
//!   so a concurrent Mac write is detected as a conflict instead of lost. The Mac app does not
//!   take the lock file today: against the Mac the revision check is the real protection;
//! - a file that cannot be parsed is quarantined (`<UUID>.corrupt-<unix ts>`, same convention as
//!   the Mac), never deleted; a file we merely do not understand (newer `storeVersion`) is left alone;
//! - chat content is never logged and never placed in an error string.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// A chat file larger than this is neither parsed nor modified (still listed as too large).
pub const MAX_READ_BYTES: u64 = 256 * 1024 * 1024;
/// The largest chat file this module will write.
pub const MAX_WRITE_BYTES: usize = 64 * 1024 * 1024;
/// Most messages in one written chat.
pub const MAX_MESSAGES: usize = 50_000;
/// Largest page `chat_load` returns.
pub const MAX_PAGE: usize = 500;
/// Largest page `chat_list` returns.
pub const MAX_LIST_PAGE: usize = 200;
/// `pending-deletes.json` / index files larger than this are ignored (and rebuilt / reported).
const SMALL_FILE_MAX: u64 = 32 * 1024 * 1024;
const TITLE_MAX_CHARS: usize = 2_000;
/// Foundation reference date (2001-01-01) in unix seconds.
pub const APPLE_EPOCH_UNIX: f64 = 978_307_200.0;
pub const SCOPES: [&str; 5] = ["explorer", "conflicts", "visual", "docGen", "quick"];
const ROLES: [&str; 3] = ["user", "assistant", "toolResult"];
const LOCK_FILE: &str = "chat-store.lock";
const PENDING_FILE: &str = "pending-deletes.json";
/// Where a deleted chat file is moved (inside the sessions folder; the Mac app ignores sub-folders).
pub const DELETED_DIR: &str = ".deleted";
/// How long a deleted chat stays recoverable.
pub const TRASH_RETENTION_SECS: u64 = 30 * 24 * 3600;
/// Most recoverable copies kept; the oldest go first.
pub const TRASH_MAX_ENTRIES: usize = 500;

// ---- errors ---------------------------------------------------------------------------------

/// A typed failure. `code` is stable and safe to show; `message` never contains chat content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoreError {
    pub code: &'static str,
    pub message: String,
}

impl StoreError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

fn io_err(what: &str, e: &std::io::Error) -> StoreError {
    // io::Error text carries paths and OS strings only, never chat content.
    StoreError::new("io", format!("{what}: {e}"))
}

// ---- ids ------------------------------------------------------------------------------------

/// Canonical (upper-case, hyphenated) form of a chat id, or `None` when it is not a UUID.
/// The file name is always `<canonical>.json`, exactly as the Swift `UUID.uuidString`.
pub fn canonical_chat_id(raw: &str) -> Option<String> {
    let b = raw.as_bytes();
    if b.len() != 36 {
        return None;
    }
    for (i, c) in b.iter().enumerate() {
        let dash = matches!(i, 8 | 13 | 18 | 23);
        if dash != (*c == b'-') || (!dash && !c.is_ascii_hexdigit()) {
            return None;
        }
    }
    Some(raw.to_ascii_uppercase())
}

/// A user id usable as one path segment: 1..=128 of `[A-Za-z0-9._-]`, not starting with a dot.
pub fn valid_user_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 128
        && !raw.starts_with('.')
        && raw.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

// ---- time -----------------------------------------------------------------------------------

pub fn now_unix() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Now as Foundation reference-date seconds (what `createdAt` / `lastUsedAt` hold).
pub fn now_apple() -> f64 {
    now_unix() - APPLE_EPOCH_UNIX
}

// ---- layout ---------------------------------------------------------------------------------

/// Where a user's chat files live. `base` also holds `pending-deletes.json` and the lock file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreLayout {
    pub base: PathBuf,
    pub sessions: PathBuf,
    /// True when the directory is the Mac app's own (macOS shared mode).
    pub shared_with_mac: bool,
}

/// Pure layout resolution (each OS is testable on any host).
/// `LLMIDE_CHAT_STORE_DIR` (absolute) overrides `base` (tests, ops); otherwise macOS uses the Mac
/// app's `Application Support/llm-ide` (or its legacy `LLM IDE` folder while only that exists, so the
/// Mac app's own migration still finds it), Windows and Linux use `<data dir>/chats/<userId>`.
pub fn layout_for(
    os: crate::fsutil::Os,
    env: &dyn Fn(&str) -> Option<String>,
    user_id: &str,
    path_exists: &dyn Fn(&Path) -> bool,
) -> std::result::Result<StoreLayout, String> {
    if !valid_user_id(user_id) {
        return Err("invalid user id".into());
    }
    let get = |k: &str| env(k).filter(|v| !v.trim().is_empty());
    if let Some(p) = get("LLMIDE_CHAT_STORE_DIR") {
        let p = PathBuf::from(p);
        if !p.is_absolute() {
            return Err("LLMIDE_CHAT_STORE_DIR must be an absolute path".into());
        }
        return Ok(StoreLayout { sessions: p.join("sessions"), base: p, shared_with_mac: false });
    }
    if os == crate::fsutil::Os::Mac {
        let home = get("HOME").map(PathBuf::from).filter(|p| p.is_absolute()).ok_or("HOME is not set")?;
        let support = home.join("Library").join("Application Support");
        let modern = support.join("llm-ide");
        let legacy = support.join("LLM IDE");
        let base = if !path_exists(&modern) && path_exists(&legacy) { legacy } else { modern };
        return Ok(StoreLayout { sessions: base.join("sessions"), base, shared_with_mac: true });
    }
    let data = crate::fsutil::data_dir_for(os, env)?;
    let base = data.join("chats").join(user_id);
    Ok(StoreLayout { sessions: base.join("sessions"), base, shared_with_mac: false })
}

pub fn layout_here(user_id: &str) -> std::result::Result<StoreLayout, String> {
    layout_for(crate::fsutil::current_os(), &|k| std::env::var(k).ok(), user_id, &|p| p.exists())
}

// ---- process identity and the lock file ------------------------------------------------------

/// What `proc_start_time` found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcInfo {
    Gone,
    Started(u64),
    /// Alive, but the platform gave no start time (treated as the owner still running).
    Unknown,
}

#[cfg(target_os = "linux")]
pub fn proc_start_time(pid: u32) -> ProcInfo {
    if pid == 0 || pid > i32::MAX as u32 {
        return ProcInfo::Gone;
    }
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => ProcInfo::Gone,
        Ok(s) => {
            // Fields after the last ')' start at field 3; starttime is field 22.
            let after = s.rsplit_once(')').map(|x| x.1).unwrap_or("");
            match after.split_whitespace().nth(19).and_then(|v| v.parse::<u64>().ok()) {
                Some(t) => ProcInfo::Started(t),
                None => ProcInfo::Unknown,
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn proc_start_time(pid: u32) -> ProcInfo {
    if pid == 0 || pid > i32::MAX as u32 {
        return ProcInfo::Gone;
    }
    // SAFETY: proc_pidinfo writes at most `size` bytes into the zeroed struct we own.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let n = libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size);
        if n == size {
            return ProcInfo::Started(info.pbi_start_tvsec.wrapping_mul(1_000_000).wrapping_add(info.pbi_start_tvusec));
        }
        if libc::kill(pid as libc::pid_t, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) {
            ProcInfo::Unknown
        } else {
            ProcInfo::Gone
        }
    }
}

#[cfg(windows)]
pub fn proc_start_time(pid: u32) -> ProcInfo {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: plain Win32 calls with valid out-pointers; the handle is closed on every path.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return ProcInfo::Gone;
        }
        let mut code: u32 = 0;
        if GetExitCodeProcess(h, &mut code) != 0 && code != 259 {
            CloseHandle(h);
            return ProcInfo::Gone;
        }
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut c, mut e, mut k, mut u) = (zero, zero, zero, zero);
        let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u);
        CloseHandle(h);
        if ok != 0 {
            ProcInfo::Started(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
        } else {
            ProcInfo::Unknown
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn proc_start_time(pid: u32) -> ProcInfo {
    // Other unixes: liveness only.
    // SAFETY: kill with signal 0 only probes.
    unsafe {
        if libc::kill(pid as libc::pid_t, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) {
            ProcInfo::Unknown
        } else {
            ProcInfo::Gone
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockOwner {
    pub pid: u32,
    /// `proc_start_time` of the owner (0 when unknown).
    pub start: u64,
    pub nonce: String,
}

fn my_identity() -> LockOwner {
    let pid = std::process::id();
    let start = match proc_start_time(pid) {
        ProcInfo::Started(t) => t,
        _ => 0,
    };
    LockOwner { pid, start, nonce: nonce() }
}

fn nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}-{:x}-{:x}", std::process::id(), t, N.fetch_add(1, Ordering::Relaxed))
}

fn file_age(path: &Path) -> Option<Duration> {
    std::fs::metadata(path).ok()?.modified().ok()?.elapsed().ok()
}

/// Is the lock file's owner gone (a crashed writer), or never finished writing it?
fn lock_is_stale(path: &Path, me: &LockOwner) -> bool {
    let Ok(bytes) = read_small(path, 4096) else {
        return true;
    };
    let Ok(owner) = serde_json::from_slice::<LockOwner>(&bytes) else {
        // Half-written lock: give the writer a moment, then treat as stale.
        return file_age(path).is_none_or(|a| a > Duration::from_secs(5));
    };
    // Our own pid but not our identity (a recycled pid) is stale; our own identity while we are
    // acquiring means a previous holder in this process died without releasing (a panic).
    if owner.pid == me.pid && owner.start == me.start {
        return true;
    }
    match proc_start_time(owner.pid) {
        ProcInfo::Gone => true,
        ProcInfo::Started(t) => owner.start != 0 && t != owner.start,
        ProcInfo::Unknown => false,
    }
}

fn read_small(path: &Path, max: u64) -> std::io::Result<Vec<u8>> {
    let f = File::open(path)?;
    let mut v = Vec::new();
    f.take(max).read_to_end(&mut v)?;
    Ok(v)
}

/// In-process exclusion (threads of this app) in front of the lock file: blocking with a timeout,
/// so waiters sleep until a release instead of polling an unfair try-lock.
static PROCESS_LOCKED: Mutex<bool> = Mutex::new(false);
static PROCESS_CV: std::sync::Condvar = std::sync::Condvar::new();

struct ProcessGuard;

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        *PROCESS_LOCKED.lock().unwrap_or_else(|e| e.into_inner()) = false;
        PROCESS_CV.notify_all();
    }
}

fn acquire_process(deadline: Instant) -> Result<ProcessGuard> {
    let mut g = PROCESS_LOCKED.lock().unwrap_or_else(|e| e.into_inner());
    while *g {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(StoreError::new("lock_busy", "chat store busy"));
        }
        g = PROCESS_CV.wait_timeout(g, left).unwrap_or_else(|e| e.into_inner()).0;
    }
    *g = true;
    Ok(ProcessGuard)
}

/// Releases the file lock (and the in-process exclusion) on drop.
pub struct LockGuard {
    path: PathBuf,
    owner: LockOwner,
    _process: ProcessGuard,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        // Remove only a lock that is still ours.
        if let Ok(b) = read_small(&self.path, 4096) {
            if serde_json::from_slice::<LockOwner>(&b).map(|o| o.nonce == self.owner.nonce).unwrap_or(false) {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

/// File-lock acquisition for one identity (no in-process mutex): the cross-process core, testable
/// with a fabricated lock file. Returns the owner written.
fn acquire_file_lock(path: &Path, me: &LockOwner, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(path) {
            Ok(mut f) => {
                let body = serde_json::to_vec(me).map_err(|_| StoreError::new("io", "lock encode"))?;
                f.write_all(&body).and_then(|()| f.sync_all()).map_err(|e| io_err("write lock", &e))?;
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(path, me) {
                    take_over_stale(path, me);
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(StoreError::new("lock_busy", "another process is writing this chat store"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(io_err("create lock", &e)),
        }
    }
}

/// Removes a stale lock under a short-lived guard file, re-checking staleness inside the guard so
/// two takers cannot remove a lock a third just created.
fn take_over_stale(path: &Path, me: &LockOwner) {
    let guard = path.with_extension("lock.takeover");
    if let Some(age) = file_age(&guard) {
        if age > Duration::from_secs(10) {
            let _ = std::fs::remove_file(&guard);
        }
    }
    if OpenOptions::new().write(true).create_new(true).open(&guard).is_err() {
        std::thread::sleep(Duration::from_millis(10));
        return;
    }
    if lock_is_stale(path, me) {
        let _ = std::fs::remove_file(path);
    }
    let _ = std::fs::remove_file(&guard);
}

pub fn acquire_lock(base: &Path, timeout: Duration) -> Result<LockGuard> {
    let deadline = Instant::now() + timeout;
    let process = acquire_process(deadline)?;
    let path = base.join(LOCK_FILE);
    let me = my_identity();
    let left = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(50));
    acquire_file_lock(&path, &me, left)?;
    Ok(LockGuard { path, owner: me, _process: process })
}

// ---- atomic file writes ----------------------------------------------------------------------

/// Temp file in the same directory (never `*.json`, so a reader scanning for chats ignores it),
/// fsync, rename over the target, fsync the directory.
pub fn write_atomic(target: &Path, body: &[u8]) -> Result<()> {
    let dir = target.parent().ok_or_else(|| StoreError::new("io", "no parent directory"))?;
    let tmp = dir.join(format!(".{}.tmp", nonce()));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(|e| io_err("create temp", &e))?;
    let res = f.write_all(body).and_then(|()| f.sync_all());
    drop(f);
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(io_err("write temp", &e));
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(io_err("rename", &e));
    }
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

// ---- parsing ---------------------------------------------------------------------------------

fn classify(e: &serde_json::Error) -> StoreError {
    if e.is_io() {
        StoreError::new("io", "read failed")
    } else {
        StoreError::new("invalid", "not a readable chat file")
    }
}

fn count_seq<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<usize>, D::Error> {
    struct V;
    impl<'de> Visitor<'de> for V {
        type Value = Option<usize>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("an array")
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Self::Value, A::Error> {
            let mut n = 0usize;
            while a.next_element::<IgnoredAny>()?.is_some() {
                n += 1;
            }
            Ok(Some(n))
        }
    }
    d.deserialize_seq(V)
}

/// The fields a listing needs; `messages` is only counted (never materialised).
#[derive(Deserialize, Default)]
#[serde(default)]
struct RawHeader {
    id: Option<String>,
    scope: Option<Value>,
    title: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<f64>,
    #[serde(rename = "lastUsedAt")]
    last_used_at: Option<f64>,
    #[serde(deserialize_with = "count_seq")]
    messages: Option<usize>,
    #[serde(deserialize_with = "count_seq")]
    history: Option<usize>,
    #[serde(rename = "storeVersion")]
    store_version: Option<Value>,
    engine: Option<Value>,
    #[serde(rename = "projectId")]
    project_id: Option<Value>,
    #[serde(rename = "meetingId")]
    meeting_id: Option<Value>,
    #[serde(rename = "ownerUserId")]
    owner_user_id: Option<Value>,
    origin: Option<Value>,
}

fn opt_str(v: &Option<Value>) -> Option<String> {
    v.as_ref().and_then(|v| v.as_str()).map(str::to_owned)
}

/// One row of a listing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub title: String,
    pub scope: Option<String>,
    pub project_id: Option<String>,
    pub created_at: f64,
    pub last_used_at: f64,
    pub message_count: usize,
    pub size_bytes: u64,
    pub engine: Option<String>,
    pub origin: Option<String>,
    pub meeting_id: Option<String>,
}

/// What a file turned out to be, cached by (mtime, size).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Parsed {
    Ok { summary: ChatSummary, owner: Option<String> },
    /// Not parseable (quarantined at first sight).
    Invalid,
    /// A newer `storeVersion` or the v1 `history` shape: left alone, not shown.
    Unsupported,
    TooLarge,
}

fn parse_header(file: &File, size: u64, id: &str) -> Parsed {
    if size > MAX_READ_BYTES {
        return Parsed::TooLarge;
    }
    let reader = BufReader::with_capacity(64 * 1024, file.take(MAX_READ_BYTES));
    let raw: RawHeader = match serde_json::from_reader(reader) {
        Ok(r) => r,
        Err(e) if e.is_io() => return Parsed::Unsupported,
        Err(_) => return Parsed::Invalid,
    };
    let (Some(fid), Some(title), Some(created), Some(last)) = (raw.id.as_deref(), raw.title.clone(), raw.created_at, raw.last_used_at) else {
        return Parsed::Invalid;
    };
    if canonical_chat_id(fid).as_deref() != Some(id) || !created.is_finite() || !last.is_finite() {
        return Parsed::Invalid;
    }
    let Some(count) = raw.messages else {
        // No `messages` key: the v1 shape (`history`) or garbage.
        return if raw.history.is_some() { Parsed::Unsupported } else { Parsed::Invalid };
    };
    if raw.store_version.as_ref().and_then(Value::as_i64).is_some_and(|v| v > 2) {
        return Parsed::Unsupported;
    }
    let scope = opt_str(&raw.scope).filter(|s| SCOPES.contains(&s.as_str()));
    Parsed::Ok {
        summary: ChatSummary {
            id: id.to_string(),
            title,
            scope,
            project_id: opt_str(&raw.project_id),
            created_at: created,
            last_used_at: last,
            message_count: count,
            size_bytes: size,
            engine: opt_str(&raw.engine),
            origin: opt_str(&raw.origin),
            meeting_id: opt_str(&raw.meeting_id),
        },
        owner: opt_str(&raw.owner_user_id),
    }
}

// ---- paged message reading (one streaming pass) ----------------------------------------------

/// Keeps the last `limit` messages with index < `before`; counts every message.
struct TailSeed {
    before: usize,
    limit: usize,
}

struct TailOut {
    total: usize,
    start: usize,
    messages: Vec<Value>,
}

impl<'de> DeserializeSeed<'de> for TailSeed {
    type Value = TailOut;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<TailOut, D::Error> {
        struct V(usize, usize);
        impl<'de> Visitor<'de> for V {
            type Value = TailOut;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an array")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<TailOut, A::Error> {
                let (before, limit) = (self.0, self.1);
                let mut ring: VecDeque<Value> = VecDeque::with_capacity(limit.min(1024));
                let mut idx = 0usize;
                loop {
                    if idx < before {
                        match a.next_element::<Value>()? {
                            Some(v) => {
                                if ring.len() == limit {
                                    ring.pop_front();
                                }
                                ring.push_back(v);
                            }
                            None => break,
                        }
                    } else if a.next_element::<IgnoredAny>()?.is_none() {
                        break;
                    }
                    idx += 1;
                }
                let end = idx.min(before);
                let messages: Vec<Value> = ring.into_iter().collect();
                Ok(TailOut { total: idx, start: end - messages.len(), messages })
            }
        }
        d.deserialize_seq(V(self.before, self.limit))
    }
}

struct PageDoc {
    fields: Map<String, Value>,
    tail: Option<TailOut>,
}

struct PageSeed {
    before: usize,
    limit: usize,
}

impl<'de> DeserializeSeed<'de> for PageSeed {
    type Value = PageDoc;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<PageDoc, D::Error> {
        struct V(usize, usize);
        impl<'de> Visitor<'de> for V {
            type Value = PageDoc;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> std::result::Result<PageDoc, A::Error> {
                let mut fields = Map::new();
                let mut tail = None;
                while let Some(key) = m.next_key::<String>()? {
                    if key == "messages" {
                        tail = Some(m.next_value_seed(TailSeed { before: self.0, limit: self.1 })?);
                    } else {
                        fields.insert(key, m.next_value::<Value>()?);
                    }
                }
                Ok(PageDoc { fields, tail })
            }
        }
        d.deserialize_map(V(self.before, self.limit))
    }
}

// ---- pending deletes (the Mac's tombstone file) ---------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PendingDoc {
    #[serde(default)]
    deletes: Vec<DeleteEntry>,
    #[serde(default)]
    orphans: Map<String, Value>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// One user-delete whose server cleanup is not confirmed. Same JSON as the Swift `DeleteEntry`
/// (`requestedAt` in reference-date seconds).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeleteEntry {
    pub id: String,
    #[serde(rename = "ownerUserId", default, skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<String>,
    #[serde(rename = "requestedAt")]
    pub requested_at: f64,
    #[serde(default)]
    pub attempts: i64,
}

// ---- the store -------------------------------------------------------------------------------

/// One user's view of a chat directory.
#[derive(Clone)]
pub struct ChatStore {
    inner: Arc<Inner>,
}

struct Inner {
    layout: StoreLayout,
    user_id: String,
    /// Where the listing index is persisted (private, Tauri-only); `None` keeps it in memory.
    index_path: Option<PathBuf>,
    cache: Mutex<IndexCache>,
    lock_timeout: Duration,
}

#[derive(Default, Serialize, Deserialize)]
struct IndexCache {
    #[serde(default)]
    entries: HashMap<String, CacheEntry>,
    #[serde(skip)]
    loaded: bool,
    #[serde(skip)]
    dirty: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct CacheEntry {
    mtime_ns: u128,
    size: u64,
    parsed: Parsed,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPage {
    pub items: Vec<ChatSummary>,
    pub total: usize,
    pub has_more: bool,
    /// Files moved to `*.corrupt-*` during this call.
    pub quarantined: usize,
    /// Files left alone because they are too large or in a shape this build does not read.
    pub unsupported: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ListQuery {
    pub offset: usize,
    pub limit: usize,
    pub scope: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedChat {
    /// Header fields plus `messages` (this page only), in the file's own JSON shape.
    pub session: Value,
    pub total: usize,
    /// Index of the first returned message.
    pub start: usize,
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveMode {
    /// The session in the request replaces the file (the caller holds the whole chat).
    Replace,
    /// Append the request's messages; `expected_count` must equal the stored count.
    Append { expected_count: usize },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub revision: String,
    pub message_count: usize,
    pub last_used_at: f64,
}

/// What the archive protocol needs to know about a chat file.
#[derive(Debug, Clone, PartialEq)]
pub struct ArchiveFacts {
    pub exists: bool,
    pub decoded: bool,
    pub owned_by_user: bool,
    pub message_count: usize,
    /// `lastUsedAt` in reference-date seconds.
    pub last_used_apple: Option<f64>,
    /// SHA-256 hex over (role, content) of every message, the server's `archiveHash`.
    pub hash: Option<String>,
}

fn mtime_ns(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0)
}

fn revision_of(meta: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    let ino = {
        use std::os::unix::fs::MetadataExt;
        meta.ino()
    };
    #[cfg(not(unix))]
    let ino = 0u64;
    format!("{:x}.{:x}.{:x}", mtime_ns(meta), meta.len(), ino)
}

impl ChatStore {
    /// Opens (creating the directories we own) the store for `user_id`.
    pub fn open(layout: StoreLayout, user_id: &str, index_path: Option<PathBuf>) -> Result<Self> {
        if !valid_user_id(user_id) {
            return Err(StoreError::new("invalid_user", "invalid user id"));
        }
        ensure_dir(&layout.base)?;
        ensure_dir(&layout.sessions)?;
        Ok(Self {
            inner: Arc::new(Inner {
                layout,
                user_id: user_id.to_string(),
                index_path,
                cache: Mutex::new(IndexCache::default()),
                lock_timeout: Duration::from_secs(3),
            }),
        })
    }

    pub fn user_id(&self) -> &str {
        &self.inner.user_id
    }

    fn file_path(&self, canonical: &str) -> PathBuf {
        self.inner.layout.sessions.join(format!("{canonical}.json"))
    }

    fn id_arg(&self, raw: &str) -> Result<String> {
        canonical_chat_id(raw).ok_or_else(|| StoreError::new("invalid_id", "chat id is not a UUID"))
    }

    fn lock(&self) -> Result<LockGuard> {
        acquire_lock(&self.inner.layout.base, self.inner.lock_timeout)
    }

    // -- tombstones --

    fn pending_path(&self) -> PathBuf {
        self.inner.layout.base.join(PENDING_FILE)
    }

    fn read_pending(&self) -> PendingDoc {
        let p = self.pending_path();
        match std::fs::metadata(&p) {
            Ok(m) if m.len() <= SMALL_FILE_MAX => read_small(&p, SMALL_FILE_MAX).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default(),
            _ => PendingDoc::default(),
        }
    }

    /// Ids with a pending delete, any owner (a chat the user deleted must not reappear for anyone).
    pub fn tombstoned_ids(&self) -> HashSet<String> {
        self.read_pending().deletes.into_iter().filter_map(|d| canonical_chat_id(&d.id)).collect()
    }

    /// Delete tombstones owed by this user (the entries are bound to the deleting user).
    pub fn my_pending_deletes(&self) -> Vec<DeleteEntry> {
        self.read_pending().deletes.into_iter().filter(|d| d.owner_user_id.as_deref() == Some(self.user_id())).collect()
    }

    pub fn pending_delete_count(&self) -> usize {
        self.my_pending_deletes().len()
    }

    fn update_pending(&self, f: impl FnOnce(&mut PendingDoc)) -> Result<()> {
        let mut doc = self.read_pending();
        f(&mut doc);
        let body = serde_json::to_vec(&doc).map_err(|_| StoreError::new("io", "encode tombstones"))?;
        write_atomic(&self.pending_path(), &body)
    }

    /// Records the delete intent (idempotent: a second delete keeps the first entry).
    pub fn add_tombstone(&self, canonical: &str) -> Result<()> {
        let me = self.user_id().to_string();
        self.update_pending(|d| {
            if !d.deletes.iter().any(|e| e.id.eq_ignore_ascii_case(canonical)) {
                d.deletes.push(DeleteEntry { id: canonical.to_string(), owner_user_id: Some(me), requested_at: now_apple(), attempts: 0 });
            }
        })
    }

    pub fn remove_tombstone(&self, id: &str) -> Result<()> {
        let _lock = self.lock()?;
        if !self.read_pending().deletes.iter().any(|e| e.id.eq_ignore_ascii_case(id)) {
            return Ok(());
        }
        self.update_pending(|d| d.deletes.retain(|e| !e.id.eq_ignore_ascii_case(id)))
    }

    pub fn bump_tombstone_attempt(&self, id: &str) -> Result<()> {
        let _lock = self.lock()?;
        self.update_pending(|d| {
            for e in d.deletes.iter_mut().filter(|e| e.id.eq_ignore_ascii_case(id)) {
                e.attempts += 1;
            }
        })
    }

    // -- listing --

    fn load_index(&self, cache: &mut IndexCache) {
        if cache.loaded {
            return;
        }
        cache.loaded = true;
        if let Some(p) = &self.inner.index_path {
            if let Ok(m) = std::fs::metadata(p) {
                if m.len() <= SMALL_FILE_MAX {
                    if let Some(c) = read_small(p, SMALL_FILE_MAX).ok().and_then(|b| serde_json::from_slice::<IndexCache>(&b).ok()) {
                        cache.entries = c.entries;
                    }
                }
            }
        }
    }

    fn save_index(&self, cache: &mut IndexCache) {
        if !cache.dirty {
            return;
        }
        cache.dirty = false;
        if let Some(p) = &self.inner.index_path {
            if let Ok(body) = serde_json::to_vec(&*cache) {
                if body.len() as u64 <= SMALL_FILE_MAX {
                    if let Some(dir) = p.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = write_atomic(p, &body);
                }
            }
        }
    }

    /// Newest-first page of this user's chats. A directory scan stats every file and re-parses only
    /// the ones whose (mtime, size) changed since the cached index, so 10k+ chats list in the time
    /// it takes to `stat` them.
    pub fn list(&self, q: &ListQuery) -> Result<ListPage> {
        let tomb = self.tombstoned_ids();
        let rd = std::fs::read_dir(&self.inner.layout.sessions).map_err(|e| io_err("read sessions dir", &e))?;
        let mut files: Vec<(String, u128, u64)> = Vec::new();
        for ent in rd.flatten() {
            let name = ent.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(stem) = name.strip_suffix(".json") else { continue };
            let Some(id) = canonical_chat_id(stem) else { continue };
            if id != stem {
                continue; // a lower-case twin would alias the same chat; the Mac only writes upper-case
            }
            let Ok(meta) = std::fs::symlink_metadata(ent.path()) else { continue };
            if !meta.is_file() {
                continue;
            }
            files.push((id, mtime_ns(&meta), meta.len()));
        }

        let mut cache = self.inner.cache.lock().unwrap_or_else(|e| e.into_inner());
        self.load_index(&mut cache);
        let mut todo: Vec<(String, u128, u64)> = Vec::new();
        let live: HashSet<&str> = files.iter().map(|f| f.0.as_str()).collect();
        let before = cache.entries.len();
        cache.entries.retain(|k, _| live.contains(k.as_str()));
        if cache.entries.len() != before {
            cache.dirty = true;
        }
        for f in &files {
            match cache.entries.get(&f.0) {
                Some(e) if e.mtime_ns == f.1 && e.size == f.2 => {}
                _ => todo.push(f.clone()),
            }
        }
        let dir = self.inner.layout.sessions.clone();
        let parsed = parse_many(&dir, &todo);
        let mut quarantined = 0usize;
        for ((id, m, s), p) in todo.iter().zip(parsed) {
            let p = match p {
                Some(p) => p,
                None => {
                    cache.entries.remove(id);
                    continue;
                }
            };
            if p == Parsed::Invalid {
                if quarantine(&dir, id).is_some() {
                    quarantined += 1;
                }
                cache.entries.remove(id);
                cache.dirty = true;
                continue;
            }
            cache.entries.insert(id.clone(), CacheEntry { mtime_ns: *m, size: *s, parsed: p });
            cache.dirty = true;
        }
        let mut unsupported = 0usize;
        let mut rows: Vec<&ChatSummary> = Vec::new();
        for (id, e) in cache.entries.iter() {
            match &e.parsed {
                Parsed::Ok { summary, owner } => {
                    if tomb.contains(id) {
                        continue;
                    }
                    if owner.as_deref().is_some_and(|o| o != self.user_id()) {
                        continue;
                    }
                    if q.scope.as_deref().is_some_and(|s| summary.scope.as_deref() != Some(s)) {
                        continue;
                    }
                    if q.project_id.as_deref().is_some_and(|p| summary.project_id.as_deref() != Some(p)) {
                        continue;
                    }
                    rows.push(summary);
                }
                Parsed::Unsupported | Parsed::TooLarge => unsupported += 1,
                Parsed::Invalid => {}
            }
        }
        rows.sort_by(|a, b| b.last_used_at.partial_cmp(&a.last_used_at).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.id.cmp(&b.id)));
        let total = rows.len();
        let limit = q.limit.clamp(1, MAX_LIST_PAGE);
        let items: Vec<ChatSummary> = rows.into_iter().skip(q.offset).take(limit).cloned().collect();
        let has_more = q.offset + items.len() < total;
        self.save_index(&mut cache);
        Ok(ListPage { items, total, has_more, quarantined, unsupported })
    }

    // -- load --

    /// One page of messages (the newest `limit` with index < `before`, or the tail), plus the header.
    pub fn load(&self, raw_id: &str, before: Option<usize>, limit: usize) -> Result<LoadedChat> {
        let id = self.id_arg(raw_id)?;
        if self.tombstoned_ids().contains(&id) {
            return Err(StoreError::new("deleted", "this chat was deleted"));
        }
        let path = self.file_path(&id);
        let file = File::open(&path).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { StoreError::new("not_found", "no such chat") } else { io_err("open chat", &e) })?;
        let meta = file.metadata().map_err(|e| io_err("stat chat", &e))?;
        if meta.len() > MAX_READ_BYTES {
            return Err(StoreError::new("too_large", "chat file exceeds the read limit"));
        }
        let limit = limit.clamp(1, MAX_PAGE);
        let reader = BufReader::with_capacity(64 * 1024, file.take(MAX_READ_BYTES));
        let mut de = serde_json::Deserializer::from_reader(reader);
        let doc = match (PageSeed { before: before.unwrap_or(usize::MAX), limit }).deserialize(&mut de) {
            Ok(d) => d,
            Err(e) if e.is_io() => return Err(classify(&e)),
            Err(_) => {
                quarantine(&self.inner.layout.sessions, &id);
                return Err(StoreError::new("corrupt", "chat file is unreadable and was set aside"));
            }
        };
        let mut fields = doc.fields;
        let Some(tail) = doc.tail else {
            return Err(StoreError::new("unsupported", "chat file has no messages array"));
        };
        let owner = fields.get("ownerUserId").and_then(Value::as_str);
        if owner.is_some_and(|o| o != self.user_id()) {
            return Err(StoreError::new("not_found", "no such chat"));
        }
        if canonical_chat_id(fields.get("id").and_then(Value::as_str).unwrap_or("")).as_deref() != Some(id.as_str()) {
            quarantine(&self.inner.layout.sessions, &id);
            return Err(StoreError::new("corrupt", "chat file is unreadable and was set aside"));
        }
        fields.insert("messages".into(), Value::Array(tail.messages));
        Ok(LoadedChat { session: Value::Object(fields), total: tail.total, start: tail.start, revision: revision_of(&meta) })
    }

    // -- save --

    /// Validates and writes a chat. See the module docs for the conflict rules.
    pub fn save(&self, session: Value, mode: SaveMode, expected_revision: Option<&str>, touch: bool) -> Result<SaveOutcome> {
        self.save_with(session, mode, expected_revision, touch, false)
    }

    /// `save`, with `allow_truncate` = a human confirmed that a `Replace` may drop more than half of the
    /// stored messages (without it such a save is refused, `truncation_needs_confirm`).
    pub fn save_with(&self, session: Value, mode: SaveMode, expected_revision: Option<&str>, touch: bool, allow_truncate: bool) -> Result<SaveOutcome> {
        let mut obj = match session {
            Value::Object(m) => m,
            _ => return Err(StoreError::new("invalid", "session must be an object")),
        };
        let id = self.id_arg(obj.get("id").and_then(Value::as_str).unwrap_or(""))?;
        validate_session(&obj)?;
        let _lock = self.lock()?;
        if self.tombstoned_ids().contains(&id) {
            return Err(StoreError::new("deleted", "this chat was deleted"));
        }
        let path = self.file_path(&id);
        let existing = match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() => Some(m),
            Ok(_) => return Err(StoreError::new("invalid", "chat path is not a regular file")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_err("stat chat", &e)),
        };
        match (&existing, expected_revision) {
            (None, Some(_)) => return Err(StoreError::new("conflict", "the chat no longer exists")),
            (Some(_), None) => return Err(StoreError::new("conflict", "the chat exists; load it and save with its revision")),
            (Some(m), Some(rev)) if revision_of(m) != rev => return Err(StoreError::new("conflict", "the chat changed on disk since it was loaded")),
            _ => {}
        }
        if let Some(m) = &existing {
            if m.len() > MAX_WRITE_BYTES as u64 {
                return Err(StoreError::new("too_large", "chat file is too large to modify"));
            }
        }
        // Existing file: owner check and, for append, the stored messages.
        let mut stored: Option<Map<String, Value>> = None;
        if existing.is_some() {
            let bytes = read_small(&path, MAX_WRITE_BYTES as u64 + 1).map_err(|e| io_err("read chat", &e))?;
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(Value::Object(m)) => {
                    if let Some(o) = m.get("ownerUserId").and_then(Value::as_str) {
                        if o != self.user_id() {
                            return Err(StoreError::new("foreign_owner", "this chat belongs to another user"));
                        }
                    }
                    stored = Some(m);
                }
                _ => return Err(StoreError::new("conflict", "the stored chat is unreadable; it will be set aside on the next list")),
            }
        }
        // Owner: always this user.
        if let Some(o) = obj.get("ownerUserId").and_then(Value::as_str) {
            if o != self.user_id() {
                return Err(StoreError::new("foreign_owner", "session names another owner"));
            }
        }
        obj.insert("ownerUserId".into(), Value::String(self.user_id().to_string()));
        obj.insert("id".into(), Value::String(id.clone()));
        obj.insert("storeVersion".into(), Value::from(2));
        if let SaveMode::Append { expected_count } = mode {
            let Some(mut old) = stored else {
                return Err(StoreError::new("conflict", "cannot append to a chat that does not exist"));
            };
            let have = old.get("messages").and_then(Value::as_array).map_or(0, Vec::len);
            if have != expected_count {
                return Err(StoreError::new("conflict", "the stored message count differs from the caller's"));
            }
            let mut merged = old.remove("messages").and_then(|v| if let Value::Array(a) = v { Some(a) } else { None }).unwrap_or_default();
            if let Some(Value::Array(add)) = obj.remove("messages") {
                merged.extend(add);
            }
            if merged.len() > MAX_MESSAGES {
                return Err(StoreError::new("too_large", "too many messages in one chat"));
            }
            // Header: the stored object wins, except the fields the caller updates.
            for k in ["title", "lastUsedAt", "route", "projectId", "engine", "scope", "meetingId", "archive", "origin"] {
                if let Some(v) = obj.remove(k) {
                    old.insert(k.to_string(), v);
                }
            }
            old.insert("messages".into(), Value::Array(merged));
            obj = old;
            obj.insert("ownerUserId".into(), Value::String(self.user_id().to_string()));
            obj.insert("id".into(), Value::String(id.clone()));
            obj.insert("storeVersion".into(), Value::from(2));
        } else if let Some(old) = stored {
            let had = old.get("messages").and_then(Value::as_array).map_or(0, Vec::len);
            let now_n = obj.get("messages").and_then(Value::as_array).map_or(0, Vec::len);
            if is_truncation(had, now_n) && !allow_truncate {
                return Err(StoreError::new("truncation_needs_confirm", "this save would drop more than half of the stored messages; confirm it first"));
            }
            // Replace keeps keys this build does not model (a newer Mac field) unless the caller sets them.
            for (k, v) in old {
                if k != "messages" && !obj.contains_key(&k) {
                    obj.insert(k, v);
                }
            }
        }
        if touch || !obj.contains_key("lastUsedAt") {
            obj.insert("lastUsedAt".into(), Value::from(now_apple()));
        }
        let count = obj.get("messages").and_then(Value::as_array).map_or(0, Vec::len);
        let body = serde_json::to_vec(&Value::Object(obj.clone())).map_err(|_| StoreError::new("invalid", "session is not encodable"))?;
        if body.len() > MAX_WRITE_BYTES {
            return Err(StoreError::new("too_large", "chat exceeds the size limit"));
        }
        write_atomic(&path, &body)?;
        let meta = std::fs::metadata(&path).map_err(|e| io_err("stat chat", &e))?;
        Ok(SaveOutcome { revision: revision_of(&meta), message_count: count, last_used_at: obj.get("lastUsedAt").and_then(Value::as_f64).unwrap_or(0.0) })
    }

    // -- delete --

    /// Tombstone first (durable), then remove the file. Returns whether a file existed.
    pub fn delete(&self, raw_id: &str) -> Result<bool> {
        let id = self.id_arg(raw_id)?;
        let _lock = self.lock()?;
        let path = self.file_path(&id);
        if let Ok(b) = read_small(&path, SMALL_FILE_MAX) {
            if let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(&b) {
                if m.get("ownerUserId").and_then(Value::as_str).is_some_and(|o| o != self.user_id()) {
                    return Err(StoreError::new("not_found", "no such chat"));
                }
            }
        }
        self.add_tombstone(&id)?;
        let existed = self.trash_file(&id)?;
        let mut c = self.inner.cache.lock().unwrap_or_else(|e| e.into_inner());
        if c.entries.remove(&id).is_some() {
            c.dirty = true;
        }
        Ok(existed)
    }

    /// Number of messages in the stored file (for a confirmation dialog); `None` when unreadable.
    pub fn message_count_of(&self, id: &str) -> Option<usize> {
        let f = File::open(self.file_path(id)).ok()?;
        let size = f.metadata().ok()?.len();
        match parse_header(&f, size, id) {
            Parsed::Ok { summary, .. } => Some(summary.message_count),
            _ => None,
        }
    }

    /// The chat's title as stored (for a confirmation dialog); `None` when unreadable. Not logged.
    pub fn title_of(&self, id: &str) -> Option<String> {
        let f = File::open(self.file_path(id)).ok()?;
        let size = f.metadata().ok()?.len();
        match parse_header(&f, size, id) {
            Parsed::Ok { summary, owner } if owner.as_deref().is_none_or(|o| o == self.user_id()) => Some(summary.title),
            _ => None,
        }
    }

    fn deleted_dir(&self) -> PathBuf {
        self.inner.layout.sessions.join(DELETED_DIR)
    }

    /// Moves `<id>.json` to `<sessions>/.deleted/<id>.<unix ts>.json` (private folder), never removes it.
    /// `Ok(false)` when there was no file. Prunes the recoverable folder afterwards. The caller holds the lock.
    fn trash_file(&self, id: &str) -> Result<bool> {
        let from = self.file_path(id);
        match std::fs::symlink_metadata(&from) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(io_err("stat chat", &e)),
        }
        let dir = crate::fsutil::private_dir(&self.deleted_dir()).map_err(|e| StoreError::new("io", e))?;
        let ts = now_unix() as u64;
        let mut moved = false;
        for n in 0..1000u32 {
            let name = if n == 0 { format!("{id}.{ts}.json") } else { format!("{id}.{ts}-{n}.json") };
            let to = dir.join(name);
            if to.exists() {
                continue;
            }
            std::fs::rename(&from, &to).map_err(|e| io_err("move chat to the recoverable folder", &e))?;
            moved = true;
            break;
        }
        if !moved {
            return Err(StoreError::new("io", "cannot find a free name in the recoverable folder"));
        }
        prune_trash(&dir, ts);
        Ok(true)
    }

    /// Recoverable copies: (chat id, deleted-at unix seconds, path), newest first.
    pub fn trashed(&self) -> Vec<(String, u64, PathBuf)> {
        list_trash(&self.deleted_dir())
    }

    /// Removes files whose delete is pending (a late write or the other app resurrected them).
    /// Returns how many were removed.
    pub fn enforce_tombstones(&self) -> Result<usize> {
        let tomb = self.tombstoned_ids();
        if tomb.is_empty() {
            return Ok(0);
        }
        let _lock = self.lock()?;
        let mut n = 0;
        for id in tomb {
            let path = self.file_path(&id);
            if let Ok(m) = std::fs::symlink_metadata(&path) {
                if m.is_file() {
                    // Only this user's (or unowned) files; another user's tombstone is theirs to send.
                    let owner = read_small(&path, SMALL_FILE_MAX).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.get("ownerUserId").and_then(Value::as_str).map(str::to_owned));
                    if owner.as_deref().is_none_or(|o| o == self.user_id()) && matches!(self.trash_file(&id), Ok(true)) {
                        n += 1;
                    }
                }
            }
        }
        Ok(n)
    }

    // -- archive facts --

    pub fn archive_facts(&self, raw_id: &str) -> Result<ArchiveFacts> {
        let id = self.id_arg(raw_id)?;
        let path = self.file_path(&id);
        let missing = ArchiveFacts { exists: false, decoded: false, owned_by_user: true, message_count: 0, last_used_apple: None, hash: None };
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() => m,
            Ok(_) => return Ok(ArchiveFacts { exists: true, ..missing }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(missing),
            Err(e) => return Err(io_err("stat chat", &e)),
        };
        let exists_only = ArchiveFacts { exists: true, ..missing };
        if meta.len() > MAX_READ_BYTES {
            return Ok(exists_only);
        }
        let Ok(file) = File::open(&path) else { return Ok(exists_only) };
        let reader = BufReader::with_capacity(64 * 1024, file.take(MAX_READ_BYTES));
        let mut de = serde_json::Deserializer::from_reader(reader);
        let Ok(doc) = (HashSeed).deserialize(&mut de) else { return Ok(exists_only) };
        let Some(h) = doc.hashed else { return Ok(exists_only) };
        let owner = doc.fields.get("ownerUserId").and_then(Value::as_str);
        let id_ok = canonical_chat_id(doc.fields.get("id").and_then(Value::as_str).unwrap_or("")).as_deref() == Some(id.as_str());
        Ok(ArchiveFacts {
            exists: true,
            decoded: id_ok,
            owned_by_user: owner.is_none_or(|o| o == self.user_id()),
            message_count: h.0,
            last_used_apple: doc.fields.get("lastUsedAt").and_then(Value::as_f64),
            hash: Some(h.1),
        })
    }

    /// How many `*.corrupt-*` files sit in the store (never deleted by this module).
    pub fn quarantined_count(&self) -> usize {
        std::fs::read_dir(&self.inner.layout.sessions)
            .map(|rd| rd.flatten().filter(|e| e.file_name().to_str().is_some_and(|n| n.contains(".corrupt-"))).count())
            .unwrap_or(0)
    }
}

// ---- hash while streaming ---------------------------------------------------------------------

struct HashedDoc {
    fields: Map<String, Value>,
    /// (message count, hex digest)
    hashed: Option<(usize, String)>,
}

struct HashSeed;

struct HashMsg<'a>(&'a mut crate::chat_hash::Sha256);

impl<'de> DeserializeSeed<'de> for HashSeed {
    type Value = HashedDoc;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<HashedDoc, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = HashedDoc;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> std::result::Result<HashedDoc, A::Error> {
                let mut fields = Map::new();
                let mut hashed = None;
                while let Some(key) = m.next_key::<String>()? {
                    if key == "messages" {
                        let mut h = crate::chat_hash::Sha256::new();
                        let n = m.next_value_seed(HashMsgs(&mut h))?;
                        hashed = Some((n, h.finish_hex()));
                    } else {
                        fields.insert(key, m.next_value::<Value>()?);
                    }
                }
                Ok(HashedDoc { fields, hashed })
            }
        }
        d.deserialize_map(V)
    }
}

struct HashMsgs<'a>(&'a mut crate::chat_hash::Sha256);

impl<'de, 'a> DeserializeSeed<'de> for HashMsgs<'a> {
    type Value = usize;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<usize, D::Error> {
        struct V<'a>(&'a mut crate::chat_hash::Sha256);
        impl<'de, 'a> Visitor<'de> for V<'a> {
            type Value = usize;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an array")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<usize, A::Error> {
                let mut n = 0;
                while let Some(counted) = a.next_element_seed(HashMsg(&mut *self.0))? {
                    if counted {
                        n += 1;
                    }
                }
                Ok(n)
            }
        }
        d.deserialize_seq(V(self.0))
    }
}

impl<'de, 'a> DeserializeSeed<'de> for HashMsg<'a> {
    type Value = bool;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<bool, D::Error> {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct M {
            role: Option<String>,
            content: Option<String>,
        }
        // Mirrors the Mac: its lossy decoding drops a message whose role is not user/assistant/toolResult,
        // and `ChatArchiveService.wire` sends every non-assistant message as role "user".
        let m = M::deserialize(d)?;
        let role = match m.role.as_deref() {
            Some("assistant") => "assistant",
            Some("user") | Some("toolResult") => "user",
            _ => return Ok(false),
        };
        self.0.feed_message(role, m.content.as_deref().unwrap_or(""));
        Ok(true)
    }
}

// ---- helpers ---------------------------------------------------------------------------------

fn ensure_dir(dir: &Path) -> Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(m) => {
            if m.file_type().is_symlink() || !m.is_dir() {
                return Err(StoreError::new("io", "store path is not a plain directory"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                // SAFETY: geteuid has no preconditions.
                if m.uid() != unsafe { libc::geteuid() } {
                    return Err(StoreError::new("io", "store directory is owned by another user"));
                }
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => crate::fsutil::private_dir(dir).map(|_| ()).map_err(|e| StoreError::new("io", e)),
        Err(e) => Err(io_err("stat store dir", &e)),
    }
}

/// A replace that keeps fewer than half of a chat of more than four messages.
pub fn is_truncation(old: usize, new: usize) -> bool {
    old > 4 && new * 2 < old
}

/// (id, deleted-at, path) of every well-formed entry in the recoverable folder, newest first.
fn list_trash(dir: &Path) -> Vec<(String, u64, PathBuf)> {
    let mut v = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(stem) = name.strip_suffix(".json") else { continue };
            let Some((id, rest)) = stem.split_once('.') else { continue };
            let Some(id) = canonical_chat_id(id) else { continue };
            let Some(ts) = rest.split('-').next().and_then(|t| t.parse::<u64>().ok()) else { continue };
            v.push((id, ts, e.path()));
        }
    }
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v
}

/// Drops copies older than the retention and the oldest beyond the count bound.
fn prune_trash(dir: &Path, now: u64) {
    for (i, (_, ts, path)) in list_trash(dir).into_iter().enumerate() {
        if i >= TRASH_MAX_ENTRIES || now.saturating_sub(ts) > TRASH_RETENTION_SECS {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Moves `<id>.json` to `<id>.corrupt-<unix ts>` (Mac convention). Never deletes.
pub fn quarantine(sessions: &Path, id: &str) -> Option<PathBuf> {
    let from = sessions.join(format!("{id}.json"));
    let ts = now_unix() as u64;
    for n in 0..100u32 {
        let name = if n == 0 { format!("{id}.corrupt-{ts}") } else { format!("{id}.corrupt-{ts}-{n}") };
        let to = sessions.join(name);
        if !to.exists() {
            return std::fs::rename(&from, &to).ok().map(|()| to);
        }
    }
    None
}

fn validate_session(obj: &Map<String, Value>) -> Result<()> {
    let bad = |m: &str| Err(StoreError::new("invalid", m.to_string()));
    match obj.get("scope").and_then(Value::as_str) {
        Some(s) if SCOPES.contains(&s) => {}
        _ => return bad("scope is missing or unknown"),
    }
    match obj.get("title").and_then(Value::as_str) {
        Some(t) if t.chars().count() <= TITLE_MAX_CHARS => {}
        _ => return bad("title is missing or too long"),
    }
    for k in ["createdAt", "lastUsedAt"] {
        match obj.get(k).and_then(Value::as_f64) {
            Some(v) if v.is_finite() => {}
            _ if k == "lastUsedAt" && !obj.contains_key(k) => {}
            _ => return bad("a timestamp is missing or not a finite number"),
        }
    }
    let Some(msgs) = obj.get("messages").and_then(Value::as_array) else {
        return bad("messages must be an array");
    };
    if msgs.len() > MAX_MESSAGES {
        return Err(StoreError::new("too_large", "too many messages in one chat"));
    }
    for m in msgs {
        match m.as_object().and_then(|o| o.get("role")).and_then(Value::as_str) {
            Some(r) if ROLES.contains(&r) => {}
            _ => return bad("a message has no valid role"),
        }
    }
    for k in ["engine", "projectId", "meetingId", "origin"] {
        if obj.get(k).is_some_and(|v| !v.is_string() && !v.is_null()) {
            return bad("an optional field has the wrong type");
        }
    }
    Ok(())
}

/// Parses the changed files, in up to four threads. `None` = could not open (vanished).
fn parse_many(dir: &Path, todo: &[(String, u128, u64)]) -> Vec<Option<Parsed>> {
    let one = |(id, _m, size): &(String, u128, u64)| -> Option<Parsed> {
        let f = File::open(dir.join(format!("{id}.json"))).ok()?;
        Some(parse_header(&f, *size, id))
    };
    if todo.len() < 64 {
        return todo.iter().map(one).collect();
    }
    let chunk = todo.len().div_ceil(4);
    std::thread::scope(|s| {
        let handles: Vec<_> = todo.chunks(chunk).map(|c| (c.len(), s.spawn(move || c.iter().map(one).collect::<Vec<_>>()))).collect();
        handles.into_iter().flat_map(|(n, h)| h.join().unwrap_or_else(|_| vec![None; n])).collect()
    })
}

#[cfg(test)]
#[path = "chat_store_tests.rs"]
pub(crate) mod tests;
