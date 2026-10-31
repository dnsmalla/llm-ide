//! Node core host: adopts a running LLM-IDE server on :3456, or spawns
//! `node extension/server.mjs` on a loopback port (3457..3459) against a DB in the
//! app data dir. The live `kb/data.db` is never touched by this app.
//!
//! Identity: every spawn gets a per-launch random nonce (`LLMIDE_CORE_NONCE`) that the
//! server echoes as `x-llmide-nonce` on /health; a process that answers without it is
//! never treated as our core. An ADOPTED :3456 server cannot be verified (nothing
//! shares a secret with it), so it is reported as `trust: "adopted_unverified"` with a
//! notice, and the host sends it nothing credential-bearing. HTTP probes never follow
//! redirects.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::fsutil;

/// The user's live server. Only probed, never spawned over, never killed.
const LIVE_PORT: u16 = 3456;
/// Ports tried, in order, for the server this app spawns (a busy one is skipped).
const SPAWN_PORTS: [u16; 3] = [3457, 3458, 3459];
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Per-probe timeout on the spawned port (kept short so readiness isn't quantized).
const SPAWN_PROBE_TIMEOUT: Duration = Duration::from_millis(250);
const READY_DEADLINE: Duration = Duration::from_secs(20);
const TERM_GRACE: Duration = Duration::from_secs(3);
const LOG_TAIL_LINES: usize = 200;
const ERROR_TAIL_LINES: usize = 40;
/// The redacted failure log kept in the app data dir.
const LOG_FILE: &str = "core.log";
const LOG_FILE_MAX_BYTES: usize = 64 * 1024;
const ERROR_POINTER: &str = "details are in core.log in the app data folder";

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Starting,
    Ready,
    Failed,
}

#[derive(Serialize, Clone, Debug)]
pub struct CoreStatus {
    pub url: String,
    pub adopted: bool,
    pub pid: Option<u32>,
    pub ms_to_healthy: Option<u64>,
    pub state: Phase,
    pub error: Option<String>,
    /// `pending` | `spawned` (nonce verified) | `adopted_unverified`.
    pub trust: &'static str,
    /// Set for an adopted core: its identity could not be verified.
    pub notice: Option<String>,
}

struct Inner {
    status: Mutex<Status>,
    child: Mutex<Option<Child>>,
    log: Arc<Mutex<VecDeque<String>>>,
    data_dir: Mutex<Option<PathBuf>>,
    /// Literal secret values to scrub from anything written to the failure log.
    literals: Mutex<Vec<String>>,
}

struct Status {
    url: String,
    adopted: bool,
    pid: Option<u32>,
    ms_to_healthy: Option<u64>,
    state: Phase,
    error: Option<String>,
    trust: &'static str,
    notice: Option<String>,
    /// Set by `shutdown`; a spawn that finishes afterwards is killed at once.
    closing: bool,
}

/// Cheap-to-clone handle. The child is killed when the last clone drops
/// (panic unwinding included), and explicitly from `shutdown`.
#[derive(Clone)]
pub struct CoreHost {
    inner: Arc<Inner>,
}

impl Drop for Inner {
    // Runs only when the last clone is dropped. The ctrlc closure and the
    // panic-hook static keep clones alive for the process lifetime, so exit
    // paths must call `shutdown()` explicitly; this is a backstop only.
    fn drop(&mut self) {
        terminate_child(&mut lock(&self.child));
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl CoreHost {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                status: Mutex::new(Status {
                    url: format!("http://127.0.0.1:{LIVE_PORT}"),
                    adopted: false,
                    pid: None,
                    ms_to_healthy: None,
                    state: Phase::Starting,
                    error: None,
                    trust: "pending",
                    notice: None,
                    closing: false,
                }),
                child: Mutex::new(None),
                log: Arc::new(Mutex::new(VecDeque::new())),
                data_dir: Mutex::new(None),
                literals: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn status(&self) -> CoreStatus {
        let s = lock(&self.inner.status);
        CoreStatus {
            url: s.url.clone(),
            adopted: s.adopted,
            pid: s.pid,
            ms_to_healthy: s.ms_to_healthy,
            state: s.state,
            error: s.error.clone(),
            trust: s.trust,
            notice: s.notice.clone(),
        }
    }

    /// Kill the child we spawned (never an adopted server). Idempotent.
    pub fn shutdown(&self) {
        lock(&self.inner.status).closing = true;
        terminate_child(&mut lock(&self.inner.child));
    }

    /// Best-effort kill for the panic hook. Uses `try_lock` so a panic raised
    /// while one of these mutexes is held on this thread cannot deadlock.
    pub fn shutdown_from_panic(&self) {
        if let Ok(mut s) = self.inner.status.try_lock() {
            s.closing = true;
        }
        if let Ok(mut slot) = self.inner.child.try_lock() {
            terminate_child(&mut slot);
        }
    }

    /// Probe, adopt or spawn, and wait for health on a background thread. `data_dir`
    /// is the app data dir (DB, failure log); without it the core is not spawned.
    pub fn start_in_background(&self, data_dir: Option<PathBuf>) {
        *lock(&self.inner.data_dir) = data_dir;
        let host = self.clone();
        thread::spawn(move || host.run_startup());
    }

    fn run_startup(&self) {
        let started = Instant::now();
        let force_spawn = std::env::var("LLMIDE_POC_FORCE_SPAWN").as_deref() == Ok("1");

        if !force_spawn && matches!(probe(LIVE_PORT, PROBE_TIMEOUT), Probe::Healthy { .. }) {
            eprintln!("core: adopting existing server on 127.0.0.1:{LIVE_PORT} (identity unverified)");
            let ms = started.elapsed().as_millis() as u64;
            self.set_ready(
                format!("http://127.0.0.1:{LIVE_PORT}"),
                true,
                ms,
                "adopted_unverified",
                Some(format!(
                    "Using an external core already running on port {LIVE_PORT}. Its identity cannot be \
                     verified; only continue if you started it."
                )),
            );
            return;
        }

        let Some(data_dir) = lock(&self.inner.data_dir).clone() else {
            self.set_failed(spawn_url(SPAWN_PORTS[0]), "no app data directory for the core database".into());
            return;
        };
        let nonce = match random_nonce() {
            Ok(n) => n,
            Err(e) => {
                self.set_failed(spawn_url(SPAWN_PORTS[0]), e);
                return;
            }
        };
        lock(&self.inner.literals).push(nonce.clone());

        let mut last = String::from("no port tried");
        for port in SPAWN_PORTS {
            if port_in_use(port) {
                last = format!("port {port} is in use");
                continue;
            }
            lock(&self.inner.log).clear();
            match self.attempt(port, &nonce, &data_dir, started) {
                Attempt::Done => return,
                Attempt::Retry(why) => last = why,
            }
        }
        self.set_failed(
            spawn_url(SPAWN_PORTS[SPAWN_PORTS.len() - 1]),
            format!("could not start the core: {last}"),
        );
    }

    /// Spawns on `port` and waits for a /health that echoes `nonce`.
    fn attempt(&self, port: u16, nonce: &str, data_dir: &Path, started: Instant) -> Attempt {
        let url = spawn_url(port);
        match self.spawn_server(port, nonce, data_dir) {
            Ok(pid) => lock(&self.inner.status).pid = Some(pid),
            Err(e) => {
                self.set_failed(url, e);
                return Attempt::Done;
            }
        }
        let deadline = started + READY_DEADLINE;
        loop {
            // Child exited early, or was taken by shutdown.
            let exit = {
                let mut guard = lock(&self.inner.child);
                match guard.as_mut() {
                    None => return Attempt::Done,
                    Some(child) => child.try_wait().ok().flatten(),
                }
            };
            if let Some(status) = exit {
                *lock(&self.inner.child) = None;
                let taken_port = lock(&self.inner.log).iter().any(|l| l.contains("EADDRINUSE"));
                if taken_port {
                    return Attempt::Retry(format!("port {port} was taken while starting"));
                }
                let msg = format!("node exited early ({status})");
                self.set_failed(url, self.failure(msg));
                return Attempt::Done;
            }
            if let Probe::Healthy { nonce: got } = probe(port, SPAWN_PROBE_TIMEOUT) {
                if !got.as_deref().is_some_and(|g| ct_eq(g, nonce)) {
                    // Something other than our child answered: never trust it.
                    terminate_child(&mut lock(&self.inner.child));
                    return Attempt::Retry(format!("a different process answered on port {port}"));
                }
                // Only trust the 200 if our child is still alive.
                let still_running = {
                    let mut guard = lock(&self.inner.child);
                    match guard.as_mut() {
                        None => return Attempt::Done,
                        Some(child) => matches!(child.try_wait(), Ok(None)),
                    }
                };
                if !still_running {
                    self.set_failed(url, self.failure("node exited after answering /health".into()));
                    return Attempt::Done;
                }
                let ms = started.elapsed().as_millis() as u64;
                self.set_ready(url, false, ms, "spawned", None);
                return Attempt::Done;
            }
            if Instant::now() >= deadline {
                let msg = format!("no /health on :{port} after {}s", READY_DEADLINE.as_secs());
                self.set_failed(url, self.failure(msg));
                return Attempt::Done;
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn spawn_server(&self, port: u16, nonce: &str, data_dir: &Path) -> Result<u32, String> {
        let rt = resolve_runtime()?;
        eprintln!("core: runtime={} node={} root={} port={port}", rt.mode, rt.node.display(), rt.root.display());
        let node = rt.node.clone();
        let db_dir = fsutil::private_dir(&data_dir.join("core"))?;
        let db_path = db_dir.join("poc.db");
        // Fail closed: no secrets, no sidecar. Values go in the child's env only.
        let secrets = crate::secrets::default_backend()
            .and_then(|b| crate::secrets::load_or_create(b.as_ref()))
            .map_err(|e| e.to_string())?;
        {
            let mut lits = lock(&self.inner.literals);
            lits.push(secrets.jwt_secret.clone());
            lits.push(secrets.vault_key.clone());
        }

        let mut child = Command::new(&node)
            .arg(rt.root.join("extension").join("server.mjs"))
            .current_dir(rt.root.join("extension"))
            .env("LLMIDE_PORT", port.to_string())
            .env("LLMIDE_DB_PATH", &db_path)
            .env("LLMIDE_CORE_NONCE", nonce)
            .env("LLMIDE_JWT_SECRET", &secrets.jwt_secret)
            .env("LLMIDE_VAULT_KEY", &secrets.vault_key)
            .env("LLMIDE_ENGINE_PREWARM", "0")
            .env("LLMIDE_BACKUP_INTERVAL_HOURS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot spawn {}: {e}", node.display()))?;

        if let Some(out) = child.stdout.take() {
            drain(out, Arc::clone(&self.inner.log));
        }
        if let Some(err) = child.stderr.take() {
            drain(err, Arc::clone(&self.inner.log));
        }
        let pid = child.id();

        let mut slot = lock(&self.inner.child);
        if lock(&self.inner.status).closing {
            drop(slot);
            terminate_child(&mut Some(child));
            return Err("app is shutting down".into());
        }
        *slot = Some(child);
        Ok(pid)
    }

    fn set_ready(&self, url: String, adopted: bool, ms: u64, trust: &'static str, notice: Option<String>) {
        {
            let mut s = lock(&self.inner.status);
            s.url = url;
            s.adopted = adopted;
            s.ms_to_healthy = Some(ms);
            s.state = Phase::Ready;
            s.error = None;
            s.trust = trust;
            s.notice = notice;
        }
        println!(
            "BENCH {{\"name\":\"core_ms_to_healthy\",\"value\":{ms},\"unit\":\"ms\",\"adopted\":{adopted}}}"
        );
    }

    fn set_failed(&self, url: String, error: String) {
        eprintln!("core: failed: {error}");
        let mut s = lock(&self.inner.status);
        s.url = url;
        s.state = Phase::Failed;
        s.error = Some(error);
    }

    /// A webview-safe failure message: the raw output tail never goes into
    /// `core_status`; a redacted copy is written to `core.log` in the app data dir.
    fn failure(&self, msg: String) -> String {
        let tail: Vec<String> = {
            let log = lock(&self.inner.log);
            let n = log.len().min(ERROR_TAIL_LINES);
            log.iter().skip(log.len() - n).cloned().collect()
        };
        if tail.is_empty() {
            return msg;
        }
        let literals = lock(&self.inner.literals).clone();
        let body = std::iter::once(msg.clone())
            .chain(tail.iter().map(|l| redact_line(l, &literals)))
            .collect::<Vec<_>>()
            .join("\n");
        let written = lock(&self.inner.data_dir)
            .clone()
            .map(|d| fsutil::write_private_atomic(&d.join(LOG_FILE), body.as_bytes(), LOG_FILE_MAX_BYTES).is_ok())
            .unwrap_or(false);
        if written {
            format!("{msg}; {ERROR_POINTER}")
        } else {
            msg
        }
    }
}

enum Attempt {
    /// Finished (ready, failed with a status set, or shut down).
    Done,
    /// This port did not work out; try the next.
    Retry(String),
}

fn spawn_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// 32 random bytes, hex.
fn random_nonce() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| format!("cannot generate a launch nonce: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Equality without an early exit on the first differing byte.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// True when something accepts connections on `port` (so a spawn there would fail
/// or, worse, be answered by that listener).
fn port_in_use(port: u16) -> bool {
    use std::net::{SocketAddr, TcpStream};
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// Masks secrets in one log line: known literal values, `name=value` / `"name":"value"`
/// pairs whose name looks secret, and long opaque tokens (JWTs, hex and base64 keys).
pub(crate) fn redact_line(line: &str, literals: &[String]) -> String {
    let mut out = line.to_string();
    for lit in literals.iter().filter(|l| l.len() >= 8) {
        out = out.replace(lit.as_str(), "[redacted]");
    }
    out.split_whitespace().map(redact_token).collect::<Vec<_>>().join(" ")
}

fn redact_token(tok: &str) -> String {
    const SECRET_WORDS: [&str; 8] =
        ["secret", "token", "key", "password", "passwd", "authorization", "cookie", "credential"];
    if let Some(i) = tok.find(['=', ':']) {
        let name = tok[..i].to_ascii_lowercase();
        if tok.len() > i + 1 && SECRET_WORDS.iter().any(|w| name.contains(w)) {
            return format!("{}[redacted]", &tok[..=i]);
        }
    }
    let core = tok.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | '{' | '}' | '[' | ']' | '(' | ')' | ';'));
    let opaque = core.len() >= 24
        && core.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '=' | '.'))
        && core.chars().any(|c| c.is_ascii_digit());
    if opaque {
        "[redacted]".to_string()
    } else {
        tok.to_string()
    }
}

/// Keep the pipe drained so the child never blocks on a full buffer.
/// Only the last `LOG_TAIL_LINES` lines are retained.
fn drain<R: Read + Send + 'static>(pipe: R, log: Arc<Mutex<VecDeque<String>>>) {
    thread::spawn(move || {
        for line in BufReader::new(pipe).lines() {
            let Ok(line) = line else { break };
            let mut buf = lock(&log);
            if buf.len() == LOG_TAIL_LINES {
                buf.pop_front();
            }
            buf.push_back(line);
        }
    });
}

/// SIGTERM, wait up to `TERM_GRACE`, then SIGKILL. No-op if no child.
fn terminate_child(slot: &mut Option<Child>) {
    let Some(mut child) = slot.take() else { return };
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    if let Ok(pid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: plain signal delivery to a pid we spawned and still own.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    let deadline = Instant::now() + TERM_GRACE;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

enum Probe {
    Down,
    /// 200 from /health; `nonce` is the `x-llmide-nonce` header, if any.
    Healthy { nonce: Option<String> },
}

/// GET /health on loopback. Redirects are never followed (a 3xx is "down"), so a
/// listener cannot bounce the host to another address.
fn probe(port: u16, timeout: Duration) -> Probe {
    let url = format!("http://127.0.0.1:{port}/health");
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(timeout).build();
    match agent.get(&url).call() {
        Ok(resp) if resp.status() == 200 => Probe::Healthy { nonce: resp.header("x-llmide-nonce").map(str::to_string) },
        _ => Probe::Down,
    }
}

/// `LLMIDE_REPO_ROOT`, else the nearest ancestor of the executable that
/// contains `extension/server.mjs`.
pub(crate) fn repo_root() -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("LLMIDE_REPO_ROOT") {
        let p = PathBuf::from(root);
        return if p.join("extension").join("server.mjs").is_file() {
            Ok(p)
        } else {
            Err(format!("LLMIDE_REPO_ROOT has no extension/server.mjs: {}", p.display()))
        };
    }
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    exe.ancestors()
        .find(|dir: &&Path| dir.join("extension").join("server.mjs").is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| "repo root not found (set LLMIDE_REPO_ROOT)".to_string())
}

/// The Node core to run: the copy bundled in a `.app` (`Resources/core`), or
/// `LLMIDE_POC_BUNDLED=1` forces it, else the repo checkout (dev runs).
pub(crate) struct Runtime {
    pub mode: &'static str,
    pub node: PathBuf,
    pub root: PathBuf,
}

pub(crate) fn resolve_runtime() -> Result<Runtime, String> {
    let forced = std::env::var("LLMIDE_POC_BUNDLED").as_deref() == Ok("1");
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    // Inside an app bundle the bundled core is mandatory: never fall back to
    // repo mode from a shipped .app. Repo mode is for non-bundle dev runs only.
    if forced || in_app_bundle(&exe) {
        if let Some(core) = bundled_core_dir(&exe) {
            return Ok(Runtime {
                mode: "bundled",
                node: core.join("node").join("node"),
                root: core.join("root"),
            });
        }
        if forced {
            return Err(format!("LLMIDE_POC_BUNDLED=1 but no Resources/core next to {}", exe.display()));
        }
        return Err(format!(
            "bundled core missing from Contents/Resources/core (executable: {})",
            exe.display()
        ));
    }
    Ok(Runtime { mode: "repo", node: node_binary(), root: repo_root()? })
}

fn in_app_bundle(exe: &Path) -> bool {
    exe.to_string_lossy().contains(".app/Contents/MacOS/")
}

/// `<App>.app/Contents/Resources/core`, when it holds the node binary and tree.
fn bundled_core_dir(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?.parent()?.join("Resources").join("core");
    let ok = dir.join("root").join("extension").join("server.mjs").is_file()
        && dir.join("node").join("node").is_file();
    ok.then_some(dir)
}

/// `LLMIDE_NODE`, else the first well-known Homebrew/system node, else PATH.
fn node_binary() -> PathBuf {
    if let Ok(n) = std::env::var("LLMIDE_NODE") {
        return PathBuf::from(n);
    }
    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from("node")
}

#[tauri::command]
pub fn core_status(host: tauri::State<'_, CoreHost>) -> CoreStatus {
    host.status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;

    /// One-shot-per-connection fake server; `reply` builds the raw HTTP response.
    fn fake(reply: impl Fn() -> String + Send + 'static) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        thread::spawn(move || {
            for conn in l.incoming() {
                let Ok(mut c) = conn else { break };
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buf = [0u8; 1024];
                let _ = c.read(&mut buf);
                let _ = c.write_all(reply().as_bytes());
            }
        });
        (port, hits)
    }

    fn ok_with(header: &str) -> String {
        format!("HTTP/1.1 200 OK\r\n{header}Content-Length: 2\r\nConnection: close\r\n\r\n{{}}")
    }

    #[test]
    fn probe_reads_the_nonce_header() {
        let (port, _) = fake(|| ok_with("x-llmide-nonce: abc123\r\n"));
        match probe(port, Duration::from_secs(2)) {
            Probe::Healthy { nonce } => assert_eq!(nonce.as_deref(), Some("abc123")),
            Probe::Down => panic!("expected healthy"),
        }
    }

    #[test]
    fn a_plain_health_has_no_nonce() {
        let (port, _) = fake(|| ok_with(""));
        match probe(port, Duration::from_secs(2)) {
            Probe::Healthy { nonce } => assert!(nonce.is_none()),
            Probe::Down => panic!("expected healthy"),
        }
    }

    #[test]
    fn redirects_are_not_followed() {
        let (target, target_hits) = fake(|| ok_with("x-llmide-nonce: abc\r\n"));
        let (port, _) = fake(move || {
            format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target}/health\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        });
        assert!(matches!(probe(port, Duration::from_secs(2)), Probe::Down));
        assert_eq!(target_hits.load(std::sync::atomic::Ordering::SeqCst), 0, "redirect target must not be contacted");
    }

    #[test]
    fn nonce_is_random_hex_and_compared_exactly() {
        let (a, b) = (random_nonce().unwrap(), random_nonce().unwrap());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert!(ct_eq(&a, &a));
        assert!(!ct_eq(&a, &b));
        assert!(!ct_eq(&a, &a[..63]));
    }

    #[test]
    fn port_in_use_sees_a_listener() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(port_in_use(port));
        drop(l);
        assert!(!port_in_use(port));
    }

    #[test]
    fn redaction_masks_literals_pairs_and_opaque_tokens() {
        let secret = "s3cr3t-value-for-jwt".to_string();
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
        let line = format!("boot LLMIDE_JWT_SECRET={secret} Authorization: Bearer {jwt} \"apiKey\":\"sk-abc\" port 3457 ok");
        let out = redact_line(&line, std::slice::from_ref(&secret));
        for leak in [&secret, jwt, "sk-abc"] {
            assert!(!out.contains(leak), "leaked {leak}: {out}");
        }
        assert!(out.contains("port 3457 ok"), "{out}");
    }

    #[test]
    fn failure_message_never_carries_the_raw_tail_and_log_is_private() {
        let host = CoreHost::new();
        let dir = std::env::temp_dir().join(format!("llmide-core-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dir = fsutil::private_dir(&dir).unwrap();
        *lock(&host.inner.data_dir) = Some(dir.clone());
        lock(&host.inner.literals).push("hunter2hunter2".into());
        lock(&host.inner.log).push_back("password leaked hunter2hunter2 in /Users/me/secret-project".into());
        let msg = host.failure("node exited early (1)".into());
        assert!(!msg.contains("hunter2") && !msg.contains("/Users/me"), "{msg}");
        assert!(msg.contains("core.log"));
        let body = std::fs::read_to_string(dir.join("core.log")).unwrap();
        assert!(!body.contains("hunter2"), "{body}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join("core.log")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn status_starts_pending_and_unverified_is_distinct() {
        let host = CoreHost::new();
        assert_eq!(host.status().trust, "pending");
        host.set_ready("http://127.0.0.1:3456".into(), true, 1, "adopted_unverified", Some("n".into()));
        let s = host.status();
        assert!(s.adopted && s.trust == "adopted_unverified" && s.notice.is_some());
    }
}
