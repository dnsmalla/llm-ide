//! Loopback-only HTTP/SSE proxy from the webview to the pinned hub.
//!
//! The webview keeps talking to `http://127.0.0.1:<port>/<32-byte-token>/…`, so the existing core
//! client's loopback rule and the CSP are unchanged. The proxy forwards to `https://hub` through an
//! agent whose rustls verifier enforces the leaf-SPKI pin. It adds no credentials of its own, never
//! follows a redirect, caps request bodies at 8 MiB, and rejects any path without the token.
//!
//! The token is in the base URL the host hands the shell; the UI displays only the origin.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::remote_tls::pinned_agent;

pub const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_HEADERS: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub struct ProxyHandle {
    pub url: String,
    pub token: String,
    hub: String,
    stop: Arc<AtomicBool>,
    port: u16,
}

impl ProxyHandle {
    /// The base URL without the token, for display/diagnostics.
    pub fn display_url(&self) -> String { format!("http://127.0.0.1:{}", self.port) }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

#[derive(Debug)]
struct ParsedRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    origin: Option<String>,
    body: Vec<u8>,
}

fn read_headers(stream: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>), FsError> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    loop {
        if buf.len() > MAX_HEADERS { return Err(herr("proxy_too_large", "the request headers are too large")); }
        if let Some(pos) = find_headers_end(&buf) {
            // The body often arrives in the same read; keep those bytes instead of waiting for them again.
            return Ok((buf[..pos + 4].to_vec(), buf[pos + 4..].to_vec()));
        }
        let n = stream.read(&mut chunk).map_err(|e| herr("proxy_io", format!("read failed: {e}")))?;
        if n == 0 { return Err(herr("proxy_io", "the client closed before the headers ended")); }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_request(head: &[u8], token: &str, leftover: &[u8], stream: &mut TcpStream) -> Result<ParsedRequest, FsError> {
    let text = std::str::from_utf8(head).map_err(|_| herr("proxy_bad", "the request headers are not UTF-8"))?;
    let mut lines = text.split("\r\n");
    let first = lines.next().ok_or_else(|| herr("proxy_bad", "the request line is missing"))?;
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let raw_path = parts.next().unwrap_or("").to_string();
    let version = parts.next().unwrap_or("");
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS") || version != "HTTP/1.1" {
        return Err(herr("proxy_bad", "unsupported request line"));
    }
    let prefix = format!("/{token}/");
    let Some(rest) = raw_path.strip_prefix(&prefix) else {
        return Err(herr("proxy_not_found", "unknown proxy path"));
    };
    if rest.is_empty() { return Err(herr("proxy_not_found", "unknown proxy path")); }
    let path = format!("/{rest}");
    let mut headers = Vec::new();
    let mut origin: Option<String> = None;
    let mut content_length = 0usize;
    let mut chunked = false;
    for line in lines {
        if line.is_empty() { break; }
        let (name, value) = line.split_once(':').ok_or_else(|| herr("proxy_bad", "malformed header"))?;
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name.is_empty() || value.contains(['\r', '\n']) { return Err(herr("proxy_bad", "malformed header")); }
        if name == "transfer-encoding" && value.eq_ignore_ascii_case("chunked") { chunked = true; }
        if name == "content-length" {
            content_length = value.parse::<usize>().map_err(|_| herr("proxy_bad", "bad content length"))?;
        }
        if name == "origin" { origin = Some(value.to_string()); continue; }
        if matches!(name.as_str(), "host" | "connection" | "transfer-encoding" | "content-length" | "proxy-connection" | "upgrade") { continue; }
        if matches!(name.as_str(), "authorization" | "content-type" | "accept" | "last-event-id" | "x-llmide-client" | "cookie") {
            headers.push((name, value.to_string()));
        }
    }
    if chunked { return Err(herr("proxy_bad", "chunked request bodies are not accepted")); }
    if content_length > MAX_BODY { return Err(herr("proxy_too_large", "the request body is too large")); }
    if leftover.len() > content_length { return Err(herr("proxy_bad", "the request body is longer than content-length")); }
    let mut body = leftover.to_vec();
    body.resize(content_length, 0);
    if content_length > leftover.len() {
        stream.read_exact(&mut body[leftover.len()..]).map_err(|e| herr("proxy_io", format!("body read failed: {e}")))?;
    }
    Ok(ParsedRequest { method, path, headers, origin, body })
}

fn origin_allowed(origin: &str) -> bool {
    crate::core_env::webview_origins(crate::fsutil::current_os()).iter().any(|o| *o == origin)
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, body: &[u8], content_type: &str, origin: Option<&str>) {
    let cors = origin.map(|o| format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n")).unwrap_or_default();
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\n{cors}Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(body);
}

fn handle(mut stream: TcpStream, agent: &ureq::Agent, hub: &str, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let (head, leftover) = match read_headers(&mut stream) {
        Ok(v) => v,
        Err(e) => { let code = if e.code == "proxy_too_large" { 413 } else { 400 }; respond(&mut stream, code, "Bad Request", b"", "text/plain", None); return; }
    };
    let req = match parse_request(&head, token, &leftover, &mut stream) {
        Ok(v) => v,
        Err(e) => { let code = if e.code == "proxy_not_found" { 404 } else if e.code == "proxy_too_large" { 413 } else { 400 }; respond(&mut stream, code, "Bad Request", b"", "text/plain", None); return; }
    };
    let origin = req.origin.clone();
    if let Some(o) = origin.as_deref() {
        if !origin_allowed(o) { respond(&mut stream, 403, "Forbidden", b"", "text/plain", None); return; }
    }
    if req.method == "OPTIONS" {
        let _ = write!(stream, "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {}\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: authorization, content-type, accept, last-event-id, x-llmide-client\r\nAccess-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", origin.as_deref().unwrap_or(""));
        return;
    }
    let url = format!("{hub}{}", req.path);
    let mut r = agent.request(&req.method, &url);
    for (name, value) in &req.headers {
        if name == "content-type" || name == "accept" || name == "authorization" || name == "last-event-id" || name == "x-llmide-client" || name == "cookie" {
            r = r.set(name, value);
        }
    }
    let result = if req.body.is_empty() { r.call() } else { r.send_bytes(&req.body) };
    match result {
        Ok(resp) => {
            let status = resp.status();
            let content_type = resp.header("content-type").unwrap_or("application/json").to_string();
            let cors = origin.as_deref().map(|o| format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n")).unwrap_or_default();
            let _ = write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\n{cors}Transfer-Encoding: chunked\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
            let mut reader = resp.into_reader();
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if write!(stream, "{n:x}\r\n").is_err() { break; }
                        if stream.write_all(&buf[..n]).is_err() || stream.write_all(b"\r\n").is_err() { break; }
                    }
                    Err(_) => break,
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        }
        Err(ureq::Error::Status(status, resp)) => {
            let content_type = resp.header("content-type").unwrap_or("application/json").to_string();
            let mut body = Vec::new();
            let _ = resp.into_reader().take(64 * 1024).read_to_end(&mut body);
            respond(&mut stream, status, "Error", &body, &content_type, origin.as_deref());
        }
        Err(err) => {
            // R-034 #11: a changed hub certificate is not an outage. The pin verifier recorded the
            // presented fingerprint during the handshake; surface it so the UI can offer a re-probe.
            let text = match &err { ureq::Error::Transport(t) => t.to_string(), other => other.to_string() };
            let got = crate::remote_tls::take_pin_mismatch()
                .or_else(|| crate::remote_tls::mismatch_fingerprint(&text));
            if let Some(got) = got {
                let body = format!(
                    r#"{{"error":{{"code":"HUB_PIN_MISMATCH","message":"The hub's certificate changed. Re-probe it in Settings and trust the new pin.","fingerprint":"{got}"}}}}"#,
                );
                respond(&mut stream, 502, "Bad Gateway", body.as_bytes(), "application/json", origin.as_deref());
            } else {
                respond(&mut stream, 502, "Bad Gateway", b"{\"error\":{\"code\":\"HUB_UNREACHABLE\"}}", "application/json", origin.as_deref());
            }
        }
    }
}

/// Starts the proxy on the first free loopback port in `[3459, 3458, 3457]` (all in the app CSP).
pub fn start(hub_url: &str, pin: &str) -> Result<ProxyHandle, FsError> {
    // A plaintext hub would bypass the pin entirely: the pinned agent serves http:// without TLS.
    let _ = crate::remote_tls::split_hub(hub_url)?;
    let agent = pinned_agent(pin)?;
    start_with_agent(agent, hub_url)
}

pub fn start_with_agent(agent: ureq::Agent, hub_url: &str) -> Result<ProxyHandle, FsError> {
    start_on(agent, hub_url, &[3459, 3458, 3457])
}

fn start_on(agent: ureq::Agent, hub_url: &str, ports: &[u16]) -> Result<ProxyHandle, FsError> {
    let mut token_bytes = [0u8; 32];
    getrandom::fill(&mut token_bytes).map_err(|e| herr("random_failed", format!("cannot generate the proxy token: {e}")))?;
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let mut listener = None;
    for port in ports {
        match TcpListener::bind(("127.0.0.1", *port)) {
            Ok(l) => { let actual = l.local_addr().map(|a| a.port()).unwrap_or(*port); listener = Some((l, actual)); break; }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => return Err(herr("proxy_bind", format!("cannot bind the loopback proxy: {e}"))),
        }
    }
    let (listener, port) = listener.ok_or_else(|| herr("proxy_bind", "no loopback proxy port is free"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let hub = hub_url.trim_end_matches('/').to_string();
    let token_for_thread = token.clone();
    let stop_for_thread = stop.clone();
    let hub_for_thread = hub.clone();
    let agent = Arc::new(agent);
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stop_for_thread.load(Ordering::SeqCst) { break; }
            let Ok(stream) = conn else { continue };
            let agent = agent.clone();
            let hub = hub_for_thread.clone();
            let token = token_for_thread.clone();
            std::thread::spawn(move || handle(stream, &agent, &hub, &token));
        }
    });
    Ok(ProxyHandle { url: format!("http://127.0.0.1:{port}/{token}"), token, hub, stop, port })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener as StdListener;

    fn start_test(agent: ureq::Agent, hub: &str) -> ProxyHandle { start_on(agent, hub, &[0]).unwrap() }

    fn fake_hub() -> (u16, std::thread::JoinHandle<()>) {
        let l = StdListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let body = b"{\"ok\":true}";
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len());
                let _ = s.write_all(body);
            }
        });
        (port, h)
    }

    #[test]
    fn forwards_get_through_the_token_prefix() {
        let (up, h) = fake_hub();
        let p = start_test(ureq::agent(), &format!("http://127.0.0.1:{up}"));
        let body = ureq::get(&format!("{}/health", p.url)).call().unwrap().into_string().unwrap();
        assert_eq!(body, "{\"ok\":true}");
        assert_eq!(ureq::get(&format!("http://127.0.0.1:{}/health", p.port)).call().unwrap_err().into_response().unwrap().status(), 404);
        p.stop();
        h.join().unwrap();
    }

    #[test]
    fn a_body_arriving_with_the_headers_is_forwarded() {
        let l = StdListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 { break; }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
                        let len = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok()).unwrap_or(0);
                        while buf.len() < pos + 4 + len {
                            let m = s.read(&mut chunk).unwrap_or(0);
                            if m == 0 { break; }
                            buf.extend_from_slice(&chunk[..m]);
                        }
                        break;
                    }
                }
                let req = String::from_utf8_lossy(&buf).to_string();
                let body = req.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("").to_string();
                let out = format!("{{\"body\":\"{body}\"}}");
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", out.len(), out);
            }
        });
        let p = start_test(ureq::agent(), &format!("http://127.0.0.1:{port}"));
        let mut s = TcpStream::connect(("127.0.0.1", p.port)).unwrap();
        // Headers AND body in one write: the proxy must not wait for bytes it already read.
        let raw = format!("POST /{}/echo HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\nabc", p.token);
        s.write_all(raw.as_bytes()).unwrap();
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match s.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => { out.extend_from_slice(&buf[..n]); if out.windows(5).any(|w| w == b"\r\n0\r\n\r\n") { break; } }
                Err(_) => break,
            }
        }
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("abc"), "the body bytes were dropped: {text}");
        p.stop();
        h.join().unwrap();
    }

    #[test]
    fn preflight_is_answered_only_for_the_webview_origin() {
        let p = start_test(ureq::agent(), "http://127.0.0.1:1");
        let allowed = crate::core_env::webview_origins(crate::fsutil::current_os())[0];
        let send = |origin: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", p.port)).unwrap();
            let raw = format!("OPTIONS /{}/health HTTP/1.1\r\nHost: x\r\nOrigin: {origin}\r\nAccess-Control-Request-Method: POST\r\n\r\n", p.token);
            s.write_all(raw.as_bytes()).unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        };
        let ok = send(allowed);
        assert!(ok.starts_with("HTTP/1.1 204"), "{ok}");
        assert!(ok.contains(&format!("Access-Control-Allow-Origin: {allowed}")));
        let refused = send("https://evil.example.com");
        assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");
        p.stop();
    }

    #[test]
    fn an_unauthorized_upstream_answer_keeps_the_webview_cors_header() {
        let l = StdListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut b = [0u8; 1024]; let _ = s.read(&mut b);
                let _ = write!(s, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}");
            }
        });
        let p = start_test(ureq::agent(), &format!("http://127.0.0.1:{port}"));
        let allowed = crate::core_env::webview_origins(crate::fsutil::current_os())[0];
        let mut s = TcpStream::connect(("127.0.0.1", p.port)).unwrap();
        let raw = format!("GET /{}/health HTTP/1.1\r\nHost: x\r\nOrigin: {allowed}\r\n\r\n", p.token);
        s.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new(); let _ = s.read_to_string(&mut out);
        assert!(out.starts_with("HTTP/1.1 401"), "{out}");
        assert!(out.contains(&format!("Access-Control-Allow-Origin: {allowed}")), "{out}");
        p.stop(); h.join().unwrap();
    }

    #[test]
    fn parse_rejects_a_bad_token_and_oversize_body() {
        let l = StdListener::bind(("127.0.0.1", 0)).unwrap();
        let mut s = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (mut peer, _) = l.accept().unwrap();
        let req = b"POST /wrong/health HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(parse_request(req, "tok", b"", &mut peer).unwrap_err().code, "proxy_not_found");
        let req = format!("POST /tok/health HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
        assert_eq!(parse_request(req.as_bytes(), "tok", b"", &mut peer).unwrap_err().code, "proxy_too_large");
        let _ = s.write_all(b"");
    }

    #[test]
    fn a_plain_http_hub_is_refused_before_a_proxy_exists() {
        assert_eq!(start("http://hub.example.com", "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap_err().code, "invalid_hub");
    }

    #[test]
    fn the_display_url_has_no_token() {
        let p = start_test(ureq::agent(), "http://127.0.0.1:1");
        assert!(!p.display_url().contains(&p.token));
        p.stop();
    }
}
