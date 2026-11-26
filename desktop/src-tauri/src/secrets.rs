//! Per-OS secret store for the desktop host: the JWT signing secret and the
//! vault master key the Node core needs (`LLMIDE_JWT_SECRET`, `LLMIDE_VAULT_KEY`,
//! see `extension/core/config.mjs`).
//!
//! - Stored in the OS store (macOS Keychain, Windows Credential Manager, Linux
//!   Secret Service) under service `com.llmide.desktop`, through the `keyring` crate.
//! - Generated once (32 random bytes, hex), read on every core start, handed to the
//!   Node sidecar through its environment only. Never argv, never logged, never
//!   returned to the webview (no command exposes them).
//! - Fails closed: a locked or unavailable store is an error. A read error never
//!   triggers generation (that would orphan the vault), and there is no plaintext
//!   file fallback.
//! - `LLMIDE_KEYCHAIN_BACKEND=memory` selects an in-process store (tests; mirrors the
//!   Mac app convention). The Mac app's own keychain items are never read.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

pub const SERVICE: &str = "com.llmide.desktop";
pub const ACCOUNT_JWT: &str = "jwt-secret";
pub const ACCOUNT_VAULT: &str = "vault-key";
pub const ACCOUNT_HUB_SESSION: &str = "hub-session";
/// The local login (email, password, refresh token) kept for the local core; see `local_login.rs`.
pub const ACCOUNT_LOCAL_LOGIN: &str = "local-login";
pub const BACKEND_ENV: &str = "LLMIDE_KEYCHAIN_BACKEND";
/// The server rejects secrets shorter than this (`extension/core/config.mjs`).
const MIN_LEN: usize = 32;
const SECRET_BYTES: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub enum SecretError {
    /// Store exists but refused access (locked, denied, no secret service running).
    Unavailable(String),
    /// A stored value is present but unusable; it is never overwritten automatically.
    Corrupt(&'static str),
    /// `LLMIDE_KEYCHAIN_BACKEND` holds a value other than `memory`.
    BadBackend(String),
    Random(String),
}

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(why) => write!(
                f,
                "OS secret store unavailable ({why}). Unlock your keychain / credential store \
                 (on Linux, start a Secret Service such as gnome-keyring or KWallet); \
                 LLM-IDE will not fall back to a plaintext file."
            ),
            Self::Corrupt(account) if *account == crate::secrets_bundle::BUNDLE_ACCOUNT => write!(
                f,
                "the '{SERVICE}' keychain item '{account}' is unreadable; refusing to replace it \
                 because it holds the vault key. Do not delete it unless you accept losing the \
                 encrypted vault (the separate 'vault-key' item, if present, is a backup copy)."
            ),
            Self::Corrupt(account) => write!(
                f,
                "stored secret '{account}' in the OS store is unusable (too short or not text); \
                 refusing to replace it automatically because that would make the vault \
                 unreadable. Remove the '{SERVICE}' entry in your OS credential manager to reset."
            ),
            Self::BadBackend(v) => write!(f, "{BACKEND_ENV}={v:?} is not supported (unset uses the OS keychain; \"memory\" is the in-process store for tests)"),
            Self::Random(why) => write!(f, "cannot generate a random secret: {why}"),
        }
    }
}

impl std::error::Error for SecretError {}

/// Minimal store interface; `None` means "no such entry" (distinct from an error).
pub trait SecretBackend: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, SecretError>;
    fn set(&self, account: &str, value: &str) -> Result<(), SecretError>;
    fn name(&self) -> &'static str;
}

#[derive(Default)]
pub struct MemoryBackend(Mutex<HashMap<String, String>>);

impl SecretBackend for MemoryBackend {
    fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        Ok(self.0.lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(account.into(), value.into());
        Ok(())
    }
    fn name(&self) -> &'static str {
        "memory"
    }
}

/// The real OS store via `keyring`. On macOS every account lives in ONE keychain item
/// (`secrets_bundle`), read once per process, because macOS prompts per item; elsewhere
/// each account is its own item (Windows caps one credential at 2560 bytes).
pub struct OsBackend;

fn map_keyring(e: keyring::Error) -> SecretError {
    // Details can name the platform failure but never carry the secret.
    SecretError::Unavailable(e.to_string())
}

/// One keyring item per account; the raw layer under the macOS bundle.
struct KeyringItems;

impl crate::secrets_bundle::RawStore for KeyringItems {
    fn read(&self, account: &str) -> Result<Option<String>, SecretError> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(map_keyring)?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_keyring(e)),
        }
    }
    fn write(&self, account: &str, value: &str) -> Result<(), SecretError> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|e| e.set_password(value))
            .map_err(map_keyring)
    }
}

/// Process-wide so every `default_backend()` shares one cache (one prompt per launch).
#[cfg(target_os = "macos")]
static OS_BUNDLE: crate::secrets_bundle::Bundle<KeyringItems> = crate::secrets_bundle::Bundle::new(KeyringItems);

impl SecretBackend for OsBackend {
    fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        #[cfg(target_os = "macos")]
        return OS_BUNDLE.get(account);
        #[cfg(not(target_os = "macos"))]
        return crate::secrets_bundle::RawStore::read(&KeyringItems, account);
    }
    fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        #[cfg(target_os = "macos")]
        return OS_BUNDLE.set(account, value);
        #[cfg(not(target_os = "macos"))]
        return crate::secrets_bundle::RawStore::write(&KeyringItems, account, value);
    }
    fn name(&self) -> &'static str {
        "os"
    }
}

/// `memory` selects the in-process store; unset or empty selects the OS store.
///
/// The in-process store is allowed in release builds too: the packaged-app smoke test and the autobench of the
/// release pipeline launch the real release binary with it, because a CI runner has no usable OS keychain. What a
/// release build must not do is use it SILENTLY (it forgets everything at exit, so the core gets fresh secrets and an
/// unreadable vault on every launch), so there it is announced on stderr.
pub fn backend_from_env(value: Option<&str>) -> Result<Box<dyn SecretBackend>, SecretError> {
    let backend = backend_from_env_with(value, true)?;
    if !cfg!(debug_assertions) && backend.name() == "memory" {
        eprintln!("secrets: {BACKEND_ENV}=memory is set: secrets are kept in memory only and are lost when the app exits (meant for tests)");
    }
    Ok(backend)
}

/// `allow_memory` false refuses the in-process store (kept for callers that must never use it).
fn backend_from_env_with(value: Option<&str>, allow_memory: bool) -> Result<Box<dyn SecretBackend>, SecretError> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(Box::new(OsBackend)),
        Some("memory") if allow_memory => Ok(Box::new(MemoryBackend::default())),
        Some(other) => Err(SecretError::BadBackend(other.into())),
    }
}

pub fn default_backend() -> Result<Box<dyn SecretBackend>, SecretError> {
    backend_from_env(std::env::var(BACKEND_ENV).ok().as_deref())
}

/// The two secrets. `Debug` is redacted so a stray `{:?}` cannot log them.
pub struct Secrets {
    pub jwt_secret: String,
    pub vault_key: String,
}

impl fmt::Debug for Secrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secrets { jwt_secret: <redacted>, vault_key: <redacted> }")
    }
}

fn generate() -> Result<String, SecretError> {
    let mut buf = [0u8; SECRET_BYTES];
    getrandom::fill(&mut buf).map_err(|e| SecretError::Random(e.to_string()))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn usable(v: &str) -> bool {
    v.len() >= MIN_LEN && !v.chars().any(char::is_control)
}

/// Existing value, or a fresh one stored on first use. Only a definite "no entry"
/// generates; any backend error propagates and nothing is written.
fn get_or_create(b: &dyn SecretBackend, account: &'static str) -> Result<String, SecretError> {
    match b.get(account)? {
        Some(v) if usable(&v) => Ok(v),
        Some(_) => Err(SecretError::Corrupt(account)),
        None => {
            let v = generate()?;
            b.set(account, &v)?;
            Ok(v)
        }
    }
}

pub fn load_or_create(b: &dyn SecretBackend) -> Result<Secrets, SecretError> {
    let secrets = Secrets {
        jwt_secret: get_or_create(b, ACCOUNT_JWT)?,
        vault_key: get_or_create(b, ACCOUNT_VAULT)?,
    };
    Ok(secrets)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Locked;
    impl SecretBackend for Locked {
        fn get(&self, _: &str) -> Result<Option<String>, SecretError> {
            Err(SecretError::Unavailable("locked".into()))
        }
        fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
            panic!("must not write when the store is locked")
        }
        fn name(&self) -> &'static str {
            "locked"
        }
    }

    #[test]
    fn generates_once_then_reuses() {
        let b = MemoryBackend::default();
        let first = load_or_create(&b).unwrap();
        let second = load_or_create(&b).unwrap();
        assert_eq!(first.jwt_secret, second.jwt_secret);
        assert_eq!(first.vault_key, second.vault_key);
        assert_ne!(first.jwt_secret, first.vault_key);
        assert_eq!(first.jwt_secret.len(), 64);
        assert!(first.jwt_secret.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn locked_store_fails_closed_without_writing() {
        let err = load_or_create(&Locked).unwrap_err();
        assert!(matches!(err, SecretError::Unavailable(_)));
        assert!(err.to_string().contains("plaintext"));
    }

    #[test]
    fn corrupt_value_is_never_overwritten() {
        let b = MemoryBackend::default();
        b.set(ACCOUNT_VAULT, "short").unwrap();
        assert_eq!(load_or_create(&b).unwrap_err(), SecretError::Corrupt(ACCOUNT_VAULT));
        assert_eq!(b.get(ACCOUNT_VAULT).unwrap().as_deref(), Some("short"));
    }

    #[test]
    fn backend_selection_from_env_value() {
        assert_eq!(backend_from_env(Some("memory")).unwrap().name(), "memory");
        assert!(matches!(backend_from_env_with(Some("memory"), false), Err(SecretError::BadBackend(_))), "release builds refuse memory");
        assert_eq!(backend_from_env_with(None, false).unwrap().name(), "os");
        assert_eq!(backend_from_env(Some(" memory ")).unwrap().name(), "memory");
        assert_eq!(backend_from_env(None).unwrap().name(), "os");
        assert_eq!(backend_from_env(Some("")).unwrap().name(), "os");
        assert!(matches!(backend_from_env(Some("file")), Err(SecretError::BadBackend(_))));
    }

    #[test]
    fn debug_is_redacted() {
        let s = load_or_create(&MemoryBackend::default()).unwrap();
        let dbg = format!("{s:?}");
        assert!(!dbg.contains(&s.jwt_secret) && !dbg.contains(&s.vault_key));
    }

    #[test]
    fn error_text_never_contains_secret_values() {
        let b = MemoryBackend::default();
        let s = load_or_create(&b).unwrap();
        let msg = SecretError::Corrupt(ACCOUNT_JWT).to_string();
        assert!(!msg.contains(&s.jwt_secret));
    }

}
