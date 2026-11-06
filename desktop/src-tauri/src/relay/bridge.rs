//! Loopback client for the core's /host-api/relay-bridge (relay plan R-4/R-5). Sends the bus host proof and the
//! device tier; the core treats the connection as an ordinary Host API session. Never logs frames.
use std::net::TcpStream;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::time::Duration;

use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::{Message, WebSocket};

pub fn bridge_url(core_url: &str) -> Result<String, String> {
    let u = url::Url::parse(core_url).map_err(|_| "bad core url")?;
    if u.scheme() != "http" || u.host_str() != Some("127.0.0.1") { return Err("the relay bridge is loopback-only".into()); }
    Ok(format!("ws://127.0.0.1:{}/host-api/relay-bridge", u.port_or_known_default().unwrap_or(80)))
}

fn connect(core_url: &str, tier: &str) -> Result<WebSocket<TcpStream>, String> {
    let url = bridge_url(core_url)?;
    let mut req = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    let proof = crate::host_approval::bus_proof()?;
    req.headers_mut().insert("x-llmide-host-nonce", HeaderValue::from_str(&proof).map_err(|_| "bad proof")?);
    req.headers_mut().insert("x-llmide-relay-tier", HeaderValue::from_str(tier).map_err(|_| "bad tier")?);
    let stream = TcpStream::connect(url.trim_start_matches("ws://").split('/').next().unwrap()).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_millis(50))).map_err(|e| e.to_string())?;
    let (ws, _) = tungstenite::client(req, stream).map_err(|_| "the core refused the relay bridge".to_string())?;
    Ok(ws)
}

/// One bridged Host API connection, pumped by its own thread: core frames arrive on `rx`, frames to the core go on `tx`.
pub struct BridgeSession { tx: Sender<Option<String>>, rx: Receiver<String> }

impl BridgeSession {
    pub fn connect(core_url: &str, tier: &str) -> Result<Self, String> {
        let mut ws = connect(core_url, tier)?;
        let (to_core, from_main) = channel::<Option<String>>();
        let (to_main, rx) = channel::<String>();
        std::thread::spawn(move || loop {
            loop {
                match from_main.try_recv() {
                    Ok(Some(t)) => { if ws.send(Message::text(t)).is_err() { return; } }
                    // Explicit close, or every sender dropped (the session was dropped): close the socket and stop.
                    Ok(None) | Err(TryRecvError::Disconnected) => { let _ = ws.close(None); return; }
                    Err(TryRecvError::Empty) => break,
                }
            }
            match ws.read() {
                Ok(Message::Text(t)) => { if to_main.send(t.to_string()).is_err() { return; } }
                Ok(Message::Close(_)) => return,
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => return,
            }
        });
        Ok(BridgeSession { tx: to_core, rx })
    }
    pub fn send(&self, frame: &str) -> bool { self.tx.send(Some(frame.to_string())).is_ok() }
    pub fn try_recv(&self) -> Option<String> { self.rx.try_recv().ok() }
    pub fn close(&self) { let _ = self.tx.send(None); }
}

impl Drop for BridgeSession {
    fn drop(&mut self) { self.close(); }
}

/// Pairs a relay device with the core through the bridge and returns its Host API device token (capped to `tier`).
pub fn pair(core_url: &str, tier: &str, label: &str, pin: &str) -> Result<String, String> {
    let s = BridgeSession::connect(core_url, tier)?;
    let frame = |id: &str, command: &str, payload: serde_json::Value| serde_json::json!({ "apiVersion": 1, "id": id, "type": "request", "command": command, "payload": payload, "ts": 0 }).to_string();
    s.send(&frame("h", "host.hello", serde_json::json!({ "clientName": label, "clientVersion": "relay-1", "platform": if tier == "ios" { "ios" } else { "web" }, "apiVersions": [1] })));
    s.send(&frame("p", "host.auth.pair", serde_json::json!({ "pin": pin })));
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < deadline {
        if let Some(text) = s.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "bad core frame")?;
            if v["replyTo"] == "p" {
                s.close();
                return v["result"]["token"].as_str().map(str::to_string).ok_or_else(|| "The PIN was refused. Try again.".into());
            }
        } else { std::thread::sleep(Duration::from_millis(20)); }
    }
    s.close();
    Err("The core did not answer the pairing in time.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dropping_a_session_closes_its_bridge_socket() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (closed_tx, closed_rx) = channel::<()>();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
            let mut ws = tungstenite::accept(stream).unwrap();
            loop {
                match ws.read() {
                    Ok(Message::Close(_)) | Err(_) => { let _ = closed_tx.send(()); return; }
                    Ok(_) => {}
                }
            }
        });
        let session = BridgeSession::connect(&format!("http://127.0.0.1:{port}/"), "web").unwrap();
        drop(session);
        closed_rx.recv_timeout(Duration::from_secs(3)).expect("the pump thread closed the socket");
    }

    #[test]
    fn bridge_url_is_loopback_only() {
        assert_eq!(bridge_url("http://127.0.0.1:3456/").unwrap(), "ws://127.0.0.1:3456/host-api/relay-bridge");
        assert!(bridge_url("http://10.0.0.1:3456/").is_err());
        assert!(bridge_url("https://127.0.0.1:3456/").is_err());
    }
}
