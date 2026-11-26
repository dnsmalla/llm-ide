//! The SSH login password the user chose to remember ("Remember password in Keychain"), kept in the same single
//! keychain item as the other secrets (`secrets_bundle`): each login is one more key in that item, so there is no new
//! keychain item and no new prompt on macOS.
//!
//! Rules:
//! - The webview never receives a stored password. It sends only flags (`useSavedPassword`, `rememberPassword`); the
//!   host reads the password here when it connects.
//! - Nothing here logs, formats or returns the password in an error. The error texts are fixed.
//! - The keychain has no delete, so forgetting writes an empty value (like `local_login::forget`). An empty value
//!   reads as "no password".
//! - The list never reads the keychain: `prefs::SshRecentServer::password_saved` is the non-secret flag that says
//!   whether to look.

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::secrets::SecretBackend;

const MAX_PASSWORD: usize = 1024;
const ACCOUNT_PREFIX: &str = "ssh-password:";

fn unavailable() -> FsError {
    herr("keychain_unavailable", "The Keychain is not available, so the password could not be saved or read.")
}

/// The keychain account for one login: `ssh-password:<user>@<host>:<port>`, host lower-cased (the same key the recent
/// list uses), user as typed.
pub(crate) fn account(host: &str, port: u16, user: &str) -> String {
    format!("{ACCOUNT_PREFIX}{}", crate::prefs::ssh_server_key(user.trim(), &host.trim().to_ascii_lowercase(), port))
}

/// Stores the password for a login. An empty or over-long password is refused, never stored.
pub(crate) fn save(b: &dyn SecretBackend, host: &str, port: u16, user: &str, password: &str) -> Result<(), FsError> {
    if password.is_empty() || password.len() > MAX_PASSWORD {
        return Err(herr("invalid_password", "Enter the password."));
    }
    b.set(&account(host, port, user), password).map_err(|_| unavailable())
}

/// The stored password for a login, or `None` when none is stored.
pub(crate) fn load(b: &dyn SecretBackend, host: &str, port: u16, user: &str) -> Result<Option<String>, FsError> {
    let stored = b.get(&account(host, port, user)).map_err(|_| unavailable())?;
    Ok(stored.filter(|p| !p.is_empty()))
}

/// Removes the stored password for a login (an empty value: the store has no delete).
pub(crate) fn forget(b: &dyn SecretBackend, host: &str, port: u16, user: &str) -> Result<(), FsError> {
    b.set(&account(host, port, user), "").map_err(|_| unavailable())
}

/// What the user asked for on this call. `typed` is the password from the dialog; `use_saved` says to read the stored
/// one instead; `remember` is the checkbox (`None` for a key login or an older UI: leave the keychain alone).
pub(crate) struct Request<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub typed: Option<&'a str>,
    pub use_saved: bool,
    pub remember: Option<bool>,
}

/// The password to log in with: the typed one, else (when `use_saved`) the stored one. A `use_saved` call with nothing
/// stored is `SSH_PASSWORD_REQUIRED`, so the dialog asks for the password instead of failing obscurely.
pub(crate) fn resolve(b: &dyn SecretBackend, req: &Request<'_>) -> Result<Option<String>, FsError> {
    if let Some(typed) = req.typed.filter(|p| !p.is_empty()) {
        return Ok(Some(typed.to_string()));
    }
    if !req.use_saved {
        return Ok(None);
    }
    match load(b, req.host, req.port, req.user)? {
        Some(saved) => Ok(Some(saved)),
        None => Err(herr("SSH_PASSWORD_REQUIRED", "Enter the password for this server.")),
    }
}

/// What a verified login changes in the keychain: `Some(true)` after a store, `Some(false)` after a removal, `None`
/// when nothing changed. Call it only after the password worked. `flagged` is the recent list's saved-password flag:
/// an uncheck touches the keychain only when something is stored.
pub(crate) fn apply_remember(b: &dyn SecretBackend, req: &Request<'_>, flagged: bool) -> Result<Option<bool>, FsError> {
    match req.remember {
        Some(true) => match req.typed.filter(|p| !p.is_empty()) {
            Some(typed) => {
                save(b, req.host, req.port, req.user, typed)?;
                Ok(Some(true))
            }
            // Using the stored password and keeping it: nothing to write, the flag already says it is there.
            None => Ok(None),
        },
        Some(false) if flagged => {
            forget(b, req.host, req.port, req.user)?;
            Ok(Some(false))
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    fn req<'a>(typed: Option<&'a str>, use_saved: bool, remember: Option<bool>) -> Request<'a> {
        Request { host: "Example.com", port: 22, user: "alice", typed, use_saved, remember }
    }

    #[test]
    fn save_load_and_forget_round_trip_per_login() {
        let b = MemoryBackend::default();
        assert_eq!(load(&b, "example.com", 22, "alice").unwrap(), None);
        save(&b, "Example.com", 22, "alice", "pw-1").unwrap();
        assert_eq!(load(&b, "example.com", 22, "alice").unwrap().as_deref(), Some("pw-1"), "host case does not matter");
        assert_eq!(load(&b, "example.com", 22, "bob").unwrap(), None, "another user has none");
        assert_eq!(load(&b, "example.com", 2222, "alice").unwrap(), None, "another port has none");
        forget(&b, "example.com", 22, "alice").unwrap();
        assert_eq!(load(&b, "example.com", 22, "alice").unwrap(), None);
    }

    #[test]
    fn the_account_is_one_key_in_the_shared_store_and_names_no_password() {
        assert_eq!(account("Example.com", 22, "alice"), "ssh-password:alice@example.com:22");
    }

    #[test]
    fn an_empty_or_huge_password_is_never_stored() {
        let b = MemoryBackend::default();
        assert_eq!(save(&b, "h.example", 22, "u", "").unwrap_err().code, "invalid_password");
        assert_eq!(save(&b, "h.example", 22, "u", &"x".repeat(MAX_PASSWORD + 1)).unwrap_err().code, "invalid_password");
        assert_eq!(load(&b, "h.example", 22, "u").unwrap(), None);
    }

    #[test]
    fn resolve_prefers_the_typed_password_and_reads_the_stored_one_on_request() {
        let b = MemoryBackend::default();
        save(&b, "example.com", 22, "alice", "stored").unwrap();
        assert_eq!(resolve(&b, &req(Some("typed"), true, None)).unwrap().as_deref(), Some("typed"));
        assert_eq!(resolve(&b, &req(None, true, None)).unwrap().as_deref(), Some("stored"));
        assert_eq!(resolve(&b, &req(None, false, None)).unwrap(), None, "no flag, no keychain read");
    }

    #[test]
    fn resolve_with_nothing_stored_asks_for_the_password() {
        let b = MemoryBackend::default();
        assert_eq!(resolve(&b, &req(None, true, None)).unwrap_err().code, "SSH_PASSWORD_REQUIRED");
    }

    #[test]
    fn remembering_stores_only_a_typed_password() {
        let b = MemoryBackend::default();
        assert_eq!(apply_remember(&b, &req(Some("typed"), false, Some(true)), false).unwrap(), Some(true));
        assert_eq!(load(&b, "example.com", 22, "alice").unwrap().as_deref(), Some("typed"));
    }

    #[test]
    fn keeping_the_stored_password_writes_nothing() {
        let b = MemoryBackend::default();
        save(&b, "example.com", 22, "alice", "stored").unwrap();
        assert_eq!(apply_remember(&b, &req(None, true, Some(true)), true).unwrap(), None);
        assert_eq!(load(&b, "example.com", 22, "alice").unwrap().as_deref(), Some("stored"));
    }

    #[test]
    fn unchecking_removes_the_stored_password_only_when_one_is_flagged() {
        let b = MemoryBackend::default();
        save(&b, "example.com", 22, "alice", "stored").unwrap();
        let unchecked = req(Some("typed"), false, Some(false));
        assert_eq!(apply_remember(&b, &unchecked, false).unwrap(), None, "no flag: the keychain is not touched");
        assert_eq!(apply_remember(&b, &unchecked, true).unwrap(), Some(false));
        assert_eq!(load(&b, "example.com", 22, "alice").unwrap(), None);
    }

    #[test]
    fn a_call_without_the_checkbox_leaves_the_keychain_alone() {
        let b = MemoryBackend::default();
        save(&b, "example.com", 22, "alice", "stored").unwrap();
        assert_eq!(apply_remember(&b, &req(Some("typed"), false, None), true).unwrap(), None);
        assert_eq!(load(&b, "example.com", 22, "alice").unwrap().as_deref(), Some("stored"));
    }

    #[test]
    fn the_unavailable_error_is_fixed_text() {
        let err = unavailable();
        assert_eq!(err.code, "keychain_unavailable");
        assert!(!err.message.contains("pw"));
    }
}
