//! schema/relay/v1 envelope crypto. Must match scripts/relay-reference.mjs byte for byte (vectors in tests).
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::{DecodePublicKey, EncodePublicKey};
use p256::{PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const BUCKETS: [usize; 6] = [1024, 4096, 16384, 65536, 262144, 1048576];
pub const MAX_FRAME: usize = 1048576 - 4;
pub const KEY_MESSAGE_CAP: u64 = 1 << 24;
pub type Result<T> = std::result::Result<T, &'static str>;

pub enum F<'a> { U(u64), S(&'a str), B(&'a [u8]) }

pub fn enc(fields: &[F]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in fields {
        let v: Vec<u8> = match f { F::U(n) => n.to_be_bytes().to_vec(), F::S(s) => s.as_bytes().to_vec(), F::B(b) => b.to_vec() };
        out.extend_from_slice(&(v.len() as u32).to_be_bytes());
        out.extend_from_slice(&v);
    }
    out
}

pub fn decode_enc(b: &[u8], count: usize) -> Result<Vec<Vec<u8>>> {
    let (mut out, mut off) = (Vec::new(), 0usize);
    while off < b.len() {
        if off + 4 > b.len() { return Err("bad_encoding"); }
        let n = u32::from_be_bytes(b[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        if off + n > b.len() { return Err("bad_encoding"); }
        out.push(b[off..off + n].to_vec());
        off += n;
    }
    if out.len() != count { return Err("bad_encoding"); }
    Ok(out)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Header { pub purpose: String, pub user_id: String, pub desktop_id: String, pub from: String, pub to: String,
    pub epoch: u64, pub session: String, pub seq: u64, pub issued_at: u64, pub tier: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope { pub v: u64, pub purpose: String, pub user_id: String, pub desktop_id: String, pub from: String, pub to: String,
    pub epoch: u64, pub session: String, pub seq: u64, pub issued_at: u64, pub tier: String,
    pub nonce: String, pub ct: String, pub sig: String, #[serde(skip_serializing_if = "Option::is_none")] pub eph: Option<String> }

impl Envelope {
    pub fn header(&self) -> Header {
        Header { purpose: self.purpose.clone(), user_id: self.user_id.clone(), desktop_id: self.desktop_id.clone(), from: self.from.clone(), to: self.to.clone(),
            epoch: self.epoch, session: self.session.clone(), seq: self.seq, issued_at: self.issued_at, tier: self.tier.clone() }
    }
}

fn header_fields(h: &Header) -> Vec<F<'_>> {
    vec![F::U(1), F::S(&h.purpose), F::S(&h.user_id), F::S(&h.desktop_id), F::S(&h.from), F::S(&h.to), F::U(h.epoch), F::S(&h.session), F::U(h.seq), F::U(h.issued_at), F::S(&h.tier)]
}
fn with<'a>(h: &'a Header, rest: &[&'a [u8]]) -> Vec<u8> {
    let mut f = header_fields(h);
    for r in rest { f.push(F::B(r)); }
    enc(&f)
}
fn context(purpose: &str) -> Vec<u8> { format!("llmide/{purpose}/v1\0").into_bytes() }
fn sha(parts: &[&[u8]]) -> [u8; 32] { let mut d = Sha256::new(); for p in parts { d.update(p); } d.finalize().into() }
fn hkdf32(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, &mut out).expect("32 bytes is a valid HKDF length");
    out
}
fn b64d(s: &str) -> Result<Vec<u8>> { URL_SAFE_NO_PAD.decode(s).map_err(|_| "bad_base64") }

pub fn pad(b: &[u8]) -> Result<Vec<u8>> {
    if b.len() > MAX_FRAME { return Err("frame_too_large"); }
    let size = *BUCKETS.iter().find(|&&s| s >= b.len() + 4).unwrap();
    let mut out = vec![0u8; size];
    out[..4].copy_from_slice(&(b.len() as u32).to_be_bytes());
    out[4..4 + b.len()].copy_from_slice(b);
    Ok(out)
}

pub fn unpad(b: &[u8]) -> Result<Vec<u8>> {
    if !BUCKETS.contains(&b.len()) { return Err("bad_padding"); }
    let n = u32::from_be_bytes(b[..4].try_into().unwrap()) as usize;
    if n > b.len() - 4 || b[4 + n..].iter().any(|&x| x != 0) { return Err("bad_padding"); }
    Ok(b[4..4 + n].to_vec())
}

pub fn device_keys(root: &[u8; 32], user_id: &str, desktop_id: &str, device_id: &str, epoch: u64) -> ([u8; 32], [u8; 32]) {
    let salt = sha(&[b"llmide-relay-v1", &enc(&[F::S(user_id), F::S(desktop_id)])]);
    let key = |purpose: &str, sender: &str, recipient: &str| hkdf32(root, &salt, &enc(&[F::S(purpose), F::U(epoch), F::S(""), F::S(sender), F::S(recipient)]));
    (key("request", device_id, desktop_id), key("reply", desktop_id, device_id))
}

pub fn seal(h: &Header, key: &[u8; 32], plaintext: &[u8], signer: &SigningKey, extra: &[u8], nonce: Option<[u8; 12]>) -> Result<Envelope> {
    let nonce = nonce.unwrap_or_else(|| { let mut n = [0u8; 12]; OsRng.fill_bytes(&mut n); n });
    let ct = Aes256Gcm::new(key.into()).encrypt(Nonce::from_slice(&nonce), Payload { msg: &pad(plaintext)?, aad: &with(h, &[extra]) }).map_err(|_| "encrypt")?;
    let mut msg = context(&h.purpose);
    msg.extend(with(h, &[extra, &nonce, &ct]));
    let sig: Signature = signer.sign(&msg);
    Ok(Envelope { v: 1, purpose: h.purpose.clone(), user_id: h.user_id.clone(), desktop_id: h.desktop_id.clone(), from: h.from.clone(), to: h.to.clone(),
        epoch: h.epoch, session: h.session.clone(), seq: h.seq, issued_at: h.issued_at, tier: h.tier.clone(),
        nonce: URL_SAFE_NO_PAD.encode(nonce), ct: URL_SAFE_NO_PAD.encode(&ct), sig: URL_SAFE_NO_PAD.encode(sig.to_bytes()),
        eph: (!extra.is_empty()).then(|| URL_SAFE_NO_PAD.encode(extra)) })
}

/// Signature check alone (verify before any decryption).
pub fn verify_envelope(env: &Envelope, verifier: &VerifyingKey) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    if env.v != 1 { return Err("bad_version"); }
    let extra = match &env.eph { Some(e) => b64d(e)?, None => Vec::new() };
    let (nonce, ct) = (b64d(&env.nonce)?, b64d(&env.ct)?);
    if nonce.len() != 12 || ct.len() < BUCKETS[0] + 16 { return Err("bad_ciphertext"); }
    let sig = Signature::from_slice(&b64d(&env.sig)?).map_err(|_| "bad_signature")?;
    let h = env.header();
    let mut msg = context(&h.purpose);
    msg.extend(with(&h, &[&extra, &nonce, &ct]));
    verifier.verify(&msg, &sig).map_err(|_| "bad_signature")?;
    Ok((extra, nonce, ct))
}

pub fn open(env: &Envelope, key: &[u8; 32], verifier: &VerifyingKey) -> Result<Vec<u8>> {
    let (extra, nonce, ct) = verify_envelope(env, verifier)?;
    let pt = Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad: &with(&env.header(), &[&extra]) }).map_err(|_| "bad_ciphertext")?;
    unpad(&pt)
}

pub struct WrapInput<'a> { pub user_id: &'a str, pub desktop_id: &'a str, pub device_id: &'a str, pub epoch: u64, pub tier: &'a str,
    pub seq: u64, pub issued_at: u64, pub device_ecdh_spki: &'a [u8], pub desktop_signing_spki: &'a [u8],
    pub request: &'a [u8; 32], pub reply: &'a [u8; 32], pub host_api_token: &'a str }

pub fn make_wrap(w: &WrapInput, signer: &SigningKey, eph: Option<&SecretKey>, nonce: Option<[u8; 12]>) -> Result<Envelope> {
    let fresh;
    let eph = match eph { Some(k) => k, None => { fresh = SecretKey::random(&mut OsRng); &fresh } };
    let eph_spki = eph.public_key().to_public_key_der().map_err(|_| "eph")?.as_bytes().to_vec();
    let device = PublicKey::from_public_key_der(w.device_ecdh_spki).map_err(|_| "bad_device_key")?;
    let z = p256::ecdh::diffie_hellman(eph.to_nonzero_scalar(), device.as_affine());
    let info = enc(&[F::S("llmide/wrap/v1"), F::U(w.epoch), F::S(w.device_id), F::B(&sha(&[w.device_ecdh_spki])), F::B(&sha(&[w.desktop_signing_spki])), F::S(w.tier)]);
    let key = hkdf32(z.raw_secret_bytes(), &sha(&[&enc(&[F::B(&eph_spki), F::B(w.device_ecdh_spki)])]), &info);
    let h = Header { purpose: "wrap".into(), user_id: w.user_id.into(), desktop_id: w.desktop_id.into(), from: w.desktop_id.into(), to: w.device_id.into(),
        epoch: w.epoch, session: String::new(), seq: w.seq, issued_at: w.issued_at, tier: w.tier.into() };
    seal(&h, &key, &enc(&[F::B(w.request), F::B(w.reply), F::S(w.host_api_token)]), signer, &eph_spki, nonce)
}

pub fn key_confirm_plaintext(wrap_sig: &[u8]) -> [u8; 32] { sha(&[b"llmide/keyconfirm/v1", wrap_sig]) }
pub fn auth_message(challenge: &str, role: &str, token_hash_hex: &str) -> String { format!("llmide/relay/auth/v1\n{challenge}\n{role}\n{token_hash_hex}") }

#[cfg(test)]
mod tests {
    use super::*;
    use p256::pkcs8::{DecodePrivateKey, DecodePublicKey};
    const V: &str = include_str!("../../../../schema/relay/v1/vectors/v1.json");
    fn v() -> serde_json::Value { serde_json::from_str(V).unwrap() }
    fn b(s: &serde_json::Value) -> Vec<u8> { URL_SAFE_NO_PAD.decode(s.as_str().unwrap()).unwrap() }
    fn h(s: &serde_json::Value) -> Vec<u8> { (0..s.as_str().unwrap().len()).step_by(2).map(|i| u8::from_str_radix(&s.as_str().unwrap()[i..i + 2], 16).unwrap()).collect() }

    #[test]
    fn canonical_subkeys_and_padding_match_the_vectors() {
        let v = v();
        assert_eq!(enc(&[F::U(1), F::S("ab"), F::S("")]), h(&v["canonical"]["hex"]));
        let ids = &v["subkeys"]["ids"];
        let root: [u8; 32] = h(&v["subkeys"]["rootHex"]).try_into().unwrap();
        let (rq, rp) = device_keys(&root, ids["userId"].as_str().unwrap(), ids["desktopId"].as_str().unwrap(), ids["deviceId"].as_str().unwrap(), 7);
        assert_eq!(rq.to_vec(), h(&v["subkeys"]["requestHex"]));
        assert_eq!(rp.to_vec(), h(&v["subkeys"]["replyHex"]));
        assert_eq!(pad(v["envelope"]["frame"].as_str().unwrap().as_bytes()).unwrap().len() as u64, v["padding"]["bucket"].as_u64().unwrap());
    }

    #[test]
    fn opens_the_vector_envelope_and_reseals_the_same_ciphertext() {
        let v = v();
        let env: Envelope = serde_json::from_value(v["envelope"]["env"].clone()).unwrap();
        let key: [u8; 32] = h(&v["envelope"]["keyHex"]).try_into().unwrap();
        let vk = VerifyingKey::from_public_key_der(&b(&v["keys"]["deviceSigningSpki"])).unwrap();
        assert_eq!(open(&env, &key, &vk).unwrap(), v["envelope"]["frame"].as_str().unwrap().as_bytes());
        let sk = SigningKey::from_pkcs8_der(&b(&v["keys"]["deviceSigningPkcs8"])).unwrap();
        let nonce: [u8; 12] = h(&v["envelope"]["nonceHex"]).try_into().unwrap();
        let again = seal(&env.header(), &key, v["envelope"]["frame"].as_str().unwrap().as_bytes(), &sk, &[], Some(nonce)).unwrap();
        assert_eq!(again.ct, env.ct);
    }

    #[test]
    fn every_vector_negative_fails_closed() {
        let v = v();
        let key: [u8; 32] = h(&v["envelope"]["keyHex"]).try_into().unwrap();
        let vk = VerifyingKey::from_public_key_der(&b(&v["keys"]["deviceSigningSpki"])).unwrap();
        for n in v["negatives"].as_array().unwrap() {
            let mut j = v["envelope"]["env"].clone();
            let (op, rest) = n.as_str().unwrap().split_once(':').unwrap();
            match op {
                "flip" => { let mut x = b(&j[rest]); x[0] ^= 1; j[rest] = URL_SAFE_NO_PAD.encode(x).into(); }
                "truncate" => { let mut x = b(&j[rest]); x.pop(); j[rest] = URL_SAFE_NO_PAD.encode(x).into(); }
                _ => { let (k, val) = rest.split_once('=').unwrap(); j[k] = val.parse::<u64>().map(serde_json::Value::from).unwrap_or_else(|_| val.into()); }
            }
            let env: Envelope = serde_json::from_value(j).unwrap();
            assert!(open(&env, &key, &vk).is_err(), "{n} must fail");
        }
    }

    #[test]
    fn wrap_is_built_like_the_reference_and_keyconfirm_matches() {
        let v = v();
        let w: Envelope = serde_json::from_value(v["wrap"]["env"].clone()).unwrap();
        let ids = &v["subkeys"]["ids"];
        let root: [u8; 32] = h(&v["subkeys"]["rootHex"]).try_into().unwrap();
        let (rq, rp) = device_keys(&root, ids["userId"].as_str().unwrap(), ids["desktopId"].as_str().unwrap(), ids["deviceId"].as_str().unwrap(), 7);
        let sk = SigningKey::from_pkcs8_der(&b(&v["keys"]["desktopSigningPkcs8"])).unwrap();
        let eph = p256::SecretKey::from_pkcs8_der(&b(&v["keys"]["ephPkcs8"])).unwrap();
        let ours = make_wrap(&WrapInput {
            user_id: ids["userId"].as_str().unwrap(), desktop_id: ids["desktopId"].as_str().unwrap(), device_id: ids["deviceId"].as_str().unwrap(),
            epoch: 7, tier: "web", seq: 9, issued_at: 1762300000001, device_ecdh_spki: &b(&v["keys"]["deviceEcdhSpki"]),
            desktop_signing_spki: &b(&v["keys"]["desktopSigningSpki"]), request: &rq, reply: &rp, host_api_token: v["wrap"]["hostApiToken"].as_str().unwrap(),
        }, &sk, Some(&eph), Some([0x33; 12])).unwrap();
        assert_eq!(ours.ct, w.ct, "same ECDH, wrap key, nonce and plaintext give the same ciphertext");
        assert_eq!(ours.eph, w.eph);
        assert_eq!(key_confirm_plaintext(&b(&v["wrap"]["env"]["sig"])).to_vec(), h(&v["keyconfirm"]["plaintextHex"]));
        let vk = VerifyingKey::from_public_key_der(&b(&v["keys"]["desktopSigningSpki"])).unwrap();
        let rogue = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let mut forged = ours.clone();
        forged.sig = seal(&ours.header(), &[0; 32], b"x", &rogue, &[], None).unwrap().sig;
        assert!(verify_envelope(&forged, &vk).is_err());
    }

    #[test]
    fn auth_message_matches_and_cap_is_two_to_the_24() {
        let v = v();
        let s = v["auth"]["messageUtf8"].as_str().unwrap();
        let p: Vec<&str> = s.split('\n').collect();
        assert_eq!(auth_message(p[1], p[2], p[3]), s);
        assert_eq!(KEY_MESSAGE_CAP, 16_777_216);
    }
}
