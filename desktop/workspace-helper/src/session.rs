//! Per-connection state: the open folder, its watcher and the search registry, and the folder rules that apply
//! before any folder is open (`~` expansion, the home-folder confinement, folder listing and creation).
//!
//! The helper runs as the SSH user. Every path the desktop names is resolved here against that user's home, so a
//! request cannot reach outside it, even through a symlink.

use std::fs;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use llmide_workspace_core::git::git_binary;
use llmide_workspace_core::paths::checked_root;
use llmide_workspace_core::project::layout;
use llmide_workspace_core::project::clone::{self, CloneRequest, Token};
use llmide_workspace_core::search::{self, Query, Searches};
use llmide_workspace_core::trash::{OsTrash, Trasher};
use llmide_workspace_core::watch::{WatchBatch, WatchSlot};
use llmide_workspace_core::{err, io_err, FsError, R};
use serde::Serialize;
use serde_json::{json, Value};

use crate::clone_credential::{self, RedeemError, RedeemFiles};
use crate::project_setup;
use crate::protocol::{event, Out, PROTOCOL};
use llmide_workspace_core::wire::{CloneEvent, CloneStarted, MadeDir, Hello, Opened, BUSY_CODE};

/// The code and text for a folder that was open but is gone. The desktop matches the code, so both are fixed.
pub use llmide_workspace_core::wire::{ROOT_MISSING_CODE, ROOT_MISSING_MESSAGE};

/// The text the desktop shows when the server has no git. Fixed, because the app shows it as is.
pub const GIT_MISSING_MESSAGE: &str = "git is not installed on the server.";

/// The message of a clone that ran without the saved token because the redeem failed, and was then refused. It tells
/// the person what to do, and names no token, grant or git text.
pub const SAVED_TOKEN_REFUSED_MESSAGE: &str = "The saved token could not be used; paste a token to clone a private repository.";

/// The grant text that makes `resolve_token` panic in tests. It exists only in test builds.
#[cfg(test)]
pub const PANIC_GRANT_FOR_TEST: &str = "grant_PANIC_SEAM";

/// The message of a clone whose thread panicked. The panic text is never sent, since it could name a path or a value.
const CLONE_INTERNAL_MESSAGE: &str = "the clone stopped unexpectedly on the server";

/// The one clone the helper runs at a time. The slot holds the running clone's id and cancel flag. Ids come from a
/// counter, unique per helper process and starting at 1, so a cancel or an event can name the clone it belongs to.
/// The reader cancels a clone directly, so a cancel never waits behind the worker queue, as a search cancel does not.
#[derive(Default)]
pub struct Clones {
    next_id: AtomicU64,
    running: Mutex<Option<(u64, Arc<AtomicBool>)>>,
    ended: Condvar,
}

impl Clones {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claims the slot for a new clone and returns its id and cancel flag. `None` when a clone is already running.
    pub fn begin(&self) -> Option<(u64, Arc<AtomicBool>)> {
        let mut running = lock(&self.running);
        if running.is_some() {
            return None;
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let flag = Arc::new(AtomicBool::new(false));
        *running = Some((id, Arc::clone(&flag)));
        Some((id, flag))
    }

    /// Sends the clone's event with the slot still held, then frees the slot. The send and the release happen under
    /// one lock, so no request can claim the slot while the event is unsent: a `begin` waits, and once it succeeds the
    /// event is already out. A stale `id` (a slot that now belongs to another clone) frees nothing.
    pub fn end(&self, id: u64, announce: impl FnOnce()) {
        let mut running = lock(&self.running);
        announce();
        if running.as_ref().is_some_and(|(held, _)| *held == id) {
            *running = None;
        }
        self.ended.notify_all();
    }

    /// Sets the cancel flag of clone `id` if it is the running one. A stale or unknown id does nothing, so a late
    /// cancel can never stop a newer clone.
    pub fn cancel(&self, id: u64) {
        if let Some((held, flag)) = lock(&self.running).as_ref() {
            if *held == id {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    /// Cancels the running clone and waits until its thread has removed the partial folder and freed the slot. Used
    /// at end of input, so the process never exits in the middle of a clone.
    pub fn stop_and_wait(&self) {
        let mut running = lock(&self.running);
        if let Some((_, flag)) = running.as_ref() {
            flag.store(true, Ordering::SeqCst);
        }
        while running.is_some() {
            running = self.ended.wait(running).unwrap_or_else(|p| p.into_inner());
        }
    }
}

impl Clones {
    /// Cancels the running clone and waits, for a short bound, until its partial folder is removed and the slot is
    /// freed. Called when the helper is about to exit on a failed write, so git does not outlive the process.
    /// It never blocks on the slot's lock when that lock is held: a clone's own `end` can be the failing write, and
    /// then the clone has already finished, so this returns at once.
    pub fn stop_for_exit(&self) {
        let mut running = match self.running.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return,
        };
        let Some((_, flag)) = running.as_ref() else { return };
        flag.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + EXIT_WAIT;
        while running.is_some() {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else { break };
            running = match self.ended.wait_timeout(running, left) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

/// How long the exit path waits for a cancelled clone to remove its folder. A clone that is still going after this
/// is left as it is, and the process exits anyway.
const EXIT_WAIT: Duration = Duration::from_secs(5);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

pub struct Session {
    pub out: Arc<Out>,
    pub searches: Arc<Searches>,
    pub clones: Arc<Clones>,
    /// Where the clone's `git` comes from. The helper uses the core lookup; tests replace it with a fake or with none.
    pub(crate) git_lookup: Box<dyn Fn() -> Option<PathBuf>>,
    trasher: Box<dyn Trasher>,
    root: Option<PathBuf>,
    watch: WatchSlot,
}

/// Encodes an event payload. The core's event types always encode, so the fallback is only a guard against a panic.
pub fn encode<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// Serialises a result the core returned. A failure here is a bug in a result type, not the caller's fault.
pub fn to_value<T: Serialize>(value: &T) -> R<Value> {
    serde_json::to_value(value).map_err(|e| FsError { code: "internal", message: format!("cannot encode the result: {e}") })
}

impl Session {
    pub fn new(out: Arc<Out>, searches: Arc<Searches>, clones: Arc<Clones>) -> Self {
        Self::with_trasher(out, searches, clones, Box::new(OsTrash))
    }

    /// The trash is injected so tests never move anything into a real Trash.
    pub fn with_trasher(out: Arc<Out>, searches: Arc<Searches>, clones: Arc<Clones>, trasher: Box<dyn Trasher>) -> Self {
        Self { out, searches, clones, git_lookup: Box::new(git_binary), trasher, root: None, watch: WatchSlot::new() }
    }

    pub fn trasher(&self) -> &dyn Trasher {
        self.trasher.as_ref()
    }

    /// The open folder, re-validated on every call the way the desktop's `active_root` does: a folder deleted or
    /// renamed on the server fails here with the core's error, and the desktop returns to the server home.
    pub fn root(&self) -> R<PathBuf> {
        match &self.root {
            None => err("no_project", "no project is open"),
            // A folder deleted or renamed on the server (or replaced by a file) gets its own code, so the app can
            // return to the server home with the message it shows, instead of an I/O error.
            Some(root) => match fs::canonicalize(root) {
                Ok(real) if real.is_dir() => confined(checked_root(&real)?),
                Ok(_) => err(ROOT_MISSING_CODE, ROOT_MISSING_MESSAGE),
                // Only "gone" and "no longer a folder" mean the folder is missing. Any other failure (a permission
                // change, a flaky mount) is reported as such, so the app keeps the folder and its unsaved work.
                Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) => {
                    err(ROOT_MISSING_CODE, ROOT_MISSING_MESSAGE)
                }
                Err(e) => Err(io_err("cannot read the folder", e)),
            },
        }
    }

    pub fn hello(&self) -> Value {
        encode(&Hello { git: git_runs(), protocol: PROTOCOL, version: env!("CARGO_PKG_VERSION").into() })
    }

    /// Opens a folder. Replaces the open one, and stops its watcher and any running search, which belong to it.
    pub fn open(&mut self, raw: &str) -> R<Value> {
        let real = home_path(raw)?;
        let root = confined(checked_root(&real)?)?;
        self.stop_folder_work();
        let name = root.file_name().map_or_else(|| root.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned());
        let reply = encode(&Opened { name, root: root.to_string_lossy().into_owned() });
        self.root = Some(root);
        Ok(reply)
    }

    /// Lists the folders (not files) in a folder under the home. A symlinked folder is marked `isLink`, and
    /// `outsideHome` when it points outside the home, where it can be seen but not opened.
    pub fn list_dirs(&self, raw: &str, hidden: bool) -> R<Value> {
        let dir = home_path(raw)?;
        if !dir.is_dir() {
            return err("not_a_directory", "not a folder");
        }
        let home = home_root()?;
        let mut rows: Vec<(String, bool, bool)> = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| io_err("cannot read the folder", e))?.flatten() {
            // A name that is not UTF-8 cannot travel in a JSON string, so it is left out rather than mangled.
            let Ok(name) = entry.file_name().into_string() else { continue };
            if !hidden && name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let is_link = fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink());
            // A dangling link resolves to nothing, so it is not a folder and is left out.
            let Ok(target) = fs::canonicalize(&path) else { continue };
            if !target.is_dir() {
                continue;
            }
            rows.push((name, is_link, !target.starts_with(&home)));
        }
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        let entries: Vec<Value> = rows
            .into_iter()
            .map(|(name, is_link, outside)| json!({"name": name, "isLink": is_link, "outsideHome": outside}))
            .collect();
        Ok(json!({"path": dir.to_string_lossy(), "entries": entries}))
    }

    /// Creates one folder inside a folder under the home. The name is one path component, never a path.
    pub fn mkdir(&self, raw: &str, name: &str) -> R<Value> {
        validate_folder_name(name)?;
        let parent = home_path(raw)?;
        if !parent.is_dir() {
            return err("not_a_directory", "not a folder");
        }
        let made = parent.join(name);
        fs::create_dir(&made).map_err(|e| io_err("cannot create the folder", e))?;
        Ok(encode(&MadeDir { path: made.to_string_lossy().into_owned() }))
    }

    /// Starts watching the open folder. Batches are pushed as `watch` events; a second start replaces the first.
    pub fn watch_start(&mut self) -> R<Value> {
        let root = self.root()?;
        let out = Arc::clone(&self.out);
        let started = self.watch.start(&root, false, Box::new(move |batch: WatchBatch| {
            out.send(&event("watch", encode(&batch)));
        }))?;
        to_value(&started)
    }

    pub fn watch_set(&mut self, dirs: &[String]) -> R<Value> {
        self.watch.set_dirs(dirs).map(|()| Value::Null)
    }

    pub fn watch_stop(&mut self) -> Value {
        self.watch.stop();
        Value::Null
    }

    /// Validates the query, cancels the running search and starts this one on its own thread. Events go out as
    /// `search` events, and the last one is always `done` for this id, even after a late error or a panic.
    pub fn search_start(&mut self, query: Query) -> R<Value> {
        let root = self.root()?;
        let out = Arc::clone(&self.out);
        search::spawn(
            Arc::clone(&self.searches),
            root,
            query,
            move |ev| out.send(&event("search", encode(&ev))),
            |job| {
                std::thread::spawn(job);
            },
        )
        .and_then(|started| to_value(&started))
    }

    /// Starts a clone into the open project's `code/` folder on its own thread and returns at once. The outcome
    /// arrives as a `clone` event. Refused before anything starts: no open folder, a folder that is not a project
    /// (a clone never makes `code/` in a plain folder), no git, an invalid request, or a clone already running.
    pub fn clone_start(&mut self, req: CloneRequest) -> R<Value> {
        let root = self.root()?;
        if !layout::is_project(&root) {
            return err("not_a_project", project_setup::NOT_A_PROJECT_MESSAGE);
        }
        let Some(git) = (self.git_lookup)() else {
            return err("git_missing", GIT_MISSING_MESSAGE);
        };
        let plan = clone::plan(&root, &req).map_err(|message| FsError { code: "clone_refused", message })?;
        let Some((id, cancel)) = self.clones.begin() else {
            return err(BUSY_CODE, "a clone is already running on the server");
        };
        let typed = req.token.clone();
        let grant = req.grant.clone();
        let files = default_redeem_files();
        let out = Arc::clone(&self.out);
        let clones = Arc::clone(&self.clones);
        let release = Arc::clone(&self.clones);
        let started = std::thread::Builder::new().name("repo-clone".into()).spawn(move || {
            // The redeem runs here, not before the reply, so the started answer is not held up by it. It is inside
            // the same guard as the clone, so a panic in either still sends the event and frees the slot.
            let ran = catch_unwind(AssertUnwindSafe(|| {
                let (token, redeem_failed) = resolve_token(typed, grant, files.as_ref());
                clone::run(&plan, token.as_ref(), &cancel, &git).map_err(|message| refused_message(message, redeem_failed))
            }));
            let data = match ran {
                Ok(Ok(done)) => encode(&CloneEvent::done(id, done.path, done.name)),
                Ok(Err(message)) => clone_failure(id, &message),
                Err(_) => encode(&CloneEvent::failed(id, "internal", CLONE_INTERNAL_MESSAGE)),
            };
            clones.end(id, || {
                out.send(&event("clone", data));
            });
        });
        if started.is_err() {
            // The thread never ran, so nothing else will free the slot; without this every later clone would be busy.
            release.end(id, || {});
            return err("internal", "the helper could not start the clone");
        }
        Ok(encode(&CloneStarted { id, started: true }))
    }

    /// Stops the watcher, any running clone and any running search, and waits for them to wind down. Used at end of
    /// input, so the process never exits with a partial clone folder behind.
    pub fn shutdown(&mut self) {
        self.clones.stop_and_wait();
        self.stop_folder_work();
        // `begin` cancels the current search; taking the run lock then waits until its scan has stopped.
        let _ = self.searches.begin();
        drop(self.searches.run_lock());
    }

    fn stop_folder_work(&mut self) {
        self.watch.stop();
        // A new id cancels the search that belongs to the previous folder.
        let _ = self.searches.begin();
    }
}

/// The token a clone runs with, and whether a grant was given but could not be redeemed. A usable typed token always
/// wins and no grant is redeemed then. A blank or unusable typed token does not count as one, so the grant is used.
/// Without a usable typed token, the grant is redeemed on the server core over loopback.
fn resolve_token(typed: Option<Token>, grant: Option<Token>, files: Option<&RedeemFiles>) -> (Option<Token>, bool) {
    // Test seam: a grant with this text makes the redeem panic, to prove the clone guard still reports and frees.
    #[cfg(test)]
    if grant.as_ref().is_some_and(|g| g.expose() == PANIC_GRANT_FOR_TEST) {
        panic!("injected panic in resolve_token");
    }
    if typed.as_ref().is_some_and(Token::is_usable) {
        return (typed, false);
    }
    let Some(grant) = grant else { return (None, false) };
    let redeemed = files.ok_or(RedeemError::State).and_then(|files| clone_credential::redeem(files, &grant));
    match redeemed {
        Ok(token) => (Some(token), false),
        Err(_) => (None, true),
    }
}

/// The server core's state and key files under the server user's home. `None` when the home folder is unusable.
fn default_redeem_files() -> Option<RedeemFiles> {
    home_root().ok().map(|home| RedeemFiles::under_home(&home))
}

/// Git's refusal of a clone that ran without the saved token says so in plain words. Any other message is kept.
fn refused_message(message: String, redeem_failed: bool) -> String {
    if redeem_failed && clone::is_auth_failure(&message) {
        SAVED_TOKEN_REFUSED_MESSAGE.to_string()
    } else {
        message
    }
}

/// The `clone` event for a clone that ended with an error. A cancel is its own code, so the desktop can tell a stop
/// the person asked for from a failure. Git's text is the only external text here, and it never carries the token.
fn clone_failure(id: u64, message: &str) -> Value {
    let code = if message == clone::CANCELLED { "cancelled" } else { "clone_failed" };
    encode(&CloneEvent::failed(id, code, message))
}

/// Whether `git --version` runs. The core's git lookup only finds the binary, and the desktop wants to know that
/// the program actually starts, so this runs it once.
pub fn git_runs() -> bool {
    let Some(git) = git_binary() else {
        return false;
    };
    std::process::Command::new(git)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Re-checks an open folder against the home folder. The first check ran when the folder was opened; the folder can
/// be replaced afterwards (a symlink swapped in by the SSH user or a process running as them), and every later
/// request must still resolve inside the home folder.
fn confined(root: PathBuf) -> R<PathBuf> {
    let home = home_root()?;
    if !root.starts_with(&home) {
        return err("outside_home", "the project folder is no longer inside the server user's home folder");
    }
    Ok(root)
}

/// The home folder from `$HOME`, canonical. Unset or unusable is `no_home`: the rules cannot be applied without it.
pub fn home_root() -> R<PathBuf> {
    let raw = std::env::var_os("HOME").filter(|h| !h.is_empty());
    let Some(raw) = raw else {
        return err("no_home", "the server user has no home folder");
    };
    fs::canonicalize(PathBuf::from(raw)).map_err(|_| FsError { code: "no_home", message: "the server user's home folder is not available".into() })
}

/// Resolves a folder the desktop named: `~` and `~/…` against the home folder, must be absolute after that, must
/// exist, and must sit inside the home folder once canonicalised (a symlink out of it is refused here).
pub fn home_path(raw: &str) -> R<PathBuf> {
    reject_control_characters(raw)?;
    let home = home_root()?;
    let expanded = expand_tilde(raw, &home);
    if !expanded.is_absolute() {
        return err("invalid_path", "the folder must be an absolute path or start with ~");
    }
    let real = fs::canonicalize(&expanded).map_err(|e| io_err("folder is not available", e))?;
    if !real.starts_with(&home) {
        return err("outside_home", "the folder is outside the server user's home folder");
    }
    Ok(real)
}

fn expand_tilde(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    match raw.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(raw),
    }
}

/// A newline, a carriage return or a NUL is refused in any path: it would split the protocol line or hide a
/// second path from the person reading the message.
fn reject_control_characters(raw: &str) -> R<()> {
    if raw.contains(['\n', '\r', '\0']) {
        return err("invalid_path", "the path contains a line break or a NUL character");
    }
    Ok(())
}

/// A new folder's name is one component: not empty, not `.` or `..`, and without a separator or control character.
fn validate_folder_name(name: &str) -> R<()> {
    let bad = name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0', '\n', '\r']);
    if bad {
        return err("invalid_path", "that is not a valid folder name");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The slot is held while the event is sent. A claim made during the send waits for it, so it can only succeed
    /// after the event is out.
    #[test]
    fn the_slot_stays_held_until_the_event_is_sent() {
        let clones = Clones::new();
        let (id, _) = clones.begin().expect("the first claim");
        let announced = AtomicBool::new(false);
        let claimed_after_announce = std::thread::scope(|scope| {
            let waiter = scope.spawn(|| loop {
                if clones.begin().is_some() {
                    return announced.load(Ordering::SeqCst);
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            });
            clones.end(id, || {
                std::thread::sleep(std::time::Duration::from_millis(200));
                announced.store(true, Ordering::SeqCst);
            });
            waiter.join().unwrap()
        });
        assert!(claimed_after_announce, "no claim succeeded before the event was sent");
    }

    #[test]
    fn ids_are_unique_and_a_stale_end_frees_nothing() {
        let clones = Clones::new();
        let (first, _) = clones.begin().expect("first");
        assert_eq!(first, 1, "ids start at 1");
        clones.end(first, || {});
        let (second, _) = clones.begin().expect("second");
        assert_eq!(second, 2);
        clones.end(first, || {});
        assert!(clones.begin().is_none(), "ending the old id leaves the new clone's slot held");
        clones.cancel(first);
        clones.end(second, || {});
        assert!(clones.begin().is_some(), "the held slot is freed by its own id");
    }
}
