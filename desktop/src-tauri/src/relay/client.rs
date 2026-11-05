//! Outbound relay connection (relay plan R-4): one WSS socket to accounts/relay, challenge auth with the desktop
//! signing key, desktop-side verification of every envelope against the LOCAL registry, one loopback bridge session
//! per device session. Off by default (registry.enabled); off means no outbound traffic at all.
use std::collections::HashMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

use super::crypto::{self, Envelope, Header, KEY_MESSAGE_CAP};
use super::registry::Registry;

const SKEW_MS: u64 = 10 * 60_000;
const MAX_SESSIONS: usize = 4;
const MAX_SESSIONS_PER_DEVICE: usize = 2;

#[derive(Debug)]
pub enum Out { Relay(String), Bridge { device: String, session: String, frame: String }, OpenBridge { device: String, session: String, tier: String }, CloseDevice(String) }

struct Session { device: String, recv_seq: u64, send_seq: u64 }

pub struct Desktop { pub reg: Registry, pub signer: SigningKey, sessions: HashMap<String, Session> }

impl Desktop {
    pub fn new(reg: Registry, signer: SigningKey) -> Self { Desktop { reg, signer, sessions: HashMap::new() } }

    fn keys(&self, device: &str) -> Option<([u8; 32], [u8; 32])> {
        let root = self.reg.root_bytes().ok()?;
        Some(crypto::device_keys(&root, &self.reg.user_id, &self.reg.desktop_id, device, self.reg.epoch))
    }
    fn header(&self, purpose: &str, device: &str, session: &str, seq: u64, now: u64) -> Header {
        Header { purpose: purpose.into(), user_id: self.reg.user_id.clone(), desktop_id: self.reg.desktop_id.clone(), from: self.reg.desktop_id.clone(),
            to: device.into(), epoch: self.reg.epoch, session: session.into(), seq, issued_at: now, tier: String::new() }
    }
    fn seal_down(&mut self, purpose: &str, device: &str, session: &str, seq: u64, pt: &[u8], now: u64) -> Option<String> {
        let d = self.reg.devices.iter_mut().find(|d| d.device_id == device)?;
        d.reply_count += 1;
        if d.reply_count > KEY_MESSAGE_CAP { return None; }
        let (_, rp) = self.keys(device)?;
        let env = crypto::seal(&self.header(purpose, device, session, seq, now), &rp, pt, &self.signer, &[], None).ok()?;
        serde_json::to_string(&serde_json::json!({ "t": "env", "env": env })).ok()
    }

    /// Every check fails closed and silently (a hostile relay learns nothing from refusals).
    pub fn on_env(&mut self, env: Envelope, now: u64) -> Vec<Out> {
        let ok_header = env.user_id == self.reg.user_id && env.desktop_id == self.reg.desktop_id && env.to == self.reg.desktop_id && env.epoch == self.reg.epoch;
        if !ok_header || now.abs_diff(env.issued_at) > SKEW_MS { return vec![]; }
        let Some(dev) = self.reg.device(&env.from).cloned() else { return vec![] };
        let Ok(spki) = URL_SAFE_NO_PAD.decode(&dev.signing_key) else { return vec![] };
        let Ok(vk) = VerifyingKey::from_public_key_der(&spki) else { return vec![] };
        let Some((rq, _)) = self.keys(&dev.device_id) else { return vec![] };
        let Ok(pt) = crypto::open(&env, &rq, &vk) else { return vec![] };
        match env.purpose.as_str() {
            "keyconfirm" => { self.reg.confirm(&dev.device_id, &pt); vec![] }
            _ if !dev.confirmed => vec![],
            "open" if pt.len() == 16 && env.session.is_empty() => {
                let per_device = self.sessions.values().filter(|s| s.device == dev.device_id).count();
                if self.sessions.len() >= MAX_SESSIONS || per_device >= MAX_SESSIONS_PER_DEVICE { return vec![]; }
                let mut sid = [0u8; 16];
                OsRng.fill_bytes(&mut sid);
                let sid = URL_SAFE_NO_PAD.encode(sid);
                self.sessions.insert(sid.clone(), Session { device: dev.device_id.clone(), recv_seq: 0, send_seq: 0 });
                let Some(opened) = self.seal_down("opened", &dev.device_id, &sid, 0, &pt, now) else { return vec![] };
                vec![Out::OpenBridge { device: dev.device_id.clone(), session: sid, tier: dev.tier.clone() }, Out::Relay(opened)]
            }
            "request" => {
                let Some(s) = self.sessions.get_mut(&env.session) else { return vec![] };
                if s.device != dev.device_id || env.seq <= s.recv_seq { return vec![]; }
                s.recv_seq = env.seq;
                match String::from_utf8(pt) { Ok(frame) => vec![Out::Bridge { device: dev.device_id, session: env.session, frame }], Err(_) => vec![] }
            }
            _ => vec![],
        }
    }

    pub fn reply(&mut self, device: &str, session: &str, frame: &str, now: u64) -> Option<String> {
        let s = self.sessions.get_mut(session)?;
        if s.device != device { return None; }
        s.send_seq += 1;
        let seq = s.send_seq;
        self.seal_down("reply", device, session, seq, frame.as_bytes(), now)
    }

    pub fn drop_device(&mut self, device: &str) -> Vec<String> {
        let gone: Vec<String> = self.sessions.iter().filter(|(_, s)| s.device == device).map(|(k, _)| k.clone()).collect();
        for k in &gone { self.sessions.remove(k); }
        gone
    }
}

pub fn auth_proof(signer: &SigningKey, challenge: &str, access_token: &str) -> String {
    let hash: String = Sha256::digest(access_token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let sig: Signature = signer.sign(crypto::auth_message(challenge, "desktop", &hash).as_bytes());
    URL_SAFE_NO_PAD.encode(sig.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::crypto::{self, Header};
    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePublicKey;
    use rand_core::OsRng;

    fn fixture() -> (Desktop, SigningKey, [u8; 32], [u8; 32]) {
        let desk = SigningKey::random(&mut OsRng);
        let dev = SigningKey::random(&mut OsRng);
        let mut reg = crate::relay::registry::Registry { user_id: "u1".into(), desktop_id: "dk1".into(), ..Default::default() };
        reg.ensure_root();
        let spki = |k: &SigningKey| URL_SAFE_NO_PAD.encode(k.verifying_key().to_public_key_der().unwrap().as_bytes());
        reg.add(crate::relay::registry::Device { device_id: "dv1".into(), label: "P".into(), tier: "web".into(), signing_key: spki(&dev), ecdh_key: String::new(),
            linked_at: 0, confirmed: true, host_api_token: "t".into(), wrap: None, wrap_sig: String::new(), reply_count: 0 });
        let (rq, rp) = crypto::device_keys(&reg.root_bytes().unwrap(), "u1", "dk1", "dv1", reg.epoch);
        (Desktop::new(reg, desk), dev, rq, rp)
    }
    fn up(dev: &SigningKey, key: &[u8; 32], purpose: &str, session: &str, seq: u64, pt: &[u8], now: u64) -> Envelope {
        let h = Header { purpose: purpose.into(), user_id: "u1".into(), desktop_id: "dk1".into(), from: "dv1".into(), to: "dk1".into(), epoch: 1, session: session.into(), seq, issued_at: now, tier: String::new() };
        crypto::seal(&h, key, pt, dev, &[], None).unwrap()
    }

    #[test]
    fn open_then_request_reaches_the_bridge_and_replays_are_dropped() {
        let (mut d, dev, rq, _rp) = fixture();
        let now = 1_762_300_000_000;
        let out = d.on_env(up(&dev, &rq, "open", "", 0, &[7u8; 16], now), now);
        let (session, opened) = match &out[..] { [Out::OpenBridge { session, .. }, Out::Relay(t)] => (session.clone(), t.clone()), o => panic!("{o:?}") };
        assert!(opened.contains("\"purpose\":\"opened\""));
        let req = up(&dev, &rq, "request", &session, 1, b"{\"x\":1}", now);
        assert!(matches!(&d.on_env(req.clone(), now)[..], [Out::Bridge { frame, .. }] if frame == "{\"x\":1}"));
        assert!(d.on_env(req, now).is_empty(), "replayed seq dropped");
        assert!(d.on_env(up(&dev, &rq, "request", "AAAAAAAAAAAAAAAAAAAAAA", 2, b"{}", now), now).is_empty(), "unknown session dropped");
        assert!(d.on_env(up(&dev, &rq, "request", &session, 3, b"{}", now + 11 * 60_000), now).is_empty(), "skew dropped");
    }

    #[test]
    fn unregistered_or_unconfirmed_devices_and_forged_envelopes_are_dropped() {
        let (mut d, dev, rq, _) = fixture();
        let now = 1_762_300_000_000;
        let mut e = up(&dev, &rq, "open", "", 0, &[1u8; 16], now);
        e.from = "rogue".into();
        assert!(d.on_env(e, now).is_empty(), "C3: not in the local registry");
        let rogue = SigningKey::random(&mut OsRng);
        assert!(d.on_env(up(&rogue, &rq, "open", "", 0, &[1u8; 16], now), now).is_empty(), "wrong signer");
        d.reg.devices[0].confirmed = false;
        assert!(d.on_env(up(&dev, &rq, "open", "", 0, &[1u8; 16], now), now).is_empty(), "no keyconfirm yet");
    }

    #[test]
    fn replies_are_sealed_for_the_session_with_increasing_seq() {
        let (mut d, dev, rq, rp) = fixture();
        let now = 1_762_300_000_000;
        let out = d.on_env(up(&dev, &rq, "open", "", 0, &[7u8; 16], now), now);
        let Out::OpenBridge { session, .. } = &out[0] else { panic!() };
        let a = d.reply("dv1", session, "{\"r\":1}", now).unwrap();
        let b = d.reply("dv1", session, "{\"r\":2}", now).unwrap();
        let ea: Envelope = serde_json::from_value(serde_json::from_str::<serde_json::Value>(&a).unwrap()["env"].clone()).unwrap();
        let eb: Envelope = serde_json::from_value(serde_json::from_str::<serde_json::Value>(&b).unwrap()["env"].clone()).unwrap();
        assert!(eb.seq > ea.seq && ea.seq >= 1);
        assert_eq!(crypto::open(&ea, &rp, d.signer.verifying_key()).unwrap(), b"{\"r\":1}");
    }
}
