//! The local login (email, password and refresh token) kept in the OS keychain, for the local core.
//!
//! Why: the local core's session lives only in memory, so every launch asked for the password again.
//! The account is kept here so the app can sign in at each start. The password is the sensitive part: it
//! is given to the local core and nowhere else.
//!
//! TRUST RULE (MUST): the password and the refresh token are sent only to the core this host spawned and
//! verified RIGHT NOW. `CoreHost::verified_url()` re-probes `/health` for this launch's nonce, so a core
//! that was stopped, restarted, or replaced by a squatter on the port yields no URL. Every credential-
//! bearing command calls `verified_core()` immediately before it uses the credential, inside the blocking
//! task. Cached status fields are never trusted here. The URL must be plain `http://127.0.0.1:<port>`.
//!
//! One keychain slot: save and forget replace or clear it regardless of the data dir. Only READS ignore an
//! entry saved from another data dir (the entry is never deleted by a read).
//!
//! Nothing here logs, returns or Debug-prints the password. The webview gets the refresh token only (like
//! the hub session) and can never read the password back; the status command returns the email alone.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::confirm::herr;
use crate::core_host::CoreHost;
use crate::fs_ops::FsError;
use crate::prefs::ServerMode;
use crate::secrets::{SecretBackend, ACCOUNT_LOCAL_LOGIN};
use tauri::State;

const STORED_VERSION: u8 = 1;
const MAX_EMAIL: usize = 254;
const MAX_PASSWORD: usize = 1024;
const MAX_TOKEN: usize = 4096;
/// Long enough for a cold local core to answer, short enough that a wedged core cannot hang the sign-in.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredLogin {
    v: u8,
    /// The desktop data dir the login was saved from. Only reads check it; a mismatch is never deleted.
    data_dir: String,
    email: String,
    password: String,
    /// The latest rotated refresh token; set from the verified login and rotated by the webview.
    refresh: String,
}

impl std::fmt::Debug for StoredLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StoredLogin { v: 1, dataDir: <redacted>, email: <redacted>, password: <redacted>, refresh: <redacted> }")
    }
}

/// What the webview may show: whether a login is saved and for which email. Never the password.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalLoginStatus {
    pub saved: bool,
    pub email: Option<String>,
}

fn valid_email(email: &str) -> bool {
    !email.is_empty() && email.len() <= MAX_EMAIL && !email.chars().any(char::is_control)
}

fn valid_password(password: &str) -> bool {
    !password.is_empty() && password.len() <= MAX_PASSWORD
}

/// Same rule as `remote_session::valid_refresh`: a non-empty opaque token with no whitespace or control characters.
fn valid_refresh(token: &str) -> bool {
    !token.is_empty() && token.len() <= MAX_TOKEN && !token.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn untrusted() -> FsError {
    herr("untrusted_core", "The saved login is used only with the LLM-IDE core this app started itself.")
}

/// Only `http://127.0.0.1:<port>` (the address the spawned core listens on). `localhost` and `[::1]` are refused:
/// one literal address keeps the trusted surface to exactly what `core_host` binds.
fn is_loopback_core_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://127.0.0.1:") else { return false };
    let port = rest.trim_end_matches('/');
    !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit())
}

/// Pure decision for a credential use. `verified` is what `CoreHost::verified_url()` returned at this moment.
/// Refuses any mode other than local, a missing verified URL, and any URL that is not the loopback core address.
pub fn credential_core(mode: ServerMode, verified: Option<String>) -> Result<String, FsError> {
    if mode != ServerMode::Local {
        return Err(untrusted());
    }
    let url = verified.ok_or_else(untrusted)?;
    if !is_loopback_core_url(&url) {
        return Err(untrusted());
    }
    Ok(url.trim_end_matches('/').to_string())
}

/// Attempts of the live gate, and the pause between them. Each attempt probes `/health` with a short timeout, so a
/// busy or just-started core can miss one probe; a few tries over about two seconds cover that without waiting long
/// on a core that is really down.
const VERIFY_ATTEMPTS: u32 = 3;
const VERIFY_PAUSE: Duration = Duration::from_millis(500);

/// Calls `probe` until it yields a value, at most `attempts` times. `pause` runs between tries, never after the last.
fn first_some<T>(attempts: u32, mut probe: impl FnMut() -> Option<T>, mut pause: impl FnMut()) -> Option<T> {
    for attempt in 0..attempts {
        if let Some(value) = probe() {
            return Some(value);
        }
        if attempt + 1 < attempts {
            pause();
        }
    }
    None
}

/// The live gate. Probes `/health` (bounded, retried), so it runs only on the blocking pool. A non-local host is
/// refused without probing at all.
fn verified_core(host: &CoreHost) -> Result<String, FsError> {
    let mode = host.mode();
    let verified = if mode == ServerMode::Local {
        first_some(VERIFY_ATTEMPTS, || host.verified_url(), || std::thread::sleep(VERIFY_PAUSE))
    } else {
        None
    };
    credential_core(mode, verified)
}

/// Maps the core's answer to `/auth/login`. Only HTTP 200 with a refresh token is accepted: a 3xx, 201 or any
/// other status is an error, so a redirect or an odd answer never counts as a verified login.
fn parse_login_answer(status: u16, body: &str) -> Result<String, FsError> {
    match status {
        200 => {
            let v: serde_json::Value = serde_json::from_str(body)
                .map_err(|_| herr("bad_core_response", "The local core's sign-in answer was not understood."))?;
            v.get("refreshToken")
                .and_then(|t| t.as_str())
                .filter(|t| valid_refresh(t))
                .map(str::to_string)
                .ok_or_else(|| herr("bad_core_response", "The local core did not issue a session."))
        }
        // The core answers 401/403 for a wrong or disabled account: the password is refused.
        401 | 403 => Err(herr("login_rejected", "The email or password is incorrect.")),
        code => Err(herr("login_failed", format!("The local core refused the sign-in (HTTP {code})."))),
    }
}

fn read_entry(b: &dyn SecretBackend) -> Result<Option<StoredLogin>, FsError> {
    let Some(raw) = b.get(ACCOUNT_LOCAL_LOGIN).map_err(|e| herr("keychain_unavailable", e.to_string()))? else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    // An unreadable entry reads as absent; the next save overwrites it.
    Ok(serde_json::from_str::<StoredLogin>(&raw).ok().filter(|s| s.v == STORED_VERSION))
}

fn write_entry(b: &dyn SecretBackend, entry: &StoredLogin) -> Result<(), FsError> {
    let body = serde_json::to_string(entry).map_err(|e| herr("login_failed", format!("could not encode the saved login: {e}")))?;
    b.set(ACCOUNT_LOCAL_LOGIN, &body).map_err(|e| herr("keychain_unavailable", e.to_string()))
}

/// The entry, but only when it was saved from this data dir (reads only; never a delete).
fn entry_for(b: &dyn SecretBackend, data_dir: &str) -> Result<Option<StoredLogin>, FsError> {
    Ok(read_entry(b)?.filter(|e| e.data_dir == data_dir))
}

/// Saves the account AFTER the local core has verified the password: `login` performs the sign-in and returns the
/// refresh token. Nothing is stored unless `login` succeeds. The entry replaces any previous one, whatever its dir.
pub fn save_with(
    b: &dyn SecretBackend,
    data_dir: &str,
    email: &str,
    password: &str,
    login: impl FnOnce(&str, &str) -> Result<String, FsError>,
) -> Result<String, FsError> {
    if !valid_email(email) {
        return Err(herr("invalid_email", "Enter the email address of this account."));
    }
    if !valid_password(password) {
        return Err(herr("invalid_password", "Enter the password."));
    }
    let refresh = login(email, password)?;
    write_entry(
        b,
        &StoredLogin { v: STORED_VERSION, data_dir: data_dir.into(), email: email.into(), password: password.into(), refresh: refresh.clone() },
    )?;
    Ok(refresh)
}

/// The stored refresh token, only for this data dir. A mismatch returns None and leaves the entry in place.
pub fn session(b: &dyn SecretBackend, data_dir: &str) -> Result<Option<String>, FsError> {
    Ok(entry_for(b, data_dir)?.map(|e| e.refresh).filter(|t| valid_refresh(t)))
}

pub fn status(b: &dyn SecretBackend, data_dir: &str) -> Result<LocalLoginStatus, FsError> {
    let entry = entry_for(b, data_dir)?.filter(|e| !e.password.is_empty());
    Ok(LocalLoginStatus { saved: entry.is_some(), email: entry.map(|e| e.email) })
}

/// Replaces the refresh token, but only when `email` (the signed-in user's) matches the stored account, compared
/// case-insensitively. Anything else, including no entry, is a no-op, so a rotation can never attach another
/// account's token to a saved password.
pub fn store_refresh(b: &dyn SecretBackend, data_dir: &str, email: &str, refresh: &str) -> Result<(), FsError> {
    if !valid_refresh(refresh) {
        return Err(herr("invalid_session", "the refresh token is not valid"));
    }
    let Some(mut entry) = entry_for(b, data_dir)? else { return Ok(()) };
    if !entry.email.eq_ignore_ascii_case(email.trim()) {
        return Ok(());
    }
    entry.refresh = refresh.into();
    write_entry(b, &entry)
}

/// Clears the saved login whatever dir saved it. Writes an empty value because `SecretBackend` has no delete.
pub fn forget(b: &dyn SecretBackend) -> Result<(), FsError> {
    b.set(ACCOUNT_LOCAL_LOGIN, "").map_err(|e| herr("keychain_unavailable", e.to_string()))
}

/// Signs in again with the saved password (through `login`, which returns the new refresh token) and keeps it.
/// No entry for this dir means `None` and `login` is not called. A rejected password leaves the entry intact,
/// so the user can update it from Settings.
pub fn relogin_with(
    b: &dyn SecretBackend,
    data_dir: &str,
    login: impl FnOnce(&str, &str) -> Result<String, FsError>,
) -> Result<Option<String>, FsError> {
    let Some(entry) = entry_for(b, data_dir)?.filter(|e| !e.password.is_empty()) else { return Ok(None) };
    let refresh = login(&entry.email, &entry.password)?;
    store_refresh(b, data_dir, &entry.email, &refresh)?;
    Ok(Some(refresh))
}

/// The real sign-in against the verified local core. The password goes only in the request body; redirects are
/// refused so the body can never be replayed to another URL.
fn http_login(url: &str, email: &str, password: &str) -> Result<String, FsError> {
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(LOGIN_TIMEOUT).build();
    let body = serde_json::json!({ "email": email, "password": password }).to_string();
    match agent.post(&format!("{url}/auth/login")).set("Content-Type", "application/json").send_string(&body) {
        Ok(resp) => {
            let status = resp.status();
            let text = resp.into_string().map_err(|_| herr("bad_core_response", "The local core's sign-in answer was not understood."))?;
            parse_login_answer(status, &text)
        }
        Err(ureq::Error::Status(code, _)) => parse_login_answer(code, ""),
        Err(ureq::Error::Transport(_)) => Err(herr("unreachable", "The local core did not answer.")),
    }
}

fn backend() -> Result<Box<dyn SecretBackend>, FsError> {
    crate::secrets::default_backend().map_err(|e| herr("keychain_unavailable", e.to_string()))
}

fn current_data_dir() -> Result<String, FsError> {
    let dir = crate::fsutil::desktop_data_dir().map_err(|e| herr("io", e))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Keychain, `/health` probe and HTTP calls block, so they run off the command thread.
async fn blocking<T, F>(f: F) -> Result<T, FsError>
where
    T: Send + 'static,
    F: FnOnce(&dyn SecretBackend, &str) -> Result<T, FsError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let b = backend()?;
        let dir = current_data_dir()?;
        f(b.as_ref(), &dir)
    })
    .await
    .map_err(|e| herr("io", format!("local login task failed: {e}")))?
}

/// Verifies the password with the local core, then saves it. Returns the new refresh token.
#[tauri::command]
pub async fn local_login_save(host: State<'_, CoreHost>, email: String, password: String) -> Result<String, FsError> {
    let host = host.inner().clone();
    let email = email.trim().to_string();
    blocking(move |b, dir| {
        save_with(b, dir, &email, &password, |e: &str, p: &str| -> Result<String, FsError> {
            let url = verified_core(&host)?;
            http_login(&url, e, p)
        })
    })
    .await
}

#[tauri::command]
pub async fn local_login_session(host: State<'_, CoreHost>) -> Result<Option<String>, FsError> {
    let host = host.inner().clone();
    // The token is read first and released only after the gate passes.
    blocking(move |b, dir| {
        let token = session(b, dir)?;
        verified_core(&host)?;
        Ok(token)
    })
    .await
}

#[tauri::command]
pub async fn local_login_relogin(host: State<'_, CoreHost>) -> Result<Option<String>, FsError> {
    let host = host.inner().clone();
    // The entry is read first; the gate runs inside the login closure, immediately before the POST. A slow keychain
    // prompt therefore cannot stretch the window between the verified core check and the request.
    blocking(move |b, dir| {
        relogin_with(b, dir, |e: &str, p: &str| -> Result<String, FsError> {
            let url = verified_core(&host)?;
            http_login(&url, e, p)
        })
    })
    .await
}

#[tauri::command]
pub async fn local_login_store_refresh(host: State<'_, CoreHost>, email: String, refresh: String) -> Result<(), FsError> {
    let host = host.inner().clone();
    blocking(move |b, dir| {
        verified_core(&host)?;
        store_refresh(b, dir, &email, &refresh)
    })
    .await
}

/// Needs no trust: it reports only whether a login is saved and its (non-secret) email.
#[tauri::command]
pub async fn local_login_status() -> Result<LocalLoginStatus, FsError> {
    blocking(|b, dir| status(b, dir)).await
}

/// Needs no trust: clearing a saved login is always allowed (the explicit sign-out path calls it).
#[tauri::command]
pub async fn local_login_forget() -> Result<(), FsError> {
    blocking(|b, _dir| forget(b)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    const DIR: &str = "/Users/a/Library/Application Support/llm-ide-desktop";
    const OTHER: &str = "/Users/a/elsewhere";
    const MAIL: &str = "dev@example.com";
    const CORE: &str = "http://127.0.0.1:3456";

    fn stored_raw(b: &MemoryBackend) -> String {
        b.get(ACCOUNT_LOCAL_LOGIN).unwrap().unwrap_or_default()
    }

    /// Saves through the verified path with a fake core that issues `refresh`.
    fn seed(b: &MemoryBackend, dir: &str, email: &str, pw: &str, refresh: &str) {
        save_with(b, dir, email, pw, |_, _| Ok(refresh.to_string())).unwrap();
    }

    #[test]
    fn save_stores_only_what_the_verified_login_returned() {
        let b = MemoryBackend::default();
        let got = save_with(&b, DIR, MAIL, "pw-1", |e, p| {
            assert_eq!((e, p), (MAIL, "pw-1"));
            Ok("refresh-1".into())
        })
        .unwrap();
        assert_eq!(got, "refresh-1");
        assert_eq!(status(&b, DIR).unwrap(), LocalLoginStatus { saved: true, email: Some(MAIL.into()) });
        assert_eq!(session(&b, DIR).unwrap().as_deref(), Some("refresh-1"));
    }

    #[test]
    fn a_refused_login_stores_nothing() {
        let b = MemoryBackend::default();
        let err = save_with(&b, DIR, MAIL, "wrong", |_, _| Err(herr("login_rejected", "no"))).unwrap_err();
        assert_eq!(err.code, "login_rejected");
        assert!(stored_raw(&b).is_empty(), "a rejected password writes nothing");
    }

    #[test]
    fn validation_runs_before_the_core_is_asked() {
        let b = MemoryBackend::default();
        let never = |_: &str, _: &str| -> Result<String, FsError> { panic!("the core must not be asked for invalid input") };
        assert!(save_with(&b, DIR, "", "pw", never).is_err());
        assert!(save_with(&b, DIR, &"a".repeat(255), "pw", never).is_err());
        assert!(save_with(&b, DIR, "a@x\n.com", "pw", never).is_err());
        assert!(save_with(&b, DIR, MAIL, "", never).is_err());
        assert!(save_with(&b, DIR, MAIL, &"p".repeat(1025), never).is_err());
        assert!(stored_raw(&b).is_empty());
    }

    #[test]
    fn one_slot_save_replaces_an_entry_from_another_dir() {
        let b = MemoryBackend::default();
        seed(&b, DIR, MAIL, "pw-1", "refresh-1");
        seed(&b, OTHER, "other@example.com", "pw-2", "refresh-2");
        assert!(!status(&b, DIR).unwrap().saved, "the first dir's entry is replaced");
        assert_eq!(session(&b, OTHER).unwrap().as_deref(), Some("refresh-2"));
    }

    #[test]
    fn a_different_data_dir_is_ignored_on_read_only() {
        let b = MemoryBackend::default();
        seed(&b, DIR, MAIL, "pw-1", "refresh-1");
        assert_eq!(session(&b, OTHER).unwrap(), None);
        assert!(!status(&b, OTHER).unwrap().saved);
        let relogin = relogin_with(&b, OTHER, |_, _| panic!("must not sign in from another data dir")).unwrap();
        assert_eq!(relogin, None);
        assert!(!stored_raw(&b).is_empty(), "a read never deletes the entry");
    }

    #[test]
    fn store_refresh_needs_a_matching_email_and_an_entry() {
        let b = MemoryBackend::default();
        store_refresh(&b, DIR, MAIL, "refresh-x").unwrap();
        assert!(stored_raw(&b).is_empty(), "no entry means a rotation cannot create a login");
        seed(&b, DIR, MAIL, "pw", "refresh-1");
        store_refresh(&b, DIR, "someone-else@example.com", "refresh-2").unwrap();
        assert_eq!(session(&b, DIR).unwrap().as_deref(), Some("refresh-1"), "another account's token is not attached");
        store_refresh(&b, DIR, "DEV@example.com", "refresh-3").unwrap();
        assert_eq!(session(&b, DIR).unwrap().as_deref(), Some("refresh-3"), "the email match ignores case");
        assert!(store_refresh(&b, DIR, MAIL, "").is_err(), "clearing goes through forget");
        assert!(store_refresh(&b, DIR, MAIL, "has space").is_err());
    }

    #[test]
    fn forget_clears_the_entry_whatever_dir_saved_it() {
        let b = MemoryBackend::default();
        seed(&b, DIR, MAIL, "pw", "refresh-1");
        forget(&b).unwrap();
        assert!(!status(&b, DIR).unwrap().saved);
        assert!(stored_raw(&b).is_empty());
    }

    #[test]
    fn relogin_stores_the_new_refresh_and_keeps_the_entry_on_rejection() {
        let b = MemoryBackend::default();
        seed(&b, DIR, MAIL, "pw-1", "refresh-old");
        let got = relogin_with(&b, DIR, |email, password| {
            assert_eq!((email, password), (MAIL, "pw-1"));
            Ok("refresh-new".into())
        })
        .unwrap();
        assert_eq!(got.as_deref(), Some("refresh-new"));
        assert_eq!(session(&b, DIR).unwrap().as_deref(), Some("refresh-new"));
        let rejected = relogin_with(&b, DIR, |_, _| Err(herr("login_rejected", "no")));
        assert_eq!(rejected.unwrap_err().code, "login_rejected");
        assert!(status(&b, DIR).unwrap().saved, "a rejected password keeps the entry so the user can update it");
    }

    #[test]
    fn relogin_without_an_entry_does_not_call_the_core() {
        let b = MemoryBackend::default();
        assert_eq!(relogin_with(&b, DIR, |_, _| panic!("no saved login, nothing to send")).unwrap(), None);
    }

    #[test]
    fn only_a_spawned_verified_local_core_gets_credentials() {
        assert_eq!(credential_core(ServerMode::Local, Some(CORE.into())).unwrap(), CORE);
        assert_eq!(credential_core(ServerMode::Local, Some("http://127.0.0.1:3456/".into())).unwrap(), CORE);
        // Remote and SSH modes never qualify, whatever the core answers.
        assert_eq!(credential_core(ServerMode::Remote, Some(CORE.into())).unwrap_err().code, "untrusted_core");
        assert_eq!(credential_core(ServerMode::Ssh, Some(CORE.into())).unwrap_err().code, "untrusted_core");
        // No verified URL: the core is stopped, not Ready, adopted, pending, or failed its nonce check.
        assert_eq!(credential_core(ServerMode::Local, None).unwrap_err().code, "untrusted_core");
    }

    #[test]
    fn only_the_literal_loopback_address_counts_as_the_local_core() {
        assert!(is_loopback_core_url("http://127.0.0.1:3456"));
        assert!(is_loopback_core_url("http://127.0.0.1:3457/"));
        assert!(!is_loopback_core_url("http://localhost:3456"), "localhost is not the bound address");
        assert!(!is_loopback_core_url("http://[::1]:3456"));
        assert!(!is_loopback_core_url("http://127.0.0.1.example.com:3456"), "a hostname is not loopback");
        assert!(!is_loopback_core_url("https://127.0.0.1:3456"), "the spawned core is plain http");
        assert!(!is_loopback_core_url("http://192.168.1.5:3456"));
        assert!(!is_loopback_core_url("http://127.0.0.1:"));
        assert!(!is_loopback_core_url("http://127.0.0.1:3456@evil.example.com"));
    }

    #[test]
    fn only_http_200_with_a_refresh_token_is_a_verified_login() {
        let ok = r#"{"user":{"id":"u"},"accessToken":"a","refreshToken":"refresh-ok"}"#;
        assert_eq!(parse_login_answer(200, ok).unwrap(), "refresh-ok");
        assert_eq!(parse_login_answer(200, "not json").unwrap_err().code, "bad_core_response");
        assert_eq!(parse_login_answer(200, r#"{"accessToken":"a"}"#).unwrap_err().code, "bad_core_response");
        for code in [201u16, 204, 302, 500] {
            assert_eq!(parse_login_answer(code, ok).unwrap_err().code, "login_failed", "HTTP {code}");
        }
        assert_eq!(parse_login_answer(401, "").unwrap_err().code, "login_rejected");
        assert_eq!(parse_login_answer(403, "").unwrap_err().code, "login_rejected");
    }

    #[test]
    fn the_live_gate_retries_a_missed_probe_but_not_forever() {
        // A probe that misses once, then answers: one pause, and the value comes back.
        let mut calls = 0;
        let mut pauses = 0;
        let got = first_some(3, || {
            calls += 1;
            (calls == 2).then_some("https://core")
        }, || pauses += 1);
        assert_eq!(got, Some("https://core"));
        assert_eq!((calls, pauses), (2, 1));

        // A core that never answers: every attempt is used, with a pause between them and none after the last.
        let mut calls = 0;
        let mut pauses = 0;
        let got: Option<&str> = first_some(3, || { calls += 1; None }, || pauses += 1);
        assert_eq!(got, None);
        assert_eq!((calls, pauses), (3, 2));
    }

    #[test]
    fn debug_never_prints_the_password_or_the_token() {
        let s = StoredLogin { v: 1, data_dir: DIR.into(), email: MAIL.into(), password: "hunter2-secret".into(), refresh: "refresh-secret".into() };
        let dbg = format!("{s:?}");
        assert!(!dbg.contains("hunter2-secret") && !dbg.contains("refresh-secret") && !dbg.contains(MAIL));
    }
}
