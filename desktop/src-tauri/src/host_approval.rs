//! Host-signed approval tokens (HOST HALF only).
//!
//! `bypass_confirm` is advisory: a compromised webview that never calls it can still ask the core for
//! `permission-mode=bypass`, because the core cannot tell that a human clicked. This module lets the host PROVE the
//! click: after the native Cancel-first dialog is accepted the host mints a short-lived, single-use token signed with a
//! per-launch random key that only the host and the core it spawned know (`LLMIDE_HOST_APPROVAL_KEY`, passed to the
//! spawned core only; never to an adopted core, never to a terminal shell, never logged).
//!
//! Token format v2 (ASCII): `v2.<expiry_ms>.<nonce_hex>.<mac_hex>` where
//! `mac = HMAC-SHA256(key_bytes, "llmide-host-approval/v2|<purpose>|<expiry_ms>|<nonce_hex>")`,
//! `key_bytes` = the hex-decoded `LLMIDE_HOST_APPROVAL_KEY` and `purpose` = `bypass:<chatId>`: the approval is BOUND TO
//! ONE CHAT (`chatId` must match `[A-Za-z0-9_.:-]{1,128}`, so the `|` separator cannot be smuggled in). Lifetime 60 s.
//! The verifier must also remember used nonces until expiry (single use). The legacy v1 format (purpose `bypass`, not
//! chat-bound) is no longer minted; the core accepts it only with `LLMIDE_HOST_APPROVAL_COMPAT=1`.
//!
//! Enforced by the core (extension/core/host-approval.mjs): with `LLMIDE_HOST_APPROVAL_KEY` set, a Bypass request needs a
//! valid token for ITS chat, `x-llmide-client: desktop-ui` and the bus host proof (`bus_proof`, below).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};

pub const TOKEN_TTL_MS: u64 = 60_000;
pub const PURPOSE_BYPASS: &str = "bypass";
pub const FORMAT: &str = "v2";

/// A chat id a Bypass approval may be bound to.
pub fn valid_chat_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// The purpose a Bypass token for `chat_id` signs (`bypass:<chatId>`), or `None` for an id that cannot be bound.
pub fn bypass_purpose(chat_id: &str) -> Option<String> {
    valid_chat_id(chat_id).then(|| format!("{PURPOSE_BYPASS}:{chat_id}"))
}

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

/// Label of the command-bus host proof (see `bus_proof_with`).
pub const BUS_PROOF_LABEL: &str = "bus-host-proof/v1";

/// The command-bus host proof: `hex(HMAC-SHA256(key, "bus-host-proof/v1"))`. A bearer secret DERIVED from the
/// per-launch approval key. The webview sends it as `x-llmide-host-nonce` ONLY to the core this app spawned and
/// verified; the core accepts a client class above `extension` (the desktop UI, which alone approves commands) only
/// with it. It is NOT the `/health` identity nonce, which any local process can read. It is equal in power to the
/// Bypass key for bus approvals, so it is never logged, stored or shown; the webview keeps it in memory only.
pub fn bus_proof_with(key: &[u8]) -> String {
    to_hex(&hmac_sha256(key, BUS_PROOF_LABEL.as_bytes()))
}

pub fn bus_proof() -> Result<String, String> {
    Ok(bus_proof_with(key()?))
}

/// Host command: the bus proof, to the main window only and only while the core is the one this app spawned and
/// verified (`trust == spawned`, `ready`). Otherwise `None`: an adopted or unverified core never receives it.
#[tauri::command]
pub fn host_bus_proof(window: tauri::Window, host: tauri::State<'_, crate::core_host::CoreHost>) -> Result<Option<String>, crate::fs_ops::FsError> {
    if window.label() != "main" {
        return Err(crate::confirm::herr("forbidden", "only the main window may ask for the bus proof"));
    }
    let st = host.status();
    if st.trust != "spawned" || st.state != crate::core_host::Phase::Ready {
        return Ok(None);
    }
    bus_proof().map(Some).map_err(|e| crate::confirm::herr("io", e))
}

fn signed_part(purpose: &str, expiry: u64, nonce: &str) -> String {
    format!("llmide-host-approval/{FORMAT}|{purpose}|{expiry}|{nonce}")
}

/// Mints a token for `purpose` valid for `TOKEN_TTL_MS` from `now`.
pub fn mint_with(key: &[u8], purpose: &str, now: u64, nonce_hex: &str) -> String {
    let expiry = now + TOKEN_TTL_MS;
    let mac = hmac_sha256(key, signed_part(purpose, expiry, nonce_hex).as_bytes());
    format!("{FORMAT}.{expiry}.{nonce_hex}.{}", to_hex(&mac))
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
        if ver != FORMAT || nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
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
        assert!(t.starts_with("v2."));
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
        for bad in ["", "v2", "v1.1.2.3", "v3.1.2.3", "v1.x.y.z", &format!("v1.99999.{NONCE}."), &format!("{t}.extra")] {
            assert!(!v.verify_at(&key, bad, PURPOSE_BYPASS, 1_500), "{bad:?}");
        }
        assert!(v.verify_at(&key, &t, PURPOSE_BYPASS, 1_500), "the genuine token still works");
    }

    #[test]
    fn a_bypass_token_is_bound_to_its_chat() {
        let key = [7u8; 32];
        let v = Verifier::default();
        let a = bypass_purpose("chat-A").unwrap();
        let b = bypass_purpose("chat-B").unwrap();
        let t = mint_with(&key, &a, 1_000, NONCE);
        assert!(!v.verify_at(&key, &t, &b, 1_500), "another chat");
        assert!(!v.verify_at(&key, &t, PURPOSE_BYPASS, 1_500), "the unbound purpose");
        assert!(v.verify_at(&key, &t, &a, 1_500));
        // The v1 format is gone: a v1-shaped token never verifies here.
        let v1 = format!("v1.{}.{NONCE}.{}", 1_000 + TOKEN_TTL_MS, "0".repeat(64));
        assert!(!v.verify_at(&key, &v1, &a, 1_500));
    }

    #[test]
    fn only_well_formed_chat_ids_can_be_bound() {
        for ok in ["a", "chat-1", "8f14e45f-ceea-467a-9575-0f1b8c6f1a2b", "a.b_c:d-e"] {
            assert!(bypass_purpose(ok).is_some(), "{ok}");
        }
        for bad in ["", "a|b", "a b", "a\n", "é", &"x".repeat(129), "a/b"] {
            assert!(bypass_purpose(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn the_core_vector_for_a_chat_bound_v2_token() {
        // Same vector extension/tests/host-approval-bypass.test.mjs derives with node:crypto.
        let key = [7u8; 32];
        let t = mint_with(&key, "bypass:chat-1", 1_000, NONCE);
        assert_eq!(t, "v2.61000.00112233445566778899aabbccddeeff.0812187205bd5c594faa3dfc1b307c35ce8831e7de6742e4c851be971a546764");
    }

    #[test]
    fn the_bus_proof_is_a_derived_secret_matching_the_core_vector() {
        // Same vector the core's test derives with node:crypto (extension/tests/bus-host-proof.test.mjs).
        assert_eq!(bus_proof_with(&[7u8; 32]), "2c4681abf6209f234bb72de37c77e21d2be14d556be363ebb70411b7c80c6472");
        assert_ne!(bus_proof_with(&[7u8; 32]), bus_proof_with(&[8u8; 32]));
        let k = key_hex().unwrap();
        let p = bus_proof().unwrap();
        assert_eq!(p.len(), 64);
        assert_ne!(p, k, "the proof is not the key");
    }

    #[test]
    fn the_launch_key_is_stable_per_process_and_random_looking() {
        let a = key_hex().unwrap();
        assert_eq!(a, key_hex().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, "0".repeat(64));
    }
}
