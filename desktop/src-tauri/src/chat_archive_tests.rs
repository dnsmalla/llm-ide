use super::*;
use crate::chat_store::tests::{session, store, Tmp};
use crate::chat_store::{ChatStore, SaveMode};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

const A: &str = "AAAAAAAA-0000-4000-8000-00000000000A";
const B: &str = "AAAAAAAA-0000-4000-8000-00000000000B";
const C: &str = "AAAAAAAA-0000-4000-8000-00000000000C";
const D: &str = "AAAAAAAA-0000-4000-8000-00000000000D";
const E: &str = "AAAAAAAA-0000-4000-8000-00000000000E";

// ---- an in-memory core that behaves like the lifecycle routes ------------------------------------

#[derive(Default)]
pub(crate) struct CoreState {
    /// chat id -> `updatedAt` text of its working state
    pub working: BTreeMap<String, String>,
    pub receipts: BTreeMap<String, (String, usize)>,
    pub busy: BTreeSet<String>,
    pub stale: BTreeSet<String>,
    /// every call, in order: `receipt:<id>`, `purge:<ids>`, ...
    pub log: Vec<String>,
    /// session-purge answer per chat (`done` by default)
    pub purge_answer: BTreeMap<String, String>,
    pub purge_requested: Vec<(String, String)>,
}

#[derive(Clone, Default)]
pub(crate) struct FakeCore {
    pub state: Arc<Mutex<CoreState>>,
    /// Fail every call from the nth on (0 = never): the process "dies" at that step.
    pub die_at: Arc<Mutex<Option<usize>>>,
    pub calls: Arc<Mutex<usize>>,
    pub delay: Duration,
}

impl FakeCore {
    fn tick(&self) {
        std::thread::sleep(self.delay);
        let n = {
            let mut n = self.calls.lock().unwrap_or_else(|e| e.into_inner());
            *n += 1;
            *n
        };
        let die = *self.die_at.lock().unwrap_or_else(|e| e.into_inner());
        if die.is_some_and(|k| n >= k) {
            // A kill: unwinds without running the archiver's own finishing step (no panic hook output).
            std::panic::resume_unwind(Box::new("killed"));
        }
    }
}

impl LifecycleRemote for FakeCore {
    fn working_state(&self, _t: Duration) -> Result<Vec<WorkingChat>, RemoteError> {
        self.tick();
        let s = self.state.lock().unwrap();
        Ok(s.working.iter().map(|(k, v)| WorkingChat { chat_session_id: k.clone(), updated_at: Some(v.clone()) }).collect())
    }
    fn record_receipt(&self, id: &str, hash: &str, count: usize, _t: Duration) -> Result<(), RemoteError> {
        self.tick();
        let mut s = self.state.lock().unwrap();
        s.log.push(format!("receipt:{id}"));
        s.receipts.insert(id.to_string(), (hash.to_string(), count));
        Ok(())
    }
    fn purge_working(&self, ids: &[String], _t: Duration) -> Result<PurgeResult, RemoteError> {
        self.tick();
        let mut s = self.state.lock().unwrap();
        s.log.push(format!("purge:{}", ids.join(",")));
        if ids.iter().any(|i| !s.receipts.contains_key(i)) {
            return Err(RemoteError::NoReceipt);
        }
        let mut r = PurgeResult::default();
        for id in ids {
            if s.busy.contains(id) {
                r.busy.push(id.clone());
            } else if s.stale.contains(id) {
                r.stale_receipt.push(id.clone());
            } else if s.working.remove(id).is_some() {
                r.purged += 1;
            }
        }
        Ok(r)
    }
    fn session_purge(&self, id: &str, iso: &str, _t: Duration) -> Result<String, RemoteError> {
        self.tick();
        let mut s = self.state.lock().unwrap();
        s.purge_requested.push((id.to_string(), iso.to_string()));
        Ok(s.purge_answer.get(id).cloned().unwrap_or_else(|| "done".into()))
    }
}

fn server_ts(apple: f64) -> String {
    iso_utc(apple + APPLE_EPOCH_UNIX).replace('T', " ").replace('Z', "")
}

struct Fixture {
    t: Tmp,
    store: ChatStore,
    core: FakeCore,
}

/// A: good file. B: file missing. C: file older than the server's last use. D: tombstoned. E: another user's file.
/// F: empty chat file.
fn fixture() -> Fixture {
    let t = Tmp::new("arch");
    let s = store(&t, "u1");
    let other = store(&t, "someone");
    let core = FakeCore::default();
    let apple_now = crate::chat_store::now_apple();
    {
        let mut st = core.state.lock().unwrap();
        for id in [A, B, C, D, E] {
            st.working.insert(id.to_string(), server_ts(apple_now));
        }
    }
    s.save(session(A, 4), SaveMode::Replace, None, true).unwrap();
    // C: the file's lastUsedAt is an hour older than the server's last use
    let mut c = session(C, 2);
    c["lastUsedAt"] = json!(apple_now - 3600.0);
    s.save(c, SaveMode::Replace, None, false).unwrap();
    s.save(session(D, 2), SaveMode::Replace, None, true).unwrap();
    s.delete(D).unwrap();
    // the deleted chat's file is back (a late write)
    std::fs::write(t.0.join("sessions").join(format!("{D}.json")), serde_json::to_vec(&session(D, 2)).unwrap()).unwrap();
    other.save(session(E, 2), SaveMode::Replace, None, true).unwrap();
    Fixture { t, store: s, core }
}

fn archiver(f: &Fixture) -> Archiver<FakeCore> {
    Archiver::new(f.store.clone(), f.core.clone(), Some(f.t.0.join("private").join("archive-journal.json")))
}

fn file_bytes(f: &Fixture, id: &str) -> Option<Vec<u8>> {
    std::fs::read(f.t.0.join("sessions").join(format!("{id}.json"))).ok()
}

// ---- the quit protocol ----------------------------------------------------------------------------

#[test]
fn quit_purges_only_chats_whose_file_is_verified_and_receipts_come_first() {
    let f = fixture();
    let before_a = file_bytes(&f, A).unwrap();
    let report = archiver(&f).quit(Duration::from_secs(5));
    assert_eq!(report.purged, vec![A.to_string()]);
    assert_eq!(report.skipped.get(B).map(String::as_str), Some("fileMissing"));
    assert_eq!(report.skipped.get(C).map(String::as_str), Some("fileOlderThanServer"));
    assert_eq!(report.skipped.get(D).map(String::as_str), Some("deletePending"));
    assert_eq!(report.skipped.get(E).map(String::as_str), Some("ownedByOtherUser"));
    assert!(report.completed, "{report:?}");
    let st = f.core.state.lock().unwrap();
    assert_eq!(st.log, vec![format!("receipt:{A}"), format!("purge:{A}")], "receipt strictly before purge, nothing else touched");
    let facts = f.store.archive_facts(A).unwrap();
    assert_eq!(st.receipts[A], (facts.hash.unwrap(), 4), "the receipt is the digest of the file just read");
    assert_eq!(st.working.keys().cloned().collect::<Vec<_>>(), vec![B.to_string(), C.to_string(), D.to_string(), E.to_string()]);
    drop(st);
    assert_eq!(file_bytes(&f, A).unwrap(), before_a, "the archive never rewrites the chat file");
    let j = archiver(&f).journal_doc().unwrap();
    assert_eq!((j.state.as_str(), j.mode.as_str()), ("done", "quit"));
    assert_eq!(j.entries.len(), 1);
    assert!(j.entries[0].receipted && j.entries[0].purged);
}

#[test]
fn a_failed_receipt_means_no_purge_call_at_all() {
    struct NoReceipt(FakeCore);
    impl LifecycleRemote for NoReceipt {
        fn working_state(&self, t: Duration) -> Result<Vec<WorkingChat>, RemoteError> {
            self.0.working_state(t)
        }
        fn record_receipt(&self, _: &str, _: &str, _: usize, _: Duration) -> Result<(), RemoteError> {
            Err(RemoteError::Http(500))
        }
        fn purge_working(&self, ids: &[String], t: Duration) -> Result<PurgeResult, RemoteError> {
            self.0.purge_working(ids, t)
        }
        fn session_purge(&self, a: &str, b: &str, t: Duration) -> Result<String, RemoteError> {
            self.0.session_purge(a, b, t)
        }
    }
    let f = fixture();
    let report = Archiver::new(f.store.clone(), NoReceipt(f.core.clone()), None).quit(Duration::from_secs(5));
    assert!(report.purged.is_empty() && !report.completed);
    assert_eq!(report.skipped.get(A).map(String::as_str), Some("receiptFailed"));
    assert!(f.core.state.lock().unwrap().log.is_empty(), "purge was never attempted");
    assert!(f.core.state.lock().unwrap().working.contains_key(A));
}

#[test]
fn the_servers_busy_and_stale_answers_are_not_success() {
    let f = fixture();
    f.store.save(session(B, 2), SaveMode::Replace, None, true).unwrap();
    {
        let mut st = f.core.state.lock().unwrap();
        st.busy.insert(A.to_string());
    }
    let report = archiver(&f).quit(Duration::from_secs(5));
    assert_eq!(report.skipped.get(A).map(String::as_str), Some("serverBusy"));
    assert_eq!(report.purged, vec![B.to_string()]);
    {
        let mut st = f.core.state.lock().unwrap();
        st.busy.clear();
        st.stale.insert(A.to_string());
    }
    let report2 = archiver(&f).sweep(Duration::from_secs(5));
    assert_eq!(report2.skipped.get(A).map(String::as_str), Some("staleReceipt"));
    assert!(!report2.purged.contains(&A.to_string()));
    assert!(f.core.state.lock().unwrap().working.contains_key(A), "still there for the next sweep");
}

#[test]
fn one_chat_without_a_receipt_does_not_block_the_rest() {
    // A server that refuses a whole batch over one id: the archiver retries one by one.
    struct Picky(FakeCore);
    impl LifecycleRemote for Picky {
        fn working_state(&self, t: Duration) -> Result<Vec<WorkingChat>, RemoteError> {
            self.0.working_state(t)
        }
        fn record_receipt(&self, id: &str, h: &str, n: usize, t: Duration) -> Result<(), RemoteError> {
            if id == B {
                return Ok(()); // claims success but the server "lost" it
            }
            self.0.record_receipt(id, h, n, t)
        }
        fn purge_working(&self, ids: &[String], t: Duration) -> Result<PurgeResult, RemoteError> {
            self.0.purge_working(ids, t)
        }
        fn session_purge(&self, a: &str, b: &str, t: Duration) -> Result<String, RemoteError> {
            self.0.session_purge(a, b, t)
        }
    }
    let f = fixture();
    f.store.save(session(B, 2), SaveMode::Replace, None, true).unwrap();
    let report = Archiver::new(f.store.clone(), Picky(f.core.clone()), None).quit(Duration::from_secs(5));
    assert_eq!(report.purged, vec![A.to_string()]);
    assert_eq!(report.skipped.get(B).map(String::as_str), Some("noReceipt"));
}

#[test]
fn the_quit_cap_is_honoured_even_when_the_core_is_slow() {
    let mut f = fixture();
    f.core.delay = Duration::from_millis(250);
    f.store.save(session(B, 2), SaveMode::Replace, None, true).unwrap();
    let t0 = Instant::now();
    let report = archiver(&f).quit(Duration::from_millis(400));
    assert!(t0.elapsed() < Duration::from_millis(1300), "{:?}", t0.elapsed());
    assert!(report.deadline_hit && !report.completed, "{report:?}");
    let j = archiver(&f).journal_doc().unwrap();
    assert_eq!(j.state, "interrupted");
}

#[test]
fn an_unreachable_or_unauthorized_core_ends_the_run_cleanly() {
    struct Down(RemoteError);
    impl LifecycleRemote for Down {
        fn working_state(&self, _: Duration) -> Result<Vec<WorkingChat>, RemoteError> {
            Err(self.0.clone())
        }
        fn record_receipt(&self, _: &str, _: &str, _: usize, _: Duration) -> Result<(), RemoteError> {
            unreachable!()
        }
        fn purge_working(&self, _: &[String], _: Duration) -> Result<PurgeResult, RemoteError> {
            unreachable!()
        }
        fn session_purge(&self, _: &str, _: &str, _: Duration) -> Result<String, RemoteError> {
            Err(self.0.clone())
        }
    }
    let f = fixture();
    for e in [RemoteError::Unreachable, RemoteError::Unauthorized] {
        let r = Archiver::new(f.store.clone(), Down(e.clone()), Some(f.t.0.join("private").join("j.json"))).quit(Duration::from_secs(2));
        assert!(!r.completed && r.errors.iter().any(|m| m.contains(&e.label())), "{r:?}");
    }
    let j = Journal::new(Some(f.t.0.join("private").join("j.json"))).read().unwrap();
    assert_eq!(j.state, "interrupted");
}

// ---- killed during quit -----------------------------------------------------------------------------

#[test]
fn killed_at_every_step_of_the_quit_the_sweep_finishes_it_and_nothing_is_ever_lost() {
    // Count the calls of a clean run.
    let clean = {
        let f = fixture();
        f.store.save(session(B, 3), SaveMode::Replace, None, true).unwrap();
        archiver(&f).quit(Duration::from_secs(5));
        let n = *f.core.calls.lock().unwrap();
        n
    };
    assert!(clean >= 4, "working-state + 2 receipts + purge, got {clean}");
    for kill_at in 1..=clean {
        let f = fixture();
        f.store.save(session(B, 3), SaveMode::Replace, None, true).unwrap();
        let originals: Vec<_> = [A, B, C].iter().map(|i| file_bytes(&f, i)).collect();
        *f.core.die_at.lock().unwrap() = Some(kill_at);
        let a = archiver(&f);
        let died = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| a.quit(Duration::from_secs(5))));
        assert!(died.is_err(), "kill_at={kill_at}: the run was cut");
        // Invariants at the instant of death: the journal says the run started and did not finish;
        // the server never lost working state without a receipt; no chat file changed.
        let j = a.journal_doc().expect("journal written before the first server call");
        assert_eq!(j.state, "running", "kill_at={kill_at}");
        {
            let st = f.core.state.lock().unwrap();
            for id in [A, B] {
                if !st.working.contains_key(id) {
                    assert!(st.receipts.contains_key(id), "kill_at={kill_at}: {id} purged without a receipt");
                }
            }
        }
        for (i, id) in [A, B, C].iter().enumerate() {
            assert_eq!(file_bytes(&f, id), originals[i], "kill_at={kill_at}: {id} file changed");
        }
        // Next start: a new process (new Archiver, same directories, same core) sweeps.
        *f.core.die_at.lock().unwrap() = None;
        let report = archiver(&f).sweep(Duration::from_secs(5));
        assert!(report.completed, "kill_at={kill_at}: {report:?}");
        let st = f.core.state.lock().unwrap();
        assert!(!st.working.contains_key(A) && !st.working.contains_key(B), "kill_at={kill_at}: sweep finished the archive");
        assert!(st.working.contains_key(C) && st.working.contains_key(E), "chats that must stay, stayed");
        drop(st);
        assert_eq!(archiver(&f).journal_doc().unwrap().state, "done");
        for (i, id) in [A, B, C].iter().enumerate() {
            assert_eq!(file_bytes(&f, id), originals[i], "kill_at={kill_at}: {id} file changed by the sweep");
        }
    }
}

// ---- sweep: tombstones ---------------------------------------------------------------------------------

#[test]
fn the_sweep_sends_tombstones_removes_resurrected_files_and_keeps_unconfirmed_ones() {
    let f = fixture();
    // D is tombstoned (fixture) and its file came back. Add a second delete the server answers "pending".
    f.store.save(session(B, 1), SaveMode::Replace, None, true).unwrap();
    f.store.delete(B).unwrap();
    f.core.state.lock().unwrap().purge_answer.insert(B.to_string(), "pending".into());
    // a tombstone owed by ANOTHER user must not be sent by us
    let p = f.t.0.join("pending-deletes.json");
    let mut doc: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    doc["deletes"].as_array_mut().unwrap().push(json!({"id": E, "ownerUserId": "someone", "requestedAt": 807_271_200, "attempts": 0}));
    std::fs::write(&p, serde_json::to_vec(&doc).unwrap()).unwrap();

    let report = archiver(&f).sweep(Duration::from_secs(5));
    assert_eq!(report.resurrected_removed, 1, "D's file is removed again");
    assert!(file_bytes(&f, D).is_none());
    assert_eq!(report.tombstones_sent, 1);
    let st = f.core.state.lock().unwrap();
    let sent: Vec<&str> = st.purge_requested.iter().map(|(i, _)| i.as_str()).collect();
    assert_eq!(sent.len(), 2);
    assert!(sent.contains(&D) && sent.contains(&B) && !sent.contains(&E));
    assert!(st.purge_requested.iter().all(|(_, iso)| iso.len() == 20 && iso.ends_with('Z')), "ISO-8601 requestedAt: {:?}", st.purge_requested);
    drop(st);
    let left: Vec<String> = f.store.my_pending_deletes().into_iter().map(|d| d.id).collect();
    assert_eq!(left, vec![B.to_string()], "the unconfirmed tombstone stays for the next start");
    assert_eq!(f.store.my_pending_deletes()[0].attempts, 1);
    // another user's entry is untouched
    let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    assert!(doc["deletes"].as_array().unwrap().iter().any(|d| d["id"] == E));
}

// ---- time helpers ----------------------------------------------------------------------------------------

#[test]
fn server_time_and_iso_round_trip() {
    assert_eq!(parse_server_time("2026-10-31 12:34:56"), Some(1_793_450_096.0));
    assert_eq!(parse_server_time("2026-10-31T12:34:56Z"), Some(1_793_450_096.0));
    assert_eq!(parse_server_time("2026-10-31T12:34:56.789Z"), Some(1_793_450_096.0));
    assert_eq!(parse_server_time("1970-01-01 00:00:00"), Some(0.0));
    for bad in ["", "yesterday", "2026-13-01 00:00:00", "2026-10-31"] {
        assert_eq!(parse_server_time(bad), None, "{bad}");
    }
    assert_eq!(iso_utc(1_793_450_096.0), "2026-10-31T12:34:56Z");
    assert_eq!(iso_utc(0.0), "1970-01-01T00:00:00Z");
    assert_eq!(iso_utc(951_782_400.0), "2000-02-29T00:00:00Z");
    for t in [0.0, 86_399.0, 951_782_400.0, 1_793_450_096.0, 4_102_444_800.0] {
        assert_eq!(parse_server_time(&iso_utc(t)), Some(t));
    }
}

// ---- over real HTTP against a fake core -------------------------------------------------------------------

/// A tiny loopback HTTP server speaking the lifecycle routes. Returns (url, shared state).
pub(crate) fn serve(core: FakeCore, token: &'static str, user: &'static str) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
    std::thread::spawn(move || {
        for conn in l.incoming() {
            let Ok(conn) = conn else { break };
            let core = core.clone();
            std::thread::spawn(move || {
                let mut r = BufReader::new(conn.try_clone().unwrap());
                let mut conn = conn;
                let mut line = String::new();
                if r.read_line(&mut line).is_err() {
                    return;
                }
                let mut parts = line.split_whitespace();
                let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                let (mut len, mut auth) = (0usize, String::new());
                loop {
                    let mut h = String::new();
                    if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    let lower = h.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("authorization:") {
                        auth = h.split_once(':').map_or("", |x| x.1).trim().to_string();
                    }
                }
                let mut body = vec![0u8; len];
                let _ = std::io::Read::read_exact(&mut r, &mut body);
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
                let reply = |status: u16, v: serde_json::Value| {
                    let b = v.to_string();
                    format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len())
                };
                let out = if auth != format!("Bearer {token}") {
                    reply(401, json!({"error": {"code": "UNAUTHORIZED"}}))
                } else {
                    match (method.as_str(), path.as_str()) {
                        ("GET", "/auth/me") => reply(200, json!({"id": user, "email": "x@y", "displayName": "X", "role": "user", "status": "active", "createdAt": "", "lastLoginAt": ""})),
                        ("GET", "/kb/agent/working-state") => {
                            let w = core.working_state(Duration::from_secs(1)).unwrap();
                            reply(200, json!({"sessions": w.iter().map(|c| json!({"chatSessionId": c.chat_session_id, "sdkSession": null, "factCount": 0, "updatedAt": c.updated_at})).collect::<Vec<_>>(), "purges": {"pending": 0, "failed": []}}))
                        }
                        ("POST", "/kb/archive-receipts") => {
                            let ok = body["hash"].as_str().is_some_and(|h| h.len() == 64 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))) && body["count"].as_u64().is_some();
                            if !ok {
                                reply(400, json!({"error": {"code": "VALIDATION_FAILED"}}))
                            } else {
                                core.record_receipt(body["chatSessionId"].as_str().unwrap_or(""), body["hash"].as_str().unwrap(), body["count"].as_u64().unwrap() as usize, Duration::ZERO).unwrap();
                                reply(200, json!({"recorded": true}))
                            }
                        }
                        ("POST", "/agent/v2/sessions/purge") => {
                            let ids: Vec<String> = body["chatSessionIds"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                            if body["verified"] != json!(true) {
                                reply(400, json!({"error": {"code": "VALIDATION_FAILED"}}))
                            } else {
                                match core.purge_working(&ids, Duration::ZERO) {
                                    Ok(r) => reply(200, json!({"purged": r.purged, "busy": r.busy, "staleReceipt": r.stale_receipt})),
                                    Err(_) => reply(409, json!({"error": {"code": "NO_RECEIPT", "message": "no receipt"}})),
                                }
                            }
                        }
                        ("POST", "/kb/session-purges") => {
                            let s = core.session_purge(body["chatSessionId"].as_str().unwrap_or(""), body["requestedAt"].as_str().unwrap_or(""), Duration::ZERO).unwrap();
                            reply(202, json!({"queued": true, "purged": s}))
                        }
                        _ => reply(404, json!({"error": {"code": "NOT_FOUND"}})),
                    }
                };
                let _ = conn.write_all(out.as_bytes());
            });
        }
    });
    url
}

#[test]
fn the_http_remote_speaks_the_lifecycle_wire_format_end_to_end() {
    let f = fixture();
    let url = serve(f.core.clone(), "tok", "u1");
    let remote = HttpRemote::new(&url, "tok").unwrap();
    assert_eq!(remote.me(Duration::from_secs(2)), Ok("u1".to_string()));
    let report = Archiver::new(f.store.clone(), remote, None).quit(Duration::from_secs(5));
    assert!(report.completed, "{report:?}");
    assert_eq!(report.purged, vec![A.to_string()]);
    assert!(!f.core.state.lock().unwrap().working.contains_key(A));
    // wrong token
    assert_eq!(HttpRemote::new(&url, "nope").unwrap().me(Duration::from_secs(2)), Err(RemoteError::Unauthorized));
    // NO_RECEIPT is mapped from the 409
    let r = HttpRemote::new(&url, "tok").unwrap();
    assert_eq!(r.purge_working(&[B.to_string()], Duration::from_secs(2)), Err(RemoteError::NoReceipt));
    // tombstone wire format
    assert_eq!(r.session_purge(B, "2026-10-31T00:00:00Z", Duration::from_secs(2)), Ok("done".to_string()));
}

#[test]
fn the_remote_is_loopback_only_and_never_follows_redirects() {
    for bad in ["https://127.0.0.1:3456", "http://example.com", "http://127.0.0.1.evil.com:3456", "http://user@127.0.0.1:1", "http://evil.com/127.0.0.1", "ftp://127.0.0.1", "127.0.0.1:3456", "http://[::2]:1"] {
        assert!(HttpRemote::new(bad, "tok").is_err(), "{bad}");
    }
    for ok in ["http://127.0.0.1:3456", "http://localhost:3456/", "http://[::1]:3456"] {
        assert!(HttpRemote::new(ok, "tok").is_ok(), "{ok}");
    }
    for bad in ["", "a b", "a\nb", "a\r\nX: y", &"x".repeat(9000)] {
        assert!(HttpRemote::new("http://127.0.0.1:1", bad).is_err());
    }
    // a 302 to another listener is an error and the target is never contacted
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    let tport = target.local_addr().unwrap().port();
    target.set_nonblocking(true).unwrap();
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        if let Ok((mut c, _)) = l.accept() {
            let mut buf = [0u8; 2048];
            let _ = std::io::Read::read(&mut c, &mut buf);
            let _ = c.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{tport}/auth/me\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
        }
    });
    let r = HttpRemote::new(&format!("http://127.0.0.1:{port}"), "tok").unwrap();
    assert!(r.me(Duration::from_secs(2)).is_err());
    std::thread::sleep(Duration::from_millis(100));
    assert!(target.accept().is_err(), "the redirect target was contacted");
}
