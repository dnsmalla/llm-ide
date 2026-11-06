//! Desktop archivist for Chrome-extension captures (live-then-archive 3.6 B; plan
//! docs/superpowers/plans/2026-11-07-desktop-capture-archivist.md).
//!
//! The extension finalizes a capture on the core (`POST /kb/live/:id/finalize`); with `LLMIDE_LIVE_ACK=1` (set on the
//! core this app spawns) the core holds it until an archivist acks. This module is that archivist, in the host:
//!   1. list the bound user's unacked captures (`GET /kb/live/unacked`),
//!   2. read the held copy (`GET /kb/live/:id/capture`); its rows must equal the line count the ack echoes,
//!   3. find the note an earlier run wrote for exactly this capture, or write it through `capture_store::finalize`
//!      (the same writer and read-back verify as a native capture),
//!   4. feed the derived index (best effort), then ack with the server's own lines and hash.
//! Nothing is acked unless step 3 returned a note that read back. A crash between 3 and 4 is repaired by the next pass
//! finding the same note (`find_archived`). Bounded: MAX_PER_TICK captures per pass, MAX_ATTEMPTS per capture per launch.
//! Capture text is never logged (desktop/scripts/check-capture-privacy.test.mjs covers every capture_*.rs).

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::capture_store::{self, FinalMeta, IndexUpsert, Row};
use crate::chat_archive::RemoteError;

pub const TICK: Duration = Duration::from_secs(20);
pub const MAX_PER_TICK: usize = 5;
pub const MAX_ATTEMPTS: u32 = 3;
/// Frontmatter platform of an extension capture (what the Swift writer used; the core does not hold the meeting app).
const PLATFORM: &str = "chrome-extension";

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unacked {
    pub session_id: String,
    pub lines: usize,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldCapture {
    pub session_id: String,
    pub title: String,
    pub started_at: i64,
    pub duration_sec: i64,
    #[serde(default)]
    pub language: String,
    pub lines: usize,
    pub hash: String,
    /// UTC `HH:MM:SS` times, as the core holds them.
    pub rows: Vec<Row>,
}

/// What the archivist asks of the core (schema/http/lifecycle.schema.json, index.schema.json).
pub trait CaptureRemote {
    fn unacked(&self) -> Result<Vec<Unacked>, RemoteError>;
    fn capture(&self, id: &str) -> Result<HeldCapture, RemoteError>;
    fn index(&self, upsert: &IndexUpsert) -> Result<(), RemoteError>;
    fn ack(&self, id: &str, note_key: &str, hash: &str, lines: usize) -> Result<(), RemoteError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Archived,
    Reused,
    Failed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickReport {
    pub archived: usize,
    pub reused: usize,
    pub failed: usize,
    pub skipped: usize,
    pub waiting: usize,
}

/// Ids the archivist puts in a URL path: the extension's UUIDs and `legacy-<id>-<hex>` ids.
pub fn valid_capture_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && !id.starts_with('.')
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

/// One capture: write (or find) the verified note, index it, then ack. Never acks without a note that read back.
pub fn archive_one(remote: &dyn CaptureRemote, root: &Path, id: &str) -> Outcome {
    let Ok(cap) = remote.capture(id) else { return Outcome::Failed };
    if cap.session_id != id || cap.lines == 0 || cap.rows.len() != cap.lines {
        return Outcome::Failed;
    }
    let mut rows = cap.rows;
    capture_store::utc_times_to_local(cap.started_at, &mut rows);
    let title = capture_store::clean_title(&cap.title);
    let meta = FinalMeta {
        id,
        title: &title,
        started_at_ms: cap.started_at,
        ended_at_ms: cap.started_at + cap.duration_sec.max(0) * 1000,
        platform: PLATFORM,
        language: &cap.language,
    };
    let (note, reused) = match capture_store::find_archived(root, &meta, &rows) {
        Some(n) => (n, true),
        None => match capture_store::finalize(root, None, &meta, &rows) {
            Ok(n) => (n, false),
            Err(_) => return Outcome::Failed,
        },
    };
    if let Some(ix) = &note.index {
        let _ = remote.index(ix); // derived and rebuildable (Library rebuild): never blocks the ack
    }
    match remote.ack(id, &note.rel, &cap.hash, cap.lines) {
        Ok(()) if reused => Outcome::Reused,
        Ok(()) => Outcome::Archived,
        Err(_) => Outcome::Failed,
    }
}

#[derive(Default)]
pub struct Archivist {
    attempts: HashMap<String, u32>,
}

impl Archivist {
    /// One bounded pass. `still_bound` is re-read before each capture: a sign-out or token refresh stops the pass.
    pub fn tick(&mut self, remote: &dyn CaptureRemote, root: &Path, still_bound: &dyn Fn() -> bool) -> Result<TickReport, RemoteError> {
        let mut r = TickReport::default();
        let mut started = 0;
        for u in remote.unacked()? {
            let tries = self.attempts.get(&u.session_id).copied().unwrap_or(0);
            if u.lines == 0 || !valid_capture_id(&u.session_id) || tries >= MAX_ATTEMPTS {
                r.skipped += 1;
                continue;
            }
            if started >= MAX_PER_TICK || !still_bound() {
                r.waiting += 1;
                continue;
            }
            started += 1;
            match archive_one(remote, root, &u.session_id) {
                Outcome::Archived => {
                    r.archived += 1;
                    self.attempts.remove(&u.session_id);
                }
                Outcome::Reused => {
                    r.reused += 1;
                    self.attempts.remove(&u.session_id);
                }
                Outcome::Failed => {
                    r.failed += 1;
                    *self.attempts.entry(u.session_id).or_insert(0) += 1;
                }
            }
        }
        if self.attempts.len() > 1_000 {
            self.attempts.clear(); // bounded memory; the core holds at most 200 unacked captures per user
        }
        Ok(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub(super) fn scratch(t: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("llmide-arch-{t}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    pub(super) fn md_files(dir: &Path) -> usize {
        let mut n = 0;
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    n += md_files(&p);
                } else if p.extension().is_some_and(|x| x == "md") {
                    n += 1;
                }
            }
        }
        n
    }

    #[derive(Default)]
    struct Fake {
        list: RefCell<Vec<Unacked>>,
        caps: HashMap<String, HeldCapture>,
        fail_acks: Cell<u32>,
        acks: RefCell<Vec<(String, String, String, usize)>>,
        indexed: RefCell<Vec<String>>,
    }

    impl CaptureRemote for Fake {
        fn unacked(&self) -> Result<Vec<Unacked>, RemoteError> {
            Ok(self.list.borrow().clone())
        }
        fn capture(&self, id: &str) -> Result<HeldCapture, RemoteError> {
            self.caps.get(id).cloned().ok_or(RemoteError::Http(404))
        }
        fn index(&self, u: &IndexUpsert) -> Result<(), RemoteError> {
            self.indexed.borrow_mut().push(u.note_key.clone());
            Ok(())
        }
        fn ack(&self, id: &str, key: &str, hash: &str, lines: usize) -> Result<(), RemoteError> {
            if self.fail_acks.get() > 0 {
                self.fail_acks.set(self.fail_acks.get() - 1);
                return Err(RemoteError::Unreachable);
            }
            self.acks.borrow_mut().push((id.into(), key.into(), hash.into(), lines));
            self.list.borrow_mut().retain(|u| u.session_id != id);
            Ok(())
        }
    }

    fn held(id: &str) -> HeldCapture {
        HeldCapture {
            session_id: id.into(),
            title: "Standup".into(),
            started_at: 1_762_335_000_000,
            duration_sec: 60,
            language: "en".into(),
            lines: 2,
            hash: "h".repeat(64),
            rows: vec![
                Row { time: "09:30:01".into(), speaker: "Ana".into(), text: "Hello.".into() },
                Row { time: "09:31:01".into(), speaker: "Ben".into(), text: "Hi.".into() },
            ],
        }
    }

    fn fake(ids: &[&str]) -> Fake {
        let mut f = Fake::default();
        for id in ids {
            f.list.borrow_mut().push(Unacked { session_id: (*id).into(), lines: 2 });
            f.caps.insert((*id).into(), held(id));
        }
        f
    }

    #[test]
    fn writes_and_verifies_the_note_then_acks_with_the_servers_lines_and_hash() {
        let root = scratch("ok");
        let f = fake(&["cap-1"]);
        let r = Archivist::default().tick(&f, &root, &|| true).unwrap();
        assert_eq!(r, TickReport { archived: 1, ..TickReport::default() });
        let acks = f.acks.borrow();
        let (id, rel, hash, lines) = &acks[0];
        assert_eq!(id, "cap-1");
        assert_eq!(hash, &"h".repeat(64));
        assert_eq!(*lines, 2);
        let text = std::fs::read_to_string(root.join(rel)).unwrap();
        assert!(text.contains("\nid: \"cap-1\"\n") && text.contains("\nplatform: \"chrome-extension\"\n"));
        assert!(text.contains("**Ana**: Hello.\n") && text.contains("**Ben**: Hi.\n"));
        assert_eq!(*f.indexed.borrow(), vec![rel.clone()]);
    }

    #[test]
    fn a_crash_between_write_and_ack_never_makes_a_second_note() {
        let root = scratch("crash");
        let f = fake(&["cap-1"]);
        f.fail_acks.set(1);
        assert_eq!(Archivist::default().tick(&f, &root, &|| true).unwrap().failed, 1);
        assert!(f.acks.borrow().is_empty());
        assert_eq!(md_files(&root), 1);
        // A relaunch (a fresh archivist) finds the same note and only acks.
        assert_eq!(Archivist::default().tick(&f, &root, &|| true).unwrap().reused, 1);
        assert_eq!(md_files(&root), 1);
        assert_eq!(f.acks.borrow().len(), 1);
    }

    #[test]
    fn a_failed_write_is_never_acked_and_is_retried_at_most_three_times() {
        let root = scratch("nowrite").join("missing"); // canonicalize fails: the write cannot happen
        let f = fake(&["cap-1"]);
        let mut a = Archivist::default();
        for _ in 0..MAX_ATTEMPTS {
            assert_eq!(a.tick(&f, &root, &|| true).unwrap().failed, 1);
        }
        assert_eq!(a.tick(&f, &root, &|| true).unwrap(), TickReport { skipped: 1, ..TickReport::default() });
        assert!(f.acks.borrow().is_empty());
    }

    #[test]
    fn rows_that_do_not_match_the_ack_line_count_are_refused() {
        let root = scratch("mismatch");
        let mut f = fake(&["cap-1"]);
        f.caps.get_mut("cap-1").unwrap().lines = 3;
        assert_eq!(Archivist::default().tick(&f, &root, &|| true).unwrap().failed, 1);
        assert_eq!(md_files(&root), 0);
        assert!(f.acks.borrow().is_empty());
    }

    #[test]
    fn a_pass_is_bounded_and_stops_when_the_session_goes() {
        let root = scratch("bound");
        let ids: Vec<String> = (0..7).map(|i| format!("cap-{i}")).collect();
        let f = fake(&ids.iter().map(String::as_str).collect::<Vec<_>>());
        let mut a = Archivist::default();
        assert_eq!(a.tick(&f, &root, &|| true).unwrap(), TickReport { archived: MAX_PER_TICK, waiting: 2, ..TickReport::default() });
        assert_eq!(a.tick(&f, &root, &|| false).unwrap(), TickReport { waiting: 2, ..TickReport::default() });
        assert_eq!(a.tick(&f, &root, &|| true).unwrap().archived, 2);
        assert_eq!(md_files(&root), 7);
    }

    #[test]
    fn empty_and_unsafe_ids_are_skipped_without_a_read() {
        let root = scratch("skip");
        let f = Fake::default();
        f.list.borrow_mut().extend([
            Unacked { session_id: "cap-0".into(), lines: 0 },
            Unacked { session_id: "../x".into(), lines: 2 },
            Unacked { session_id: String::new(), lines: 2 },
        ]);
        assert_eq!(Archivist::default().tick(&f, &root, &|| true).unwrap(), TickReport { skipped: 3, ..TickReport::default() });
        assert!(valid_capture_id("0b6c2d4e-1111-4a2b-9c3d-123456789abc") && valid_capture_id("legacy-17300-ab12cd34ef56"));
        assert!(!valid_capture_id("..") && !valid_capture_id("a/b") && !valid_capture_id(&"a".repeat(201)));
    }
}
