//! The hub session in the OS keychain, bound to the hub URL and its TLS pin.
//!
//! A refresh token is a long-lived credential. It is stored as one JSON entry (`hub-session`) and
//! returned only when the current `remote_server.hub_url` and `remote_server.tls_pin` match the
//! values it was stored with. A re-pointed or re-keyed hub therefore gets nothing; the old entry is
//! deleted on the mismatch. Nothing here logs or Debug-prints the token.

use serde::{Deserialize, Serialize};

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::secrets::{SecretBackend, ACCOUNT_HUB_SESSION};

const MAX_TOKEN: usize = 4096;

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
struct StoredSession {
    v: u8,
    hub: String,
    pin: String,
    refresh: String,
}

impl std::fmt::Debug for StoredSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StoredSession { v: 1, hub: <redacted>, pin: <redacted>, refresh: <redacted> }")
    }
}

fn valid_hub(hub: &str) -> bool {
    hub.starts_with("https://") && hub.len() <= 300 && !hub.contains('@') && !hub.contains(['\r', '\n', ' ', '\t'])
}

fn valid_pin(pin: &str) -> bool {
    pin.len() == 50 && pin.starts_with("sha256:") && pin[7..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_refresh(token: &str) -> bool {
    !token.is_empty() && token.len() <= MAX_TOKEN && !token.chars().any(|c| c.is_control() || c.is_whitespace())
}

pub fn store(b: &dyn SecretBackend, hub: &str, pin: &str, refresh: &str) -> Result<(), FsError> {
    if !valid_hub(hub) { return Err(herr("invalid_hub", "the hub URL is not valid")); }
    if !valid_pin(pin) { return Err(herr("invalid_pin", "the TLS pin is not valid")); }
    if !valid_refresh(refresh) { return Err(herr("invalid_session", "the refresh token is not valid")); }
    let body = serde_json::to_string(&StoredSession { v: 1, hub: hub.to_string(), pin: pin.to_string(), refresh: refresh.to_string() })
        .map_err(|e| herr("session_failed", format!("could not encode the session: {e}")))?;
    b.set(ACCOUNT_HUB_SESSION, &body).map_err(|e| herr("keychain_unavailable", e.to_string()))
}

/// The refresh token, only when the stored hub and pin still match `hub`/`pin`. A mismatch deletes
/// the entry: it must never be replayed to a different (or re-keyed) host.
pub fn load(b: &dyn SecretBackend, hub: &str, pin: &str) -> Result<Option<String>, FsError> {
    let Some(raw) = b.get(ACCOUNT_HUB_SESSION).map_err(|e| herr("keychain_unavailable", e.to_string()))? else { return Ok(None); };
    let parsed: StoredSession = match serde_json::from_str(&raw) { Ok(v) => v, Err(_) => { clear(b)?; return Ok(None); } };
    if parsed.v != 1 || parsed.hub != hub || parsed.pin != pin || !valid_refresh(&parsed.refresh) {
        clear(b)?;
        return Ok(None);
    }
    Ok(Some(parsed.refresh))
}

pub fn clear(b: &dyn SecretBackend) -> Result<(), FsError> {
    // There is no delete in `SecretBackend` (the OS stores used here implement `set` only); writing an
    // empty value is the portable "no session" state and `load` treats it as absent.
    b.set(ACCOUNT_HUB_SESSION, "").map_err(|e| herr("keychain_unavailable", e.to_string()))
}

pub fn stored_present(b: &dyn SecretBackend) -> bool {
    b.get(ACCOUNT_HUB_SESSION).ok().flatten().is_some_and(|v| !v.is_empty())
}

#[tauri::command]
pub fn remote_session_store(hub: String, pin: String, refresh: String) -> Result<(), FsError> {
    let b = crate::secrets::default_backend().map_err(|e| herr("keychain_unavailable", e.to_string()))?;
    store(b.as_ref(), &hub, &pin, &refresh)
}

#[tauri::command]
pub fn remote_session_load(hub: String, pin: String) -> Result<Option<String>, FsError> {
    let b = crate::secrets::default_backend().map_err(|e| herr("keychain_unavailable", e.to_string()))?;
    load(b.as_ref(), &hub, &pin)
}

#[tauri::command]
pub fn remote_session_clear() -> Result<(), FsError> {
    let b = crate::secrets::default_backend().map_err(|e| herr("keychain_unavailable", e.to_string()))?;
    clear(b.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    const HUB: &str = "https://hub.example.com";
    const PIN: &str = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn a_session_is_bound_to_the_hub_and_pin() {
        let b = MemoryBackend::default();
        store(&b, HUB, PIN, "refresh-1").unwrap();
        assert_eq!(load(&b, HUB, PIN).unwrap().as_deref(), Some("refresh-1"));
        let other = "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        assert_eq!(load(&b, HUB, other).unwrap(), None);
        assert!(!stored_present(&b), "a mismatch clears the entry");
        store(&b, HUB, PIN, "refresh-2").unwrap();
        assert_eq!(load(&b, "https://evil.example.com", PIN).unwrap(), None);
        assert!(!stored_present(&b));
    }

    #[test]
    fn debug_never_prints_the_token() {
        let s = StoredSession { v: 1, hub: HUB.into(), pin: PIN.into(), refresh: "super-secret".into() };
        assert!(!format!("{s:?}").contains("super-secret"));
    }
}
