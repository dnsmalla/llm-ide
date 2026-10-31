use super::*;
use crate::fsutil::Os;
use serde_json::json;
use std::sync::atomic::{AtomicU32, Ordering};

pub(crate) struct Tmp(pub PathBuf);

impl Tmp {
    pub fn new(tag: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!("llmide-chat-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn layout(t: &Tmp) -> StoreLayout {
    StoreLayout { base: t.0.clone(), sessions: t.0.join("sessions"), shared_with_mac: false }
}

pub(crate) fn store(t: &Tmp, user: &str) -> ChatStore {
    ChatStore::open(layout(t), user, Some(t.0.join("private").join("index.json"))).unwrap()
}

const ID1: &str = "AAAAAAAA-0000-4000-8000-000000000001";
const CORRUPT_BODY: &[u8] = b"{\"storeVersion\":2,\"id\":\"AAAA-SECRET\", truncated";
const ID2: &str = "AAAAAAAA-0000-4000-8000-000000000002";

pub(crate) fn session(id: &str, n: usize) -> Value {
    json!({
        "storeVersion": 2, "id": id, "scope": "quick", "title": "T", "createdAt": 807271200.0, "lastUsedAt": 807271260.0,
        "messages": (0..n).map(|i| json!({"role": if i % 2 == 0 {"user"} else {"assistant"}, "content": format!("m{i}"), "status": "done", "toolSteps": [], "createdAt": 807271200.0})).collect::<Vec<_>>(),
    })
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/chat-session").join(name)).unwrap()
}

fn put(t: &Tmp, id: &str, body: &[u8]) {
    std::fs::create_dir_all(t.0.join("sessions")).unwrap();
    std::fs::write(t.0.join("sessions").join(format!("{id}.json")), body).unwrap();
}

fn q(limit: usize) -> ListQuery {
    ListQuery { offset: 0, limit, scope: None, project_id: None }
}

// ---- ids, traversal ------------------------------------------------------------------------

#[test]
fn only_uuids_are_chat_ids_and_traversal_is_refused() {
    assert_eq!(canonical_chat_id("aaaaaaaa-0000-4000-8000-000000000001").as_deref(), Some(ID1));
    for bad in [
        "", "..", "../../etc/passwd", "..\\..\\x", "AAAAAAAA-0000-4000-8000-00000000000", "AAAAAAAA-0000-4000-8000-0000000000011", "AAAAAAAA_0000_4000_8000_000000000001",
        "AAAAAAAA-0000-4000-8000-00000000000g", "AAAAAAAA-0000-4000-8000-000000000001/../x", "AAAAAAAA-0000-4000-8000-000000000001\0", "/AAAAAAAA-0000-4000-8000-00000000000",
        "AAAAAAAA-0000-4000-8000-000000000001.json", "con", "ＡＡＡＡＡＡＡＡ-0000-4000-8000-000000000001",
    ] {
        assert!(canonical_chat_id(bad).is_none(), "{bad:?}");
    }
    for ok in ["u1", "A.b_c-9", "9f1c2d3e-0000-4000-8000-000000000001"] {
        assert!(valid_user_id(ok), "{ok}");
    }
    for bad in ["", ".", "..", ".hidden", "a/b", "a\\b", "a b", "a\0b", "../x", "ü", &"x".repeat(129)] {
        assert!(!valid_user_id(bad), "{bad:?}");
    }
}

#[test]
fn every_entry_point_refuses_a_path_shaped_id() {
    let t = Tmp::new("trav");
    let s = store(&t, "u1");
    std::fs::write(t.0.join("secret.json"), b"{}").unwrap();
    for bad in ["../secret", "..\\secret", "../../etc/passwd", "AAAAAAAA-0000-4000-8000-000000000001/../../secret"] {
        assert_eq!(s.load(bad, None, 10).unwrap_err().code, "invalid_id");
        assert_eq!(s.delete(bad).unwrap_err().code, "invalid_id");
        assert_eq!(s.archive_facts(bad).unwrap_err().code, "invalid_id");
        let mut sess = session(ID1, 1);
        sess["id"] = json!(bad);
        assert_eq!(s.save(sess, SaveMode::Replace, None, true).unwrap_err().code, "invalid_id");
    }
    assert!(t.0.join("secret.json").exists());
    assert_eq!(ChatStore::open(layout(&t), "../x", None).err().unwrap().code, "invalid_user");
}

// ---- layout ----------------------------------------------------------------------------------

#[test]
fn layout_per_os() {
    let env = |k: &str| match k {
        "HOME" => Some("/Users/me".to_string()),
        "LOCALAPPDATA" => Some("/win/Local".to_string()),
        _ => None,
    };
    let none = |_: &Path| false;
    let mac = layout_for(Os::Mac, &env, "u1", &none).unwrap();
    assert_eq!(mac.sessions, PathBuf::from("/Users/me/Library/Application Support/llm-ide/sessions"));
    assert!(mac.shared_with_mac);
    // Only the legacy folder exists: use it in place (the Mac app migrates it later, never us).
    let legacy_only = |p: &Path| p.ends_with("LLM IDE");
    assert_eq!(layout_for(Os::Mac, &env, "u1", &legacy_only).unwrap().base, PathBuf::from("/Users/me/Library/Application Support/LLM IDE"));
    let both = |_: &Path| true;
    assert_eq!(layout_for(Os::Mac, &env, "u1", &both).unwrap().base, PathBuf::from("/Users/me/Library/Application Support/llm-ide"));
    let lin = layout_for(Os::Linux, &env, "u1", &none).unwrap();
    assert_eq!(lin.sessions, PathBuf::from("/Users/me/.local/share/llm-ide-desktop/chats/u1/sessions"));
    assert!(!lin.shared_with_mac);
    let win = layout_for(Os::Windows, &env, "u1", &none).unwrap();
    assert!(win.base.ends_with("llm-ide-desktop/chats/u1") || win.base.ends_with("llm-ide-desktop\\chats\\u1"));
    let over = |k: &str| (k == "LLMIDE_CHAT_STORE_DIR").then(|| "/tmp/x".to_string());
    assert_eq!(layout_for(Os::Mac, &over, "u1", &none).unwrap().sessions, PathBuf::from("/tmp/x/sessions"));
    let rel = |k: &str| (k == "LLMIDE_CHAT_STORE_DIR").then(|| "rel".to_string());
    assert!(layout_for(Os::Mac, &rel, "u1", &none).is_err());
    assert!(layout_for(Os::Linux, &env, "../u", &none).is_err());
}

// ---- the Mac format (Swift-produced fixtures) --------------------------------------------------

#[test]
fn swift_written_files_list_load_and_round_trip_without_loss() {
    let t = Tmp::new("swift");
    put(&t, ID1, &fixture("session-v2-engine-project.json"));
    put(&t, ID2, &fixture("session-v2-no-engine-no-project.json"));
    let s = store(&t, "u1");
    let page = s.list(&q(50)).unwrap();
    assert_eq!(page.total, 2);
    let a = page.items.iter().find(|c| c.id == ID1).unwrap();
    assert_eq!((a.title.as_str(), a.scope.as_deref(), a.engine.as_deref(), a.project_id.as_deref(), a.message_count), ("Search latency", Some("quick"), Some("agentV2"), Some("proj-a"), 2));
    let b = page.items.iter().find(|c| c.id == ID2).unwrap();
    assert_eq!((b.scope.as_deref(), b.engine.as_deref(), b.project_id.as_deref()), (Some("explorer"), None, None));
    assert_eq!(a.created_at, 807_271_200.0);
    assert_eq!(page.items[0].id, ID1, "newest lastUsedAt first (tie broken by id)");

    let loaded = s.load("aaaaaaaa-0000-4000-8000-000000000001", None, 100).unwrap();
    assert_eq!(loaded.total, 2);
    assert_eq!(loaded.start, 0);
    let original: Value = serde_json::from_slice(&fixture("session-v2-engine-project.json")).unwrap();
    assert_eq!(loaded.session["messages"], original["messages"], "messages come back verbatim");

    // Save it back with the revision: every original key survives, messages are byte-for-byte the same values.
    let out = s.save(loaded.session.clone(), SaveMode::Replace, Some(&loaded.revision), false).unwrap();
    assert_eq!(out.message_count, 2);
    let back: Value = serde_json::from_slice(&std::fs::read(t.0.join("sessions").join(format!("{ID1}.json"))).unwrap()).unwrap();
    for k in ["storeVersion", "id", "scope", "title", "createdAt", "lastUsedAt", "messages", "engine", "projectId"] {
        assert_eq!(back[k], original[k], "{k}");
    }
    assert_eq!(back["ownerUserId"], "u1", "the writer stamps its owner");
}

#[test]
fn a_file_written_here_has_exactly_the_keys_the_swift_decoder_reads() {
    let t = Tmp::new("shape");
    let s = store(&t, "u1");
    s.save(session(ID1, 3), SaveMode::Replace, None, true).unwrap();
    let v: Value = serde_json::from_slice(&std::fs::read(t.0.join("sessions").join(format!("{ID1}.json"))).unwrap()).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["createdAt", "id", "lastUsedAt", "messages", "ownerUserId", "scope", "storeVersion", "title"]);
    assert_eq!(v["storeVersion"], 2);
    assert!(v["createdAt"].is_f64() && v["lastUsedAt"].is_f64());
    assert_eq!(v["id"], ID1);
    assert!(v["lastUsedAt"].as_f64().unwrap() > 8.0e8, "reference-date seconds, not unix");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let m = std::fs::metadata(t.0.join("sessions").join(format!("{ID1}.json"))).unwrap();
        assert_eq!(m.permissions().mode() & 0o777, 0o600);
    }
}

// ---- save rules ------------------------------------------------------------------------------

#[test]
fn overwrite_needs_the_current_revision() {
    let t = Tmp::new("rev");
    let s = store(&t, "u1");
    let first = s.save(session(ID1, 2), SaveMode::Replace, None, true).unwrap();
    assert_eq!(s.save(session(ID1, 2), SaveMode::Replace, None, true).unwrap_err().code, "conflict", "exists, no revision");
    assert_eq!(s.save(session(ID1, 2), SaveMode::Replace, Some("bogus"), true).unwrap_err().code, "conflict");
    let second = s.save(session(ID1, 4), SaveMode::Replace, Some(&first.revision), true).unwrap();
    assert_ne!(first.revision, second.revision);
    assert_eq!(s.save(session(ID1, 5), SaveMode::Replace, Some(&first.revision), true).unwrap_err().code, "conflict", "stale revision");
    assert_eq!(s.save(session(ID2, 1), SaveMode::Replace, Some("x"), true).unwrap_err().code, "conflict", "revision for a chat that is gone");
    // The other app (Mac) rewriting the file in between is a conflict, not a silent overwrite.
    std::thread::sleep(Duration::from_millis(5));
    std::fs::write(t.0.join("sessions").join(format!("{ID1}.json")), serde_json::to_vec(&session(ID1, 9)).unwrap()).unwrap();
    assert_eq!(s.save(session(ID1, 6), SaveMode::Replace, Some(&second.revision), true).unwrap_err().code, "conflict");
}

#[test]
fn validation_rejects_bad_sessions_without_echoing_content() {
    let t = Tmp::new("val");
    let s = store(&t, "u1");
    let secret = "TOP-SECRET-CONTENT";
    let mut bad_role = session(ID1, 1);
    bad_role["messages"][0]["role"] = json!(secret);
    let mut bad_scope = session(ID1, 1);
    bad_scope["scope"] = json!(secret);
    let mut bad_time = session(ID1, 1);
    bad_time["createdAt"] = json!(secret);
    let mut not_array = session(ID1, 1);
    not_array["messages"] = json!({ "x": secret });
    let mut bad_opt = session(ID1, 1);
    bad_opt["projectId"] = json!(5);
    let mut long_title = session(ID1, 1);
    long_title["title"] = json!("x".repeat(5000));
    for (label, sess) in [("role", bad_role), ("scope", bad_scope), ("time", bad_time), ("array", not_array), ("opt", bad_opt), ("title", long_title)] {
        let e = s.save(sess, SaveMode::Replace, None, true).unwrap_err();
        assert!(!e.message.contains(secret) && !format!("{e}").contains(secret), "{label}: {e}");
        assert_eq!(e.code, "invalid", "{label}");
    }
    assert_eq!(s.save(json!([1]), SaveMode::Replace, None, true).unwrap_err().code, "invalid");
    assert!(!t.0.join("sessions").join(format!("{ID1}.json")).exists());
}

#[test]
fn append_checks_the_count_and_keeps_the_header() {
    let t = Tmp::new("app");
    let s = store(&t, "u1");
    let mut base = session(ID1, 2);
    base["engine"] = json!("agentV2");
    let r1 = s.save(base, SaveMode::Replace, None, true).unwrap();
    let mut add = session(ID1, 0);
    add["messages"] = json!([{"role": "user", "content": "more"}]);
    add["title"] = json!("renamed");
    assert_eq!(s.save(add.clone(), SaveMode::Append { expected_count: 5 }, Some(&r1.revision), true).unwrap_err().code, "conflict");
    let r2 = s.save(add, SaveMode::Append { expected_count: 2 }, Some(&r1.revision), true).unwrap();
    assert_eq!(r2.message_count, 3);
    let l = s.load(ID1, None, 10).unwrap();
    assert_eq!(l.session["title"], "renamed");
    assert_eq!(l.session["engine"], "agentV2", "unmentioned header keys are kept");
    assert_eq!(l.session["messages"][2]["content"], "more");
    let mut ghost = session(ID2, 0);
    ghost["messages"] = json!([{"role": "user", "content": "x"}]);
    assert_eq!(s.save(ghost, SaveMode::Append { expected_count: 0 }, None, true).unwrap_err().code, "conflict");
}

#[test]
fn another_users_chat_is_invisible_and_never_overwritten() {
    let t = Tmp::new("own");
    let alice = store(&t, "alice");
    let bob = store(&t, "bob");
    alice.save(session(ID1, 2), SaveMode::Replace, None, true).unwrap();
    // an unowned (older) file is visible to both, as on the Mac
    put(&t, ID2, &fixture("session-v2-no-engine-no-project.json"));
    assert!(bob.list(&q(10)).unwrap().items.iter().all(|c| c.id != ID1));
    assert!(alice.list(&q(10)).unwrap().items.iter().any(|c| c.id == ID1));
    assert_eq!(bob.list(&q(10)).unwrap().total, 1);
    assert_eq!(bob.load(ID1, None, 10).unwrap_err().code, "not_found");
    assert_eq!(bob.delete(ID1).unwrap_err().code, "not_found");
    let rev = alice.load(ID1, None, 1).unwrap().revision;
    assert_eq!(bob.save(session(ID1, 1), SaveMode::Replace, Some(&rev), true).unwrap_err().code, "foreign_owner");
    let mut forged = session(ID1, 1);
    forged["ownerUserId"] = json!("alice");
    assert_eq!(bob.save(forged, SaveMode::Replace, None, true).unwrap_err().code, "conflict");
    let mut forged2 = session(ID2, 1);
    forged2["ownerUserId"] = json!("alice");
    assert_eq!(bob.save(forged2, SaveMode::Replace, Some("x"), true).unwrap_err().code, "conflict");
    let mut forged3 = session("AAAAAAAA-0000-4000-8000-000000000003", 1);
    forged3["ownerUserId"] = json!("alice");
    assert_eq!(bob.save(forged3, SaveMode::Replace, None, true).unwrap_err().code, "foreign_owner", "a webview cannot claim another owner");
    assert_eq!(alice.load(ID1, None, 10).unwrap().total, 2, "untouched");
    assert_eq!(bob.archive_facts(ID1).unwrap().owned_by_user, false);
}

// ---- paging ------------------------------------------------------------------------------------

#[test]
fn load_pages_from_the_tail_and_walks_back() {
    let t = Tmp::new("page");
    let s = store(&t, "u1");
    s.save(session(ID1, 25), SaveMode::Replace, None, true).unwrap();
    let tail = s.load(ID1, None, 10).unwrap();
    assert_eq!((tail.total, tail.start, tail.session["messages"].as_array().unwrap().len()), (25, 15, 10));
    assert_eq!(tail.session["messages"][9]["content"], "m24");
    let older = s.load(ID1, Some(tail.start), 10).unwrap();
    assert_eq!((older.start, older.session["messages"][0]["content"].clone()), (5, json!("m5")));
    let oldest = s.load(ID1, Some(older.start), 10).unwrap();
    assert_eq!((oldest.start, oldest.session["messages"].as_array().unwrap().len()), (0, 5));
    let none = s.load(ID1, Some(0), 10).unwrap();
    assert_eq!((none.start, none.session["messages"].as_array().unwrap().len()), (0, 0));
    let all = s.load(ID1, Some(999), 500).unwrap();
    assert_eq!(all.session["messages"].as_array().unwrap().len(), 25);
    assert_eq!(s.load(ID1, None, 0).unwrap().session["messages"].as_array().unwrap().len(), 1, "limit is clamped to at least 1");
}

#[test]
fn a_huge_chat_loads_a_tail_without_materialising_the_file() {
    let t = Tmp::new("huge");
    let s = store(&t, "u1");
    let blob = "x".repeat(4096);
    let mut sess = session(ID1, 0);
    sess["messages"] = Value::Array((0..5000).map(|i| json!({"role": if i % 2 == 0 {"user"} else {"assistant"}, "content": format!("{i}:{blob}")})).collect());
    s.save(sess, SaveMode::Replace, None, true).unwrap();
    let size = std::fs::metadata(t.0.join("sessions").join(format!("{ID1}.json"))).unwrap().len();
    assert!(size > 20_000_000, "{size}");
    let t0 = Instant::now();
    let l = s.load(ID1, None, 20).unwrap();
    assert_eq!((l.total, l.start, l.session["messages"].as_array().unwrap().len()), (5000, 4980, 20));
    assert!(l.session["messages"][19]["content"].as_str().unwrap().starts_with("4999:"));
    assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
    let page = s.list(&q(5)).unwrap();
    assert_eq!((page.items[0].message_count, page.items[0].size_bytes), (5000, size));
}

#[test]
fn oversized_files_are_refused_not_parsed_or_deleted() {
    let t = Tmp::new("big");
    let s = store(&t, "u1");
    std::fs::create_dir_all(t.0.join("sessions")).unwrap();
    let p = t.0.join("sessions").join(format!("{ID1}.json"));
    let f = File::create(&p).unwrap();
    f.set_len(MAX_READ_BYTES + 1).unwrap(); // sparse
    drop(f);
    assert_eq!(s.load(ID1, None, 10).unwrap_err().code, "too_large");
    let page = s.list(&q(10)).unwrap();
    assert_eq!((page.total, page.unsupported, page.quarantined), (0, 1, 0));
    assert!(p.exists(), "never deleted or quarantined");
    // writes over the cap are refused
    let mut sess = session(ID2, 0);
    sess["messages"] = json!([{"role": "user", "content": "y".repeat(MAX_WRITE_BYTES + 1)}]);
    assert_eq!(s.save(sess, SaveMode::Replace, None, true).unwrap_err().code, "too_large");
    assert!(!t.0.join("sessions").join(format!("{ID2}.json")).exists());
    let mut many = session(ID2, 0);
    many["messages"] = Value::Array((0..=MAX_MESSAGES).map(|_| json!({"role": "user"})).collect());
    assert_eq!(s.save(many, SaveMode::Replace, None, true).unwrap_err().code, "too_large");
}

#[test]
fn ten_thousand_chats_list_fast_after_the_first_scan() {
    let t = Tmp::new("10k");
    let s = store(&t, "u1");
    std::fs::create_dir_all(t.0.join("sessions")).unwrap();
    for i in 0..10_000u32 {
        let id = format!("AAAAAAAA-0000-4000-8000-{i:012}");
        let mut sess = session(&id, 2);
        sess["lastUsedAt"] = json!(807_271_200.0 + f64::from(i));
        sess["title"] = json!(format!("chat {i}"));
        std::fs::write(t.0.join("sessions").join(format!("{id}.json")), serde_json::to_vec(&sess).unwrap()).unwrap();
    }
    let t0 = Instant::now();
    let p = s.list(&q(50)).unwrap();
    let first = t0.elapsed();
    assert_eq!((p.total, p.items.len(), p.has_more), (10_000, 50, true));
    assert_eq!(p.items[0].title, "chat 9999");
    assert_eq!(p.items[49].title, "chat 9950");
    let t1 = Instant::now();
    let p2 = s.list(&ListQuery { offset: 9_990, limit: 50, scope: None, project_id: None }).unwrap();
    let second = t1.elapsed();
    assert_eq!((p2.items.len(), p2.has_more), (10, false));
    assert_eq!(p2.items[9].title, "chat 0");
    // a fresh store with the persisted index re-parses nothing and is just as fast
    let s2 = store(&t, "u1");
    let t2 = Instant::now();
    assert_eq!(s2.list(&q(1)).unwrap().total, 10_000);
    let third = t2.elapsed();
    eprintln!("10k chats: first scan {first:?}, cached {second:?}, persisted index {third:?}");
    assert!(second < Duration::from_secs(2), "{second:?}");
    assert!(third < Duration::from_secs(3), "{third:?}");
    assert!(t.0.join("private").join("index.json").exists());
    // filters
    let none = s.list(&ListQuery { offset: 0, limit: 10, scope: Some("explorer".into()), project_id: None }).unwrap();
    assert_eq!(none.total, 0);
}

// ---- corruption --------------------------------------------------------------------------------

#[test]
fn a_corrupt_file_is_quarantined_never_deleted() {
    let t = Tmp::new("corrupt");
    let s = store(&t, "u1");
    put(&t, ID1, CORRUPT_BODY);
    put(&t, ID2, &fixture("session-v2-no-engine-no-project.json"));
    let page = s.list(&q(10)).unwrap();
    assert_eq!((page.total, page.quarantined), (1, 1));
    assert!(!t.0.join("sessions").join(format!("{ID1}.json")).exists());
    let kept: Vec<_> = std::fs::read_dir(t.0.join("sessions")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".corrupt-")).collect();
    assert_eq!(kept.len(), 1);
    assert!(kept[0].starts_with(ID1));
    assert_eq!(std::fs::read(t.0.join("sessions").join(&kept[0])).unwrap(), CORRUPT_BODY, "content kept byte for byte");
    assert_eq!(s.quarantined_count(), 1);
    // second list: still one, nothing re-quarantined, the quarantined file is not a chat
    let again = s.list(&q(10)).unwrap();
    assert_eq!((again.total, again.quarantined), (1, 0));
}

#[test]
fn load_of_a_corrupt_file_quarantines_it_and_leaks_nothing() {
    let t = Tmp::new("corrupt2");
    let s = store(&t, "u1");
    put(&t, ID1, b"{\"id\": \"SUPER-SECRET-TEXT\" garbage");
    let e = s.load(ID1, None, 5).unwrap_err();
    assert_eq!(e.code, "corrupt");
    assert!(!e.message.contains("SECRET") && !format!("{e:?}").contains("SECRET"));
    assert_eq!(s.quarantined_count(), 1);
    // a file whose internal id disagrees with its name is corrupt too
    let mut wrong = session(ID2, 1);
    wrong["ownerUserId"] = json!("u1");
    put(&t, ID1, &serde_json::to_vec(&wrong).unwrap());
    assert_eq!(s.load(ID1, None, 5).unwrap_err().code, "corrupt");
    assert_eq!(s.quarantined_count(), 2);
}

#[test]
fn files_this_build_does_not_understand_are_left_alone() {
    let t = Tmp::new("unsup");
    let s = store(&t, "u1");
    let mut newer = session(ID1, 1);
    newer["storeVersion"] = json!(3);
    put(&t, ID1, &serde_json::to_vec(&newer).unwrap());
    // v1: `history` instead of `messages`
    put(&t, ID2, br#"{"id":"AAAAAAAA-0000-4000-8000-000000000002","scope":"quick","title":"old","createdAt":1,"lastUsedAt":2,"history":[{"role":"user","content":"x"}]}"#);
    let page = s.list(&q(10)).unwrap();
    assert_eq!((page.total, page.unsupported, page.quarantined), (0, 2, 0));
    assert!(t.0.join("sessions").join(format!("{ID1}.json")).exists() && t.0.join("sessions").join(format!("{ID2}.json")).exists());
    // non-chat names are ignored entirely: legacy scope files, temp files, lower-case twins, symlinks
    put(&t, "quick", b"{}");
    std::fs::write(t.0.join("sessions").join(".x.tmp"), b"{").unwrap();
    assert_eq!(s.list(&q(10)).unwrap().quarantined, 0);
    #[cfg(unix)]
    {
        let target = t.0.join("outside.json");
        std::fs::write(&target, serde_json::to_vec(&session("AAAAAAAA-0000-4000-8000-000000000009", 1)).unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, t.0.join("sessions").join("AAAAAAAA-0000-4000-8000-000000000009.json")).unwrap();
        assert_eq!(s.list(&q(10)).unwrap().total, 0, "a symlinked chat is not followed");
    }
}

// ---- tombstones ---------------------------------------------------------------------------------

#[test]
fn delete_writes_a_mac_format_tombstone_and_wins_both_ways() {
    let t = Tmp::new("tomb");
    let s = store(&t, "u1");
    s.save(session(ID1, 2), SaveMode::Replace, None, true).unwrap();
    s.save(session(ID2, 2), SaveMode::Replace, None, true).unwrap();
    // a pending file the Mac wrote earlier, with a key we do not model, must survive our update
    std::fs::write(t.0.join(PENDING_FILE), br#"{"deletes":[],"orphans":{"X":1.5},"futureKey":7}"#).unwrap();
    assert!(s.delete(ID1).unwrap());
    assert!(!s.delete(ID1).unwrap(), "idempotent");
    let doc: Value = serde_json::from_slice(&std::fs::read(t.0.join(PENDING_FILE)).unwrap()).unwrap();
    assert_eq!(doc["deletes"].as_array().unwrap().len(), 1);
    let e = &doc["deletes"][0];
    assert_eq!((e["id"].as_str(), e["ownerUserId"].as_str(), e["attempts"].as_i64()), (Some(ID1), Some("u1"), Some(0)));
    assert!(e["requestedAt"].as_f64().unwrap() > 8.0e8 && e["requestedAt"].as_f64().unwrap() < 2.0e9, "reference-date seconds: {e}");
    assert_eq!((doc["orphans"]["X"].as_f64(), doc["futureKey"].as_i64()), (Some(1.5), Some(7)));
    assert!(!t.0.join("sessions").join(format!("{ID1}.json")).exists());
    // hidden, unreadable, unsavable
    assert_eq!(s.list(&q(10)).unwrap().total, 1);
    assert_eq!(s.load(ID1, None, 5).unwrap_err().code, "deleted");
    assert_eq!(s.save(session(ID1, 1), SaveMode::Replace, None, true).unwrap_err().code, "deleted");
    // the OTHER app resurrects the file with a late write: still hidden, and the sweep removes it
    put(&t, ID1, &serde_json::to_vec(&session(ID1, 3)).unwrap());
    assert_eq!(s.list(&q(10)).unwrap().total, 1);
    assert_eq!(s.enforce_tombstones().unwrap(), 1);
    assert!(!t.0.join("sessions").join(format!("{ID1}.json")).exists());
    // a tombstone the Mac wrote (another entry, any owner) hides that chat from us too
    let mut d2: Value = serde_json::from_slice(&std::fs::read(t.0.join(PENDING_FILE)).unwrap()).unwrap();
    d2["deletes"].as_array_mut().unwrap().push(json!({"id": ID2, "ownerUserId": "u1", "requestedAt": 807_271_200, "attempts": 3}));
    std::fs::write(t.0.join(PENDING_FILE), serde_json::to_vec(&d2).unwrap()).unwrap();
    assert_eq!(s.list(&q(10)).unwrap().total, 0);
    assert_eq!(s.my_pending_deletes().len(), 2);
    s.remove_tombstone(ID2).unwrap();
    assert_eq!(s.my_pending_deletes().len(), 1);
    s.bump_tombstone_attempt(ID1).unwrap();
    assert_eq!(s.my_pending_deletes()[0].attempts, 1);
}

// ---- hash / archive facts -----------------------------------------------------------------------

#[test]
fn archive_facts_hash_matches_the_servers_archive_hash() {
    let t = Tmp::new("facts");
    let s = store(&t, "u1");
    let mut sess = session(ID1, 0);
    sess["messages"] = json!([
        {"role": "user", "content": "What did we decide?"},
        {"role": "assistant", "content": "Ship on Friday. 日本語 ✓"},
        {"role": "toolResult", "content": ""},   // the Mac sends a tool result as a user turn
        {"role": "system", "content": "dropped by the Mac decoder, so not hashed"},
    ]);
    // `system` is invalid for a save; write the raw file the way a newer build might have
    let mut raw = sess.clone();
    raw["ownerUserId"] = json!("u1");
    put(&t, ID1, &serde_json::to_vec(&raw).unwrap());
    let f = s.archive_facts(ID1).unwrap();
    // value from extension/kb/chat-lifecycle.mjs archiveHash([user, assistant, user ""])
    assert_eq!(f.hash.as_deref(), Some("e7d414b8992f996c1eced98fb56bbe738e3e99aaf0fa1078991f317070651b2a"));
    assert_eq!((f.exists, f.decoded, f.owned_by_user, f.message_count), (true, true, true, 3));
    assert_eq!(f.last_apple(), Some(807_271_260.0));
    let missing = s.archive_facts(ID2).unwrap();
    assert!(!missing.exists);
    put(&t, ID2, b"nope");
    let bad = s.archive_facts(ID2).unwrap();
    assert!(bad.exists && !bad.decoded);
    assert!(t.0.join("sessions").join(format!("{ID2}.json")).exists(), "facts never quarantine or delete");
}

impl ArchiveFacts {
    fn last_apple(&self) -> Option<f64> {
        self.last_used_apple
    }
}

// ---- locking ------------------------------------------------------------------------------------

#[test]
fn the_lock_is_released_on_drop_and_never_removes_a_foreign_lock() {
    let t = Tmp::new("lock");
    let g = acquire_lock(&t.0, Duration::from_secs(30)).unwrap();
    assert!(t.0.join(LOCK_FILE).exists());
    drop(g);
    assert!(!t.0.join(LOCK_FILE).exists());
    // a guard whose file was replaced by someone else's lock leaves it alone
    let g = acquire_lock(&t.0, Duration::from_secs(30)).unwrap();
    std::fs::write(t.0.join(LOCK_FILE), serde_json::to_vec(&LockOwner { pid: 1, start: 1, nonce: "other".into() }).unwrap()).unwrap();
    drop(g);
    assert!(t.0.join(LOCK_FILE).exists());
}

#[test]
fn a_dead_owners_lock_is_recovered() {
    let t = Tmp::new("stale");
    let path = t.0.join(LOCK_FILE);
    let me = my_identity();
    // pid that does not exist
    std::fs::write(&path, serde_json::to_vec(&LockOwner { pid: 4_000_000_000, start: 5, nonce: "dead".into() }).unwrap()).unwrap();
    acquire_file_lock(&path, &me, Duration::from_millis(500)).unwrap();
    std::fs::remove_file(&path).unwrap();
    // our own identity left behind by a panic while holding the guard
    std::fs::write(&path, serde_json::to_vec(&me).unwrap()).unwrap();
    acquire_file_lock(&path, &my_identity_with(&me), Duration::from_millis(500)).unwrap();
    std::fs::remove_file(&path).unwrap();
    // a half-written lock is given a grace period (not stolen at once) ...
    std::fs::write(&path, b"{\"pid\":").unwrap();
    assert_eq!(acquire_file_lock(&path, &me, Duration::from_millis(150)).unwrap_err().code, "lock_busy");
    // ... but an old one is recovered
    let old = SystemTime::now() - Duration::from_secs(60);
    File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
    acquire_file_lock(&path, &me, Duration::from_millis(500)).unwrap();
}

fn my_identity_with(me: &LockOwner) -> LockOwner {
    LockOwner { pid: me.pid, start: me.start, nonce: "second".into() }
}

#[cfg(unix)]
#[test]
fn a_live_owner_blocks_and_a_recycled_pid_does_not() {
    let t = Tmp::new("live");
    let path = t.0.join(LOCK_FILE);
    let me = my_identity();
    let mut child = std::process::Command::new("sleep").arg("2").spawn().unwrap();
    let started = match proc_start_time(child.id()) {
        ProcInfo::Started(s) => s,
        ProcInfo::Unknown => 0,
        ProcInfo::Gone => panic!("child must be alive"),
    };
    std::fs::write(&path, serde_json::to_vec(&LockOwner { pid: child.id(), start: started, nonce: "child".into() }).unwrap()).unwrap();
    let t0 = Instant::now();
    assert_eq!(acquire_file_lock(&path, &me, Duration::from_millis(300)).unwrap_err().code, "lock_busy");
    assert!(t0.elapsed() >= Duration::from_millis(250));
    if started != 0 {
        // same pid, different start time: the pid was recycled, the lock is stale
        std::fs::write(&path, serde_json::to_vec(&LockOwner { pid: child.id(), start: started + 12345, nonce: "recycled".into() }).unwrap()).unwrap();
        acquire_file_lock(&path, &me, Duration::from_millis(500)).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, serde_json::to_vec(&LockOwner { pid: child.id(), start: started, nonce: "child".into() }).unwrap()).unwrap();
    }
    // the owner exits: its lock is recovered
    child.wait().unwrap();
    acquire_file_lock(&path, &me, Duration::from_secs(3)).unwrap();
}

#[test]
fn concurrent_writers_never_lose_or_corrupt_a_chat() {
    let t = Tmp::new("conc");
    let first = store(&t, "u1");
    first.save(session(ID1, 0), SaveMode::Replace, None, true).unwrap();
    let base = t.0.clone();
    let done = Arc::new(AtomicU32::new(0));
    let threads: Vec<_> = (0..8u32)
        .map(|w| {
            let base = base.clone();
            let done = Arc::clone(&done);
            std::thread::spawn(move || {
                let s = ChatStore::open(StoreLayout { base: base.clone(), sessions: base.join("sessions"), shared_with_mac: false }, "u1", None).unwrap();
                for i in 0..12u32 {
                    loop {
                        let cur = s.load(ID1, None, 1).unwrap();
                        let mut add = session(ID1, 0);
                        add["messages"] = json!([{"role": "user", "content": format!("w{w}-{i}")}]);
                        match s.save(add, SaveMode::Append { expected_count: cur.total }, Some(&cur.revision), true) {
                            Ok(_) => break,
                            Err(e) if e.code == "conflict" || e.code == "lock_busy" => continue,
                            Err(e) => panic!("{e}"),
                        }
                    }
                    done.fetch_add(1, Ordering::SeqCst);
                }
            })
        })
        .collect();
    for th in threads {
        th.join().unwrap();
    }
    assert_eq!(done.load(Ordering::SeqCst), 96);
    let l = first.load(ID1, None, 500).unwrap();
    assert_eq!(l.total, 96);
    let mut seen: Vec<String> = l.session["messages"].as_array().unwrap().iter().map(|m| m["content"].as_str().unwrap().to_string()).collect();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 96, "every append landed exactly once");
    let stray: Vec<_> = std::fs::read_dir(t.0.join("sessions")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
    assert!(stray.is_empty(), "no temp files left behind");
    assert!(!t.0.join(LOCK_FILE).exists());
}

#[test]
fn atomic_write_replaces_whole_or_not_at_all() {
    let t = Tmp::new("atomic");
    let target = t.0.join("x.json");
    write_atomic(&target, b"first").unwrap();
    write_atomic(&target, b"second-longer").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"second-longer");
    // a target that cannot be replaced leaves the old content and no temp file
    let dir_target = t.0.join("dir.json");
    std::fs::create_dir(&dir_target).unwrap();
    assert!(write_atomic(&dir_target, b"x").is_err());
    let tmps = std::fs::read_dir(&t.0).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count();
    assert_eq!(tmps, 0);
}


// ---- delete keeps a recoverable copy ------------------------------------------------------------

#[test]
fn delete_moves_the_file_to_a_recoverable_folder_instead_of_removing_it() {
    let t = Tmp::new("trash");
    let s = store(&t, "alice");
    s.save(session(ID1, 3), SaveMode::Replace, None, true).unwrap();
    let original = std::fs::read(t.0.join("sessions").join(format!("{ID1}.json"))).unwrap();
    assert!(s.delete(ID1).unwrap());
    assert!(!t.0.join("sessions").join(format!("{ID1}.json")).exists());
    let kept = s.trashed();
    assert_eq!(kept.len(), 1, "one recoverable copy");
    assert_eq!(kept[0].0, ID1);
    assert_eq!(std::fs::read(&kept[0].2).unwrap(), original, "byte-identical copy");
    assert!(kept[0].2.starts_with(t.0.join("sessions").join(".deleted")));
    // The recoverable folder is not a chat and does not show up in the listing.
    assert_eq!(s.list(&q(10)).unwrap().total, 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let m = std::fs::metadata(t.0.join("sessions").join(".deleted")).unwrap().permissions().mode();
        assert_eq!(m & 0o077, 0, "private folder");
    }
}

#[test]
fn a_resurrected_file_is_trashed_not_removed_by_the_sweep() {
    let t = Tmp::new("trash-resurrect");
    let s = store(&t, "alice");
    s.save(session(ID1, 2), SaveMode::Replace, None, true).unwrap();
    s.delete(ID1).unwrap();
    put(&t, ID1, &serde_json::to_vec(&session(ID1, 2)).unwrap());
    assert_eq!(s.enforce_tombstones().unwrap(), 1);
    assert_eq!(s.trashed().len(), 2, "both copies are kept");
}

#[test]
fn trash_retention_and_count_are_bounded() {
    let t = Tmp::new("trash-bound");
    let s = store(&t, "alice");
    let dir = t.0.join("sessions").join(".deleted");
    std::fs::create_dir_all(&dir).unwrap();
    let now = now_unix() as u64;
    let old = now - TRASH_RETENTION_SECS - 10;
    const OLD_ID: &str = "BBBBBBBB-0000-4000-8000-000000000009";
    std::fs::write(dir.join(format!("{OLD_ID}.{old}.json")), b"{}").unwrap();
    for i in 0..(TRASH_MAX_ENTRIES + 5) {
        std::fs::write(dir.join(format!("AAAAAAAA-0000-4000-8000-{i:012}.{}.json", now - 100 - i as u64)), b"{}").unwrap();
    }
    s.save(session(ID1, 1), SaveMode::Replace, None, true).unwrap();
    s.delete(ID1).unwrap();
    let kept = s.trashed();
    assert!(kept.iter().all(|k| k.0 != OLD_ID), "older than the retention is pruned");
    assert!(kept.len() <= TRASH_MAX_ENTRIES, "{}", kept.len());
    assert!(kept.iter().any(|k| k.0 == ID1), "the newest copy always survives");
}


// ---- replace may not silently truncate -----------------------------------------------------------

#[test]
fn replace_refuses_a_big_message_count_drop_unless_explicitly_allowed() {
    let t = Tmp::new("trunc");
    let s = store(&t, "alice");
    let first = s.save(session(ID1, 10), SaveMode::Replace, None, true).unwrap();
    // 10 -> 0 and 10 -> 4 are drops of more than half
    for n in [0usize, 4] {
        let e = s.save(session(ID1, n), SaveMode::Replace, Some(&first.revision), true).unwrap_err();
        assert_eq!(e.code, "truncation_needs_confirm", "10 -> {n}");
    }
    assert_eq!(s.load(ID1, None, 100).unwrap().total, 10, "nothing was written");
    // a small shrink and any growth are fine
    let r = s.save(session(ID1, 6), SaveMode::Replace, Some(&first.revision), true).unwrap();
    let r = s.save(session(ID1, 12), SaveMode::Replace, Some(&r.revision), true).unwrap();
    // small chats (<= 4 messages) can be emptied: nothing meaningful to lose
    let small = s.save(session(ID2, 4), SaveMode::Replace, None, true).unwrap();
    s.save(session(ID2, 0), SaveMode::Replace, Some(&small.revision), true).unwrap();
    // with the explicit allowance (a host-confirmed token in the app) the drop goes through
    let r = s.save_with(session(ID1, 2), SaveMode::Replace, Some(&r.revision), true, true).unwrap();
    assert_eq!(r.message_count, 2);
}


// ---- the Mac app's shared folder is never rearranged ----------------------------------------------

#[test]
fn unreadable_files_in_the_shared_mac_folder_are_reported_never_moved() {
    let t = Tmp::new("shared-corrupt");
    let lay = StoreLayout { base: t.0.clone(), sessions: t.0.join("sessions"), shared_with_mac: true };
    let s = ChatStore::open(lay, "u1", None).unwrap();
    put(&t, ID1, CORRUPT_BODY);
    put(&t, ID2, &fixture("session-v2-no-engine-no-project.json"));
    let page = s.list(&q(10)).unwrap();
    assert_eq!((page.total, page.quarantined, page.unreadable), (1, 0, 1));
    assert!(t.0.join("sessions").join(format!("{ID1}.json")).exists(), "the Mac's file stays where it is");
    assert_eq!(s.quarantined_count(), 0);
    // load reports it without moving it either, and still leaks nothing
    let e = s.load(ID1, None, 5).unwrap_err();
    assert_eq!(e.code, "corrupt");
    assert!(t.0.join("sessions").join(format!("{ID1}.json")).exists());
    // a second list does not re-parse into a different answer
    assert_eq!(s.list(&q(10)).unwrap().unreadable, 1);
}

#[test]
fn quarantine_growth_is_bounded() {
    let t = Tmp::new("quarantine-cap");
    let dir = t.0.join("sessions");
    std::fs::create_dir_all(&dir).unwrap();
    for i in 0..(MAX_QUARANTINED + 3) {
        let id = format!("AAAAAAAA-0000-4000-8000-{i:012}");
        std::fs::write(dir.join(format!("{id}.json")), b"junk").unwrap();
        let moved = quarantine(&dir, &id);
        assert_eq!(moved.is_some(), i < MAX_QUARANTINED, "{i}");
    }
}
