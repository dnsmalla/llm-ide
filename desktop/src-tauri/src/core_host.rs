//! Node core host: adopts a running LLM-IDE server on :3456, or spawns
//! `node extension/server.mjs` on :3457 against a temp DB. The live
//! `kb/data.db` is never touched by this app.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// The user's live server. Only probed, never spawned over, never killed.
const LIVE_PORT: u16 = 3456;
/// Port for the server this app spawns.
const SPAWN_PORT: u16 = 3457;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Per-probe timeout on the spawned port (kept short so readiness isn't quantized).
const SPAWN_PROBE_TIMEOUT: Duration = Duration::from_millis(250);
const READY_DEADLINE: Duration = Duration::from_secs(20);
const TERM_GRACE: Duration = Duration::from_secs(3);
const LOG_TAIL_LINES: usize = 200;
const ERROR_TAIL_LINES: usize = 8;

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
}

struct Inner {
    status: Mutex<Status>,
    child: Mutex<Option<Child>>,
    log: Arc<Mutex<VecDeque<String>>>,
}

struct Status {
    url: String,
    adopted: bool,
    pid: Option<u32>,
    ms_to_healthy: Option<u64>,
    state: Phase,
    error: Option<String>,
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
                    closing: false,
                }),
                child: Mutex::new(None),
                log: Arc::new(Mutex::new(VecDeque::new())),
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

    /// Probe, adopt or spawn, and wait for health on a background thread.
    pub fn start_in_background(&self) {
        let host = self.clone();
        thread::spawn(move || host.run_startup());
    }

    fn run_startup(&self) {
        let started = Instant::now();
        let force_spawn = std::env::var("LLMIDE_POC_FORCE_SPAWN").as_deref() == Ok("1");

        if !force_spawn && health_ok(LIVE_PORT, PROBE_TIMEOUT) {
            eprintln!("core: adopting existing server on 127.0.0.1:{LIVE_PORT}");
            let ms = started.elapsed().as_millis() as u64;
            self.set_ready(format!("http://127.0.0.1:{LIVE_PORT}"), true, None, ms);
            return;
        }

        let url = format!("http://127.0.0.1:{SPAWN_PORT}");
        if health_ok(SPAWN_PORT, SPAWN_PROBE_TIMEOUT) {
            self.set_failed(
                url,
                format!("port {SPAWN_PORT} already in use (stale PoC server?)"),
            );
            return;
        }
        match self.spawn_server() {
            Ok(pid) => {
                lock(&self.inner.status).pid = Some(pid);
            }
            Err(e) => {
                self.set_failed(url, e);
                return;
            }
        }

        let deadline = started + READY_DEADLINE;
        loop {
            // Child exited early, or was taken by shutdown.
            let exit = {
                let mut guard = lock(&self.inner.child);
                match guard.as_mut() {
                    None => return,
                    Some(child) => child.try_wait().ok().flatten(),
                }
            };
            if let Some(status) = exit {
                let msg = format!("node exited early ({status})");
                self.set_failed(url, self.with_log_tail(msg));
                return;
            }
            if health_ok(SPAWN_PORT, SPAWN_PROBE_TIMEOUT) {
                // Only trust the 200 if our child is still alive; otherwise a
                // dying child may have raced with some other listener.
                let still_running = {
                    let mut guard = lock(&self.inner.child);
                    match guard.as_mut() {
                        None => return,
                        Some(child) => matches!(child.try_wait(), Ok(None)),
                    }
                };
                if !still_running {
                    self.set_failed(url, self.with_log_tail("node exited after answering /health".into()));
                    return;
                }
                let ms = started.elapsed().as_millis() as u64;
                self.set_ready(url, false, None, ms);
                return;
            }
            if Instant::now() >= deadline {
                let msg = format!(
                    "no /health on :{SPAWN_PORT} after {}s",
                    READY_DEADLINE.as_secs()
                );
                self.set_failed(url, self.with_log_tail(msg));
                return;
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn spawn_server(&self) -> Result<u32, String> {
        let repo = repo_root()?;
        let node = node_binary();
        let db_dir = std::env::temp_dir().join("llmide-poc");
        std::fs::create_dir_all(&db_dir)
            .map_err(|e| format!("cannot create {}: {e}", db_dir.display()))?;
        let db_path = db_dir.join("poc.db");

        let mut child = Command::new(&node)
            .arg(repo.join("extension").join("server.mjs"))
            .current_dir(repo.join("extension"))
            .env("LLMIDE_PORT", SPAWN_PORT.to_string())
            .env("LLMIDE_DB_PATH", &db_path)
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

    fn set_ready(&self, url: String, adopted: bool, pid: Option<u32>, ms: u64) {
        {
            let mut s = lock(&self.inner.status);
            s.url = url;
            s.adopted = adopted;
            s.pid = pid.or(s.pid);
            s.ms_to_healthy = Some(ms);
            s.state = Phase::Ready;
            s.error = None;
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

    fn with_log_tail(&self, msg: String) -> String {
        let log = lock(&self.inner.log);
        let tail: Vec<&str> = log
            .iter()
            .rev()
            .take(ERROR_TAIL_LINES)
            .map(String::as_str)
            .collect();
        if tail.is_empty() {
            msg
        } else {
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            format!("{msg}; last output: {}", tail.join(" | "))
        }
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

fn health_ok(port: u16, timeout: Duration) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    match ureq::get(&url).timeout(timeout).call() {
        Ok(resp) => resp.status() == 200,
        Err(_) => false,
    }
}

/// `LLMIDE_REPO_ROOT`, else the nearest ancestor of the executable that
/// contains `extension/server.mjs`.
fn repo_root() -> Result<PathBuf, String> {
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
