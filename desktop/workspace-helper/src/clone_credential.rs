//! Redeems a clone grant for the saved provider token. The desktop passes only the grant; the token comes from the
//! server core over loopback, and only this helper holds it. The core's port and nonce come from the 0600 state
//! file the server start script writes under the server user's home.
//!
//! The client is std-only HTTP/1.1: one request, one answer, `Connection: close`, a 5 s bound and a 64 KiB cap.
//! Every failure is a fixed `RedeemError` variant, so no answer text or grant can reach a message.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::{Duration, Instant};

use llmide_workspace_core::project::clone::Token;
use serde::Deserialize;

/// Where the server start script keeps the core's port and nonce, relative to the server user's home.
pub const STATE_FILE_REL: &str = ".llmide-server/state.json";
/// The core's redeem route. It is never listed in `/health` and carries no JWT.
pub const REDEEM_PATH: &str = "/internal/clone-credential";
/// The header that carries the core nonce.
pub const NONCE_HEADER: &str = "x-llmide-core-nonce";
/// The longest answer the client reads. A token is a few hundred bytes, so this only bounds a bad core.
pub const ANSWER_CAP_BYTES: usize = 64 * 1024;
/// The bound on connecting, on each read and on the whole exchange.
pub const IO_TIMEOUT: Duration = Duration::from_secs(5);
/// The longest state file the helper reads. The real file is a few hundred bytes.
const STATE_CAP_BYTES: u64 = 64 * 1024;
/// The longest nonce accepted. A hex nonce from the core is 64 characters.
const NONCE_MAX_CHARS: usize = 256;

/// Why a redeem did not yield a token. None of the variants carries text from the state file or the answer.
#[derive(Debug, PartialEq, Eq)]
pub enum RedeemError {
    /// The state file is missing, not a plain file, too large, not JSON, or lacks a usable port or nonce.
    State,
    /// The state file is not owned by the helper's user, or group or other can read it.
    Unsafe,
    /// The core could not be reached on loopback.
    Unreachable,
    /// The core did not finish answering within the bound.
    Timeout,
    /// The answer grew past `ANSWER_CAP_BYTES`.
    Oversize,
    /// The core answered something other than 200.
    Refused,
    /// A 200 whose body is not `{"token": "..."}` with a usable token.
    BadAnswer,
}

/// The core's port and nonce, read from the state file.
#[derive(Debug, PartialEq, Eq)]
pub struct CoreState {
    pub port: u16,
    pub nonce: String,
}

#[derive(Deserialize)]
struct StateFile {
    port: u16,
    nonce: String,
}

#[derive(Deserialize)]
struct Answer {
    token: Token,
}

/// The helper's own effective user. The state file must belong to it.
fn effective_uid() -> u32 {
    // SAFETY: geteuid reads no memory and cannot fail.
    unsafe { libc::geteuid() }
}

/// Reads the core's port and nonce from the state file at `path`. `expected_uid` is the helper's own user.
/// A symlink is refused: the owner and mode checks must apply to the file the helper actually reads.
pub fn read_state(path: &Path, expected_uid: u32) -> Result<CoreState, RedeemError> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| RedeemError::State)?;
    if !meta.file_type().is_file() {
        return Err(RedeemError::State);
    }
    check_state_owner(meta.uid(), meta.mode(), expected_uid)?;
    let file = std::fs::File::open(path).map_err(|_| RedeemError::State)?;
    let mut text = String::new();
    file.take(STATE_CAP_BYTES + 1).read_to_string(&mut text).map_err(|_| RedeemError::State)?;
    if text.len() as u64 > STATE_CAP_BYTES {
        return Err(RedeemError::State);
    }
    parse_state(&text)
}

/// Checks the owner and permission bits of a state file: the helper's user must own it, and no group or other bits
/// may be set. Pure, so the refusal can be tested without a file owned by someone else.
pub fn check_state_owner(file_uid: u32, mode: u32, expected_uid: u32) -> Result<(), RedeemError> {
    if file_uid != expected_uid || mode & 0o077 != 0 {
        return Err(RedeemError::Unsafe);
    }
    Ok(())
}

/// Parses the state file's JSON. Extra fields are ignored; the nonce must be non-empty hex, and the port non-zero.
pub fn parse_state(text: &str) -> Result<CoreState, RedeemError> {
    let file: StateFile = serde_json::from_str(text).map_err(|_| RedeemError::State)?;
    let nonce_ok = !file.nonce.is_empty() && file.nonce.len() <= NONCE_MAX_CHARS && file.nonce.chars().all(|c| c.is_ascii_hexdigit());
    if file.port == 0 || !nonce_ok {
        return Err(RedeemError::State);
    }
    Ok(CoreState { port: file.port, nonce: file.nonce })
}

/// Redeems `grant` with the core named by the state file at `state_path`: reads the state, then calls the core.
pub fn redeem(state_path: &Path, grant: &Token) -> Result<Token, RedeemError> {
    let state = read_state(state_path, effective_uid())?;
    let addr = SocketAddr::from(([127, 0, 0, 1], state.port));
    redeem_at(addr, &state.nonce, grant, IO_TIMEOUT)
}

/// Sends one redeem request to `addr` with `nonce` and reads the answer. `timeout` bounds the whole exchange.
pub fn redeem_at(addr: SocketAddr, nonce: &str, grant: &Token, timeout: Duration) -> Result<Token, RedeemError> {
    // The grant goes only into the request body; the core is the one that checks it.
    let body = serde_json::json!({ "grant": grant.expose() }).to_string();
    let request = format!(
        "POST {REDEEM_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{NONCE_HEADER}: {nonce}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|_| RedeemError::Unreachable)?;
    stream.set_write_timeout(Some(timeout)).map_err(|_| RedeemError::Unreachable)?;
    stream.write_all(request.as_bytes()).map_err(|e| io_failure(&e))?;
    let raw = read_answer(&mut stream, deadline)?;
    parse_answer(&raw)
}

/// Maps a socket error to the variant the caller acts on: a timed-out socket is a timeout, anything else unreachable.
fn io_failure(error: &std::io::Error) -> RedeemError {
    match error.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => RedeemError::Timeout,
        _ => RedeemError::Unreachable,
    }
}

/// The index just past the blank line that ends the headers, if the headers have all arrived.
fn header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// True once a `Content-Length` body is complete, so the client need not wait for the core to close the socket.
fn body_complete(raw: &[u8]) -> bool {
    let Some(end) = header_end(raw) else { return false };
    let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
    let length = head.lines().find_map(|line| line.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok());
    length.is_some_and(|n| raw.len() - end >= n)
}

/// Reads the answer to the end, or until a complete `Content-Length` body has arrived. Each read is bounded by what
/// is left of `deadline`, and the answer is capped at `ANSWER_CAP_BYTES`.
fn read_answer(stream: &mut TcpStream, deadline: Instant) -> Result<Vec<u8>, RedeemError> {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(RedeemError::Timeout);
        }
        stream.set_read_timeout(Some(left)).map_err(|_| RedeemError::Unreachable)?;
        match stream.read(&mut chunk) {
            Ok(0) => return Ok(raw),
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > ANSWER_CAP_BYTES {
                    return Err(RedeemError::Oversize);
                }
                if body_complete(&raw) {
                    return Ok(raw);
                }
            }
            Err(e) => return Err(io_failure(&e)),
        }
    }
}

/// Reads the 200 status and the token from a complete raw answer.
pub fn parse_answer(raw: &[u8]) -> Result<Token, RedeemError> {
    let end = header_end(raw).ok_or(RedeemError::BadAnswer)?;
    let status_line = raw.split(|b| *b == b'\r').next().unwrap_or_default();
    let status = String::from_utf8_lossy(status_line);
    let is_ok = status.split_whitespace().nth(1) == Some("200");
    if !is_ok {
        return Err(RedeemError::Refused);
    }
    let answer: Answer = serde_json::from_slice(&raw[end..]).map_err(|_| RedeemError::BadAnswer)?;
    if !answer.token.is_usable() {
        return Err(RedeemError::BadAnswer);
    }
    Ok(answer.token)
}

/// A one-shot loopback server for the tests of this module and of the session. It answers the first connection with
/// `response` and hands back the request it read, so a test can check the header and the body.
#[cfg(test)]
pub mod test_server {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::thread::JoinHandle;

    pub fn serve_once(response: Vec<u8>) -> (SocketAddr, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            conn.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut seen = Vec::new();
            let mut chunk = [0u8; 1024];
            // Read the headers, then the body the Content-Length names, so the request is seen whole.
            loop {
                let n = conn.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                seen.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&seen).into_owned();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if seen.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let _ = conn.write_all(&response);
            let _ = conn.flush();
            String::from_utf8_lossy(&seen).into_owned()
        });
        (addr, handle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "00ff11ee22dd33cc44bb55aa66998877aabbccddeeff00112233445566778899";

    fn state_json(port: &str, nonce: &str) -> String {
        format!(r#"{{"running":true,"port":{port},"pid":4242,"nonce":"{nonce}","version":"1.2.3"}}"#)
    }

    #[test]
    fn the_state_file_gives_the_port_and_nonce_and_extra_fields_are_ignored() {
        let state = parse_state(&state_json("3456", NONCE)).unwrap();
        assert_eq!(state, CoreState { port: 3456, nonce: NONCE.into() });
    }

    #[test]
    fn a_state_file_without_a_usable_port_or_nonce_is_refused() {
        assert_eq!(parse_state("not json"), Err(RedeemError::State));
        assert_eq!(parse_state(r#"{"nonce":"ab"}"#), Err(RedeemError::State), "no port");
        assert_eq!(parse_state(&state_json("0", NONCE)), Err(RedeemError::State), "port zero");
        assert_eq!(parse_state(&state_json("70000", NONCE)), Err(RedeemError::State), "port out of range");
        assert_eq!(parse_state(&state_json("3456", "")), Err(RedeemError::State), "empty nonce");
        assert_eq!(parse_state(&state_json("3456", "zz")), Err(RedeemError::State), "nonce not hex");
        let long = "a".repeat(NONCE_MAX_CHARS + 1);
        assert_eq!(parse_state(&state_json("3456", &long)), Err(RedeemError::State), "nonce too long");
    }

    #[test]
    fn a_nonce_with_a_line_break_cannot_reach_a_header() {
        assert_eq!(parse_state(&state_json("3456", "ab\\r\\nx-evil: 1")), Err(RedeemError::State));
    }

    #[test]
    fn the_state_file_must_belong_to_the_helper_user_and_be_private() {
        assert_eq!(check_state_owner(501, 0o600, 501), Ok(()));
        assert_eq!(check_state_owner(0, 0o600, 501), Err(RedeemError::Unsafe), "another owner");
        assert_eq!(check_state_owner(501, 0o640, 501), Err(RedeemError::Unsafe), "group can read");
        assert_eq!(check_state_owner(501, 0o604, 501), Err(RedeemError::Unsafe), "others can read");
        assert_eq!(check_state_owner(501, 0o700, 501), Ok(()), "owner-only bits are fine");
    }

    #[test]
    fn read_state_refuses_a_missing_file_a_symlink_and_a_public_file() {
        let dir = std::env::temp_dir().join(format!("llmide-redeem-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let uid = unsafe { libc::geteuid() };
        assert_eq!(read_state(&dir.join("missing.json"), uid), Err(RedeemError::State));
        let public = dir.join("public.json");
        std::fs::write(&public, state_json("3456", NONCE)).unwrap();
        std::fs::set_permissions(&public, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
        assert_eq!(read_state(&public, uid), Err(RedeemError::Unsafe));
        let private = dir.join("state.json");
        std::fs::write(&private, state_json("3456", NONCE)).unwrap();
        std::fs::set_permissions(&private, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        assert_eq!(read_state(&private, uid).unwrap(), CoreState { port: 3456, nonce: NONCE.into() });
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&private, &link).unwrap();
        assert_eq!(read_state(&link, uid), Err(RedeemError::State), "a symlink is not the state file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn grant() -> Token {
        Token::from("grant_abc123")
    }

    #[test]
    fn a_200_answer_yields_the_token() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 19\r\n\r\n{\"token\":\"ghp_T1\"}";
        assert_eq!(parse_answer(raw).unwrap().expose(), "ghp_T1");
    }

    #[test]
    fn other_statuses_and_bad_bodies_are_refused_without_detail() {
        let forbidden = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(parse_answer(forbidden).unwrap_err(), RedeemError::Refused);
        let no_token = b"HTTP/1.1 200 OK\r\n\r\n{\"nope\":1}";
        assert_eq!(parse_answer(no_token).unwrap_err(), RedeemError::BadAnswer);
        let blank = b"HTTP/1.1 200 OK\r\n\r\n{\"token\":\"  \"}";
        assert_eq!(parse_answer(blank).unwrap_err(), RedeemError::BadAnswer, "a blank token is not usable");
        assert_eq!(parse_answer(b"garbage").unwrap_err(), RedeemError::BadAnswer);
    }

    #[test]
    fn the_client_sends_the_nonce_header_and_the_grant_then_reads_the_token() {
        let body = r#"{"token":"ghp_OK"}"#;
        let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes();
        let (addr, seen) = test_server::serve_once(response);
        let token = redeem_at(addr, NONCE, &grant(), IO_TIMEOUT).unwrap();
        assert_eq!(token.expose(), "ghp_OK");
        let request = seen.join().unwrap();
        assert!(request.starts_with("POST /internal/clone-credential HTTP/1.1\r\n"), "{request}");
        assert!(request.contains(&format!("\r\nx-llmide-core-nonce: {NONCE}\r\n")), "{request}");
        assert!(request.ends_with(r#"{"grant":"grant_abc123"}"#), "{request}");
    }

    #[test]
    fn a_refused_redeem_is_refused() {
        let (addr, seen) = test_server::serve_once(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 40\r\n\r\n{\"error\":\"clone_credential_refused\"}".to_vec());
        assert_eq!(redeem_at(addr, NONCE, &grant(), IO_TIMEOUT).unwrap_err(), RedeemError::Refused);
        seen.join().unwrap();
    }

    #[test]
    fn a_core_that_never_answers_times_out() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hold = std::thread::spawn(move || {
            let (_conn, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(1500));
        });
        let started = std::time::Instant::now();
        let result = redeem_at(addr, NONCE, &grant(), Duration::from_millis(300));
        assert_eq!(result.unwrap_err(), RedeemError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(1), "the bound holds");
        hold.join().unwrap();
    }

    #[test]
    fn an_answer_over_the_cap_is_refused() {
        let body = "x".repeat(ANSWER_CAP_BYTES + 10);
        let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes();
        let (addr, seen) = test_server::serve_once(response);
        assert_eq!(redeem_at(addr, NONCE, &grant(), IO_TIMEOUT).unwrap_err(), RedeemError::Oversize);
        seen.join().unwrap();
    }

    #[test]
    fn nothing_listens_means_unreachable() {
        let port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            probe.local_addr().unwrap().port()
        };
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        assert_eq!(redeem_at(addr, NONCE, &grant(), IO_TIMEOUT).unwrap_err(), RedeemError::Unreachable);
    }
}
