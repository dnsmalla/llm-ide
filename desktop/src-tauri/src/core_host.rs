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
use crate::prefs::{ServerMode, SshAuthKind};
use crate::remote_proxy::ProxyHandle;
use crate::ssh_link::{LinkState, SshLink};
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
/// `LLMIDE_HOST_API_CHAT_CLEAR`: the phone's own "clear / delete this chat" (behind a confirmation there) works; without it the
/// core refuses and the phone's cleared chat reappears on the next reload. It has no Settings switch.
/// `LLMIDE_EXT_ACTIVE_SET`: an extension switched on in Library → Extensions loads into Claude chats (the catalog's
/// active set); with it off the core ignores those switches. Installing an item whose kind and name another item
/// already holds is refused by the core, so a shared switch never turns an existing plugin off.
/// `LLMIDE_REGISTRATION_SINGLE_OWNER`: this core serves one person, so a no-invite sign-up is refused once an owner exists
/// (`selfRegistrationOpen` in `extension/server/users.mjs`); the first account on a fresh install still registers and becomes
/// the owner. Without it any process that can reach the loopback port could register a second account with `maxMode: execute`.
/// SSH mode sets the same flag in `ssh_server_scripts.rs`.
/// NOTE: `LLMIDE_HOST_API_READ` / `_COMPOSE` / `_TOOL_APPROVALS` are NOT here: they are Settings switches, on by default,
/// and `prefs::core_env_pairs` passes each one as an explicit `1` or `0` so turning one off is honoured.
const SPAWNED_CORE_FLAGS: [(&str, &str); 6] = [
    ("LLMIDE_ENGINE_PREWARM", "0"),
    ("LLMIDE_BACKUP_INTERVAL_HOURS", "0"),
    ("LLMIDE_LIVE_ACK", "1"),
    ("LLMIDE_HOST_API_CHAT_CLEAR", "1"),
    ("LLMIDE_EXT_ACTIVE_SET", "1"),
    ("LLMIDE_REGISTRATION_SINGLE_OWNER", "1"),
];
/// On a supervised restart, how long the port our just-exited core held may stay busy before it is skipped.
const RESTART_PORT_WAIT: Duration = Duration::from_secs(3);
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// Per-probe timeout on the spawned port (kept short so readiness isn't quantized).
const SPAWN_PROBE_TIMEOUT: Duration = Duration::from_millis(250);
const READY_DEADLINE: Duration = Duration::from_secs(20);
/// A core that still accepts TCP connections but has not answered `/health` for this long is declared hung.
const HEALTH_BUSY_BUDGET: Duration = Duration::from_secs(180);
const PORT_OPEN_TIMEOUT: Duration = Duration::from_millis(500);
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
    /// Consecutive failed health probes after which a core whose port REFUSES connections counts as dead.
    pub health_fails: u32,
    /// How long a core that is alive and listening but not answering `/health` in time (a long synchronous
    /// database call, swap pressure) is waited for before it counts as hung. Killing it sooner would take its
    /// in-flight Loop and agent work with it.
    pub health_busy_budget: Duration,
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
            health_busy_budget: HEALTH_BUSY_BUDGET,
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

/// The wait before retry `attempt` (1-based): `base` doubled per earlier attempt, never above `cap`. The one
/// backoff curve for the core's crash restarts and the SSH link's reconnects.
pub(crate) fn exponential_backoff(base: Duration, cap: Duration, attempt: u32) -> Duration {
    // The shift is bounded so the multiplier cannot overflow; any base worth backing off from reaches `cap` first.
    let shift = attempt.saturating_sub(1).min(16);
    base.saturating_mul(1u32 << shift).min(cap)
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
        Decision::Restart(exponential_backoff(self.base, self.cap, self.crashes.len() as u32))
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
    /// Remote mode: this app talks to a pinned hub through the loopback proxy; no local child exists.
    Remote,
    /// SSH mode: the core runs on a server and is reached through a supervised ssh forward; no local child exists.
    Ssh,
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
    /// `local` or `remote` (the host's server mode).
    pub mode: &'static str,
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
    /// Additive, SSH mode only; `null` otherwise. One of: `connecting` (a key-mode connect is running), `connected` and
    /// `reconnecting` (the live link's state), `needs_password` (password auth, not connected yet), `failed` (a connect
    /// ended with an error, or the live link reports `Failed`), `stopped` (after a Stop, or at launch with start off).
    pub link: Option<&'static str>,
}

/// What one spawn needs; produced by a [`Launcher`].
pub struct Launch {
    pub cmd: Command,
    /// Literal secret values to scrub from the failure log.
    pub secrets: Vec<String>,
    /// One JSON line for the child's stdin (`jwtSecret`, `vaultKey`, `hostApprovalKey`). Never an env var: a
    /// same-user process can read the environment of any process it owns. `None` for the test launchers.
    pub stdin_secrets: Option<String>,
}

pub struct LaunchCtx<'a> {
    /// The preferences this core run is started with (see `CoreHost::run_prefs`).
    pub prefs: &'a crate::prefs::Prefs,
    pub port: u16,
    pub nonce: &'a str,
    pub data_dir: &'a Path,
}

pub type Launcher = Arc<dyn for<'a> Fn(&LaunchCtx<'a>) -> Result<Launch, String> + Send + Sync>;
pub type ClaudeProbe = Arc<dyn Fn(&Path, &crate::prefs::Prefs) -> ClaudeInfo + Send + Sync>;
/// Where a user-initiated start reads the CURRENT stored preferences (tests inject their own).
pub type PrefsSource = Arc<dyn Fn() -> crate::prefs::Prefs + Send + Sync>;
/// Builds the forward for SSH mode from the saved server settings. Injected so `CoreHost` never holds a bundle,
/// a secret or a pinned host key; the SSH connect flow supplies the production one.
pub type SshConnector = Arc<dyn Fn(&crate::prefs::RemoteServerPrefs) -> Result<SshLink, crate::fs_ops::FsError> + Send + Sync>;

/// Until the SSH connect flow is wired in, SSH mode reports that instead of guessing how to connect.
fn unwired_ssh_connector() -> SshConnector {
    Arc::new(|_| Err(crate::fs_ops::FsError { code: "SSH_NOT_WIRED", message: "SSH server mode is not available in this build yet.".into() }))
}

/// SSH mode's link slot. The link and the "a key-mode connect is running" flag share one lock, so an attach and
/// the flag change together and `status` never reads one without the other.
#[derive(Default)]
struct SshSlot {
    link: Option<SshLink>,
    connecting: bool,
    /// Set when the user ended the link (Disconnect, Stop server, Uninstall, or a stop of the host), so the
    /// status reads `stopped` instead of the failure a missing link would otherwise show. Cleared when a link is
    /// attached and when a startup begins.
    disconnected: bool,
}

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
    /// 0 = local, 1 = remote. Set by `lib.rs` after `prefs::init`, before the first start.
    mode: std::sync::atomic::AtomicU8,
    /// The loopback pinned proxy while remote mode is running.
    remote_proxy: Mutex<Option<ProxyHandle>>,
    /// Held by `start` and `stop` for their whole duration. The guard check, the join of the old supervisor
    /// and the `Starting` write must be one step: otherwise two quick starts both pass the guard and run two
    /// supervisors, i.e. two cores on one SQLite DB.
    lifecycle: Mutex<()>,
    /// Preferences the current core run was started with. `None` until a user Start/Restart: the launch
    /// snapshot applies then. The supervisor's own crash restarts reuse it, so nothing changes by itself.
    run_prefs: Mutex<Option<crate::prefs::Prefs>>,
    prefs_source: PrefsSource,
    /// The supervised forward SSH mode serves. Its own lock: `status` reads it, and nothing holds both locks.
    ssh_link: Mutex<SshSlot>,
    ssh_connector: Mutex<SshConnector>,
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

/// Process-wide mode for host commands that have no `CoreHost` state (fs, pty, capture). Set in `set_mode`.
static MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

pub fn require_local_mode() -> Result<(), crate::fs_ops::FsError> {
    match MODE.load(Ordering::SeqCst) {
        1 => Err(crate::fs_ops::FsError { code: "remote_mode", message: "This action uses the local computer and is unavailable in remote mode.".into() }),
        2 => Err(crate::fs_ops::FsError { code: "ssh_mode", message: "This action uses the local computer and is unavailable in SSH server mode.".into() }),
        _ => Ok(()),
    }
}

/// Whether SSH server mode is on. The Explorer then runs on the server, and the local project is not used.
pub fn is_ssh_mode() -> bool {
    MODE.load(Ordering::SeqCst) == 2
}

/// The helper channel's ssh inputs from the attached link. Fails with `lost_connection` when no link is attached
/// or the forward is not up.
pub(crate) fn attached_helper_spawn() -> Result<crate::ssh_link::HelperSpawn, crate::fs_ops::FsError> {
    let Some(host) = crate::CORE.get() else {
        return Err(crate::ssh_workspace::lost());
    };
    let slot = lock(&host.inner.ssh_link);
    match slot.link.as_ref() {
        Some(link) => link.helper_spawn(),
        None => Err(crate::ssh_workspace::lost()),
    }
}

/// Lets a test outside this module take the lock the mode tests share, so no other test changes `MODE` meanwhile.
#[cfg(test)]
pub(crate) fn process_mode_guard() -> MutexGuard<'static, ()> {
    tests::mode_guard()
}

/// Sets `MODE` directly to a server mode value (0 local, 1 remote, 2 ssh), for tests of commands that read it.
#[cfg(test)]
pub(crate) fn set_process_mode(value: u8) {
    MODE.store(value, Ordering::SeqCst);
}

/// The value `MODE` and `Inner::mode` store for a server mode: 0 local, 1 remote, 2 ssh.
fn mode_value(mode: ServerMode) -> u8 {
    match mode {
        ServerMode::Local => 0,
        ServerMode::Remote => 1,
        ServerMode::Ssh => 2,
    }
}

fn mode_from_value(value: u8) -> ServerMode {
    match value {
        1 => ServerMode::Remote,
        2 => ServerMode::Ssh,
        _ => ServerMode::Local,
    }
}

/// The `mode` field of `CoreStatus`.
fn mode_name(mode: ServerMode) -> &'static str {
    match mode {
        ServerMode::Local => "local",
        ServerMode::Remote => "remote",
        ServerMode::Ssh => "ssh",
    }
}

/// The label of a live link's state.
fn live_link_label(state: &LinkState) -> &'static str {
    match state {
        LinkState::Connected => "connected",
        LinkState::Reconnecting { .. } => "reconnecting",
        LinkState::NeedsPassword => "needs_password",
        LinkState::Failed { .. } => "failed",
    }
}

/// What SSH mode reads from the link slot on each `status()` call, taken in one lock.
struct SshView {
    url: Option<String>,
    state: Option<LinkState>,
    connecting: bool,
    disconnected: bool,
    password_auth: bool,
}

/// `url`, `error` and `link` for SSH mode. A live link decides the label. With no link, the phase and the
/// user's last action decide: a stopped host, or one the user disconnected, says `stopped`, not `failed`. That check
/// comes before the connect flag, so a stop never reads as a connect still in progress.
fn ssh_fields(view: SshView, phase: Phase, stored_error: Option<String>) -> (String, Option<String>, &'static str) {
    let error = match &view.state {
        Some(LinkState::Failed { message, .. }) => Some(message.clone()),
        _ => stored_error,
    };
    let label = match &view.state {
        Some(state) => live_link_label(state),
        None if phase == Phase::Stopped || view.disconnected => "stopped",
        None if view.connecting => "connecting",
        None if view.password_auth => "needs_password",
        // Phase::Starting is the window before the startup thread starts a key-mode connect.
        None if phase == Phase::Starting => "connecting",
        None => "failed",
    };
    (view.url.unwrap_or_default(), error, label)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// How long a core found on the live port at launch is given to go away before it is treated as someone else's.
const ORPHAN_SETTLE: Duration = if cfg!(test) { Duration::ZERO } else { Duration::from_millis(1500) };

/// True when `healthy` answers yes now and keeps answering yes for `settle` (checked every `interval`). The first no
/// ends the wait: the core that was there has gone.
fn still_healthy_after(settle: Duration, interval: Duration, mut healthy: impl FnMut() -> bool) -> bool {
    if !healthy() {
        return false;
    }
    let until = Instant::now() + settle;
    while Instant::now() < until {
        std::thread::sleep(interval.min(until.saturating_duration_since(Instant::now())));
        if !healthy() {
            return false;
        }
    }
    true
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
                mode: std::sync::atomic::AtomicU8::new(0),
                remote_proxy: Mutex::new(None),
                lifecycle: Mutex::new(()),
                run_prefs: Mutex::new(None),
                prefs_source: Arc::new(crate::prefs::stored),
                ssh_link: Mutex::new(SshSlot::default()),
                ssh_connector: Mutex::new(unwired_ssh_connector()),
            }),
        }
    }

    /// Where a user-initiated start reads the stored preferences. Tests only; production uses `prefs::stored`.
    #[cfg(test)]
    fn with_prefs_source(mut self, source: PrefsSource) -> Self {
        if let Some(inner) = Arc::get_mut(&mut self.inner) {
            inner.prefs_source = source;
        }
        self
    }

    /// The preferences this core run uses: what the last user Start/Restart read, else the launch snapshot.
    /// Automatic crash restarts never re-read the file, so a stored change applies only on a user's next start.
    fn run_prefs(&self) -> crate::prefs::Prefs {
        lock(&self.inner.run_prefs).clone().unwrap_or_else(crate::prefs::launch)
    }

    /// Records the server mode. It applies at the next app start or user Start: a change never restarts a core.
    pub fn set_mode(&self, mode: ServerMode) {
        let v = mode_value(mode);
        self.inner.mode.store(v, Ordering::SeqCst);
        MODE.store(v, Ordering::SeqCst);
    }

    pub fn mode(&self) -> ServerMode {
        mode_from_value(self.inner.mode.load(Ordering::SeqCst))
    }

    /// The URL of the core this app SPAWNED and verified, right now: `Some` only while the phase is
    /// `Ready`, the trust is `spawned` (never an adopted or still-pending core), and `/health` still
    /// echoes this launch's nonce. Callers that hand a credential to the core re-ask at every use, so a
    /// restart on another port (or a squatter) is never sent a stale URL's token. Hub and SSH mode never qualify.
    pub fn verified_url(&self) -> Option<String> {
        if self.mode() != ServerMode::Local { return None; }
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
        let mode = self.mode();
        // Read before the status lock: the link has its own lock and the two are never held together.
        let ssh = self.ssh_view(mode);
        let s = lock(&self.inner.status);
        let (url, error, link) = match ssh {
            Some(view) => {
                let (url, error, label) = ssh_fields(view, s.state, s.error.clone());
                (url, error, Some(label))
            }
            None => (s.url.clone(), s.error.clone(), None),
        };
        CoreStatus {
            url,
            mode: mode_name(mode),
            adopted: s.adopted,
            pid: s.pid,
            ms_to_healthy: s.ms_to_healthy,
            state: s.state,
            error,
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
            link,
        }
    }

    /// SSH mode's part of `status()`; `None` in every other mode. Takes only the link lock.
    fn ssh_view(&self, mode: ServerMode) -> Option<SshView> {
        if mode != ServerMode::Ssh {
            return None;
        }
        let (url, state, connecting, disconnected) = {
            let slot = lock(&self.inner.ssh_link);
            (
                slot.link.as_ref().map(SshLink::url),
                slot.link.as_ref().map(SshLink::state),
                slot.connecting,
                slot.disconnected,
            )
        };
        let password_auth = self.run_prefs().remote_server.ssh_auth == SshAuthKind::Password;
        Some(SshView { url, state, connecting, disconnected, password_auth })
    }

    /// Makes `link` the one SSH mode serves. The swap is one lock, so two concurrent attaches cannot both see the
    /// same previous link and leak one. The replaced link is stopped after the lock is released; a link that
    /// reached `NeedsPassword` is dead and must be replaced, not resumed.
    pub fn attach_ssh_link(&self, link: SshLink) {
        let (previous, same_server) = {
            let mut slot = lock(&self.inner.ssh_link);
            slot.connecting = false;
            slot.disconnected = false;
            // SSH terminals stay open only for a reconnect to the same server and login; any other endpoint ends them.
            let same_server = slot.link.as_ref().is_some_and(|old| old.same_endpoint(&link));
            (std::mem::replace(&mut slot.link, Some(link)), same_server)
        };
        // The helper channel belongs to the link it was opened with, so a new link starts without one.
        crate::workspace_backend::reset();
        if !same_server {
            crate::pty::kill_ssh_terminals();
        }
        if let Some(previous) = previous {
            previous.stop();
        }
        let mut s = lock(&self.inner.status);
        s.state = Phase::Ssh;
        s.error = None;
        s.error_code = None;
    }

    /// Stops and drops the attached link, and records that the user ended it, so the status reads `stopped`. The
    /// server core keeps running: that is the point of SSH mode.
    pub fn detach_ssh_link(&self) {
        let link = {
            let mut slot = lock(&self.inner.ssh_link);
            slot.disconnected = true;
            slot.link.take()
        };
        // The helper channel dies with its link: its folder and any running search or watch go with it. So do the SSH
        // terminals, whose ssh processes are logged in to the same server.
        crate::workspace_backend::reset();
        crate::pty::kill_ssh_terminals();
        if let Some(link) = link {
            link.stop();
        }
    }

    /// The known_hosts file the attached link reads, for tests that check the folder's lifetime.
    #[cfg(test)]
    pub(crate) fn attached_known_hosts(&self) -> Option<PathBuf> {
        lock(&self.inner.ssh_link).link.as_ref().and_then(SshLink::known_hosts_file)
    }

    fn set_connecting(&self, connecting: bool) {
        lock(&self.inner.ssh_link).connecting = connecting;
    }

    /// Where SSH mode gets its link. The SSH connect flow installs the production connector; tests inject fakes.
    pub fn set_ssh_connector(&self, connector: SshConnector) {
        *lock(&self.inner.ssh_connector) = connector;
    }

    fn ssh_link_is_live(&self) -> bool {
        matches!(lock(&self.inner.ssh_link).link.as_ref().map(SshLink::state), Some(LinkState::Connected | LinkState::Reconnecting { .. }))
    }

    fn ssh_startup_running(&self) -> bool {
        lock(&self.inner.startup).as_ref().is_some_and(|handle| !handle.is_finished())
    }

    fn is_closing(&self) -> bool {
        lock(&self.inner.status).closing
    }

    /// Stop the child tree we spawned (never an adopted server). Idempotent, blocks up
    /// to the term grace. A pending restart is cancelled.
    pub fn shutdown(&self) {
        if let Some(p) = lock(&self.inner.remote_proxy).take() { p.stop(); }
        self.detach_ssh_link();
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
        // try_lock as above: the panic may have been raised while this slot is held on this thread.
        if let Ok(mut slot) = self.inner.ssh_link.try_lock() {
            let link = slot.link.take();
            drop(slot);
            if let Some(link) = link {
                link.stop();
            }
        }
        // `closing` is set, so no supervisor will move the phase again. A phase that still claims Starting or
        // Restarting (no child existed at this instant) would make the guard in `start()` ignore every later Start.
        if let Ok(mut s) = self.inner.status.try_lock() {
            if killed || matches!(s.state, Phase::Starting | Phase::Restarting) {
                s.state = Phase::Failed;
                s.pid = None;
                s.nonce = None;
                s.restart_at = None;
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
        // Same trust a user Stop leaves: an SSH core is never one this app spawned.
        let ssh = self.mode() == ServerMode::Ssh;
        let mut s = lock(&self.inner.status);
        s.closing = true;
        s.state = Phase::Stopped;
        s.trust = if ssh { "ssh_forward" } else { "spawned" };
        s.pid = None;
        s.nonce = None;
        s.error = None;
        s.fatal = false;
        s.restart_at = None;
    }

    /// Stop the core the user sees (never an adopted server). Blocks until the supervisor has ended so a following
    /// Start cannot race it. The app keeps running; Settings offers Start.
    pub fn stop(&self) -> Result<(), String> {
        let _lifecycle = lock(&self.inner.lifecycle);
        self.shutdown();
        if let Some(handle) = lock(&self.inner.startup).take() {
            let _ = handle.join();
        }
        // After the join: a connect that was in flight when Stop was pressed may have attached a link meanwhile.
        self.detach_ssh_link();
        // The startup thread has finished, so no connect can still be in flight; a stop must not leave the
        // connect flag set, or the status would keep reading `connecting` after the stop.
        lock(&self.inner.ssh_link).connecting = false;
        let ssh = self.mode() == ServerMode::Ssh;
        let mut s = lock(&self.inner.status);
        // A stopped own core is still the app's core: reporting "unverified" would show a false trust warning.
        // An adopted external server keeps its (unverified) identity. An SSH core is never one this app spawned,
        // so its trust stays `ssh_forward`.
        if !s.adopted && !ssh {
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
        let _lifecycle = lock(&self.inner.lifecycle);
        if self.mode() == ServerMode::Ssh {
            return self.start_ssh();
        }
        if self.mode() == ServerMode::Remote {
            let s = lock(&self.inner.status);
            if matches!(s.state, Phase::Starting | Phase::Remote) { return Ok(()); }
            drop(s);
            *lock(&self.inner.run_prefs) = Some((self.inner.prefs_source)());
            // Bound first: a guard in the argument would stay locked while `start_in_background` locks the same mutex.
            let data_dir = lock(&self.inner.data_dir).clone();
            self.start_in_background(data_dir);
            return Ok(());
        }
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
        // A user asked for this start, so it is the point where Settings changes ("Restart the core to apply")
        // are picked up.
        *lock(&self.inner.run_prefs) = Some((self.inner.prefs_source)());
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

    /// A user Start in SSH mode. Like Remote it re-reads the saved settings; it does nothing while a link is live
    /// or a connect is already running, so two quick Starts never race two connects.
    fn start_ssh(&self) -> Result<(), String> {
        if self.ssh_link_is_live() || self.ssh_startup_running() {
            return Ok(());
        }
        if let Some(handle) = lock(&self.inner.startup).take() {
            let _ = handle.join();
        }
        // A Stop sets `closing`; a Start after it must clear that, or the connect below would be thrown away.
        lock(&self.inner.status).closing = false;
        *lock(&self.inner.run_prefs) = Some((self.inner.prefs_source)());
        // Bound first: a guard in the argument would stay locked while `start_in_background` locks the same mutex.
        let data_dir = lock(&self.inner.data_dir).clone();
        self.start_in_background(data_dir);
        Ok(())
    }

    /// SSH mode's startup. It spawns nothing and never probes or adopts a local core: the server core is
    /// reached through a forward. Password auth waits for the user; key auth connects here, on the startup thread.
    fn run_ssh_startup(&self) {
        let cfg = self.run_prefs().remote_server;
        let key_auth = cfg.ssh_auth == SshAuthKind::Key;
        // A link left from an earlier run is dead or stale, so this run starts with nothing attached. This is not a
        // user Disconnect, so the flag is cleared. The connect flag is set before the phase changes, so a status
        // read never shows the connect window as `failed`.
        let stale = {
            let mut slot = lock(&self.inner.ssh_link);
            slot.disconnected = false;
            slot.connecting = key_auth;
            slot.link.take()
        };
        if let Some(stale) = stale {
            stale.stop();
        }
        {
            let mut s = lock(&self.inner.status);
            s.state = Phase::Ssh;
            s.trust = "ssh_forward";
            s.url = String::new();
            s.error = None;
            s.error_code = None;
        }
        if !key_auth {
            return;
        }
        let connector = lock(&self.inner.ssh_connector).clone();
        match connector(&cfg) {
            // A Stop arrived while connecting: the link is dropped here, not attached to a host nobody is using.
            Ok(link) if self.is_closing() => {
                self.set_connecting(false);
                link.stop();
            }
            // attach clears the connecting flag in the same lock that stores the link.
            Ok(link) => self.attach_ssh_link(link),
            Err(e) => self.set_ssh_failed(e.message),
        }
    }

    fn set_ssh_failed(&self, message: String) {
        {
            let mut s = lock(&self.inner.status);
            s.state = Phase::Ssh;
            s.error = Some(message);
            s.error_code = Some("SSH_UNAVAILABLE");
        }
        self.set_connecting(false);
    }

    fn run_startup(&self) {
        if self.mode() == ServerMode::Ssh {
            return self.run_ssh_startup();
        }
        let started = Instant::now();
        let t = &self.inner.tuning;
        if self.mode() == ServerMode::Remote {
            let cfg = self.run_prefs().remote_server;
            let result = if cfg.hub_url.trim().is_empty() {
                Err(crate::fs_ops::FsError { code: "REMOTE_NOT_CONFIGURED", message: "connect to a hub URL before switching to remote mode".into() })
            } else {
                crate::remote_proxy::start(&cfg.hub_url, &cfg.tls_pin)
            };
            let mut s = lock(&self.inner.status);
            match result {
                Ok(handle) => {
                    s.state = Phase::Remote;
                    s.url = handle.url.clone();
                    s.trust = "remote_pinned";
                    s.error = None;
                    *lock(&self.inner.remote_proxy) = Some(handle);
                }
                Err(e) => {
                    s.state = Phase::Failed;
                    s.trust = "remote_pinned";
                    s.error = Some(e.message);
                    s.error_code = Some("REMOTE_UNAVAILABLE");
                }
            }
            return;
        }

        // A core left behind by a force-quit app notices within half a second that its host is gone and shuts down
        // (extension/core/parent-watch.mjs). An app relaunched straight after the force quit would still find it
        // answering: it would then keep its own core off the usual port for the whole session (the browser extension
        // expects that port), or, in a dev build, adopt a core that is about to exit. So a healthy answer is believed
        // only if it is still there after a short wait. A core someone really runs there costs this wait once.
        let live_healthy = still_healthy_after(ORPHAN_SETTLE, Duration::from_millis(150), || matches!(probe(t.live_port, PROBE_TIMEOUT), Probe::Healthy { .. }));
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
        // One automatic retry for a first start that was merely slow (first launch scanning by Gatekeeper, a
        // boot migration, a swapping machine): the core was alive, so a second spawn is not a retry loop.
        let mut retried = false;
        // The port our last core held: a restart waits briefly for it rather than moving off :3456.
        let mut held: Option<u16> = None;
        loop {
            let began = if first && !retried { started } else { Instant::now() };
            match self.start_once(&data_dir, began, held) {
                Started::Closed => return,
                Started::TimedOut { .. } if first && !retried => {
                    retried = true;
                    eprintln!("core: first start timed out waiting for /health; retrying once");
                    continue;
                }
                Started::TimedOut { url, error } => {
                    self.set_failed(url, error);
                    if first {
                        return;
                    }
                }
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
        let prefs_now = self.run_prefs();
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
                Attempt::TimedOut { url, error } => return Started::TimedOut { url, error },
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
        // Measured from this spawn, not from the start of the whole startup: probing and an earlier port's
        // failed attempt must not eat into the time this core gets to boot.
        let deadline = Instant::now() + self.inner.tuning.ready_deadline;
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
                return Attempt::TimedOut { url, error: self.failure(msg) };
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    /// Watches the running core: child exit and `/health` carrying our nonce.
    fn supervise(&self, port: u16, nonce: &str) -> Ended {
        let t = &self.inner.tuning;
        let mut last_health = Instant::now();
        let mut last_claude = Instant::now();
        let mut watch = HealthWatch::default();
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
                let outcome = match probe(port, t.health_timeout) {
                    Probe::Healthy { nonce: got } if got.as_deref().is_some_and(|g| ct_eq(g, nonce)) => HealthOutcome::Healthy,
                    // Something else answered with a 200: not our core, never "busy".
                    Probe::Healthy { .. } => HealthOutcome::Dead,
                    // No answer in time: dead if the port refuses, busy if the process still listens.
                    Probe::Down if port_accepts(port, PORT_OPEN_TIMEOUT) => HealthOutcome::Busy,
                    Probe::Down => HealthOutcome::Dead,
                };
                let was_degraded = watch.degraded_since.is_some();
                let hung = watch.record(outcome, Instant::now(), t);
                if !was_degraded && watch.degraded_since.is_some() {
                    eprintln!("core: /health is slow but the core still listens; waiting up to {}s before treating it as hung", t.health_busy_budget.as_secs());
                }
                if hung {
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
            let info = (host.inner.claude_probe)(&data_dir, &host.run_prefs());
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
        let prefs = self.run_prefs();
        let launch = (self.inner.launcher)(&LaunchCtx { prefs: &prefs, port, nonce, data_dir })?;
        lock(&self.inner.literals).extend(launch.secrets);
        let mut cmd = launch.cmd;
        let secrets_line = launch.stdin_secrets;
        // A piped stdin is only for the secrets handoff; dropping our end after the write closes it (the core reads
        // to EOF). No secrets line → the historical null stdin.
        cmd.stdin(if secrets_line.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = ManagedChild::spawn(&mut cmd).map_err(|e| format!("cannot spawn the core: {e}"))?;
        if let Some(line) = secrets_line {
            if let Some(mut stdin) = child.child_mut().stdin.take() {
                use std::io::Write;
                if let Err(e) = stdin.write_all(format!("{line}\n").as_bytes()) {
                    eprintln!("core: could not hand over its secrets on stdin: {e}");
                }
                // `stdin` drops here: the core sees EOF and finishes reading.
            }
        }

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
        let body = fit_log_body(&msg, &body, LOG_FILE_MAX_BYTES);
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

/// 40 lines of up to 8 KB can exceed the file cap, and `write_private_atomic` refuses an oversized body, which
/// would drop exactly the long failures (and the "details are in core.log" pointer). Keep the message line and the
/// END of the output, where the error is.
fn fit_log_body(msg: &str, body: &str, max: usize) -> String {
    if body.len() <= max {
        return body.to_string();
    }
    let marker = "\n[... earlier output truncated ...]\n";
    let budget = max.saturating_sub(msg.len().min(max / 4) + marker.len());
    let mut start = body.len() - budget;
    while !body.is_char_boundary(start) {
        start += 1;
    }
    // Begin on a line boundary when one is near, so the first kept line is whole.
    if let Some(nl) = body[start..].find('\n').filter(|&i| i < 512) {
        start += nl + 1;
    }
    let head: String = msg.chars().take(max / 4).collect();
    format!("{head}{marker}{}", &body[start..])
}

enum Attempt {
    Ready,
    /// The app is shutting down (or the child was taken by shutdown).
    Closed,
    /// Failed with a status set.
    Failed,
    /// This port did not work out; try the next.
    Retry(String),
    /// The child was alive but never answered /health within its own deadline (killed; status NOT yet set).
    TimedOut { url: String, error: String },
}

enum Started {
    Ready { port: u16, nonce: String },
    Closed,
    Failed,
    /// A spawned core stayed alive but never answered /health in time; the failure is not recorded yet so the
    /// caller may retry once.
    TimedOut { url: String, error: String },
}

/// What one `/health` probe of the running core means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HealthOutcome {
    Healthy,
    /// No usable answer and the port refuses connections (or another process answers): the core is gone.
    Dead,
    /// No answer in time but the port still accepts connections: the process is alive and busy.
    Busy,
}

/// Tells a dead core from a busy one: refused/foreign answers count toward `health_fails`; a core that keeps
/// listening is only given up on after `health_busy_budget` of continuous silence.
#[derive(Default)]
struct HealthWatch {
    fails: u32,
    degraded_since: Option<Instant>,
}

impl HealthWatch {
    /// True when the core should be killed as hung.
    fn record(&mut self, outcome: HealthOutcome, now: Instant, t: &Tuning) -> bool {
        match outcome {
            HealthOutcome::Healthy => {
                self.fails = 0;
                self.degraded_since = None;
                false
            }
            HealthOutcome::Dead => {
                self.fails += 1;
                self.fails >= t.health_fails
            }
            HealthOutcome::Busy => {
                self.fails = 0;
                let since = *self.degraded_since.get_or_insert(now);
                now.duration_since(since) >= t.health_busy_budget
            }
        }
    }
}

/// True when something accepts a TCP connection on `port` (a listening process, however slow its handlers).
fn port_accepts(port: u16, timeout: Duration) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, timeout).is_ok()
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
    crate::fsutil::random_hex(32).map_err(|e| format!("cannot generate a launch nonce: {e}"))
}

pub(crate) use crate::fsutil::ct_eq;

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

/// The nonce `/health` echoes on a loopback port, or `None` when nothing healthy answers in time. SSH server mode
/// checks the forwarded port with it, so a port held by some other process is never taken for the server core.
pub(crate) fn health_nonce(port: u16, timeout: Duration) -> Option<String> {
    match probe(port, timeout) {
        Probe::Healthy { nonce } => nonce,
        Probe::Down => None,
    }
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

/// The resource dir recorded at startup, for the SSH server bundle lookup. `None` before `set_resource_dir`.
pub(crate) fn resource_dir() -> Option<PathBuf> {
    RESOURCE_DIR.get().cloned()
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

/// Put the three secrets in ONE JSON line for the child's stdin and mark the handoff. They are never set in the
/// child's environment: a same-user process can read another process's environment (`ps eww`, /proc/<pid>/environ).
fn wire_secrets(cmd: &mut Command, jwt: &str, vault: &str, approval: &str) -> String {
    cmd.env("LLMIDE_SECRETS_STDIN", "1");
    secrets_stdin_payload(jwt, vault, approval)
}

/// The one JSON line the core reads from its stdin, without a trailing newline. The SSH server start
/// sends the same bytes, so both paths hand the core an identical payload.
pub(crate) fn secrets_stdin_payload(jwt: &str, vault: &str, approval: &str) -> String {
    serde_json::json!({ "jwtSecret": jwt, "vaultKey": vault, "hostApprovalKey": approval }).to_string()
}

/// The spawn used in production: the bundled (or repo) node running `server.mjs` with a
/// scrubbed environment, the two secrets, and the data dir. Fails closed without secrets.
fn real_launch(ctx: &LaunchCtx<'_>) -> Result<Launch, String> {
    let p = ctx.prefs.clone();
    let rt = runtime_for(&p)?;
    eprintln!("core: runtime={} node={} root={} port={}", rt.mode, rt.node.display(), rt.root.display(), ctx.port);
    let db_dir = fsutil::private_dir(&ctx.data_dir.join("core"))?;
    // Before the spawn: the core reads its extension pin once at boot, and on :3456 it must echo CORS for our
    // extension only, never any chrome-extension:// origin.
    crate::core_env::pin_extension_ids(&db_dir)?;
    if let Err(e) = migrate_addons(&db_dir) { eprintln!("core: add-on migration failed: {e}"); }
    // After the add-on copy, which reads the same legacy folder. Best effort: a failure only logs.
    match crate::retired_leftovers::remove_mac_rebuild_staging() {
        Ok(true) => eprintln!("core: deleted the retired Mac app's rebuild-staging folder"),
        Ok(false) => {}
        Err(e) => eprintln!("core: leftover cleanup failed: {e}"),
    }
    // Fail closed: no secrets, no sidecar. Values go in the child's env only.
    let secrets = crate::secrets::default_backend()
        .and_then(|b| crate::secrets::load_or_create(b.as_ref()))
        .map_err(|e| e.to_string())?;
    let approval_key = crate::host_approval::key_hex()?;
    let mut cmd = core_command(&rt, &db_dir);
    cmd.arg(rt.root.join("extension").join("server.mjs"))
        .env("LLMIDE_PORT", ctx.port.to_string())
        .env("LLMIDE_CORE_NONCE", ctx.nonce)
        // The core exits by itself when this process is gone (core/parent-watch.mjs). Without it a force quit or a
        // crash here leaves an orphan on unix, and the next launch would start a second writer on the same database.
        .env("LLMIDE_PARENT_PID", std::process::id().to_string())
        // Spawned core only (this is the spawn path): lets the packaged webview call it. Exact origins.
        .env("LLMIDE_CORS_ORIGINS", crate::core_env::spawned_core_cors_origins());
    // Secrets go on the child's stdin, not its environment; the core reads them before config (core/secrets-stdin.mjs).
    let stdin_secrets = wire_secrets(&mut cmd, &secrets.jwt_secret, &secrets.vault_key, &approval_key);
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
        // Origins saved in Settings win; the host env is only the fallback (dev setups started from a shell).
        if key == "LLMIDE_HOST_API_WEB_ORIGINS" && host_env_origins_shadowed(&p) { continue; }
        if let Some(v) = host_api_env(key, std::env::var(key).ok().as_deref()) {
            cmd.env(key, v);
        }
    }
    Ok(Launch { cmd, secrets: vec![secrets.jwt_secret.clone(), secrets.vault_key.clone(), approval_key], stdin_secrets: Some(stdin_secrets) })
}

/// Origins saved in Settings win over the host env's `LLMIDE_HOST_API_WEB_ORIGINS` (which stays the dev fallback).
fn host_env_origins_shadowed(p: &crate::prefs::Prefs) -> bool {
    !p.host_api_web_origins.is_empty()
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


/// The retired Mac app's add-on entries. A plain copy is valid: no JSON stores an absolute path here.
const ADDON_ENTRIES: &[&str] = &[
    "plugins", "extensions", "llm-sources", "llm-sources.json", "llm-sources-state.json",
    "mcp-plugins.json", "mcp-plugins-state.json", "connector-state.json", "plugin-state.json",
    "plugin-sources.json", "extensions-state.json", "extensions-installed.json",
    "skills-sources.json", "skills-sources-state.json",
];

fn copy_tree_no_symlinks(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() { return Ok(()); }
    if meta.is_dir() {
        std::fs::create_dir_all(dst)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_tree_no_symlinks(&e.path(), &dst.join(e.file_name()))?;
        }
    } else if meta.is_file() {
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

/// One-time copy of the retired Mac app's add-ons into `<core>/addons`. The old folder is never
/// modified; a failure leaves no partial `addons` (the core starts on an empty one).
pub(crate) fn migrate_addons_from(core_dir: &Path, support: &Path) -> Result<bool, String> {
    if core_dir.join("addons").exists() {
        return Ok(false);
    }
    let modern = support.join("llm-ide");
    let legacy = support.join("LLM IDE");
    let old = if modern.exists() { modern } else { legacy };
    let present: Vec<&str> = ADDON_ENTRIES.iter().copied().filter(|n| old.join(n).exists()).collect();
    if present.is_empty() { return Ok(false); }
    let tmp = core_dir.join(format!("addons.tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("cannot create the add-on staging folder: {e}"))?;
    let result = (|| -> std::io::Result<()> {
        for name in &present { copy_tree_no_symlinks(&old.join(name), &tmp.join(name))?; }
        std::fs::rename(&tmp, core_dir.join("addons"))?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("cannot copy the old add-ons: {e}"));
    }
    Ok(true)
}

/// The spawn-path wrapper: macOS only, HOME resolved once.
pub(crate) fn migrate_addons(core_dir: &Path) -> Result<bool, String> {
    if fsutil::current_os() != fsutil::Os::Mac || core_dir.join("addons").exists() { return Ok(false); }
    let home = std::env::var("HOME").map(PathBuf::from).ok().filter(|p| p.is_absolute())
        .ok_or("HOME is not set")?;
    migrate_addons_from(core_dir, &home.join("Library").join("Application Support"))
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
        .env("LLMIDE_PLUGIN_DIR", db_dir.join("addons").join("plugins"))
        .current_dir(rt.root.join("extension"));
    cmd
}

/// Module the probe imports: the server's own single resolver for the `claude` CLI.
const CLAUDE_PROBE_JS: &str = "import { resolveClaudeExecutable, CLAUDE_INSTALL_MESSAGE } from './providers/claude-path.mjs';\n\
const r = resolveClaudeExecutable({ purpose: 'sdk' });\n\
process.stdout.write('\\nLLMIDE_CLAUDE_PROBE ' + JSON.stringify({ found: Boolean(r.path), source: r.source, message: CLAUDE_INSTALL_MESSAGE }) + '\\n');\n";

/// Runs the server's own `claude-path.mjs` under the core's node and environment, so the
/// answer is exactly what the engine will find. Any failure is `unknown`, never `missing`.
fn real_claude_probe(data_dir: &Path, prefs: &crate::prefs::Prefs) -> ClaudeInfo {
    let Ok(rt) = runtime_for(prefs) else { return ClaudeInfo::unknown() };
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
#[path = "core_host_tests.rs"]
pub(crate) mod tests;
