//! Terminal PTYs: spawns the user's login shell, streams its output to the webview
//! in batches over a Tauri `Channel`, and kills every shell (and its foreground job)
//! on app exit, page reload and window destruction.
//!
//! Known PoC limits (Phase 1 must address these):
//! - No end-to-end flow control: a flood (e.g. `yes`) is sent as fast as the shell
//!   writes; xterm discards input past its write-buffer watermark, so the terminal
//!   can drop bytes instead of pausing the shell.
//! - The pty_* commands are not yet declared in an AppManifest or capability file;
//!   Phase 1 must add the allow-pty-* permissions.
//! - Background `&` jobs run in their own process groups and may be orphaned when a
//!   shell is killed; only the foreground job and the shell's own group are signalled.

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
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
/// Concurrent shells allowed; spawning beyond this is an error.
const MAX_SESSIONS: usize = 8;

/// Result of `spawn`: the session id and the shell's name (basename of its path).
#[derive(Serialize)]
pub struct Spawned {
    pub id: u32,
    pub shell: String,
}

/// One shell. Each field has its own lock so I/O never runs under the table lock.
struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
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

/// Repo root when known, else `$HOME`, else `/`.
fn start_dir() -> PathBuf {
    core_host::repo_root()
        .ok()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"))
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
    });

    // Insert before any thread starts, so a shell that exits at once always finds
    // its own table entry to retire. The cap is re-checked under the same lock.
    {
        let mut table = lock_table();
        if table.len() >= MAX_SESSIONS {
            drop(table);
            terminate(&session);
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
                .spawn(move || flush_loop(rx, on_data))
        });
    if let Err(e) = started {
        if let Some(s) = lock_table().remove(&id) {
            terminate(&s);
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
fn flush_loop(rx: mpsc::Receiver<Vec<u8>>, out: Channel<Response>) {
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
                if batch.len() >= FLUSH_BYTES && !send_batch(&out, &mut batch) {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !send_batch(&out, &mut batch) {
                    return;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                send_batch(&out, &mut batch);
                return;
            }
        }
    }
}

/// Sends the pending batch. False when the channel is closed (the webview is gone).
fn send_batch(out: &Channel<Response>, batch: &mut Vec<u8>) -> bool {
    if batch.is_empty() {
        return true;
    }
    let body = std::mem::replace(batch, Vec::with_capacity(FLUSH_BYTES));
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

/// Writes input bytes to the shell. Runs off the main thread (async command).
pub fn write(id: u32, data: &str) -> Result<(), String> {
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
    terminate(&session);
    Ok(())
}

/// Kills every shell. Called on app exit, page reload, window destruction and from
/// the signal and panic handlers.
pub fn kill_all() {
    let sessions: Vec<Shared> = lock_table().drain().map(|(_, s)| s).collect();
    for session in &sessions {
        terminate(session);
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
        terminate(session);
    }
}
