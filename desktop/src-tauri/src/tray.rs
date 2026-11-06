//! Tray / menu-bar presence and fixed-template native notifications.
//!
//! - Tray menu: "Show window", the active project name (disabled label), "Quit".
//!   Left-click toggles the main window. If the tray cannot be created (a Linux
//!   desktop without a StatusNotifier host) the app runs without it and
//!   close-to-tray is forced off, so the window can never become unreachable.
//! - Close-to-tray is OFF by default and persisted in the app data dir.
//! - Notifications: the webview names a fixed template (`approval_needed`,
//!   `task_done`) plus an optional short detail; the host builds plain text
//!   (no HTML, control characters and markup characters stripped, length capped).
//!   The webview is never granted the notification plugin's own commands.
//! - Nothing here auto-starts the app at login.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_notification::{NotificationExt, PermissionState};

pub const DETAIL_MAX_CHARS: usize = 80;
const NO_PROJECT_LABEL: &str = "No project open";
const MIN_NOTIFY_INTERVAL_MS: u64 = 500;

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);
static ICON_VISIBLE: AtomicBool = AtomicBool::new(true);
static TRAY_READY: AtomicBool = AtomicBool::new(false);
static LAST_NOTIFY_MS: AtomicU64 = AtomicU64::new(0);
static PROJECT_ITEM: Mutex<Option<MenuItem<Wry>>> = Mutex::new(None);

// ---- notification templates -------------------------------------------------------------

/// Invisible "format" characters (Unicode Cf): bidi overrides/isolates, zero-width
/// joiners, BOM, tag characters. They can reorder or hide text in a notification.
pub(crate) fn is_invisible_format(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}' | '\u{E0000}'..='\u{E007F}')
}

/// True for a word that looks like a link: a scheme, `www.`, or a host/path.
fn looks_like_url(word: &str) -> bool {
    let w = word.to_ascii_lowercase();
    w.contains("://") || w.starts_with("www.") || w.starts_with("mailto:") || w.starts_with("javascript:") || w.starts_with("data:")
        || (w.contains('.') && w.contains('/'))
}

/// Plain-text, markup-free, single-line, capped detail with no hidden direction
/// controls and no links (a notification is not a place for a clickable lure).
pub fn sanitize_detail(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control() && !is_invisible_format(*c) && !matches!(c, '<' | '>' | '&' | '"' | '`'))
        .collect();
    let no_urls = cleaned.split(' ').filter(|w| !looks_like_url(w)).collect::<Vec<_>>().join(" ");
    no_urls.trim().chars().take(DETAIL_MAX_CHARS).collect()
}

/// (title, body) for a fixed template, or an error for an unknown kind.
pub fn notification_text(kind: &str, detail: Option<&str>) -> Result<(String, String), String> {
    let head = match kind {
        "approval_needed" => "Approval needed",
        "task_done" => "Task done",
        _ => return Err("unknown notification template".into()),
    };
    let d = detail.map(sanitize_detail).unwrap_or_default();
    let body = if d.is_empty() { head.to_string() } else { format!("{head}: {d}") };
    Ok(("LLM-IDE".to_string(), body))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Shows a fixed-template notification, requesting permission once if undecided.
#[tauri::command]
pub fn notify(app: AppHandle, kind: String, detail: Option<String>) -> Result<(), String> {
    let (title, body) = notification_text(&kind, detail.as_deref())?;
    let now = now_ms();
    let last = LAST_NOTIFY_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < MIN_NOTIFY_INTERVAL_MS {
        return Err("notifications are rate limited".into());
    }
    LAST_NOTIFY_MS.store(now, Ordering::Relaxed);
    let n = app.notification();
    let mut state = n.permission_state().map_err(|e| e.to_string())?;
    if state == PermissionState::Prompt || state == PermissionState::PromptWithRationale {
        state = n.request_permission().map_err(|e| e.to_string())?;
    }
    if state != PermissionState::Granted {
        return Err("notification permission not granted".into());
    }
    n.builder().title(title).body(body).show().map_err(|e| e.to_string())
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
    let show = MenuItem::with_id(app, "tray_show", "Show window", true, None::<&str>)?;
    let project = MenuItem::with_id(app, "tray_project", NO_PROJECT_LABEL, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &project, &sep, &quit])?;
    if let Ok(mut g) = PROJECT_ITEM.lock() {
        *g = Some(project);
    }
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("LLM-IDE")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_main(app),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_are_fixed_and_unknown_kinds_rejected() {
        assert_eq!(notification_text("approval_needed", None).unwrap().1, "Approval needed");
        assert_eq!(notification_text("task_done", Some("build")).unwrap().1, "Task done: build");
        assert!(notification_text("custom", Some("x")).is_err());
        assert!(notification_text("", None).is_err());
        assert_eq!(notification_text("task_done", None).unwrap().0, "LLM-IDE");
    }

    #[test]
    fn detail_is_capped_and_has_no_markup_or_control_chars() {
        let long = "a".repeat(500);
        assert_eq!(sanitize_detail(&long).chars().count(), DETAIL_MAX_CHARS);
        assert_eq!(sanitize_detail("<b>hi</b> & \"x\"\n\tline`"), "bhi/b  xline");
        let (_, body) = notification_text("approval_needed", Some(&format!("<script>{long}"))).unwrap();
        assert!(!body.contains('<') && !body.contains('>'));
        assert!(body.chars().count() <= "Approval needed: ".len() + DETAIL_MAX_CHARS);
        assert_eq!(notification_text("task_done", Some("   ")).unwrap().1, "Task done");
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
    fn tray_settings_parse_both_flags_with_defaults() {
        assert_eq!(parse_settings(&serde_json::json!({})), TraySettings::default());
        assert_eq!(TraySettings::default(), TraySettings { close_to_tray: false, icon_visible: true });
        assert_eq!(parse_settings(&serde_json::json!({"closeToTray":true})), TraySettings { close_to_tray: true, icon_visible: true });
        assert_eq!(parse_settings(&serde_json::json!({"iconVisible":false})), TraySettings { close_to_tray: false, icon_visible: false });
        assert_eq!(parse_settings(&serde_json::json!({"closeToTray":"yes","iconVisible":1})), TraySettings::default());
        assert_eq!(settings_json(TraySettings { close_to_tray: true, icon_visible: false }), "{\"closeToTray\":true,\"iconVisible\":false}");
    }

    #[test]
    fn detail_has_no_bidi_controls_or_links() {
        let tricky = "build \u{202E}gpj.exe\u{202C} \u{200B}done \u{2066}x\u{2069}";
        let out = sanitize_detail(tricky);
        assert!(out.chars().all(|c| !is_invisible_format(c)), "{out:?}");
        assert_eq!(sanitize_detail("see https://evil.example/x now"), "see now");
        assert_eq!(sanitize_detail("go to www.evil.com ok"), "go to ok");
        assert_eq!(sanitize_detail("evil.com/login done"), "done");
        assert_eq!(sanitize_detail("mailto:a@b.c hi"), "hi");
        assert_eq!(sanitize_detail("v1.2 shipped"), "v1.2 shipped", "dots alone are not links");
    }
}
