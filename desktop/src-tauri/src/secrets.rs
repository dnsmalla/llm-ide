//! Per-OS secret store for the desktop host: the JWT signing secret and the
//! vault master key the Node core needs (`LLMIDE_JWT_SECRET`, `LLMIDE_VAULT_KEY`,
//! see `extension/core/config.mjs`).
//!
//! - Stored in the OS store (macOS Keychain, Windows Credential Manager, Linux
//!   Secret Service) under service `com.llmide.desktop`, through the `keyring` crate.
//! - Generated once (32 random bytes, hex), read on every core start, handed to the
//!   Node sidecar through its environment only. Never argv, never logged, never
//!   returned to the webview (`secrets_status` returns booleans).
//! - Fails closed: a locked or unavailable store is an error. A read error never
//!   triggers generation (that would orphan the vault), and there is no plaintext
//!   file fallback.
//! - `LLMIDE_KEYCHAIN_BACKEND=memory` selects an in-process store (tests; mirrors the
//!   Mac app convention). The Mac app's own keychain items are never read.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

pub const SERVICE: &str = "com.llmide.desktop";
pub const ACCOUNT_JWT: &str = "jwt-secret";
pub const ACCOUNT_VAULT: &str = "vault-key";
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
            Self::Corrupt(account) => write!(
                f,
                "stored secret '{account}' in the OS store is unusable (too short or not text); \
                 refusing to replace it automatically because that would make the vault \
                 unreadable. Remove the '{SERVICE}' entry in your OS credential manager to reset."
            ),
            Self::BadBackend(v) => write!(f, "{BACKEND_ENV}={v:?} is not supported (only \"memory\" or unset)"),
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

/// The real OS store via `keyring`.
pub struct OsBackend;

fn map_keyring(e: keyring::Error) -> SecretError {
    // Details can name the platform failure but never carry the secret.
    SecretError::Unavailable(e.to_string())
}

impl SecretBackend for OsBackend {
    fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(map_keyring)?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_keyring(e)),
        }
    }
    fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|e| e.set_password(value))
            .map_err(map_keyring)
    }
    fn name(&self) -> &'static str {
        "os"
    }
}

/// `memory` selects the in-process store; unset or empty selects the OS store.
pub fn backend_from_env(value: Option<&str>) -> Result<Box<dyn SecretBackend>, SecretError> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(Box::new(OsBackend)),
        Some("memory") => Ok(Box::new(MemoryBackend::default())),
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

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub struct SecretsStatus {
    pub backend: &'static str,
    pub available: bool,
    pub jwt_secret: bool,
    pub vault_key: bool,
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
    invalidate_status_cache();
    Ok(secrets)
}

/// Read-only: reports presence, creates nothing.
pub fn status(b: &dyn SecretBackend) -> SecretsStatus {
    let probe = |a| b.get(a).map(|v| v.is_some_and(|v| usable(&v)));
    let (jwt, vault) = (probe(ACCOUNT_JWT), probe(ACCOUNT_VAULT));
    SecretsStatus {
        backend: b.name(),
        available: jwt.is_ok() && vault.is_ok(),
        jwt_secret: jwt.unwrap_or(false),
        vault_key: vault.unwrap_or(false),
    }
}

/// How long a `secrets_status` answer is reused. Each uncached call reads the OS
/// store (a keychain prompt or a securityd round trip), and the webview may poll.
const STATUS_TTL: Duration = Duration::from_secs(60);

type StatusCache = Mutex<Option<(Instant, SecretsStatus)>>;
static STATUS_CACHE: StatusCache = Mutex::new(None);

/// Forget the cached status (the secrets just changed).
pub fn invalidate_status_cache() {
    *STATUS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// `fetch` runs only when `cache` holds nothing younger than `ttl`; errors are not cached.
fn cached_status(
    cache: &StatusCache,
    ttl: Duration,
    fetch: impl FnOnce() -> Result<SecretsStatus, String>,
) -> Result<SecretsStatus, String> {
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, st)) = guard.as_ref() {
        if at.elapsed() < ttl {
            return Ok(st.clone());
        }
    }
    let fresh = fetch()?;
    *guard = Some((Instant::now(), fresh.clone()));
    Ok(fresh)
}

/// Webview-visible: booleans only, never a value. Cached for `STATUS_TTL` so a polling
/// page does not touch the OS credential store on every call.
#[tauri::command]
pub async fn secrets_status() -> Result<SecretsStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        cached_status(&STATUS_CACHE, STATUS_TTL, || {
            let b = default_backend().map_err(|e| e.to_string())?;
            Ok(status(b.as_ref()))
        })
    })
    .await
    .map_err(|e| format!("secrets task failed: {e}"))?
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
    fn status_reports_booleans_and_creates_nothing() {
        let b = MemoryBackend::default();
        let s = status(&b);
        assert_eq!(s, SecretsStatus { backend: "memory", available: true, jwt_secret: false, vault_key: false });
        assert!(b.get(ACCOUNT_JWT).unwrap().is_none());
        load_or_create(&b).unwrap();
        let s = status(&b);
        assert!(s.jwt_secret && s.vault_key && s.available);
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains(&b.get(ACCOUNT_JWT).unwrap().unwrap()));
        let locked = status(&Locked);
        assert!(!locked.available && !locked.jwt_secret);
    }

    #[test]
    fn backend_selection_from_env_value() {
        assert_eq!(backend_from_env(Some("memory")).unwrap().name(), "memory");
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

    #[test]
    fn status_is_cached_until_invalidated_and_errors_are_not_cached() {
        let cache: StatusCache = Mutex::new(None);
        let st = |jwt| SecretsStatus { backend: "t", available: true, jwt_secret: jwt, vault_key: jwt };
        let mut calls = 0;
        let ttl = Duration::from_secs(60);
        for _ in 0..3 {
            let got = cached_status(&cache, ttl, || { calls += 1; Ok(st(true)) }).unwrap();
            assert!(got.jwt_secret);
        }
        assert_eq!(calls, 1, "the store is read once, not per call");
        *cache.lock().unwrap() = None;
        assert!(cached_status(&cache, ttl, || { calls += 1; Ok(st(false)) }).is_ok());
        assert_eq!(calls, 2);
        let cache: StatusCache = Mutex::new(None);
        assert!(cached_status(&cache, ttl, || Err("locked".into())).is_err());
        assert!(cached_status(&cache, ttl, || Ok(st(true))).is_ok(), "a failure does not poison the cache");
        assert!(cached_status(&cache, Duration::ZERO, || { calls += 1; Ok(st(true)) }).is_ok());
        assert_eq!(calls, 3, "ttl expiry refetches");
    }
}
