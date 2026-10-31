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
static TRAY_READY: AtomicBool = AtomicBool::new(false);
static LAST_NOTIFY_MS: AtomicU64 = AtomicU64::new(0);
static PROJECT_ITEM: Mutex<Option<MenuItem<Wry>>> = Mutex::new(None);

// ---- notification templates -------------------------------------------------------------

/// Plain-text, markup-free, single-line, capped detail.
pub fn sanitize_detail(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | '&' | '"' | '`'))
        .collect();
    cleaned.trim().chars().take(DETAIL_MAX_CHARS).collect()
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

// ---- close-to-tray setting ---------------------------------------------------------------

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("tray-settings.json"))
}

fn load_close_to_tray(app: &AppHandle) -> bool {
    settings_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("closeToTray").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

#[derive(serde::Serialize)]
pub struct TrayStatus {
    pub available: bool,
    pub close_to_tray: bool,
}

#[tauri::command]
pub fn tray_status() -> TrayStatus {
    TrayStatus { available: TRAY_READY.load(Ordering::Relaxed), close_to_tray: CLOSE_TO_TRAY.load(Ordering::Relaxed) }
}

#[tauri::command]
pub fn tray_set_close_to_tray(app: AppHandle, enabled: bool) -> Result<TrayStatus, String> {
    if enabled && !TRAY_READY.load(Ordering::Relaxed) {
        return Err("no tray icon is available on this desktop".into());
    }
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
    if let Some(f) = settings_file(&app) {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(f, format!("{{\"closeToTray\":{enabled}}}"));
    }
    Ok(tray_status())
}

/// True when a window close should hide to the tray instead of closing.
pub fn should_hide_on_close() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed) && TRAY_READY.load(Ordering::Relaxed)
}

// ---- tray ---------------------------------------------------------------------------------------

pub fn set_project_label(_app: &AppHandle, name: Option<&str>) {
    if let Ok(g) = PROJECT_ITEM.lock() {
        if let Some(item) = g.as_ref() {
            let _ = item.set_text(name.unwrap_or(NO_PROJECT_LABEL));
        }
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

/// Builds the tray icon; failure is logged and leaves the app tray-less.
pub fn setup(app: &AppHandle) {
    CLOSE_TO_TRAY.store(load_close_to_tray(app), Ordering::Relaxed);
    if let Err(e) = build(app) {
        eprintln!("tray: not available: {e}");
        CLOSE_TO_TRAY.store(false, Ordering::Relaxed);
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
            "tray_show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
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
        CLOSE_TO_TRAY.store(true, Ordering::Relaxed);
        TRAY_READY.store(false, Ordering::Relaxed);
        assert!(!should_hide_on_close());
        TRAY_READY.store(true, Ordering::Relaxed);
        assert!(should_hide_on_close());
        CLOSE_TO_TRAY.store(false, Ordering::Relaxed);
        assert!(!should_hide_on_close());
    }
}
