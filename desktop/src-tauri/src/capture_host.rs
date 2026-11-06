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
    sync::{mpsc, Mutex},
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
struct Active {
    id: String,
    started_at_ms: i64,
    tx: mpsc::Sender<Cmd>,
    join: Option<JoinHandle<()>>,
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
    ACTIVE.lock().map(|g| g.is_some()).unwrap_or(false)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub supported: bool,
    pub trusted: bool,
    pub recording: bool,
    pub session_id: Option<String>,
    pub started_at_ms: Option<i64>,
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
    let (rec, id, ts) = match ACTIVE.lock().ok().as_deref() {
        Some(Some(a)) => (true, Some(a.id.clone()), Some(a.started_at_ms)),
        _ => (false, None, None),
    };
    CaptureStatus {
        supported: ax::SUPPORTED,
        trusted: ax::is_trusted(),
        recording: rec,
        session_id: id,
        started_at_ms: ts,
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
pub fn capture_open_settings() -> Result<(), String> {
    if !ax::SUPPORTED {
        return Err("unsupported: Accessibility settings exist on macOS only".into());
    }
    std::process::Command::new("/usr/bin/open")
        .arg(AX_SETTINGS)
        .status()
        .map_err(|e| format!("io: {e}"))?;
    Ok(())
}
#[tauri::command]
pub fn capture_start(
    language: String,
    on_event: Channel<CaptureEvent>,
) -> Result<StartInfo, String> {
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
        let join = std::thread::Builder::new()
            .name("llmide-capture".into())
            .spawn(move || run(session, Box::new(MacSource), rx, on_event))
            .map_err(|e| format!("io: {e}"))?;
        *guard = Some(Active {
            id: info.session_id.clone(),
            started_at_ms: info.started_at_ms,
            tx,
            join: Some(join),
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
    let Some(mut active) = take_active() else {
        return Err("not_recording: no capture is running".into());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (reply, got) = mpsc::channel();
        active
            .tx
            .send(Cmd::Stop { title, reply })
            .map_err(|_| "io: capture thread is gone".to_string())?;
        let r = got
            .recv_timeout(STOP_TIMEOUT)
            .map_err(|_| "io: capture did not stop in time; the partial is kept".to_string())?;
        if let Some(j) = active.join.take() {
            let _ = j.join();
        }
        Ok(r)
    })
    .await
    .map_err(|e| format!("io: {e}"))?
}
fn active_id() -> Option<String> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|a| a.id.clone()))
}
#[tauri::command]
pub fn capture_recover_list() -> Vec<PartialSummary> {
    capture_dir()
        .map(|d| capture_store::list_partials(&d, active_id().as_deref()))
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
}
