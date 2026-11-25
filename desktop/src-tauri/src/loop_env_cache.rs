//! Environment cache for Factory runs.
//!
//! Every Factory run works in a brand-new git worktree, so a project whose tests need an installed environment (a
//! Python `.venv`, `node_modules`) would rebuild it from scratch for every run. A loop can declare
//! `config.envCache = { keyFiles, setup, paths }` in `system/loop.json`:
//!
//! - `keyFiles`: manifest files (`requirements.txt`, `package-lock.json`, ...) whose bytes, together with `setup`, make
//!   the cache key. A changed manifest is a new key, so a stale environment is never reused.
//! - `setup`: the command that builds the environment in the worktree. It is ONE MORE COMMAND IN THE LOOP'S NATIVE
//!   APPROVAL (`loop_approval.rs` lists it under `ENV_CACHE_STAGE_ID`, pinned to its SHA-256 like every other
//!   command), and it runs only on a cache miss.
//! - `paths`: what `setup` produces, relative to the worktree (`.venv`, `node_modules`).
//!
//! A hit is a plain file copy made by the host itself (no shell, no approval needed). Each run gets its OWN copy, never
//! a link to one shared folder, so two runs in parallel cannot disturb each other's environment. Text files that name
//! the folder the environment was built in (a venv's script shebangs, `pyvenv.cfg`, `.pth` files) are rewritten to the
//! new worktree, because a venv is not relocatable without it.
//!
//! The cache lives in `<project>/system/loop-env-cache/<key>/`, outside every worktree, and at most `MAX_KEYS_KEPT`
//! keys are kept (least recently used go first).

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::loop_approval::ApprovalStore;
use crate::loop_runner::{canonical_roots, clear_cancel, read_loop_json, root_for, run_command_keyed};

/// The reserved stage id under which the setup command is approved. A real stage must not use it.
pub(crate) const ENV_CACHE_STAGE_ID: &str = "__env_cache_setup__";
pub(crate) const ENV_CACHE_STAGE_NAME: &str = "Set up environment";

const MAX_KEYS_KEPT: usize = 4;
const MAX_KEY_FILES: usize = 16;
const MAX_PATHS: usize = 8;
const MAX_KEY_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_REWRITE_FILE_BYTES: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 1_000_000;
const MAX_DEPTH: usize = 64;
const DEFAULT_SETUP_TIMEOUT_SECS: u64 = 30 * 60;
const OUTPUT_TAIL_CHARS: usize = 4000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EnvCacheSpec {
    pub key_files: Vec<String>,
    pub setup: String,
    pub paths: Vec<String>,
}

/// What `loop_env_prepare` did. `status`: `none` (no envCache), `present` (every path already exists in the worktree),
/// `restored` (copied from the cache), `built` (setup ran), `failed` (setup did not succeed; `output` has its tail).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvPrepare {
    pub status: &'static str,
    pub message: String,
    pub key: Option<String>,
    pub output: Option<String>,
}

impl EnvPrepare {
    fn of(status: &'static str, message: impl Into<String>, key: Option<String>) -> Self {
        EnvPrepare { status, message: message.into(), key, output: None }
    }
}

/// A plain relative path inside the worktree: no `..`, no root, no `\`, never `.git` or `.factory`.
fn safe_rel(rel: &str, what: &str) -> Result<String, String> {
    let t = rel.trim();
    if t.is_empty() || t.len() > 200 || t.contains('\0') || t.contains('\\') {
        return Err(format!("envCache.{what}: “{}” is not a usable path", display(t)));
    }
    let p = Path::new(t);
    if p.is_absolute() {
        return Err(format!("envCache.{what}: “{t}” must be relative to the repository"));
    }
    let mut parts: Vec<&str> = Vec::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::Normal(s) => parts.push(s.to_str().ok_or_else(|| format!("envCache.{what}: “{t}” is not valid text"))?),
            _ => return Err(format!("envCache.{what}: “{t}” must stay inside the repository")),
        }
    }
    match parts.first() {
        None => Err(format!("envCache.{what}: “{t}” is empty")),
        Some(&".git") | Some(&".factory") => Err(format!("envCache.{what}: “{t}” is reserved")),
        _ => Ok(parts.join("/")),
    }
}

fn display(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(80).collect()
}

fn string_list(v: Option<&serde_json::Value>, what: &str, max: usize) -> Result<Vec<String>, String> {
    let arr = v.and_then(|x| x.as_array()).ok_or_else(|| format!("envCache.{what} must be a list"))?;
    if arr.is_empty() || arr.len() > max {
        return Err(format!("envCache.{what} needs between 1 and {max} entries"));
    }
    let mut out: Vec<String> = Vec::new();
    for item in arr {
        let rel = safe_rel(item.as_str().ok_or_else(|| format!("envCache.{what} holds a non-text entry"))?, what)?;
        if !out.contains(&rel) {
            out.push(rel);
        }
    }
    Ok(out)
}

pub(crate) fn parse_spec(raw: &serde_json::Value) -> Result<EnvCacheSpec, String> {
    if !raw.is_object() {
        return Err("envCache must be an object with keyFiles, setup and paths".into());
    }
    let setup = raw.get("setup").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if setup.is_empty() {
        return Err("envCache.setup is empty".into());
    }
    let key_files = string_list(raw.get("keyFiles"), "keyFiles", MAX_KEY_FILES)?;
    let paths = string_list(raw.get("paths"), "paths", MAX_PATHS)?;
    Ok(EnvCacheSpec { key_files, setup, paths })
}

/// The loop's `config.envCache`, or `None` when it declares none. A declared but invalid one is an error, never a
/// silent skip: a typo must not quietly turn the cache off.
pub(crate) fn read_spec(root: &Path, loop_id: &str) -> Result<Option<EnvCacheSpec>, String> {
    let v = read_loop_json(root)?;
    let loops = v.get("loops").and_then(|x| x.as_array()).ok_or("system/loop.json has no loops")?;
    let l = loops.iter().find(|l| l.get("id").and_then(|x| x.as_str()) == Some(loop_id)).ok_or("that loop is not in system/loop.json")?;
    match l.get("config").and_then(|c| c.get("envCache")) {
        None => Ok(None),
        Some(raw) if raw.is_null() => Ok(None),
        Some(raw) => parse_spec(raw).map(Some),
    }
}

pub(crate) fn cache_root(project: &Path) -> PathBuf {
    project.join("system").join("loop-env-cache")
}

/// SHA-256 over the setup command, the declared paths, this OS and CPU, and every key file (path and bytes; a missing
/// file counts as absent). The key is a hex string, so it is also a safe folder name.
pub(crate) fn cache_key(work: &Path, spec: &EnvCacheSpec) -> Result<String, String> {
    let mut h = Sha256::new();
    h.update(b"llmide-env-cache-v1\0");
    h.update(std::env::consts::OS.as_bytes());
    h.update([0]);
    h.update(std::env::consts::ARCH.as_bytes());
    h.update([0]);
    h.update(spec.setup.as_bytes());
    h.update([0]);
    for p in &spec.paths {
        h.update(p.as_bytes());
        h.update([0]);
    }
    h.update([1]);
    for rel in &spec.key_files {
        h.update(rel.as_bytes());
        h.update([0]);
        let path = work.join(rel);
        match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() => {
                if m.len() > MAX_KEY_FILE_BYTES {
                    return Err(format!("envCache key file {rel} is larger than 8 MiB"));
                }
                let bytes = std::fs::read(&path).map_err(|e| format!("cannot read key file {rel}: {e}"))?;
                h.update((bytes.len() as u64).to_le_bytes());
                h.update(&bytes);
            }
            Ok(_) => return Err(format!("envCache key file {rel} is not a regular file")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => h.update(b"absent"),
            Err(e) => return Err(format!("cannot read key file {rel}: {e}")),
        }
        h.update([0]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn entry_exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

fn copy_tree(src: &Path, dst: &Path, depth: usize, budget: &mut usize) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("the environment folder is nested too deeply to copy".into());
    }
    if *budget == 0 {
        return Err("the environment folder has too many files to copy".into());
    }
    *budget -= 1;
    let meta = std::fs::symlink_metadata(src).map_err(|e| format!("cannot read {}: {e}", src.display()))?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        let target = std::fs::read_link(src).map_err(|e| format!("cannot read link {}: {e}", src.display()))?;
        #[cfg(unix)]
        {
            return std::os::unix::fs::symlink(&target, dst).map_err(|e| format!("cannot copy link {}: {e}", src.display()));
        }
        #[cfg(not(unix))]
        {
            let _ = target;
            return Err(format!("{} is a link, which this platform cannot cache", src.display()));
        }
    }
    if ft.is_dir() {
        std::fs::create_dir(dst).map_err(|e| format!("cannot create {}: {e}", dst.display()))?;
        let mut names: Vec<std::ffi::OsString> = std::fs::read_dir(src)
            .map_err(|e| format!("cannot list {}: {e}", src.display()))?
            .flatten()
            .map(|e| e.file_name())
            .collect();
        names.sort();
        for name in names {
            copy_tree(&src.join(&name), &dst.join(&name), depth + 1, budget)?;
        }
        std::fs::set_permissions(dst, meta.permissions()).map_err(|e| format!("cannot set permissions on {}: {e}", dst.display()))?;
        return Ok(());
    }
    if ft.is_file() {
        std::fs::copy(src, dst).map_err(|e| format!("cannot copy {}: {e}", src.display()))?;
    }
    Ok(())
}

/// Copies one cached or built path. On macOS an APFS clone (`cp -c`) is tried first: it is near-instant and still an
/// independent copy; any failure falls back to the plain copy above.
fn copy_path(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    #[cfg(target_os = "macos")]
    {
        let cloned = std::process::Command::new("/bin/cp").arg("-cR").arg(src).arg(dst).output().map(|o| o.status.success()).unwrap_or(false);
        if cloned && entry_exists(dst) {
            return Ok(());
        }
        let _ = remove_any(dst);
    }
    let mut budget = MAX_ENTRIES;
    let result = copy_tree(src, dst, 0, &mut budget);
    if result.is_err() {
        let _ = remove_any(dst);
    }
    result
}

fn remove_any(p: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(p),
        Ok(_) => std::fs::remove_file(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Removes the `paths` entries a failed setup created (they were absent before it ran). A symlink is removed as a link,
/// and an entry whose parent folders pass through a symlink is left alone, so nothing outside the worktree is touched.
fn remove_created(worktree: &Path, created: &[&String]) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    for rel in created {
        let rel = safe_rel(rel, "paths")?;
        let target = worktree.join(&rel);
        let mut walk = worktree.to_path_buf();
        let parts: Vec<&str> = rel.split('/').collect();
        let mut through_link = false;
        for part in &parts[..parts.len() - 1] {
            walk.push(part);
            if std::fs::symlink_metadata(&walk).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                through_link = true;
                break;
            }
        }
        if through_link {
            errors.push(format!("{rel}: a parent folder is a symlink"));
        } else if let Err(e) = remove_any(&target) {
            errors.push(format!("{rel}: {e}"));
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}

/// The spellings of a worktree path that may be baked into files: as given, and fully resolved.
fn path_variants(p: &Path) -> Vec<String> {
    let mut out = vec![p.to_string_lossy().into_owned()];
    if let Ok(c) = std::fs::canonicalize(p) {
        let s = c.to_string_lossy().into_owned();
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// Rewrites `old` to `new` in the small text files under `dir` (never binaries, never links).
fn rewrite_prefix(dir: &Path, pairs: &[(String, String)], depth: usize, budget: &mut usize) -> Result<(), String> {
    if depth > MAX_DEPTH || *budget == 0 {
        return Err("the restored environment is too large to adjust".into());
    }
    *budget -= 1;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    if meta.is_dir() {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?.flatten() {
            rewrite_prefix(&entry.path(), pairs, depth + 1, budget)?;
        }
        return Ok(());
    }
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_REWRITE_FILE_BYTES {
        return Ok(());
    }
    let Ok(bytes) = std::fs::read(dir) else { return Ok(()) };
    if bytes.contains(&0) {
        return Ok(());
    }
    let Ok(text) = String::from_utf8(bytes) else { return Ok(()) };
    if !pairs.iter().any(|(old, _)| text.contains(old.as_str())) {
        return Ok(());
    }
    let mut next = text;
    for (old, new) in pairs {
        next = next.replace(old.as_str(), new);
    }
    std::fs::write(dir, next).map_err(|e| format!("cannot update {}: {e}", dir.display()))
}

fn read_origin(entry: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(entry.join("meta.json")) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    v.get("origins").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// Copies the cached paths for `key` into `worktree`. `Ok(false)` is a miss. A path that already exists in the worktree
/// is left alone. Text files that name the folder the environment was built in are pointed at `worktree`.
pub(crate) fn restore(project: &Path, worktree: &Path, spec: &EnvCacheSpec, key: &str) -> Result<bool, String> {
    let entry = cache_root(project).join(key);
    let files = entry.join("files");
    if !files.is_dir() || !spec.paths.iter().all(|p| entry_exists(&files.join(p))) {
        return Ok(false);
    }
    // Every spelling the old worktree had becomes the new worktree's resolved path: it names the same folder as any
    // other spelling, and it is the one a process started inside it sees as its working directory.
    let new = path_variants(worktree).pop().unwrap_or_default();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for old in read_origin(&entry) {
        if !old.is_empty() && old != new {
            pairs.push((old, new.clone()));
        }
    }
    pairs.sort_by_key(|(old, _)| std::cmp::Reverse(old.len()));
    for rel in &spec.paths {
        let dst = worktree.join(rel);
        if entry_exists(&dst) {
            continue;
        }
        copy_path(&files.join(rel), &dst)?;
        if !pairs.is_empty() {
            let mut budget = MAX_ENTRIES;
            if let Err(e) = rewrite_prefix(&dst, &pairs, 0, &mut budget) {
                let _ = remove_any(&dst);
                return Err(e);
            }
        }
    }
    #[cfg(unix)]
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(entry.join("meta.json")) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
    Ok(true)
}

/// Stores the built `paths` of `worktree` under `key`. Built beside the final folder and renamed into place, so a
/// reader never sees a half-written entry and two runs that built the same key at once simply keep the first.
pub(crate) fn save(project: &Path, worktree: &Path, spec: &EnvCacheSpec, key: &str) -> Result<(), String> {
    let root = cache_root(project);
    let finalized = root.join(key);
    if finalized.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create the environment cache folder: {e}"))?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = root.join(format!(".tmp-{}-{nanos}", std::process::id()));
    let built = (|| -> Result<(), String> {
        for rel in &spec.paths {
            let src = worktree.join(rel);
            if !entry_exists(&src) {
                return Err(format!("the setup command did not create {rel}"));
            }
            copy_path(&src, &tmp.join("files").join(rel))?;
        }
        let meta = serde_json::json!({ "origins": path_variants(worktree) });
        std::fs::write(tmp.join("meta.json"), meta.to_string()).map_err(|e| format!("cannot write the cache entry: {e}"))
    })();
    if let Err(e) = built {
        let _ = remove_any(&tmp);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp, &finalized) {
        let _ = remove_any(&tmp);
        if !finalized.exists() {
            return Err(format!("cannot store the environment cache: {e}"));
        }
    }
    prune(&root, key);
    Ok(())
}

/// Keeps the `MAX_KEYS_KEPT` most recently used keys (and always `keep`); drops stale half-built folders.
fn prune(root: &Path, keep: &str) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let mut keys: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        let used = std::fs::metadata(path.join("meta.json")).or_else(|_| std::fs::metadata(&path)).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        if name.starts_with(".tmp-") {
            let stale = std::time::SystemTime::now().duration_since(used).map(|d| d.as_secs() > 3600).unwrap_or(false);
            if stale {
                let _ = remove_any(&path);
            }
            continue;
        }
        if name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) {
            keys.push((used, path));
        }
    }
    keys.sort_by_key(|(used, _)| std::cmp::Reverse(*used));
    for (i, (_, path)) in keys.iter().enumerate() {
        if i >= MAX_KEYS_KEPT && path.file_name().and_then(|n| n.to_str()) != Some(keep) {
            let _ = remove_any(path);
        }
    }
}

fn tail(s: &str) -> String {
    let n = s.chars().count();
    if n <= OUTPUT_TAIL_CHARS { s.to_string() } else { s.chars().skip(n - OUTPUT_TAIL_CHARS).collect() }
}

/// Makes the run's environment ready before its first stage. `token` is the loop's approval token (the setup command
/// is part of that approval); it is needed only on a miss, because only a miss runs a command.
pub(crate) fn prepare_gated(root: &Path, worktree: &Path, run_id: &str, loop_id: &str, timeout_secs: Option<u64>, store: &ApprovalStore, token: Option<&str>) -> Result<EnvPrepare, String> {
    let Some(spec) = read_spec(root, loop_id)? else {
        return Ok(EnvPrepare::of("none", "No environment cache is set for this loop.", None));
    };
    let (project, work) = canonical_roots(root)?;
    // A Stop pressed during an earlier prepare must not make this one (a Resume of the same run) cancel at once.
    clear_cancel(run_id);
    if spec.paths.iter().all(|p| entry_exists(&worktree.join(p))) {
        return Ok(EnvPrepare::of("present", "The environment is already in the worktree.", None));
    }
    let key = cache_key(worktree, &spec)?;
    let short = key[..12].to_string();
    if restore(&project, worktree, &spec, &key)? {
        return Ok(EnvPrepare::of("restored", format!("Environment restored from the cache ({short})."), Some(key)));
    }
    let token = token.ok_or_else(|| "the environment setup needs a native host approval before it can run".to_string())?;
    store.authorize_stage_at(token, &project, &work, loop_id, ENV_CACHE_STAGE_ID, &spec.setup, crate::confirm::now_ms())?;
    // Only what setup itself creates may be undone on failure, so remember what was absent before it ran.
    let absent: Vec<&String> = spec.paths.iter().filter(|p| !entry_exists(&worktree.join(p))).collect();
    let run = run_command_keyed(worktree, &spec.setup, Some(timeout_secs.unwrap_or(DEFAULT_SETUP_TIMEOUT_SECS)), run_id)?;
    let output = tail(&format!("{}{}", run.stdout, run.stderr));
    if run.cancelled || run.timed_out || run.exit_code != Some(0) {
        let why = if run.cancelled { "was cancelled" } else if run.timed_out { "timed out" } else { "failed" };
        let mut message = format!("The environment setup {why}.");
        // A half-built environment must not look ready to the next prepare (failed runs keep their worktree).
        if let Err(e) = remove_created(worktree, &absent) {
            message.push_str(&format!(" The half-built environment could not be removed: {e}"));
        }
        return Ok(EnvPrepare { status: "failed", message, key: Some(key), output: Some(output) });
    }
    match save(&project, worktree, &spec, &key) {
        Ok(()) => Ok(EnvPrepare { status: "built", message: format!("Environment built and cached ({short})."), key: Some(key), output: Some(output) }),
        Err(e) => Ok(EnvPrepare { status: "built", message: format!("Environment built; it could not be cached: {e}"), key: Some(key), output: Some(output) }),
    }
}

/// Tauri command. The run's own project and worktree come from `loop_worktree` (never from the page); the webview names
/// only the loop and carries the approval token minted for it.
#[tauri::command]
pub async fn loop_env_prepare(loop_id: String, run_id: String, approval_token: Option<String>, timeout_secs: Option<u64>) -> Result<EnvPrepare, String> {
    if !crate::loop_worktree::valid_run_id(&run_id) {
        return Err("invalid run id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (project, work) = root_for(Some(&run_id))?;
        prepare_gated(&project, &work, &run_id, &loop_id, timeout_secs, crate::loop_approval::store(), approval_token.as_deref())
    })
    .await
    .map_err(|e| format!("environment setup task failed: {e}"))?
}

#[cfg(test)]
#[path = "loop_env_cache_tests.rs"]
mod tests;
