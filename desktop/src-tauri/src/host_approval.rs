//! Host-signed approval tokens (HOST HALF only).
//!
//! `bypass_confirm` is advisory today: a compromised webview that never calls it can still ask the
//! core for `permission-mode=bypass`, because the core cannot tell that a human clicked. This
//! module lets the host PROVE the click: after the native Cancel-first dialog is accepted the host
//! mints a short-lived, single-use token signed with a per-launch random key that only the host
//! and the core it spawned know (`LLMIDE_HOST_APPROVAL_KEY`, passed to the spawned core only;
//! never to an adopted core, never to a terminal shell, never logged).
//!
//! Token (ASCII): `v1.<expiry_ms>.<nonce_hex>.<mac_hex>` where
//! `mac = HMAC-SHA256(key_bytes, "llmide-host-approval/v1|<purpose>|<expiry_ms>|<nonce_hex>")`,
//! `key_bytes` = the hex-decoded `LLMIDE_HOST_APPROVAL_KEY`, `purpose` = `bypass`.
//! Lifetime 60 s. The verifier must also remember used nonces until expiry (single use).
//!
//! STATUS: UX-only until the core verifies it (blocked-by item, see docs/ and desktop/PACKAGING.md):
//! the core must reject `permission-mode=bypass` requests that lack a valid
//! `x-llmide-host-approval` header when `LLMIDE_HOST_APPROVAL_KEY` is set. This task does not
//! change `extension/**`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};

pub const TOKEN_TTL_MS: u64 = 60_000;
pub const PURPOSE_BYPASS: &str = "bypass";

static KEY: OnceLock<[u8; 32]> = OnceLock::new();

/// The per-launch key (generated on first use, held only in host memory).
pub fn key() -> Result<&'static [u8; 32], String> {
    if let Some(k) = KEY.get() {
        return Ok(k);
    }
    let mut k = [0u8; 32];
    getrandom::fill(&mut k).map_err(|e| format!("cannot generate the approval key: {e}"))?;
    Ok(KEY.get_or_init(|| k))
}

pub fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Hex of the key, for the spawned core's environment.
pub fn key_hex() -> Result<String, String> {
    Ok(to_hex(key()?))
}

pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(msg);
    let ih = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(ih);
    outer.finalize().into()
}

fn signed_part(purpose: &str, expiry: u64, nonce: &str) -> String {
    format!("llmide-host-approval/v1|{purpose}|{expiry}|{nonce}")
}

/// Mints a token for `purpose` valid for `TOKEN_TTL_MS` from `now`.
pub fn mint_with(key: &[u8], purpose: &str, now: u64, nonce_hex: &str) -> String {
    let expiry = now + TOKEN_TTL_MS;
    let mac = hmac_sha256(key, signed_part(purpose, expiry, nonce_hex).as_bytes());
    format!("v1.{expiry}.{nonce_hex}.{}", to_hex(&mac))
}

pub fn mint(purpose: &str) -> Result<String, String> {
    let mut n = [0u8; 16];
    getrandom::fill(&mut n).map_err(|e| format!("cannot generate a nonce: {e}"))?;
    Ok(mint_with(key()?, purpose, crate::confirm::now_ms(), &to_hex(&n)))
}

/// Remembers used nonces until they expire (single use). Reference verifier: the core (Node) implements
/// the same rule; here it pins the token format in tests.
#[derive(Default)]
#[allow(dead_code)]
pub struct Verifier {
    used: Mutex<HashMap<String, u64>>,
}

#[allow(dead_code)]
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[allow(dead_code)]
impl Verifier {
    /// True once per valid, unexpired token for `purpose`. Mirrors what the core must do.
    pub fn verify_at(&self, key: &[u8], token: &str, purpose: &str, now: u64) -> bool {
        let parts: Vec<&str> = token.split('.').collect();
        let [ver, exp, nonce, mac] = parts[..] else { return false };
        if ver != "v1" || nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        let Ok(expiry) = exp.parse::<u64>() else { return false };
        if now >= expiry || expiry > now + TOKEN_TTL_MS {
            return false;
        }
        let want = to_hex(&hmac_sha256(key, signed_part(purpose, expiry, nonce).as_bytes()));
        if !ct_eq(want.as_bytes(), mac.as_bytes()) {
            return false;
        }
        let mut used = self.used.lock().unwrap_or_else(|p| p.into_inner());
        used.retain(|_, e| *e > now);
        used.insert(nonce.to_string(), expiry).is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_the_rfc_4231_vectors() {
        // Test case 1
        let mac = hmac_sha256(&[0x0b; 20], b"Hi There");
        assert_eq!(to_hex(&mac), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
        // Test case 2
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(to_hex(&mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // Test case 6: key longer than the block size
        let mac = hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(to_hex(&mac), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    const NONCE: &str = "00112233445566778899aabbccddeeff";

    #[test]
    fn a_minted_token_verifies_once_and_expires() {
        let key = [7u8; 32];
        let v = Verifier::default();
        let t = mint_with(&key, PURPOSE_BYPASS, 1_000, NONCE);
        assert!(v.verify_at(&key, &t, PURPOSE_BYPASS, 2_000));
        assert!(!v.verify_at(&key, &t, PURPOSE_BYPASS, 2_001), "single use");
        let t2 = mint_with(&key, PURPOSE_BYPASS, 1_000, "ffeeddccbbaa99887766554433221100");
        assert!(!v.verify_at(&key, &t2, PURPOSE_BYPASS, 1_000 + TOKEN_TTL_MS), "expired");
    }

    #[test]
    fn tampering_wrong_key_wrong_purpose_and_garbage_are_refused() {
        let key = [7u8; 32];
        let v = Verifier::default();
        let t = mint_with(&key, PURPOSE_BYPASS, 1_000, NONCE);
        assert!(!v.verify_at(&[8u8; 32], &t, PURPOSE_BYPASS, 1_500), "wrong key");
        assert!(!v.verify_at(&key, &t, "other", 1_500), "wrong purpose");
        let mut parts: Vec<String> = t.split('.').map(String::from).collect();
        parts[1] = (1_000 + TOKEN_TTL_MS + 5_000).to_string(); // extended lifetime
        assert!(!v.verify_at(&key, &parts.join("."), PURPOSE_BYPASS, 1_500), "forged expiry");
        for bad in ["", "v1", "v2.1.2.3", "v1.x.y.z", &format!("v1.99999.{NONCE}."), &format!("{t}.extra")] {
            assert!(!v.verify_at(&key, bad, PURPOSE_BYPASS, 1_500), "{bad:?}");
        }
        assert!(v.verify_at(&key, &t, PURPOSE_BYPASS, 1_500), "the genuine token still works");
    }

    #[test]
    fn the_launch_key_is_stable_per_process_and_random_looking() {
        let a = key_hex().unwrap();
        assert_eq!(a, key_hex().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, "0".repeat(64));
    }
}
