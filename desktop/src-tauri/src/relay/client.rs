//! Outbound relay connection (relay plan R-4): one WSS socket to accounts/relay, challenge auth with the desktop
//! signing key, desktop-side verification of every envelope against the LOCAL registry, one loopback bridge session
//! per device session. Off by default (registry.enabled); off means no outbound traffic at all.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

use super::crypto::{self, Envelope, Header, KEY_MESSAGE_CAP};
use super::registry::Registry;
use crate::secrets::SecretBackend;

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


pub struct ClientConfig {
    pub relay_url: String,
    pub core_url: String,
    pub store: Box<dyn SecretBackend>,
    pub token: Arc<dyn Fn() -> Result<String, String> + Send + Sync>,
    pub signer: SigningKey,
    pub signing_spki: Vec<u8>,
}

#[derive(Clone, Debug, Default, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus { pub connected: bool, pub devices_online: usize, pub enabled: bool }

pub struct RelayHandle {
    stop: Arc<AtomicBool>,
    status: Arc<Mutex<RelayStatus>>,
}

impl RelayHandle {
    pub fn stop(&self) { self.stop.store(true, Ordering::SeqCst); }
    pub fn status(&self) -> RelayStatus { self.status.lock().map(|s| s.clone()).unwrap_or_default() }
}

impl Drop for RelayHandle {
    fn drop(&mut self) { self.stop(); }
}

fn read_timeout(ws: &WebSocket<MaybeTlsStream<std::net::TcpStream>>, ms: u64) {
    let t = Some(Duration::from_millis(ms));
    match ws.get_ref() {
        MaybeTlsStream::Plain(s) => { let _ = s.set_read_timeout(t); }
        MaybeTlsStream::Rustls(s) => { let _ = s.get_ref().set_read_timeout(t); }
        _ => {}
    }
}

fn socket<'a>(ws: &'a mut WebSocket<MaybeTlsStream<std::net::TcpStream>>) -> &'a mut WebSocket<MaybeTlsStream<std::net::TcpStream>> { ws }

fn send_text(ws: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>, text: String) -> Result<(), ()> {
    ws.send(Message::text(text)).map_err(|_| ())
}

fn send_env(ws: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>, env_json: &str) -> Result<(), ()> {
    send_text(ws, format!("{{\"t\":\"env\",\"env\":{env_json}}}"))
}

fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

fn connect(cfg: &ClientConfig) -> Result<(WebSocket<MaybeTlsStream<std::net::TcpStream>>, Desktop, HashMap<String, (String, super::bridge::BridgeSession)>, String), String> {
    let mut reg = super::registry::load(cfg.store.as_ref())?;
    if !reg.enabled { return Err("relay is off".into()); }
    if reg.desktop_id.is_empty() { return Err("register this desktop first".into()); }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut ws = tungstenite::connect(cfg.relay_url.as_str()).map_err(|e| format!("relay connect: {e}"))?.0;
    read_timeout(&ws, 10_000);
    // challenge
    let challenge = loop {
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t).map_err(|_| "bad relay challenge")?;
                if v["t"] == "challenge" { break v["nonce"].as_str().ok_or("bad challenge")?.to_string(); }
            }
            Ok(_) => {}
            Err(e) => return Err(format!("relay challenge: {e}")),
        }
    };
    let token = (cfg.token)().map_err(|e| format!("relay token: {e}"))?;
    let proof = auth_proof(&cfg.signer, &challenge, &token);
    send_text(&mut ws, serde_json::json!({ "t": "auth", "token": token, "proof": proof }).to_string()).map_err(|_| "relay auth")?;
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t).map_err(|_| "bad relay ready")?;
                match v["t"].as_str() {
                    Some("ready") => {
                        if v["role"] != "desktop" || v["userId"].as_str() != Some(reg.user_id.as_str()) || v["desktopId"].as_str() != Some(reg.desktop_id.as_str()) {
                            return Err("relay identity mismatch".into());
                        }
                        break;
                    }
                    Some("err") => return Err(format!("relay refused auth: {}", v["code"].as_str().unwrap_or("unknown"))),
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(e) => return Err(format!("relay ready: {e}")),
        }
    }
    read_timeout(&ws, 50);
    let mut bridges = HashMap::new();
    // pending wraps
    for d in &reg.devices {
        if let Some(w) = &d.wrap { let _ = send_env(&mut ws, w); }
    }
    reg.enabled = true;
    Ok((ws, Desktop::new(reg, cfg.signer.clone()), bridges, challenge))
}

fn run_loop(cfg: ClientConfig, status: Arc<Mutex<RelayStatus>>, stop: Arc<AtomicBool>) {
    let mut backoff = 1u64;
    while !stop.load(Ordering::SeqCst) {
        match connect(&cfg) {
            Ok((mut ws, mut desktop, mut bridges, challenge)) => {
                if let Ok(mut s) = status.lock() { s.connected = true; s.devices_online = 0; }
                let mut last_auth = now_ms();
                let mut last_reload = now_ms();
                let mut sent_wraps = std::collections::HashSet::new();
                backoff = 1;
                loop {
                    if stop.load(Ordering::SeqCst) { break; }
                    // A link can be confirmed while this socket is up. Reload the registry, merge the devices this
                    // connection changed, and deliver any new pending wrap without clobbering the new device.
                    if now_ms().saturating_sub(last_reload) >= 1_500 {
                        if let Ok(current) = super::registry::load(cfg.store.as_ref()) {
                            for d in &current.devices {
                                if let Some(w) = &d.wrap {
                                    if sent_wraps.insert(d.device_id.clone()) { let _ = send_env(&mut ws, w); }
                                }
                            }
                            desktop.reg = current;
                        }
                        last_reload = now_ms();
                    }
                    // pump core → relay
                    for (session, (device, bridge)) in bridges.iter() {
                        while let Some(frame) = bridge.try_recv() {
                            if let Some(env) = desktop.reply(device, session, &frame, now_ms()) { let _ = send_text(&mut ws, env); }
                        }
                    }
                    if now_ms().saturating_sub(last_auth) > 9 * 60_000 {
                        if let Ok(token) = (cfg.token)() {
                            let proof = auth_proof(&cfg.signer, &challenge, &token);
                            let _ = send_text(&mut ws, serde_json::json!({ "t": "auth", "token": token, "proof": proof }).to_string());
                        }
                        last_auth = now_ms();
                    }
                    match ws.read() {
                        Ok(Message::Text(t)) => {
                            let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else { break; };
                            match v["t"].as_str() {
                                Some("ping") => { let _ = send_text(&mut ws, "{\"t\":\"pong\"}".into()); }
                                Some("env") => {
                                    let Ok(env) = serde_json::from_value::<Envelope>(v["env"].clone()) else { continue; };
                                    let outs = desktop.on_env(env, now_ms());
                                    if let Ok(mut current) = super::registry::load(cfg.store.as_ref()) {
                                        for d in desktop.reg.devices.clone() { current.add(d); }
                                        current.enabled = desktop.reg.enabled;
                                        let _ = super::registry::save(cfg.store.as_ref(), &current);
                                        desktop.reg = current;
                                    }
                                    for out in outs {
                                        match out {
                                            Out::Relay(t) => { let _ = send_text(&mut ws, t); }
                                            Out::Bridge { session, frame, .. } => { if let Some((_, b)) = bridges.get(&session) { let _ = b.send(&frame); } }
                                            Out::OpenBridge { device, session, tier } => {
                                                if let Ok(b) = super::bridge::BridgeSession::connect(&cfg.core_url, &tier) {
                                                    bridges.insert(session, (device, b));
                                                }
                                            }
                                            Out::CloseDevice(device) => {
                                                for (_, (d, _)) in bridges.iter().filter(|(_, (d, _))| d == &device) { let _ = d; }
                                                let gone: Vec<String> = bridges.iter().filter(|(_, (d, _))| d == &device).map(|(k, _)| k.clone()).collect();
                                                for k in gone { bridges.remove(&k); }
                                            }
                                        }
                                    }
                                    if let Ok(mut s) = status.lock() { s.devices_online = bridges.len(); }
                                }
                                Some("peer") if v["online"] == false => {
                                    if let Some(id) = v["id"].as_str() {
                                        let gone = desktop.drop_device(id);
                                        for k in gone { bridges.remove(&k); }
                                        if let Ok(mut s) = status.lock() { s.devices_online = bridges.len(); }
                                    }
                                }
                                Some("err") => break,
                                _ => {}
                            }
                        }
                        Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => break,
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                        Err(_) => break,
                    }
                }
            }
            Err(_) => {}
        }
        if let Ok(mut s) = status.lock() { s.connected = false; s.devices_online = 0; }
        if stop.load(Ordering::SeqCst) { break; }
        let jitter = (rand_core::OsRng.next_u32() % 21) as u64;
        std::thread::sleep(Duration::from_secs(backoff + jitter / 10));
        backoff = (backoff * 2).min(60);
    }
}

pub fn start(cfg: ClientConfig) -> RelayHandle {
    let status = Arc::new(Mutex::new(RelayStatus::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let s = status.clone(); let st = stop.clone();
    std::thread::spawn(move || run_loop(cfg, s, st));
    RelayHandle { stop, status }
}

#[cfg(test)]
mod socket_tests {
    use super::*;
    use p256::pkcs8::EncodePublicKey;
    #[test]
    fn socket_loop_authenticates_and_pumps_a_frame_through_the_bridge() {
        use std::io::Write;
        use std::net::TcpListener;
        use std::sync::mpsc::channel;
        use std::time::Duration;
        use tungstenite::Message;

        let desk = SigningKey::random(&mut OsRng);
        let dev = SigningKey::random(&mut OsRng);
        let mut reg = crate::relay::registry::Registry { enabled: true, user_id: "u1".into(), desktop_id: "dk1".into(), ..Default::default() };
        reg.ensure_root();
        let spki = |k: &SigningKey| URL_SAFE_NO_PAD.encode(k.verifying_key().to_public_key_der().unwrap().as_bytes());
        reg.add(crate::relay::registry::Device { device_id: "dv1".into(), label: "P".into(), tier: "web".into(), signing_key: spki(&dev), ecdh_key: String::new(),
            linked_at: 0, confirmed: true, host_api_token: "t".into(), wrap: None, wrap_sig: String::new(), reply_count: 0 });
        let (rq, rp) = crypto::device_keys(&reg.root_bytes().unwrap(), "u1", "dk1", "dv1", reg.epoch);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let open = crypto::seal(&Header { purpose: "open".into(), user_id: "u1".into(), desktop_id: "dk1".into(), from: "dv1".into(), to: "dk1".into(), epoch: 1, session: String::new(), seq: 0, issued_at: now, tier: String::new() }, &rq, &[7u8; 16], &dev, &[], None).unwrap();
        // The fake relay builds the request with the session id from the opened envelope, not a guess.

        let relay = TcpListener::bind("127.0.0.1:0").unwrap(); let relay_port = relay.local_addr().unwrap().port();
        let core = TcpListener::bind("127.0.0.1:0").unwrap(); let core_port = core.local_addr().unwrap().port();
        let (done_tx, done_rx) = channel::<String>();
        let desk2 = desk.clone();
        let dev2 = dev.clone();
        std::thread::spawn(move || {
            let (stream, _) = relay.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_millis(500))).ok();
            let mut ws = tungstenite::accept(stream).unwrap();
            ws.send(Message::text(serde_json::json!({ "t": "challenge", "nonce": "Y2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtMDA" }).to_string())).unwrap();
            let auth: serde_json::Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            if auth["proof"] != auth_proof(&desk2, "Y2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtMDA", auth["token"].as_str().unwrap()) { return; }
            ws.send(Message::text(serde_json::json!({ "t": "ready", "role": "desktop", "userId": "u1", "deviceId": "dk1", "desktopId": "dk1" }).to_string())).unwrap();
            ws.send(Message::text(serde_json::json!({ "t": "env", "env": open }).to_string())).unwrap();
            let mut sent_request = false;
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                match ws.read() {
                    Ok(Message::Text(t)) => {
                        let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                        let Some(e) = v.get("env") else { continue };
                        match e["purpose"].as_str() {
                            Some("opened") if !sent_request => {
                                let sid = e["session"].as_str().unwrap_or_default().to_string();
                                let request = crypto::seal(&Header { purpose: "request".into(), user_id: "u1".into(), desktop_id: "dk1".into(), from: "dv1".into(), to: "dk1".into(), epoch: 1, session: sid, seq: 1, issued_at: now, tier: String::new() }, &rq, b"{\"x\":1}", &dev2, &[], None).unwrap();
                                ws.send(Message::text(serde_json::json!({ "t": "env", "env": request }).to_string())).unwrap(); sent_request = true;
                            }
                            Some("reply") => { let env: Envelope = serde_json::from_value(e.clone()).unwrap(); if let Ok(pt) = crypto::open(&env, &rp, desk2.verifying_key()) { let _ = done_tx.send(String::from_utf8_lossy(&pt).into_owned()); return; } }
                            _ => {}
                        }
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                    Err(_) => return,
                }
            }
        });
        std::thread::spawn(move || {
            let (stream, _) = core.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_millis(500))).ok();
            let mut ws = tungstenite::accept(stream).unwrap();
            loop {
                match ws.read() {
                    Ok(Message::Text(t)) => { ws.send(Message::text(t)).unwrap(); }
                    Ok(Message::Close(_)) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        });

        let store = Box::new(crate::secrets::MemoryBackend::default());
        crate::relay::registry::save(store.as_ref(), &reg).unwrap();
        let cfg = ClientConfig { relay_url: format!("ws://127.0.0.1:{relay_port}/relay/v1"), core_url: format!("http://127.0.0.1:{core_port}/"),
            store, token: std::sync::Arc::new(|| Ok("tok-0123456789abcdef0123456789".to_string())), signer: desk.clone(),
            signing_spki: desk.verifying_key().to_public_key_der().unwrap().as_bytes().to_vec() };
        let handle = start(cfg);
        let got = done_rx.recv_timeout(Duration::from_secs(6)).unwrap();
        assert_eq!(got, "{\"x\":1}");
        handle.stop();
    }

}
