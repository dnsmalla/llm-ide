//! Self-Heal capture, host side (plan A of docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md).
//!
//! Debug builds only:
//! - `enabled()` is false in a release build whatever the environment. A release build therefore records nothing,
//!   passes no `LLMIDE_SELF_HEAL` to the core and answers `self_heal_take` with `enabled: false`.
//! - A debug build records unless `LLMIDE_SELF_HEAL=0`.
//!
//! Two host sources:
//! - the spawned core's stderr: one report per error line plus its `at …` frames, or per JSON logger `error` line;
//! - `crash_report`'s panic records: once per record file, the last 50 ids remembered.
//!
//! Every report is redacted line by line here (`crash_report::redact`) and again by the core before it is stored.
//! The webview drains the queue (`self_heal_take`) and posts it to `POST /kb/self-heal/incidents`; the host never
//! calls the core for this. Incident text is never logged.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Reports held for the webview; past this the oldest go first.
pub const QUEUE_MAX: usize = 100;
const MAX_FRAMES: usize = 30;
const QUIET: Duration = Duration::from_secs(2);
const CATEGORY_CAP: usize = 200;
const MESSAGE_CAP: usize = 2_000;
const STACK_LINE_CAP: usize = 500;
const SEEN_CRASHES_MAX: usize = 50;
const SEEN_FILE: &str = "self-heal-crashes.json";
/// Request ids of recent `request_failed` lines: their `http_request` 5xx summary is the same failure.
const RECENT_FAILED_MAX: usize = 64;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct HostIncident {
    pub source: &'static str,
    pub category: String,
    pub message: String,
    pub stack: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Take {
    pub enabled: bool,
    pub incidents: Vec<HostIncident>,
}

/// The switch: a debug build, unless the developer set `LLMIDE_SELF_HEAL=0`.
pub fn gate(debug: bool, value: Option<&str>) -> bool {
    debug && value != Some("0")
}

pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| gate(cfg!(debug_assertions), std::env::var("LLMIDE_SELF_HEAL").ok().as_deref()))
}

/// The Mac's `normalizeEndpoint`: no query, and a segment with a digit or of 20+ characters becomes `:id`.
pub fn normalize_endpoint(path: &str) -> String {
    let bare = path.split('?').next().unwrap_or(path);
    bare.split('/')
        .map(|s| if s.chars().any(|c| c.is_ascii_digit()) || s.chars().count() >= 20 { ":id" } else { s })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_error_start(line: &str) -> bool {
    let word: String = line.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    line.starts_with("ERROR:") || line.starts_with("Uncaught") || line.contains("Error:") || word.ends_with("Error")
}

/// Groups the core's stderr into reports (the Mac's `ServerStderrIncidentParser`, plus the core logger's JSON lines).
#[derive(Default)]
pub struct StderrParser {
    pending: Option<HostIncident>,
    frames: usize,
    last_line: Option<Instant>,
    failed_requests: VecDeque<String>,
}

impl StderrParser {
    pub fn feed(&mut self, line: &str, now: Instant) -> Vec<HostIncident> {
        self.last_line = Some(now);
        let trimmed = line.trim();
        if trimmed.starts_with("at ") {
            if let Some(p) = self.pending.as_mut() {
                let stack = p.stack.get_or_insert_with(String::new);
                if !stack.is_empty() {
                    stack.push('\n');
                }
                stack.push_str(line);
                self.frames += 1;
                return if self.frames >= MAX_FRAMES { self.flush() } else { Vec::new() };
            }
        }
        let mut done = self.flush();
        if trimmed.starts_with('{') {
            done.extend(self.json_line(trimmed));
        } else if is_error_start(trimmed) {
            self.pending = Some(HostIncident { source: "server", category: "server".into(), message: trimmed.into(), stack: None });
        }
        done
    }

    /// A trace's last frame has no following line to close it: it settles after 2 s of quiet.
    pub fn flush_if_quiet(&mut self, now: Instant) -> Vec<HostIncident> {
        match self.last_line {
            Some(t) if now.duration_since(t) >= QUIET => self.flush(),
            _ => Vec::new(),
        }
    }

    pub fn flush(&mut self) -> Vec<HostIncident> {
        self.frames = 0;
        self.pending.take().into_iter().collect()
    }

    fn json_line(&mut self, line: &str) -> Option<HostIncident> {
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        if v.get("level")?.as_str()? != "error" {
            return None;
        }
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        let msg = s("msg").unwrap_or_else(|| "error".into());
        let url = s("url").unwrap_or_default();
        // The Self-Heal routes' own failures would feed back into the store.
        if url.starts_with("/kb/self-heal") {
            return None;
        }
        let endpoint = || format!("{} {}", s("method").unwrap_or_else(|| "?".into()), normalize_endpoint(&url));
        let rid = s("requestId");
        match msg.clone().as_str() {
            "http_request" => {
                let status = v.get("status").and_then(|x| x.as_u64()).unwrap_or(0);
                if status < 500 || rid.as_ref().is_some_and(|r| self.failed_requests.contains(r)) {
                    return None;
                }
                Some(HostIncident { source: "server", category: endpoint(), message: format!("HTTP {status}"), stack: None })
            }
            "request_failed" => {
                if let Some(r) = rid {
                    self.failed_requests.push_back(r);
                    if self.failed_requests.len() > RECENT_FAILED_MAX {
                        self.failed_requests.pop_front();
                    }
                }
                let message = s("message").or_else(|| s("code")).unwrap_or_else(|| msg.clone());
                Some(HostIncident { source: "server", category: endpoint(), message, stack: s("stack") })
            }
            _ => {
                let message = ["error", "message", "reason"]
                    .into_iter()
                    .find_map(&s)
                    .map(|m| format!("{msg}: {m}"))
                    .unwrap_or_else(|| msg.clone());
                Some(HostIncident { source: "log", category: msg, message, stack: s("stack") })
            }
        }
    }
}

/// Line-by-line redaction with the crash notice's redactor (home folder, user names, secret pairs, opaque tokens).
pub fn redact_incident(i: HostIncident, home: Option<&str>) -> HostIncident {
    use crate::crash_report::redact;
    HostIncident {
        source: i.source,
        category: redact(&i.category, home, CATEGORY_CAP),
        message: redact(&i.message, home, MESSAGE_CAP),
        stack: i.stack.map(|s| {
            s.lines().take(MAX_FRAMES + 1).map(|l| redact(l, home, STACK_LINE_CAP)).collect::<Vec<_>>().join("\n")
        }),
    }
}

/// Each pending panic record becomes one report, once: the ids already reported live in `seen_path` (the last 50,
/// in order; the Mac's `CrashIncidentImporter`). The banner's Dismiss still deletes the records themselves.
pub fn crash_incidents(dir: &Path, seen_path: &Path) -> Vec<HostIncident> {
    let mut seen: Vec<String> = std::fs::read(seen_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let mut out = Vec::new();
    for (id, rec) in crate::crash_report::pending_records_in(dir) {
        if seen.contains(&id) {
            continue;
        }
        out.push(HostIncident { source: "crash", category: "crash".into(), message: rec.message, stack: Some(format!("at {}", rec.location)) });
        seen.push(id);
    }
    if !out.is_empty() {
        let keep = seen.len().saturating_sub(SEEN_CRASHES_MAX);
        let body = serde_json::to_vec(&seen[keep..]).unwrap_or_default();
        let _ = crate::fsutil::write_private_atomic(seen_path, &body, 16 * 1024);
    }
    out
}

static QUEUE: Mutex<VecDeque<HostIncident>> = Mutex::new(VecDeque::new());
static PARSER: Mutex<Option<StderrParser>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn with_parser<R>(f: impl FnOnce(&mut StderrParser) -> R) -> R {
    f(lock(&PARSER).get_or_insert_with(StderrParser::default))
}

fn home() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()).filter(|h| !h.trim().is_empty())
}

fn enqueue(items: Vec<HostIncident>) {
    if items.is_empty() {
        return;
    }
    let home = home();
    let mut q = lock(&QUEUE);
    for i in items {
        q.push_back(redact_incident(i, home.as_deref()));
        if q.len() > QUEUE_MAX {
            q.pop_front();
        }
    }
}

/// One line of the spawned core's stderr (`core_host::drain`). A no-op in a release build.
pub fn on_core_stderr_line(line: &str) {
    if enabled() {
        enqueue(with_parser(|p| p.feed(line, Instant::now())));
    }
}

/// The core's stderr closed (it exited): the open trace is complete.
pub fn on_core_stderr_end() {
    if enabled() {
        enqueue(with_parser(StderrParser::flush));
    }
}

/// The webview's pump: everything queued since the last call, or `enabled: false` in a release build.
#[tauri::command]
pub fn self_heal_take() -> Take {
    if !enabled() {
        return Take { enabled: false, incidents: Vec::new() };
    }
    enqueue(with_parser(|p| p.flush_if_quiet(Instant::now())));
    if let (Ok(dir), Ok(data)) = (crate::crash_report::records_dir(), crate::fsutil::desktop_data_dir()) {
        enqueue(crash_incidents(&dir, &data.join(SEEN_FILE)));
    }
    Take { enabled: true, incidents: lock(&QUEUE).drain(..).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(p: &mut StderrParser, lines: &[&str], t: Instant) -> Vec<HostIncident> {
        lines.iter().flat_map(|l| p.feed(l, t)).collect()
    }

    #[test]
    fn the_gate_is_debug_only_and_honours_an_explicit_off() {
        assert!(gate(true, None));
        assert!(gate(true, Some("1")));
        assert!(!gate(true, Some("0")), "LLMIDE_SELF_HEAL=0 opts a debug build out");
        assert!(!gate(false, None), "a release build never records");
        assert!(!gate(false, Some("1")), "not even when asked");
    }

    #[test]
    fn endpoints_lose_their_ids_and_query() {
        assert_eq!(normalize_endpoint("/kb/notes/42/edit?x=1"), "/kb/notes/:id/edit");
        assert_eq!(normalize_endpoint("/kb/sync/devices/AAAAAAAAAAAAAAAAAAAAAA"), "/kb/sync/devices/:id");
        assert_eq!(normalize_endpoint("/health"), "/health");
    }

    #[test]
    fn a_plain_error_line_takes_its_frames_and_closes_on_the_next_line() {
        let t = Instant::now();
        let mut p = StderrParser::default();
        let out = feed_all(&mut p, &["TypeError: x is not a function", "    at a (/r/extension/server.mjs:1:2)", "    at b (node:internal/x:3:4)", "plain line"], t);
        assert_eq!(out, vec![HostIncident {
            source: "server",
            category: "server".into(),
            message: "TypeError: x is not a function".into(),
            stack: Some("    at a (/r/extension/server.mjs:1:2)\n    at b (node:internal/x:3:4)".into()),
        }]);
        assert!(p.flush().is_empty());
        assert!(feed_all(&mut p, &["all good", "    at nothing"], t).is_empty(), "a frame without an error is noise");
    }

    #[test]
    fn a_trace_settles_after_two_quiet_seconds_and_caps_at_thirty_frames() {
        let t = Instant::now();
        let mut p = StderrParser::default();
        p.feed("Error: boom", t);
        assert!(p.flush_if_quiet(t + Duration::from_millis(1_999)).is_empty());
        assert_eq!(p.flush_if_quiet(t + Duration::from_secs(2)).len(), 1);
        p.feed("Error: deep", t);
        let mut out = Vec::new();
        for i in 0..30 {
            out.extend(p.feed(&format!("    at f{i} (x.js:1:1)"), t));
        }
        assert_eq!(out.len(), 1, "the 30th frame closes the trace");
        assert_eq!(out[0].stack.as_ref().unwrap().lines().count(), 30);
    }

    #[test]
    fn json_logger_lines_become_reports_and_a_failed_request_is_reported_once() {
        let t = Instant::now();
        let mut p = StderrParser::default();
        let failed = r#"{"ts":"x","level":"error","msg":"request_failed","requestId":"ab12","method":"POST","url":"/kb/notes/42","code":"INTERNAL_ERROR","message":"db is locked","stack":"Error: db is locked\n    at x (/r/extension/kb/db.mjs:9:1)"}"#;
        let summary = r#"{"ts":"x","level":"error","msg":"http_request","requestId":"ab12","method":"POST","url":"/kb/notes/42","status":500}"#;
        let bare = r#"{"ts":"x","level":"error","msg":"http_request","requestId":"cd34","method":"GET","url":"/kb/sync/status","status":503}"#;
        let uncaught = r#"{"ts":"x","level":"error","msg":"uncaught_exception","error":"boom","stack":"Error: boom"}"#;
        let warn = r#"{"ts":"x","level":"warn","msg":"request_rejected","code":"X"}"#;
        let own = r#"{"ts":"x","level":"error","msg":"http_request","requestId":"ef56","method":"POST","url":"/kb/self-heal/incidents","status":500}"#;
        let out = feed_all(&mut p, &[failed, summary, bare, uncaught, warn, own, "{not json"], t);
        assert_eq!(out, vec![
            HostIncident { source: "server", category: "POST /kb/notes/:id".into(), message: "db is locked".into(), stack: Some("Error: db is locked\n    at x (/r/extension/kb/db.mjs:9:1)".into()) },
            HostIncident { source: "server", category: "GET /kb/sync/status".into(), message: "HTTP 503".into(), stack: None },
            HostIncident { source: "log", category: "uncaught_exception".into(), message: "uncaught_exception: boom".into(), stack: Some("Error: boom".into()) },
        ]);
    }

    #[test]
    fn redaction_masks_the_home_folder_user_names_and_secrets_per_line() {
        let i = HostIncident {
            source: "server",
            category: "server".into(),
            message: "Error: token=abcdef123456 at /Users/alice/x".into(),
            stack: Some("    at a (/Users/alice/llm-ide/extension/server.mjs:1:2)\n    at b (/home/bob/y.js:1:1)".into()),
        };
        let r = redact_incident(i, Some("/Users/alice"));
        assert!(!r.message.contains("abcdef123456") && !r.message.contains("alice"), "{}", r.message);
        let stack = r.stack.unwrap();
        assert_eq!(stack.lines().count(), 2);
        assert!(stack.contains("~/llm-ide/extension/server.mjs:1:2"), "{stack}");
        assert!(!stack.contains("bob"), "{stack}");
    }

    #[test]
    fn each_crash_record_becomes_one_report_once() {
        let root = std::env::temp_dir().join(format!("llmide-selfheal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let crashes = root.join("crashes");
        let seen = root.join(SEEN_FILE);
        let facts = crate::crash_report::PanicFacts {
            message: "index out of bounds".into(),
            location: "/Users/dev/llm-ide/desktop/src-tauri/src/git_scm.rs:123".into(),
        };
        let rec = crate::crash_report::build_record(&facts, "2026-11-07T10:00:00Z", Some("/Users/dev"));
        crate::crash_report::write_record_at(&crashes, &rec, 100, 7).unwrap();
        let first = crash_incidents(&crashes, &seen);
        assert_eq!(first.len(), 1);
        assert_eq!((first[0].source, first[0].category.as_str(), first[0].message.as_str()), ("crash", "crash", "index out of bounds"));
        assert!(first[0].stack.as_deref().unwrap().contains("desktop/src-tauri/src/git_scm.rs:123"));
        assert!(crash_incidents(&crashes, &seen).is_empty(), "the same record is never reported twice");
        crate::crash_report::write_record_at(&crashes, &rec, 200, 7).unwrap();
        assert_eq!(crash_incidents(&crashes, &seen).len(), 1, "a new record is");
        let _ = std::fs::remove_dir_all(&root);
    }
}
