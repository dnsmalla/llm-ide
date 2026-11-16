//! Redeems a clone grant for the saved provider token. The desktop passes only the grant; the token comes from the
//! server core over loopback, and only this helper holds it. The helper reads the core's port from the 0600 state
//! file and the redeem key from its own 0600 key file, both under the server user's home.
//!
//! The redeem key is a secret; the health nonce is not (the core serves it unauthenticated), so it is never used
//! here. The client is std-only HTTP/1.1: one request, one answer, `Connection: close`, a 5 s bound and a 64 KiB cap.
//! Every failure is a fixed `RedeemError` variant, so no answer text, grant or key can reach a message.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use llmide_workspace_core::project::clone::Token;
use serde::Deserialize;

/// Where the server start script keeps the core's port, relative to the server user's home.
pub const STATE_FILE_REL: &str = ".llmide-server/state.json";
/// Where the core keeps the redeem key, relative to the server user's home. One line of 64 hex characters.
pub const KEY_FILE_REL: &str = ".llmide-server/data/clone-redeem.key";
/// The core's redeem route. It is never listed in `/health` and carries no JWT.
pub const REDEEM_PATH: &str = "/internal/clone-credential";
/// The header that carries the redeem key.
pub const REDEEM_KEY_HEADER: &str = "x-llmide-redeem-key";
/// The longest answer the client reads. A token is a few hundred bytes, so this only bounds a bad core.
pub const ANSWER_CAP_BYTES: usize = 64 * 1024;
/// The bound on connecting, on each read and on the whole exchange.
pub const IO_TIMEOUT: Duration = Duration::from_secs(5);
/// The longest state file the helper reads. The real file is a few hundred bytes.
const STATE_CAP_BYTES: u64 = 64 * 1024;
/// The longest key file the helper reads. The key is 64 hex characters plus a line end.
const KEY_CAP_BYTES: u64 = 256;
/// The length of a redeem key: 64 hex characters.
const KEY_HEX_LEN: usize = 64;

/// Why a redeem did not yield a token. None of the variants carries text from the files, the grant, the key or the
/// answer.
#[derive(Debug, PartialEq, Eq)]
pub enum RedeemError {
    /// The state file is missing, not a plain file, too large, not JSON, or lacks a usable port.
    State,
    /// The key file is missing, not a plain file, too large, or not one line of 64 hex characters.
    Key,
    /// A file is not owned by the helper's user, or group or other can read it.
    Unsafe,
    /// The core could not be reached on loopback.
    Unreachable,
    /// The core did not finish answering within the bound.
    Timeout,
    /// The answer grew past `ANSWER_CAP_BYTES`.
    Oversize,
    /// The core answered something other than 200.
    Refused,
    /// A 200 whose body is not `{"token": "..."}` with a usable token, or whose chunked framing is broken.
    BadAnswer,
}

/// The core's port, read from the state file.
#[derive(Debug, PartialEq, Eq)]
pub struct CoreState {
    pub port: u16,
}

/// The two files a redeem reads, under the server user's home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedeemFiles {
    pub state: PathBuf,
    pub key: PathBuf,
}

impl RedeemFiles {
    /// The state and key files under `home`, where the server start script and the core put them.
    pub fn under_home(home: &Path) -> Self {
        Self { state: home.join(STATE_FILE_REL), key: home.join(KEY_FILE_REL) }
    }
}

#[derive(Deserialize)]
struct StateFile {
    port: u16,
}

#[derive(Deserialize)]
struct Answer {
    token: Token,
}

/// The helper's own effective user. The files must belong to it.
fn effective_uid() -> u32 {
    // SAFETY: geteuid reads no memory and cannot fail.
    unsafe { libc::geteuid() }
}

/// Reads a file that must be a plain file owned by `expected_uid`, readable by nobody else, and no longer than `cap`.
/// A symlink is refused: the owner and mode checks must apply to the file the helper actually reads.
fn read_private_file(path: &Path, expected_uid: u32, cap: u64) -> Result<String, RedeemError> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| RedeemError::State)?;
    if !meta.file_type().is_file() {
        return Err(RedeemError::State);
    }
    check_private_file(meta.uid(), meta.mode(), expected_uid)?;
    if meta.len() > cap {
        return Err(RedeemError::State);
    }
    let file = std::fs::File::open(path).map_err(|_| RedeemError::State)?;
    let mut text = String::new();
    file.take(cap + 1).read_to_string(&mut text).map_err(|_| RedeemError::State)?;
    if text.len() as u64 > cap {
        return Err(RedeemError::State);
    }
    Ok(text)
}

/// Reads the core's port from the state file at `path`. `expected_uid` is the helper's own user.
pub fn read_state(path: &Path, expected_uid: u32) -> Result<CoreState, RedeemError> {
    parse_state(&read_private_file(path, expected_uid, STATE_CAP_BYTES)?)
}

/// Reads the redeem key from the key file at `path`. Its text is returned only inside a redacting `Token`.
pub fn read_key(path: &Path, expected_uid: u32) -> Result<Token, RedeemError> {
    let text = read_private_file(path, expected_uid, KEY_CAP_BYTES).map_err(|e| match e {
        RedeemError::State => RedeemError::Key,
        other => other,
    })?;
    parse_key(&text)
}

/// Checks the owner and permission bits of a private file: `expected_uid` must own it, and no group or other bits
/// may be set. Pure, so the refusal can be tested without a file owned by someone else.
pub fn check_private_file(file_uid: u32, mode: u32, expected_uid: u32) -> Result<(), RedeemError> {
    if file_uid != expected_uid || mode & 0o077 != 0 {
        return Err(RedeemError::Unsafe);
    }
    Ok(())
}

/// Parses the state file's JSON. Extra fields are ignored; the port must be non-zero.
pub fn parse_state(text: &str) -> Result<CoreState, RedeemError> {
    let file: StateFile = serde_json::from_str(text).map_err(|_| RedeemError::State)?;
    if file.port == 0 {
        return Err(RedeemError::State);
    }
    Ok(CoreState { port: file.port })
}

/// Parses the key file's text: one line, trimmed, exactly 64 hex characters.
fn parse_key(text: &str) -> Result<Token, RedeemError> {
    let key = text.trim();
    if key.len() != KEY_HEX_LEN || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(RedeemError::Key);
    }
    Ok(Token::from(key))
}

/// Redeems `grant` with the core: reads the key and the port from `files`, then calls the core on loopback.
pub fn redeem(files: &RedeemFiles, grant: &Token) -> Result<Token, RedeemError> {
    let uid = effective_uid();
    let key = read_key(&files.key, uid)?;
    let state = read_state(&files.state, uid)?;
    let addr = SocketAddr::from(([127, 0, 0, 1], state.port));
    redeem_at(addr, &key, grant, IO_TIMEOUT)
}

/// Sends one redeem request to `addr`, authenticated by `key`, and reads the answer. `timeout` bounds the whole
/// exchange.
pub fn redeem_at(addr: SocketAddr, key: &Token, grant: &Token, timeout: Duration) -> Result<Token, RedeemError> {
    // The grant and the key go only into the request; the core is the one that checks them. The key is hex-checked
    // when it is read, so it cannot break the header line.
    let body = serde_json::json!({ "grant": grant.expose() }).to_string();
    let request = format!(
        "POST {REDEEM_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{REDEEM_KEY_HEADER}: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
        key.expose()
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

/// The lowercased header block of a raw answer, up to the blank line.
fn head_lower(raw: &[u8], end: usize) -> String {
    String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase()
}

/// True when the headers say the body is `Transfer-Encoding: chunked`.
fn is_chunked(head: &str) -> bool {
    head.lines().any(|line| line.strip_prefix("transfer-encoding:").is_some_and(|v| v.trim() == "chunked"))
}

/// Where a chunked body stands: all of it decoded, still arriving, or not chunked framing at all.
#[derive(Debug, PartialEq, Eq)]
enum Chunks {
    Complete(Vec<u8>),
    Incomplete,
    Malformed,
}

/// Decodes a chunked body. The last chunk is `0`; any trailers after it are ignored.
fn decode_chunks(body: &[u8]) -> Chunks {
    let mut out = Vec::new();
    let mut pos = 0;
    loop {
        let Some(line_len) = body[pos..].windows(2).position(|w| w == b"\r\n") else { return Chunks::Incomplete };
        let Ok(size_line) = std::str::from_utf8(&body[pos..pos + line_len]) else { return Chunks::Malformed };
        // A chunk extension (`;name=value`) after the size is allowed and ignored.
        let size_hex = size_line.split(';').next().unwrap_or_default().trim();
        let Ok(size) = u64::from_str_radix(size_hex, 16) else { return Chunks::Malformed };
        pos += line_len + 2;
        if size == 0 {
            return Chunks::Complete(out);
        }
        let remaining = (body.len() - pos) as u64;
        // The data and its closing CRLF must both be here before the chunk is complete.
        if size + 2 > remaining {
            return Chunks::Incomplete;
        }
        let size = size as usize;
        if &body[pos + size..pos + size + 2] != b"\r\n" {
            return Chunks::Malformed;
        }
        out.extend_from_slice(&body[pos..pos + size]);
        pos += size + 2;
    }
}

/// True once the answer's body is complete, so the client need not wait for the core to close the socket. A
/// `Content-Length` body is complete at that length; a chunked body at its last chunk, or at a framing error, which
/// then fails in `parse_answer`.
fn body_complete(raw: &[u8]) -> bool {
    let Some(end) = header_end(raw) else { return false };
    let head = head_lower(raw, end);
    if is_chunked(&head) {
        return decode_chunks(&raw[end..]) != Chunks::Incomplete;
    }
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
    let head = head_lower(raw, end);
    let body = if is_chunked(&head) {
        match decode_chunks(&raw[end..]) {
            Chunks::Complete(body) => body,
            Chunks::Incomplete | Chunks::Malformed => return Err(RedeemError::BadAnswer),
        }
    } else {
        raw[end..].to_vec()
    };
    let answer: Answer = serde_json::from_slice(&body).map_err(|_| RedeemError::BadAnswer)?;
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

    /// A 64-hex key, the shape the core writes to the key file. Its text must never show in any output.
    const KEY_HEX: &str = "9a8b7c6d5e4f30291a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081";

    fn key() -> Token {
        Token::from(KEY_HEX)
    }

    fn grant() -> Token {
        Token::from("grant_abc123")
    }

    fn state_json(port: &str) -> String {
        format!(r#"{{"running":true,"port":{port},"pid":4242,"nonce":"unused-by-the-helper","version":"1.2.3"}}"#)
    }

    /// A private scratch folder for the file tests, named by the test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("llmide-redeem-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_private(path: &Path, text: &str, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn the_state_file_gives_the_port_and_extra_fields_are_ignored() {
        assert_eq!(parse_state(&state_json("3456")).unwrap(), CoreState { port: 3456 });
    }

    #[test]
    fn a_state_file_without_a_usable_port_is_refused() {
        assert_eq!(parse_state("not json"), Err(RedeemError::State));
        assert_eq!(parse_state(r#"{"nonce":"ab"}"#), Err(RedeemError::State), "no port");
        assert_eq!(parse_state(&state_json("0")), Err(RedeemError::State), "port zero");
        assert_eq!(parse_state(&state_json("70000")), Err(RedeemError::State), "port out of range");
    }

    #[test]
    fn the_files_must_belong_to_the_helper_user_and_be_private() {
        assert_eq!(check_private_file(501, 0o600, 501), Ok(()));
        assert_eq!(check_private_file(0, 0o600, 501), Err(RedeemError::Unsafe), "another owner");
        assert_eq!(check_private_file(501, 0o640, 501), Err(RedeemError::Unsafe), "group can read");
        assert_eq!(check_private_file(501, 0o604, 501), Err(RedeemError::Unsafe), "others can read");
        assert_eq!(check_private_file(501, 0o700, 501), Ok(()), "owner-only bits are fine");
    }

    #[test]
    fn read_state_refuses_a_missing_file_a_symlink_and_a_public_file() {
        let dir = scratch("state");
        let uid = effective_uid();
        assert_eq!(read_state(&dir.join("missing.json"), uid), Err(RedeemError::State));
        let public = dir.join("public.json");
        write_private(&public, &state_json("3456"), 0o644);
        assert_eq!(read_state(&public, uid), Err(RedeemError::Unsafe));
        let private = dir.join("state.json");
        write_private(&private, &state_json("3456"), 0o600);
        assert_eq!(read_state(&private, uid).unwrap(), CoreState { port: 3456 });
        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&private, &link).unwrap();
        assert_eq!(read_state(&link, uid), Err(RedeemError::State), "a symlink is not the state file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_key_file_is_one_64_hex_line_read_trimmed() {
        let dir = scratch("key-ok");
        let path = dir.join("clone-redeem.key");
        write_private(&path, &format!("{KEY_HEX}\n"), 0o600);
        let read = read_key(&path, effective_uid()).unwrap();
        assert_eq!(read.expose(), KEY_HEX);
        assert!(!format!("{read:?}{read}").contains(KEY_HEX), "the key never shows in Debug or Display");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_key_file_is_a_key_error() {
        let dir = scratch("key-missing");
        assert_eq!(read_key(&dir.join("clone-redeem.key"), effective_uid()).unwrap_err(), RedeemError::Key);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_key_file_with_wrong_permissions_is_unsafe() {
        let dir = scratch("key-perms");
        let path = dir.join("clone-redeem.key");
        write_private(&path, KEY_HEX, 0o640);
        assert_eq!(read_key(&path, effective_uid()).unwrap_err(), RedeemError::Unsafe, "group can read");
        write_private(&path, KEY_HEX, 0o644);
        assert_eq!(read_key(&path, effective_uid()).unwrap_err(), RedeemError::Unsafe, "others can read");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_key_that_is_not_one_64_hex_line_is_refused() {
        let dir = scratch("key-bad");
        let path = dir.join("clone-redeem.key");
        let uid = effective_uid();
        let refused = |text: String| {
            write_private(&path, &text, 0o600);
            read_key(&path, uid).unwrap_err()
        };
        assert_eq!(refused(KEY_HEX.replacen('9', "z", 1)), RedeemError::Key, "not hex");
        assert_eq!(refused(KEY_HEX[1..].to_string()), RedeemError::Key, "63 characters");
        assert_eq!(refused(format!("{KEY_HEX}{KEY_HEX}")), RedeemError::Key, "128 characters");
        assert_eq!(refused(format!("{KEY_HEX}\n{KEY_HEX}\n")), RedeemError::Key, "two lines");
        assert_eq!(refused("a".repeat(300)), RedeemError::Key, "over 256 bytes");
        assert_eq!(refused(String::new()), RedeemError::Key, "empty");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_symlinked_key_file_is_refused() {
        let dir = scratch("key-link");
        let real = dir.join("real.key");
        write_private(&real, KEY_HEX, 0o600);
        let link = dir.join("clone-redeem.key");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(read_key(&link, effective_uid()).unwrap_err(), RedeemError::Key);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn redeem_without_a_key_file_is_a_key_error_and_sends_nothing() {
        let dir = scratch("redeem-nokey");
        let state = dir.join("state.json");
        write_private(&state, &state_json("9"), 0o600);
        let files = RedeemFiles { state, key: dir.join("clone-redeem.key") };
        assert_eq!(redeem(&files, &grant()).unwrap_err(), RedeemError::Key);
        let _ = std::fs::remove_dir_all(&dir);
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
    fn a_chunked_200_answer_yields_the_token() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n{\"token\"\r\na\r\n:\"ghp_C1\"}\r\n0\r\n\r\n";
        assert_eq!(parse_answer(raw).unwrap().expose(), "ghp_C1");
    }

    #[test]
    fn a_chunked_answer_cut_short_is_a_bad_answer() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n{\"token\"\r\n";
        assert_eq!(parse_answer(raw).unwrap_err(), RedeemError::BadAnswer);
        let bad_size = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nabc\r\n0\r\n\r\n";
        assert_eq!(parse_answer(bad_size).unwrap_err(), RedeemError::BadAnswer);
    }

    #[test]
    fn the_client_sends_the_key_header_and_the_grant_and_never_the_nonce_header() {
        let body = r#"{"token":"ghp_OK"}"#;
        let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes();
        let (addr, seen) = test_server::serve_once(response);
        let token = redeem_at(addr, &key(), &grant(), IO_TIMEOUT).unwrap();
        assert_eq!(token.expose(), "ghp_OK");
        let request = seen.join().unwrap();
        assert!(request.starts_with("POST /internal/clone-credential HTTP/1.1\r\n"), "{request}");
        assert!(request.contains(&format!("\r\nx-llmide-redeem-key: {KEY_HEX}\r\n")), "{request}");
        assert!(!request.to_ascii_lowercase().contains("x-llmide-core-nonce"), "the health nonce is never sent: {request}");
        assert!(request.ends_with(r#"{"grant":"grant_abc123"}"#), "{request}");
    }

    #[test]
    fn a_chunked_answer_is_read_without_waiting_for_the_close() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n{\"token\"\r\na\r\n:\"ghp_C2\"}\r\n0\r\n\r\n".to_vec();
        let (addr, seen) = test_server::serve_once(response);
        assert_eq!(redeem_at(addr, &key(), &grant(), IO_TIMEOUT).unwrap().expose(), "ghp_C2");
        seen.join().unwrap();
    }

    #[test]
    fn a_chunked_answer_over_the_cap_is_refused() {
        let chunk = "x".repeat(ANSWER_CAP_BYTES);
        let response = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{chunk}\r\n0\r\n\r\n", chunk.len()).into_bytes();
        let (addr, seen) = test_server::serve_once(response);
        assert_eq!(redeem_at(addr, &key(), &grant(), IO_TIMEOUT).unwrap_err(), RedeemError::Oversize);
        seen.join().unwrap();
    }

    #[test]
    fn a_refused_redeem_is_refused() {
        let (addr, seen) = test_server::serve_once(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 40\r\n\r\n{\"error\":\"clone_credential_refused\"}".to_vec());
        assert_eq!(redeem_at(addr, &key(), &grant(), IO_TIMEOUT).unwrap_err(), RedeemError::Refused);
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
        let result = redeem_at(addr, &key(), &grant(), Duration::from_millis(300));
        assert_eq!(result.unwrap_err(), RedeemError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(1), "the bound holds");
        hold.join().unwrap();
    }

    #[test]
    fn an_answer_over_the_cap_is_refused() {
        let body = "x".repeat(ANSWER_CAP_BYTES + 10);
        let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes();
        let (addr, seen) = test_server::serve_once(response);
        assert_eq!(redeem_at(addr, &key(), &grant(), IO_TIMEOUT).unwrap_err(), RedeemError::Oversize);
        seen.join().unwrap();
    }

    #[test]
    fn nothing_listens_means_unreachable() {
        let port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            probe.local_addr().unwrap().port()
        };
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        assert_eq!(redeem_at(addr, &key(), &grant(), IO_TIMEOUT).unwrap_err(), RedeemError::Unreachable);
    }
}
