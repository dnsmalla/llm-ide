//! Live-then-archive for the desktop chat store: the quit hook and the start-up recovery sweep.
//!
//! Model (live-then-archive plan, option B, same as the Mac app): the chat FILE is the live and
//! final transcript; the server only holds working state for a chat (agent mapping, SDK transcript,
//! session memory). At quit, for every chat the server still holds working state for:
//!
//!   1. verify the file (exists, decodes, owned by this user, has messages, not older than the
//!      server's last use of the chat),
//!   2. record a receipt (`POST /kb/archive-receipts`: SHA-256 over the file's messages, computed
//!      from the file just read),
//!   3. only then ask the core to purge the working state (`POST /agent/v2/sessions/purge`,
//!      `verified: true`); the server refuses a chat without a receipt, a chat with a turn running,
//!      and a receipt older than the chat's last use.
//!
//! Nothing is deleted before the verify; a failure at any step leaves the working state, and the
//! next start's sweep repeats the same steps. The whole quit run has a hard time cap (6 s by
//! default) so a dead core can never hold the app open.
//!
//! Crash and kill behaviour (see `docs/how-to/desktop-chat-store.md`):
//! - a pending-archive journal (`archive-journal.json`, private data dir) is written BEFORE the
//!   first server call and updated per step, so a run killed at any point is visible at the next
//!   start (`interrupted`) and the sweep, which needs no journal to be correct, replays it;
//! - macOS has `ExitRequested` for Cmd-Q / Dock quit and the SIGTERM handler; Windows and Linux get
//!   `ExitRequested` for window close and SIGTERM on Linux, but NOT a reliable hook for OS shutdown,
//!   a `TerminateProcess` or a power loss. Those paths rely on the sweep alone;
//! - the sweep runs once per launch right after the webview binds its signed-in session (the host
//!   holds no user credential of its own).

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_store::{canonical_chat_id, now_unix, write_atomic, ChatStore, APPLE_EPOCH_UNIX};

/// Hard cap of the quit run.
pub const QUIT_CAP: Duration = Duration::from_secs(6);
/// Cap of the start-up sweep (it runs in the background).
pub const SWEEP_CAP: Duration = Duration::from_secs(25);
/// One remote call never waits longer than this, whatever time is left.
const CALL_CAP: Duration = Duration::from_secs(3);
const PURGE_BATCH: usize = 100;
/// Most chats one run will look at.
const MAX_CANDIDATES: usize = 5_000;
const RESPONSE_MAX: u64 = 4 * 1024 * 1024;

// ---- the remote ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteError {
    Unreachable,
    Unauthorized,
    /// 409 `NO_RECEIPT`: nothing was purged.
    NoReceipt,
    Http(u16),
    Invalid,
}

impl RemoteError {
    pub fn label(&self) -> String {
        match self {
            Self::Unreachable => "unreachable".into(),
            Self::Unauthorized => "unauthorized".into(),
            Self::NoReceipt => "no_receipt".into(),
            Self::Http(c) => format!("http_{c}"),
            Self::Invalid => "invalid_response".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkingChat {
    pub chat_session_id: String,
    /// SQLite `datetime('now')` text (UTC) or ISO 8601; `None` when only facts remain.
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PurgeResult {
    pub purged: usize,
    pub busy: Vec<String>,
    pub stale_receipt: Vec<String>,
}

/// What the archive protocol asks of the core (the lifecycle routes in `schema/http/lifecycle.schema.json`).
pub trait LifecycleRemote {
    fn working_state(&self, timeout: Duration) -> Result<Vec<WorkingChat>, RemoteError>;
    fn record_receipt(&self, chat_id: &str, hash: &str, count: usize, timeout: Duration) -> Result<(), RemoteError>;
    fn purge_working(&self, chat_ids: &[String], timeout: Duration) -> Result<PurgeResult, RemoteError>;
    /// `POST /kb/session-purges`: returns `done` | `pending` | `failed`.
    fn session_purge(&self, chat_id: &str, requested_at_iso: &str, timeout: Duration) -> Result<String, RemoteError>;
}

/// Loopback HTTP implementation. The base URL must be `http://127.0.0.1:<port>` (or `localhost` / `[::1]`);
/// redirects are never followed, so the bearer token cannot be sent anywhere else.
pub struct HttpRemote {
    base: String,
    token: String,
}

impl HttpRemote {
    pub fn new(base: &str, token: &str) -> Result<Self, String> {
        Self::check_loopback(base)?;
        if token.is_empty() || token.len() > 8192 || token.bytes().any(|b| b < 0x21 || b == 0x7f) {
            return Err("invalid token".into());
        }
        Ok(Self { base: base.trim_end_matches('/').to_string(), token: token.to_string() })
    }

    fn check_loopback(base: &str) -> Result<(), String> {
        let rest = base.strip_prefix("http://").ok_or("core url must be http on loopback")?;
        let host_port = rest.split('/').next().unwrap_or("");
        let host = if let Some(v6) = host_port.strip_prefix('[') { v6.split(']').next().unwrap_or("") } else { host_port.split(':').next().unwrap_or("") };
        if matches!(host, "127.0.0.1" | "localhost" | "::1") && !host_port.contains('@') {
            Ok(())
        } else {
            Err("core url must be loopback".into())
        }
    }

    fn agent(timeout: Duration) -> ureq::Agent {
        ureq::AgentBuilder::new().redirects(0).timeout(timeout.min(CALL_CAP).max(Duration::from_millis(100))).build()
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<Value, RemoteError> {
        let url = format!("{}{}", self.base, path);
        let req = Self::agent(timeout).request(method, &url).set("Authorization", &format!("Bearer {}", self.token));
        let res = match body {
            Some(b) => req.set("Content-Type", "application/json").send_string(&b.to_string()),
            None => req.call(),
        };
        match res {
            Ok(resp) => read_json(resp),
            Err(ureq::Error::Status(401 | 403, _)) => Err(RemoteError::Unauthorized),
            Err(ureq::Error::Status(409, resp)) => {
                let v = read_json(resp).unwrap_or(Value::Null);
                if v.pointer("/error/code").and_then(Value::as_str) == Some("NO_RECEIPT") {
                    Err(RemoteError::NoReceipt)
                } else {
                    Err(RemoteError::Http(409))
                }
            }
            Err(ureq::Error::Status(c, _)) => Err(RemoteError::Http(c)),
            Err(ureq::Error::Transport(_)) => Err(RemoteError::Unreachable),
        }
    }

    /// `GET /auth/me`: the user id the core's login resolves this token to.
    pub fn me(&self, timeout: Duration) -> Result<String, RemoteError> {
        let v = self.call("GET", "/auth/me", None, timeout)?;
        v.get("id").and_then(Value::as_str).map(str::to_owned).ok_or(RemoteError::Invalid)
    }
}

fn read_json(resp: ureq::Response) -> Result<Value, RemoteError> {
    let mut buf = Vec::new();
    resp.into_reader().take(RESPONSE_MAX).read_to_end(&mut buf).map_err(|_| RemoteError::Unreachable)?;
    serde_json::from_slice(&buf).map_err(|_| RemoteError::Invalid)
}

impl LifecycleRemote for HttpRemote {
    fn working_state(&self, timeout: Duration) -> Result<Vec<WorkingChat>, RemoteError> {
        let v = self.call("GET", "/kb/agent/working-state", None, timeout)?;
        let arr = v.get("sessions").and_then(Value::as_array).ok_or(RemoteError::Invalid)?;
        Ok(arr
            .iter()
            .filter_map(|s| {
                Some(WorkingChat {
                    chat_session_id: s.get("chatSessionId")?.as_str()?.to_string(),
                    updated_at: s.get("updatedAt").and_then(Value::as_str).map(str::to_owned),
                })
            })
            .collect())
    }

    fn record_receipt(&self, chat_id: &str, hash: &str, count: usize, timeout: Duration) -> Result<(), RemoteError> {
        let body = serde_json::json!({ "chatSessionId": chat_id, "hash": hash, "count": count });
        let v = self.call("POST", "/kb/archive-receipts", Some(&body), timeout)?;
        if v.get("recorded").and_then(Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err(RemoteError::Invalid)
        }
    }

    fn purge_working(&self, chat_ids: &[String], timeout: Duration) -> Result<PurgeResult, RemoteError> {
        let body = serde_json::json!({ "chatSessionIds": chat_ids, "verified": true });
        let v = self.call("POST", "/agent/v2/sessions/purge", Some(&body), timeout)?;
        let list = |k: &str| v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        Ok(PurgeResult { purged: v.get("purged").and_then(Value::as_u64).unwrap_or(0) as usize, busy: list("busy"), stale_receipt: list("staleReceipt") })
    }

    fn session_purge(&self, chat_id: &str, requested_at_iso: &str, timeout: Duration) -> Result<String, RemoteError> {
        let body = serde_json::json!({ "chatSessionId": chat_id, "reason": "user_delete", "requestedAt": requested_at_iso });
        let v = self.call("POST", "/kb/session-purges", Some(&body), timeout)?;
        v.get("purged").and_then(Value::as_str).map(str::to_owned).ok_or(RemoteError::Invalid)
    }
}

// ---- time helpers --------------------------------------------------------------------------

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The server stamps `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC); ISO 8601 is accepted too.
pub fn parse_server_time(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 19 || !(b[10] == b' ' || b[10] == b'T') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    Some((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se) as f64)
}

pub fn iso_utc(unix: f64) -> String {
    let secs = unix.max(0.0) as i64;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let r = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", r / 3600, (r % 3600) / 60, r % 60)
}

// ---- journal and report ---------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub hash: String,
    pub count: usize,
    pub receipted: bool,
    pub purged: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalDoc {
    /// `idle` | `running` | `interrupted` | `done`
    pub state: String,
    /// `quit` | `sweep`
    pub mode: String,
    pub started_at_unix: f64,
    pub updated_at_unix: f64,
    pub entries: Vec<JournalEntry>,
    pub last_report: Option<ArchiveReport>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReport {
    /// Chats whose working state the server purged.
    pub purged: Vec<String>,
    /// Chat id -> why it was left alone (the sweep retries). Reasons are fixed words.
    pub skipped: BTreeMap<String, String>,
    pub errors: Vec<String>,
    /// Every step that was needed ran (nothing left over for a later sweep).
    pub completed: bool,
    pub deadline_hit: bool,
    pub tombstones_sent: usize,
    pub resurrected_removed: usize,
}

pub struct Journal {
    path: Option<PathBuf>,
}

impl Journal {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self { path }
    }

    pub fn read(&self) -> Option<JournalDoc> {
        let p = self.path.as_ref()?;
        let mut v = Vec::new();
        std::fs::File::open(p).ok()?.take(8 * 1024 * 1024).read_to_end(&mut v).ok()?;
        serde_json::from_slice(&v).ok()
    }

    fn write(&self, doc: &JournalDoc) {
        if let Some(p) = &self.path {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(b) = serde_json::to_vec(doc) {
                let _ = write_atomic(p, &b);
            }
        }
    }
}

// ---- the archiver ----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    Quit,
    Sweep,
}

/// How far the archive goes (the desktop's `ltaMode` pref, fixed per launch).
/// `Off`: the quit run does not exist and the start sweep only forwards pending deletes.
/// `Shadow`: verify and record receipts, but never purge the server's working state.
/// `On`: the full verify, receipt, purge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchivePolicy {
    Off,
    Shadow,
    On,
}

pub struct Archiver<R: LifecycleRemote> {
    store: ChatStore,
    remote: R,
    journal: Journal,
    now: fn() -> f64,
    policy: ArchivePolicy,
}

impl<R: LifecycleRemote> Archiver<R> {
    pub fn new(store: ChatStore, remote: R, journal_path: Option<PathBuf>) -> Self {
        Self { store, remote, journal: Journal::new(journal_path), now: now_unix, policy: ArchivePolicy::On }
    }

    pub fn with_policy(mut self, policy: ArchivePolicy) -> Self {
        self.policy = policy;
        self
    }

    #[cfg(test)]
    pub fn journal_doc(&self) -> Option<JournalDoc> {
        self.journal.read()
    }

    /// The quit run: archive, never longer than `cap`.
    pub fn quit(&self, cap: Duration) -> ArchiveReport {
        self.run(RunMode::Quit, cap)
    }

    /// The start-up recovery: tombstones first, then the same verify/receipt/purge as the quit.
    pub fn sweep(&self, cap: Duration) -> ArchiveReport {
        self.run(RunMode::Sweep, cap)
    }

    fn run(&self, mode: RunMode, cap: Duration) -> ArchiveReport {
        let deadline = Instant::now() + cap;
        let left = |d: &Instant| d.saturating_duration_since(Instant::now());
        let mut report = ArchiveReport::default();
        let mut doc = JournalDoc { state: "running".into(), mode: if mode == RunMode::Quit { "quit" } else { "sweep" }.into(), started_at_unix: (self.now)(), updated_at_unix: (self.now)(), entries: Vec::new(), last_report: None };
        // The intent is durable before any server call.
        self.journal.write(&doc);

        if mode == RunMode::Sweep {
            match self.store.enforce_tombstones() {
                Ok(n) => report.resurrected_removed = n,
                Err(e) => report.errors.push(format!("tombstones: {}", e.code)),
            }
            for entry in self.store.my_pending_deletes() {
                if left(&deadline).is_zero() {
                    report.deadline_hit = true;
                    break;
                }
                let iso = iso_utc(entry.requested_at + APPLE_EPOCH_UNIX);
                match self.remote.session_purge(&entry.id, &iso, left(&deadline)) {
                    Ok(state) if state == "done" => {
                        let _ = self.store.remove_tombstone(&entry.id);
                        report.tombstones_sent += 1;
                    }
                    Ok(_) => {
                        let _ = self.store.bump_tombstone_attempt(&entry.id);
                    }
                    Err(e) => {
                        let _ = self.store.bump_tombstone_attempt(&entry.id);
                        report.errors.push(format!("tombstone: {}", e.label()));
                        if e == RemoteError::Unauthorized || e == RemoteError::Unreachable {
                            break;
                        }
                    }
                }
            }
        }

        let finish = |mut doc: JournalDoc, mut report: ArchiveReport, ok: bool| {
            report.completed = ok && report.errors.is_empty() && !report.deadline_hit;
            doc.state = if report.completed { "done" } else { "interrupted" }.into();
            doc.updated_at_unix = (self.now)();
            doc.last_report = Some(report.clone());
            self.journal.write(&doc);
            report
        };

        if self.policy == ArchivePolicy::Off {
            // Pending deletes were forwarded above; nothing else is archived while the mode is off.
            return finish(doc, report, true);
        }
        if left(&deadline).is_zero() {
            report.deadline_hit = true;
            return finish(doc, report, false);
        }
        let state = match self.remote.working_state(left(&deadline)) {
            Ok(s) => s,
            Err(e) => {
                report.errors.push(format!("working-state: {}", e.label()));
                return finish(doc, report, false);
            }
        };

        // 1. verify every chat the server holds working state for.
        let tomb = self.store.tombstoned_ids();
        let mut verified: Vec<JournalEntry> = Vec::new();
        for ws in state.into_iter().take(MAX_CANDIDATES) {
            let Some(id) = canonical_chat_id(&ws.chat_session_id) else {
                report.skipped.insert(ws.chat_session_id, "invalidId".into());
                continue;
            };
            if tomb.contains(&id) {
                report.skipped.insert(id, "deletePending".into());
                continue;
            }
            let facts = match self.store.archive_facts(&id) {
                Ok(f) => f,
                Err(e) => {
                    report.skipped.insert(id, e.code.into());
                    continue;
                }
            };
            if !facts.exists {
                report.skipped.insert(id, "fileMissing".into());
                continue;
            }
            if !facts.decoded {
                report.skipped.insert(id, "fileUnreadable".into());
                continue;
            }
            if !facts.owned_by_user {
                report.skipped.insert(id, "ownedByOtherUser".into());
                continue;
            }
            if facts.message_count == 0 {
                report.skipped.insert(id, "emptyFile".into());
                continue;
            }
            // Never fewer messages than this store has seen for the chat: a truncated (even freshly
            // touched) file must not let the server's longer working state be purged.
            if facts.message_count < facts.high_water {
                report.skipped.insert(id, "fewerMessagesThanSeen".into());
                continue;
            }
            // The FILE's mtime (not the header's lastUsedAt, which a page can write) must not be older than
            // the server's last use. No slack: the server stamps whole seconds, the file is saved after a turn.
            if let Some(server) = ws.updated_at.as_deref().and_then(parse_server_time) {
                if facts.mtime_unix.is_none_or(|m| m < server) {
                    report.skipped.insert(id, "fileOlderThanServer".into());
                    continue;
                }
            }
            let Some(hash) = facts.hash else {
                report.skipped.insert(id, "fileUnreadable".into());
                continue;
            };
            verified.push(JournalEntry { id, hash, count: facts.message_count, receipted: false, purged: false });
        }
        doc.entries = verified.clone();
        self.journal.write(&doc);

        // 2. receipts (the file's own digest), one per verified chat.
        for e in verified.iter_mut() {
            if left(&deadline).is_zero() {
                report.deadline_hit = true;
                break;
            }
            match self.remote.record_receipt(&e.id, &e.hash, e.count, left(&deadline)) {
                Ok(()) => e.receipted = true,
                Err(err) => {
                    report.skipped.insert(e.id.clone(), "receiptFailed".into());
                    report.errors.push(format!("receipt: {}", err.label()));
                    if err == RemoteError::Unauthorized || err == RemoteError::Unreachable {
                        break;
                    }
                }
            }
        }
        doc.entries = verified.clone();
        self.journal.write(&doc);

        // 3. purge working state, only for receipted chats.
        let ids: Vec<String> = if self.policy == ArchivePolicy::Shadow {
            Vec::new() // shadow: verified and receipted, never purged
        } else {
            verified.iter().filter(|e| e.receipted).map(|e| e.id.clone()).collect()
        };
        let mut purged_ids: Vec<String> = Vec::new();
        let mut i = 0;
        while i < ids.len() {
            if left(&deadline).is_zero() {
                report.deadline_hit = true;
                break;
            }
            let batch = &ids[i..(i + PURGE_BATCH).min(ids.len())];
            i += batch.len();
            let mut apply = |ids: &[String], r: PurgeResult, report: &mut ArchiveReport| {
                for id in &r.busy {
                    report.skipped.insert(id.clone(), "serverBusy".into());
                }
                for id in &r.stale_receipt {
                    report.skipped.insert(id.clone(), "staleReceipt".into());
                }
                for id in ids {
                    if !r.busy.contains(id) && !r.stale_receipt.contains(id) {
                        purged_ids.push(id.clone());
                    }
                }
            };
            match self.remote.purge_working(batch, left(&deadline)) {
                Ok(r) => apply(batch, r, &mut report),
                Err(RemoteError::NoReceipt) => {
                    // The server refuses the whole batch over one chat; one by one so the rest clear.
                    for id in batch {
                        if left(&deadline).is_zero() {
                            report.deadline_hit = true;
                            break;
                        }
                        match self.remote.purge_working(std::slice::from_ref(id), left(&deadline)) {
                            Ok(r) => apply(std::slice::from_ref(id), r, &mut report),
                            Err(_) => {
                                report.skipped.insert(id.clone(), "noReceipt".into());
                            }
                        }
                    }
                }
                Err(e) => {
                    report.errors.push(format!("purge: {}", e.label()));
                    if e == RemoteError::Unauthorized || e == RemoteError::Unreachable {
                        break;
                    }
                }
            }
        }
        for e in doc.entries.iter_mut() {
            e.purged = purged_ids.contains(&e.id);
        }
        report.purged = purged_ids;
        finish(doc, report, true)
    }
}

#[cfg(test)]
#[path = "chat_archive_tests.rs"]
pub(crate) mod tests;
