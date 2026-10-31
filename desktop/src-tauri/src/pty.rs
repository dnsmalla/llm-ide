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

/// The Terminal feature toggle, read from the host's environment (never the webview).
pub fn terminal_enabled() -> bool {
    feature_enabled(std::env::var("LLMIDE_FEATURES").ok().as_deref(), "terminal")
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Consent {
    Unasked,
    Granted,
    Denied,
}

/// Per-page-load consent. Default deny: nothing runs until `check` has seen a yes, a
/// no is remembered until the page reloads (a page cannot nag with repeat prompts),
/// and `reset` (page load / window close) forgets everything.
pub struct Gate {
    state: Mutex<Consent>,
}

impl Gate {
    pub const fn new() -> Self {
        Gate { state: Mutex::new(Consent::Unasked) }
    }

    pub fn reset(&self) {
        *lock(&self.state) = Consent::Unasked;
    }

    pub fn granted(&self) -> bool {
        *lock(&self.state) == Consent::Granted
    }

    /// True when terminals are allowed; `ask` (the native dialog) runs only while the
    /// state is `Unasked`, and its answer is recorded.
    pub fn check(&self, ask: impl FnOnce() -> bool) -> bool {
        let mut st = lock(&self.state);
        match *st {
            Consent::Granted => true,
            Consent::Denied => false,
            Consent::Unasked => {
                let yes = ask();
                *st = if yes { Consent::Granted } else { Consent::Denied };
                yes
            }
        }
    }
}

static GATE: Gate = Gate::new();

/// Forget consent (new page load, window gone).
pub fn reset_consent() {
    GATE.reset();
}

/// Terminal feature on AND user consent (native dialog on first use per page load).
/// Runs on a blocking thread: the dialog blocks until answered.
pub fn authorize() -> Result<(), String> {
    if !terminal_enabled() {
        return Err("the Terminal feature is disabled".into());
    }
    let allowed = GATE.check(|| {
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title("Allow terminal access?")
            .set_description(
                "LLM-IDE wants to open a terminal: a real shell that runs with all of your \
                 user permissions. Only allow this if you just asked for a terminal.",
            )
            .set_buttons(rfd::MessageButtons::YesNo)
            .show()
            == rfd::MessageDialogResult::Yes
    });
    if allowed {
        Ok(())
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

/// The environment handed to the shell: the host's, minus secrets.
pub fn shell_env(source: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    source.filter(|(k, _)| !is_secret_env(k)).collect()
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

/// `$SHELL`, else zsh (the macOS default).
fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string())
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
pub fn spawn(cols: u16, rows: u16, on_data: Channel<Response>) -> Result<Spawned, String> {
    authorize()?;
    if lock_table().len() >= MAX_SESSIONS {
        return Err(format!("too many terminals (max {MAX_SESSIONS})"));
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell = login_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env_clear();
    for (k, v) in shell_env(std::env::vars()) {
        cmd.env(k, v);
    }
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // A Finder-launched app has no locale; without one, UTF-8 output garbles.
    if std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd.cwd(start_dir());
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("cannot start {shell}: {e}"))?;
    // The parent must not keep the slave open, or the reader never sees EOF.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let session: Shared = Arc::new(Session {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        flow: Arc::new(Flow::new()),
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
    let started = thread::Builder::new()
        .name(format!("pty-read-{id}"))
        .spawn(move || read_loop(id, reader, tx))
        .and_then(|_| {
            thread::Builder::new()
                .name(format!("pty-flush-{id}"))
                .spawn(move || flush_loop(rx, on_data, flow))
        });
    if let Err(e) = started {
        if let Some(s) = lock_table().remove(&id) {
            dispose(&s);
        }
        return Err(format!("cannot start pty threads: {e}"));
    }

    Ok(Spawned {
        id,
        shell: shell_name(&shell),
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
fn flush_loop(rx: mpsc::Receiver<Vec<u8>>, out: Channel<Response>, flow: Arc<Flow>) {
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
                if batch.len() >= FLUSH_BYTES && !send_batch(&out, &mut batch, &flow) {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !send_batch(&out, &mut batch, &flow) {
                    return;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                send_batch(&out, &mut batch, &flow);
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
    if !terminal_enabled() || !GATE.granted() {
        return Err("terminal access was not approved".into());
    }
    let session = get(id)?;
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
    fn shell_env_drops_secrets_and_keeps_the_basics() {
        let src = [
            ("PATH", "/usr/bin"), ("HOME", "/h"), ("SHELL", "/bin/zsh"), ("LANG", "C"), ("SSH_AUTH_SOCK", "/s"),
            ("LLMIDE_JWT_SECRET", "x"), ("LLMIDE_VAULT_KEY", "x"), ("ANTHROPIC_API_KEY", "x"),
            ("OPENAI_API_KEY", "x"), ("GITHUB_TOKEN", "x"), ("DB_PASSWORD", "x"), ("AWS_SECRET_ACCESS_KEY", "x"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let kept: Vec<String> = shell_env(src).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, ["PATH", "HOME", "SHELL", "LANG", "SSH_AUTH_SOCK"]);
    }
}
