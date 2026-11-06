//! Tray / menu-bar presence. Native notifications live in notify.rs.
//!
//! - Tray menu: backend status (+ "Recording"), approvals waiting, Show window, the active project (label), Start/Stop live capture, Pause/Resume sync, Quit.
//!   Left-click toggles the main window. If the tray cannot be created (a Linux
//!   desktop without a StatusNotifier host) the app runs without it and
//!   close-to-tray is forced off, so the window can never become unreachable.
//! - Close-to-tray is OFF by default and persisted in the app data dir.
//! - Notifications live in notify.rs; this module only shows the window and hands it a pending route.
//! - Nothing here auto-starts the app at login.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;
use tauri::Emitter;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

const NO_PROJECT_LABEL: &str = "No project open";

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);
static ICON_VISIBLE: AtomicBool = AtomicBool::new(true);
static TRAY_READY: AtomicBool = AtomicBool::new(false);
static PROJECT_ITEM: Mutex<Option<MenuItem<Wry>>> = Mutex::new(None);

// ---- notification templates -------------------------------------------------------------

/// Invisible "format" characters (Unicode Cf): bidi overrides/isolates, zero-width
/// joiners, BOM, tag characters. They can reorder or hide text in a notification.
pub(crate) fn is_invisible_format(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}' | '\u{E0000}'..='\u{E007F}')
}

// ---- tray settings (close-to-tray, menu-bar icon) ---------------------------------------

fn settings_file(_app: &AppHandle) -> Option<PathBuf> {
    crate::fsutil::desktop_data_dir().ok().map(|d| d.join("tray-settings.json"))
}

/// A settings file larger than this is ignored.
const SETTINGS_MAX_BYTES: u64 = 4 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TraySettings {
    pub close_to_tray: bool,
    pub icon_visible: bool,
}

impl Default for TraySettings {
    fn default() -> Self {
        // Close-to-tray is off by default; the menu-bar icon is on (the Mac's menu-bar chat icon is on).
        Self { close_to_tray: false, icon_visible: true }
    }
}

/// Both settings from one JSON object; a missing or non-boolean field keeps its default.
pub fn parse_settings(v: &serde_json::Value) -> TraySettings {
    let d = TraySettings::default();
    TraySettings {
        close_to_tray: v.get("closeToTray").and_then(|b| b.as_bool()).unwrap_or(d.close_to_tray),
        icon_visible: v.get("iconVisible").and_then(|b| b.as_bool()).unwrap_or(d.icon_visible),
    }
}

pub fn settings_json(s: TraySettings) -> String {
    format!("{{\"closeToTray\":{},\"iconVisible\":{}}}", s.close_to_tray, s.icon_visible)
}

fn load_settings(app: &AppHandle) -> TraySettings {
    settings_file(app)
        .filter(|f| std::fs::metadata(f).is_ok_and(|m| m.is_file() && m.len() <= SETTINGS_MAX_BYTES))
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|v| parse_settings(&v))
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: TraySettings) {
    if let Some(f) = settings_file(app) {
        let saved = f
            .parent()
            .ok_or_else(|| "no settings directory".to_string())
            .and_then(crate::fsutil::private_dir)
            .and_then(|_| crate::fsutil::write_private_atomic(&f, settings_json(s).as_bytes(), SETTINGS_MAX_BYTES as usize));
        if let Err(e) = saved {
            eprintln!("tray: setting not saved: {e}");
        }
    }
}

fn current() -> TraySettings {
    TraySettings { close_to_tray: CLOSE_TO_TRAY.load(Ordering::Relaxed), icon_visible: ICON_VISIBLE.load(Ordering::Relaxed) }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayStatus {
    pub available: bool,
    pub close_to_tray: bool,
    /// False after the user hides the menu-bar icon in Settings > General.
    pub icon_visible: bool,
}

#[tauri::command]
pub fn tray_status() -> TrayStatus {
    TrayStatus { available: TRAY_READY.load(Ordering::Relaxed), close_to_tray: CLOSE_TO_TRAY.load(Ordering::Relaxed), icon_visible: ICON_VISIBLE.load(Ordering::Relaxed) }
}

#[tauri::command]
pub fn tray_set_close_to_tray(app: AppHandle, enabled: bool) -> Result<TrayStatus, String> {
    if enabled && (!TRAY_READY.load(Ordering::Relaxed) || !ICON_VISIBLE.load(Ordering::Relaxed)) {
        return Err("no tray icon is available on this desktop".into());
    }
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
    save_settings(&app, current());
    Ok(tray_status())
}

/// Shows or hides the menu-bar icon. Hiding it also turns close-to-tray off: with no icon the window would be
/// unreachable after a close. The Settings page is still open, so the icon can be brought back.
#[tauri::command]
pub fn tray_set_icon_visible(app: AppHandle, visible: bool) -> Result<TrayStatus, String> {
    if !TRAY_READY.load(Ordering::Relaxed) {
        return Err("no tray icon is available on this desktop".into());
    }
    ICON_VISIBLE.store(visible, Ordering::Relaxed);
    if !visible {
        CLOSE_TO_TRAY.store(false, Ordering::Relaxed);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_visible(visible);
    }
    save_settings(&app, current());
    Ok(tray_status())
}

/// True when a window close should hide to the tray instead of closing.
pub fn should_hide_on_close() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed) && TRAY_READY.load(Ordering::Relaxed) && ICON_VISIBLE.load(Ordering::Relaxed)
}

// ---- tray ---------------------------------------------------------------------------------------

pub fn set_project_label(_app: &AppHandle, name: Option<&str>) {
    if let Ok(g) = PROJECT_ITEM.lock() {
        if let Some(item) = g.as_ref() {
            let _ = item.set_text(name.unwrap_or(NO_PROJECT_LABEL));
        }
    }
}

/// Shows, restores and focuses the main window, then hands it a fresh notification's route (notify.rs).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus();
    }
    crate::notify::on_main_focused(app);
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else { show_main(app); }
    }
}

/// Builds the tray icon; failure is logged and leaves the app tray-less.
pub fn setup(app: &AppHandle) {
    let s = load_settings(app);
    CLOSE_TO_TRAY.store(s.close_to_tray, Ordering::Relaxed);
    ICON_VISIBLE.store(s.icon_visible, Ordering::Relaxed);
    if let Err(e) = build(app) {
        eprintln!("tray: not available: {e}");
        CLOSE_TO_TRAY.store(false, Ordering::Relaxed);
        return;
    }
    // The user may have hidden the menu-bar icon in Settings > General; the window is still the way back.
    if !s.icon_visible {
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_visible(false);
        }
    }
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "tray_status", "Backend starting", false, None::<&str>)?;
    let approvals = MenuItem::with_id(app, "tray_approvals", "No approvals waiting", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "tray_show", "Show window", true, None::<&str>)?;
    let project = MenuItem::with_id(app, "tray_project", NO_PROJECT_LABEL, false, None::<&str>)?;
    let capture = MenuItem::with_id(app, "tray_capture", "Start live capture", false, None::<&str>)?;
    let sync = MenuItem::with_id(app, "tray_sync", "Sync unavailable", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &approvals, &sep1, &show, &project, &capture, &sync, &sep2, &quit])?;
    *lock(&ITEMS) = Some(Items { status, approvals, capture, sync });
    if let Ok(mut g) = PROJECT_ITEM.lock() {
        *g = Some(project);
    }
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("LLM-IDE")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_main(app),
            "tray_approvals" => { show_main(app); let _ = app.emit("tray-action", format!("route:{}", approvals_route(CHAT_PENDING.load(Ordering::Relaxed)))); }
            "tray_capture" => { show_main(app); let _ = app.emit("tray-action", "capture_toggle"); }
            "tray_sync" => { let _ = app.emit("tray-action", "sync_toggle"); }
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    TRAY_READY.store(true, Ordering::Relaxed);
    Ok(())
}

// ---- tray view (pure) ---------------------------------------------------------------------------------------------

use crate::core_host::Phase;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncState {
    /// Not set up, signed out, or not readable by this UI.
    Unknown,
    On,
    Paused,
}

impl SyncState {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "unknown" => Some(Self::Unknown),
            "on" => Some(Self::On),
            "paused" => Some(Self::Paused),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayView {
    pub status: String,
    pub approvals: String,
    pub approvals_enabled: bool,
    pub capture: &'static str,
    pub capture_enabled: bool,
    pub sync: &'static str,
    pub sync_enabled: bool,
    /// Text beside the menu-bar icon (macOS, Linux); None hides it.
    pub title: Option<String>,
    pub tooltip: String,
}

pub fn count_text(n: u32) -> String {
    if n > 99 { "99+".into() } else { n.to_string() }
}

pub fn tray_view(core: Phase, recording: bool, capture_supported: bool, chat: u32, jobs: u32, sync: SyncState) -> TrayView {
    let backend = match core {
        Phase::Ready => "Backend ready",
        Phase::Starting => "Backend starting",
        Phase::Restarting => "Backend restarting",
        Phase::Failed | Phase::Stopped => "Backend stopped",
    };
    let status = if recording { format!("{backend} · Recording") } else { backend.to_string() };
    let total = chat.saturating_add(jobs);
    let approvals = match total {
        0 => "No approvals waiting".to_string(),
        1 => "1 approval waiting".to_string(),
        n => format!("{} approvals waiting", count_text(n)),
    };
    let (capture, capture_enabled) = if !capture_supported {
        ("Live capture (macOS only)", false)
    } else if recording {
        ("Stop live capture", true)
    } else {
        ("Start live capture", true)
    };
    let (sync_text, sync_enabled) = match sync {
        SyncState::Unknown => ("Sync unavailable", false),
        SyncState::On => ("Pause sync", true),
        SyncState::Paused => ("Resume sync", true),
    };
    let tooltip = if total == 0 { "LLM-IDE".to_string() } else { format!("LLM-IDE: {approvals}") };
    TrayView {
        status,
        approvals_enabled: total > 0,
        approvals,
        capture,
        capture_enabled,
        sync: sync_text,
        sync_enabled,
        title: (total > 0).then(|| count_text(total)),
        tooltip,
    }
}

/// The approvals line opens Chat when a chat tool waits, else the status-bar inbox.
pub fn approvals_route(chat: u32) -> &'static str {
    if chat > 0 { "chat" } else { "inbox" }
}

/// An unexpected stop: a crash or a failed start. A user Stop and a restart that then fails are not reported twice.
pub fn core_went_down(prev: Phase, next: Phase) -> bool {
    matches!((prev, next), (Phase::Ready, Phase::Restarting | Phase::Failed) | (Phase::Starting, Phase::Failed))
}

static CHAT_PENDING: AtomicU32 = AtomicU32::new(0);
static JOB_PENDING: AtomicU32 = AtomicU32::new(0);
static SYNC: Mutex<SyncState> = Mutex::new(SyncState::Unknown);
static ITEMS: Mutex<Option<Items>> = Mutex::new(None);
static LAST_VIEW: Mutex<Option<TrayView>> = Mutex::new(None);
const WATCH_EVERY: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct Items {
    status: MenuItem<Wry>,
    approvals: MenuItem<Wry>,
    capture: MenuItem<Wry>,
    sync: MenuItem<Wry>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}


fn apply(app: &AppHandle, v: &TrayView) {
    let items = lock(&ITEMS).clone();
    if let Some(i) = items {
        let _ = i.status.set_text(&v.status); let _ = i.approvals.set_text(&v.approvals); let _ = i.approvals.set_enabled(v.approvals_enabled);
        let _ = i.capture.set_text(v.capture); let _ = i.capture.set_enabled(v.capture_enabled);
        let _ = i.sync.set_text(v.sync); let _ = i.sync.set_enabled(v.sync_enabled);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(v.title.as_deref()); let _ = tray.set_tooltip(Some(&v.tooltip));
    }
}
pub fn refresh(app: &AppHandle) -> Phase {
    let phase = app.state::<crate::core_host::CoreHost>().status().state;
    let sync = *lock(&SYNC);
    let v = tray_view(phase, crate::capture_host::is_recording(), crate::capture_ax_macos::SUPPORTED, CHAT_PENDING.load(Ordering::Relaxed), JOB_PENDING.load(Ordering::Relaxed), sync);
    let changed = { let mut last = lock(&LAST_VIEW); if last.as_ref() == Some(&v) { false } else { *last = Some(v.clone()); true } };
    if changed { apply(app, &v); }
    phase
}
#[tauri::command]
pub fn tray_report(app: AppHandle, chat_approvals: u32, job_approvals: u32, sync: String) -> Result<(), String> {
    let s = SyncState::parse(&sync).ok_or("unknown sync state")?;
    CHAT_PENDING.store(chat_approvals.min(999), Ordering::Relaxed); JOB_PENDING.store(job_approvals.min(999), Ordering::Relaxed); *lock(&SYNC) = s;
    refresh(&app); Ok(())
}
pub fn start_watch(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("llmide-tray-watch".into()).spawn(move || {
        let mut prev = Phase::Starting;
        loop {
            let phase = refresh(&app);
            if core_went_down(prev, phase) { crate::notify::fire_host(&app, crate::notify::Kind::CoreDown, None); }
            prev = phase; std::thread::sleep(WATCH_EVERY);
        }
    });
    if let Err(e) = spawned { eprintln!("tray: status watcher not started: {e}"); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_host::Phase;

    #[test]
    fn the_status_line_names_the_backend_and_recording_only() {
        assert_eq!(tray_view(Phase::Ready, false, true, 0, 0, SyncState::On).status, "Backend ready");
        assert_eq!(tray_view(Phase::Ready, true, true, 0, 0, SyncState::On).status, "Backend ready · Recording");
        assert_eq!(tray_view(Phase::Failed, false, true, 0, 0, SyncState::On).status, "Backend stopped");
        assert_eq!(tray_view(Phase::Stopped, false, true, 0, 0, SyncState::On).status, "Backend stopped");
        assert_eq!(tray_view(Phase::Restarting, false, true, 0, 0, SyncState::On).status, "Backend restarting");
    }

    #[test]
    fn the_approval_count_shows_in_the_menu_title_and_tooltip() {
        let none = tray_view(Phase::Ready, false, true, 0, 0, SyncState::Unknown);
        assert_eq!((none.approvals.as_str(), none.approvals_enabled, none.title.clone(), none.tooltip.as_str()), ("No approvals waiting", false, None, "LLM-IDE"));
        let one = tray_view(Phase::Ready, false, true, 1, 0, SyncState::Unknown);
        assert_eq!((one.approvals.as_str(), one.title.as_deref()), ("1 approval waiting", Some("1")));
        let many = tray_view(Phase::Ready, false, true, 2, 150, SyncState::Unknown);
        assert_eq!((many.approvals.as_str(), many.title.as_deref(), many.tooltip.as_str()), ("99+ approvals waiting", Some("99+"), "LLM-IDE: 99+ approvals waiting"));
        assert_eq!(approvals_route(1), "chat");
        assert_eq!(approvals_route(0), "inbox");
    }

    #[test]
    fn capture_and_sync_items_follow_their_state() {
        let mac = tray_view(Phase::Ready, false, true, 0, 0, SyncState::On);
        assert_eq!((mac.capture, mac.capture_enabled, mac.sync, mac.sync_enabled), ("Start live capture", true, "Pause sync", true));
        let rec = tray_view(Phase::Ready, true, true, 0, 0, SyncState::Paused);
        assert_eq!((rec.capture, rec.sync), ("Stop live capture", "Resume sync"));
        let other = tray_view(Phase::Ready, false, false, 0, 0, SyncState::Unknown);
        assert_eq!((other.capture, other.capture_enabled, other.sync, other.sync_enabled), ("Live capture (macOS only)", false, "Sync unavailable", false));
        assert_eq!(SyncState::parse("paused"), Some(SyncState::Paused));
        assert_eq!(SyncState::parse("off"), None);
    }

    #[test]
    fn only_an_unexpected_stop_counts_as_down() {
        assert!(core_went_down(Phase::Ready, Phase::Restarting));
        assert!(core_went_down(Phase::Ready, Phase::Failed));
        assert!(core_went_down(Phase::Starting, Phase::Failed));
        assert!(!core_went_down(Phase::Ready, Phase::Stopped), "a user Stop is not news");
        assert!(!core_went_down(Phase::Restarting, Phase::Failed), "already told at Ready -> Restarting");
        assert!(!core_went_down(Phase::Ready, Phase::Ready));
    }




    #[test]
    fn close_to_tray_needs_a_tray() {
        ICON_VISIBLE.store(true, Ordering::Relaxed);
        CLOSE_TO_TRAY.store(true, Ordering::Relaxed);
        TRAY_READY.store(false, Ordering::Relaxed);
        assert!(!should_hide_on_close());
        TRAY_READY.store(true, Ordering::Relaxed);
        assert!(should_hide_on_close());
        ICON_VISIBLE.store(false, Ordering::Relaxed);
        assert!(!should_hide_on_close(), "a hidden menu-bar icon must never hide the window");
        ICON_VISIBLE.store(true, Ordering::Relaxed);
        CLOSE_TO_TRAY.store(false, Ordering::Relaxed);
        assert!(!should_hide_on_close());
    }

    #[test]
    fn invisible_format_characters_are_detected() {
        for c in ['\u{202E}', '\u{200B}', '\u{2066}', '\u{FEFF}', '\u{E0041}'] { assert!(is_invisible_format(c), "{c:?}"); }
        for c in ['a', ' ', 'é', '日'] { assert!(!is_invisible_format(c), "{c:?}"); }
    }

    #[test]
    fn tray_settings_parse_both_flags_with_defaults() {
        assert_eq!(parse_settings(&serde_json::json!({})), TraySettings::default());
        assert_eq!(TraySettings::default(), TraySettings { close_to_tray: false, icon_visible: true });
        assert_eq!(parse_settings(&serde_json::json!({"closeToTray":true})), TraySettings { close_to_tray: true, icon_visible: true });
        assert_eq!(parse_settings(&serde_json::json!({"iconVisible":false})), TraySettings { close_to_tray: false, icon_visible: false });
        assert_eq!(parse_settings(&serde_json::json!({"closeToTray":"yes","iconVisible":1})), TraySettings::default());
        assert_eq!(settings_json(TraySettings { close_to_tray: true, icon_visible: false }), "{\"closeToTray\":true,\"iconVisible\":false}");
    }

}
