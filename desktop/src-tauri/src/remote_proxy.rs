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
    body: Vec<u8>,
}

fn read_headers(stream: &mut TcpStream) -> Result<Vec<u8>, FsError> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    loop {
        if buf.len() > MAX_HEADERS { return Err(herr("proxy_too_large", "the request headers are too large")); }
        if let Some(pos) = find_headers_end(&buf) { return Ok(buf[..pos + 4].to_vec()); }
        let n = stream.read(&mut chunk).map_err(|e| herr("proxy_io", format!("read failed: {e}")))?;
        if n == 0 { return Err(herr("proxy_io", "the client closed before the headers ended")); }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn find_headers_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_request(head: &[u8], token: &str, stream: &mut TcpStream) -> Result<ParsedRequest, FsError> {
    let text = std::str::from_utf8(head).map_err(|_| herr("proxy_bad", "the request headers are not UTF-8"))?;
    let mut lines = text.split("\r\n");
    let first = lines.next().ok_or_else(|| herr("proxy_bad", "the request line is missing"))?;
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let raw_path = parts.next().unwrap_or("").to_string();
    let version = parts.next().unwrap_or("");
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") || version != "HTTP/1.1" {
        return Err(herr("proxy_bad", "unsupported request line"));
    }
    let prefix = format!("/{token}/");
    let Some(rest) = raw_path.strip_prefix(&prefix) else {
        return Err(herr("proxy_not_found", "unknown proxy path"));
    };
    if rest.is_empty() { return Err(herr("proxy_not_found", "unknown proxy path")); }
    let path = format!("/{rest}");
    let mut headers = Vec::new();
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
        if matches!(name.as_str(), "host" | "connection" | "transfer-encoding" | "content-length" | "proxy-connection" | "upgrade") { continue; }
        if matches!(name.as_str(), "authorization" | "content-type" | "accept" | "last-event-id" | "x-llmide-client" | "cookie") {
            headers.push((name, value.to_string()));
        }
    }
    if chunked { return Err(herr("proxy_bad", "chunked request bodies are not accepted")); }
    if content_length > MAX_BODY { return Err(herr("proxy_too_large", "the request body is too large")); }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        stream.read_exact(&mut body).map_err(|e| herr("proxy_io", format!("body read failed: {e}")))?;
    }
    Ok(ParsedRequest { method, path, headers, body })
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, body: &[u8], content_type: &str) {
    let _ = write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(body);
}

fn handle(mut stream: TcpStream, agent: &ureq::Agent, hub: &str, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let head = match read_headers(&mut stream) {
        Ok(v) => v,
        Err(e) => { let code = if e.code == "proxy_too_large" { 413 } else { 400 }; respond(&mut stream, code, "Bad Request", b"", "text/plain"); return; }
    };
    let req = match parse_request(&head, token, &mut stream) {
        Ok(v) => v,
        Err(e) => { let code = if e.code == "proxy_not_found" { 404 } else if e.code == "proxy_too_large" { 413 } else { 400 }; respond(&mut stream, code, "Bad Request", b"", "text/plain"); return; }
    };
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
            let _ = write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
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
            respond(&mut stream, status, "Error", &body, &content_type);
        }
        Err(_) => respond(&mut stream, 502, "Bad Gateway", b"{\"error\":{\"code\":\"HUB_UNREACHABLE\"}}", "application/json"),
    }
}

/// Starts the proxy on the first free loopback port in `[3459, 3458, 3457]` (all in the app CSP).
pub fn start(hub_url: &str, pin: &str) -> Result<ProxyHandle, FsError> {
    let agent = pinned_agent(pin)?;
    start_with_agent(agent, hub_url)
}

pub fn start_with_agent(agent: ureq::Agent, hub_url: &str) -> Result<ProxyHandle, FsError> {
    let mut token_bytes = [0u8; 32];
    getrandom::fill(&mut token_bytes).map_err(|e| herr("random_failed", format!("cannot generate the proxy token: {e}")))?;
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let mut listener = None;
    for port in [3459u16, 3458, 3457] {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => { listener = Some((l, port)); break; }
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
        let p = start_with_agent(ureq::agent(), &format!("http://127.0.0.1:{up}")).unwrap();
        let body = ureq::get(&format!("{}/health", p.url)).call().unwrap().into_string().unwrap();
        assert_eq!(body, "{\"ok\":true}");
        assert_eq!(ureq::get(&format!("http://127.0.0.1:{}/health", p.port)).call().unwrap_err().into_response().unwrap().status(), 404);
        p.stop();
        h.join().unwrap();
    }

    #[test]
    fn parse_rejects_a_bad_token_and_oversize_body() {
        let l = StdListener::bind(("127.0.0.1", 0)).unwrap();
        let mut s = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (mut peer, _) = l.accept().unwrap();
        let req = b"POST /wrong/health HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(parse_request(req, "tok", &mut peer).unwrap_err().code, "proxy_not_found");
        let req = format!("POST /tok/health HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
        assert_eq!(parse_request(req.as_bytes(), "tok", &mut peer).unwrap_err().code, "proxy_too_large");
        let _ = s.write_all(b"");
    }

    #[test]
    fn the_display_url_has_no_token() {
        let p = start_with_agent(ureq::agent(), "http://127.0.0.1:1").unwrap();
        assert!(!p.display_url().contains(&p.token));
        p.stop();
    }
}
