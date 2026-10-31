//! Project-wide text search for the Explorer's Search panel, confined to the active project root.
//!
//! Built for big repositories (100k+ files) and a hostile page:
//! - The root is `fs_ops::active_root()`, re-validated on every search. The webview sends only a
//!   query and relative globs / relative file names; every path returned is relative.
//! - The tree is walked with the `ignore` crate, in parallel, WITHOUT following symlinks (a link
//!   is never entered or read), honouring `.gitignore` / `.ignore` (optional), skipping `.git`.
//!   Each file is opened once with `O_NOFOLLOW`, the real location of the open descriptor is
//!   re-checked against the root, hard-linked files (an alias of something outside the tree) are
//!   refused, and only regular files are read, from that descriptor, up to a byte cap.
//! - The matcher is the `regex` crate: a finite automaton, so there is no catastrophic backtracking
//!   by construction. Compilation is bounded (`size_limit`, `dfa_size_limit`, `nest_limit`, query
//!   length) so a pathological pattern is an `invalid_query` error, never a hang or a memory blow-up.
//!   Literal queries are escaped. Matching is per line.
//! - Output is bounded: matches (default and maximum 5000), matches per line and per file, preview
//!   length (500 bytes), files scanned, files over the byte cap (2 MB default) and binary files are
//!   skipped, and there is a wall-clock limit. Results stream to the page in small chunks over a
//!   Tauri channel; a bounded queue applies backpressure to the walkers.
//! - One search at a time: starting one cancels the previous; `project_search_cancel` stops it.
//!
//! Replace is out of scope (Mac `SearchService` has it; parity row: defer).
//! Column / offset numbers are UTF-16 code units (what Monaco and JS use).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::fs_ops::{active_root, nlink, open_nofollow, rel_of, resolve_existing, split_rel, FsError, R};

pub const MAX_MATCHES: usize = 5000;
pub const MAX_QUERY_CHARS: usize = 1000;
pub const MAX_GLOBS: usize = 50;
pub const MAX_GLOB_CHARS: usize = 256;
pub const MAX_ONLY_PATHS: usize = 500;
pub const MAX_FILES_SCANNED: usize = 500_000;
pub const DEFAULT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const HARD_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const PREVIEW_BYTES: usize = 500;
const PREVIEW_LEAD: usize = 40;
const MAX_PER_LINE: usize = 20;
const MAX_PER_FILE: usize = 500;
const BINARY_SNIFF: usize = 8192;
const TIME_LIMIT: Duration = Duration::from_secs(60);
const QUEUE: usize = 64;
const CHUNK_FILES: usize = 64;
const CHUNK_MATCHES: usize = 200;
const CHUNK_WAIT: Duration = Duration::from_millis(60);
const REGEX_SIZE_LIMIT: usize = 2 * 1024 * 1024;
const REGEX_DFA_LIMIT: usize = 4 * 1024 * 1024;
const REGEX_NEST_LIMIT: u32 = 40;
/// Directories never entered, whatever the query says.
const ALWAYS_SKIP_DIRS: [&str; 3] = [".git", ".hg", ".svn"];

fn yes() -> bool {
    true
}

#[derive(Deserialize, Debug, Clone)]
pub struct Query {
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Glob whitelist (relative, gitignore syntax). Empty = everything.
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    /// Search only these files (relative paths; the "open files" scope). No walking.
    #[serde(default)]
    pub only_paths: Option<Vec<String>>,
    #[serde(default)]
    pub max_matches: Option<usize>,
    #[serde(default)]
    pub max_file_bytes: Option<u64>,
    #[serde(default = "yes")]
    pub include_hidden: bool,
    /// Honour `.gitignore` / `.ignore`.
    #[serde(default = "yes")]
    pub use_ignore: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Hit {
    /// 1-based line.
    pub line: u32,
    /// 1-based UTF-16 column of the match start in the ORIGINAL line.
    pub col: u32,
    /// The line, windowed to at most `PREVIEW_BYTES` bytes around the match.
    pub preview: String,
    /// Match start / end as UTF-16 offsets into `preview`.
    pub ms: u32,
    pub me: u32,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct FileHits {
    pub path: String,
    pub hits: Vec<Hit>,
    /// More matches in this file than were kept.
    pub more: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SearchEvent {
    Chunk { id: u64, files: Vec<FileHits> },
    Done {
        id: u64,
        files_scanned: usize,
        files_matched: usize,
        matches: usize,
        /// Why the result is partial: `matches`, `files`, `time`; null when complete.
        truncated: Option<&'static str>,
        cancelled: bool,
        skipped_binary: usize,
        skipped_large: usize,
        skipped_other: usize,
    },
}

fn err<T>(code: &'static str, message: impl Into<String>) -> R<T> {
    Err(FsError { code, message: message.into() })
}

// ---- query -> matcher -------------------------------------------------------------------

pub fn build_matcher(q: &Query) -> R<Regex> {
    if q.query.is_empty() {
        return err("invalid_query", "enter something to search for");
    }
    if q.query.chars().count() > MAX_QUERY_CHARS {
        return err("invalid_query", "the query is too long");
    }
    if q.query.contains('\0') {
        return err("invalid_query", "the query contains a NUL character");
    }
    let mut pat = if q.regex { q.query.clone() } else { regex::escape(&q.query) };
    if q.whole_word {
        pat = format!(r"\b(?:{pat})\b");
    }
    RegexBuilder::new(&pat)
        .case_insensitive(!q.case_sensitive)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_DFA_LIMIT)
        .nest_limit(REGEX_NEST_LIMIT)
        .build()
        .map_err(|e| FsError { code: "invalid_query", message: first_line(&e.to_string()) })
}

fn first_line(s: &str) -> String {
    let l = s.lines().last().unwrap_or(s).trim();
    l.chars().take(200).collect()
}

fn valid_globs(globs: &[String]) -> R<()> {
    if globs.len() > MAX_GLOBS {
        return err("invalid_query", "too many include/exclude patterns");
    }
    for g in globs {
        if g.len() > MAX_GLOB_CHARS || g.contains('\0') {
            return err("invalid_query", "an include/exclude pattern is too long");
        }
    }
    Ok(())
}

fn build_overrides(root: &Path, q: &Query) -> R<Option<ignore::overrides::Override>> {
    let inc: Vec<&String> = q.include.iter().filter(|g| !g.trim().is_empty()).collect();
    let exc: Vec<&String> = q.exclude.iter().filter(|g| !g.trim().is_empty()).collect();
    if inc.is_empty() && exc.is_empty() {
        return Ok(None);
    }
    let mut b = OverrideBuilder::new(root);
    for g in inc {
        b.add(g.trim()).map_err(|e| FsError { code: "invalid_query", message: format!("bad include pattern: {}", first_line(&e.to_string())) })?;
    }
    for g in exc {
        let g = g.trim().trim_start_matches('!');
        b.add(&format!("!{g}")).map_err(|e| FsError { code: "invalid_query", message: format!("bad exclude pattern: {}", first_line(&e.to_string())) })?;
    }
    b.build().map(Some).map_err(|e| FsError { code: "invalid_query", message: first_line(&e.to_string()) })
}

// ---- per-file scan ----------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum FileOutcome {
    Hits(FileHits),
    NoMatch,
    Binary,
    Large,
    Other,
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn utf16(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// Scans decoded text; pure, so it is unit-tested directly.
pub fn scan_text(text: &str, re: &Regex, rel: &str) -> Option<FileHits> {
    // A cheap whole-text prefilter (literal acceleration); the per-line pass is authoritative.
    if !re.is_match(text) {
        return None;
    }
    let mut hits = Vec::new();
    let mut more = false;
    'lines: for (i, raw) in text.lines().enumerate() {
        let line = raw;
        let mut n_line = 0usize;
        // Incremental UTF-16 column: matches arrive in ascending order.
        let (mut last_byte, mut col16) = (0usize, 0u32);
        for m in re.find_iter(line) {
            if m.start() == m.end() {
                continue; // empty matches (e.g. `x*`) are noise
            }
            if hits.len() >= MAX_PER_FILE {
                more = true;
                break 'lines;
            }
            if n_line >= MAX_PER_LINE {
                more = true;
                break;
            }
            n_line += 1;
            col16 += utf16(&line[last_byte..m.start()]);
            last_byte = m.start();
            let (preview, ms, me) = if line.len() <= PREVIEW_BYTES {
                (line.to_string(), utf16(&line[..m.start()]), utf16(&line[..m.end()]))
            } else {
                let start = floor_boundary(line, m.start().saturating_sub(PREVIEW_LEAD));
                let end = floor_boundary(line, (start + PREVIEW_BYTES).max(start));
                let me_b = m.end().min(end).max(m.start().min(end));
                let ms_b = m.start().min(end);
                let w = &line[start..end];
                (w.to_string(), utf16(&line[start..ms_b]), utf16(&line[start..me_b]))
            };
            hits.push(Hit { line: (i + 1) as u32, col: col16 + 1, preview, ms, me });
        }
    }
    if hits.is_empty() {
        None
    } else {
        Some(FileHits { path: rel.to_string(), hits, more })
    }
}

fn scan_file(root: &Path, path: &Path, re: &Regex, max_bytes: u64) -> FileOutcome {
    use std::io::Read;
    let Ok(f) = open_nofollow(path, false) else { return FileOutcome::Other };
    match crate::graph_file::fd_path(&f) {
        Some(real) => {
            if !real.starts_with(root) {
                return FileOutcome::Other;
            }
        }
        None if cfg!(any(target_os = "macos", target_os = "linux")) => return FileOutcome::Other,
        None => {}
    }
    let Ok(meta) = f.metadata() else { return FileOutcome::Other };
    if !meta.is_file() || nlink(&meta) > 1 {
        return FileOutcome::Other;
    }
    if meta.len() > max_bytes {
        return FileOutcome::Large;
    }
    let mut buf = Vec::with_capacity(meta.len() as usize + 1);
    if f.take(max_bytes + 1).read_to_end(&mut buf).is_err() {
        return FileOutcome::Other;
    }
    if buf.len() as u64 > max_bytes {
        return FileOutcome::Large;
    }
    let sniff = &buf[..buf.len().min(BINARY_SNIFF)];
    if sniff.contains(&0) || sniff.starts_with(&[0xFF, 0xFE]) || sniff.starts_with(&[0xFE, 0xFF]) {
        return FileOutcome::Binary;
    }
    let text = String::from_utf8_lossy(&buf);
    match scan_text(&text, re, &rel_of(root, path)) {
        Some(h) => FileOutcome::Hits(h),
        None => FileOutcome::NoMatch,
    }
}

// ---- the run ----------------------------------------------------------------------------

#[derive(Default)]
struct Stats {
    scanned: AtomicUsize,
    binary: AtomicUsize,
    large: AtomicUsize,
    other: AtomicUsize,
    /// Matches seen by workers: a hint to stop early; the aggregator enforces the cap.
    matches: AtomicUsize,
    files_cap_hit: AtomicBool,
}

fn worker_visit(root: &Path, path: &Path, re: &Regex, max_bytes: u64, cap: usize, stats: &Stats, cancel: &AtomicBool, tx: &std::sync::mpsc::SyncSender<FileHits>) -> bool {
    // `cancel` here is the internal halt flag (set by the aggregator on cancel, cap, time, closed sink).
    if cancel.load(Ordering::Relaxed) || stats.matches.load(Ordering::Relaxed) >= cap {
        return false;
    }
    if stats.scanned.fetch_add(1, Ordering::Relaxed) >= MAX_FILES_SCANNED {
        stats.files_cap_hit.store(true, Ordering::Relaxed);
        return false;
    }
    match scan_file(root, path, re, max_bytes) {
        FileOutcome::Hits(h) => {
            stats.matches.fetch_add(h.hits.len(), Ordering::Relaxed);
            if tx.send(h).is_err() {
                cancel.store(true, Ordering::Relaxed);
                return false;
            }
        }
        FileOutcome::NoMatch => {}
        FileOutcome::Binary => {
            stats.binary.fetch_add(1, Ordering::Relaxed);
        }
        FileOutcome::Large => {
            stats.large.fetch_add(1, Ordering::Relaxed);
        }
        FileOutcome::Other => {
            stats.other.fetch_add(1, Ordering::Relaxed);
        }
    }
    true
}

fn thread_count() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(2, 8)
}

/// Runs a search and reports through `sink` (returns false to stop). Blocking; call from a
/// blocking thread. `id` only labels the events.
pub fn run_search(root: &Path, q: &Query, id: u64, cancel: &AtomicBool, sink: &mut dyn FnMut(SearchEvent) -> bool) -> R<()> {
    valid_globs(&q.include)?;
    valid_globs(&q.exclude)?;
    let re = build_matcher(q)?;
    let cap = q.max_matches.unwrap_or(MAX_MATCHES).clamp(1, MAX_MATCHES);
    let max_bytes = q.max_file_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES).clamp(1, HARD_MAX_FILE_BYTES);
    let overrides = build_overrides(root, q)?;
    let only: Option<Vec<PathBuf>> = match &q.only_paths {
        None => None,
        Some(list) => {
            if list.len() > MAX_ONLY_PATHS {
                return err("invalid_query", "too many files in scope");
            }
            let mut v = Vec::new();
            for rel in list {
                split_rel(rel)?;
                // A file that vanished or resolves outside the root is simply not searched.
                if let Ok(p) = resolve_existing(root, rel) {
                    v.push(p);
                }
            }
            Some(v)
        }
    };

    let stats = Arc::new(Stats::default());
    // Internal halt flag the workers watch: set on external cancel, match cap, deadline, closed sink.
    let halt = AtomicBool::new(false);
    let halt = &halt;
    let (tx, rx) = sync_channel::<FileHits>(QUEUE);
    let deadline = Instant::now() + TIME_LIMIT;
    let mut truncated: Option<&'static str> = None;
    let (mut total, mut files_matched) = (0usize, 0usize);
    let mut chunk: Vec<FileHits> = Vec::new();
    let mut chunk_matches = 0usize;
    let mut chunk_since: Option<Instant> = None;
    let mut stopped = false;
    let mut sink_closed = false;

    std::thread::scope(|scope| {
        let stats_w = Arc::clone(&stats);
        let (re_w, root_w) = (&re, root);
        scope.spawn(move || {
            let stats = stats_w;
            if let Some(paths) = only {
                for p in paths {
                    if !worker_visit(root_w, &p, re_w, max_bytes, cap, &stats, halt, &tx) {
                        break;
                    }
                }
                return;
            }
            let mut wb = WalkBuilder::new(root_w);
            wb.follow_links(false)
                .hidden(!q.include_hidden)
                .parents(false)
                .git_global(false)
                .require_git(false)
                .git_ignore(q.use_ignore)
                .git_exclude(q.use_ignore)
                .ignore(q.use_ignore)
                .threads(thread_count())
                .max_depth(Some(256))
                .filter_entry(|e| {
                    let skip = e.file_type().is_some_and(|t| t.is_dir()) && e.file_name().to_str().is_some_and(|n| ALWAYS_SKIP_DIRS.contains(&n));
                    !skip
                });
            if let Some(o) = overrides {
                wb.overrides(o);
            }
            wb.build_parallel().run(|| {
                let (tx, stats, re) = (tx.clone(), Arc::clone(&stats), re_w.clone());
                Box::new(move |entry| {
                    let Ok(entry) = entry else { return WalkState::Continue };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        return WalkState::Continue;
                    }
                    if worker_visit(root_w, entry.path(), &re, max_bytes, cap, &stats, halt, &tx) {
                        WalkState::Continue
                    } else {
                        WalkState::Quit
                    }
                })
            });
            drop(tx);
        });

        // Aggregator: enforce the match cap, batch into chunks, honour cancel / deadline.
        let flush = |chunk: &mut Vec<FileHits>, chunk_matches: &mut usize, since: &mut Option<Instant>, sink: &mut dyn FnMut(SearchEvent) -> bool| -> bool {
            *chunk_matches = 0;
            *since = None;
            if chunk.is_empty() {
                return true;
            }
            sink(SearchEvent::Chunk { id, files: std::mem::take(chunk) })
        };
        loop {
            if cancel.load(Ordering::Relaxed) {
                stopped = true;
            }
            if !stopped && truncated.is_none() && Instant::now() >= deadline {
                truncated = Some("time");
                stopped = true;
            }
            if stopped {
                halt.store(true, Ordering::Relaxed); // stop the walkers; keep draining so they unblock
            }
            match rx.recv_timeout(CHUNK_WAIT) {
                Ok(mut f) => {
                    if stopped || truncated == Some("matches") {
                        continue;
                    }
                    let room = cap - total;
                    if f.hits.len() > room {
                        f.hits.truncate(room);
                        f.more = true;
                        truncated = Some("matches");
                    }
                    total += f.hits.len();
                    files_matched += 1;
                    chunk_matches += f.hits.len();
                    chunk.push(f);
                    chunk_since.get_or_insert_with(Instant::now);
                    if total >= cap {
                        truncated = Some("matches");
                    }
                    if truncated == Some("matches") {
                        halt.store(true, Ordering::Relaxed);
                    }
                    if chunk.len() >= CHUNK_FILES || chunk_matches >= CHUNK_MATCHES {
                        if !flush(&mut chunk, &mut chunk_matches, &mut chunk_since, sink) {
                            stopped = true;
                            sink_closed = true;
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if chunk_since.is_some_and(|t| t.elapsed() >= CHUNK_WAIT) && !flush(&mut chunk, &mut chunk_matches, &mut chunk_since, sink) {
                        stopped = true;
                        sink_closed = true;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        if !sink_closed && !(stopped && truncated.is_none()) {
            flush(&mut chunk, &mut chunk_matches, &mut chunk_since, sink);
        }
    });

    let user_cancelled = stopped && truncated.is_none();
    if truncated.is_none() && stats.files_cap_hit.load(Ordering::Relaxed) {
        truncated = Some("files");
    }
    let _ = sink(SearchEvent::Done {
        id,
        files_scanned: stats.scanned.load(Ordering::Relaxed).min(MAX_FILES_SCANNED),
        files_matched,
        matches: total,
        truncated,
        cancelled: user_cancelled,
        skipped_binary: stats.binary.load(Ordering::Relaxed),
        skipped_large: stats.large.load(Ordering::Relaxed),
        skipped_other: stats.other.load(Ordering::Relaxed),
    });
    Ok(())
}

// ---- commands -----------------------------------------------------------------------------

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static CURRENT: Mutex<Option<(u64, Arc<AtomicBool>)>> = Mutex::new(None);

fn begin() -> (u64, Arc<AtomicBool>) {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let flag = Arc::new(AtomicBool::new(false));
    let mut cur = CURRENT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((_, old)) = cur.replace((id, Arc::clone(&flag))) {
        old.store(true, Ordering::Relaxed);
    }
    (id, flag)
}

fn finish(id: u64) {
    let mut cur = CURRENT.lock().unwrap_or_else(|p| p.into_inner());
    if cur.as_ref().is_some_and(|(i, _)| *i == id) {
        *cur = None;
    }
}

#[derive(Serialize)]
pub struct Started {
    pub id: u64,
}

/// Validates the query (a bad pattern is an immediate `invalid_query` error), cancels any running
/// search and starts this one on a blocking thread. Events arrive on `on_event`.
#[tauri::command]
pub async fn project_search_start(req: Query, on_event: Channel<SearchEvent>) -> R<Started> {
    let root = active_root()?;
    valid_globs(&req.include)?;
    valid_globs(&req.exclude)?;
    build_matcher(&req)?;
    build_overrides(&root, &req)?;
    let (id, cancel) = begin();
    tauri::async_runtime::spawn_blocking(move || {
        let mut sink = |ev: SearchEvent| on_event.send(ev).is_ok();
        if let Err(e) = run_search(&root, &req, id, &cancel, &mut sink) {
            // Validation already passed; this is a late failure (e.g. a path went away).
            let _ = on_event.send(SearchEvent::Done {
                id,
                files_scanned: 0,
                files_matched: 0,
                matches: 0,
                truncated: None,
                cancelled: true,
                skipped_binary: 0,
                skipped_large: 0,
                skipped_other: 0,
            });
            let _ = e;
        }
        finish(id);
    });
    Ok(Started { id })
}

#[tauri::command]
pub fn project_search_cancel(id: u64) {
    let cur = CURRENT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((i, f)) = cur.as_ref() {
        if *i == id {
            f.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-search-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }
    fn q(s: &str) -> Query {
        serde_json::from_value(serde_json::json!({ "query": s })).unwrap()
    }
    fn run(root: &Path, q: &Query) -> (Vec<FileHits>, SearchEvent) {
        let cancel = AtomicBool::new(false);
        run_with(root, q, &cancel)
    }
    fn run_with(root: &Path, q: &Query, cancel: &AtomicBool) -> (Vec<FileHits>, SearchEvent) {
        let mut files = Vec::new();
        let mut done = None;
        let mut sink = |ev: SearchEvent| {
            match ev {
                SearchEvent::Chunk { files: f, .. } => files.extend(f),
                d @ SearchEvent::Done { .. } => done = Some(d),
            }
            true
        };
        run_search(root, q, 1, cancel, &mut sink).unwrap();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        (files, done.unwrap())
    }
    fn done_fields(d: &SearchEvent) -> (usize, usize, Option<&'static str>, bool) {
        match d {
            SearchEvent::Done { files_scanned, matches, truncated, cancelled, .. } => (*files_scanned, *matches, *truncated, *cancelled),
            _ => panic!("not done"),
        }
    }

    #[test]
    fn literal_case_word_and_regex_modes() {
        let root = scratch("modes");
        fs::write(root.join("a.txt"), "Hello world\nhello World\nshelloe\n").unwrap();
        let (f, _) = run(&root, &q("hello"));
        assert_eq!(f[0].hits.len(), 3, "case-insensitive literal");
        let mut cs = q("hello");
        cs.case_sensitive = true;
        assert_eq!(run(&root, &cs).0[0].hits.len(), 2);
        let mut ww = q("hello");
        ww.whole_word = true;
        assert_eq!(run(&root, &ww).0[0].hits.len(), 2, "shelloe excluded");
        let mut rx = q(r"wor\w+");
        rx.regex = true;
        assert_eq!(run(&root, &rx).0[0].hits.len(), 2);
        // A literal query with regex metacharacters is escaped.
        fs::write(root.join("b.txt"), "a.b a+b axb\n").unwrap();
        let (f, _) = run(&root, &q("a.b"));
        assert_eq!(f.iter().find(|x| x.path == "b.txt").unwrap().hits.len(), 1);
    }

    #[test]
    fn line_numbers_columns_and_crlf() {
        let root = scratch("lines");
        fs::write(root.join("a.txt"), "one\r\ntwo needle\r\n\r\nthree needle needle\n").unwrap();
        let (f, _) = run(&root, &q("needle"));
        let h = &f[0].hits;
        assert_eq!(h.len(), 3);
        assert_eq!((h[0].line, h[0].col), (2, 5));
        assert_eq!((h[1].line, h[1].col), (4, 7));
        assert_eq!((h[2].line, h[2].col), (4, 14));
        assert_eq!(h[0].preview, "two needle", "CR stripped");
        assert_eq!((h[0].ms, h[0].me), (4, 10));
    }

    #[test]
    fn unicode_columns_are_utf16() {
        let root = scratch("uni");
        // 😀 is two UTF-16 units, 日本 one each.
        fs::write(root.join("u.txt"), "😀日本 résumé!\n").unwrap();
        let (f, _) = run(&root, &q("RÉSUMÉ"));
        let h = &f[0].hits[0];
        assert_eq!(h.col, 6, "😀(2)+日本(2)+space(1) before the match, 1-based");
        assert_eq!((h.ms, h.me), (5, 11));
        assert_eq!(&h.preview.encode_utf16().collect::<Vec<_>>()[5..11], "résumé".encode_utf16().collect::<Vec<_>>().as_slice());
    }

    #[test]
    fn gitignore_hidden_and_git_dir() {
        let root = scratch("ignore");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        fs::write(root.join(".git/config"), "needle\n").unwrap();
        fs::write(root.join("build/out.js"), "needle\n").unwrap();
        fs::write(root.join("src/a.rs"), "needle\n").unwrap();
        fs::write(root.join(".hidden.txt"), "needle\n").unwrap();
        let (f, _) = run(&root, &q("needle"));
        let paths: Vec<&str> = f.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, [".hidden.txt", "src/a.rs"]);
        let mut all = q("needle");
        all.use_ignore = false;
        all.include_hidden = false;
        let paths: Vec<String> = run(&root, &all).0.into_iter().map(|x| x.path).collect();
        assert_eq!(paths, ["build/out.js", "src/a.rs"], ".git is never searched; hidden off");
    }

    #[test]
    fn include_exclude_globs() {
        let root = scratch("globs");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        for p in ["src/a.rs", "src/b.ts", "docs/c.md", "d.rs"] {
            fs::write(root.join(p), "needle\n").unwrap();
        }
        let mut i = q("needle");
        i.include = vec!["*.rs".into()];
        let paths: Vec<String> = run(&root, &i).0.into_iter().map(|x| x.path).collect();
        assert_eq!(paths, ["d.rs", "src/a.rs"]);
        let mut e = q("needle");
        e.exclude = vec!["docs/".into(), "*.ts".into()];
        let paths: Vec<String> = run(&root, &e).0.into_iter().map(|x| x.path).collect();
        assert_eq!(paths, ["d.rs", "src/a.rs"]);
        let mut bad = q("needle");
        bad.include = vec!["[".into()];
        let cancel = AtomicBool::new(false);
        let r = run_search(&root, &bad, 1, &cancel, &mut |_| true);
        assert_eq!(r.unwrap_err().code, "invalid_query");
    }

    #[test]
    fn binary_and_huge_files_are_skipped_and_counted() {
        let root = scratch("bin");
        let mut bin = b"needle\n".to_vec();
        bin.push(0);
        fs::write(root.join("b.bin"), &bin).unwrap();
        fs::write(root.join("big.txt"), "needle\n".repeat(400_000)).unwrap(); // 2.8 MB
        fs::write(root.join("ok.txt"), "needle\n").unwrap();
        let (f, d) = run(&root, &q("needle"));
        assert_eq!(f.len(), 1);
        match d {
            SearchEvent::Done { skipped_binary, skipped_large, .. } => assert_eq!((skipped_binary, skipped_large), (1, 1)),
            _ => unreachable!(),
        }
        let mut more = q("needle");
        more.max_file_bytes = Some(4 * 1024 * 1024);
        more.max_matches = Some(10);
        let (f, d) = run(&root, &more);
        assert_eq!(f.len(), 2, "raised file cap includes big.txt");
        assert_eq!(done_fields(&d).2, Some("matches"));
        assert!(f.iter().map(|x| x.hits.len()).sum::<usize>() <= 10);
    }

    #[test]
    fn match_cap_is_enforced_exactly_and_marks_truncated() {
        let root = scratch("cap");
        for i in 0..20 {
            fs::write(root.join(format!("f{i}.txt")), "x\n".repeat(400)).unwrap();
        }
        let mut c = q("x");
        c.max_matches = Some(1_000_000); // clamped to MAX_MATCHES
        let (f, d) = run(&root, &c);
        let total: usize = f.iter().map(|x| x.hits.len()).sum();
        assert_eq!(total, MAX_MATCHES);
        assert_eq!(done_fields(&d), (done_fields(&d).0, MAX_MATCHES, Some("matches"), false));
    }

    #[test]
    fn per_line_and_per_file_limits_and_long_line_preview() {
        let root = scratch("limits");
        fs::write(root.join("a.txt"), format!("{}\n", "x ".repeat(1000))).unwrap();
        let (f, _) = run(&root, &q("x"));
        assert_eq!(f[0].hits.len(), MAX_PER_LINE);
        assert!(f[0].more);
        // A minified-style line: preview is windowed, offsets stay inside it.
        let long = format!("{}NEEDLE{}", "é".repeat(3000), "ü".repeat(3000));
        fs::write(root.join("m.js"), format!("{long}\n")).unwrap();
        let (f, _) = run(&root, &q("needle"));
        let h = &f.iter().find(|x| x.path == "m.js").unwrap().hits[0];
        assert!(h.preview.len() <= PREVIEW_BYTES);
        assert_eq!(h.col, 3001);
        let u: Vec<u16> = h.preview.encode_utf16().collect();
        assert_eq!(String::from_utf16(&u[h.ms as usize..h.me as usize]).unwrap(), "NEEDLE");
    }

    #[test]
    fn empty_matches_and_empty_query_are_rejected_or_ignored() {
        let root = scratch("empty");
        fs::write(root.join("a.txt"), "abc\n").unwrap();
        let cancel = AtomicBool::new(false);
        assert_eq!(run_search(&root, &q(""), 1, &cancel, &mut |_| true).unwrap_err().code, "invalid_query");
        let mut r = q("x*");
        r.regex = true;
        let (f, _) = run(&root, &r);
        assert!(f.is_empty(), "a pattern that only matches the empty string yields nothing");
    }

    #[test]
    fn regex_dos_inputs_are_bounded() {
        // Catastrophic-backtracking classics are linear in this engine.
        let root = scratch("dos");
        fs::write(root.join("a.txt"), format!("{}!\n", "a".repeat(50_000))).unwrap();
        let mut ev = q("(a+)+$");
        ev.regex = true;
        let start = Instant::now();
        let (f, _) = run(&root, &ev);
        assert!(start.elapsed() < Duration::from_secs(10), "took {:?}", start.elapsed());
        let _ = f;
        // Pattern blow-ups fail to compile rather than allocate.
        for p in ["(((((a{100}){100}){100}){100}){100}){100}", "a{1000}{1000}", r"\pL{10000}"] {
            let mut b = q(p);
            b.regex = true;
            let cancel = AtomicBool::new(false);
            let r = run_search(&root, &b, 1, &cancel, &mut |_| true);
            assert_eq!(r.map_err(|e| e.code), Err("invalid_query"), "{p}");
        }
        let long = q(&"a".repeat(MAX_QUERY_CHARS + 1));
        let cancel = AtomicBool::new(false);
        assert_eq!(run_search(&root, &long, 1, &cancel, &mut |_| true).unwrap_err().code, "invalid_query");
        let mut deep = q(&format!("{}a{}", "(".repeat(100), ")".repeat(100)));
        deep.regex = true;
        assert_eq!(run_search(&root, &deep, 1, &cancel, &mut |_| true).unwrap_err().code, "invalid_query", "nest limit");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed_and_hardlinks_never_read() {
        use std::os::unix::fs::symlink;
        let root = scratch("links");
        let outside = scratch("links-out");
        fs::write(outside.join("secret.txt"), "needle secret\n").unwrap();
        fs::create_dir_all(outside.join("d")).unwrap();
        fs::write(outside.join("d/in.txt"), "needle\n").unwrap();
        symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        symlink(outside.join("d"), root.join("dirlink")).unwrap();
        // A loop inside the tree.
        fs::create_dir_all(root.join("loop")).unwrap();
        symlink(&root, root.join("loop/back")).unwrap();
        // A hard link to an outside file.
        fs::hard_link(outside.join("secret.txt"), root.join("hard.txt")).unwrap();
        fs::write(root.join("real.txt"), "needle\n").unwrap();
        let (f, d) = run(&root, &q("needle"));
        let paths: Vec<&str> = f.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, ["real.txt"], "{paths:?}");
        match d {
            SearchEvent::Done { skipped_other, .. } => assert!(skipped_other >= 1, "the hard link is counted as skipped"),
            _ => unreachable!(),
        }
        // The open-files scope cannot be pointed at a link out of the root either.
        let mut only = q("needle");
        only.only_paths = Some(vec!["link.txt".into(), "dirlink/in.txt".into(), "../x".into()]);
        let cancel = AtomicBool::new(false);
        let r = run_search(&root, &only, 1, &cancel, &mut |_| true);
        assert_eq!(r.unwrap_err().code, "invalid_path");
        only.only_paths = Some(vec!["link.txt".into(), "dirlink/in.txt".into(), "real.txt".into()]);
        let (f, _) = run(&root, &only);
        let paths: Vec<&str> = f.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, ["real.txt"]);
    }

    #[test]
    fn open_files_scope_validates_paths_and_skips_missing() {
        let root = scratch("only");
        fs::write(root.join("a.txt"), "needle\n").unwrap();
        fs::write(root.join("b.txt"), "needle\n").unwrap();
        let mut o = q("needle");
        o.only_paths = Some(vec!["a.txt".into(), "gone.txt".into()]);
        let (f, d) = run(&root, &o);
        assert_eq!(f.len(), 1);
        assert_eq!(done_fields(&d).0, 1);
        for bad in ["/etc/passwd", "a/../../x", "a\\b", ""] {
            let mut b = q("needle");
            b.only_paths = Some(vec![bad.to_string()]);
            let cancel = AtomicBool::new(false);
            let r = run_search(&root, &b, 1, &cancel, &mut |_| true);
            // "" is the root itself (a directory): nothing to search, not an error.
            if bad.is_empty() {
                assert!(r.is_ok());
            } else {
                assert_eq!(r.unwrap_err().code, "invalid_path", "{bad}");
            }
        }
    }

    #[test]
    fn cancel_before_and_during_a_run() {
        let root = scratch("cancel");
        for i in 0..300 {
            fs::write(root.join(format!("f{i}.txt")), "needle\n").unwrap();
        }
        let pre = AtomicBool::new(true);
        let (f, d) = run_with(&root, &q("needle"), &pre);
        assert!(f.is_empty());
        assert_eq!(done_fields(&d).3, true, "cancelled");
        // Cancel from the sink after the first chunk.
        let cancel = AtomicBool::new(false);
        let mut chunks = 0;
        let mut done = None;
        run_search(&root, &q("needle"), 9, &cancel, &mut |ev| {
            match ev {
                SearchEvent::Chunk { .. } => {
                    chunks += 1;
                    cancel.store(true, Ordering::Relaxed);
                }
                d => done = Some(d),
            }
            true
        })
        .unwrap();
        assert!(chunks >= 1);
        let d = done.unwrap();
        let (scanned, _, _, cancelled) = done_fields(&d);
        assert!(cancelled);
        assert!(scanned <= 300);
    }

    #[test]
    fn a_closed_channel_stops_the_search() {
        let root = scratch("closed");
        for i in 0..2000 {
            fs::write(root.join(format!("f{i}.txt")), "needle\n").unwrap();
        }
        let cancel = AtomicBool::new(false);
        let mut sent = 0;
        run_search(&root, &q("needle"), 1, &cancel, &mut |ev| {
            if matches!(ev, SearchEvent::Chunk { .. }) {
                sent += 1;
                return false; // the page is gone
            }
            true
        })
        .unwrap();
        assert_eq!(sent, 1, "no chunk is sent after the sink refused one");
    }

    #[test]
    fn root_is_the_boundary_for_walks() {
        let parent = scratch("boundary");
        let root = parent.join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(parent.join("outside.txt"), "needle\n").unwrap();
        fs::write(root.join("in.txt"), "needle\n").unwrap();
        let (f, _) = run(&root, &q("needle"));
        assert_eq!(f.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["in.txt"]);
    }

    /// `cargo test --release --lib project_search::tests::bench_100k -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_100k_files() {
        let root = scratch("bench");
        let n_dirs = 1000;
        let per = 100;
        for d in 0..n_dirs {
            let dir = root.join(format!("pkg{d:04}/src"));
            fs::create_dir_all(&dir).unwrap();
            for f in 0..per {
                let body = format!("// file {d}/{f}\nfn main() {{\n    let value = {};\n    println!(\"hello {{}}\", value);\n}}\n", d * per + f);
                fs::write(dir.join(format!("m{f:03}.rs")), body.repeat(8)).unwrap();
            }
        }
        // A rare literal in 1 of every 1000 files, and a common one in all.
        for d in 0..n_dirs {
            fs::write(root.join(format!("pkg{d:04}/src/zz_rare.rs")), "let rare_marker_xyz = 1;\n").unwrap();
        }
        for (label, qs, rx) in [("literal-rare", "rare_marker_xyz", false), ("literal-common", "println", false), ("regex", r"value = \d+7;", true)] {
            let mut query = q(qs);
            query.regex = rx;
            let start = Instant::now();
            let (_, d) = run(&root, &query);
            let (scanned, matches, trunc, _) = done_fields(&d);
            println!("BENCH {label}: {} ms, files scanned {scanned}, matches {matches}, truncated {trunc:?}", start.elapsed().as_millis());
        }
    }
}
