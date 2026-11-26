//! One keychain item for all of the host's secrets, cached for the life of the process.
//!
//! macOS asks the user to allow access PER ITEM, so keeping the JWT secret, the vault key and
//! the saved logins as separate items meant one prompt per item on every launch (three at start).
//! Here every account is a key in one JSON map stored under the account [`BUNDLE_ACCOUNT`],
//! read at most once per process: one prompt per launch at most, none after "Always Allow".
//!
//! Migration: when the bundle item does not exist yet, the legacy per-account items are copied
//! into it once. The legacy items are left in place (never deleted), so an older build still
//! finds its secrets. A read error during migration propagates and nothing is written: writing
//! a bundle without the vault key would make a later start generate a new key and orphan the vault.

use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::secrets::{SecretError, ACCOUNT_HUB_SESSION, ACCOUNT_JWT, ACCOUNT_LOCAL_LOGIN, ACCOUNT_VAULT};

/// The single item that holds every account.
pub const BUNDLE_ACCOUNT: &str = "secrets";
/// Per-account items written by builds before the bundle; copied in on first use.
const LEGACY_ACCOUNTS: [&str; 4] = [ACCOUNT_JWT, ACCOUNT_VAULT, ACCOUNT_HUB_SESSION, ACCOUNT_LOCAL_LOGIN];

/// Accounts also written to their legacy item on every set (downgrade safety).
const LEGACY_MIRRORED: [&str; 2] = [ACCOUNT_JWT, ACCOUNT_VAULT];

type Map = BTreeMap<String, String>;

/// Raw item access (one OS keychain item per account). `None` means "no such item".
pub trait RawStore: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<String>, SecretError>;
    fn write(&self, account: &str, value: &str) -> Result<(), SecretError>;
}

/// The bundled store. The mutex is held across keychain calls on purpose: concurrent first
/// reads would otherwise each raise their own prompt.
pub struct Bundle<R: RawStore> {
    raw: R,
    cache: Mutex<Option<Map>>,
}

impl<R: RawStore> Bundle<R> {
    pub const fn new(raw: R) -> Self {
        Self { raw, cache: Mutex::new(None) }
    }

    pub fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        self.with_map(|map| Ok(map.get(account).cloned()))
    }

    pub fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        self.with_map(|map| {
            // Re-read before writing: another instance (a different data dir) shares this item,
            // and writing back our cached copy would erase what it saved for other accounts.
            let mut next = match self.raw.read(BUNDLE_ACCOUNT)? {
                Some(text) => parse(&text)?,
                None => map.clone(),
            };
            let is_core = LEGACY_MIRRORED.contains(&account);
            if is_core && next.get(account).is_some_and(|stored| stored != value) {
                // Another instance created this core secret first and its core may already use
                // it: never replace it. Adopting the stored map lets the caller's retry read it.
                *map = next;
                return Err(SecretError::Unavailable(format!(
                    "'{account}' was just created by another LLM-IDE instance; retry"
                )));
            }
            next.insert(account.to_string(), value.to_string());
            self.raw.write(BUNDLE_ACCOUNT, &encode(&next)?)?;
            // The cache follows the bundle as soon as it is written, so a failed mirror write below
            // cannot make a retry generate (and store) a second vault key.
            *map = next;
            // NOTE: the two core secrets are mirrored to their legacy items too, so a downgraded
            // build still finds the vault key instead of generating a new one and orphaning the vault.
            if is_core {
                self.raw.write(account, value)?;
            }
            Ok(())
        })
    }

    fn with_map<T>(&self, op: impl FnOnce(&mut Map) -> Result<T, SecretError>) -> Result<T, SecretError> {
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        // A failed load is not cached, so a later call (after the user unlocks) retries.
        let loaded = match guard.take() {
            Some(map) => map,
            None => self.load()?,
        };
        op(guard.insert(loaded))
    }

    fn load(&self) -> Result<Map, SecretError> {
        match self.raw.read(BUNDLE_ACCOUNT)? {
            // Never overwritten automatically: it holds the vault key.
            Some(text) => parse(&text),
            None => self.migrate(),
        }
    }

    fn migrate(&self) -> Result<Map, SecretError> {
        let mut map = Map::new();
        for account in LEGACY_ACCOUNTS {
            if let Some(value) = self.raw.read(account)? {
                map.insert(account.to_string(), value);
            }
        }
        if !map.is_empty() {
            self.raw.write(BUNDLE_ACCOUNT, &encode(&map)?)?;
        }
        Ok(map)
    }
}

fn parse(text: &str) -> Result<Map, SecretError> {
    // The parse error is dropped on purpose: its text could quote part of a secret.
    serde_json::from_str(text).map_err(|_| SecretError::Corrupt(BUNDLE_ACCOUNT))
}

fn encode(map: &Map) -> Result<String, SecretError> {
    serde_json::to_string(map).map_err(|e| SecretError::Unavailable(format!("cannot encode the secret bundle: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    #[derive(Default)]
    struct Counting {
        items: Mutex<HashMap<String, String>>,
        reads: Mutex<Vec<String>>,
        fail_read: Option<&'static str>,
    }

    impl Counting {
        fn with(items: &[(&str, &str)]) -> Self {
            let c = Self::default();
            for (k, v) in items {
                c.items.lock().unwrap().insert((*k).into(), (*v).into());
            }
            c
        }
        fn reads_of(&self, account: &str) -> usize {
            self.reads.lock().unwrap().iter().filter(|a| *a == account).count()
        }
        fn item(&self, account: &str) -> Option<String> {
            self.items.lock().unwrap().get(account).cloned()
        }
    }

    impl RawStore for Arc<Counting> {
        fn read(&self, account: &str) -> Result<Option<String>, SecretError> {
            self.reads.lock().unwrap().push(account.into());
            if self.fail_read == Some(account) || self.fail_read == Some("*") {
                return Err(SecretError::Unavailable("denied".into()));
            }
            Ok(self.items.lock().unwrap().get(account).cloned())
        }
        fn write(&self, account: &str, value: &str) -> Result<(), SecretError> {
            self.items.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
    }

    #[test]
    fn many_gets_touch_the_keychain_once() {
        let raw = Arc::new(Counting::default());
        let bundle = Bundle::new(raw.clone());
        bundle.set(ACCOUNT_JWT, "j").unwrap();
        bundle.set(ACCOUNT_VAULT, "v").unwrap();
        for _ in 0..5 {
            assert_eq!(bundle.get(ACCOUNT_JWT).unwrap().as_deref(), Some("j"));
            assert_eq!(bundle.get(ACCOUNT_LOCAL_LOGIN).unwrap(), None);
        }
        // One load, plus one re-read per set; the gets add none.
        assert_eq!(raw.reads_of(BUNDLE_ACCOUNT), 3);

        // A new process: one read of the bundle item, no legacy reads.
        let next = Bundle::new(raw.clone());
        assert_eq!(next.get(ACCOUNT_VAULT).unwrap().as_deref(), Some("v"));
        assert_eq!(next.get(ACCOUNT_JWT).unwrap().as_deref(), Some("j"));
        assert_eq!(raw.reads_of(BUNDLE_ACCOUNT), 4);
        assert_eq!(raw.reads_of(ACCOUNT_VAULT), 1, "legacy read only during the first migration");
    }

    #[test]
    fn legacy_items_are_copied_once_and_kept() {
        let raw = Arc::new(Counting::with(&[(ACCOUNT_JWT, "old-j"), (ACCOUNT_VAULT, "old-v")]));
        let bundle = Bundle::new(raw.clone());
        assert_eq!(bundle.get(ACCOUNT_VAULT).unwrap().as_deref(), Some("old-v"));
        assert!(raw.item(BUNDLE_ACCOUNT).is_some());
        assert_eq!(raw.item(ACCOUNT_VAULT).as_deref(), Some("old-v"), "legacy item never deleted");

        let next = Bundle::new(raw.clone());
        assert_eq!(next.get(ACCOUNT_JWT).unwrap().as_deref(), Some("old-j"));
        assert_eq!(raw.reads_of(ACCOUNT_JWT), 1);
    }

    #[test]
    fn migration_read_error_writes_nothing_and_is_not_cached() {
        let mut c = Counting::with(&[(ACCOUNT_JWT, "j")]);
        c.fail_read = Some(ACCOUNT_VAULT);
        let raw = Arc::new(c);
        let bundle = Bundle::new(raw.clone());
        assert!(matches!(bundle.get(ACCOUNT_JWT), Err(SecretError::Unavailable(_))));
        assert!(raw.item(BUNDLE_ACCOUNT).is_none(), "no bundle without the vault key");
        assert!(bundle.get(ACCOUNT_JWT).is_err(), "retried, not cached");
        assert_eq!(raw.reads_of(BUNDLE_ACCOUNT), 2);
    }

    #[test]
    fn set_keeps_what_another_instance_saved() {
        let raw = Arc::new(Counting::default());
        let first = Bundle::new(raw.clone());
        let second = Bundle::new(raw.clone());
        assert_eq!(first.get(ACCOUNT_JWT).unwrap(), None);
        assert_eq!(second.get(ACCOUNT_JWT).unwrap(), None);
        first.set(ACCOUNT_LOCAL_LOGIN, "login-a").unwrap();
        second.set(ACCOUNT_HUB_SESSION, "hub-b").unwrap();
        let fresh = Bundle::new(raw.clone());
        assert_eq!(fresh.get(ACCOUNT_LOCAL_LOGIN).unwrap().as_deref(), Some("login-a"));
        assert_eq!(fresh.get(ACCOUNT_HUB_SESSION).unwrap().as_deref(), Some("hub-b"));
    }

    #[test]
    fn a_core_secret_another_instance_created_is_never_replaced() {
        let raw = Arc::new(Counting::default());
        let first = Bundle::new(raw.clone());
        let second = Bundle::new(raw.clone());
        assert_eq!(first.get(ACCOUNT_VAULT).unwrap(), None);
        assert_eq!(second.get(ACCOUNT_VAULT).unwrap(), None);
        first.set(ACCOUNT_VAULT, "va").unwrap();
        assert!(second.set(ACCOUNT_VAULT, "vb").is_err());
        assert_eq!(second.get(ACCOUNT_VAULT).unwrap().as_deref(), Some("va"), "retry reads the stored key");
        assert_eq!(Bundle::new(raw.clone()).get(ACCOUNT_VAULT).unwrap().as_deref(), Some("va"));
    }

    #[test]
    fn core_secrets_are_mirrored_to_legacy_items_for_downgrades() {
        let raw = Arc::new(Counting::default());
        let bundle = Bundle::new(raw.clone());
        bundle.set(ACCOUNT_VAULT, "v").unwrap();
        bundle.set(ACCOUNT_LOCAL_LOGIN, "l").unwrap();
        assert_eq!(raw.item(ACCOUNT_VAULT).as_deref(), Some("v"));
        assert_eq!(raw.item(ACCOUNT_LOCAL_LOGIN), None, "only the core secrets are mirrored");
    }

    #[test]
    fn corrupt_bundle_is_never_overwritten() {
        let raw = Arc::new(Counting::with(&[(BUNDLE_ACCOUNT, "not json")]));
        let bundle = Bundle::new(raw.clone());
        assert_eq!(bundle.get(ACCOUNT_VAULT).unwrap_err(), SecretError::Corrupt(BUNDLE_ACCOUNT));
        assert!(bundle.set(ACCOUNT_VAULT, "new").is_err());
        assert_eq!(raw.item(BUNDLE_ACCOUNT).as_deref(), Some("not json"));
    }

    #[test]
    fn locked_store_fails_closed() {
        let c = Counting { fail_read: Some("*"), ..Default::default() };
        let bundle = Bundle::new(Arc::new(c));
        assert!(crate::secrets::load_or_create(&BundleAdapter(&bundle)).is_err());
    }

    /// Lets the generic `load_or_create` run over a bundle in tests.
    struct BundleAdapter<'a>(&'a Bundle<Arc<Counting>>);
    impl crate::secrets::SecretBackend for BundleAdapter<'_> {
        fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
            self.0.get(account)
        }
        fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
            self.0.set(account, value)
        }
        fn name(&self) -> &'static str {
            "bundle"
        }
    }
}
