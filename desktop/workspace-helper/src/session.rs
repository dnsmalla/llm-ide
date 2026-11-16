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
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use llmide_workspace_core::git::git_binary;
use llmide_workspace_core::paths::checked_root;
use llmide_workspace_core::project::layout;
use llmide_workspace_core::project::clone::{self, CloneRequest};
use llmide_workspace_core::search::{aborted_done, run_search, validate, Query, Searches, Started};
use llmide_workspace_core::trash::{OsTrash, Trasher};
use llmide_workspace_core::watch::{Watch, WatchBatch, WatchStarted};
use llmide_workspace_core::{err, io_err, FsError, R};
use serde::Serialize;
use serde_json::{json, Value};

use crate::project_setup;
use crate::protocol::{event, Out, PROTOCOL};

/// The code and text for a folder that was open but is gone. The desktop matches the code, so both are fixed.
pub const ROOT_MISSING_CODE: &str = "root_missing";
pub const ROOT_MISSING_MESSAGE: &str = "This folder is no longer on the server.";

/// The text the desktop shows when the server has no git. Fixed, because the app shows it as is.
pub const GIT_MISSING_MESSAGE: &str = "git is not installed on the server.";

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
    watch: Option<Watch>,
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
        Self { out, searches, clones, git_lookup: Box::new(git_binary), trasher, root: None, watch: None }
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
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": PROTOCOL,
            "git": git_runs(),
        })
    }

    /// Opens a folder. Replaces the open one, and stops its watcher and any running search, which belong to it.
    pub fn open(&mut self, raw: &str) -> R<Value> {
        let real = home_path(raw)?;
        let root = confined(checked_root(&real)?)?;
        self.stop_folder_work();
        let name = root.file_name().map_or_else(|| root.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned());
        let reply = json!({"name": name, "root": root.to_string_lossy()});
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
        Ok(json!({"path": made.to_string_lossy()}))
    }

    /// Starts watching the open folder. Batches are pushed as `watch` events; a second start replaces the first.
    pub fn watch_start(&mut self) -> R<Value> {
        let root = self.root()?;
        let out = Arc::clone(&self.out);
        let (watch, mode) = Watch::start(&root, false, Box::new(move |batch: WatchBatch| {
            out.send(&event("watch", encode(&batch)));
        }))?;
        self.watch = Some(watch);
        to_value(&WatchStarted { mode })
    }

    pub fn watch_set(&mut self, dirs: &[String]) -> R<Value> {
        match self.watch.as_mut() {
            Some(watch) => watch.set_dirs(dirs).map(|()| Value::Null),
            None => err("no_watch", "the file watcher is not running"),
        }
    }

    pub fn watch_stop(&mut self) -> Value {
        self.watch = None;
        Value::Null
    }

    /// Validates the query, cancels the running search and starts this one on its own thread. Events go out as
    /// `search` events, and the last one is always `done` for this id, even after a late error or a panic.
    pub fn search_start(&mut self, query: Query) -> R<Value> {
        let root = self.root()?;
        validate(&query)?;
        let (id, cancel) = self.searches.begin();
        let out = Arc::clone(&self.out);
        let searches = Arc::clone(&self.searches);
        std::thread::spawn(move || {
            let _running = searches.run_lock();
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                out.send(&event("search", encode(&aborted_done(id))));
                searches.finish(id);
                return;
            }
            let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut sink = |ev: llmide_workspace_core::search::SearchEvent| out.send(&event("search", encode(&ev)));
                run_search(&root, &query, id, &cancel, &mut sink)
            }));
            if !matches!(ran, Ok(Ok(()))) {
                out.send(&event("search", encode(&aborted_done(id))));
            }
            searches.finish(id);
        });
        to_value(&Started { id })
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
            return err("busy", "a clone is already running on the server");
        };
        let out = Arc::clone(&self.out);
        let clones = Arc::clone(&self.clones);
        let release = Arc::clone(&self.clones);
        let started = std::thread::Builder::new().name("repo-clone".into()).spawn(move || {
            let ran = catch_unwind(AssertUnwindSafe(|| clone::run(&plan, req.token.as_ref(), &cancel, &git)));
            let data = match ran {
                Ok(Ok(done)) => json!({"id": id, "ok": true, "path": done.path, "name": done.name}),
                Ok(Err(message)) => clone_failure(id, &message),
                Err(_) => json!({"id": id, "ok": false, "code": "internal", "message": CLONE_INTERNAL_MESSAGE}),
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
        Ok(json!({"started": true, "id": id}))
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
        self.watch = None;
        // A new id cancels the search that belongs to the previous folder.
        let _ = self.searches.begin();
    }
}

/// The `clone` event for a clone that ended with an error. A cancel is its own code, so the desktop can tell a stop
/// the person asked for from a failure. Git's text is the only external text here, and it never carries the token.
fn clone_failure(id: u64, message: &str) -> Value {
    let code = if message == clone::CANCELLED { "cancelled" } else { "clone_failed" };
    json!({"id": id, "ok": false, "code": code, "message": message})
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
