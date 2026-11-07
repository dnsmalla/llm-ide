//! Next-launch crash notice (the Mac's `CrashReportStore` + `CrashReportBanner`).
//!
//! A panic hook writes one small JSON record per panic into `<app data dir>/crashes/` (0600, the folder 0700).
//! On the next launch the shell asks for the newest pending record and shows a banner with Dismiss and
//! "Copy details". Dismiss deletes every pending record (the Mac's `dismissAll`).
//!
//! What a record holds, and nothing else: a schema version, the time (RFC 3339 UTC), the panic message, the
//! panic location (`file:line`), the app version and the OS and CPU names. No environment, no secrets, no
//! backtrace, no project path. The message and location are redacted before they are written (the user's
//! home and other `/Users/<name>`, `/home/<name>` segments become `~` or `<user>`, secret-looking `name=value`
//! pairs and long opaque tokens are masked, control and bidi characters dropped) and are redacted again when
//! read, because the file is untrusted input. Records are bounded: at most `MAX_RECORDS` are kept, each file is
//! capped at `RECORD_MAX_BYTES`, and a file that is a symlink, oversized, malformed or of another version is
//! skipped, never followed.
//!
//! The webview never names a path: the two commands take no arguments and read only the fixed folder.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsutil;

/// Pending records kept on disk; older ones are deleted when a new one is written.
pub const MAX_RECORDS: usize = 5;
/// One record file is never larger than this (a record is well under 4 KiB).
pub const RECORD_MAX_BYTES: usize = 8 * 1024;
const DIR_NAME: &str = "crashes";
const VERSION: u32 = 1;
const MESSAGE_CAP: usize = 1_000;
const LOCATION_CAP: usize = 300;

/// What is written to disk. Field order is the file order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CrashRecord {
    pub v: u32,
    pub at: String,
    pub message: String,
    pub location: String,
    pub app_version: String,
    pub os: String,
}

/// What the shell shows: the newest pending record plus how many are pending.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CrashNotice {
    pub at: String,
    pub message: String,
    pub location: String,
    pub app_version: String,
    pub os: String,
    pub count: usize,
}

/// Raw panic facts, before redaction.
#[derive(Clone, Debug, PartialEq)]
pub struct PanicFacts {
    pub message: String,
    pub location: String,
}

/// Removes control and bidi/invisible characters, the user's home folder and every other `/Users/<name>`,
/// `/home/<name>`, `\Users\<name>` segment, then masks secret-looking pairs and opaque tokens (the same helper
/// the core log uses), and caps the length in characters.
pub fn redact(raw: &str, home: Option<&str>, cap: usize) -> String {
    // A control character becomes a space, not nothing: dropping it would glue `Bearer\tTOKEN` into one word.
    let mut s: String = raw
        .chars()
        .filter(|&c| !crate::tray::is_invisible_format(c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if let Some(h) = home.map(|h| h.trim_end_matches(['/', '\\'])).filter(|h| h.len() >= 2 && *h != "/") {
        s = replace_home(&s, h);
    }
    let s = mask_user_segments(&s);
    // Before `redact_line`, which would turn `Authorization:Bearer` into `Authorization:[redacted]` and hide the cue.
    let s = mask_known_secrets(&s);
    let s = crate::core_host::redact_line(&s, &[]);
    s.chars().take(cap).collect()
}

/// Replaces `home` with `~` only where it ends at a path boundary, so `/Users/d` never turns `/Users/dave`
/// into `~ave` (which would also hide the name from `mask_user_segments`).
fn replace_home(s: &str, home: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(home) {
        let after = &rest[i + home.len()..];
        let boundary = after.chars().next().is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '.')));
        out.push_str(&rest[..i]);
        out.push_str(if boundary { "~" } else { home });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Credential shapes `redact_line` does not cover (the prefixes of `extension/core/redact-secrets.mjs`): a
/// token carrying a known key prefix, the word after `Bearer`/`Basic`, and URL userinfo
/// (`https://user:pass@host` keeps only the scheme and host).
fn mask_known_secrets(s: &str) -> String {
    const PREFIXES: [&str; 18] = [
        "sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "gloas-", "glrt-", "gldt-", "xoxa-",
        "xoxb-", "xoxp-", "AIza", "AKIA", "ASIA", "ya29.",
    ];
    let mut out: Vec<String> = Vec::new();
    let mut after_scheme_word = false;
    for tok in s.split_whitespace() {
        // The last word of the token (`Authorization:Bearer` -> `Bearer`), and whether it is a secret name with
        // its value in the next word (`"password": hunter2`, `token= x`).
        let last = tok.rsplit([':', '=']).next().unwrap_or(tok).trim_matches(|c: char| !c.is_alphanumeric());
        let scheme = last.eq_ignore_ascii_case("bearer") || last.eq_ignore_ascii_case("basic");
        if after_scheme_word && !scheme {
            after_scheme_word = false;
            out.push("[redacted]".into());
            continue;
        }
        let lower = tok.to_ascii_lowercase();
        let empty_secret_pair = tok.ends_with([':', '='])
            && ["secret", "token", "key", "password", "passwd", "authorization", "cookie", "credential"]
                .iter()
                .any(|w| lower.contains(w));
        if scheme || empty_secret_pair {
            // `Authorization: Bearer x`: the cue carries over the scheme word to the value after it.
            after_scheme_word = true;
            out.push(tok.to_string());
            continue;
        }
        let has_key = PREFIXES.iter().any(|p| {
            tok.match_indices(p).any(|(i, _)| {
                let before_ok = tok[..i].chars().next_back().is_none_or(|c| !c.is_ascii_alphanumeric());
                let body = tok[i + p.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).count();
                before_ok && body >= 8
            })
        });
        out.push(if has_key { "[redacted]".into() } else { strip_userinfo(tok) });
    }
    out.join(" ")
}

/// `scheme://user:pass@host/...` becomes `scheme://[redacted]@host/...`, anywhere in the token.
fn strip_userinfo(tok: &str) -> String {
    let Some(p) = tok.find("://") else { return tok.to_string() };
    let auth_start = p + 3;
    let auth_end = tok[auth_start..].find(['/', '?', '#']).map_or(tok.len(), |e| auth_start + e);
    match tok[auth_start..auth_end].rfind('@') {
        Some(at) => format!("{}[redacted]{}", &tok[..auth_start], &tok[auth_start + at..]),
        None => tok.to_string(),
    }
}

/// Replaces the name in `/Users/<name>`, `/home/<name>` and `\Users\<name>` with `<user>`.
fn mask_user_segments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let next = ["/Users/", "/home/", "\\Users\\"]
            .iter()
            .filter_map(|m| rest.find(m).map(|i| (i, m.len())))
            .min_by_key(|(i, _)| *i);
        let Some((i, mlen)) = next else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..i + mlen]);
        let after = &rest[i + mlen..];
        let end = after.find(['/', '\\', ' ']).unwrap_or(after.len());
        if end > 0 {
            out.push_str("<user>");
        }
        rest = &after[end..];
    }
}

/// The text of a panic payload (`&str` or `String`), or a fixed phrase for anything else.
pub fn payload_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "(panic payload is not text)".to_string()
    }
}

/// Builds the record from raw facts. Pure: the time and the home folder are passed in.
pub fn build_record(facts: &PanicFacts, at: &str, home: Option<&str>) -> CrashRecord {
    CrashRecord {
        v: VERSION,
        at: at.to_string(),
        message: redact(&facts.message, home, MESSAGE_CAP),
        location: redact(&facts.location, home, LOCATION_CAP),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
    }
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()).filter(|h| !h.trim().is_empty())
}

pub(crate) fn records_dir() -> Result<PathBuf, String> {
    Ok(fsutil::desktop_data_dir()?.join(DIR_NAME))
}

/// `crash-<unix nanoseconds>-<pid>.json`: the name carries the time the record sorts by.
fn record_name(nanos: u128, pid: u32) -> String {
    format!("crash-{nanos}-{pid}.json")
}

/// The nanosecond part of a record file name, when the name is one of ours.
fn record_nanos(name: &str) -> Option<u128> {
    let core = name.strip_prefix("crash-")?.strip_suffix(".json")?;
    let (nanos, pid) = core.split_once('-')?;
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    nanos.parse().ok()
}

/// Pending record files, newest first. Only regular files with our name are listed.
fn pending_files(dir: &Path) -> Vec<(u128, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(u128, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name();
            let nanos = record_nanos(name.to_str()?)?;
            let meta = std::fs::symlink_metadata(e.path()).ok()?;
            meta.is_file().then(|| (nanos, e.path()))
        })
        .collect();
    out.sort_by_key(|x| std::cmp::Reverse(x.0));
    out
}

/// Writes `rec` into `dir` as the record for `nanos`, then deletes the oldest records beyond `MAX_RECORDS`.
pub fn write_record_at(dir: &Path, rec: &CrashRecord, nanos: u128, pid: u32) -> Result<PathBuf, String> {
    fsutil::private_dir(dir)?;
    let body = serde_json::to_string(rec).map_err(|e| e.to_string())?;
    let path = dir.join(record_name(nanos, pid));
    fsutil::write_private_atomic(&path, body.as_bytes(), RECORD_MAX_BYTES)?;
    for (_, old) in pending_files(dir).into_iter().skip(MAX_RECORDS) {
        let _ = std::fs::remove_file(old);
    }
    Ok(path)
}

/// Reads one record file, or `None` when it is a symlink, oversized, malformed, another version, or has a bad time.
fn read_record(path: &Path) -> Option<CrashRecord> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > RECORD_MAX_BYTES as u64 {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let rec: CrashRecord = serde_json::from_str(&text).ok()?;
    let valid = rec.v == VERSION && crate::project::valid_rfc3339_utc(&rec.at);
    valid.then_some(rec)
}

/// The newest pending record (re-redacted on read), with the pending count. `None` when nothing is pending.
pub fn latest_in(dir: &Path) -> Option<CrashNotice> {
    let home = home_dir();
    let readable: Vec<CrashRecord> = pending_files(dir).iter().filter_map(|(_, p)| read_record(p)).collect();
    let count = readable.len();
    let rec = readable.into_iter().next()?;
    Some(CrashNotice {
        at: rec.at,
        message: redact(&rec.message, home.as_deref(), MESSAGE_CAP),
        location: redact(&rec.location, home.as_deref(), LOCATION_CAP),
        app_version: redact(&rec.app_version, None, 40),
        os: redact(&rec.os, None, 80),
        count,
    })
}

/// Every readable pending record with its file name (the crash id Self-Heal imports once), re-redacted on read like
/// `latest_in`.
pub fn pending_records_in(dir: &Path) -> Vec<(String, CrashRecord)> {
    let home = home_dir();
    pending_files(dir)
        .into_iter()
        .filter_map(|(_, p)| {
            let id = p.file_name()?.to_str()?.to_string();
            let mut rec = read_record(&p)?;
            rec.message = redact(&rec.message, home.as_deref(), MESSAGE_CAP);
            rec.location = redact(&rec.location, home.as_deref(), LOCATION_CAP);
            Some((id, rec))
        })
        .collect()
}

/// Deletes every pending record in `dir` (and nothing else). Returns how many files were removed.
pub fn dismiss_in(dir: &Path) -> usize {
    let files = pending_files(dir);
    let mut removed = 0;
    for (_, p) in &files {
        if std::fs::remove_file(p).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Deletes only the records this process (`pid`) wrote: a panic the app survived (a worker thread) must not
/// show a crash banner after a clean exit. Records of earlier processes stay for their banner.
pub fn clear_own_in(dir: &Path, pid: u32) -> usize {
    let suffix = format!("-{pid}.json");
    let mine = pending_files(dir).into_iter().filter(|(_, p)| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&suffix))
    });
    mine.filter(|(_, p)| std::fs::remove_file(p).is_ok()).count()
}

/// Clean-exit hook: drops this process's own records. Failures are ignored (exit must not stall).
pub fn clear_own_on_clean_exit() {
    if let Ok(dir) = records_dir() {
        clear_own_in(&dir, std::process::id());
    }
}

/// Panic hook body: writes one record. Never panics itself (a panic inside a panic hook aborts the process),
/// so every failure is dropped.
pub fn record_panic(info: &std::panic::PanicHookInfo<'_>) {
    let facts = PanicFacts {
        message: payload_text(info.payload()),
        location: info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default(),
    };
    let Ok(dir) = records_dir() else { return };
    let rec = build_record(&facts, &crate::project::now_rfc3339(), home_dir().as_deref());
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let _ = write_record_at(&dir, &rec, nanos, std::process::id());
}

// ---- commands -------------------------------------------------------------------------------

/// The newest pending crash, for the banner. `null` when there is none.
#[tauri::command]
pub fn crash_report_latest() -> Result<Option<CrashNotice>, String> {
    Ok(latest_in(&records_dir()?))
}

/// Dismisses the banner: deletes every pending record. Returns how many were removed.
#[tauri::command]
pub fn crash_report_dismiss() -> Result<usize, String> {
    Ok(dismiss_in(&records_dir()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-crash-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    fn facts(msg: &str) -> PanicFacts {
        PanicFacts { message: msg.into(), location: "/Users/dinsmallade/llm-ide/desktop/src-tauri/src/git_scm.rs:123".into() }
    }

    fn rec(msg: &str) -> CrashRecord {
        build_record(&facts(msg), "2026-11-02T10:00:00Z", Some("/Users/dinsmallade"))
    }

    #[test]
    fn write_then_read_round_trip_is_private_and_carries_only_the_fields() {
        let dir = scratch("write");
        let path = write_record_at(&dir, &rec("boom"), 100, 7).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["app_version", "at", "location", "message", "os", "v"], "no env, no backtrace, no other field");
        let n = latest_in(&dir).unwrap();
        assert_eq!(n.message, "boom");
        assert_eq!(n.count, 1);
        assert_eq!(n.at, "2026-11-02T10:00:00Z");
        assert_eq!(n.app_version, env!("CARGO_PKG_VERSION"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600, "record is owner-only");
            assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o077, 0, "folder is private");
        }
    }

    #[test]
    fn the_folder_keeps_at_most_max_records_and_drops_the_oldest() {
        let dir = scratch("cap");
        for i in 1..=(MAX_RECORDS as u128 + 3) {
            write_record_at(&dir, &rec(&format!("crash {i}")), i, 7).unwrap();
        }
        let left = pending_files(&dir);
        assert_eq!(left.len(), MAX_RECORDS);
        assert_eq!(left.first().map(|x| x.0), Some(MAX_RECORDS as u128 + 3), "newest kept");
        assert_eq!(left.last().map(|x| x.0), Some(4), "the three oldest are gone");
        assert_eq!(latest_in(&dir).unwrap().message, format!("crash {}", MAX_RECORDS + 3));
        assert_eq!(latest_in(&dir).unwrap().count, MAX_RECORDS);
    }

    #[test]
    fn redaction_removes_home_users_secrets_controls_and_caps_length() {
        let r = build_record(
            &PanicFacts {
                message: "failed at /Users/dinsmallade/work/a.txt and /home/bob/app\u{202E}\u{7} api_key=sk-live-123 token=abc".into(),
                location: "/Users/dinsmallade/llm-ide/desktop/src.rs:9".into(),
            },
            "2026-11-02T10:00:00Z",
            Some("/Users/dinsmallade"),
        );
        assert!(!r.message.contains("dinsmallade"), "{}", r.message);
        assert!(!r.location.contains("dinsmallade"), "{}", r.location);
        assert!(r.message.contains("~/work/a.txt"), "{}", r.message);
        assert!(r.message.contains("/home/<user>/app"), "{}", r.message);
        assert!(!r.message.contains("sk-live-123"), "{}", r.message);
        assert!(!r.message.contains('\u{202E}') && !r.message.contains('\u{7}'));
        assert!(r.location.starts_with("~/llm-ide/"), "{}", r.location);
        let long = build_record(&PanicFacts { message: "é".repeat(5_000), location: "x".repeat(900) }, "2026-11-02T10:00:00Z", None);
        assert_eq!(long.message.chars().count(), MESSAGE_CAP, "message capped by characters, multibyte safe");
        assert_eq!(long.location.chars().count(), LOCATION_CAP);
        let opaque = redact("key 0123456789abcdef0123456789abcdef0123", None, 1000);
        assert!(!opaque.contains("0123456789abcdef0123"), "{opaque}");
    }

    #[test]
    fn redaction_masks_key_prefixes_bearer_url_userinfo_and_home_paths() {
        let raw = "invalid x-api-key: sk-ant-api03-abcdefghij (ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ) \
                   Authorization: Bearer abc fetch https://user:pass@host.example/repo.git?x=1 \
                   in /Users/alice/secret/path and xoxb-1234-abcdefgh";
        let r = redact(raw, Some("/Users/alice"), 1000);
        for leak in ["sk-ant", "ghp_", "abc fetch", "user:pass", "alice", "xoxb-"] {
            assert!(!r.contains(leak), "{leak} leaked: {r}");
        }
        assert!(r.contains("Bearer [redacted]"), "{r}");
        assert!(r.contains("https://[redacted]@host.example/repo.git"), "{r}");
        assert!(r.contains("~/secret/path"), "{r}");
        // A home that is a prefix of another user's name is not half-replaced.
        assert_eq!(redact("/Users/dave/x", Some("/Users/d"), 100), "/Users/<user>/x");
        // Ordinary words that merely contain a prefix survive.
        assert_eq!(redact("task-12345678 desk-abcdefgh", None, 100), "task-12345678 desk-abcdefgh");
    }

    #[test]
    fn redaction_covers_the_review_cases_and_split_tokens() {
        let raw = "sk-ant-api03-xxxxxxxxxxxx ghp_xxxxxxxxxxxxxxxxxxxx Bearer abc.def https://user:pass@host/x /Users/carol/secret/path";
        let r = redact(raw, Some("/Users/carol"), 1000);
        for leak in ["sk-ant-api03", "ghp_x", "abc.def", "user:pass", "carol"] {
            assert!(!r.contains(leak), "{leak} leaked: {r}");
        }
        assert!(r.contains("~/secret/path"), "{r}");
        // A tab or newline between the scheme word and the value must not glue them into one token.
        for raw in ["Bearer\tabc.def", "Bearer\nabc.def", "failed\nsk-ant-api03-xxxxxxxxxxxx"] {
            let r = redact(raw, None, 1000);
            assert!(!r.contains("abc.def") && !r.contains("sk-ant"), "leaked: {r}");
        }
        // The scheme word glued to a header name, and a secret name whose value is the next word.
        for raw in ["Authorization:Bearer abc.def", "\"password\": hunter2", "token= abc.def"] {
            let r = redact(raw, None, 1000);
            assert!(!r.contains("abc.def") && !r.contains("hunter2"), "leaked: {r}");
        }
    }

    #[test]
    fn clean_exit_drops_only_this_process_records() {
        let dir = scratch("own");
        write_record_at(&dir, &rec("earlier run"), 1, 17).unwrap();
        write_record_at(&dir, &rec("survived"), 2, 7).unwrap();
        assert_eq!(clear_own_in(&dir, 7), 1);
        let left = latest_in(&dir).unwrap();
        assert_eq!((left.message.as_str(), left.count), ("earlier run", 1), "pid 17 is not pid 7");
        assert_eq!(clear_own_in(&dir, 7), 0, "a second clear is a no-op");
    }

    #[test]
    fn dismiss_deletes_pending_records_and_nothing_else() {
        let dir = scratch("ack");
        write_record_at(&dir, &rec("one"), 1, 7).unwrap();
        write_record_at(&dir, &rec("two"), 2, 7).unwrap();
        fs::write(dir.join("notes.txt"), "keep").unwrap();
        assert_eq!(latest_in(&dir).unwrap().message, "two");
        assert_eq!(dismiss_in(&dir), 2);
        assert!(latest_in(&dir).is_none(), "nothing pending after dismiss");
        assert_eq!(fs::read_to_string(dir.join("notes.txt")).unwrap(), "keep", "unrelated files are left alone");
        assert_eq!(dismiss_in(&dir), 0, "a second dismiss is a no-op");
    }

    #[test]
    fn unreadable_hostile_or_foreign_files_are_skipped_not_followed() {
        let dir = scratch("tolerant");
        write_record_at(&dir, &rec("good"), 5, 7).unwrap();
        // Newer names, all unusable: malformed JSON, another version, a bad time, oversized, a wrong name.
        fs::write(dir.join(record_name(9, 7)), "{not json").unwrap();
        fs::write(dir.join(record_name(8, 7)), r#"{"v":2,"at":"2026-11-02T10:00:00Z","message":"m","location":"l","app_version":"x","os":"y"}"#).unwrap();
        fs::write(dir.join(record_name(7, 7)), r#"{"v":1,"at":"yesterday","message":"m","location":"l","app_version":"x","os":"y"}"#).unwrap();
        fs::write(dir.join(record_name(6, 7)), vec![b' '; RECORD_MAX_BYTES + 1]).unwrap();
        fs::write(dir.join("crash-x-y.json"), "{}").unwrap();
        let n = latest_in(&dir).unwrap();
        assert_eq!(n.message, "good", "the newest USABLE record is shown");
        #[cfg(unix)]
        {
            let target = dir.join("elsewhere.json");
            fs::write(&target, r#"{"v":1,"at":"2026-11-02T10:00:00Z","message":"linked","location":"l","app_version":"x","os":"y"}"#).unwrap();
            std::os::unix::fs::symlink(&target, dir.join(record_name(20, 7))).unwrap();
            assert_eq!(latest_in(&dir).unwrap().message, "good", "a symlinked record is never read");
        }
        let empty = scratch("tolerant-empty");
        assert!(latest_in(&empty).is_none());
        assert!(latest_in(&empty.join("missing")).is_none(), "a missing folder is nothing pending, not an error");
    }

    #[test]
    fn panic_payloads_become_text() {
        let s: Box<dyn std::any::Any + Send> = Box::new("static text");
        assert_eq!(payload_text(s.as_ref()), "static text");
        let owned: Box<dyn std::any::Any + Send> = Box::new(String::from("owned text"));
        assert_eq!(payload_text(owned.as_ref()), "owned text");
        let other: Box<dyn std::any::Any + Send> = Box::new(42u8);
        assert_eq!(payload_text(other.as_ref()), "(panic payload is not text)");
    }

    #[test]
    fn record_names_round_trip_and_reject_strangers() {
        assert_eq!(record_nanos(&record_name(123, 45)), Some(123));
        assert_eq!(record_nanos("crash-123-.json"), None);
        assert_eq!(record_nanos("crash-123-4a.json"), None);
        assert_eq!(record_nanos("notes-123-4.json"), None);
        assert_eq!(record_nanos("crash-123-4.json.bak"), None);
    }
}
