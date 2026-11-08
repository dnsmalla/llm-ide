//! One-time, verified import of the retired Mac app's data into this app's desktop core data
//! directory. The copy/verify/rollback engine is `extension/kb/legacy-import.mjs` (no SQLite
//! dependency in the Rust host); this module is the explicit desktop surface:
//!
//!   legacy path: ~/Library/Application Support/llm-ide/system       (macOS only)
//!   target path: <desktop data dir>/core/data.db                    (`fsutil::data_dir_for`)
//!
//! - Read-only status (`legacy_import_status`) runs the helper with `--status --json`; it never
//!   changes either folder.
//! - `legacy_import_run` refuses (as a report, not an error) unless the helper says `import` or,
//!   for a non-empty target, the caller passed `force`.
//! - Replacing a target ALWAYS goes through a native, Cancel-first dialog. The helper then writes
//!   and verifies a backup of the old data.db, agent.db and `.dev-secrets.json` before the switch.
//! - The app-managed core is stopped for the switch and restarted afterwards. An adopted server is
//!   never stopped; if it holds the target DB the helper reports `target-in-use` and nothing changes.
//! - The old app's JWT secret and vault key are read from its `.dev-secrets.json`. The desktop core
//!   receives those two values from the OS keychain (environment), which wins over the file, so the
//!   host moves them into the keychain AFTER backing up the current values. On any failure the
//!   keychain is restored, so the untouched desktop DB keeps its old vault key.
//! - Secrets are never logged, returned to the webview or put in an error message.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::confirm;
use crate::core_host::{self, CoreHost, Phase};
use crate::fsutil::{self, Os};
use crate::fs_ops::FsError;
use crate::prefs;
use crate::secrets;

const SCRIPT: &str = "extension/kb/legacy-import.mjs";
const SECRETS_FILE: &str = ".dev-secrets.json";
const BACKUP_LIMIT: usize = 4096;
const PATH_SHOWN_MAX: usize = 300;
const STDERR_TAIL: usize = 500;

fn herr(code: &'static str, message: impl Into<String>) -> FsError {
    FsError { code, message: message.into() }
}

/// The old Mac app's data folder. `LLMIDE_LEGACY_DATA_DIR` (absolute) wins; otherwise macOS
/// `~/Library/Application Support/llm-ide/system`. `None` on other platforms (the Mac app never
/// ran there), unless the override is set.
pub(crate) fn legacy_dir_for(os: Os, env: &dyn Fn(&str) -> Option<String>) -> Result<Option<PathBuf>, String> {
    let get = |k: &str| env(k).filter(|v| !v.trim().is_empty());
    if let Some(v) = get("LLMIDE_LEGACY_DATA_DIR") {
        let p = PathBuf::from(v);
        return if p.is_absolute() { Ok(Some(p)) } else { Err("LLMIDE_LEGACY_DATA_DIR must be an absolute path".into()) };
    }
    if os != Os::Mac {
        return Ok(None);
    }
    let home = get("HOME").ok_or("HOME is not set")?;
    let home = PathBuf::from(home);
    if !home.is_absolute() {
        return Err("HOME is not an absolute path".into());
    }
    Ok(Some(home.join("Library").join("Application Support").join("llm-ide").join("system")))
}

/// `<desktop data dir>/core`, the directory the spawned core is given as its data dir.
pub(crate) fn target_core_dir(os: Os, env: &dyn Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    Ok(fsutil::data_dir_for(os, env)?.join("core"))
}

fn resolve_dirs() -> Result<(Option<PathBuf>, PathBuf), FsError> {
    let env = |k: &str| std::env::var(k).ok();
    let os = fsutil::current_os();
    let legacy = legacy_dir_for(os, &env).map_err(|e| herr("invalid", e))?;
    let target = target_core_dir(os, &env).map_err(|e| herr("invalid", e))?;
    Ok((legacy, target))
}

fn runtime() -> Result<core_host::Runtime, FsError> {
    core_host::runtime_for(&prefs::launch()).map_err(|e| herr("io", e))
}

/// The helper's JSON report. The helper prints one JSON object on stdout even for a refusal; it
/// exits non-zero for failures and refusals, which is not an error by itself.
fn parse_report(stdout: &[u8], stderr: &[u8], status_ok: bool) -> Result<Value, FsError> {
    let text = String::from_utf8_lossy(stdout);
    let candidate = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{'))
        .unwrap_or_else(|| text.trim());
    match serde_json::from_str::<Value>(candidate) {
        Ok(v) if v.is_object() && v.get("status").and_then(Value::as_str).is_some() => Ok(v),
        _ => {
            let tail = String::from_utf8_lossy(stderr);
            let tail = confirm::sanitize_line(&tail, STDERR_TAIL);
            let why = if tail.is_empty() { "no output".to_string() } else { tail };
            Err(herr(
                "io",
                format!(
                    "the data import helper did not return a report ({}): {}",
                    if status_ok { "exit ok" } else { "non-zero exit" },
                    why
                ),
            ))
        }
    }
}

/// Run the helper in the staged (or checkout) core. Never passes the webview anything but the
/// report; stdout/stderr are bounded and contain no secrets (the helper only reports counts).
fn run_helper(legacy: &Path, target: &Path, import: bool, force: bool) -> Result<Value, FsError> {
    let rt = runtime()?;
    let script = rt.root.join(SCRIPT);
    if !script.is_file() {
        return Err(herr("io", format!("the core has no {}; rebuild the desktop app", SCRIPT)));
    }
    let mut cmd = Command::new(&rt.node);
    cmd.arg(&script)
        .arg(if import { "--import" } else { "--status" })
        .arg("--json")
        .arg("--legacy")
        .arg(legacy)
        .arg("--target")
        .arg(target)
        .current_dir(rt.root.join("extension"));
    if import && force {
        cmd.arg("--force");
    }
    let out = cmd.output().map_err(|e| herr("io", format!("cannot run the data import helper: {e}")))?;
    parse_report(&out.stdout, &out.stderr, out.status.success())
}

fn status_for(legacy: Option<&Path>, target: &Path) -> Result<Value, FsError> {
    match legacy {
        Some(l) => run_helper(l, target, false, false),
        None => Ok(json!({
            "formatVersion": 1,
            "status": "unavailable",
            "reason": "no-legacy-dir",
            "action": "none",
            "needsForce": false,
            "legacy": { "path": null, "exists": false, "valid": false, "empty": true, "sizeBytes": 0, "tableCount": 0, "totalRows": 0, "migration": null },
            "target": { "path": target.join("data.db").to_string_lossy(), "exists": false, "valid": false, "empty": true, "sizeBytes": 0, "tableCount": 0, "totalRows": 0, "migration": null },
            "notes": ["The old Mac app data folder only exists on macOS; set LLMIDE_LEGACY_DATA_DIR to point at a copy."]
        })),
    }
}

/// Read-only: what would an import do? Safe while the core runs.
#[tauri::command]
pub async fn legacy_import_status() -> Result<Value, FsError> {
    tauri::async_runtime::spawn_blocking(|| {
        let (legacy, target) = resolve_dirs()?;
        status_for(legacy.as_deref(), &target)
    })
    .await
    .map_err(|e| herr("io", format!("status task failed: {e}")))?
}

/// The fixed dialog text. Only host-resolved paths and counts vary; the page supplies nothing.
pub(crate) fn dialog_text(status: &Value, replacing: bool) -> (String, String) {
    let source = status.pointer("/legacy/path").and_then(Value::as_str).unwrap_or("(unknown)");
    let target = status.pointer("/target/path").and_then(Value::as_str).unwrap_or("(unknown)");
    let mb = |key: &str| {
        status.pointer(key).and_then(Value::as_u64).map(|b| format!("{} MB", (b as f64 / 1_048_576.0 * 10.0).round() / 10.0)).unwrap_or_else(|| "unknown size".into())
    };
    let rows = status.pointer("/legacy/totalRows").and_then(Value::as_u64).unwrap_or(0);
    let version = status.pointer("/legacy/migration").and_then(Value::as_u64).unwrap_or(0);
    let source = confirm::sanitize_line(source, PATH_SHOWN_MAX);
    let target = confirm::sanitize_line(target, PATH_SHOWN_MAX);
    let body = format!(
        "Old Mac app data:\n\u{201C}{source}\u{201D}\n{}\n{rows} rows, schema version {version}.\n\n\
         Desktop data folder:\n\u{201C}{target}\u{201D}\n\n{}",
        mb("/legacy/sizeBytes"),
        if replacing {
            "This REPLACES the desktop database and agent history. A verified backup of the current desktop data is written first. The old Mac app folder is never changed. The desktop core is stopped for the import and restarted afterwards."
        } else {
            "The desktop data folder is empty, so nothing is replaced. The old Mac app folder is never changed. The desktop core is stopped for the import and restarted afterwards."
        }
    );
    let accept = if replacing { "Import and replace" } else { "Import" };
    (body, accept.to_string())
}

#[derive(Clone)]
struct LegacySecrets {
    jwt_secret: String,
    vault_key: String,
}

/// The old app's `.dev-secrets.json`, if present. Values are validated (same minimum as the core)
/// and never logged. `Ok(None)` when the file does not exist.
fn read_legacy_secrets(legacy: &Path) -> Result<Option<LegacySecrets>, FsError> {
    let file = legacy.join(SECRETS_FILE);
    if !file.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&file).map_err(|e| herr("io", format!("cannot read the old app .dev-secrets.json: {e}")))?;
    let v: Value = serde_json::from_str(&raw).map_err(|_| herr("invalid", "the old app .dev-secrets.json is not valid JSON"))?;
    let take = |key: &str| -> Result<String, FsError> {
        let s = v.get(key).and_then(Value::as_str).ok_or_else(|| herr("invalid", format!("the old app .dev-secrets.json has no {key}")))?;
        if s.len() < 32 || s.chars().any(char::is_control) {
            return Err(herr("invalid", format!("the old app .dev-secrets.json has an unusable {key}")));
        }
        Ok(s.to_string())
    };
    Ok(Some(LegacySecrets { jwt_secret: take("jwtSecret")?, vault_key: take("vaultKey")? }))
}

/// Copy of the values currently in the keychain, written beside the DB backup so a rollback after
/// a later problem can restore them. Owner-only, bounded, atomic.
fn backup_keychain_secrets(target: &Path, stamp: &str, current: &secrets::Secrets) -> Result<PathBuf, FsError> {
    let dir = target.join("backups");
    fsutil::private_dir(&dir).map_err(|e| herr("io", e))?;
    let file = dir.join(format!("pre-import-{stamp}.dev-secrets.json"));
    let body = serde_json::to_vec(&json!({ "jwtSecret": current.jwt_secret, "vaultKey": current.vault_key }))
        .map_err(|e| herr("io", format!("cannot encode the keychain backup: {e}")))?;
    fsutil::write_private_atomic(&file, &body, BACKUP_LIMIT).map_err(|e| herr("io", format!("cannot write the keychain backup: {e}")))?;
    Ok(file)
}

fn stamp_now() -> String {
    // Coarse and filesystem-safe; the Node importer uses its own, finer stamp for its backups.
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{ms}")
}

fn note(report: &mut Value, text: impl Into<String>) {
    if let Some(arr) = report.get_mut("notes").and_then(Value::as_array_mut) {
        arr.push(Value::String(text.into()));
    } else if let Some(obj) = report.as_object_mut() {
        obj.insert("notes".into(), json!([text.into()]));
    }
}

fn completed(report: &Value) -> bool {
    matches!(report.get("status").and_then(Value::as_str), Some("completed"))
}

/// The explicit desktop action. `force` is only sent by the page after the user chooses to replace;
/// the native dialog below is the actual consent.
#[tauri::command]
pub async fn legacy_import_run(host: tauri::State<'_, CoreHost>, force: bool) -> Result<Value, FsError> {
    let core = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_blocking(core, force))
        .await
        .map_err(|e| herr("io", format!("import task failed: {e}")))?
}

fn run_blocking(host: CoreHost, force: bool) -> Result<Value, FsError> {
    let (legacy, target) = resolve_dirs()?;
    let Some(legacy) = legacy else {
        return Err(herr("no_legacy", "the old Mac app data folder does not exist on this platform (set LLMIDE_LEGACY_DATA_DIR)"));
    };
    let status = run_helper(&legacy, &target, false, false)?;
    let action = status.get("action").and_then(Value::as_str).unwrap_or("none");
    if action == "noop" || action == "refuse" || action == "none" {
        return Ok(status);
    }
    let needs_force = status.get("needsForce").and_then(Value::as_bool).unwrap_or(false);
    if needs_force && !force {
        return Ok(status);
    }

    // Refuse a vault that cannot be decrypted before asking for a confirmation.
    let legacy_secrets = read_legacy_secrets(&legacy)?;
    if legacy_secrets.is_none() && status.get("hasVaultSecrets").and_then(Value::as_bool).unwrap_or(false) {
        return Err(herr(
            "legacy_vault_key_missing",
            "the old app holds vault-encrypted secrets but has no .dev-secrets.json; refusing to import a vault that cannot be decrypted",
        ));
    }

    let replacing = needs_force;
    let (body, accept) = dialog_text(&status, replacing);
    let title = if replacing { "Replace the desktop data with the old Mac app data?" } else { "Import the old Mac app data?" };
    if !confirm::ask(title, &body, &accept, replacing) {
        let mut cancelled = status;
        cancelled["status"] = json!("cancelled");
        return Ok(cancelled);
    }

    // Secrets first, but only after a backup that would let a rollback restore them.
    let backend = secrets::default_backend().map_err(|e| herr("io", e.to_string()))?;
    let current = secrets::load_or_create(backend.as_ref()).map_err(|e| herr("io", e.to_string()))?;
    let keychain_backup = if legacy_secrets.is_some() {
        Some(backup_keychain_secrets(&target, &stamp_now(), &current)?)
    } else {
        None
    };
    let mut keychain_changed = false;
    if let Some(ls) = &legacy_secrets {
        backend
            .set(secrets::ACCOUNT_JWT, &ls.jwt_secret)
            .map_err(|e| herr("io", format!("cannot store the old app JWT secret in the OS keychain: {e}")))?;
        keychain_changed = true;
        if let Err(e) = backend.set(secrets::ACCOUNT_VAULT, &ls.vault_key) {
            let _ = backend.set(secrets::ACCOUNT_JWT, &current.jwt_secret);
            return Err(herr("io", format!("cannot store the old app vault key in the OS keychain: {e}")));
        }
    }

    // Stop the app's own core, not an adopted server. If an adopted server holds the target DB the
    // helper reports `target-in-use` and the rollback below keeps the keychain as it was.
    let before = host.status();
    let was_running = before.pid.is_some()
        && !before.adopted
        && matches!(before.state, Phase::Ready | Phase::Starting | Phase::Restarting);
    if was_running {
        if let Err(e) = host.stop() {
            if keychain_changed {
                let _ = backend.set(secrets::ACCOUNT_JWT, &current.jwt_secret);
                let _ = backend.set(secrets::ACCOUNT_VAULT, &current.vault_key);
            }
            return Err(herr("io", format!("cannot stop the core for the import: {e}")));
        }
    }

    let mut report = match run_helper(&legacy, &target, true, force) {
        Ok(r) => r,
        Err(e) => {
            if keychain_changed {
                let _ = backend.set(secrets::ACCOUNT_JWT, &current.jwt_secret);
                let _ = backend.set(secrets::ACCOUNT_VAULT, &current.vault_key);
            }
            if was_running {
                let _ = host.start();
            }
            return Err(e);
        }
    };

    let ok = completed(&report);
    if !ok && keychain_changed {
        // The helper rolled the files back; the keychain must go back too, or the untouched DB's
        // vault would no longer open.
        let jwt = backend.set(secrets::ACCOUNT_JWT, &current.jwt_secret);
        let vault = backend.set(secrets::ACCOUNT_VAULT, &current.vault_key);
        if jwt.is_err() || vault.is_err() {
            report["status"] = json!("failed");
            note(&mut report, "the desktop data was not changed, but restoring the previous keychain secrets failed; the desktop vault may not open until they are restored by hand");
        } else {
            note(&mut report, "the previous keychain secrets were restored");
        }
    }
    if keychain_changed && ok {
        note(&mut report, "the old app's JWT secret and vault key were moved into the desktop OS keychain");
    }
    if let Some(p) = keychain_backup.as_ref().filter(|_| keychain_changed) {
        report["keychainBackup"] = json!(p.to_string_lossy());
    }
    if was_running {
        match host.start() {
            Ok(()) => note(&mut report, "the desktop core was restarted"),
            Err(e) => note(&mut report, format!("the desktop core could not be restarted: {e}")),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn legacy_dir_is_macos_only_and_honours_an_absolute_override() {
        assert_eq!(
            legacy_dir_for(Os::Mac, &env(&[("HOME", "/Users/a")])).unwrap().unwrap(),
            PathBuf::from("/Users/a/Library/Application Support/llm-ide/system")
        );
        assert_eq!(legacy_dir_for(Os::Windows, &env(&[("HOME", "/Users/a")])).unwrap(), None);
        assert_eq!(legacy_dir_for(Os::Linux, &env(&[("HOME", "/home/a")])).unwrap(), None);
        assert_eq!(
            legacy_dir_for(Os::Linux, &env(&[("LLMIDE_LEGACY_DATA_DIR", "/tmp/old")])).unwrap().unwrap(),
            PathBuf::from("/tmp/old")
        );
        assert!(legacy_dir_for(Os::Mac, &env(&[("LLMIDE_LEGACY_DATA_DIR", "relative/path")])).is_err());
    }

    #[test]
    fn target_is_the_core_folder_of_the_desktop_data_dir() {
        assert_eq!(
            target_core_dir(Os::Mac, &env(&[("HOME", "/Users/a")])).unwrap(),
            PathBuf::from("/Users/a/Library/Application Support/llm-ide-desktop/core")
        );
        assert_eq!(
            target_core_dir(Os::Mac, &env(&[("LLMIDE_DESKTOP_DATA_DIR", "/tmp/desk")])).unwrap(),
            PathBuf::from("/tmp/desk/core")
        );
    }

    #[test]
    fn report_parser_reads_the_last_json_object_and_rejects_prose() {
        let v = parse_report(b"warning on stderr is separate\n{\"status\":\"ready\",\"action\":\"import\"}\n", b"", true).unwrap();
        assert_eq!(v["action"], "import");
        let err = parse_report(b"not json\n", b"boom", false).unwrap_err();
        assert_eq!(err.code, "io");
        assert!(err.message.contains("boom"));
        // A JSON object without a status is not a report.
        assert!(parse_report(b"{\"ok\":true}", b"", true).is_err());
    }

    #[test]
    fn the_dialog_names_the_folders_and_warns_before_replacing() {
        let status = json!({
            "status": "needs-confirmation", "needsForce": true,
            "legacy": { "path": "/old/system", "sizeBytes": 411_078_656u64, "totalRows": 1234, "migration": 69 },
            "target": { "path": "/new/core/data.db" }
        });
        let (body, accept) = dialog_text(&status, true);
        assert!(body.contains("/old/system") && body.contains("/new/core/data.db"));
        assert!(body.contains("392 MB"));
        assert!(body.contains("REPLACES") && body.contains("backup"));
        assert_eq!(accept, "Import and replace");
        let (body, accept) = dialog_text(&status, false);
        assert!(body.contains("nothing is replaced"));
        assert_eq!(accept, "Import");
    }

    #[test]
    fn a_report_status_helper_only_accepts_completed() {
        assert!(completed(&json!({ "status": "completed" })));
        assert!(!completed(&json!({ "status": "refused" })));
        assert!(!completed(&json!({})));
    }
}
