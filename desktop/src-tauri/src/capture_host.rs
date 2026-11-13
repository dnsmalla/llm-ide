//! Live capture host commands. One capture at a time on its own thread; no paths reach the webview.
use crate::capture_ax_macos as ax;
use crate::capture_session::{
    CaptureEvent, CaptureState, MacSource, Session, SnapshotSource, StopResult, TickOutcome,
};
use crate::capture_store::{self, FinalMeta, PartialSummary};
use crate::trash_guard::{OsTrash, Trasher};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
const TICK: Duration = Duration::from_millis(800);
const MIN_GAP: Duration = Duration::from_millis(50);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const MAC_APP: &str = "com.llmide.macapp";
const AX_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
enum Cmd {
    Stop {
        title: String,
        reply: mpsc::Sender<StopResult>,
    },
    Abort,
}
/// Why the tick loop ended (shared with the capture thread; 0 while it runs).
const LOOP_RUNNING: u8 = 0;
const LOOP_PERMISSION_LOST: u8 = 1;
const LOOP_FULL: u8 = 2;
/// Where a Stop request is. The record stays in ACTIVE until the stop has completed, so a slow finalize cannot be
/// raced by a second capture and `shutdown` can still join the thread.
enum StopPhase {
    Running,
    /// A caller is waiting for the capture thread's reply right now.
    Waiting,
    /// The wait timed out; the next Stop picks up the same reply instead of sending another request.
    Pending(mpsc::Receiver<StopResult>),
}
struct Active {
    id: String,
    started_at_ms: i64,
    tx: mpsc::Sender<Cmd>,
    join: Option<JoinHandle<()>>,
    loop_end: Arc<AtomicU8>,
    stop: StopPhase,
}
impl Active {
    fn loop_ended(&self) -> bool {
        self.loop_end.load(Ordering::SeqCst) != LOOP_RUNNING
    }
    /// (recording, stopping, why the loop ended). Recording is false once nothing is captured any more, even though
    /// the record stays until Stop finishes the note.
    fn view(&self) -> (bool, bool, Option<&'static str>) {
        let reason = match self.loop_end.load(Ordering::SeqCst) {
            LOOP_PERMISSION_LOST => Some("permission_lost"),
            LOOP_FULL => Some("full"),
            _ => None,
        };
        let stopping = !matches!(self.stop, StopPhase::Running);
        (reason.is_none() && !stopping, stopping, reason)
    }
}
static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
fn capture_dir() -> Result<PathBuf, String> {
    Ok(crate::fsutil::desktop_data_dir()?.join("capture"))
}
fn valid_language(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 35
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn take_active() -> Option<Active> {
    ACTIVE.lock().ok().and_then(|mut g| g.take())
}

/// True while a capture runs (the tray's status line and Start/Stop item).
pub fn is_recording() -> bool {
    ACTIVE
        .lock()
        .map(|g| g.as_ref().is_some_and(|a| a.view().0))
        .unwrap_or(false)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub supported: bool,
    pub trusted: bool,
    pub recording: bool,
    pub session_id: Option<String>,
    pub started_at_ms: Option<i64>,
    /// A stop is in progress or timed out; the capture is not running.
    pub stopping: bool,
    /// Why capture ended on its own (`permission_lost`, `full`) while the session still awaits Stop.
    pub stopped_reason: Option<&'static str>,
    pub notes_root: bool,
    pub mac_app_running: bool,
    pub dev_build: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub session_id: String,
    pub started_at_ms: i64,
}
#[tauri::command]
pub fn capture_status() -> CaptureStatus {
    let (rec, stopping, reason, id, ts) = match ACTIVE.lock().ok().as_deref() {
        Some(Some(a)) => {
            let (rec, stopping, reason) = a.view();
            (
                rec,
                stopping,
                reason,
                Some(a.id.clone()),
                Some(a.started_at_ms),
            )
        }
        _ => (false, false, None, None, None),
    };
    CaptureStatus {
        supported: ax::SUPPORTED,
        trusted: ax::is_trusted(),
        recording: rec,
        session_id: id,
        started_at_ms: ts,
        stopping,
        stopped_reason: reason,
        notes_root: crate::notes_fs::current_root().is_ok(),
        mac_app_running: ax::running_pid(MAC_APP).is_some(),
        dev_build: cfg!(debug_assertions),
    }
}
#[tauri::command]
pub fn capture_request_permission() -> bool {
    ax::prompt_trust()
}
#[tauri::command]
pub async fn capture_open_settings() -> Result<(), String> {
    if !ax::SUPPORTED {
        return Err("unsupported: Accessibility settings exist on macOS only".into());
    }
    tauri::async_runtime::spawn_blocking(|| -> Result<(), String> {
        std::process::Command::new("/usr/bin/open")
            .arg(AX_SETTINGS)
            .status()
            .map_err(|e| format!("io: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("io: {e}"))?
}
#[tauri::command]
pub async fn capture_start(
    language: String,
    on_event: Channel<CaptureEvent>,
) -> Result<StartInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_capture(language, on_event))
        .await
        .map_err(|e| format!("io: {e}"))?
}
fn start_capture(language: String, on_event: Channel<CaptureEvent>) -> Result<StartInfo, String> {
    if !ax::SUPPORTED {
        return Err("unsupported: live capture is macOS-only in this version".into());
    }
    if !valid_language(&language) {
        return Err("invalid_language: expected a short language tag".into());
    }
    if !ax::is_trusted() {
        return Err("not_trusted: Accessibility is not allowed for LLM-IDE".into());
    }
    let root = crate::notes_fs::current_root().map_err(|e| format!("no_notes_root: {e}"))?;
    let mut guard = ACTIVE
        .lock()
        .map_err(|_| "io: capture state poisoned".to_string())?;
    // Why: a loop that ended on its own (permission lost, buffer full) must not wedge the next start; its partial
    // is on disk and shows up in the recover list once the record is gone.
    reap_ended(&mut guard);
    if guard.is_some() {
        return Err("already_recording: stop the current capture first".into());
    }
    let session = Session::start(
        &capture_dir()?,
        root,
        language,
        now_ms(),
        Instant::now(),
        crate::capture_readers::all_readers(),
    )?;
    let info = StartInfo {
        session_id: session.id().to_string(),
        started_at_ms: session.started_at_ms(),
    };
    (|| {
        let (tx, rx) = mpsc::channel();
        let loop_end = Arc::new(AtomicU8::new(LOOP_RUNNING));
        let thread_end = loop_end.clone();
        let join = std::thread::Builder::new()
            .name("llmide-capture".into())
            .spawn(move || run(session, Box::new(MacSource), rx, on_event, thread_end))
            .map_err(|e| format!("io: {e}"))?;
        *guard = Some(Active {
            id: info.session_id.clone(),
            started_at_ms: info.started_at_ms,
            tx,
            join: Some(join),
            loop_end,
            stop: StopPhase::Running,
        });
        Ok(info)
    })()
}
fn finish(session: Session, title: &str) -> StopResult {
    let root = crate::notes_fs::validate_notes_root(session.notes_root())
        .or_else(|_| crate::notes_fs::current_root());
    session.finish(root, title, now_ms())
}
fn run(
    mut session: Session,
    mut src: Box<dyn SnapshotSource>,
    rx: mpsc::Receiver<Cmd>,
    chan: Channel<CaptureEvent>,
    ended: Arc<AtomicU8>,
) {
    let start = Instant::now();
    let mut n: u32 = 0;
    loop {
        let mut out = Vec::new();
        let outcome = session.tick(src.as_mut(), Instant::now(), now_ms(), &mut out);
        for e in out {
            let _ = chan.send(e);
        }
        if !matches!(outcome, TickOutcome::Continue) {
            ended.store(
                if matches!(outcome, TickOutcome::Full) {
                    LOOP_FULL
                } else {
                    LOOP_PERMISSION_LOST
                },
                Ordering::SeqCst,
            );
            break;
        }
        n += 1;
        let wait = (start + TICK * n)
            .saturating_duration_since(Instant::now())
            .max(MIN_GAP);
        match rx.recv_timeout(wait) {
            Ok(Cmd::Stop { title, reply }) => {
                let _ = reply.send(finish(session, &title));
                let _ = chan.send(CaptureEvent::State {
                    state: CaptureState::Stopped,
                    platform: None,
                    detail: None,
                });
                return;
            }
            Ok(Cmd::Abort) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = session.close_out();
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    match rx.recv() {
        Ok(Cmd::Stop { title, reply }) => {
            let _ = reply.send(finish(session, &title));
            let _ = chan.send(CaptureEvent::State {
                state: CaptureState::Stopped,
                platform: None,
                detail: None,
            });
        }
        _ => {
            let _ = session.close_out();
        }
    }
}
#[tauri::command]
pub async fn capture_stop(title: String) -> Result<StopResult, String> {
    tauri::async_runtime::spawn_blocking(move || stop_in(&ACTIVE, title, STOP_TIMEOUT))
        .await
        .map_err(|e| format!("io: {e}"))?
}
/// Sends Stop and waits for the finished note. The record leaves `slot` only after the thread answered and was joined;
/// on a timeout it stays (marked stopping) so no second capture starts beside the one still finalizing, and the next
/// Stop waits on the same reply.
fn stop_in(
    slot: &Mutex<Option<Active>>,
    title: String,
    wait: Duration,
) -> Result<StopResult, String> {
    let got = {
        let mut g = slot
            .lock()
            .map_err(|_| "io: capture state poisoned".to_string())?;
        let Some(a) = g.as_mut() else {
            return Err("not_recording: no capture is running".into());
        };
        match std::mem::replace(&mut a.stop, StopPhase::Waiting) {
            StopPhase::Running => {
                let (reply, got) = mpsc::channel();
                if a.tx.send(Cmd::Stop { title, reply }).is_err() {
                    *g = None;
                    return Err("io: capture thread is gone".into());
                }
                got
            }
            StopPhase::Pending(got) => got,
            StopPhase::Waiting => {
                a.stop = StopPhase::Waiting;
                return Err("stopping: a stop is already in progress".into());
            }
        }
    };
    match got.recv_timeout(wait) {
        Ok(r) => {
            clear_active(slot);
            Ok(r)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if let Ok(mut g) = slot.lock() {
                if let Some(a) = g.as_mut() {
                    a.stop = StopPhase::Pending(got);
                }
            }
            Err("io: capture did not stop in time; the partial is kept".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            clear_active(slot);
            Err("io: capture thread ended without a result; the partial is kept".into())
        }
    }
}
fn clear_active(slot: &Mutex<Option<Active>>) {
    let join = slot
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().and_then(|a| a.join.take()));
    if let Some(j) = join {
        let _ = j.join();
    }
    if let Ok(mut g) = slot.lock() {
        *g = None;
    }
}
/// Drops a record whose loop ended on its own and that nobody is stopping; the thread is told to close out.
fn reap_ended(slot: &mut Option<Active>) {
    if slot
        .as_ref()
        .is_some_and(|a| a.loop_ended() && matches!(a.stop, StopPhase::Running))
    {
        if let Some(mut a) = slot.take() {
            let _ = a.tx.send(Cmd::Abort);
            if let Some(j) = a.join.take() {
                let _ = j.join();
            }
        }
    }
}
fn active_id() -> Option<String> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|a| a.id.clone()))
}
#[tauri::command]
pub async fn capture_recover_list() -> Vec<PartialSummary> {
    tauri::async_runtime::spawn_blocking(|| {
        capture_dir()
            .map(|d| capture_store::list_partials(&d, active_id().as_deref()))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}
fn recover_path(id: &str) -> Result<PathBuf, String> {
    if active_id().as_deref() == Some(id) {
        return Err("invalid_id: this capture is still running".into());
    }
    let p = capture_store::partial_path(&capture_dir()?, id).ok_or("invalid_id: bad capture id")?;
    if !p.is_file() {
        return Err("not_found: no unfinished capture with this id".into());
    }
    Ok(p)
}
#[tauri::command]
pub async fn capture_recover_finish(id: String, title: String) -> Result<StopResult, String> {
    if !capture_store::valid_session_id(&id) {
        return Err("invalid_id: bad capture id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = recover_path(&id)?;
        let r = capture_store::read_partial(&path)?;
        if r.rows.is_empty() {
            OsTrash
                .trash(&path)
                .map_err(|e| format!("trash_unavailable: {}", e.message))?;
            return Ok(StopResult {
                note: None,
                kept_partial: false,
                reason: Some("empty".into()),
            });
        }
        let root = crate::notes_fs::validate_notes_root(std::path::Path::new(&r.header.notes_root))
            .or_else(|_| crate::notes_fs::current_root())?;
        let ended = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(now_ms);
        let title = capture_store::clean_title(&title);
        let meta = FinalMeta {
            id: &r.header.id,
            title: &title,
            started_at_ms: r.header.started_at_ms,
            ended_at_ms: ended,
            platform: r.platform.as_deref().unwrap_or("mic"),
            language: &r.header.language,
        };
        Ok(
            match capture_store::finalize(&root, Some(&path), &meta, &r.rows) {
                Ok(note) => StopResult {
                    note: Some(note),
                    kept_partial: false,
                    reason: None,
                },
                Err(e) => StopResult {
                    note: None,
                    kept_partial: true,
                    reason: Some(e),
                },
            },
        )
    })
    .await
    .map_err(|e| format!("io: {e}"))?
}
#[tauri::command]
pub fn capture_recover_discard(id: String) -> Result<(), String> {
    if !capture_store::valid_session_id(&id) {
        return Err("invalid_id: bad capture id".into());
    }
    OsTrash
        .trash(&recover_path(&id)?)
        .map_err(|e| format!("trash_unavailable: {}", e.message))
}
pub fn shutdown() {
    if let Some(mut a) = take_active() {
        let _ = a.tx.send(Cmd::Abort);
        if let Some(j) = a.join.take() {
            let _ = j.join();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lang() {
        for ok in ["en", "ja", "pt-BR", "zh_Hant"] {
            assert!(valid_language(ok))
        }
        for bad in ["", "en us", "<x>", &"a".repeat(36)] {
            assert!(!valid_language(bad))
        }
    }
    #[test]
    fn no_stop() {
        assert!(take_active().is_none());
        assert!(tauri::async_runtime::block_on(capture_stop("x".into()))
            .unwrap_err()
            .starts_with("not_recording"))
    }
    #[test]
    fn ids() {
        assert!(tauri::async_runtime::block_on(capture_recover_finish(
            "../../etc".into(),
            "".into()
        ))
        .unwrap_err()
        .starts_with("invalid_id"));
        assert!(capture_recover_discard("m-x/../../y".into())
            .unwrap_err()
            .starts_with("invalid_id"))
    }

    fn fake_active(stop_after: Option<Duration>) -> Active {
        let (tx, rx) = mpsc::channel::<Cmd>();
        let join = std::thread::spawn(move || {
            if let Ok(Cmd::Stop { reply, .. }) = rx.recv() {
                if let Some(d) = stop_after {
                    std::thread::sleep(d);
                }
                let _ = reply.send(StopResult {
                    note: None,
                    kept_partial: true,
                    reason: Some("t".into()),
                });
            }
        });
        Active {
            id: "m-a-b".into(),
            started_at_ms: 1,
            tx,
            join: Some(join),
            loop_end: Arc::new(AtomicU8::new(LOOP_RUNNING)),
            stop: StopPhase::Running,
        }
    }
    #[test]
    fn ended_loop_is_not_recording() {
        let a = fake_active(None);
        assert_eq!(a.view(), (true, false, None));
        a.loop_end.store(LOOP_PERMISSION_LOST, Ordering::SeqCst);
        assert_eq!(a.view(), (false, false, Some("permission_lost")));
        a.loop_end.store(LOOP_FULL, Ordering::SeqCst);
        assert_eq!(a.view(), (false, false, Some("full")));
        let mut slot = Some(a);
        reap_ended(&mut slot);
        assert!(
            slot.is_none(),
            "an ended, unstopped record no longer blocks a new start"
        );
    }
    #[test]
    fn running_record_is_not_reaped() {
        let mut slot = Some(fake_active(None));
        reap_ended(&mut slot);
        assert!(slot.is_some());
        let _ = stop_in(&Mutex::new(slot), "x".into(), Duration::from_secs(2));
    }
    #[test]
    fn slow_stop_keeps_the_record_until_it_completes() {
        let slot = Mutex::new(Some(fake_active(Some(Duration::from_millis(300)))));
        let err = stop_in(&slot, "x".into(), Duration::from_millis(30)).unwrap_err();
        assert!(err.contains("did not stop in time"), "{err}");
        {
            let g = slot.lock().unwrap();
            let a = g
                .as_ref()
                .expect("still recorded, so a second start is refused");
            assert_eq!(a.view(), (false, true, None));
        }
        let r = stop_in(&slot, "x".into(), Duration::from_secs(5)).unwrap();
        assert_eq!(r.reason.as_deref(), Some("t"));
        assert!(
            slot.lock().unwrap().is_none(),
            "cleared only after the stop completed"
        );
    }
    #[test]
    fn concurrent_stop_is_refused() {
        let slot = Mutex::new(Some(fake_active(None)));
        slot.lock().unwrap().as_mut().unwrap().stop = StopPhase::Waiting;
        assert!(stop_in(&slot, "x".into(), Duration::from_millis(10))
            .unwrap_err()
            .starts_with("stopping"));
        assert!(slot.lock().unwrap().is_some());
        let mut g = slot.lock().unwrap();
        reap_ended(&mut g);
        assert!(g.is_some());
        let a = g.take().unwrap();
        let _ = a.tx.send(Cmd::Abort);
    }
}
