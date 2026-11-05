//! The desktop-authoritative device registry (relay design 4.6, C3) plus the epoch root. Stored only in the OS
//! secret store (integrity-protected by the OS), written only by the user's link confirm, keyconfirm and revoke.
//! Rotation and every wrap go only to devices listed here; the relay's copy is never trusted.
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::secrets::SecretBackend;

pub const ACCOUNT: &str = "relay-registry-v1";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Registry { pub version: u32, pub enabled: bool, pub epoch: u64, pub root: String, pub desktop_id: String, pub user_id: String, pub devices: Vec<Device> }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device { pub device_id: String, pub label: String, pub tier: String, pub signing_key: String, pub ecdh_key: String, pub linked_at: u64,
    pub confirmed: bool, pub host_api_token: String, pub wrap: Option<String>, pub wrap_sig: String, pub reply_count: u64 }

pub fn load(store: &dyn SecretBackend) -> Result<Registry, String> {
    match store.get(ACCOUNT).map_err(|e| e.to_string())? {
        Some(raw) => serde_json::from_str(&raw).map_err(|_| "the relay registry is unreadable".to_string()),
        None => Ok(Registry { version: 1, ..Default::default() }),
    }
}

pub fn save(store: &dyn SecretBackend, r: &Registry) -> Result<(), String> {
    store.set(ACCOUNT, &serde_json::to_string(r).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

impl Registry {
    pub fn ensure_root(&mut self) {
        if self.epoch == 0 {
            let mut k = [0u8; 32];
            OsRng.fill_bytes(&mut k);
            self.root = URL_SAFE_NO_PAD.encode(k);
            self.epoch = 1;
        }
    }
    pub fn root_bytes(&self) -> Result<[u8; 32], String> {
        URL_SAFE_NO_PAD.decode(&self.root).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| "the relay root is unreadable".to_string())
    }
    pub fn add(&mut self, d: Device) {
        self.devices.retain(|x| x.device_id != d.device_id);
        self.devices.push(d);
    }
    pub fn device(&self, id: &str) -> Option<&Device> { self.devices.iter().find(|d| d.device_id == id) }
    pub fn confirm(&mut self, id: &str, plaintext: &[u8]) -> bool {
        let Some(d) = self.devices.iter_mut().find(|d| d.device_id == id) else { return false };
        let Ok(sig) = URL_SAFE_NO_PAD.decode(&d.wrap_sig) else { return false };
        let want = crate::relay::crypto::key_confirm_plaintext(&sig);
        let ok = plaintext.len() == 32 && plaintext.iter().zip(want.iter()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0;
        if ok { d.confirmed = true; d.wrap = None; }
        ok
    }
    pub fn remove(&mut self, id: &str) { self.devices.retain(|d| d.device_id != id); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryBackend;

    fn dev(id: &str) -> Device {
        Device { device_id: id.into(), label: "Phone".into(), tier: "web".into(), signing_key: "s".into(), ecdh_key: "e".into(), linked_at: 1,
            confirmed: false, host_api_token: "t".into(), wrap: None, wrap_sig: "c2ln".into(), reply_count: 0 }
    }

    #[test]
    fn root_is_created_once_and_devices_persist_in_the_secret_store() {
        let store = MemoryBackend::default();
        let mut r = load(&store).unwrap();
        assert_eq!(r.epoch, 0);
        r.ensure_root();
        let root = r.root.clone();
        r.add(dev("d1"));
        save(&store, &r).unwrap();
        let again = load(&store).unwrap();
        assert_eq!((again.epoch, again.root.clone(), again.devices.len()), (1, root, 1));
        assert!(!again.devices[0].confirmed);
    }

    #[test]
    fn confirm_needs_the_exact_keyconfirm_plaintext() {
        let mut r = Registry::default();
        r.ensure_root();
        r.add(dev("d1"));
        assert!(!r.confirm("d1", &[0u8; 32]));
        let want = crate::relay::crypto::key_confirm_plaintext(b"sig");
        assert!(r.confirm("d1", &want));
        assert!(r.devices[0].confirmed);
        assert!(!r.confirm("unknown", &want));
    }
}
