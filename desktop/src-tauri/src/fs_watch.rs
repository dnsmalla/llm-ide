//! Explorer change notifications for the active project root.
//!
//! Scales to big projects by watching only what the UI shows: the webview sends the set of
//! directories it has expanded or has open files in (`fs_watch_set`, at most `MAX_DIRS`, each
//! validated like any fs path), and each is watched NON-recursively. Nothing recursive means no
//! inotify watch per `node_modules` folder on Linux and no event storm from a build.
//!
//! The webview is never flooded: raw events go through a bounded queue (a full queue sets the
//! `overflow` flag instead of blocking or growing), are debounced (`QUIET_MS` of silence, or
//! `MAX_WAIT_MS` under a constant stream) and coalesced into ONE batch of distinct relative paths,
//! capped at `MAX_PATHS` (beyond that: `overflow`, meaning "refresh everything visible").
//! `node_modules`, `.git` (except `.git/index` and `.git/HEAD`, which drive git status),
//! `target` and the host's own save temp files are never reported.
//!
//! If the OS watcher cannot start (inotify limit, network share), a polling watcher takes over
//! and `mode` says `poll`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Config, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::fs_ops::{resolve_existing, rel_of, FsError, R};

pub const MAX_DIRS: usize = 512;
pub const MAX_PATHS: usize = 2000;
const QUEUE: usize = 4096;
const QUIET_MS: u64 = 150;
const MAX_WAIT_MS: u64 = 500;
const POLL_INTERVAL_MS: u64 = 2000;
const EXCLUDED: [&str; 4] = ["node_modules", ".git", "target", ".DS_Store"];

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct WatchBatch {
    /// Folders (relative, `""` = root) whose listing changed.
    pub dirs: Vec<String>,
    /// Entries (relative) that were created, changed, renamed or removed.
    pub files: Vec<String>,
    /// Too much happened (or the queue filled): treat everything visible as stale.
    pub overflow: bool,
}

/// True for paths the UI must not be told about.
pub fn is_noise(rel: &str) -> bool {
    let segs: Vec<&str> = rel.split('/').collect();
    if let Some(i) = segs.iter().position(|s| *s == ".git") {
        let tail = &segs[i + 1..];
        return !(tail == ["index"] || tail == ["HEAD"]);
    }
    if segs.iter().any(|s| EXCLUDED.contains(s)) {
        return true;
    }
    let name = segs.last().copied().unwrap_or("");
    name.starts_with('.') && name.contains(".llmide-") && name.ends_with(".tmp")
}

/// Accumulates paths until flushed. Pure, so the coalescing rules are unit-tested.
#[derive(Default)]
pub struct Coalescer {
    dirs: HashSet<String>,
    files: HashSet<String>,
    overflow: bool,
}

impl Coalescer {
    pub fn push_rel(&mut self, rel: &str) {
        if rel.is_empty() || is_noise(rel) {
            return;
        }
        if self.files.len() + self.dirs.len() >= MAX_PATHS {
            self.overflow = true;
            return;
        }
        let parent = rel.rsplit_once('/').map_or("", |(p, _)| p);
        self.dirs.insert(parent.to_string());
        self.files.insert(rel.to_string());
    }
    pub fn mark_overflow(&mut self) {
        self.overflow = true;
    }
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && !self.overflow
    }
    pub fn take(&mut self) -> Option<WatchBatch> {
        if self.is_empty() {
            return None;
        }
        let mut dirs: Vec<String> = self.dirs.drain().collect();
        let mut files: Vec<String> = self.files.drain().collect();
        dirs.sort();
        files.sort();
        Some(WatchBatch { dirs, files, overflow: std::mem::take(&mut self.overflow) })
    }
}

pub struct Watch {
    root: PathBuf,
    watcher: Box<dyn Watcher + Send>,
    watched: HashSet<PathBuf>,
    stop: Arc<AtomicBool>,
    pub mode: &'static str,
}

impl Watch {
    /// Starts watching nothing yet; call `set_dirs`. `sink` receives batches on a worker thread.
    pub fn start(root: &Path, force_poll: bool, sink: Box<dyn Fn(WatchBatch) + Send>) -> Result<Watch, String> {
        let (tx, rx) = sync_channel::<notify::Result<notify::Event>>(QUEUE);
        let overflow = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));

        fn handler(tx: SyncSender<notify::Result<notify::Event>>, overflow: Arc<AtomicBool>) -> impl Fn(notify::Result<notify::Event>) + Send + 'static {
            move |res| {
                if tx.try_send(res).is_err() {
                    overflow.store(true, Ordering::Relaxed);
                }
            }
        }
        let poll_cfg = Config::default().with_poll_interval(Duration::from_millis(POLL_INTERVAL_MS));
        let (watcher, mode): (Box<dyn Watcher + Send>, &'static str) = if force_poll {
            (Box::new(PollWatcher::new(handler(tx.clone(), overflow.clone()), poll_cfg).map_err(|e| e.to_string())?), "poll")
        } else {
            match RecommendedWatcher::new(handler(tx.clone(), overflow.clone()), Config::default()) {
                Ok(w) => (Box::new(w), "native"),
                Err(_) => (Box::new(PollWatcher::new(handler(tx, overflow.clone()), poll_cfg).map_err(|e| e.to_string())?), "poll"),
            }
        };

        let worker_root = root.to_path_buf();
        let worker_stop = stop.clone();
        std::thread::Builder::new()
            .name("fs-watch".into())
            .spawn(move || {
                let mut co = Coalescer::default();
                let mut first: Option<Instant> = None;
                loop {
                    if worker_stop.load(Ordering::Relaxed) {
                        return;
                    }
                    let flush = match rx.recv_timeout(Duration::from_millis(QUIET_MS)) {
                        Ok(Ok(ev)) => {
                            if !matches!(ev.kind, EventKind::Access(_)) {
                                for p in &ev.paths {
                                    if let Ok(rel) = p.strip_prefix(&worker_root) {
                                        co.push_rel(&rel_of(Path::new(""), rel));
                                    }
                                }
                            }
                            first.get_or_insert_with(Instant::now);
                            first.is_some_and(|t| t.elapsed() >= Duration::from_millis(MAX_WAIT_MS))
                        }
                        Ok(Err(_)) => {
                            co.mark_overflow();
                            first.get_or_insert_with(Instant::now);
                            false
                        }
                        Err(RecvTimeoutError::Timeout) => true,
                        Err(RecvTimeoutError::Disconnected) => return,
                    };
                    if overflow.swap(false, Ordering::Relaxed) {
                        co.mark_overflow();
                        first.get_or_insert_with(Instant::now);
                    }
                    if flush {
                        if let Some(b) = co.take() {
                            sink(b);
                        }
                        first = None;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Watch { root: root.to_path_buf(), watcher, watched: HashSet::new(), stop, mode })
    }

    /// Replaces the watched folder set (relative paths, `""` = root). Invalid or escaping paths fail the call.
    pub fn set_dirs(&mut self, dirs: &[String]) -> R<()> {
        if dirs.len() > MAX_DIRS {
            return Err(FsError { code: "too_large", message: format!("at most {MAX_DIRS} folders can be watched") });
        }
        let mut want = HashSet::new();
        for d in dirs {
            let abs = resolve_existing(&self.root, d)?;
            if !abs.is_dir() {
                return Err(FsError { code: "not_a_directory", message: "not a folder".into() });
            }
            want.insert(abs);
        }
        for gone in self.watched.difference(&want).cloned().collect::<Vec<_>>() {
            let _ = self.watcher.unwatch(&gone);
            self.watched.remove(&gone);
        }
        for add in want.difference(&self.watched).cloned().collect::<Vec<_>>() {
            // A folder that vanished meanwhile is simply not watched.
            if self.watcher.watch(&add, RecursiveMode::NonRecursive).is_ok() {
                self.watched.insert(add);
            }
        }
        Ok(())
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop();
    }
}

static CURRENT: Mutex<Option<Watch>> = Mutex::new(None);

#[derive(Serialize)]
pub struct WatchStarted {
    pub mode: &'static str,
}

/// Starts (replacing any previous) the watcher for the active root; batches arrive on `on_event`.
#[tauri::command]
pub fn fs_watch_start(on_event: Channel<WatchBatch>) -> R<WatchStarted> {
    let root = crate::fs_ops::active_root()?;
    let w = Watch::start(&root, false, Box::new(move |b| {
        let _ = on_event.send(b);
    }))
    .map_err(|e| FsError { code: "io", message: format!("cannot start the file watcher: {e}") })?;
    let mode = w.mode;
    *CURRENT.lock().map_err(|_| FsError { code: "io", message: "watcher lock poisoned".into() })? = Some(w);
    Ok(WatchStarted { mode })
}

#[tauri::command]
pub fn fs_watch_set(dirs: Vec<String>) -> R<()> {
    let mut g = CURRENT.lock().map_err(|_| FsError { code: "io", message: "watcher lock poisoned".into() })?;
    match g.as_mut() {
        Some(w) => w.set_dirs(&dirs),
        None => Err(FsError { code: "no_watch", message: "the file watcher is not running".into() }),
    }
}

#[tauri::command]
pub fn fs_watch_stop() {
    if let Ok(mut g) = CURRENT.lock() {
        *g = None;
    }
}

/// Called when the project changes or the app quits.
pub fn stop_all() {
    fs_watch_stop();
}

/// Is a watcher installed (for the root that was active when it started)?
#[cfg(test)]
pub(crate) fn running() -> bool {
    CURRENT.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Installs a watcher on `root` with a no-op sink (project tests).
#[cfg(test)]
pub(crate) fn install_for_test(root: &Path) {
    let w = Watch::start(root, true, Box::new(|_| {})).expect("watch");
    *CURRENT.lock().unwrap() = Some(w);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc::channel;

    #[test]
    fn noise_filter() {
        for noisy in ["node_modules/x/y.js", "a/node_modules/b", "target/debug/x", ".git/objects/ab/cd", ".git/refs/heads/main", ".DS_Store", "src/.DS_Store", ".a.txt.llmide-1-0.tmp"] {
            assert!(is_noise(noisy), "{noisy}");
        }
        for fine in ["src/main.rs", ".git/index", ".git/HEAD", ".gitignore", "target.rs", "docs/.env", "a/.git-notes"] {
            assert!(!is_noise(fine), "{fine}");
        }
    }

    #[test]
    fn coalesces_dedups_and_caps() {
        let mut c = Coalescer::default();
        assert!(c.take().is_none());
        for _ in 0..5 {
            c.push_rel("src/a.rs");
        }
        c.push_rel("b.rs");
        c.push_rel("node_modules/x.js");
        let b = c.take().unwrap();
        assert_eq!(b, WatchBatch { dirs: vec!["".into(), "src".into()], files: vec!["b.rs".into(), "src/a.rs".into()], overflow: false });
        assert!(c.take().is_none());
        for i in 0..(MAX_PATHS * 2) {
            c.push_rel(&format!("d{}/f{i}", i % 50));
        }
        let b = c.take().unwrap();
        assert!(b.overflow && b.files.len() + b.dirs.len() <= MAX_PATHS + 1, "{}", b.files.len());
        c.mark_overflow();
        assert!(c.take().unwrap().overflow);
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-watch-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    fn collect(root: &Path, poll: bool, act: impl FnOnce(&Path), wait: Duration) -> Vec<WatchBatch> {
        let (tx, rx) = channel();
        let mut w = Watch::start(root, poll, Box::new(move |b| {
            let _ = tx.send(b);
        }))
        .unwrap();
        w.set_dirs(&["".to_string(), "sub".to_string()]).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        act(root);
        let deadline = Instant::now() + wait;
        let mut out = Vec::new();
        while Instant::now() < deadline {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(200)) {
                let done = b.files.iter().any(|f| f == "sub/file.txt");
                out.push(b);
                if done {
                    break;
                }
            }
        }
        out
    }

    #[test]
    fn real_watcher_reports_changes_and_ignores_noise() {
        let root = scratch("native");
        fs::create_dir(root.join("sub")).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        let batches = collect(&root, false, |r| {
            fs::write(r.join("node_modules/ignored.js"), "x").unwrap();
            fs::write(r.join("sub/file.txt"), "x").unwrap();
        }, Duration::from_secs(10));
        let files: Vec<&String> = batches.iter().flat_map(|b| &b.files).collect();
        assert!(files.iter().any(|f| *f == "sub/file.txt"), "{batches:?}");
        assert!(!files.iter().any(|f| f.contains("node_modules")), "{batches:?}");
        assert!(batches.iter().any(|b| b.dirs.iter().any(|d| d == "sub")));
    }

    #[test]
    fn polling_fallback_works() {
        let root = scratch("poll");
        fs::create_dir(root.join("sub")).unwrap();
        let batches = collect(&root, true, |r| fs::write(r.join("sub/file.txt"), "x").unwrap(), Duration::from_secs(15));
        assert!(batches.iter().flat_map(|b| &b.files).any(|f| f == "sub/file.txt"), "{batches:?}");
    }

    #[test]
    fn set_dirs_validates() {
        let root = scratch("set");
        fs::create_dir(root.join("a")).unwrap();
        fs::write(root.join("f.txt"), "x").unwrap();
        let mut w = Watch::start(&root, true, Box::new(|_| {})).unwrap();
        assert!(w.set_dirs(&["a".into(), "".into()]).is_ok());
        assert_eq!(w.set_dirs(&["../x".into()]).unwrap_err().code, "invalid_path");
        assert_eq!(w.set_dirs(&["f.txt".into()]).unwrap_err().code, "not_a_directory");
        assert_eq!(w.set_dirs(&(0..MAX_DIRS + 1).map(|i| format!("d{i}")).collect::<Vec<_>>()).unwrap_err().code, "too_large");
        assert!(w.set_dirs(&[]).is_ok() && w.watched.is_empty());
    }
}
