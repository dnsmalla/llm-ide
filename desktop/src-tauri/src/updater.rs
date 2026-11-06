//! Signed auto-update. The plugin is registered only when the build carries a valid `plugins.updater` section
//! (the release overlay written by desktop/scripts/release-config.mjs); local builds report `no_update_config`.
//! Flow: check (network, on request or once a day when the pref is on) -> the user presses Install -> native
//! Cancel-first confirm -> download (the plugin verifies the signature against the embedded key) -> stop the core
//! and terminals -> install -> restart. A .deb install is package-managed and never self-updates.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use crate::confirm::{self, herr};
use crate::fs_ops::FsError;

/// The one allowed endpoint: a fixed channel release that desktop-promote.yml updates. Keep in step with
/// desktop/scripts/release-config.mjs (a drift test there reads this line).
pub const CHANNEL_URL: &str = "https://github.com/dnsmalla/llm-ide/releases/download/desktop-stable/latest.json";
pub const NOTES_MAX: usize = 2000;
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const MANUAL_GAP_MS: u64 = 30_000;

/// None = valid. A missing section must read as a problem (never use `cfg?`, which would return None = valid).
pub fn config_problem(cfg: Option<&serde_json::Value>) -> Option<&'static str> {
    let Some(c) = cfg.and_then(|v| v.as_object()) else { return Some("no_update_config") };
    if c.get("pubkey").and_then(|v| v.as_str()).map_or(true, |k| k.trim().len() < 40) {
        return Some("no_update_key");
    }
    match c.get("endpoints").and_then(|v| v.as_array()) {
        Some(a) if a.len() == 1 && a[0].as_str() == Some(CHANNEL_URL) => None,
        _ => Some("bad_update_endpoint"),
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum InstallKind { SelfUpdate, PackageManaged }

pub fn install_kind(os: &str, appimage: Option<&str>) -> InstallKind {
    if os == "linux" && appimage.map_or(true, |p| p.trim().is_empty()) { InstallKind::PackageManaged } else { InstallKind::SelfUpdate }
}

pub fn notes_text(body: Option<&str>) -> String {
    body.unwrap_or("").chars().filter(|c| *c == '\n' || !c.is_control()).take(NOTES_MAX).collect()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate { pub version: String, pub notes: String }

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub configured: bool,
    pub reason: Option<&'static str>,
    pub install_kind: &'static str,
    pub available: Option<AvailableUpdate>,
    pub last_checked_ms: Option<u64>,
    pub error: Option<String>,
}

pub(crate) fn status_from(reason: Option<&'static str>, kind: InstallKind, available: Option<AvailableUpdate>, last: Option<u64>, error: Option<String>) -> UpdateStatus {
    UpdateStatus {
        configured: reason.is_none(),
        reason,
        install_kind: if kind == InstallKind::SelfUpdate { "self" } else { "package" },
        available: if reason.is_none() { available } else { None },
        last_checked_ms: last,
        error,
    }
}

use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
struct Inner {
    reason: Option<&'static str>,
    pending: Option<Update>,
    last_checked_ms: Option<u64>,
    error: Option<String>,
    checking: bool,
}
static STATE: Mutex<Option<Inner>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut Inner) -> R) -> R {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(|| Inner { reason: Some("no_update_config"), ..Default::default() }))
}

fn kind() -> InstallKind { install_kind(std::env::consts::OS, std::env::var("APPIMAGE").ok().as_deref()) }

/// Called once from `run()` with the result of `config_problem` on the build's config.
pub fn init(reason: Option<&'static str>) { with(|s| s.reason = reason); }

fn snapshot() -> UpdateStatus {
    with(|s| status_from(
        s.reason, kind(),
        s.pending.as_ref().map(|u| AvailableUpdate { version: u.version.clone(), notes: notes_text(u.body.as_deref()) }),
        s.last_checked_ms, s.error.clone(),
    ))
}

async fn check_now(app: &tauri::AppHandle) -> Result<UpdateStatus, FsError> {
    if let Some(r) = with(|s| s.reason) { return Err(herr(r, "This build has no update channel.")); }
    let busy = with(|s| {
        let now = confirm::now_ms();
        let too_soon = s.last_checked_ms.is_some_and(|t| now.saturating_sub(t) < MANUAL_GAP_MS);
        if s.checking || too_soon { true } else { s.checking = true; false }
    });
    if busy { return Ok(snapshot()); }
    let result = match app.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    with(|s| {
        s.checking = false;
        s.last_checked_ms = Some(confirm::now_ms());
        match result {
            Ok(found) => { s.pending = found; s.error = None; }
            Err(e) => s.error = Some(confirm::sanitize_line(&e, 200)),
        }
    });
    Ok(snapshot())
}

#[tauri::command]
pub fn update_status() -> UpdateStatus { snapshot() }

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateStatus, FsError> { check_now(&app).await }

/// Ok(false) = the user cancelled. Never returns Ok(true): a successful install restarts the app.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, host: tauri::State<'_, crate::core_host::CoreHost>) -> Result<bool, FsError> {
    if let Some(r) = with(|s| s.reason) { return Err(herr(r, "This build has no update channel.")); }
    if kind() == InstallKind::PackageManaged {
        return Err(herr("package_managed", "This copy was installed from a package. Update it with your package manager."));
    }
    let update = with(|s| s.pending.clone()).ok_or_else(|| herr("no_update", "Check for updates first."))?;
    let text = format!("Install LLM-IDE {}?\n\nThe app downloads the update, checks its signature, closes, installs it and opens again. Unsaved terminal output is lost.", confirm::sanitize_line(&update.version, 40));
    let ok = tauri::async_runtime::spawn_blocking(move || confirm::ask("Install update", &text, "Install and Restart", false)).await.unwrap_or(false);
    if !ok { return Ok(false); }
    // The plugin verifies the signature here; nothing is stopped until a verified payload is on disk.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| herr("download_failed", confirm::sanitize_line(&e.to_string(), 200)))?;
    host.shutdown();
    crate::pty::kill_all();
    if let Err(e) = update.install(bytes) {
        let _ = host.start();
        return Err(herr("install_failed", confirm::sanitize_line(&e.to_string(), 200)));
    }
    app.restart();
}

/// Once a minute after launch, then daily, while the pref is on. Check only: never installs.
pub fn start_background(app: tauri::AppHandle) {
    if with(|s| s.reason).is_some() { return; }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            if crate::prefs::stored().update_checks {
                let _ = tauri::async_runtime::block_on(check_now(&app));
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0QKUldTMTIzNDU2Nzg5MAo=";

    #[test]
    fn config_is_valid_only_with_a_key_and_exactly_the_channel_url() {
        assert_eq!(config_problem(None), Some("no_update_config"));
        assert_eq!(config_problem(Some(&json!({"endpoints": [CHANNEL_URL]}))), Some("no_update_key"));
        assert_eq!(config_problem(Some(&json!({"pubkey": "  ", "endpoints": [CHANNEL_URL]}))), Some("no_update_key"));
        assert_eq!(config_problem(Some(&json!({"pubkey": KEY, "endpoints": ["http://github.com/x"]}))), Some("bad_update_endpoint"));
        assert_eq!(config_problem(Some(&json!({"pubkey": KEY, "endpoints": [CHANNEL_URL, "https://evil.example/l.json"]}))), Some("bad_update_endpoint"));
        assert_eq!(config_problem(Some(&json!({"pubkey": KEY, "endpoints": [CHANNEL_URL]}))), None);
    }

    #[test]
    fn linux_without_appimage_is_package_managed() {
        assert_eq!(install_kind("linux", None), InstallKind::PackageManaged);
        assert_eq!(install_kind("linux", Some("")), InstallKind::PackageManaged);
        assert_eq!(install_kind("linux", Some("/home/u/LLM-IDE.AppImage")), InstallKind::SelfUpdate);
        assert_eq!(install_kind("macos", None), InstallKind::SelfUpdate);
        assert_eq!(install_kind("windows", None), InstallKind::SelfUpdate);
    }

    #[test]
    fn notes_are_capped_and_stripped() {
        assert_eq!(notes_text(None), "");
        assert_eq!(notes_text(Some("a\u{0007}b\nc")), "ab\nc");
        assert_eq!(notes_text(Some(&"x".repeat(5000))).chars().count(), NOTES_MAX);
    }

    #[test]
    fn status_without_config_says_why_and_is_never_available() {
        let s = status_from(Some("no_update_config"), InstallKind::SelfUpdate, None, None, None);
        assert!(!s.configured);
        assert_eq!(s.reason, Some("no_update_config"));
        assert!(s.available.is_none());
        assert_eq!(s.install_kind, "self");
    }
}
