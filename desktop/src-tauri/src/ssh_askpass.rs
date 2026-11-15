//! One-time askpass grant for password logins through the system `ssh`.
//!
//! OpenSSH reads a password from an askpass program when `SSH_ASKPASS` is set and
//! `SSH_ASKPASS_REQUIRE=force`. The desktop executable is that program: the host opens a loopback
//! listener that holds the secret for one use, and ssh starts this same exe as the helper, which
//! connects, presents a one-time token and prints the answer to stdout.
//!
//! The secret never appears in an argv, an environment variable, a file or a log. The environment
//! handed to ssh carries only the helper path, the loopback address and the one-time token.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const ENV_ADDR: &str = "LLMIDE_ASKPASS_ADDR";
const ENV_TOKEN: &str = "LLMIDE_ASKPASS_TOKEN";

/// How long the listener waits for the helper before it gives up.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(60);

/// Pause between accept polls; bounds how long a dropped grant takes to stop its thread.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// A helper that stalls mid-handshake must not hold the thread (and so a `drop`) for long.
const CLIENT_IO_TIMEOUT: Duration = Duration::from_secs(2);

/// Upper bound for the token line; a 64-hex token plus newline is 65 bytes.
const MAX_TOKEN_LINE: usize = 256;

/// Upper bound for the secret the helper will accept; a larger answer is treated as a failure.
const MAX_SECRET: usize = 4096;

/// A running one-time grant. Dropping it stops the listener and wipes the secret.
pub struct AskpassGrant {
    addr: String,
    token: String,
    helper: PathBuf,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

/// Written by hand so a `{:?}` in a log or a panic message can never print the one-time token. The address
/// and helper path carry nothing secret, so they stay visible for debugging.
impl std::fmt::Debug for AskpassGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AskpassGrant")
            .field("addr", &self.addr)
            .field("helper", &self.helper)
            .field("token", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl AskpassGrant {
    /// Environment for the ssh child: the askpass helper, the forced-askpass switch, and the
    /// one-time address and token. Carries no secret.
    pub fn env(&self) -> Vec<(String, String)> {
        vec![
            ("SSH_ASKPASS".to_string(), self.helper.to_string_lossy().into_owned()),
            ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
            (ENV_ADDR.to_string(), self.addr.clone()),
            (ENV_TOKEN.to_string(), self.token.clone()),
        ]
    }
}

impl Drop for AskpassGrant {
    fn drop(&mut self) {
        // Joining makes "dropped" mean "listener closed", so a connect right after drop is refused.
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Starts a one-time grant that answers `secret` to the first client presenting the token.
///
/// Preconditions: none; `secret` may be empty (the helper then prints nothing useful).
/// Postconditions: the listener is bound to `127.0.0.1` on an ephemeral port. It closes after one
/// successful answer, after 60 s without one, or when the grant is dropped.
pub fn grant(secret: &str) -> std::io::Result<AskpassGrant> {
    let token = crate::core_host::random_nonce().map_err(std::io::Error::other)?;
    let helper = std::env::current_exe()?;
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    // Nonblocking so the worker can notice `stop` and the deadline between polls.
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?.to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let worker_token = token.clone();
    let worker_secret = secret.as_bytes().to_vec();
    let worker = std::thread::spawn(move || {
        serve(listener, &worker_token, worker_secret, &worker_stop);
    });
    Ok(AskpassGrant { addr, token, helper, stop, worker: Some(worker) })
}

/// Accepts clients until one presents the right token, the grant is stopped, or time runs out.
///
/// The secret is owned here and wiped on every exit path, so it outlives the grant only in memory
/// that this thread has already zeroed.
fn serve(listener: TcpListener, token: &str, mut secret: Vec<u8>, stop: &AtomicBool) {
    let deadline = Instant::now() + ACCEPT_TIMEOUT;
    while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
        match listener.accept() {
            Ok((stream, _)) => {
                if answer_if_authorised(stream, token, &secret) {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(POLL_INTERVAL),
            Err(_) => break,
        }
    }
    wipe(&mut secret);
}

/// Handles one client. Returns `true` once the secret has been released (the grant is then spent).
///
/// A wrong or malformed token closes the connection without a byte of secret and returns `false`,
/// so the real helper can still arrive. Comparison is constant-time to keep the token unguessable
/// by timing.
fn answer_if_authorised(mut stream: TcpStream, token: &str, secret: &[u8]) -> bool {
    // Accepted sockets inherit the listener's nonblocking flag on macOS; the handshake needs blocking reads.
    if stream.set_nonblocking(false).is_err() {
        return false;
    }
    let _ = stream.set_read_timeout(Some(CLIENT_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CLIENT_IO_TIMEOUT));
    let Some(presented) = read_token_line(&mut stream) else {
        return false;
    };
    if !crate::core_host::ct_eq(&presented, token) {
        return false;
    }
    // Once the token matched, the grant is spent even if the write fails: a retry must not get a second answer.
    let _ = stream.write_all(secret);
    let _ = stream.shutdown(Shutdown::Write);
    true
}

/// Reads up to the first newline, bounded by `MAX_TOKEN_LINE`. `None` on EOF, error or overlong input.
fn read_token_line(stream: &mut TcpStream) -> Option<String> {
    let mut line = Vec::with_capacity(72);
    let mut byte = [0u8; 1];
    loop {
        if stream.read(&mut byte).ok()? == 0 {
            return None;
        }
        if byte[0] == b'\n' {
            break;
        }
        if line.len() >= MAX_TOKEN_LINE {
            return None;
        }
        line.push(byte[0]);
    }
    String::from_utf8(line).ok()
}

/// Overwrites a secret buffer with zeros. `black_box` keeps the compiler from dropping the stores.
fn wipe(buf: &mut [u8]) {
    buf.fill(0);
    std::hint::black_box(buf);
}

/// Helper entry point. Call first thing in `run()`; when the askpass variables are set this
/// process is the ssh helper, so it answers and returns `true` and the caller must exit.
///
/// Returns `false` for an ordinary app start. Ignores argv, which ssh uses for the prompt text.
/// Any askpass variable counts as a helper request: a half-set environment must fail closed
/// (print nothing) rather than start the whole app as a password prompt.
pub fn run_helper_if_requested() -> bool {
    let addr = std::env::var(ENV_ADDR).ok();
    let token = std::env::var(ENV_TOKEN).ok();
    if addr.is_none() && token.is_none() {
        return false;
    }
    if let (Some(addr), Some(token)) = (addr, token) {
        if let Some(mut secret) = request_secret(&addr, &token) {
            let mut out = std::io::stdout();
            let _ = out.write_all(&secret);
            let _ = out.write_all(b"\n");
            let _ = out.flush();
            wipe(&mut secret);
        }
    }
    true
}

/// Client side: presents the token and returns the secret, or `None` on any failure.
///
/// Refuses non-loopback addresses so the token can never be sent off-machine.
fn request_secret(addr: &str, token: &str) -> Option<Vec<u8>> {
    let socket: SocketAddr = addr.parse().ok()?;
    if !socket.ip().is_loopback() {
        return None;
    }
    let mut stream = TcpStream::connect_timeout(&socket, CLIENT_IO_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(CLIENT_IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(CLIENT_IO_TIMEOUT)).ok()?;
    stream.write_all(format!("{token}\n").as_bytes()).ok()?;
    let mut out = Vec::new();
    // Bounded read: the host closes after the secret, so EOF ends a well-formed answer.
    let read = stream.take(MAX_SECRET as u64 + 1).read_to_end(&mut out);
    if read.is_err() || out.is_empty() || out.len() > MAX_SECRET {
        wipe(&mut out);
        return None;
    }
    Some(out)
}

/// Test-only client that behaves like the helper's network side.
#[cfg(test)]
fn fetch_secret(addr: &str, token: &str) -> Vec<u8> {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream.write_all(format!("{token}\n").as_bytes()).unwrap();
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr_and_token(grant: &AskpassGrant) -> (String, String) {
        let env = grant.env();
        let find = |name: &str| env.iter().find(|(k, _)| k == name).unwrap().1.clone();
        (find(ENV_ADDR), find(ENV_TOKEN))
    }

    #[test]
    fn serves_once() {
        let g = grant("hunter2").unwrap();
        let (addr, token) = addr_and_token(&g);
        assert_eq!(fetch_secret(&addr, &token), b"hunter2");
        // Second use: the listener is gone, or the connection yields no secret.
        match TcpStream::connect(&addr) {
            Err(_) => {}
            Ok(mut s) => {
                let _ = s.write_all(format!("{token}\n").as_bytes());
                let mut out = Vec::new();
                let _ = s.read_to_end(&mut out);
                assert!(!String::from_utf8_lossy(&out).contains("hunter2"));
            }
        }
    }

    #[test]
    fn wrong_token_gets_nothing() {
        let g = grant("hunter2").unwrap();
        let (addr, token) = addr_and_token(&g);
        let wrong = "0".repeat(token.len());
        assert!(fetch_secret(&addr, &wrong).is_empty());
        assert_eq!(fetch_secret(&addr, &token), b"hunter2");
    }

    #[test]
    fn env_has_no_secret() {
        let g = grant("hunter2").unwrap();
        for (name, value) in g.env() {
            assert!(!value.contains("hunter2"), "{name} carries the secret");
        }
        let names: Vec<String> = g.env().into_iter().map(|(k, _)| k).collect();
        assert_eq!(
            names,
            ["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", ENV_ADDR, ENV_TOKEN]
        );
    }

    #[test]
    fn drop_closes() {
        let g = grant("hunter2").unwrap();
        let (addr, token) = addr_and_token(&g);
        drop(g);
        // The port may be reused by a concurrent test's grant, so a connection can still succeed. What must
        // hold is that this grant no longer answers: it never returns its own secret.
        if let Ok(mut stream) = TcpStream::connect(&addr) {
            let _ = stream.write_all(format!("{token}\n").as_bytes());
            let mut out = Vec::new();
            let _ = stream.read_to_end(&mut out);
            assert!(!String::from_utf8_lossy(&out).contains("hunter2"), "a dropped grant still released its secret");
        }
    }

    #[test]
    fn debug_never_prints_the_token() {
        let g = grant("hunter2").unwrap();
        let (_, token) = addr_and_token(&g);
        let shown = format!("{g:?}");
        assert!(!shown.contains(&token), "Debug printed the one-time token: {shown}");
        assert!(!shown.contains("hunter2"), "Debug printed the secret: {shown}");
        assert!(shown.contains("redacted"));
    }
}
