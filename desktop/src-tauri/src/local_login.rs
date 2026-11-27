//! The login (email, password and refresh token) kept in the OS keychain, for the local core or for one SSH server.
//!
//! Why: a core's session lives only in memory, so every launch asked for the password again. The account is kept
//! here so the app can sign in at each start. The password is the sensitive part: it is given to the core it was
//! saved for and nowhere else.
//!
//! TRUST RULE (MUST): the password and the refresh token are sent only to a core the host verified RIGHT NOW,
//! for the scope the credential belongs to (see `login_scope.rs`). Local: `CoreHost::verified_url()` re-probes
//! `/health` for this launch's nonce. SSH: `CoreHost::ssh_forward()` needs a connected link with a pinned host
//! key and a fresh `/health` that echoes the link's nonce; the full gate then adds a STATUS run over SSH as the SSH
//! user. STATUS reads that user's own 0600 `state.json` and accepts only a process owned by that same user, so
//! another account on the server cannot make it report a core of theirs (`/health` alone could be echoed by a
//! co-tenant who binds the freed port). That is not a secret-based proof: a full fix needs a challenge the core
//! answers with a secret `/health` never reveals. `store_refresh` sends no secret and uses the probe-only gate.
//! Hub mode never qualifies. Every credential-releasing command (save, session, relogin) calls
//! `verified_core()` immediately before it uses the credential, inside the blocking task; `store_refresh` uses
//! `verified_core_for_rotation()` instead. A credential read
//! for one scope is refused when the verified core is for another. Cached status fields are never trusted here.
//!
//! One keychain slot per scope: `local-login` for the local core, `ssh-login:<server key>` per SSH server. Save and
//! forget replace or clear only their scope's slot. READS ignore an entry whose stored id is not the scope's
//! (the entry is never deleted by a read).
//!
//! Nothing here logs, returns or Debug-prints the password. The webview gets the refresh token only (like
//! the hub session) and can never read the password back; the status command returns the email alone.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::confirm::herr;
use crate::core_host::{CoreHost, SshForward};
use crate::ssh_link::ConfirmInput;
use crate::fs_ops::FsError;
use crate::prefs::ServerMode;
use crate::login_scope::{self, credential_core, ensure_same, LoginScope, Verified};
use crate::secrets::SecretBackend;
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
    /// The scope id the login was saved for: the desktop data dir (local) or `<server key>#<host key fingerprint>`
    /// (SSH). Only reads check it; a mismatch is never deleted. The field keeps its name so older entries stay
    /// readable.
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

/// The FULL gate, for every command that releases a credential (`save`, `session`, `relogin`). Probes `/health`
/// (bounded, retried), and in SSH mode then asks the server over SSH (STATUS, one try, short deadline: a "no" or a
/// timeout is final). Runs only on the blocking pool. Hub mode is refused without probing at all. Returns the
/// verified URL with the scope it was verified for.
fn verified_core(host: &CoreHost) -> Result<Verified, FsError> {
    gate(host, true)
}

/// The ROTATION gate, for `store_refresh` alone: the same checks without the STATUS step. It sends no secret to the
/// core (it only writes the keychain, into the scope of the live link), and it runs on every refresh rotation, where
/// an ssh login per call would be a cost and a silent failure point.
fn verified_core_for_rotation(host: &CoreHost) -> Result<Verified, FsError> {
    gate(host, false)
}

fn gate(host: &CoreHost, with_status: bool) -> Result<Verified, FsError> {
    gate_with(host, with_status, || host.ssh_forward(), |input| input.is_some_and(|input| input.confirms()))
}

/// [`gate`] with the SSH probe and the STATUS confirmation injected, so a test can drive the real decision.
fn gate_with(
    host: &CoreHost,
    with_status: bool,
    forward: impl FnMut() -> Option<SshForward>,
    confirm: impl FnOnce(Option<ConfirmInput>) -> bool,
) -> Result<Verified, FsError> {
    let mode = host.mode();
    let pause = || std::thread::sleep(VERIFY_PAUSE);
    let verified = match mode {
        ServerMode::Local => match first_some(VERIFY_ATTEMPTS, || host.verified_url(), pause) {
            Some(url) => Some(Verified { url, scope: LoginScope::Local { data_dir: current_data_dir()? } }),
            None => None,
        },
        // Only the missed-probe case is retried; STATUS answers once.
        ServerMode::Ssh => first_some(VERIFY_ATTEMPTS, forward, pause)
            .and_then(|forward| if with_status { forward.confirmed_with(confirm) } else { Some(forward.unconfirmed()) })
            .map(|(url, server_key, host_key_fp)| Verified { url, scope: LoginScope::Ssh { server_key, host_key_fp } }),
        ServerMode::Remote => None,
    };
    credential_core(mode, verified)
}

/// Maps the core's answer to `/auth/login`. Only HTTP 200 with a refresh token is accepted: a 3xx, 201 or any
/// other status is an error, so a redirect or an odd answer never counts as a verified login.
fn parse_login_answer(status: u16, body: &str) -> Result<String, FsError> {
    match status {
        200 => {
            let v: serde_json::Value = serde_json::from_str(body)
                .map_err(|_| herr("bad_core_response", "The core's sign-in answer was not understood."))?;
            v.get("refreshToken")
                .and_then(|t| t.as_str())
                .filter(|t| valid_refresh(t))
                .map(str::to_string)
                .ok_or_else(|| herr("bad_core_response", "The core did not issue a session."))
        }
        // The core answers 401/403 for a wrong or disabled account: the password is refused.
        401 | 403 => Err(herr("login_rejected", "The email or password is incorrect.")),
        code => Err(herr("login_failed", format!("The core refused the sign-in (HTTP {code})."))),
    }
}

fn read_entry(b: &dyn SecretBackend, scope: &LoginScope) -> Result<Option<StoredLogin>, FsError> {
    let Some(raw) = b.get(&scope.account()).map_err(|e| herr("keychain_unavailable", e.to_string()))? else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    // An unreadable entry reads as absent; the next save overwrites it.
    Ok(serde_json::from_str::<StoredLogin>(&raw).ok().filter(|s| s.v == STORED_VERSION))
}

fn write_entry(b: &dyn SecretBackend, scope: &LoginScope, entry: &StoredLogin) -> Result<(), FsError> {
    let body = serde_json::to_string(entry).map_err(|e| herr("login_failed", format!("could not encode the saved login: {e}")))?;
    b.set(&scope.account(), &body).map_err(|e| herr("keychain_unavailable", e.to_string()))
}

/// The scope's entry, but only when it was saved for this scope id (reads only; never a delete).
fn entry_for(b: &dyn SecretBackend, scope: &LoginScope) -> Result<Option<StoredLogin>, FsError> {
    Ok(read_entry(b, scope)?.filter(|e| e.data_dir == scope.id()))
}

/// Saves the account AFTER the core has verified the password: `login` performs the sign-in and returns the refresh
/// token with the scope of the core that answered. Nothing is stored unless `login` succeeds, and the entry goes
/// into that verified scope's slot, replacing whatever it held.
pub fn save_with(
    b: &dyn SecretBackend,
    email: &str,
    password: &str,
    login: impl FnOnce(&str, &str) -> Result<(String, LoginScope), FsError>,
) -> Result<String, FsError> {
    if !valid_email(email) {
        return Err(herr("invalid_email", "Enter the email address of this account."));
    }
    if !valid_password(password) {
        return Err(herr("invalid_password", "Enter the password."));
    }
    let (refresh, scope) = login(email, password)?;
    let entry = StoredLogin { v: STORED_VERSION, data_dir: scope.id().into(), email: email.into(), password: password.into(), refresh: refresh.clone() };
    write_entry(b, &scope, &entry)?;
    Ok(refresh)
}

/// The stored refresh token, only for this scope. A mismatch returns None and leaves the entry in place.
pub(crate) fn session(b: &dyn SecretBackend, scope: &LoginScope) -> Result<Option<String>, FsError> {
    Ok(entry_for(b, scope)?.map(|e| e.refresh).filter(|t| valid_refresh(t)))
}

pub(crate) fn status(b: &dyn SecretBackend, scope: &LoginScope) -> Result<LocalLoginStatus, FsError> {
    let entry = entry_for(b, scope)?.filter(|e| !e.password.is_empty());
    Ok(LocalLoginStatus { saved: entry.is_some(), email: entry.map(|e| e.email) })
}

/// Replaces the refresh token, but only when `email` (the signed-in user's) matches the stored account, compared
/// case-insensitively. Anything else, including no entry, is a no-op, so a rotation can never attach another
/// account's token to a saved password.
pub(crate) fn store_refresh(b: &dyn SecretBackend, scope: &LoginScope, email: &str, refresh: &str) -> Result<(), FsError> {
    if !valid_refresh(refresh) {
        return Err(herr("invalid_session", "the refresh token is not valid"));
    }
    let Some(mut entry) = entry_for(b, scope)? else { return Ok(()) };
    if !entry.email.eq_ignore_ascii_case(email.trim()) {
        return Ok(());
    }
    entry.refresh = refresh.into();
    write_entry(b, scope, &entry)
}

/// Clears the scope's saved login (for local, whatever dir saved it). Writes an empty value because `SecretBackend`
/// has no delete.
pub(crate) fn forget(b: &dyn SecretBackend, scope: &LoginScope) -> Result<(), FsError> {
    b.set(&scope.account(), "").map_err(|e| herr("keychain_unavailable", e.to_string()))
}

/// Signs in again with the saved password (through `login`, which returns the new refresh token) and keeps it.
/// No entry for this scope means `None` and `login` is not called. A rejected password leaves the entry intact,
/// so the user can update it from Settings.
pub(crate) fn relogin_with(
    b: &dyn SecretBackend,
    scope: &LoginScope,
    login: impl FnOnce(&str, &str) -> Result<String, FsError>,
) -> Result<Option<String>, FsError> {
    let Some(entry) = entry_for(b, scope)?.filter(|e| !e.password.is_empty()) else { return Ok(None) };
    let refresh = login(&entry.email, &entry.password)?;
    store_refresh(b, scope, &entry.email, &refresh)?;
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
            let text = resp.into_string().map_err(|_| herr("bad_core_response", "The core's sign-in answer was not understood."))?;
            parse_login_answer(status, &text)
        }
        Err(ureq::Error::Status(code, _)) => parse_login_answer(code, ""),
        Err(ureq::Error::Transport(_)) => Err(herr("unreachable", "The core did not answer.")),
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
    F: FnOnce(&dyn SecretBackend) -> Result<T, FsError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let b = backend()?;
        f(b.as_ref())
    })
    .await
    .map_err(|e| herr("io", format!("login task failed: {e}")))?
}

/// The scope a trusted command reads for. Hub mode (and SSH with no server named) has none: the gate still runs, so
/// hub mode answers `untrusted_core` as it always did.
fn scope_or_refuse(host: &CoreHost) -> Result<LoginScope, FsError> {
    match login_scope::current_scope(host)? {
        Some(scope) => Ok(scope),
        None => {
            verified_core(host)?;
            Err(login_scope::untrusted())
        }
    }
}

/// The verified sign-in for one POST: the gate runs here, immediately before the request.
fn verified_login(host: &CoreHost, email: &str, password: &str) -> Result<(String, LoginScope), FsError> {
    let verified = verified_core(host)?;
    Ok((http_login(&verified.url, email, password)?, verified.scope))
}

/// Verifies the password with the core, then saves it for the scope that core was verified for. Returns the new
/// refresh token.
#[tauri::command]
pub async fn local_login_save(host: State<'_, CoreHost>, email: String, password: String) -> Result<String, FsError> {
    let host = host.inner().clone();
    let email = email.trim().to_string();
    blocking(move |b| save_with(b, &email, &password, |e: &str, p: &str| verified_login(&host, e, p))).await
}

#[tauri::command]
pub async fn local_login_session(host: State<'_, CoreHost>) -> Result<Option<String>, FsError> {
    let host = host.inner().clone();
    // The token is read first and released only after the gate passes for the scope it was read from.
    blocking(move |b| {
        let scope = scope_or_refuse(&host)?;
        let token = session(b, &scope)?;
        ensure_same(&scope, &verified_core(&host)?.scope)?;
        Ok(token)
    })
    .await
}

#[tauri::command]
pub async fn local_login_relogin(host: State<'_, CoreHost>) -> Result<Option<String>, FsError> {
    let host = host.inner().clone();
    // The entry is read first; the gate runs inside the login closure, immediately before the POST, and must name
    // the scope the entry was read for. A slow keychain prompt therefore cannot stretch the window between the
    // verified core check and the request.
    blocking(move |b| {
        let scope = scope_or_refuse(&host)?;
        relogin_with(b, &scope, |e: &str, p: &str| -> Result<String, FsError> {
            let verified = verified_core(&host)?;
            ensure_same(&scope, &verified.scope)?;
            http_login(&verified.url, e, p)
        })
    })
    .await
}

#[tauri::command]
pub async fn local_login_store_refresh(host: State<'_, CoreHost>, email: String, refresh: String) -> Result<(), FsError> {
    let host = host.inner().clone();
    blocking(move |b| {
        let verified = verified_core_for_rotation(&host)?;
        store_refresh(b, &verified.scope, &email, &refresh)
    })
    .await
}

/// Needs no trust: it reports only whether a login is saved for the current mode's scope and its (non-secret) email.
#[tauri::command]
pub async fn local_login_status(host: State<'_, CoreHost>) -> Result<LocalLoginStatus, FsError> {
    let host = host.inner().clone();
    blocking(move |b| match login_scope::current_scope(&host)? {
        Some(scope) => status(b, &scope),
        None => Ok(LocalLoginStatus { saved: false, email: None }),
    })
    .await
}

/// Needs no trust: clearing a saved login is always allowed (the explicit sign-out path calls it). It clears only the
/// current mode's scope, and does nothing when no scope is named.
#[tauri::command]
pub async fn local_login_forget(host: State<'_, CoreHost>) -> Result<(), FsError> {
    let host = host.inner().clone();
    blocking(move |b| match login_scope::current_scope(&host)? {
        Some(scope) => forget(b, &scope),
        None => Ok(()),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    const DIR: &str = "/Users/a/Library/Application Support/llm-ide-desktop";
    const OTHER: &str = "/Users/a/elsewhere";
    const MAIL: &str = "dev@example.com";
    const KEY_A: &str = "alice@a.example.com:22";
    const KEY_B: &str = "alice@b.example.com:22";

    fn at(dir: &str) -> LoginScope {
        LoginScope::Local { data_dir: dir.into() }
    }

    fn on(key: &str) -> LoginScope {
        under(key, "fp-1")
    }

    fn under(key: &str, fp: &str) -> LoginScope {
        LoginScope::Ssh { server_key: key.into(), host_key_fp: fp.into() }
    }

    fn stored_raw(b: &MemoryBackend) -> String {
        b.get("local-login").unwrap().unwrap_or_default()
    }

    /// Saves through the verified path with a fake core of `scope` that issues `refresh`.
    fn seed(b: &MemoryBackend, scope: &LoginScope, email: &str, pw: &str, refresh: &str) {
        save_with(b, email, pw, |_, _| Ok((refresh.to_string(), scope.clone()))).unwrap();
    }

    #[test]
    fn save_stores_only_what_the_verified_login_returned() {
        let b = MemoryBackend::default();
        let got = save_with(&b, MAIL, "pw-1", |e, p| {
            assert_eq!((e, p), (MAIL, "pw-1"));
            Ok(("refresh-1".into(), at(DIR)))
        })
        .unwrap();
        assert_eq!(got, "refresh-1");
        assert_eq!(status(&b, &at(DIR)).unwrap(), LocalLoginStatus { saved: true, email: Some(MAIL.into()) });
        assert_eq!(session(&b, &at(DIR)).unwrap().as_deref(), Some("refresh-1"));
    }

    #[test]
    fn a_refused_login_stores_nothing() {
        let b = MemoryBackend::default();
        let err = save_with(&b, MAIL, "wrong", |_, _| Err(herr("login_rejected", "no"))).unwrap_err();
        assert_eq!(err.code, "login_rejected");
        assert!(stored_raw(&b).is_empty(), "a rejected password writes nothing");
    }

    #[test]
    fn validation_runs_before_the_core_is_asked() {
        let b = MemoryBackend::default();
        let never = |_: &str, _: &str| -> Result<(String, LoginScope), FsError> { panic!("the core must not be asked for invalid input") };
        assert!(save_with(&b, "", "pw", never).is_err());
        assert!(save_with(&b, &"a".repeat(255), "pw", never).is_err());
        assert!(save_with(&b, "a@x\n.com", "pw", never).is_err());
        assert!(save_with(&b, MAIL, "", never).is_err());
        assert!(save_with(&b, MAIL, &"p".repeat(1025), never).is_err());
        assert!(stored_raw(&b).is_empty());
    }

    #[test]
    fn one_slot_save_replaces_an_entry_from_another_dir() {
        let b = MemoryBackend::default();
        seed(&b, &at(DIR), MAIL, "pw-1", "refresh-1");
        seed(&b, &at(OTHER), "other@example.com", "pw-2", "refresh-2");
        assert!(!status(&b, &at(DIR)).unwrap().saved, "the first dir's entry is replaced");
        assert_eq!(session(&b, &at(OTHER)).unwrap().as_deref(), Some("refresh-2"));
    }

    #[test]
    fn a_different_data_dir_is_ignored_on_read_only() {
        let b = MemoryBackend::default();
        seed(&b, &at(DIR), MAIL, "pw-1", "refresh-1");
        assert_eq!(session(&b, &at(OTHER)).unwrap(), None);
        assert!(!status(&b, &at(OTHER)).unwrap().saved);
        let relogin = relogin_with(&b, &at(OTHER), |_, _| panic!("must not sign in from another data dir")).unwrap();
        assert_eq!(relogin, None);
        assert!(!stored_raw(&b).is_empty(), "a read never deletes the entry");
    }

    #[test]
    fn store_refresh_needs_a_matching_email_and_an_entry() {
        let b = MemoryBackend::default();
        store_refresh(&b, &at(DIR), MAIL, "refresh-x").unwrap();
        assert!(stored_raw(&b).is_empty(), "no entry means a rotation cannot create a login");
        seed(&b, &at(DIR), MAIL, "pw", "refresh-1");
        store_refresh(&b, &at(DIR), "someone-else@example.com", "refresh-2").unwrap();
        assert_eq!(session(&b, &at(DIR)).unwrap().as_deref(), Some("refresh-1"), "another account's token is not attached");
        store_refresh(&b, &at(DIR), "DEV@example.com", "refresh-3").unwrap();
        assert_eq!(session(&b, &at(DIR)).unwrap().as_deref(), Some("refresh-3"), "the email match ignores case");
        assert!(store_refresh(&b, &at(DIR), MAIL, "").is_err(), "clearing goes through forget");
        assert!(store_refresh(&b, &at(DIR), MAIL, "has space").is_err());
    }

    #[test]
    fn forget_clears_the_entry_whatever_dir_saved_it() {
        let b = MemoryBackend::default();
        seed(&b, &at(DIR), MAIL, "pw", "refresh-1");
        forget(&b, &at(DIR)).unwrap();
        assert!(!status(&b, &at(DIR)).unwrap().saved);
        assert!(stored_raw(&b).is_empty());
    }

    #[test]
    fn relogin_stores_the_new_refresh_and_keeps_the_entry_on_rejection() {
        let b = MemoryBackend::default();
        seed(&b, &at(DIR), MAIL, "pw-1", "refresh-old");
        let got = relogin_with(&b, &at(DIR), |email, password| {
            assert_eq!((email, password), (MAIL, "pw-1"));
            Ok("refresh-new".into())
        })
        .unwrap();
        assert_eq!(got.as_deref(), Some("refresh-new"));
        assert_eq!(session(&b, &at(DIR)).unwrap().as_deref(), Some("refresh-new"));
        let rejected = relogin_with(&b, &at(DIR), |_, _| Err(herr("login_rejected", "no")));
        assert_eq!(rejected.unwrap_err().code, "login_rejected");
        assert!(status(&b, &at(DIR)).unwrap().saved, "a rejected password keeps the entry so the user can update it");
    }

    #[test]
    fn relogin_without_an_entry_does_not_call_the_core() {
        let b = MemoryBackend::default();
        assert_eq!(relogin_with(&b, &at(DIR), |_, _| panic!("no saved login, nothing to send")).unwrap(), None);
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

    #[test]
    fn ssh_login_is_kept_per_server() {
        let b = MemoryBackend::default();
        seed(&b, &on(KEY_A), MAIL, "pw-a", "refresh-a");
        // Server B, the local slot and a different local dir see nothing of A's login.
        assert!(!status(&b, &on(KEY_B)).unwrap().saved);
        assert_eq!(session(&b, &on(KEY_B)).unwrap(), None);
        assert!(!status(&b, &at(DIR)).unwrap().saved);
        // Saving B leaves A alone; saving SSH never touches `local-login`, and local never touches SSH.
        seed(&b, &on(KEY_B), "bob@example.com", "pw-b", "refresh-b");
        assert!(stored_raw(&b).is_empty(), "an SSH save never writes the local slot");
        seed(&b, &at(DIR), "local@example.com", "pw-l", "refresh-l");
        assert_eq!(session(&b, &on(KEY_A)).unwrap().as_deref(), Some("refresh-a"));
        assert_eq!(session(&b, &on(KEY_B)).unwrap().as_deref(), Some("refresh-b"));
        // Forgetting A leaves B and the local slot intact.
        forget(&b, &on(KEY_A)).unwrap();
        assert!(!status(&b, &on(KEY_A)).unwrap().saved);
        assert_eq!(session(&b, &on(KEY_B)).unwrap().as_deref(), Some("refresh-b"));
        assert_eq!(session(&b, &at(DIR)).unwrap().as_deref(), Some("refresh-l"));
        // Forgetting local leaves the servers alone.
        forget(&b, &at(DIR)).unwrap();
        assert_eq!(session(&b, &on(KEY_B)).unwrap().as_deref(), Some("refresh-b"));
    }

    #[test]
    fn a_login_is_saved_under_the_scope_that_was_verified() {
        let b = MemoryBackend::default();
        // The login closure reports the scope of the core that answered: that slot is the one written.
        save_with(&b, MAIL, "pw", |_, _| Ok(("refresh-1".into(), on(KEY_B)))).unwrap();
        assert!(status(&b, &on(KEY_B)).unwrap().saved);
        assert!(!status(&b, &on(KEY_A)).unwrap().saved);
    }

    #[test]
    fn a_login_is_sent_only_to_the_server_it_was_saved_for() {
        let b = MemoryBackend::default();
        seed(&b, &on(KEY_A), MAIL, "pw-a", "refresh-a");
        // Connected to B: the entry for B is absent, so there is nothing to send, and A's password is never offered.
        let sent = relogin_with(&b, &on(KEY_B), |_, _| panic!("A's password must not reach server B")).unwrap();
        assert_eq!(sent, None);
        // The command's extra gate: a login read for A is refused when the verified core is B's.
        let read_for = on(KEY_A);
        let verified = on(KEY_B);
        let refused = relogin_with(&b, &read_for, |_, _| {
            ensure_same(&read_for, &verified)?;
            panic!("the POST must not run for another server");
        });
        assert_eq!(refused.unwrap_err().code, "untrusted_core");
        let token = session(&b, &read_for).unwrap();
        assert!(token.is_some() && ensure_same(&read_for, &verified).is_err(), "no token is released for another scope");
        assert!(status(&b, &read_for).unwrap().saved, "a refusal never deletes the entry");
    }

    #[test]
    fn a_login_saved_under_another_host_key_is_never_read() {
        let b = MemoryBackend::default();
        seed(&b, &under(KEY_A, "fp-A"), MAIL, "pw-a", "refresh-a");
        let after_change = under(KEY_A, "fp-B");
        // Same server key, same keychain slot, other pinned host key: the old entry is unreadable.
        assert_eq!(session(&b, &after_change).unwrap(), None);
        assert!(!status(&b, &after_change).unwrap().saved);
        assert_eq!(relogin_with(&b, &after_change, |_, _| panic!("the old key's password must not be sent")).unwrap(), None);
        store_refresh(&b, &after_change, MAIL, "refresh-x").unwrap();
        assert_eq!(session(&b, &under(KEY_A, "fp-A")).unwrap().as_deref(), Some("refresh-a"), "a rotation never touches it");
        // Saving under the new key overwrites the stale entry in the same slot.
        seed(&b, &after_change, MAIL, "pw-b", "refresh-b");
        assert!(!status(&b, &under(KEY_A, "fp-A")).unwrap().saved);
        assert_eq!(session(&b, &after_change).unwrap().as_deref(), Some("refresh-b"));
        // Forget works by server key alone, whatever fingerprint is stored.
        forget(&b, &under(KEY_A, "")).unwrap();
        assert!(!status(&b, &after_change).unwrap().saved);
    }

    #[test]
    fn store_refresh_does_not_run_status() {
        use crate::ssh_link::{gated_for_test, LinkState};
        let _mode = crate::core_host::process_mode_guard();
        let host = CoreHost::new();
        host.set_mode(ServerMode::Ssh);
        host.attach_ssh_link(gated_for_test(LinkState::Connected, "n1", KEY_A, Some("fp-1")));
        let healthy = || host.ssh_forward_with(|_| Some("n1".to_string()));
        let status_calls = std::cell::Cell::new(0);
        let answer = |yes: bool| {
            let calls = &status_calls;
            move |_input: Option<ConfirmInput>| {
                calls.set(calls.get() + 1);
                yes
            }
        };
        let scope = under(KEY_A, "fp-1");

        // Rotation gate (`with_status = false`): the verified scope, and STATUS is never asked.
        let got = gate_with(&host, false, healthy, answer(true)).unwrap();
        assert_eq!(got.scope, scope);
        assert_eq!(status_calls.get(), 0);

        // Full gate (save, session, relogin): STATUS is asked exactly once.
        let got = gate_with(&host, true, healthy, answer(true)).unwrap();
        assert_eq!(got.scope, scope);
        assert_eq!(status_calls.get(), 1);

        // A "no" is final: untrusted, one STATUS call, and the probe is not retried because of it.
        let probes = std::cell::Cell::new(0);
        let counted = || {
            probes.set(probes.get() + 1);
            healthy()
        };
        let refused = gate_with(&host, true, counted, answer(false)).unwrap_err();
        assert_eq!(refused.code, "untrusted_core");
        assert_eq!((status_calls.get(), probes.get()), (2, 1));
        host.set_mode(ServerMode::Local);
    }
}
