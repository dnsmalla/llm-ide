//! Terminal PTYs: spawns the user's login shell, streams its output to the webview
//! in batches over a Tauri `Channel`, and kills every shell (and its foreground job)
//! on app exit, page reload and window destruction.
//!
//! Flow control (credit based): every batch sent adds to the session's `outstanding`
//! byte count; the webview reports bytes xterm has finished parsing via `pty_ack`.
//! Above `HIGH_WATER` the flusher stops sending, the bounded queue fills, the
//! reader blocks and the shell stalls on a full pty buffer, so a flood (`yes`) pauses
//! instead of overrunning xterm's write buffer and dropping bytes.
//!
//! Security: a pty is an unrestricted shell, so everything here is behind a host-side
//! gate (see `Gate`): the Terminal feature must be enabled in the host's own
//! `LLMIDE_FEATURES`, and the user must approve a native confirm dialog (run by the
//! host, default deny) once per page load. The spawned shell's environment is scrubbed
//! of the server's secrets and provider keys, and starts in the active project root.
//!
//! Known limits:
//! - Background `&` jobs run in their own process groups and may be orphaned when a
//!   shell is killed; only the foreground job and the shell's own group are signalled.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, Response};

use crate::confirm::herr;
use crate::fs_ops::FsError;
use crate::ssh_askpass::AskpassGrant;
use crate::ssh_server_scripts::TERMINAL;
use crate::ssh_transport::{exec_args_tty, ssh_child_env, SshEndpoint};

#[cfg(debug_assertions)]
use crate::core_host;

/// A batch is sent as soon as it holds this many bytes...
const FLUSH_BYTES: usize = 16 * 1024;
/// ...or this long after its first byte arrived, whichever comes first.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
/// Size of each read from the pty master.
const READ_CHUNK: usize = 16 * 1024;
/// Read chunks queued between the reader and the flusher. A full queue blocks the
/// reader, which applies backpressure to the shell instead of growing memory.
const QUEUE_DEPTH: usize = 256;
/// Unacknowledged output bytes at which the flusher pauses.
const HIGH_WATER: u64 = 1024 * 1024;
/// Give up on a session whose webview acknowledges nothing for this long (it is
/// gone or hung); the flusher thread then exits instead of leaking.
const ACK_STALL_LIMIT: Duration = Duration::from_secs(60);
/// Concurrent shells allowed; spawning beyond this is an error.
const MAX_SESSIONS: usize = 8;

/// Whether `key` is enabled by an `LLMIDE_FEATURES` value (comma-separated enabled
/// keys; unset or empty means all, same as the Mac app and the server).
pub fn feature_enabled(raw: Option<&str>, key: &str) -> bool {
    match raw.map(str::trim).filter(|v| !v.is_empty()) {
        None => true,
        Some(list) => list.split(',').any(|k| k.trim() == key),
    }
}

/// The Terminal feature toggle: the host's own `LLMIDE_FEATURES` AND the persisted pref as it was at
/// launch (`prefs.json`); never a value the webview supplies per call.
pub fn terminal_enabled() -> bool {
    crate::prefs::terminal_enabled(std::env::var("LLMIDE_FEATURES").ok().as_deref())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Consent {
    Unasked,
    Granted,
    Denied,
}

/// How long one approval lasts for OPENING terminals. After that the next spawn asks again; a shell that was
/// spawned under a valid approval keeps accepting input until it ends (see `Gate::session_epoch`).
pub const GRANT_TTL_MS: u64 = 30 * 60 * 1000;

struct Inner {
    consent: Consent,
    /// When `consent` became `Granted` (ms since the epoch).
    granted_ms: u64,
    /// Bumped by `reset` (page load / window close): an answer to a dialog that was opened for an
    /// older page load is discarded, so a grant can never leak into the next page.
    epoch: u64,
}

/// Per-page-load consent with an expiry. Default deny: nothing runs until `check` has seen a
/// yes, a no is remembered until the page reloads (a page cannot nag with repeat prompts), a
/// yes lasts `GRANT_TTL_MS`, and `reset` (page load / window close) forgets everything.
pub struct Gate {
    state: Mutex<Inner>,
    /// Serialises the native dialog (one at a time) without holding `state` while it is open.
    asking: Mutex<()>,
    /// Re-asks after a refusal: (count, last time). Cleared by `reset`.
    retries: Mutex<(u32, Option<Instant>)>,
}

/// A refusal can be re-asked at most this often, and this many times per page load, so a page
/// cannot turn the native dialog into a nag loop.
const RETRY_GAP: Duration = Duration::from_secs(5);
const RETRY_MAX: u32 = 5;

impl Gate {
    pub const fn new() -> Self {
        Gate { state: Mutex::new(Inner { consent: Consent::Unasked, granted_ms: 0, epoch: 0 }), asking: Mutex::new(()), retries: Mutex::new((0, None)) }
    }

    pub fn reset(&self) {
        let mut st = lock(&self.state);
        st.consent = Consent::Unasked;
        st.epoch += 1;
        drop(st);
        *lock(&self.retries) = (0, None);
    }

    /// Expires a grant that is older than the TTL (back to `Unasked`: the next spawn asks).
    fn expire(st: &mut Inner, now: u64) {
        if st.consent == Consent::Granted && now.saturating_sub(st.granted_ms) >= GRANT_TTL_MS {
            st.consent = Consent::Unasked;
        }
    }

    /// `unasked` / `granted` / `denied`, for the UI's pre-explanation and denied state.
    pub fn label(&self) -> &'static str {
        self.label_at(crate::confirm::now_ms())
    }

    pub fn label_at(&self, now: u64) -> &'static str {
        let mut st = lock(&self.state);
        Self::expire(&mut st, now);
        match st.consent {
            Consent::Unasked => "unasked",
            Consent::Granted => "granted",
            Consent::Denied => "denied",
        }
    }

    /// After a refusal, forgets it so the NEXT spawn asks again (user clicked "Try again").
    /// Rate limited; only valid while denied.
    pub fn retry(&self) -> Result<(), &'static str> {
        let mut st = lock(&self.state);
        if st.consent != Consent::Denied {
            return Err("nothing to retry");
        }
        let mut r = lock(&self.retries);
        if r.0 >= RETRY_MAX {
            return Err("too many attempts; reload the app to try again");
        }
        if r.1.is_some_and(|t| t.elapsed() < RETRY_GAP) {
            return Err("please wait a few seconds before trying again");
        }
        *r = (r.0 + 1, Some(Instant::now()));
        st.consent = Consent::Unasked;
        Ok(())
    }

    /// The current page-load epoch. A session stores the value it was spawned under; consent was given for
    /// that session, so it stays writable after `GRANT_TTL_MS` and is cut off only by `reset`.
    pub fn session_epoch(&self) -> u64 {
        lock(&self.state).epoch
    }

    /// Whether a session spawned under `epoch` may still receive input (no page reload since).
    pub fn session_may_write(&self, epoch: u64) -> bool {
        // A later Deny in the same page load also cuts off the shells that are already open.
        let st = lock(&self.state);
        st.epoch == epoch && st.consent != Consent::Denied
    }

    #[cfg(test)]
    pub fn granted(&self) -> bool {
        self.granted_at(crate::confirm::now_ms())
    }

    #[cfg(test)]
    pub fn granted_at(&self, now: u64) -> bool {
        let mut st = lock(&self.state);
        Self::expire(&mut st, now);
        st.consent == Consent::Granted
    }

    /// True when terminals are allowed; `ask` (the native dialog) runs only while the
    /// state is `Unasked`, and its answer is recorded.
    pub fn check(&self, ask: impl FnOnce() -> bool) -> bool {
        self.check_at(crate::confirm::now_ms(), ask)
    }

    pub fn check_at(&self, now: u64, ask: impl FnOnce() -> bool) -> bool {
        let _one_dialog = lock(&self.asking);
        let epoch = {
            let mut st = lock(&self.state);
            Self::expire(&mut st, now);
            match st.consent {
                Consent::Granted => return true,
                Consent::Denied => return false,
                Consent::Unasked => st.epoch,
            }
        };
        let yes = ask();
        let mut st = lock(&self.state);
        if st.epoch != epoch {
            // The page that was asked about is gone: the answer does not carry over.
            return false;
        }
        if yes {
            st.consent = Consent::Granted;
            st.granted_ms = now;
        } else {
            st.consent = Consent::Denied;
        }
        yes
    }
}

/// Label of the one button that grants terminal access.
pub const TERMINAL_ACCEPT: &str = "Allow terminal";

static GATE: Gate = Gate::new();

/// Forget consent (new page load, window gone).
pub fn reset_consent() {
    GATE.reset();
}

/// Terminal feature on AND user consent (native dialog on first use per page load).
/// Runs on a blocking thread: the dialog blocks until answered.
/// Returns the consent epoch the new session is bound to.
pub fn authorize() -> Result<u64, String> {
    if !terminal_enabled() {
        return Err("the Terminal feature is disabled".into());
    }
    // Read BEFORE asking: a reset during the dialog then yields a stale epoch, which only ever refuses input.
    let epoch = GATE.session_epoch();
    // Cancel-first (the default button, Return key): only an explicit click on "Allow terminal" counts.
    let allowed = GATE.check(|| {
        crate::confirm::ask(
            "Allow terminal access?",
            "LLM-IDE wants to open a terminal: a real shell that runs with all of your user permissions. \
             The approval lets new terminals open for 30 minutes. Only allow this if you just asked for a terminal.",
            TERMINAL_ACCEPT,
            true,
        )
    });
    if allowed {
        Ok(epoch)
    } else {
        Err("terminal access was not approved".into())
    }
}

/// True for variables the shell must not inherit: the server's own configuration,
/// provider credentials, and anything named like a secret.
pub fn is_secret_env(name: &str) -> bool {
    let u = name.to_ascii_uppercase();
    const PREFIXES: [&str; 9] = [
        "LLMIDE_", "MEETNOTES_", "ANTHROPIC_", "CLAUDE_CODE_OAUTH", "OPENAI_", "GEMINI_", "GOOGLE_API",
        "AWS_SECRET", "AWS_SESSION",
    ];
    const WORDS: [&str; 6] = ["SECRET", "TOKEN", "PASSWORD", "PASSWD", "API_KEY", "CREDENTIAL"];
    PREFIXES.iter().any(|p| u.starts_with(p)) || WORDS.iter().any(|w| u.contains(w))
}

/// Variables that change what a program loads or runs at start-up. Never inherited by a child the host spawns.
fn is_loader_or_startup_env(name: &str) -> bool {
    let u = name.to_ascii_uppercase();
    ["DYLD_", "LD_", "GIT_"].iter().any(|p| u.starts_with(p))
        || ["BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "NODE_OPTIONS", "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "IFS", "CDPATH"].contains(&u.as_str())
}

/// For short-lived helper children (the OS link/file opener): the host's environment minus secrets and
/// minus anything that changes what a program loads at start-up.
pub fn scrubbed_env(source: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    source.filter(|(k, _)| !is_secret_env(k) && !is_loader_or_startup_env(k)).collect()
}

/// Exact names a terminal shell inherits (case-insensitive on Windows).
const SHELL_ENV_ALLOW: [&str; 8] = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "COLORTERM", "TMPDIR"];
/// A Windows shell cannot start without these.
const SHELL_ENV_ALLOW_WINDOWS: [&str; 16] = [
    "SYSTEMROOT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMSPEC", "PATHEXT",
    "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "TEMP", "TMP",
];

/// `PATH` with relative, empty and duplicate entries dropped (a `.` or `bin` entry would run a program planted
/// in whatever directory the shell is in).
pub fn sanitize_path(path: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let kept: Vec<std::path::PathBuf> = std::env::split_paths(path).filter(|d| d.is_absolute() && seen.insert(d.clone())).collect();
    std::env::join_paths(kept).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The environment handed to the terminal shell, an ALLOWLIST: `HOME`, `USER`, `LOGNAME`, `SHELL`, a sanitised
/// `PATH`, `LANG`/`LC_*`, `TERM`, `COLORTERM`, `TMPDIR` (plus the few variables a Windows shell cannot start
/// without). Everything else is dropped: server and provider secrets, `SSH_AUTH_SOCK` (the user's loaded
/// keys), proxies, `DYLD_*`/`LD_*` injection, `BASH_ENV`/`ENV`/`ZDOTDIR`/`PROMPT_COMMAND` start-up hooks,
/// `NODE_OPTIONS`, `GIT_*` and whatever else the parent process happened to carry.
pub fn shell_env(source: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    shell_env_for(cfg!(windows), source)
}

pub fn shell_env_for(windows: bool, source: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (k, v) in source {
        let key = if windows { k.to_ascii_uppercase() } else { k.clone() };
        if key == "PATH" {
            let p = sanitize_path(&v);
            if !p.is_empty() {
                out.push((k, p));
            }
        } else if SHELL_ENV_ALLOW.contains(&key.as_str()) || key.starts_with("LC_") || (windows && SHELL_ENV_ALLOW_WINDOWS.contains(&key.as_str())) {
            if !is_secret_env(&k) && !is_loader_or_startup_env(&k) {
                out.push((k, v));
            }
        }
    }
    out
}

/// Result of `spawn`: the session id and the shell's name (basename of its path).
#[derive(Serialize)]
pub struct Spawned {
    pub id: u32,
    pub shell: String,
}

/// Credit counter shared by a session's flusher (adds) and `pty_ack` (subtracts).
struct Flow {
    state: Mutex<FlowState>,
    cv: Condvar,
}

struct FlowState {
    outstanding: u64,
    closed: bool,
}

impl Flow {
    fn new() -> Self {
        Flow {
            state: Mutex::new(FlowState { outstanding: 0, closed: false }),
            cv: Condvar::new(),
        }
    }

    /// Blocks while `outstanding > high`. False when the flow was closed or no ack
    /// arrived for `stall` (the caller stops sending).
    fn wait_below(&self, high: u64, stall: Duration) -> bool {
        let mut st = lock(&self.state);
        let mut last_progress = Instant::now();
        let mut seen = st.outstanding;
        while st.outstanding > high && !st.closed {
            if st.outstanding < seen {
                seen = st.outstanding;
                last_progress = Instant::now();
            }
            let left = stall.saturating_sub(last_progress.elapsed());
            if left.is_zero() {
                return false;
            }
            st = self.cv.wait_timeout(st, left).unwrap_or_else(|e| e.into_inner()).0;
        }
        !st.closed
    }

    fn add(&self, n: u64) {
        lock(&self.state).outstanding += n;
    }

    fn ack(&self, n: u64) {
        let mut st = lock(&self.state);
        st.outstanding = st.outstanding.saturating_sub(n);
        self.cv.notify_all();
    }

    fn close(&self) {
        lock(&self.state).closed = true;
        self.cv.notify_all();
    }
}

/// One shell. Each field has its own lock so I/O never runs under the table lock.
struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    flow: Arc<Flow>,
    /// Consent epoch this shell was spawned under; see `Gate::session_epoch`.
    consent_epoch: u64,
    /// An SSH terminal, whose ssh process belongs to the server link it was opened on.
    remote: bool,
    _grant: Option<AskpassGrant>,
}

type Shared = Arc<Session>;

static SESSIONS: OnceLock<Mutex<HashMap<u32, Shared>>> = OnceLock::new();
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn table() -> &'static Mutex<HashMap<u32, Shared>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_table() -> MutexGuard<'static, HashMap<u32, Shared>> {
    table().lock().unwrap_or_else(|e| e.into_inner())
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The shell to run and its arguments, per OS. Unix: `$SHELL -l` (else zsh on macOS, sh elsewhere,
/// and a non-absolute `$SHELL` is ignored). Windows: Windows PowerShell under `%SystemRoot%`, else
/// `%COMSPEC%`, else cmd.exe; no login flag.
pub fn shell_command(windows: bool, macos: bool, env: &dyn Fn(&str) -> Option<String>) -> (String, Vec<&'static str>) {
    if windows {
        let root = env("SystemRoot").filter(|s| !s.is_empty()).unwrap_or_else(|| "C:\\Windows".to_string());
        let ps = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        if std::path::Path::new(&ps).is_file() {
            return (ps, vec!["-NoLogo"]);
        }
        let cmd = env("COMSPEC").filter(|s| !s.is_empty()).unwrap_or_else(|| format!("{root}\\System32\\cmd.exe"));
        return (cmd, vec![]);
    }
    let fallback = if macos { "/bin/zsh" } else { "/bin/sh" };
    let sh = env("SHELL").filter(|s| s.starts_with('/')).unwrap_or_else(|| fallback.to_string());
    (sh, vec!["-l"])
}

fn login_shell() -> (String, Vec<&'static str>) {
    shell_command(cfg!(windows), cfg!(target_os = "macos"), &|k| std::env::var(k).ok())
}

/// What the Terminal panel shows before anything is spawned.
#[derive(Serialize)]
pub struct Status {
    /// The Terminal feature is on in the host's own `LLMIDE_FEATURES`.
    pub enabled: bool,
    /// `unasked` | `granted` | `denied`.
    pub consent: &'static str,
    /// Basename of the shell that would start.
    pub shell: String,
}

pub fn status() -> Status {
    Status { enabled: terminal_enabled(), consent: GATE.label(), shell: shell_name(&login_shell().0) }
}

/// "Try again" after a refusal: re-arms the consent dialog for the next spawn (rate limited).
pub fn retry_consent() -> Result<Status, String> {
    if !terminal_enabled() {
        return Err("the Terminal feature is disabled".into());
    }
    GATE.retry().map_err(String::from)?;
    Ok(status())
}

/// Active project root when one is open; else `$HOME`, else `/`. The repo root is a
/// dev-build convenience only.
fn start_dir() -> PathBuf {
    if let Some(root) = crate::project::active_root() {
        return root;
    }
    #[cfg(debug_assertions)]
    if let Ok(root) = core_host::repo_root() {
        return root;
    }
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Basename of the shell path, for the tab label.
fn shell_name(shell: &str) -> String {
    Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("shell")
        .to_string()
}

fn get(id: u32) -> Result<Shared, String> {
    lock_table().get(&id).cloned().ok_or_else(|| "no such terminal".to_string())
}

/// Starts `$SHELL -l` in a new pty and returns its id and name. Output is sent to
/// `on_data` as raw bytes (see `Response`): one message per batch.
pub fn spawn(cols: u16, rows: u16, on_data: Channel<Response>, on_exit: Channel<serde_json::Value>) -> Result<Spawned, String> {
    let consent_epoch = authorize()?;
    ensure_capacity()?;
    let (shell, shell_args) = login_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env_clear();
    for (k, v) in shell_env(std::env::vars()) {
        cmd.env(k, v);
    }
    for a in shell_args {
        cmd.arg(a);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // A Finder-launched app has no locale; without one, UTF-8 output garbles.
    if std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd.cwd(start_dir());
    let started = Started { shell: shell_name(&shell), input: Vec::new(), grant: None, consent_epoch, remote: false };
    start(cols, rows, cmd, started, on_data, on_exit)
}

/// Starts an SSH terminal: `ssh -tt` to the server, in the open server folder. It uses the same session table, output
/// channels and cap as a local shell; only the process and what is written to its pty first differ.
pub fn spawn_remote(cols: u16, rows: u16, on_data: Channel<Response>, on_exit: Channel<serde_json::Value>) -> Result<Spawned, String> {
    // The folder is checked before the consent dialog, so a request without one never shows it.
    let folder = crate::workspace_backend::project_info().ok_or_else(|| "no project is open".to_string())?;
    let consent_epoch = authorize()?;
    ensure_capacity()?;
    let helper = crate::core_host::attached_helper_spawn().map_err(|e| e.message)?;
    let launch = remote_terminal_launch(&helper.endpoint, &helper.known_hosts, helper.grant, &folder.root)
        .map_err(|e| e.message)?;
    let mut cmd = CommandBuilder::new(&launch.program);
    cmd.env_clear();
    for (key, value) in launch.env {
        cmd.env(key, value);
    }
    for arg in launch.args {
        cmd.arg(arg);
    }
    let started = Started { shell: launch.shell, input: launch.input, grant: launch.grant, consent_epoch, remote: true };
    start(cols, rows, cmd, started, on_data, on_exit)
}

/// What a new terminal process needs besides its command: the label shown on the tab, the bytes written to its pty
/// before any output is read, the askpass grant that answers its password prompt, and the consent epoch it runs under.
struct Started {
    shell: String,
    input: Vec<u8>,
    grant: Option<AskpassGrant>,
    consent_epoch: u64,
    remote: bool,
}

/// The `ssh` process of one SSH terminal, as data, so the argv, environment and input can be checked without
/// starting ssh. The folder is in `input` only: argv is quoted into the remote command line and is visible to other
/// local processes, and a folder name can hold any character, so it must not be spliced into either.
struct Launch {
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    input: Vec<u8>,
    shell: String,
    grant: Option<AskpassGrant>,
}

fn remote_terminal_launch(ep: &SshEndpoint, known_hosts: &Path, grant: Option<AskpassGrant>, root: &str) -> Result<Launch, FsError> {
    // A line break would end the folder line early, so the script would read a truncated path and then run the rest
    // as input to the shell. An empty folder has nothing to enter.
    if root.is_empty() || root.contains(['\n', '\r', '\0']) {
        return Err(herr("invalid_path", "the folder path cannot be used in a terminal"));
    }
    let args = exec_args_tty(ep, known_hosts, true, TERMINAL);
    let mut env = ssh_child_env(grant.as_ref());
    // The remote shell takes its terminal type from ssh's TERM, so it must be set to what xterm.js can render.
    env.retain(|(key, _)| key != "TERM");
    env.push(("TERM".to_string(), "xterm-256color".to_string()));
    let mut input = root.as_bytes().to_vec();
    input.push(b'\n');
    Ok(Launch { program: "ssh".to_string(), args, env, input, shell: format!("ssh: {}", ep.host), grant })
}

/// Turns the pty's local echo on or off through its slave device.
///
/// Why this is needed for SSH terminals: ssh switches its own local terminal to raw mode only after login, so until
/// then the kernel echoes every byte written to the pty. The remote `stty -echo` changes the server's line discipline,
/// not this one, so the folder line would show on screen without it. The slave is opened only for this call and
/// closed at once; O_NOCTTY keeps it from becoming this process's controlling terminal.
#[cfg(unix)]
fn set_local_echo(tty_path: &Path, on: bool) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(tty_path.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
    // SAFETY: `name` is a valid NUL-terminated path for the duration of the call; the fd is checked before use and closed.
    let fd = unsafe { libc::open(name.as_ptr(), libc::O_RDWR | libc::O_NOCTTY) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `term` is a plain C struct that tcgetattr fills in full before it is read.
    let result = unsafe {
        let mut term: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut term) != 0 {
            Err(std::io::Error::last_os_error())
        } else {
            if on {
                term.c_lflag |= libc::ECHO;
            } else {
                term.c_lflag &= !libc::ECHO;
            }
            if libc::tcsetattr(fd, libc::TCSANOW, &term) != 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    };
    // SAFETY: `fd` was opened above and is closed exactly once.
    unsafe {
        libc::close(fd);
    }
    result
}

/// Whether local echo is on for the pty's slave device. Used by tests to read back what `set_local_echo` did.
#[cfg(all(unix, test))]
fn local_echo_is_on(tty_path: &Path) -> std::io::Result<bool> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(tty_path.as_os_str().as_bytes()).map_err(std::io::Error::other)?;
    // SAFETY: as in `set_local_echo`.
    let fd = unsafe { libc::open(name.as_ptr(), libc::O_RDWR | libc::O_NOCTTY) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: as in `set_local_echo`; `term` is filled by tcgetattr before it is read.
    let result = unsafe {
        let mut term: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut term) != 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(term.c_lflag & libc::ECHO != 0)
        }
    };
    // SAFETY: `fd` was opened above and is closed exactly once.
    unsafe {
        libc::close(fd);
    }
    result
}

/// Whether one more terminal would exceed `MAX_SESSIONS`. Local and SSH terminals share the table, so one cap covers both.
fn capacity_error(count: usize) -> Option<String> {
    (count >= MAX_SESSIONS).then(|| format!("too many terminals (max {MAX_SESSIONS})"))
}

fn ensure_capacity() -> Result<(), String> {
    match capacity_error(lock_table().len()) {
        Some(message) => Err(message),
        None => Ok(()),
    }
}

/// Opens a pty, starts `cmd` in it and registers the session. Shared by the local shell and the SSH terminal.
fn start(cols: u16, rows: u16, cmd: CommandBuilder, started: Started, on_data: Channel<Response>, on_exit: Channel<serde_json::Value>) -> Result<Spawned, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("cannot start {}: {e}", started.shell))?;
    // The parent must not keep the slave open, or the reader never sees EOF.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;
    // Written before the reader thread exists, so no output is forwarded before the folder line is in place.
    // A failed write ends the new process: a terminal that cannot take its folder must not open in the wrong one.
    let mut child = child;
    if !started.input.is_empty() {
        // Ignored on failure: the terminal still works, only the folder line may show once on screen.
        #[cfg(unix)]
        {
            if let Some(path) = pair.master.tty_name() {
                let _ = set_local_echo(&path, false);
            }
        }
        if let Err(e) = writer.write_all(&started.input).and_then(|()| writer.flush()) {
            let _ = child.kill();
            return Err(format!("cannot give the terminal its folder: {e}"));
        }
    }

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let session: Shared = Arc::new(Session {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        flow: Arc::new(Flow::new()),
        consent_epoch: started.consent_epoch,
        remote: started.remote,
        // Held, not read: an SSH terminal's askpass grant must outlive the first password prompt, which ssh may send
        // long after spawn. It is dropped with the session.
        _grant: started.grant,
    });
    let flow = Arc::clone(&session.flow);

    // Insert before any thread starts, so a shell that exits at once always finds
    // its own table entry to retire. The cap is re-checked under the same lock.
    {
        let mut table = lock_table();
        if table.len() >= MAX_SESSIONS {
            drop(table);
            dispose(&session);
            return Err(format!("too many terminals (max {MAX_SESSIONS})"));
        }
        table.insert(id, Arc::clone(&session));
    }

    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(QUEUE_DEPTH);
    let threads = thread::Builder::new()
        .name(format!("pty-read-{id}"))
        .spawn(move || read_loop(id, reader, tx))
        .and_then(|_| {
            thread::Builder::new()
                .name(format!("pty-flush-{id}"))
                .spawn(move || flush_loop(rx, on_data, flow, on_exit))
        });
    if let Err(e) = threads {
        if let Some(s) = lock_table().remove(&id) {
            dispose(&s);
        }
        return Err(format!("cannot start pty threads: {e}"));
    }

    Ok(Spawned {
        id,
        shell: started.shell,
    })
}

/// Reads the master until EOF (shell exited) and then retires the session.
fn read_loop(id: u32, mut reader: Box<dyn Read + Send>, tx: SyncSender<Vec<u8>>) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).is_err() {
                    break; // flusher gone: the webview side is closed
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break, // EIO once the shell has exited
        }
    }
    drop(tx);
    let retired = lock_table().remove(&id);
    if let Some(session) = retired {
        terminate(&session);
    }
}

/// Collects chunks into batches and sends each batch as one raw `Response`
/// (an ArrayBuffer on the JS side). Raw bytes avoid JSON number arrays and base64.
/// When the shell's output has ended (it exited) the final batch is flushed and then `on_exit` fires once,
/// so the tab can say "(exited)" at once instead of on the next write. A webview that is gone or a
/// session that was killed (the flow was closed) simply never receives it.
fn flush_loop(rx: mpsc::Receiver<Vec<u8>>, out: Channel<Response>, flow: Arc<Flow>, on_exit: Channel<serde_json::Value>) {
    flush_until_end(rx, &out, &flow);
    let _ = on_exit.send(serde_json::json!({ "exited": true }));
}

fn flush_until_end(rx: mpsc::Receiver<Vec<u8>>, out: &Channel<Response>, flow: &Flow) {
    let mut batch: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut due = Instant::now();
    loop {
        let received = if batch.is_empty() {
            rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
        } else {
            rx.recv_timeout(due.saturating_duration_since(Instant::now()))
        };
        match received {
            Ok(chunk) => {
                if batch.is_empty() {
                    due = Instant::now() + FLUSH_INTERVAL;
                }
                batch.extend_from_slice(&chunk);
                if batch.len() >= FLUSH_BYTES && !send_batch(out, &mut batch, flow) {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !send_batch(out, &mut batch, flow) {
                    return;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                send_batch(out, &mut batch, flow);
                return;
            }
        }
    }
}

/// Sends the pending batch. False when the channel is closed (the webview is gone).
fn send_batch(out: &Channel<Response>, batch: &mut Vec<u8>, flow: &Flow) -> bool {
    if batch.is_empty() {
        return true;
    }
    // Flow control: wait for the webview to catch up before adding more.
    if !flow.wait_below(HIGH_WATER, ACK_STALL_LIMIT) {
        return false;
    }
    let body = std::mem::replace(batch, Vec::with_capacity(FLUSH_BYTES));
    let n = body.len() as u64;
    flow.add(n);
    out.send(Response::new(body)).is_ok()
}

/// Kills a shell and everything it runs. The shell is a session leader, so its
/// pty foreground job (e.g. `yes | head`) is a separate process group; that group
/// is signalled first (SIGHUP), then the shell (SIGKILL), then its own group.
/// Only signals are sent here; reaping happens on a detached thread, so callers
/// (including the main thread at exit) never block on a child.
fn terminate(session: &Shared) {
    #[cfg(unix)]
    if let Some(fg) = lock(&session.master).process_group_leader() {
        if fg > 0 {
            // SAFETY: killpg only sends a signal; a stale group id just fails with ESRCH.
            unsafe {
                libc::killpg(fg, libc::SIGHUP);
            }
        }
    }
    let pid = {
        let mut child = lock(&session.child);
        let _ = child.kill();
        child.process_id()
    };
    #[cfg(unix)]
    if let Some(pid) = pid {
        // The child is not reaped yet, so its pid (and process group) cannot be reused.
        // SAFETY: as above.
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
    }
    let _ = pid;
    let reaper = Arc::clone(session);
    thread::spawn(move || {
        let _ = lock(&reaper.child).wait();
    });
}

/// `terminate` plus closing the flow so a flusher blocked on acks wakes and exits.
/// Used for explicit kills; a shell that exits by itself is only `terminate`d, so its
/// last output can still drain under flow control.
fn dispose(session: &Shared) {
    session.flow.close();
    terminate(session);
}

/// Credits `bytes` the webview has finished parsing; unknown ids are ignored (the
/// shell may already be gone).
pub fn ack(id: u32, bytes: u64) {
    if let Ok(session) = get(id) {
        session.flow.ack(bytes);
    }
}

/// Writes input bytes to the shell. Runs off the main thread (async command).
pub fn write(id: u32, data: &str) -> Result<(), String> {
    if !terminal_enabled() {
        return Err("terminal access was not approved".into());
    }
    let session = get(id)?;
    // Consent was given for this running session; the 30-minute TTL only gates NEW spawns, so a shell in the
    // middle of vim or a REPL must not go deaf. A page reload (epoch bump) still revokes it.
    if !GATE.session_may_write(session.consent_epoch) {
        return Err("terminal access was not approved".into());
    }
    let mut writer = lock(&session.writer);
    writer
        .write_all(data.as_bytes())
        .and_then(|()| writer.flush())
        .map_err(|e| format!("write failed: {e}"))
}

/// Resizes the pty; the shell receives SIGWINCH.
pub fn resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let session = get(id)?;
    let master = lock(&session.master);
    master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))
}

/// Ends one shell. Unknown ids are an error; a shell that already exited is not.
pub fn kill(id: u32) -> Result<(), String> {
    let session = lock_table().remove(&id).ok_or("no such terminal")?;
    dispose(&session);
    Ok(())
}

/// Ends every SSH terminal and leaves the local shells running. An SSH terminal is an ssh process to a server, so it
/// ends with the link it was opened on: Disconnect, Stop server, Uninstall and a switch to another server all call this.
pub fn kill_ssh_terminals() {
    let sessions: Vec<Shared> = {
        let mut table = lock_table();
        let ids: Vec<u32> = table.iter().filter(|(_, session)| session.remote).map(|(id, _)| *id).collect();
        ids.into_iter().filter_map(|id| table.remove(&id)).collect()
    };
    for session in &sessions {
        dispose(session);
    }
}

/// Kills every shell. Called on app exit, page reload, window destruction and from
/// the signal and panic handlers.
pub fn kill_all() {
    let sessions: Vec<Shared> = lock_table().drain().map(|(_, s)| s).collect();
    for session in &sessions {
        dispose(session);
    }
}

/// `kill_all` for the panic hook: never blocks on the table lock.
pub fn kill_all_from_panic() {
    let Ok(mut table) = table().try_lock() else {
        return;
    };
    let sessions: Vec<Shared> = table.drain().map(|(_, s)| s).collect();
    drop(table);
    for session in &sessions {
        dispose(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn below_high_water_does_not_block() {
        let f = Flow::new();
        f.add(HIGH_WATER);
        assert!(f.wait_below(HIGH_WATER, Duration::from_millis(50)));
    }

    #[test]
    fn blocks_above_high_water_until_acked() {
        let f = Arc::new(Flow::new());
        f.add(HIGH_WATER + 10);
        let released = Arc::new(AtomicBool::new(false));
        let (f2, r2) = (Arc::clone(&f), Arc::clone(&released));
        let t = thread::spawn(move || {
            let ok = f2.wait_below(HIGH_WATER, Duration::from_secs(5));
            r2.store(true, Ordering::SeqCst);
            ok
        });
        thread::sleep(Duration::from_millis(100));
        assert!(!released.load(Ordering::SeqCst), "must stay paused with no ack");
        f.ack(100);
        assert!(t.join().unwrap());
    }

    #[test]
    fn close_releases_a_blocked_sender_with_false() {
        let f = Arc::new(Flow::new());
        f.add(HIGH_WATER * 2);
        let f2 = Arc::clone(&f);
        let t = thread::spawn(move || f2.wait_below(HIGH_WATER, Duration::from_secs(5)));
        thread::sleep(Duration::from_millis(50));
        f.close();
        assert!(!t.join().unwrap());
    }

    #[test]
    fn gives_up_when_nothing_is_acked() {
        let f = Flow::new();
        f.add(HIGH_WATER * 2);
        let start = Instant::now();
        assert!(!f.wait_below(HIGH_WATER, Duration::from_millis(100)));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn ack_never_underflows() {
        let f = Flow::new();
        f.add(5);
        f.ack(50);
        assert_eq!(lock(&f.state).outstanding, 0);
    }

    #[test]
    fn terminal_toggle_follows_llmide_features() {
        assert!(feature_enabled(None, "terminal"));
        assert!(feature_enabled(Some(""), "terminal"));
        assert!(feature_enabled(Some("agent_chat, terminal"), "terminal"));
        assert!(!feature_enabled(Some("agent_chat,file_explorer"), "terminal"));
        assert!(!feature_enabled(Some("terminal_extra"), "terminal"));
    }

    #[test]
    fn gate_defaults_to_deny_and_asks_once() {
        let g = Gate::new();
        assert!(!g.granted(), "nothing runs before consent");
        let mut asked = 0;
        assert!(g.check(|| { asked += 1; true }));
        assert!(g.check(|| { asked += 1; true }));
        assert_eq!(asked, 1);
        assert!(g.granted());
    }

    #[test]
    fn a_grant_expires_after_the_ttl_and_asks_again() {
        let g = Gate::new();
        assert!(g.check_at(1_000, || true));
        assert!(g.granted_at(1_000 + GRANT_TTL_MS - 1));
        assert!(!g.granted_at(1_000 + GRANT_TTL_MS), "expired");
        assert_eq!(g.label_at(1_000 + GRANT_TTL_MS), "unasked");
        let mut asked = 0;
        assert!(g.check_at(1_000 + GRANT_TTL_MS, || { asked += 1; true }), "re-asked after expiry");
        assert_eq!(asked, 1);
    }

    #[test]
    fn an_old_session_keeps_input_after_the_grant_expired_but_a_new_spawn_asks() {
        let g = Gate::new();
        let before = g.session_epoch();
        assert!(g.check_at(1_000, || true));
        let session_epoch = before;
        let later = 1_000 + GRANT_TTL_MS + 5;
        assert!(!g.granted_at(later), "the grant itself expired");
        assert!(g.session_may_write(session_epoch), "the running session still accepts input");
        let mut asked = 0;
        assert!(g.check_at(later, || { asked += 1; true }), "a new spawn asks again");
        assert_eq!(asked, 1);
        g.reset();
        assert!(!g.session_may_write(session_epoch), "a page reload revokes the old session");
    }

    #[test]
    fn an_answer_for_an_older_page_load_is_discarded() {
        let g = Gate::new();
        let yes = g.check_at(1, || {
            g.reset(); // the page reloaded while the dialog was open
            true
        });
        assert!(!yes);
        assert!(!g.granted_at(2), "the grant must not leak into the new page");
        assert_eq!(g.label_at(2), "unasked");
    }

    #[test]
    fn the_terminal_dialog_defaults_to_cancel() {
        let (first, second) = crate::confirm::button_labels(TERMINAL_ACCEPT);
        assert_eq!(first, "Cancel", "the default (first) button must not grant");
        assert_eq!(second, TERMINAL_ACCEPT);
    }

    #[test]
    fn a_refusal_is_sticky_until_reset() {
        let g = Gate::new();
        assert!(!g.check(|| false));
        assert!(!g.check(|| panic!("must not prompt again after a refusal")));
        assert!(!g.granted());
        g.reset();
        assert!(g.check(|| true), "a reload gives a fresh decision");
        g.reset();
        assert!(!g.granted(), "reset revokes");
    }

    #[test]
    fn retry_only_after_a_refusal_and_is_rate_limited() {
        let g = Gate::new();
        assert!(g.retry().is_err(), "nothing to retry before asking");
        assert!(!g.check(|| false));
        assert_eq!(g.label(), "denied");
        assert!(g.retry().is_ok());
        assert_eq!(g.label(), "unasked");
        assert!(g.check(|| true), "the next spawn asks again");
        assert!(g.retry().is_err(), "granted: nothing to retry");
        let g = Gate::new();
        assert!(!g.check(|| false));
        assert!(g.retry().is_ok());
        assert!(!g.check(|| false));
        assert!(g.retry().is_err(), "second retry inside the gap is refused");
        g.reset();
        assert_eq!(g.label(), "unasked");
    }

    fn clear_gap(g: &Gate) {
        let mut r = lock(&g.retries);
        r.1 = None;
    }

    #[test]
    fn retry_count_is_capped_per_page_load() {
        let g = Gate::new();
        for _ in 0..RETRY_MAX {
            assert!(!g.check(|| false));
            clear_gap(&g); // skip the wait in the test
            assert!(g.retry().is_ok());
        }
        assert!(!g.check(|| false));
        clear_gap(&g);
        assert!(g.retry().is_err());
    }

    #[test]
    fn per_os_shell_selection() {
        let e = |m: &'static [(&'static str, &'static str)]| {
            move |k: &str| m.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
        };
        assert_eq!(shell_command(false, true, &e(&[])), ("/bin/zsh".into(), vec!["-l"]));
        assert_eq!(shell_command(false, false, &e(&[])), ("/bin/sh".into(), vec!["-l"]));
        assert_eq!(shell_command(false, true, &e(&[("SHELL", "/opt/homebrew/bin/fish")])).0, "/opt/homebrew/bin/fish");
        assert_eq!(shell_command(false, true, &e(&[("SHELL", "fish")])).0, "/bin/zsh", "a relative $SHELL is ignored");
        let (w, args) = shell_command(true, false, &e(&[("SystemRoot", "C:\\NoSuchWin"), ("COMSPEC", "C:\\x\\cmd.exe")]));
        assert_eq!((w.as_str(), args.len()), ("C:\\x\\cmd.exe", 0), "no PowerShell on disk: COMSPEC, no -l");
    }

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn shell_env_is_an_allowlist() {
        // PATH must be absolute on the host for it to be kept.
        let src = env(&[
            ("PATH", if cfg!(windows) { "C:\\Windows" } else { "/usr/bin" }), ("HOME", "/h"), ("SHELL", "/bin/zsh"), ("LANG", "C"), ("LC_ALL", "C"), ("LC_CTYPE", "UTF-8"), ("TERM", "xterm"),
            ("COLORTERM", "truecolor"), ("TMPDIR", "/t"), ("USER", "a"), ("LOGNAME", "a"),
            // everything below must go
            ("SSH_AUTH_SOCK", "/s"), ("LLMIDE_JWT_SECRET", "x"), ("LLMIDE_VAULT_KEY", "x"), ("ANTHROPIC_API_KEY", "x"),
            ("OPENAI_API_KEY", "x"), ("GITHUB_TOKEN", "x"), ("DB_PASSWORD", "x"), ("AWS_SECRET_ACCESS_KEY", "x"),
            ("DYLD_INSERT_LIBRARIES", "/evil.dylib"), ("DYLD_LIBRARY_PATH", "/x"), ("LD_PRELOAD", "/evil.so"), ("LD_LIBRARY_PATH", "/x"),
            ("BASH_ENV", "/evil.sh"), ("ENV", "/evil.sh"), ("ZDOTDIR", "/evil"), ("PROMPT_COMMAND", "evil"), ("NODE_OPTIONS", "--require /evil.js"),
            ("GIT_SSH_COMMAND", "evil"), ("GIT_CONFIG_GLOBAL", "/evil"), ("HTTP_PROXY", "http://p"), ("XDG_CONFIG_HOME", "/c"), ("EDITOR", "vim"),
            ("PYTHONSTARTUP", "/evil.py"), ("LC_EVIL_SECRET_TOKEN", "x"),
        ]);
        let kept: Vec<String> = shell_env(src.into_iter()).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TMPDIR", "USER", "LOGNAME"]);
    }

    #[test]
    fn shell_path_is_sanitised() {
        // The host's own separator and notion of absolute (`/usr/bin` is relative on Windows).
        if cfg!(windows) {
            assert_eq!(sanitize_path("C:\\Windows;.;bin;;C:\\Windows;D:\\x"), "C:\\Windows;D:\\x");
            assert_eq!(sanitize_path("relative;also\\relative;/rooted"), "");
        } else {
            assert_eq!(sanitize_path("/usr/bin:.:bin::/usr/bin:/opt/x"), "/usr/bin:/opt/x");
            assert_eq!(sanitize_path("relative:also/relative"), "");
        }
        let out = shell_env(env(&[("PATH", ".:rel"), ("HOME", "/h")]).into_iter());
        assert_eq!(out, env(&[("HOME", "/h")]), "a PATH with no absolute entry is not passed at all");
    }

    #[test]
    fn windows_shells_keep_the_variables_they_need_case_insensitively() {
        // `Path` is matched case-insensitively and kept when its entry is absolute on the host.
        let path = if cfg!(windows) { "C:\\Windows" } else { "/usr/bin" };
        let src = env(&[("SystemRoot", "C:\\Windows"), ("ComSpec", "C:\\cmd.exe"), ("Path", path), ("APPDATA", "C:\\a"), ("OPENAI_API_KEY", "x"), ("SSH_AUTH_SOCK", "x")]);
        let kept: Vec<String> = shell_env_for(true, src.into_iter()).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, ["SystemRoot", "ComSpec", "Path", "APPDATA"]);
    }

    #[test]
    fn helper_children_get_the_scrubbed_environment() {
        let src = env(&[("PATH", "/usr/bin"), ("HOME", "/h"), ("DISPLAY", ":0"), ("DBUS_SESSION_BUS_ADDRESS", "u"), ("DYLD_INSERT_LIBRARIES", "x"), ("NODE_OPTIONS", "x"), ("GITHUB_TOKEN", "x"), ("GIT_DIR", "/x")]);
        let kept: Vec<String> = scrubbed_env(src.into_iter()).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, ["PATH", "HOME", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS"], "the opener keeps the desktop-session variables xdg-open needs");
    }

    const KNOWN: &str = "/tmp/llmide-terminal-known-hosts-test";

    fn ssh_endpoint() -> crate::ssh_transport::SshEndpoint {
        crate::ssh_transport::prepare_endpoint("server.example", 22, "alice", crate::ssh_transport::SshAuth::Password)
            .unwrap()
    }

    #[test]
    fn terminal_argv_is_strict_and_constant() {
        let launch = remote_terminal_launch(&ssh_endpoint(), Path::new(KNOWN), None, "/srv/app").unwrap();
        assert_eq!(launch.program, "ssh");
        assert!(launch.args.iter().any(|a| a == "-tt"), "the remote shell needs a pty");
        assert!(launch.args.iter().any(|a| a == "StrictHostKeyChecking=yes"));
        assert!(launch.args.iter().any(|a| a == &format!("UserKnownHostsFile=\"{KNOWN}\"")));
        assert_eq!(launch.args.last().map(String::as_str), Some(TERMINAL), "the remote command is the constant");
        assert_eq!(launch.args[launch.args.len() - 2], "alice@server.example");
        assert!(!launch.args.iter().any(|a| a.contains("/srv/app")), "the folder is never in argv");
    }

    #[test]
    fn terminal_folder_is_data() {
        let folder = "a b'; rm -rf ~";
        let launch = remote_terminal_launch(&ssh_endpoint(), Path::new(KNOWN), None, folder).unwrap();
        assert!(launch.args.iter().all(|a| !a.contains("rm -rf")), "the folder reached argv");
        assert!(launch.env.iter().all(|(k, v)| !k.contains("rm -rf") && !v.contains("rm -rf")), "the folder reached env");
        assert_eq!(launch.input, format!("{folder}\n").into_bytes(), "the folder is written to the pty as one line");
        for bad in ["a\nb", "a\rb", "a\0b", ""] {
            let err = remote_terminal_launch(&ssh_endpoint(), Path::new(KNOWN), None, bad).err().expect("refused");
            assert_eq!(err.code, "invalid_path", "{bad:?}");
        }
    }

    #[test]
    fn terminal_uses_held_password() {
        let link = crate::ssh_link::held_for_test(Some("terminal-test-secret"));
        let grant = link.grant().unwrap().expect("a password link grants");
        let expected = grant.env();
        let launch = remote_terminal_launch(&ssh_endpoint(), Path::new(KNOWN), Some(grant), "/srv/app").unwrap();
        for pair in &expected {
            assert!(launch.env.contains(pair), "{} missing from the ssh environment", pair.0);
        }
        assert!(launch.grant.is_some(), "the grant lives in the launch until the session ends");
        let everything = format!("{:?} {:?}", launch.args, launch.env);
        assert!(!everything.contains("terminal-test-secret"), "the password reached argv or env");
    }

    #[test]
    fn remote_terminal_sets_term_for_the_remote_shell() {
        let launch = remote_terminal_launch(&ssh_endpoint(), Path::new(KNOWN), None, "/srv/app").unwrap();
        assert!(launch.env.contains(&("TERM".to_string(), "xterm-256color".to_string())));
    }

    #[test]
    fn capacity_counts_every_terminal() {
        // Local and SSH terminals share one table, so one cap covers both.
        assert!(capacity_error(MAX_SESSIONS - 1).is_none());
        assert!(capacity_error(MAX_SESSIONS).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn ssh_terminal_turns_local_echo_off_before_the_folder_line() {
        // A real pty pair, no ssh: the folder line written to it must not be echoed by this side's line discipline.
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let path = pair.master.tty_name().expect("a unix pty has a device name");
        assert!(local_echo_is_on(&path).unwrap(), "a new pty echoes by default");
        set_local_echo(&path, false).expect("echo turned off");
        assert!(!local_echo_is_on(&path).unwrap(), "echo must be off for the folder line");
        set_local_echo(&path, true).expect("echo turned back on");
        assert!(local_echo_is_on(&path).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn local_terminal_unchanged() {
        assert_eq!(login_shell().1, vec!["-l"], "the local shell is still a login shell");
    }

    /// Starts `sleep` in a pty as a local or an SSH terminal. No ssh and no consent check are involved.
    #[cfg(unix)]
    fn start_test_process(remote: bool) -> u32 {
        let mut cmd = CommandBuilder::new("/bin/sleep");
        cmd.arg("30");
        let started = Started { shell: "sleep".into(), input: Vec::new(), grant: None, consent_epoch: 0, remote };
        let on_data: Channel<Response> = Channel::new(|_| Ok(()));
        let on_exit: Channel<serde_json::Value> = Channel::new(|_| Ok(()));
        start(80, 24, cmd, started, on_data, on_exit).expect("the test process starts").id
    }

    #[cfg(unix)]
    #[test]
    fn killing_ssh_terminals_leaves_local_ones_running() {
        let local = start_test_process(false);
        let remote = start_test_process(true);
        kill_ssh_terminals();
        assert!(get(remote).is_err(), "the SSH terminal ended with its link");
        assert!(get(local).is_ok(), "a local shell is not part of any server link");
        kill(local).expect("the local test process is still registered");
    }
}
