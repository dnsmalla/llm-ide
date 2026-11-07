//! Node core host: adopts a running LLM-IDE server on :3456 (only when adopting is on), or spawns
//! `node extension/server.mjs` on a loopback port (3456 first, then 3457..3459) against a DB in the
//! desktop data dir (`llm-ide-desktop`, see `fsutil::data_dir_for`). The live
//! `kb/data.db` and the Mac app's `llm-ide/system` are never touched by this app.
//!
//! Lifecycle (production): start on launch; a supervisor thread watches the child
//! (exit and `/health` with the nonce) and restarts a crashed or hung core with bounded
//! exponential backoff (`RestartPolicy`: N crashes inside M minutes is a fatal state,
//! never a restart loop); quit stops the whole process tree (`proc_tree`), SIGTERM then
//! SIGKILL on unix, a Job Object on Windows, so no Node or `claude` child survives.
//! `core_status` reports `restarting` while a restart is pending (additive fields).
//!
//! Identity: every spawn gets a per-launch random nonce (`LLMIDE_CORE_NONCE`) that the
//! server echoes as `x-llmide-nonce` on /health; a process that answers without it is
//! never treated as our core. An ADOPTED :3456 server cannot be verified (nothing
//! shares a secret with it), so it is reported as `trust: "adopted_unverified"` with a
//! notice, and the host sends it nothing credential-bearing. HTTP probes never follow
//! redirects. An adopted server is never supervised, restarted or killed.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::foreign_core::{self, ForeignCore};
use crate::fsutil;
use crate::proc_tree::ManagedChild;

/// The port the Chrome extension talks to. Probed first: a server already there is adopted (when
/// adopting is on) or reported as foreign; never spawned over, never killed. When it is free, this app
/// spawns its own core there (decision D2), else on 3457..3459.
const LIVE_PORT: u16 = 3456;
/// Ports tried, in order, for the server this app spawns (a busy one is skipped). `:3456` first, so the
/// Chrome extension reaches the desktop core.
const SPAWN_PORTS: [u16; 4] = [3456, 3457, 3458, 3459];
/// Fixed env of the core THIS app spawns (never read from the host env). `LLMIDE_LIVE_ACK=1`: a finalized extension
/// capture is held until the desktop archivist (capture_archivist.rs) acks the verified note; without it the extension
/// keeps every draft in `no-ack` and an ack releases nothing. An adopted server keeps its own env.
const SPAWNED_CORE_FLAGS: [(&str, &str); 3] = [
    ("LLMIDE_ENGINE_PREWARM", "0"),
    ("LLMIDE_BACKUP_INTERVAL_HOURS", "0"),
    ("LLMIDE_LIVE_ACK", "1"),
];
/// On a supervised restart, how long the port our just-exited core held may stay busy before it is skipped.
const RESTART_PORT_WAIT: Duration = Duration::from_secs(3);
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
/// Marker line the claude probe prints (the module logger may write other lines).
const CLAUDE_PROBE_MARKER: &str = "LLMIDE_CLAUDE_PROBE ";
const CLAUDE_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const CLAUDE_FALLBACK_NOTICE: &str = "Claude Code was not found on this computer. Install Claude Code \
(https://claude.com/claude-code) and run `claude login`, then try again.";

/// Everything the supervisor's timing and policy depends on; tests shrink it.
#[derive(Clone, Debug)]
pub struct Tuning {
    pub ports: Vec<u16>,
    /// Adopt a healthy server already on `live_port` instead of spawning. Off in release builds
    /// unless `LLMIDE_ADOPT_CORE=1`: an adopted core is unverifiable and the release CSP does not
    /// allow it, so by default a foreign :3456 server is only reported, never used.
    pub adopt: bool,
    /// The live-server port that is probed (3456; tests point it at a fake).
    pub live_port: u16,
    pub ready_deadline: Duration,
    pub term_grace: Duration,
    pub health_interval: Duration,
    pub health_timeout: Duration,
    /// Consecutive failed health probes after which a running core counts as hung.
    pub health_fails: u32,
    pub max_crashes: usize,
    pub crash_window: Duration,
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
    /// While `claude` is missing, look again this often (the user may install it).
    pub claude_recheck: Duration,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            ports: SPAWN_PORTS.to_vec(),
            adopt: default_adopt(
                cfg!(debug_assertions),
                std::env::var("LLMIDE_ADOPT_CORE").ok().as_deref(),
                std::env::var("LLMIDE_POC_FORCE_SPAWN").ok().as_deref(),
            ),
            live_port: LIVE_PORT,
            ready_deadline: READY_DEADLINE,
            term_grace: TERM_GRACE,
            health_interval: Duration::from_secs(5),
            health_timeout: Duration::from_secs(2),
            health_fails: 3,
            max_crashes: 5,
            crash_window: Duration::from_secs(5 * 60),
            backoff_base: Duration::from_secs(1),
            backoff_cap: Duration::from_secs(30),
            claude_recheck: Duration::from_secs(30),
        }
    }
}

/// Adopt policy. Release: only with `LLMIDE_ADOPT_CORE=1`. Debug: the dev default (adopt unless
/// `LLMIDE_POC_FORCE_SPAWN=1`), and `LLMIDE_ADOPT_CORE=1` always wins.
pub(crate) fn default_adopt(debug: bool, adopt_env: Option<&str>, force_spawn: Option<&str>) -> bool {
    if adopt_env == Some("1") {
        return true;
    }
    debug && adopt_env != Some("0") && force_spawn != Some("1")
}

/// What a restart should do after a crash.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Restart(Duration),
    /// Too many crashes inside the window: stop restarting, show a fatal state.
    Fatal,
}

/// Bounded restart policy: `max` crashes within `window` is fatal; otherwise the delay
/// doubles with each crash still inside the window, capped. Old crashes age out, so a
/// core that ran fine for a while gets a fresh budget.
pub struct RestartPolicy {
    max: usize,
    window: Duration,
    base: Duration,
    cap: Duration,
    crashes: VecDeque<Instant>,
}

impl RestartPolicy {
    pub fn new(t: &Tuning) -> Self {
        Self { max: t.max_crashes, window: t.crash_window, base: t.backoff_base, cap: t.backoff_cap, crashes: VecDeque::new() }
    }

    pub fn record_crash(&mut self, now: Instant) -> Decision {
        self.crashes.push_back(now);
        while self.crashes.front().is_some_and(|t| now.duration_since(*t) > self.window) {
            self.crashes.pop_front();
        }
        if self.crashes.len() >= self.max {
            return Decision::Fatal;
        }
        let shift = (self.crashes.len() as u32 - 1).min(16);
        Decision::Restart(self.base.saturating_mul(1u32 << shift).min(self.cap))
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Starting,
    Ready,
    /// The core stopped unexpectedly and a bounded restart is pending or running.
    Restarting,
    Failed,
    /// Stopped by the user from Settings; Start resumes it.
    Stopped,
}

/// What the claude probe found (state: `unknown` before the first probe, then `found`/`missing`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeInfo {
    pub state: &'static str,
    pub source: Option<String>,
    pub notice: Option<String>,
}

impl ClaudeInfo {
    fn unknown() -> Self {
        Self { state: "unknown", source: None, notice: None }
    }
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
    /// Additive (T6): restarts performed since launch.
    pub restarts: u32,
    /// Additive: while `state` is `restarting`, milliseconds until the next start attempt.
    pub restart_in_ms: Option<u64>,
    /// Additive: true when the core crashed too often and will not be restarted.
    pub fatal: bool,
    /// Additive: `unknown` | `found` | `missing` (the user's Claude Code CLI).
    pub claude: &'static str,
    /// Additive: how it was found (`env` | `bundled` | `installed`); never a path.
    pub claude_source: Option<String>,
    /// Additive: user-facing install hint when `claude` is `missing`.
    pub claude_notice: Option<String>,
    /// Additive: absolute path of the redacted failure log (`core.log`). The PATH only, never its
    /// contents; the file exists only after a core failure has been recorded.
    pub core_log_path: Option<String>,
    /// Additive: a server this app did not start holds the live port (:3456). It is never used or
    /// stopped. `null` when none was seen.
    pub foreign_core: Option<ForeignCore>,
    /// Additive: machine-readable failure reason (`ports_busy`); `null` otherwise.
    pub error_code: Option<&'static str>,
    /// Additive: the spawn ports this app tried (set with `ports_busy`).
    pub ports_tried: Vec<u16>,
    /// Additive: the spawned core holds :3456, the only port the Chrome extension talks to.
    #[serde(rename = "extensionReachable")]
    pub extension_reachable: bool,
}

/// What one spawn needs; produced by a [`Launcher`].
pub struct Launch {
    pub cmd: Command,
    /// Literal secret values to scrub from the failure log.
    pub secrets: Vec<String>,
}

pub struct LaunchCtx<'a> {
    pub port: u16,
    pub nonce: &'a str,
    pub data_dir: &'a Path,
}

pub type Launcher = Arc<dyn for<'a> Fn(&LaunchCtx<'a>) -> Result<Launch, String> + Send + Sync>;
pub type ClaudeProbe = Arc<dyn Fn(&Path) -> ClaudeInfo + Send + Sync>;

struct Inner {
    status: Mutex<Status>,
    child: Mutex<Option<ManagedChild>>,
    /// The supervisor thread, so a user Stop can join it before a later Start.
    startup: Mutex<Option<std::thread::JoinHandle<()>>>,
    log: Arc<Mutex<VecDeque<String>>>,
    data_dir: Mutex<Option<PathBuf>>,
    /// Literal secret values to scrub from anything written to the failure log.
    literals: Mutex<Vec<String>>,
    tuning: Tuning,
    launcher: Launcher,
    claude_probe: ClaudeProbe,
    claude_in_flight: AtomicBool,
}

struct Status {
    url: String,
    adopted: bool,
    pid: Option<u32>,
    ms_to_healthy: Option<u64>,
    state: Phase,
    error: Option<String>,
    trust: &'static str,
    /// The launch nonce of the child this app spawned (only while `trust == "spawned"`).
    nonce: Option<String>,
    notice: Option<String>,
    restarts: u32,
    restart_at: Option<Instant>,
    fatal: bool,
    claude: ClaudeInfo,
    foreign: Option<ForeignCore>,
    error_code: Option<&'static str>,
    ports_tried: Vec<u16>,
    /// Set by `shutdown`; a spawn that finishes afterwards is killed at once.
    closing: bool,
}

/// Cheap-to-clone handle. The child tree is killed when the last clone drops
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
        terminate_child(&mut lock(&self.child), self.tuning.term_grace);
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl CoreHost {
    pub fn new() -> Self {
        Self::with(Tuning::default(), Arc::new(real_launch), Arc::new(real_claude_probe))
    }

    /// Custom tuning, launcher and claude probe (tests inject a fake server).
    pub fn with(tuning: Tuning, launcher: Launcher, claude_probe: ClaudeProbe) -> Self {
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
                    nonce: None,
                    notice: None,
                    restarts: 0,
                    restart_at: None,
                    fatal: false,
                    claude: ClaudeInfo::unknown(),
                    foreign: None,
                    error_code: None,
                    ports_tried: Vec::new(),
                    closing: false,
                }),
                child: Mutex::new(None),
                startup: Mutex::new(None),
                log: Arc::new(Mutex::new(VecDeque::new())),
                data_dir: Mutex::new(None),
                literals: Mutex::new(Vec::new()),
                tuning,
                launcher,
                claude_probe,
                claude_in_flight: AtomicBool::new(false),
            }),
        }
    }

    /// The URL of the core this app SPAWNED and verified, right now: `Some` only while the phase is
    /// `Ready`, the trust is `spawned` (never an adopted or still-pending core), and `/health` still
    /// echoes this launch's nonce. Callers that hand a credential to the core re-ask at every use, so a
    /// restart on another port (or a squatter) is never sent a stale URL's token.
    pub fn verified_url(&self) -> Option<String> {
        let (url, nonce) = {
            let s = lock(&self.inner.status);
            if s.state != Phase::Ready || s.trust != "spawned" {
                return None;
            }
            (s.url.clone(), s.nonce.clone()?)
        };
        let port = url_port(&url)?;
        match probe(port, Duration::from_millis(800)) {
            Probe::Healthy { nonce: Some(got) } if ct_eq(&got, &nonce) => Some(url),
            _ => None,
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
            restarts: s.restarts,
            restart_in_ms: s.restart_at.map(|t| t.saturating_duration_since(Instant::now()).as_millis() as u64),
            fatal: s.fatal,
            claude: s.claude.state,
            claude_source: s.claude.source.clone(),
            claude_notice: s.claude.notice.clone(),
            core_log_path: lock(&self.inner.data_dir).as_ref().map(|d| d.join(LOG_FILE).to_string_lossy().into_owned()),
            foreign_core: s.foreign.clone(),
            error_code: s.error_code,
            ports_tried: s.ports_tried.clone(),
            extension_reachable: s.state == Phase::Ready
                && !s.adopted
                && url_port(&s.url) == Some(self.inner.tuning.live_port),
        }
    }

    fn is_closing(&self) -> bool {
        lock(&self.inner.status).closing
    }

    /// Stop the child tree we spawned (never an adopted server). Idempotent, blocks up
    /// to the term grace. A pending restart is cancelled.
    pub fn shutdown(&self) {
        lock(&self.inner.status).closing = true;
        // Take the child out first so the supervisor is never blocked behind the grace wait.
        let child = lock(&self.inner.child).take();
        if let Some(c) = child {
            c.terminate(self.inner.tuning.term_grace);
        }
    }

    /// Best-effort kill for the panic hook. Uses `try_lock` so a panic raised
    /// while one of these mutexes is held on this thread cannot deadlock.
    pub fn shutdown_from_panic(&self) {
        if let Ok(mut s) = self.inner.status.try_lock() {
            s.closing = true;
        }
        let mut killed = false;
        if let Ok(mut slot) = self.inner.child.try_lock() {
            killed = slot.is_some();
            terminate_child(&mut slot, self.inner.tuning.term_grace);
        }
        if killed {
            // The core is gone: core_status must not keep reporting it ready.
            if let Ok(mut s) = self.inner.status.try_lock() {
                s.state = Phase::Failed;
                s.pid = None;
                s.error = Some("the core was stopped after an app error".into());
                s.error_code = None;
            }
        }
    }

    /// Probe, adopt or spawn, and wait for health on a background thread. `data_dir`
    /// is the desktop data dir (DB, failure log); without it the core is not spawned.
    pub fn start_in_background(&self, data_dir: Option<PathBuf>) {
        *lock(&self.inner.data_dir) = data_dir;
        let host = self.clone();
        let handle = thread::spawn(move || host.run_startup());
        *lock(&self.inner.startup) = Some(handle);
    }

    /// Initial state when "Start backend on app launch" is off: nothing was spawned, but Start can.
    pub fn mark_stopped(&self, data_dir: Option<PathBuf>) {
        *lock(&self.inner.data_dir) = data_dir;
        let mut s = lock(&self.inner.status);
        s.closing = true;
        s.state = Phase::Stopped;
        s.trust = "spawned";
        s.pid = None;
        s.nonce = None;
        s.error = None;
        s.fatal = false;
        s.restart_at = None;
    }

    /// Stop the core the user sees (never an adopted server). Blocks until the supervisor has ended so a following
    /// Start cannot race it. The app keeps running; Settings offers Start.
    pub fn stop(&self) -> Result<(), String> {
        self.shutdown();
        if let Some(handle) = lock(&self.inner.startup).take() {
            let _ = handle.join();
        }
        let mut s = lock(&self.inner.status);
        // A stopped own core is still the app's core: reporting "unverified" would show a false trust warning.
        // An adopted external server keeps its (unverified) identity.
        if !s.adopted {
            s.trust = "spawned";
        }
        s.state = Phase::Stopped;
        s.pid = None;
        s.nonce = None;
        s.error = None;
        s.fatal = false;
        s.restart_at = None;
        s.error_code = None;
        Ok(())
    }

    /// Start the core again after a user Stop (or a failed start). Idempotent while starting/running.
    pub fn start(&self) -> Result<(), String> {
        let data = lock(&self.inner.data_dir).clone().ok_or_else(|| "the app data folder is not available".to_string())?;
        {
            let s = lock(&self.inner.status);
            if matches!(s.state, Phase::Starting | Phase::Ready | Phase::Restarting) {
                return Ok(());
            }
        }
        if let Some(handle) = lock(&self.inner.startup).take() {
            let _ = handle.join();
        }
        {
            let mut s = lock(&self.inner.status);
            s.closing = false;
            s.state = Phase::Starting;
            s.error = None;
            s.error_code = None;
            s.fatal = false;
            s.pid = None;
            s.nonce = None;
            s.restart_at = None;
            s.trust = "pending";
        }
        self.start_in_background(Some(data));
        Ok(())
    }

    /// Kill & Restart from Settings: a clean Stop followed by a Start.
    pub fn restart(&self) -> Result<(), String> {
        self.stop()?;
        self.start()
    }

    fn run_startup(&self) {
        let started = Instant::now();
        let t = &self.inner.tuning;

        let live_healthy = matches!(probe(t.live_port, PROBE_TIMEOUT), Probe::Healthy { .. });
        if t.adopt && live_healthy {
            eprintln!("core: adopting existing server on 127.0.0.1:{} (identity unverified)", t.live_port);
            let ms = started.elapsed().as_millis() as u64;
            self.set_ready(
                format!("http://127.0.0.1:{}", t.live_port),
                true,
                ms,
                "adopted_unverified",
                Some(format!(
                    "Using an external core already running on port {}. Its identity cannot be \
                     verified; only continue if you started it.",
                    t.live_port
                )),
            );
            self.refresh_claude();
            return;
        }
        if live_healthy {
            // Not ours (we have no nonce for it) and not adopted: report it, start our own core.
            eprintln!("core: ignoring a foreign server on 127.0.0.1:{} (not adopted)", t.live_port);
            self.note_foreign(t.live_port);
        }

        let Some(data_dir) = lock(&self.inner.data_dir).clone() else {
            self.set_failed(spawn_url(t.ports[0]), "no app data directory for the core database".into());
            return;
        };

        let mut policy = RestartPolicy::new(t);
        let mut first = true;
        // The port our last core held: a restart waits briefly for it rather than moving off :3456.
        let mut held: Option<u16> = None;
        loop {
            let began = if first { started } else { Instant::now() };
            match self.start_once(&data_dir, began, held) {
                Started::Closed => return,
                // A first start that fails is reported as-is (no retry: a broken install or
                // missing secret would only fail again). After a crash, a failed restart
                // counts as another crash and goes through the same bounded policy.
                Started::Failed if first => return,
                Started::Failed => {}
                Started::Ready { port, nonce } => {
                    held = Some(port);
                    self.refresh_claude();
                    match self.supervise(port, &nonce) {
                        Ended::Closing => return,
                        Ended::Crashed(why) => {
                            let msg = self.failure(format!("core stopped unexpectedly ({why})"));
                            eprintln!("core: {msg}");
                        }
                    }
                }
            }
            first = false;
            if self.is_closing() {
                return;
            }
            match policy.record_crash(Instant::now()) {
                Decision::Fatal => {
                    let mut s = lock(&self.inner.status);
                    s.state = Phase::Failed;
                    s.fatal = true;
                    s.pid = None;
                    s.restart_at = None;
                    s.error = Some(format!(
                        "The core stopped {} times in {} minutes and was not restarted; {ERROR_POINTER}",
                        t.max_crashes,
                        (t.crash_window.as_secs() / 60).max(1)
                    ));
                    eprintln!("core: fatal: {}", s.error.as_deref().unwrap_or(""));
                    return;
                }
                Decision::Restart(delay) => {
                    {
                        let mut s = lock(&self.inner.status);
                        s.state = Phase::Restarting;
                        s.pid = None;
                        s.restart_at = Some(Instant::now() + delay);
                        s.error = Some("The core stopped unexpectedly and is restarting".into());
                    }
                    eprintln!("core: restarting in {} ms", delay.as_millis());
                    if !self.sleep_unless_closing(delay) {
                        return;
                    }
                }
            }
        }
    }

    /// Polls `port` until nothing listens on it, at most `max`; true when it became free.
    fn wait_port_free(&self, port: u16, max: Duration) -> bool {
        let end = Instant::now() + max;
        while Instant::now() < end {
            if !self.sleep_unless_closing(Duration::from_millis(100)) {
                return false;
            }
            if !port_in_use(port) {
                return true;
            }
        }
        false
    }

    /// Sleeps `d` in slices; false if the app began closing meanwhile.
    fn sleep_unless_closing(&self, d: Duration) -> bool {
        let end = Instant::now() + d;
        while Instant::now() < end {
            if self.is_closing() {
                return false;
            }
            thread::sleep(Duration::from_millis(25).min(end.saturating_duration_since(Instant::now())));
        }
        !self.is_closing()
    }

    /// One start: a fresh nonce, then the first free port that answers with it. `held` is set on a supervised
    /// restart: the port the core that just exited held, waited for (bounded) when it is still busy.
    fn start_once(&self, data_dir: &Path, started: Instant, held: Option<u16>) -> Started {
        let is_restart = held.is_some();
        let t = &self.inner.tuning;
        let nonce = match random_nonce() {
            Ok(n) => n,
            Err(e) => {
                self.set_failed(spawn_url(t.ports[0]), e);
                return Started::Failed;
            }
        };
        lock(&self.inner.literals).push(nonce.clone());
        let prefs_now = crate::prefs::launch();
        let ports = if prefs_now.backend_source && prefs_now.backend_port > 0 {
            vec![prefs_now.backend_port]
        } else {
            t.ports.clone()
        };
        let mut last = String::from("no port tried");
        let mut busy = 0usize;
        for &port in &ports {
            if self.is_closing() {
                return Started::Closed;
            }
            if port_in_use(port) && !(held == Some(port) && self.wait_port_free(port, RESTART_PORT_WAIT)) {
                last = format!("port {port} is in use");
                busy += 1;
                continue;
            }
            lock(&self.inner.log).clear();
            match self.attempt(port, &nonce, data_dir, started, is_restart) {
                Attempt::Ready => return Started::Ready { port, nonce },
                Attempt::Closed => return Started::Closed,
                Attempt::Failed => return Started::Failed,
                Attempt::Retry(why) => last = why,
            }
        }
        if self.is_closing() {
            return Started::Closed;
        }
        let all_busy = busy == ports.len();
        self.set_failed(spawn_url(*ports.last().unwrap_or(&t.ports[0])), format!("could not start the core: {last}"));
        if all_busy {
            let first = ports.first().copied().unwrap_or(0);
            let last_port = ports.last().copied().unwrap_or(0);
            let mut s = lock(&self.inner.status);
            s.error_code = Some("ports_busy");
            s.ports_tried = ports.clone();
            s.error = Some(format!("Ports {first}-{last_port} are busy: free one of them or restart"));
        }
        Started::Failed
    }

    /// Records a foreign server on the live port, then fills in pid/command best-effort off-thread.
    fn note_foreign(&self, port: u16) {
        lock(&self.inner.status).foreign = Some(ForeignCore::detected(port));
        let host = self.clone();
        thread::spawn(move || {
            if let Some((pid, cmd)) = foreign_core::lookup_owner(port) {
                let mut s = lock(&host.inner.status);
                if let Some(f) = s.foreign.take() {
                    s.foreign = Some(f.with_owner(pid, cmd));
                }
            }
        });
    }

    /// Spawns on `port` and waits for a /health that echoes `nonce`.
    fn attempt(&self, port: u16, nonce: &str, data_dir: &Path, started: Instant, is_restart: bool) -> Attempt {
        let url = spawn_url(port);
        match self.spawn_server(port, nonce, data_dir) {
            Ok(pid) => lock(&self.inner.status).pid = Some(pid),
            Err(e) => {
                if self.is_closing() {
                    return Attempt::Closed;
                }
                self.set_failed(url, e);
                return Attempt::Failed;
            }
        }
        let deadline = started + self.inner.tuning.ready_deadline;
        loop {
            // Child exited early, or was taken by shutdown.
            let exit = {
                let mut guard = lock(&self.inner.child);
                match guard.as_mut() {
                    None => return Attempt::Closed,
                    Some(child) => child.try_wait().ok().flatten(),
                }
            };
            if let Some(status) = exit {
                self.reap_exited();
                let taken_port = lock(&self.inner.log).iter().any(|l| l.contains("EADDRINUSE"));
                if taken_port {
                    return Attempt::Retry(format!("port {port} was taken while starting"));
                }
                let msg = format!("node exited early ({status})");
                self.set_failed(url, self.failure(msg));
                return Attempt::Failed;
            }
            if let Probe::Healthy { nonce: got } = probe(port, SPAWN_PROBE_TIMEOUT) {
                if !got.as_deref().is_some_and(|g| ct_eq(g, nonce)) {
                    // Something other than our child answered: never trust it.
                    self.kill_child();
                    return Attempt::Retry(format!("a different process answered on port {port}"));
                }
                // Only trust the 200 if our child is still alive.
                let still_running = {
                    let mut guard = lock(&self.inner.child);
                    match guard.as_mut() {
                        None => return Attempt::Closed,
                        Some(child) => matches!(child.try_wait(), Ok(None)),
                    }
                };
                if !still_running {
                    self.reap_exited();
                    self.set_failed(url, self.failure("node exited after answering /health".into()));
                    return Attempt::Failed;
                }
                let ms = started.elapsed().as_millis() as u64;
                self.set_ready(url, false, ms, "spawned", None);
                lock(&self.inner.status).nonce = Some(nonce.to_string());
                if is_restart {
                    lock(&self.inner.status).restarts += 1;
                }
                return Attempt::Ready;
            }
            if Instant::now() >= deadline {
                let msg = format!("no /health on :{port} after {}s", self.inner.tuning.ready_deadline.as_secs());
                self.kill_child();
                self.set_failed(url, self.failure(msg));
                return Attempt::Failed;
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    /// Watches the running core: child exit and `/health` carrying our nonce.
    fn supervise(&self, port: u16, nonce: &str) -> Ended {
        let t = &self.inner.tuning;
        let mut last_health = Instant::now();
        let mut last_claude = Instant::now();
        let mut fails = 0u32;
        loop {
            thread::sleep(Duration::from_millis(50));
            if self.is_closing() {
                return Ended::Closing;
            }
            let exit = {
                let mut guard = lock(&self.inner.child);
                match guard.as_mut() {
                    None => return Ended::Closing,
                    Some(c) => c.try_wait().ok().flatten(),
                }
            };
            if let Some(status) = exit {
                self.reap_exited();
                return if self.is_closing() { Ended::Closing } else { Ended::Crashed(format!("exited with {status}")) };
            }
            if last_health.elapsed() >= t.health_interval {
                last_health = Instant::now();
                match probe(port, t.health_timeout) {
                    Probe::Healthy { nonce: got } if got.as_deref().is_some_and(|g| ct_eq(g, nonce)) => fails = 0,
                    _ => fails += 1,
                }
                if fails >= t.health_fails {
                    self.kill_child();
                    return if self.is_closing() { Ended::Closing } else { Ended::Crashed("health check failed".into()) };
                }
            }
            if last_claude.elapsed() >= t.claude_recheck {
                last_claude = Instant::now();
                if lock(&self.inner.status).claude.state != "found" {
                    self.refresh_claude();
                }
            }
        }
    }

    /// Looks for the user's `claude` on a worker thread (at most one at a time) and records
    /// the result in the status. Never blocks the supervisor.
    fn refresh_claude(&self) {
        if self.inner.claude_in_flight.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(data_dir) = lock(&self.inner.data_dir).clone() else {
            self.inner.claude_in_flight.store(false, Ordering::SeqCst);
            return;
        };
        let host = self.clone();
        thread::spawn(move || {
            let info = (host.inner.claude_probe)(&data_dir);
            lock(&host.inner.status).claude = info;
            host.inner.claude_in_flight.store(false, Ordering::SeqCst);
        });
    }

    /// Kill the whole tree of the current child (hung, wrong identity, or deadline).
    fn kill_child(&self) {
        let child = lock(&self.inner.child).take();
        if let Some(c) = child {
            c.terminate(self.inner.tuning.term_grace);
        }
    }

    /// The leader has exited (and been reaped by `try_wait`): drop it and SIGKILL any
    /// members still in its group so a crash leaves no orphans.
    fn reap_exited(&self) {
        let child = lock(&self.inner.child).take();
        if let Some(c) = child {
            c.terminate(Duration::ZERO);
        }
    }

    fn spawn_server(&self, port: u16, nonce: &str, data_dir: &Path) -> Result<u32, String> {
        let launch = (self.inner.launcher)(&LaunchCtx { port, nonce, data_dir })?;
        lock(&self.inner.literals).extend(launch.secrets);
        let mut cmd = launch.cmd;
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = ManagedChild::spawn(&mut cmd).map_err(|e| format!("cannot spawn the core: {e}"))?;

        if let Some(out) = child.child_mut().stdout.take() {
            drain(out, Arc::clone(&self.inner.log), false);
        }
        if let Some(err) = child.child_mut().stderr.take() {
            drain(err, Arc::clone(&self.inner.log), true);
        }
        let pid = child.id();

        let mut slot = lock(&self.inner.child);
        if lock(&self.inner.status).closing {
            drop(slot);
            child.terminate(self.inner.tuning.term_grace);
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
            if s.ms_to_healthy.is_none() {
                s.ms_to_healthy = Some(ms);
            }
            s.state = Phase::Ready;
            s.error = None;
            s.restart_at = None;
            s.fatal = false;
            s.trust = trust;
            s.nonce = None;
            s.notice = notice;
            s.error_code = None;
            s.ports_tried.clear();
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
        s.pid = None;
        s.error = Some(error);
        s.error_code = None;
        s.ports_tried.clear();
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
    Ready,
    /// The app is shutting down (or the child was taken by shutdown).
    Closed,
    /// Failed with a status set.
    Failed,
    /// This port did not work out; try the next.
    Retry(String),
}

enum Started {
    Ready { port: u16, nonce: String },
    Closed,
    Failed,
}

enum Ended {
    Closing,
    Crashed(String),
}

fn spawn_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The port of a `spawn_url`, or `None` for anything else.
fn url_port(url: &str) -> Option<u16> {
    url.strip_prefix("http://127.0.0.1:")?.parse().ok()
}

/// 32 random bytes, hex.
pub(crate) fn random_nonce() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| format!("cannot generate a launch nonce: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Equality without an early exit on the first differing byte.
pub(crate) fn ct_eq(a: &str, b: &str) -> bool {
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
/// Only the last `LOG_TAIL_LINES` lines are retained. Stderr lines also feed Self-Heal (a no-op in release builds).
fn drain<R: Read + Send + 'static>(pipe: R, log: Arc<Mutex<VecDeque<String>>>, stderr: bool) {
    thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        loop {
            let line = match read_log_line(&mut reader) {
                Ok(Some(line)) => line,
                Ok(None) => break,
                // Only a transient error keeps the pipe; anything else (EBADF, EIO) ends it.
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            if stderr {
                crate::self_heal::on_core_stderr_line(&line);
            }
            let mut buf = lock(&log);
            if buf.len() == LOG_TAIL_LINES {
                buf.pop_front();
            }
            buf.push_back(line);
        }
        if stderr {
            crate::self_heal::on_core_stderr_end();
        }
    });
}

/// Longest child output line kept in the log tail; the rest of a longer line is read and discarded.
const LOG_LINE_MAX: usize = 8 * 1024;

/// One line, at most `LOG_LINE_MAX` bytes, decoded lossily. `None` at end of input.
fn read_log_line<R: BufRead>(r: &mut R) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    if r.by_ref().take(LOG_LINE_MAX as u64).read_until(b'\n', &mut buf)? == 0 {
        return Ok(None);
    }
    if buf.len() == LOG_LINE_MAX && buf.last() != Some(&b'\n') {
        let mut rest = Vec::new();
        while r.by_ref().take(LOG_LINE_MAX as u64).read_until(b'\n', &mut rest)? > 0 && rest.last() != Some(&b'\n') {
            rest.clear();
        }
    }
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// Stop the child tree in `slot`, if any (graceful, then forced). No-op if none.
fn terminate_child(slot: &mut Option<ManagedChild>, grace: Duration) {
    if let Some(c) = slot.take() {
        c.terminate(grace);
    }
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

/// The Node core to run: the copy bundled with the app (`<resources>/core`), or the repo
/// checkout (dev runs).
pub(crate) struct Runtime {
    pub mode: &'static str,
    pub node: PathBuf,
    pub root: PathBuf,
}

/// Tauri's resource dir, set once at startup (`<App>.app/Contents/Resources` on macOS,
/// next to the exe on Windows, `/usr/lib/<product>` for a Linux package).
static RESOURCE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

/// File name of the staged node: `node.exe` on Windows (see `scripts/stage-core.mjs`).
const NODE_FILE: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// Which runtime to use. `LLMIDE_POC_BUNDLED=1` forces the bundle (error if absent); a
/// macOS `.app` always requires it (never falls back to a checkout); other release builds
/// use it when present and otherwise look for a checkout (a developer running the release
/// binary); debug builds use the checkout.
pub(crate) fn resolve_runtime() -> Result<Runtime, String> {
    let forced = std::env::var("LLMIDE_POC_BUNDLED").as_deref() == Ok("1");
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let bundle = in_app_bundle(&exe);
    let bundled = || {
        let res = RESOURCE_DIR.get().cloned().or_else(|| exe.parent()?.parent().map(|p| p.join("Resources")))?;
        bundled_core_dir(&res)
    };
    if forced || bundle || !cfg!(debug_assertions) {
        if let Some(core) = bundled() {
            return Ok(Runtime { mode: "bundled", node: core.join("node").join(NODE_FILE), root: core.join("root") });
        }
        if forced {
            return Err(format!("LLMIDE_POC_BUNDLED=1 but no bundled core next to {}", exe.display()));
        }
        if bundle {
            return Err(format!("bundled core missing from Contents/Resources/core (executable: {})", exe.display()));
        }
    }
    Ok(Runtime { mode: "repo", node: node_binary(), root: repo_root()? })
}

fn in_app_bundle(exe: &Path) -> bool {
    exe.to_string_lossy().contains(".app/Contents/MacOS/")
}

/// `<resources>/core`, when it holds the node binary and the server tree.
fn bundled_core_dir(resources: &Path) -> Option<PathBuf> {
    let dir = resources.join("core");
    let ok = dir.join("root").join("extension").join("server.mjs").is_file()
        && dir.join("node").join(NODE_FILE).is_file();
    ok.then_some(dir)
}

/// `LLMIDE_NODE`, else the first well-known Homebrew/system node, else PATH.
pub(crate) fn node_binary() -> PathBuf {
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

/// The runtime the backend prefs select: the bundled/repo default, or an explicit source checkout with its own
/// node binary and `extension` folder. Empty source fields auto-detect from the checkout.
pub(crate) fn runtime_for(p: &crate::prefs::Prefs) -> Result<Runtime, String> {
    if !p.backend_source {
        return resolve_runtime();
    }
    let dir = if !p.backend_dir.is_empty() {
        PathBuf::from(&p.backend_dir)
    } else {
        let root = repo_root().or_else(|_| crate::feature_rebuild::source_root().ok_or_else(|| "source checkout not found (set the project folder)".to_string()))?;
        root.join("extension")
    };
    let (extension, root) = if dir.join("server.mjs").is_file() {
        let root = dir.parent().ok_or_else(|| "the project folder has no parent".to_string())?.to_path_buf();
        (dir, root)
    } else if dir.join("extension").join("server.mjs").is_file() {
        (dir.join("extension"), dir)
    } else {
        return Err(format!("{} does not contain server.mjs (choose the extension folder or the checkout)", dir.display()));
    };
    let node = if p.backend_node.is_empty() { node_binary() } else { PathBuf::from(&p.backend_node) };
    if node.is_absolute() && !node.is_file() {
        return Err(format!("node binary not found: {}", node.display()));
    }
    let _ = extension;
    Ok(Runtime { mode: "source", node, root })
}

/// The spawn used in production: the bundled (or repo) node running `server.mjs` with a
/// scrubbed environment, the two secrets, and the data dir. Fails closed without secrets.
fn real_launch(ctx: &LaunchCtx<'_>) -> Result<Launch, String> {
    let p = crate::prefs::launch();
    let rt = runtime_for(&p)?;
    eprintln!("core: runtime={} node={} root={} port={}", rt.mode, rt.node.display(), rt.root.display(), ctx.port);
    let db_dir = fsutil::private_dir(&ctx.data_dir.join("core"))?;
    // Before the spawn: the core reads its extension pin once at boot, and on :3456 it must echo CORS for our
    // extension only, never any chrome-extension:// origin.
    crate::core_env::pin_extension_ids(&db_dir)?;
    // Fail closed: no secrets, no sidecar. Values go in the child's env only.
    let secrets = crate::secrets::default_backend()
        .and_then(|b| crate::secrets::load_or_create(b.as_ref()))
        .map_err(|e| e.to_string())?;
    let approval_key = crate::host_approval::key_hex()?;
    let mut cmd = core_command(&rt, &db_dir);
    cmd.arg(rt.root.join("extension").join("server.mjs"))
        .env("LLMIDE_PORT", ctx.port.to_string())
        .env("LLMIDE_CORE_NONCE", ctx.nonce)
        // Spawned core only (this is the spawn path): lets the packaged webview call it. Exact origins.
        .env("LLMIDE_CORS_ORIGINS", crate::core_env::spawned_core_cors_origins())
        .env("LLMIDE_JWT_SECRET", &secrets.jwt_secret)
        .env("LLMIDE_VAULT_KEY", &secrets.vault_key)
        // Host-signed approvals (see host_approval.rs): the spawned core may verify them; never an adopted one.
        .env("LLMIDE_HOST_APPROVAL_KEY", &approval_key);
    for (k, v) in SPAWNED_CORE_FLAGS {
        cmd.env(k, v);
    }
    // Host prefs fixed at this launch (token switches default off; only the exact value `on`).
    let host_features = std::env::var("LLMIDE_FEATURES").ok();
    for (k, v) in crate::prefs::core_env_pairs(&p, host_features.as_deref()) {
        cmd.env(k, v);
    }
    // Host API v1 loopback dev listener: debug builds only, explicit `.env` (never a widened core_env ALLOWED).
    if host_api_dev_env(cfg!(debug_assertions), std::env::var("LLMIDE_HOST_API_DEV").ok().as_deref()) {
        cmd.env("LLMIDE_HOST_API_DEV", "1");
    }
    // Self-Heal incident capture: debug builds only (self_heal::enabled), an explicit `.env` like the dev flag, never
    // a widened core_env ALLOWED.
    if crate::self_heal::enabled() {
        cmd.env("LLMIDE_SELF_HEAL", "1");
    }
    for key in ["LLMIDE_HOST_API_TLS", "LLMIDE_HOST_API_WEB_ORIGINS"] {
        if let Some(v) = host_api_env(key, std::env::var(key).ok().as_deref()) {
            cmd.env(key, v);
        }
    }
    Ok(Launch { cmd, secrets: vec![secrets.jwt_secret.clone(), secrets.vault_key.clone(), approval_key] })
}

/// True when the spawned core gets `LLMIDE_HOST_API_DEV=1`: a debug build whose own env has exactly `1`.
fn host_api_dev_env(debug: bool, value: Option<&str>) -> bool {
    debug && value == Some("1")
}

/// Host API v1 env the core may receive. TLS and the web-origin list are allowed in release builds
/// (they only tighten or enable the pinned listener); the plaintext dev flag stays debug-only (Plan 3).
fn host_api_env(key: &str, value: Option<&str>) -> Option<String> {
    match (key, value) {
        ("LLMIDE_HOST_API_TLS", Some("1")) => Some("1".into()),
        ("LLMIDE_HOST_API_WEB_ORIGINS", Some(v)) if v.len() <= 2048 => Some(v.into()),
        _ => None,
    }
}

/// `node` with the cleared + allowlisted environment, cwd `extension/`, and the data
/// layout: `LLMIDE_DATA_DIR` and `LLMIDE_DB_PATH` both point into `<data>/core`. The
/// explicit DB path makes the server's repo-kb -> data-dir boot migration a no-op, so a
/// dev run from a checkout can never MOVE the live `kb/data.db`.
fn core_command(rt: &Runtime, db_dir: &Path) -> Command {
    let parent: Vec<(String, String)> = std::env::vars().collect();
    let node_dir = (rt.mode == "bundled").then(|| rt.node.parent().map(Path::to_path_buf)).flatten();
    let (env, path) = crate::core_env::core_env(fsutil::current_os(), &parent, node_dir.as_deref());
    let mut cmd = Command::new(&rt.node);
    cmd.env_clear()
        .envs(env)
        .env("PATH", path)
        .env("LLMIDE_DATA_DIR", db_dir)
        .env("LLMIDE_DB_PATH", db_dir.join("data.db"))
        .current_dir(rt.root.join("extension"));
    cmd
}

/// Module the probe imports: the server's own single resolver for the `claude` CLI.
const CLAUDE_PROBE_JS: &str = "import { resolveClaudeExecutable, CLAUDE_INSTALL_MESSAGE } from './providers/claude-path.mjs';\n\
const r = resolveClaudeExecutable({ purpose: 'sdk' });\n\
process.stdout.write('\\nLLMIDE_CLAUDE_PROBE ' + JSON.stringify({ found: Boolean(r.path), source: r.source, message: CLAUDE_INSTALL_MESSAGE }) + '\\n');\n";

/// Runs the server's own `claude-path.mjs` under the core's node and environment, so the
/// answer is exactly what the engine will find. Any failure is `unknown`, never `missing`.
fn real_claude_probe(data_dir: &Path) -> ClaudeInfo {
    let prefs = crate::prefs::launch();
    let Ok(rt) = runtime_for(&prefs) else { return ClaudeInfo::unknown() };
    let Ok(db_dir) = fsutil::private_dir(&data_dir.join("core")) else { return ClaudeInfo::unknown() };
    let mut cmd = core_command(&rt, &db_dir);
    cmd.args(["--input-type=module", "-e", CLAUDE_PROBE_JS])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = ManagedChild::spawn(&mut cmd) else { return ClaudeInfo::unknown() };
    let Some(mut out) = child.child_mut().stdout.take() else {
        child.terminate(Duration::ZERO);
        return ClaudeInfo::unknown();
    };
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut buf = String::new();
        let _ = out.by_ref().take(256 * 1024).read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let stdout = rx.recv_timeout(CLAUDE_PROBE_TIMEOUT).ok();
    child.terminate(Duration::ZERO);
    stdout.as_deref().and_then(parse_claude_probe).unwrap_or_else(ClaudeInfo::unknown)
}

/// Reads the probe's marker line. The notice is the server's own install message, capped.
pub(crate) fn parse_claude_probe(stdout: &str) -> Option<ClaudeInfo> {
    let line = stdout.lines().rev().find_map(|l| l.strip_prefix(CLAUDE_PROBE_MARKER))?;
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("found")?.as_bool()? {
        let source = v.get("source").and_then(|s| s.as_str()).filter(|s| ["env", "bundled", "installed"].contains(s));
        return Some(ClaudeInfo { state: "found", source: source.map(str::to_string), notice: None });
    }
    let msg = v
        .get("message")
        .and_then(|m| m.as_str())
        .filter(|m| !m.is_empty() && m.len() <= 400 && !m.contains('\n'))
        .unwrap_or(CLAUDE_FALLBACK_NOTICE);
    Some(ClaudeInfo { state: "missing", source: None, notice: Some(msg.to_string()) })
}

#[tauri::command]
pub fn core_status(host: tauri::State<'_, CoreHost>) -> CoreStatus {
    host.status()
}

/// Stop the user-visible core. The app keeps running; Settings (or the core-down panel) offers Start.
#[tauri::command]
pub async fn core_stop(host: tauri::State<'_, CoreHost>) -> Result<(), String> {
    let h = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || h.stop()).await.map_err(|e| format!("stop task failed: {e}"))?
}

/// Start the core after a user Stop.
#[tauri::command]
pub async fn core_start(host: tauri::State<'_, CoreHost>) -> Result<(), String> {
    let h = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || h.start()).await.map_err(|e| format!("start task failed: {e}"))?
}

/// Kill & Restart: a clean Stop followed by a Start.
#[tauri::command]
pub async fn core_restart(host: tauri::State<'_, CoreHost>) -> Result<(), String> {
    let h = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || h.restart()).await.map_err(|e| format!("restart task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;

    #[test]
    fn host_api_dev_flag_is_debug_only_and_exact() {
        assert!(host_api_dev_env(true, Some("1")));
        assert!(!host_api_dev_env(false, Some("1")), "a release build never passes it");
        assert!(!host_api_dev_env(true, None));
        assert!(!host_api_dev_env(true, Some("true")));
        assert!(!host_api_dev_env(true, Some("")));
    }

    #[test]
    fn host_api_env_passes_only_known_values() {
        assert_eq!(host_api_env("LLMIDE_HOST_API_TLS", Some("1")), Some("1".to_string()));
        assert_eq!(host_api_env("LLMIDE_HOST_API_TLS", Some("true")), None, "only the exact value 1");
        assert_eq!(host_api_env("LLMIDE_HOST_API_TLS", None), None);
        let o = "https://app.example.com,http://127.0.0.1:5180";
        assert_eq!(host_api_env("LLMIDE_HOST_API_WEB_ORIGINS", Some(o)), Some(o.to_string()));
        assert_eq!(host_api_env("LLMIDE_HOST_API_WEB_ORIGINS", Some(&"x".repeat(2049))), None, "bounded");
        assert_eq!(host_api_env("LLMIDE_HOST_API_WEB_ORIGINS", None), None);
        assert_eq!(host_api_env("LLMIDE_HOST_API_DEV", Some("1")), None, "the dev flag has its own debug-only gate");
        assert_eq!(host_api_env("LLMIDE_VAULT_KEY", Some("1")), None);
    }

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
        // Other tests bind ephemeral ports concurrently, which can recycle this one the
        // instant it is freed; a fresh port a few times makes that vanishingly unlikely.
        let mut freed_ok = false;
        for _ in 0..5 {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            assert!(port_in_use(port));
            drop(l);
            if !port_in_use(port) {
                freed_ok = true;
                break;
            }
        }
        assert!(freed_ok);
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
    fn stop_leaves_stopped_where_shutdown_leaves_ready_so_start_can_run_again() {
        let host = CoreHost::new();
        lock(&host.inner.status).state = Phase::Ready;
        host.shutdown();
        assert!(matches!(lock(&host.inner.status).state, Phase::Ready));
        host.stop().unwrap();
        assert!(matches!(lock(&host.inner.status).state, Phase::Stopped));
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
    fn only_a_spawned_verified_core_is_handed_credentials() {
        let (port, _) = fake(|| ok_with("x-llmide-nonce: good\r\n"));
        let url = format!("http://127.0.0.1:{port}");
        // pending: nothing yet
        let host = CoreHost::new();
        assert!(host.verified_url().is_none());
        // adopted (identity unverifiable): never, even though it answers /health
        host.set_ready(url.clone(), true, 1, "adopted_unverified", Some("n".into()));
        assert!(host.verified_url().is_none(), "an adopted core is never verified");
        // spawned with the matching nonce: yes
        host.set_ready(url.clone(), false, 1, "spawned", None);
        lock(&host.inner.status).nonce = Some("good".into());
        assert_eq!(host.verified_url().as_deref(), Some(url.as_str()));
        // the process on the port stopped echoing our nonce (replaced / squatted): no
        lock(&host.inner.status).nonce = Some("other".into());
        assert!(host.verified_url().is_none());
        // not Ready: no
        lock(&host.inner.status).nonce = Some("good".into());
        lock(&host.inner.status).state = Phase::Restarting;
        assert!(host.verified_url().is_none());
    }

    #[test]
    fn a_user_stop_marks_the_core_stopped_and_start_without_a_data_dir_fails() {
        let host = CoreHost::new();
        host.stop().unwrap();
        assert_eq!(host.status().state, Phase::Stopped);
        assert_eq!(host.status().trust, "spawned", "a stopped own core is not a trust warning");
        assert!(host.start().is_err(), "there is no data dir to start against");
    }

    #[test]
    fn source_backend_prefs_select_the_checkout_runtime() {
        let dir = std::env::temp_dir().join(format!("llmide-source-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("extension")).unwrap();
        std::fs::write(dir.join("extension/server.mjs"), "//").unwrap();
        let mut p = crate::prefs::Prefs::default();
        p.backend_source = true;
        p.backend_dir = dir.join("extension").to_string_lossy().into_owned();
        p.backend_node = "node".into();
        let rt = runtime_for(&p).unwrap();
        assert_eq!(rt.mode, "source");
        assert_eq!(rt.root, dir);
        assert_eq!(rt.node, PathBuf::from("node"));
        p.backend_dir = dir.join("missing").to_string_lossy().into_owned();
        assert!(runtime_for(&p).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drain_keeps_reading_past_bad_utf8_and_an_overlong_line() {
        let mut bytes = b"first\n".to_vec();
        bytes.extend_from_slice(&[0xFF, b'\n']);
        bytes.extend(std::iter::repeat(b'a').take(1 << 20));
        bytes.extend_from_slice(b"\nlast\n");
        let log = Arc::new(Mutex::new(VecDeque::new()));
        drain(std::io::Cursor::new(bytes), log.clone(), false);
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end && !lock(&log).iter().any(|l| l == "last") {
            thread::sleep(Duration::from_millis(10));
        }
        let lines: Vec<String> = lock(&log).iter().cloned().collect();
        assert_eq!(lines[0], "first");
        assert_eq!(lines[1], "\u{FFFD}", "invalid UTF-8 is replaced, not fatal");
        assert_eq!(lines[2].len(), LOG_LINE_MAX, "the over-long line is capped");
        assert_eq!(lines.last().map(String::as_str), Some("last"), "reading went on after both");
    }

    #[test]
    fn a_panic_kill_leaves_the_core_failed_not_ready() {
        let host = CoreHost::with(tuning_fast(vec![1]), never_launcher(), no_claude());
        host.set_ready("http://127.0.0.1:1".into(), false, 1, "spawned", None);
        let mut cmd = Command::new("sleep");
        cmd.arg("30").stdin(Stdio::null());
        *lock(&host.inner.child) = Some(ManagedChild::spawn(&mut cmd).unwrap());
        host.shutdown_from_panic();
        let s = host.status();
        assert_eq!(s.state, Phase::Failed);
        assert!(s.error.is_some() && s.pid.is_none());
    }

    #[test]
    fn status_starts_pending_and_unverified_is_distinct() {
        let host = CoreHost::new();
        assert_eq!(host.status().trust, "pending");
        host.set_ready("http://127.0.0.1:3456".into(), true, 1, "adopted_unverified", Some("n".into()));
        let s = host.status();
        assert!(s.adopted && s.trust == "adopted_unverified" && s.notice.is_some());
    }

    // ---- lifecycle: restart policy, supervision, quit, orphans -------------------------

    fn tuning_fast(ports: Vec<u16>) -> Tuning {
        Tuning {
            ports,
            adopt: false,
            live_port: 1,
            ready_deadline: Duration::from_secs(10),
            term_grace: Duration::from_millis(500),
            health_interval: Duration::from_millis(100),
            health_timeout: Duration::from_millis(300),
            health_fails: 2,
            max_crashes: 3,
            crash_window: Duration::from_secs(60),
            backoff_base: Duration::from_millis(50),
            backoff_cap: Duration::from_millis(200),
            claude_recheck: Duration::from_secs(3600),
        }
    }

    #[test]
    fn restart_policy_backs_off_exponentially_then_goes_fatal() {
        let t = Tuning { max_crashes: 4, crash_window: Duration::from_secs(60), ..Tuning::default() };
        let mut p = RestartPolicy::new(&t);
        let t0 = Instant::now();
        assert_eq!(p.record_crash(t0), Decision::Restart(Duration::from_secs(1)));
        assert_eq!(p.record_crash(t0 + Duration::from_secs(2)), Decision::Restart(Duration::from_secs(2)));
        assert_eq!(p.record_crash(t0 + Duration::from_secs(5)), Decision::Restart(Duration::from_secs(4)));
        assert_eq!(p.record_crash(t0 + Duration::from_secs(10)), Decision::Fatal);
    }

    #[test]
    fn restart_policy_caps_the_delay_and_forgets_old_crashes() {
        let t = Tuning { max_crashes: 100, crash_window: Duration::from_secs(60), ..Tuning::default() };
        let mut p = RestartPolicy::new(&t);
        let t0 = Instant::now();
        let mut last = Duration::ZERO;
        for i in 0..20 {
            if let Decision::Restart(d) = p.record_crash(t0 + Duration::from_secs(i)) {
                last = d;
            }
        }
        assert_eq!(last, t.backoff_cap);
        // Everything above aged out of the window: the budget starts over.
        assert_eq!(p.record_crash(t0 + Duration::from_secs(10_000)), Decision::Restart(t.backoff_base));
    }

    fn free_ports(n: usize) -> Vec<u16> {
        let ls: Vec<TcpListener> = (0..n).map(|_| TcpListener::bind("127.0.0.1:0").unwrap()).collect();
        ls.iter().map(|l| l.local_addr().unwrap().port()).collect()
    }

    fn node_on_path() -> Option<PathBuf> {
        std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("node")).find(|c| c.is_file()))
    }

    /// A stand-in for server.mjs: serves /health with the nonce header, spawns a grandchild
    /// `sleep` (pid in `<dir>/child-<run>.pid`), and misbehaves per MODE:
    /// `ok`, `crash:K` (exit 1 shortly after ready on the first K runs), `always-crash`,
    /// `hang:K` (stop answering after ready on the first K runs), `slow` (listen after 3 s),
    /// `linger:K` (on the first K runs, crash while a detached process keeps the port for 1.5 s).
    const FAKE_SERVER: &str = r#"
const http = require('http'), fs = require('fs'), cp = require('child_process'), path = require('path');
const dir = process.env.FAKE_DIR, mode = process.env.FAKE_MODE || 'ok';
const runs = fs.existsSync(path.join(dir, 'runs')) ? fs.readFileSync(path.join(dir, 'runs'), 'utf8').split('\n').filter(Boolean).length : 0;
fs.appendFileSync(path.join(dir, 'runs'), process.pid + '\n');
const child = cp.spawn('sleep', ['300'], { stdio: 'ignore' }); child.on('error', () => {});
fs.writeFileSync(path.join(dir, 'child-' + runs + '.pid'), String(child.pid));
const [kind, kStr] = mode.split(':'); const k = Number(kStr || 0);
let hung = false;
const srv = http.createServer((req, res) => {
  if (hung) return; // never answer
  res.writeHead(200, { 'content-type': 'application/json', 'x-llmide-nonce': process.env.LLMIDE_CORE_NONCE });
  res.end('{"status":"ok"}');
});
const go = () => srv.listen(Number(process.env.LLMIDE_PORT), '127.0.0.1', () => {
  if (kind === 'always-crash' || (kind === 'crash' && runs < k)) setTimeout(() => process.exit(1), 400);
  if (kind === 'hang' && runs < k) setTimeout(() => { hung = true; }, 300);
  if (kind === 'linger' && runs < k) setTimeout(linger, 400);
});
function linger() {
  const bound = path.join(dir, 'linger-' + runs);
  const code = "require('http').createServer((q, r) => r.end()).listen(" + process.env.LLMIDE_PORT
    + ", '127.0.0.1', () => { require('fs').writeFileSync(" + JSON.stringify(bound) + ", '1');"
    + " setTimeout(() => process.exit(0), 1500); });";
  srv.close(() => {
    cp.spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref();
    const t = setInterval(() => { if (fs.existsSync(bound)) { clearInterval(t); process.exit(1); } }, 10);
  });
}
if (kind === 'slow') setTimeout(go, 3000); else go();
process.on('SIGTERM', () => process.exit(0));
"#;

    struct Fake {
        dir: PathBuf,
        host: CoreHost,
        /// Every port the launcher was asked to spawn on (the only path that hands a core its secrets).
        launched: Arc<Mutex<Vec<u16>>>,
    }

    impl Fake {
        fn new(tag: &str, mode: &str, tuning: Tuning) -> Option<Fake> {
            let node = node_on_path()?;
            let dir = std::env::temp_dir().join(format!("llmide-fake-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("fake-server.cjs");
            std::fs::write(&script, FAKE_SERVER).unwrap();
            let mode = mode.to_string();
            let fdir = dir.clone();
            let launched = Arc::new(Mutex::new(Vec::new()));
            let seen = Arc::clone(&launched);
            let launcher: Launcher = Arc::new(move |ctx: &LaunchCtx<'_>| {
                lock(&seen).push(ctx.port);
                let mut cmd = Command::new(&node);
                cmd.arg(&script)
                    .env("LLMIDE_PORT", ctx.port.to_string())
                    .env("LLMIDE_CORE_NONCE", ctx.nonce)
                    .env("FAKE_DIR", &fdir)
                    .env("FAKE_MODE", &mode)
                    .env("PATH", std::env::var_os("PATH").unwrap_or_default());
                Ok(Launch { cmd, secrets: vec![] })
            });
            let probe: ClaudeProbe = Arc::new(|_| ClaudeInfo {
                state: "missing",
                source: None,
                notice: Some("install claude".into()),
            });
            let host = CoreHost::with(tuning, launcher, probe);
            host.start_in_background(Some(dir.clone()));
            Some(Fake { dir, host, launched })
        }

        fn wait_for(&self, what: &str, secs: u64, mut f: impl FnMut(&CoreStatus) -> bool) -> CoreStatus {
            let end = Instant::now() + Duration::from_secs(secs);
            loop {
                let s = self.host.status();
                if f(&s) {
                    return s;
                }
                assert!(Instant::now() < end, "timed out waiting for {what}; last status: {s:?}");
                thread::sleep(Duration::from_millis(25));
            }
        }

        fn pids(&self, prefix: &str) -> Vec<i32> {
            let mut v = Vec::new();
            for e in std::fs::read_dir(&self.dir).unwrap().flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with(prefix) && n.ends_with(".pid") {
                    v.push(std::fs::read_to_string(e.path()).unwrap().trim().parse().unwrap());
                }
            }
            v
        }

        fn runs(&self) -> Vec<i32> {
            std::fs::read_to_string(self.dir.join("runs"))
                .unwrap_or_default()
                .lines()
                .filter_map(|l| l.parse().ok())
                .collect()
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            self.host.shutdown();
        }
    }

    fn never_launcher() -> Launcher {
        Arc::new(|_| Err("must not launch".into()))
    }

    fn no_claude() -> ClaudeProbe {
        Arc::new(|_| ClaudeInfo::unknown())
    }

    #[test]
    fn adopt_policy_is_off_in_release_unless_explicit() {
        assert!(!default_adopt(false, None, None), "release default");
        assert!(!default_adopt(false, Some("0"), None));
        assert!(default_adopt(false, Some("1"), None), "explicit opt-in");
        assert!(default_adopt(true, None, None), "debug keeps the dev flow");
        assert!(!default_adopt(true, None, Some("1")), "force-spawn still wins in debug");
        assert!(default_adopt(true, Some("1"), Some("1")));
        assert!(!default_adopt(true, Some("0"), None));
    }

    #[test]
    fn adoption_happens_only_when_enabled() {
        let (port, _) = fake(|| ok_with(""));
        let t = Tuning { live_port: port, adopt: true, ..tuning_fast(vec![1]) };
        let host = CoreHost::with(t, never_launcher(), no_claude());
        host.start_in_background(Some(std::env::temp_dir()));
        let end = Instant::now() + Duration::from_secs(5);
        while host.status().state != Phase::Ready && Instant::now() < end {
            thread::sleep(Duration::from_millis(20));
        }
        let s = host.status();
        assert!(s.adopted && s.trust == "adopted_unverified" && s.foreign_core.is_none(), "{s:?}");
        assert!(host.verified_url().is_none());
    }

    #[test]
    fn a_user_stop_then_start_restarts_a_real_child() {
        let Some(f) = Fake::new("stopstart", "ok", tuning_fast(free_ports(2))) else { return };
        f.wait_for("ready", 5, |s| s.state == Phase::Ready);
        let first = f.host.status().pid;
        f.host.stop().unwrap();
        assert_eq!(f.host.status().state, Phase::Stopped);
        assert!(f.host.status().pid.is_none());
        f.host.start().unwrap();
        let s = f.wait_for("ready after start", 5, |s| s.state == Phase::Ready);
        assert!(s.pid.is_some());
        assert_ne!(s.pid, first, "the user start launched a new child");
        f.host.stop().unwrap();
        assert_eq!(f.host.status().state, Phase::Stopped);
    }

    #[test]
    fn a_foreign_core_is_ignored_and_our_own_is_started_on_the_next_port() {
        let (live, hits) = fake(|| ok_with(""));
        let ports = free_ports(2);
        let t = Tuning { live_port: live, adopt: false, ..tuning_fast(ports.clone()) };
        let Some(f) = Fake::new("foreign", "ok", t) else { return };
        let s = f.wait_for("ready", 15, |s| s.state == Phase::Ready);
        assert!(!s.adopted && s.trust == "spawned", "{s:?}");
        assert_eq!(s.url, format!("http://127.0.0.1:{}", ports[0]));
        let fc = s.foreign_core.expect("foreign core is reported");
        assert!(fc.detected && fc.port == live && fc.notice.contains("not used by this app"));
        assert!(hits.load(std::sync::atomic::Ordering::SeqCst) >= 1);
        assert!(f.host.verified_url().is_some(), "only the spawned core gets credentials");
        assert!(s.error_code.is_none());
    }

    #[test]
    fn a_nonce_less_listener_on_the_live_port_is_never_used_and_the_core_spawns_on_the_next() {
        let (live, hits) = fake(|| ok_with(""));
        let mut ports = vec![live];
        ports.extend(free_ports(1));
        let t = Tuning { live_port: ports[0], adopt: false, ..tuning_fast(ports.clone()) };
        let Some(f) = Fake::new("live-squat", "ok", t) else { return };
        let s = f.wait_for("ready", 15, |s| s.state == Phase::Ready);
        assert!(!s.adopted && s.trust == "spawned", "{s:?}");
        assert_eq!(s.url, format!("http://127.0.0.1:{}", ports[1]), "fell back to the next port");
        assert_eq!(*lock(&f.launched), vec![ports[1]], "no core (and no secret) was ever launched for the squatted port");
        assert_eq!(f.host.verified_url(), Some(format!("http://127.0.0.1:{}", ports[1])), "credentials go to our own core only");
        assert!(hits.load(std::sync::atomic::Ordering::SeqCst) >= 1, "the squatter was probed");
        let fc = s.foreign_core.expect("the squatter is reported");
        assert_eq!(fc.port, ports[0]);
        assert!(!s.extension_reachable, "the extension's port belongs to someone else");
    }

    #[test]
    fn a_free_live_port_gets_our_core_and_the_extension_can_reach_it() {
        let ports = free_ports(2);
        let t = Tuning { live_port: ports[0], adopt: false, ..tuning_fast(ports.clone()) };
        let Some(f) = Fake::new("live-free", "ok", t) else { return };
        let s = f.wait_for("ready", 15, |s| s.state == Phase::Ready);
        assert_eq!(s.url, format!("http://127.0.0.1:{}", ports[0]));
        assert!(s.foreign_core.is_none(), "{s:?}");
        assert!(s.extension_reachable);
        assert_eq!(serde_json::to_value(&s).unwrap()["extensionReachable"], true);
    }

    #[cfg(unix)]
    #[test]
    fn a_supervised_restart_waits_for_the_live_port_instead_of_moving_off_it() {
        let ports = free_ports(2);
        let t = Tuning { live_port: ports[0], adopt: false, ..tuning_fast(ports.clone()) };
        let Some(f) = Fake::new("linger", "linger:1", t) else { return };
        let s = f.wait_for("ready after the crash", 30, |s| s.state == Phase::Ready && s.restarts == 1);
        assert!(f.dir.join("linger-0").exists(), "the port really was still busy at the restart");
        assert_eq!(s.url, format!("http://127.0.0.1:{}", ports[0]), "restarted on the live port");
        assert_eq!(*lock(&f.launched), vec![ports[0], ports[0]]);
        assert!(s.extension_reachable);
    }

    #[test]
    fn all_spawn_ports_busy_fails_with_ports_busy_and_the_ports_tried() {
        let ls: Vec<TcpListener> = (0..3).map(|_| TcpListener::bind("127.0.0.1:0").unwrap()).collect();
        let ports: Vec<u16> = ls.iter().map(|l| l.local_addr().unwrap().port()).collect();
        let t = Tuning { live_port: 1, ..tuning_fast(ports.clone()) };
        let host = CoreHost::with(t, never_launcher(), no_claude());
        host.start_in_background(Some(std::env::temp_dir()));
        let end = Instant::now() + Duration::from_secs(10);
        while host.status().state != Phase::Failed && Instant::now() < end {
            thread::sleep(Duration::from_millis(20));
        }
        let s = host.status();
        assert_eq!(s.state, Phase::Failed, "{s:?}");
        assert_eq!(s.error_code, Some("ports_busy"));
        assert_eq!(s.ports_tried, ports);
        assert!(s.error.unwrap().contains("busy"));
        drop(ls);
    }

    #[test]
    fn core_status_serializes_the_new_fields_additively() {
        let host = CoreHost::with(tuning_fast(vec![1]), never_launcher(), no_claude());
        let v = serde_json::to_value(host.status()).unwrap();
        assert!(v["foreign_core"].is_null() && v["error_code"].is_null() && v["ports_tried"].as_array().unwrap().is_empty());
        assert_eq!(v["extensionReachable"], false);
        host.note_foreign(3456);
        let v = serde_json::to_value(host.status()).unwrap();
        assert_eq!(v["foreign_core"]["port"], 3456);
        assert_eq!(v["foreign_core"]["detected"], true);
    }

    #[cfg(unix)]
    fn all_dead(pids: &[i32]) -> bool {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            // SAFETY: signal 0 is an existence check.
            if pids.iter().all(|p| unsafe { libc::kill(*p, 0) } != 0) {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[cfg(unix)]
    #[test]
    fn quit_stops_the_core_and_every_grandchild() {
        let Some(f) = Fake::new("quit", "ok", tuning_fast(free_ports(2))) else { return };
        let s = f.wait_for("ready", 15, |s| s.state == Phase::Ready);
        assert_eq!(s.trust, "spawned");
        assert!(!s.fatal && s.restarts == 0 && s.restart_in_ms.is_none());
        let leader = s.pid.unwrap() as i32;
        let grandkids = f.pids("child-");
        assert_eq!(grandkids.len(), 1);
        f.host.shutdown();
        let mut all = grandkids;
        all.push(leader);
        assert!(all_dead(&all), "survivors after quit: {all:?}");
        f.host.shutdown(); // idempotent
    }

    #[cfg(unix)]
    #[test]
    fn a_crashed_core_is_restarted_with_backoff_and_leaves_no_orphans() {
        let Some(f) = Fake::new("crash", "crash:2", tuning_fast(free_ports(3))) else { return };
        let mut saw_restarting = false;
        let s = f.wait_for("ready after two restarts", 30, |s| {
            saw_restarting |= s.state == Phase::Restarting;
            s.state == Phase::Ready && s.restarts == 2
        });
        assert!(saw_restarting, "the webview must be able to see a restarting state");
        assert!(!s.fatal && s.error.is_none());
        // The two crashed runs left a sleep child each; the host must have reaped them.
        let runs = f.runs();
        assert_eq!(runs.len(), 3);
        let old_children: Vec<i32> = (0..2)
            .map(|i| std::fs::read_to_string(f.dir.join(format!("child-{i}.pid"))).unwrap().trim().parse().unwrap())
            .collect();
        assert!(all_dead(&old_children), "orphans from crashed runs: {old_children:?}");
        assert!(all_dead(&runs[..2]));
    }

    #[cfg(unix)]
    #[test]
    fn a_core_that_keeps_crashing_ends_in_a_fatal_state_and_is_not_restarted_again() {
        let Some(f) = Fake::new("fatal", "always-crash", tuning_fast(free_ports(3))) else { return };
        let s = f.wait_for("fatal", 30, |s| s.fatal);
        assert_eq!(s.state, Phase::Failed);
        assert!(s.error.as_deref().unwrap().contains("not restarted"));
        let n = f.runs().len();
        assert_eq!(n, 3, "max_crashes = 3 means three runs in total");
        thread::sleep(Duration::from_millis(800));
        assert_eq!(f.runs().len(), n, "no restart loop after the fatal state");
        assert!(f.host.status().fatal);
        assert!(all_dead(&f.runs()));
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_core_is_detected_by_the_nonce_health_check_and_restarted() {
        let Some(f) = Fake::new("hang", "hang:1", tuning_fast(free_ports(3))) else { return };
        f.wait_for("ready", 15, |s| s.state == Phase::Ready);
        let s = f.wait_for("restarted after hang", 30, |s| s.state == Phase::Ready && s.restarts == 1);
        assert_eq!(s.trust, "spawned");
        let runs = f.runs();
        assert_eq!(runs.len(), 2);
        assert!(all_dead(&runs[..1]), "the hung core must be killed, not leaked");
    }

    #[cfg(unix)]
    #[test]
    fn quit_while_starting_never_leaves_a_core_behind_or_reports_ready() {
        let Some(f) = Fake::new("qws", "slow", tuning_fast(free_ports(2))) else { return };
        f.wait_for("spawned", 10, |s| s.pid.is_some());
        let end = Instant::now() + Duration::from_secs(10);
        while f.runs().is_empty() && Instant::now() < end {
            thread::sleep(Duration::from_millis(20)); // node has started and holds its grandchild
        }
        let leader = f.host.status().pid.unwrap() as i32;
        f.host.shutdown();
        thread::sleep(Duration::from_millis(500));
        let s = f.host.status();
        assert_ne!(s.state, Phase::Ready);
        assert!(all_dead(&[leader]));
        // The start thread must not spawn again after shutdown.
        thread::sleep(Duration::from_millis(500));
        assert_eq!(f.runs().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn claude_status_is_exposed_additively_and_never_with_a_path() {
        let Some(f) = Fake::new("claude", "ok", tuning_fast(free_ports(2))) else { return };
        let s = f.wait_for("claude probed", 15, |s| s.claude != "unknown");
        assert_eq!(s.claude, "missing");
        assert_eq!(s.claude_notice.as_deref(), Some("install claude"));
        assert!(s.claude_source.is_none());
        let json = serde_json::to_value(&s).unwrap();
        for k in ["restarts", "restart_in_ms", "fatal", "claude", "claude_source", "claude_notice", "url", "state"] {
            assert!(json.get(k).is_some(), "missing {k}");
        }
        assert_eq!(json["state"], "ready");
    }

    #[test]
    fn restarting_serialises_lowercase() {
        assert_eq!(serde_json::to_value(Phase::Restarting).unwrap(), "restarting");
    }

    #[test]
    fn claude_probe_output_is_parsed_strictly() {
        let found = "noise\nLLMIDE_CLAUDE_PROBE {\"found\":true,\"source\":\"installed\",\"message\":\"m\"}\n";
        let i = parse_claude_probe(found).unwrap();
        assert_eq!((i.state, i.source.as_deref(), i.notice), ("found", Some("installed"), None));
        let missing = "LLMIDE_CLAUDE_PROBE {\"found\":false,\"source\":\"none\",\"message\":\"Install Claude Code\"}";
        let i = parse_claude_probe(missing).unwrap();
        assert_eq!((i.state, i.notice.as_deref()), ("missing", Some("Install Claude Code")));
        // An odd source is dropped; an oversized or multi-line message falls back to ours.
        let weird = "LLMIDE_CLAUDE_PROBE {\"found\":true,\"source\":\"/Users/x/claude\"}";
        assert!(parse_claude_probe(weird).unwrap().source.is_none());
        let long = format!("LLMIDE_CLAUDE_PROBE {{\"found\":false,\"message\":\"{}\"}}", "a".repeat(500));
        assert_eq!(parse_claude_probe(&long).unwrap().notice.as_deref(), Some(CLAUDE_FALLBACK_NOTICE));
        assert!(parse_claude_probe("no marker here").is_none());
        assert!(parse_claude_probe("LLMIDE_CLAUDE_PROBE not-json").is_none());
    }

    #[test]
    fn bundled_core_needs_both_node_and_server() {
        let d = std::env::temp_dir().join(format!("llmide-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let core = d.join("core");
        std::fs::create_dir_all(core.join("root/extension")).unwrap();
        std::fs::create_dir_all(core.join("node")).unwrap();
        assert!(bundled_core_dir(&d).is_none());
        std::fs::write(core.join("root/extension/server.mjs"), "").unwrap();
        assert!(bundled_core_dir(&d).is_none());
        std::fs::write(core.join("node").join(NODE_FILE), "").unwrap();
        assert_eq!(bundled_core_dir(&d), Some(core));
    }

    #[cfg(unix)]
    #[test]
    fn the_core_command_runs_with_a_cleared_environment_and_explicit_db() {
        let rt = Runtime { mode: "bundled", node: PathBuf::from("/App/core/node/node"), root: PathBuf::from("/App/core/root") };
        let cmd = core_command(&rt, Path::new("/data/core"));
        let envs: std::collections::HashMap<_, _> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().to_string(), v.map(|v| v.to_string_lossy().to_string()))).collect();
        assert_eq!(envs["LLMIDE_DATA_DIR"].as_deref(), Some("/data/core"));
        assert_eq!(envs["LLMIDE_DB_PATH"].as_deref(), Some("/data/core/data.db"));
        assert!(envs["PATH"].as_deref().unwrap().ends_with("/App/core/node"));
        for leaked in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS", "LLMIDE_JWT_SECRET", "GITHUB_TOKEN"] {
            assert!(!envs.contains_key(leaked), "{leaked} must not reach the core");
        }
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/App/core/root/extension")));
    }

    /// Run by hand against a real staging (`node scripts/stage-core.mjs` first):
    /// `LLMIDE_KEYCHAIN_BACKEND=memory cargo test --lib real_staged_core -- --ignored --nocapture`.
    /// Exercises the production launcher (cleared env, secrets, data layout), the nonce
    /// handshake, the claude probe and the tree stop against the real server.
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn real_staged_core_starts_reports_claude_and_stops_clean() {
        let res = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("resources");
        assert!(res.join("core").join("node").join(NODE_FILE).is_file(), "stage the core first");
        set_resource_dir(res.canonicalize().unwrap());
        std::env::set_var("LLMIDE_POC_BUNDLED", "1");
        std::env::set_var("LLMIDE_KEYCHAIN_BACKEND", "memory");
        let dir = std::env::temp_dir().join(format!("llmide-real-core-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dir = fsutil::private_dir(&dir).unwrap();
        let t = Tuning { ports: free_ports(2), adopt: false, ..Tuning::default() };
        let host = CoreHost::with(t, Arc::new(real_launch), Arc::new(real_claude_probe));
        host.start_in_background(Some(dir.clone()));
        let end = Instant::now() + Duration::from_secs(40);
        let s = loop {
            let s = host.status();
            if (s.state == Phase::Ready && s.claude != "unknown") || s.state == Phase::Failed || Instant::now() > end {
                break s;
            }
            thread::sleep(Duration::from_millis(50));
        };
        println!("status: {s:?}");
        assert_eq!(s.state, Phase::Ready, "{s:?}");
        assert_eq!(s.trust, "spawned");
        assert!(dir.join("core").join("data.db").is_file(), "DB must live in the data dir");
        assert_ne!(s.claude, "unknown");
        let pid = s.pid.unwrap() as i32;
        host.shutdown();
        // SAFETY: existence check only.
        assert!(all_dead(&[pid]), "core survived shutdown");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_spawned_core_holds_extension_captures_for_the_archivist() {
        assert!(SPAWNED_CORE_FLAGS.contains(&("LLMIDE_LIVE_ACK", "1")));
        let host = vec![("LLMIDE_LIVE_ACK".to_string(), "0".to_string())];
        assert!(crate::core_env::scrub(&host, crate::fsutil::Os::Mac).is_empty(), "never taken from the host env");
    }
}
