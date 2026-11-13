//! Native Loop stage execution, first slice. Only a `shellCommand` stage read by the host from the project's
//! working-tree `system/loop.json` can run, and only after a NATIVE host approval pinned to that exact command's
//! SHA-256 (`loop_approval.rs`). The webview names a stage id, never a command string; it cannot ask the host to
//! execute arbitrary shell, and editing `system/loop.json` after approval invalidates the approval. The user starts
//! the stage from the Loop page (one native dialog per loop or stage).
//!
//! Output is captured with bounded buffers; the process is killed on timeout or when the caller cancels by dropping
//! the task (the async command is blocking, so cancellation is bounded by the timeout).
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::loop_approval::ApprovalStore;
use crate::proc_tree::ManagedChild;

/// Cancel requests keyed by run id; `""` is the legacy run that has no id. Stop on one run never stops another.
static CANCEL: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn cancel_set() -> MutexGuard<'static, HashSet<String>> {
    CANCEL.lock().unwrap_or_else(|p| p.into_inner())
}

pub(crate) fn is_cancelled(key: &str) -> bool {
    cancel_set().contains(key)
}

/// A run (or its next stage) starts uncancelled: a Stop pressed while idle must not abort it.
pub(crate) fn clear_cancel(key: &str) {
    cancel_set().remove(key);
}

pub(crate) fn request_cancel(key: &str) {
    cancel_set().insert(key.to_string());
}

/// App exit: every stage command still running is stopped, and none starts afterwards.
///
/// A stage leads its own process group on unix, so it does not die with the app: a `make regression` started by a
/// Loop or by Self-Heal would keep writing in the project (or its worktree) with nothing watching it, and the next
/// launch would know nothing about it. Windows ends the stage's job with the process, so this only makes it prompt.
pub(crate) struct ExitGate {
    exiting: AtomicBool,
    live: std::sync::atomic::AtomicUsize,
}

impl ExitGate {
    pub(crate) const fn new() -> Self {
        ExitGate { exiting: AtomicBool::new(false), live: std::sync::atomic::AtomicUsize::new(0) }
    }
    fn exiting(&self) -> bool { self.exiting.load(Ordering::SeqCst) }
    /// Asks every running stage to stop without waiting (for a path that must not block, such as the panic hook).
    pub(crate) fn request_stop(&self) { self.exiting.store(true, Ordering::SeqCst); }
    /// The exit was called off and the app keeps running (an update whose install failed): stages may run again.
    /// Without this the gate would refuse every Loop and Self-Heal stage as "cancelled" until the next launch.
    pub(crate) fn reopen(&self) { self.exiting.store(false, Ordering::SeqCst); }
    /// Asks every running stage to stop and waits until they have (each is terminated with its process group), up to
    /// `wait`. Returns how many were still running when the wait ended.
    pub(crate) fn stop_all(&self, wait: Duration) -> usize {
        self.request_stop();
        let until = Instant::now() + wait;
        loop {
            let live = self.live.load(Ordering::SeqCst);
            if live == 0 || Instant::now() >= until { return live; }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

static EXIT_GATE: ExitGate = ExitGate::new();

/// Called from the app's exit paths (`exit_cleanup`, the signal handler). A stage gets 2 s to end after SIGTERM before
/// it is killed, so the wait covers that and a little more.
pub(crate) fn stop_all_for_exit() -> usize {
    EXIT_GATE.stop_all(Duration::from_millis(3500))
}

/// Non-blocking form for the panic hook: running stages stop on their own threads' next poll.
pub(crate) fn request_stop_all_for_exit() {
    EXIT_GATE.request_stop();
}

/// The app did not exit after all (see `ExitGate::reopen`).
pub(crate) fn resume_after_cancelled_exit() {
    EXIT_GATE.reopen();
}

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StageRun {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoopStageResult {
    pub stage_id: String,
    pub stage_name: String,
    pub severity: String,
    pub run: StageRun,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoopRunResult {
    pub loop_id: String,
    pub loop_name: String,
    pub passed: bool,
    pub stages: Vec<LoopStageResult>,
}

const MAX_CAPTURE: usize = 400_000;
const DEFAULT_TIMEOUT_SECS: u64 = 600;

fn clipped(mut s: String) -> String {
    if s.len() > MAX_CAPTURE {
        let mut cut = MAX_CAPTURE;
        while !s.is_char_boundary(cut) { cut -= 1; }
        s.truncate(cut);
        s.push_str("\n… output truncated by the desktop host");
    }
    s
}

fn read_capped_stream<R: Read + Send + 'static>(mut reader: R, sink: Option<Arc<dyn Fn(&str, bool) + Send + Sync>>, stdout: bool) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if kept.len() < MAX_CAPTURE { let room = (MAX_CAPTURE - kept.len()).min(n); kept.extend_from_slice(&buf[..room]); }
                    if let Some(cb) = &sink { cb(&String::from_utf8_lossy(&buf[..n]), stdout); }
                }
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&kept).into_owned());
    });
    rx
}

/// The Mac runs a Loop in the project's git root (the first code repo), not necessarily the project root. A
/// project that is itself a git repo wins; otherwise the first `code/*` directory is the working tree.
pub fn work_root(root: &Path) -> std::path::PathBuf {
    if root.join(".git").exists() { return root.to_path_buf(); }
    let code = root.join("code");
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&code).ok().into_iter().flatten().flatten()
        .map(|e| e.path()).filter(|p| p.is_dir() && !p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with('.')).unwrap_or(false)).collect();
    dirs.sort();
    if let Some(repo) = dirs.iter().find(|p| p.join(".git").exists()) { return repo.clone(); }
    dirs.into_iter().next().unwrap_or_else(|| root.to_path_buf())
}

/// One stage read by the host from `system/loop.json`. `command` is the exact string that was approved and will be
/// run; the webview never supplies it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StageSpec {
    pub loop_id: String,
    pub stage_id: String,
    pub name: String,
    pub kind: String,
    pub command: String,
}

/// One saved fault `verify:` command read by the host. `rel` is the project-relative, `/`-separated path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FaultSpec {
    pub rel: String,
    pub command: String,
}

fn read_loop_json(root: &Path) -> Result<serde_json::Value, String> {
    let path = root.join("system").join("loop.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read system/loop.json: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("system/loop.json is not valid JSON: {e}"))
}

pub(crate) fn loop_name(root: &Path, loop_id: &str) -> Result<String, String> {
    let v = read_loop_json(root)?;
    let loops = v.get("loops").and_then(|x| x.as_array()).ok_or("system/loop.json has no loops")?;
    let l = loops.iter().find(|l| l.get("id").and_then(|x| x.as_str()) == Some(loop_id)).ok_or("that loop is not in system/loop.json")?;
    Ok(l.get("name").and_then(|x| x.as_str()).unwrap_or("Loop").to_string())
}

pub(crate) fn loop_has_enabled_kind(root: &Path, loop_id: &str, kind: &str) -> Result<bool, String> {
    let v = read_loop_json(root)?;
    let loops = v.get("loops").and_then(|x| x.as_array()).ok_or("system/loop.json has no loops")?;
    let l = loops.iter().find(|l| l.get("id").and_then(|x| x.as_str()) == Some(loop_id)).ok_or("that loop is not in system/loop.json")?;
    let stages = l.get("config").and_then(|c| c.get("stages")).and_then(|s| s.as_array()).ok_or("loop has no stages")?;
    Ok(stages.iter().any(|s| s.get("enabled").and_then(|x| x.as_bool()) == Some(true) && s.get("kind").and_then(|x| x.as_str()) == Some(kind)))
}

/// Resolves a stage by id, host-side. When `loop_id` is given the stage must belong to that loop; otherwise the
/// first matching stage across the file wins (older callers). No command is accepted from the caller.
pub(crate) fn resolve_stage(root: &Path, stage_id: &str, loop_id: Option<&str>) -> Result<StageSpec, String> {
    let v = read_loop_json(root)?;
    let loops = v.get("loops").and_then(|x| x.as_array()).ok_or("system/loop.json has no loops")?;
    for l in loops {
        let lid = l.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if loop_id.is_some_and(|want| want != lid) { continue; }
        let Some(stages) = l.get("config").and_then(|c| c.get("stages")).and_then(|s| s.as_array()) else { continue };
        for s in stages {
            if s.get("id").and_then(|x| x.as_str()) != Some(stage_id) { continue; }
            return Ok(StageSpec {
                loop_id: lid.to_string(),
                stage_id: stage_id.to_string(),
                name: s.get("name").and_then(|x| x.as_str()).unwrap_or("Stage").to_string(),
                kind: s.get("kind").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                command: s.get("command").and_then(|x| x.as_str()).unwrap_or("").trim().to_string(),
            });
        }
    }
    Err("that stage is not in system/loop.json".into())
}

/// The command of a shell stage, retained for the stage-only path and tests. No command is accepted from the caller.
#[cfg(test)]
pub(crate) fn stage_command(root: &Path, stage_id: &str) -> Result<String, String> {
    let s = resolve_stage(root, stage_id, None)?;
    if s.kind != "shellCommand" { return Err("only shellCommand stages can run in this slice".into()); }
    if s.command.is_empty() { return Err("this stage has no command".into()); }
    Ok(s.command)
}

/// Every ENABLED `shellCommand` stage of one loop, in file order. This is the host's own derivation of what an
/// approval for this loop must cover; it never comes from the webview.
pub(crate) fn loop_shell_stages(root: &Path, loop_id: &str) -> Result<Vec<StageSpec>, String> {
    let v = read_loop_json(root)?;
    let loops = v.get("loops").and_then(|x| x.as_array()).ok_or("system/loop.json has no loops")?;
    let l = loops.iter().find(|l| l.get("id").and_then(|x| x.as_str()) == Some(loop_id)).ok_or("that loop is not in system/loop.json")?;
    let stages = l.get("config").and_then(|c| c.get("stages")).and_then(|s| s.as_array()).ok_or("loop has no stages")?;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for s in stages {
        if s.get("enabled").and_then(|x| x.as_bool()) != Some(true) { continue; }
        if s.get("kind").and_then(|x| x.as_str()) != Some("shellCommand") { continue; }
        let name = s.get("name").and_then(|x| x.as_str()).unwrap_or("Stage").to_string();
        let id = s.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if id.is_empty() { return Err(format!("“{name}” has no stage id")); }
        if !seen.insert(id.clone()) { return Err(format!("“{name}” reuses a stage id in this loop; an approval could not tell the stages apart")); }
        let command = s.get("command").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if command.is_empty() { return Err(format!("“{name}” has no command")); }
        out.push(StageSpec {
            loop_id: loop_id.to_string(),
            stage_id: id,
            name,
            kind: "shellCommand".to_string(),
            command,
        });
    }
    Ok(out)
}

fn stage_frontmatter_verify(text: &str) -> Option<String> {
    let mut verify = None;
    for line in text.lines() {
        let t = line.trim();
        if let Some(v) = t.strip_prefix("verify:") {
            let v = v.trim();
            if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
                if let Ok(s) = serde_json::from_str::<String>(v) { verify = Some(s); }
            } else if !v.is_empty() { verify = Some(v.to_string()); }
            break;
        }
    }
    verify.filter(|c| !c.trim().is_empty())
}

/// Reads one fault report's `verify:` command. The caller names the project-relative path; never a command.
pub(crate) fn fault_verify_command_in(root: &Path, rel: &str) -> Result<String, String> {
    let p = crate::fs_ops::resolve_existing(root, rel).map_err(|e| e.message)?;
    let text = std::fs::read_to_string(&p).map_err(|e| format!("cannot read the fault report: {e}"))?;
    stage_frontmatter_verify(&text).ok_or_else(|| "this fault has no verify command".into())
}

fn walk_faults(dir: &Path, rel_prefix: &str, depth: usize, out: &mut Vec<FaultSpec>, budget: &mut usize) -> Result<(), String> {
    if depth > 8 { return Err("the fault reports are nested too deeply to approve".into()); }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        if meta.file_type().is_symlink() { continue; }
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
        if name.starts_with('.') { continue; }
        let rel = format!("{rel_prefix}/{name}");
        if meta.is_dir() {
            walk_faults(&p, &rel, depth + 1, out, budget)?;
            continue;
        }
        if p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("md")) != Some(true) { continue; }
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if meta.len() > 2_000_000 { continue; }
        if meta.len() as usize > FAULT_SCAN_BYTES.saturating_sub(*budget) {
            return Err("there is too much fault text to show in one approval dialog; run the faults individually".into());
        }
        *budget += meta.len() as usize;
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        if let Some(command) = stage_frontmatter_verify(&text) {
            out.push(FaultSpec { rel, command });
            if out.len() > 500 { return Err("there are more than 500 fault verify commands to approve; run the faults individually".into()); }
        }
    }
    Ok(())
}

/// Most fault text one approval scans, so a huge faults folder cannot make the dialog allocate without bound.
const FAULT_SCAN_BYTES: usize = 8_000_000;

/// Every fault `verify:` command under the project's `system/faults` AND, when the Loop runs in a `code/<repo>`
/// working tree, that tree's `system/faults` (the UI lists the latter). Paths are project-relative, so they match
/// what `loop_run_fault_verify` resolves. The host's own list, never the webview's.
pub(crate) fn fault_commands(root: &Path) -> Result<Vec<FaultSpec>, String> {
    let project = crate::fs_ops::checked_root(root).map_err(|e| e.message)?;
    let work = work_root(&project);
    let mut out = Vec::new();
    let mut budget = 0usize;
    walk_faults(&project.join("system").join("faults"), "system/faults", 0, &mut out, &mut budget)?;
    if let Ok(rel) = work.strip_prefix(&project) {
        let rel = rel.to_string_lossy().replace('\\', "/");
        if !rel.is_empty() {
            walk_faults(&work.join("system").join("faults"), &format!("{rel}/system/faults"), 0, &mut out, &mut budget)?;
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out.dedup_by(|a, b| a.rel == b.rel);
    Ok(out)
}

/// Normalises a project-relative path (`a/b/c`) for use as an approval key.
pub(crate) fn normalized_rel(rel: &str) -> Result<String, String> {
    let parts = crate::fs_ops::split_rel(rel).map_err(|e| e.message)?;
    Ok(parts.join("/"))
}

/// SHA-256 of the EXACT command bytes. An approval is valid only for this hash; editing the command changes it.
pub(crate) fn command_hash(command: &str) -> String {
    let mut h = Sha256::new();
    h.update(command.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The canonical project root and the Loop working folder an approval is bound to.
pub(crate) fn canonical_roots(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let project = crate::fs_ops::checked_root(root).map_err(|e| e.message)?;
    let work = work_root(&project);
    let work = std::fs::canonicalize(&work).map_err(|e| format!("cannot resolve the Loop working folder: {e}"))?;
    Ok((project, work))
}

/// (project, work) for a Loop host command. `None`: the active project and its `work_root`, exactly as before.
/// `Some(run_id)`: the run's own project and worktree from `loop_worktree::resolve` (registry first, ownership
/// re-checked), never `active_root()`, so switching project mid-run cannot move a run.
pub(crate) fn root_for(run_id: Option<&str>) -> Result<(PathBuf, PathBuf), String> {
    match run_id {
        None => {
            let root = crate::project::active_root().ok_or_else(|| "open a project first".to_string())?;
            crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
            let work = work_root(&root);
            Ok((root, work))
        }
        Some(id) => {
            let info = crate::loop_worktree::resolve(id)?;
            Ok((PathBuf::from(info.project), PathBuf::from(info.worktree)))
        }
    }
}

/// True when any `system/faults/**/*.md` is still marked `status: fixed`. The desktop's deterministic slice cannot
/// re-ask the agent those questions, so it refuses rather than reporting a green sweep it never performed.
fn has_fixed_faults(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() { if has_fixed_faults(&p) { return true; } continue; }
        if p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("md")) != Some(true) { continue; }
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        let head = text.split("\n---").next().unwrap_or("");
        if head.lines().any(|l| l.trim().eq_ignore_ascii_case("status: fixed")) { return true; }
    }
    false
}

fn run_regression(root: &Path) -> Result<StageRun, String> {
    if has_fixed_faults(&root.join("system").join("faults")) {
        return Err("the Regression sweep has fixed faults to re-ask; the native regression/agent slice is not ported yet".into());
    }
    Ok(StageRun {
        exit_code: Some(0), stdout: "No fixed faults to re-check.".into(), stderr: String::new(),
        timed_out: false, cancelled: false, duration_ms: 0,
    })
}

/// Reads a fault report's `verify` command (frontmatter) and runs it in the git root, but ONLY when the host holds
/// a native approval for this exact project-relative path and command hash. The webview supplies only the path.
pub(crate) fn run_fault_verify_gated(root: &Path, rel: &str, timeout_secs: Option<u64>, store: &ApprovalStore, token: Option<&str>) -> Result<StageRun, String> {
    let command = fault_verify_command_in(root, rel)?;
    let (project, work) = canonical_roots(root)?;
    let key = normalized_rel(rel)?;
    let token = token.ok_or_else(|| "this fault verify command needs a native host approval before it can run".to_string())?;
    store.authorize_fault_at(token, &project, &work, &key, &command, crate::confirm::now_ms())?;
    run_command_at(&work, &command, timeout_secs)
}

/// Runs one already-saved stage. A shell stage requires a native host approval pinned to its exact command; a
/// Regression stage runs its deterministic slice without shell. Nothing is spawned until the approval checks pass.
pub(crate) fn run_stage_gated(root: &Path, stage_id: &str, loop_id: Option<&str>, timeout_secs: Option<u64>, store: &ApprovalStore, token: Option<&str>) -> Result<StageRun, String> {
    run_stage_gated_at(root, None, stage_id, loop_id, timeout_secs, store, token)
}

/// `run_stage_gated` for a factory run. `run` is `Some((worktree, run_id))`: the approval is still checked against
/// the PROJECT's canonical roots (the hash-pinned grant the Loop page minted for `root`), then the approved command
/// starts in the run's worktree and stops only on that run's cancel. `None` is the legacy path, unchanged.
pub(crate) fn run_stage_gated_at(root: &Path, run: Option<(&Path, &str)>, stage_id: &str, loop_id: Option<&str>, timeout_secs: Option<u64>, store: &ApprovalStore, token: Option<&str>) -> Result<StageRun, String> {
    let spec = resolve_stage(root, stage_id, loop_id)?;
    match spec.kind.as_str() {
        // NOTE: run_regression reads the MAIN project's system/faults, which a factory worktree run must never inspect.
        "regressionSweep" if run.is_some() => Err("Regression stages cannot run in a factory worktree".into()),
        "regressionSweep" => run_regression(root),
        "shellCommand" => {
            if spec.command.is_empty() { return Err("this stage has no command".into()); }
            let (project, work) = canonical_roots(root)?;
            let token = token.ok_or_else(|| "this shell stage needs a native host approval before it can run".to_string())?;
            store.authorize_stage_at(token, &project, &work, &spec.loop_id, &spec.stage_id, &spec.command, crate::confirm::now_ms())?;
            match run {
                Some((worktree, run_id)) => run_command_keyed(worktree, &spec.command, timeout_secs, run_id),
                None => run_command_at(&work, &spec.command, timeout_secs),
            }
        }
        _ => Err("only shellCommand and regressionSweep stages can run in this slice".into()),
    }
}

/// The shell command actually runs in `work` (the approved working folder), never in a folder re-derived later.
fn run_command_at(work: &Path, command: &str, timeout_secs: Option<u64>) -> Result<StageRun, String> {
    run_command_keyed(work, command, timeout_secs, "")
}

/// `run_command_at`, stopped only by a cancel for `key` (a run id, or `""` for the legacy run).
fn run_command_keyed(work: &Path, command: &str, timeout_secs: Option<u64>, key: &str) -> Result<StageRun, String> {
    run_command_at_cancellable(work, command, timeout_secs, None, &|| is_cancelled(key))
}

/// The shell a saved stage command runs in: `/bin/sh -lc`, like the Mac app's Loop. Windows has no `/bin/sh`, so
/// there it is the system `cmd.exe /D /S /C` (`/D` skips AutoRun hooks; `/S` takes the quoted command verbatim).
#[cfg(not(windows))]
fn stage_shell(command: &str) -> Command {
    let mut c = Command::new("/bin/sh");
    c.arg("-lc").arg(command);
    c
}

#[cfg(windows)]
fn stage_shell(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let root = std::env::var_os("SystemRoot").filter(|s| !s.is_empty()).unwrap_or_else(|| "C:\\Windows".into());
    let mut c = Command::new(std::path::PathBuf::from(root).join("System32").join("cmd.exe"));
    c.raw_arg(format!("/D /S /C \"{command}\""));
    // cmd.exe otherwise runs a bare name from the working folder before PATH (a repo's own `git.bat`); sh never does.
    c.env("NoDefaultCurrentDirectoryInExePath", "1");
    c
}

/// Repo overrides an inherited environment can carry (a host started from a git hook or a terminal with GIT_DIR set):
/// with one of them, every git call below would act on some other repository or index.
pub const GIT_OVERRIDES: &[&str] = &[
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE", "GIT_PREFIX", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
];

pub fn strip_git_env(c: &mut Command) {
    for k in GIT_OVERRIDES {
        c.env_remove(k);
    }
}

/// `git` with the inherited repo overrides removed.
pub fn git_command() -> Command {
    let mut c = Command::new("git");
    strip_git_env(&mut c);
    c
}

/// The host-controlled shell helper for Self-Heal's fixed `scripts/self-heal-verify.sh` run. It is NOT a Loop entry
/// point: every Loop shell command goes through `run_stage_gated` / `run_loop_gated` / `run_fault_verify_gated`.
pub(crate) fn run_command_cancellable(root: &Path, command: &str, timeout_secs: Option<u64>, sink: Option<Arc<dyn Fn(&str, bool) + Send + Sync>>, cancel: &AtomicBool) -> Result<StageRun, String> {
    run_command_at_cancellable(&work_root(root), command, timeout_secs, sink, &|| cancel.load(Ordering::SeqCst))
}

fn run_command_at_cancellable(work: &Path, command: &str, timeout_secs: Option<u64>, sink: Option<Arc<dyn Fn(&str, bool) + Send + Sync>>, stop_requested: &dyn Fn() -> bool) -> Result<StageRun, String> {
    run_command_at_gated(work, command, timeout_secs, sink, stop_requested, &EXIT_GATE)
}

fn run_command_at_gated(work: &Path, command: &str, timeout_secs: Option<u64>, sink: Option<Arc<dyn Fn(&str, bool) + Send + Sync>>, stop_requested: &dyn Fn() -> bool, gate: &ExitGate) -> Result<StageRun, String> {
    // Counted for the whole call, so the exit path waits until the child (and its group) has really been stopped.
    struct Live<'a>(&'a ExitGate);
    impl Drop for Live<'_> {
        fn drop(&mut self) { self.0.live.fetch_sub(1, Ordering::SeqCst); }
    }
    gate.live.fetch_add(1, Ordering::SeqCst);
    let _live = Live(gate);
    let stop_requested = || stop_requested() || gate.exiting();
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, 86_400));
    let started = Instant::now();
    if stop_requested() {
        return Ok(StageRun { exit_code: None, stdout: String::new(), stderr: String::new(), timed_out: false, cancelled: true, duration_ms: 0 });
    }
    let mut cmd = stage_shell(command);
    strip_git_env(&mut cmd);
    cmd
        // cmd.exe cannot start in a `\\?\` folder (it falls back to the Windows folder).
        .current_dir(crate::fsutil::plain_path(work))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Own process group / job, so a timeout or cancel stops the stage's children too, not only the shell.
    let mut child = ManagedChild::spawn(&mut cmd).map_err(|e| format!("cannot start the stage command: {e}"))?;
    let out_rx = child.child_mut().stdout.take().map(|r| read_capped_stream(r, sink.clone(), true));
    let err_rx = child.child_mut().stderr.take().map(|r| read_capped_stream(r, sink.clone(), false));
    let grace = Duration::from_secs(2);
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        let waited = match child.try_wait() {
            Ok(w) => w,
            Err(e) => {
                // Never leave the stage's process group running behind an early return.
                child.terminate(grace);
                return Err(format!("cannot wait for the stage: {e}"));
            }
        };
        match waited {
            Some(s) => break Some(s),
            None if stop_requested() => {
                cancelled = true;
                child.terminate(grace);
                break None;
            }
            None if started.elapsed() >= timeout => {
                timed_out = true;
                child.terminate(grace);
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(60)),
        }
    };
    let stdout = out_rx.and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok()).unwrap_or_default();
    let stderr = err_rx.and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok()).unwrap_or_default();
    Ok(StageRun {
        exit_code: status.and_then(|s| s.code()),
        stdout: clipped(stdout),
        stderr: clipped(stderr),
        timed_out,
        cancelled,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

struct LoopPlanStage {
    spec: StageSpec,
    severity: String,
}

/// Host-side plan for one loop: every enabled stage, with the exact command read here. A loop with any enabled stage
/// this native slice cannot run is refused before anything runs, instead of silently reporting a green run that
/// skipped the verification the user asked for.
fn build_loop_plan(root: &Path, loop_id: &str) -> Result<(String, Vec<LoopPlanStage>), String> {
    let v = read_loop_json(root)?;
    let loops = v.get("loops").and_then(|x| x.as_array()).ok_or("system/loop.json has no loops")?;
    let loop_v = loops.iter().find(|l| l.get("id").and_then(|x| x.as_str()) == Some(loop_id)).ok_or("that loop is not in system/loop.json")?;
    let loop_name = loop_v.get("name").and_then(|x| x.as_str()).unwrap_or("Loop").to_string();
    let stages = loop_v.get("config").and_then(|c| c.get("stages")).and_then(|s| s.as_array()).ok_or("loop has no stages")?;
    let mut plan = Vec::new();
    for s in stages {
        if s.get("enabled").and_then(|x| x.as_bool()) != Some(true) { continue; }
        let id = s.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let name = s.get("name").and_then(|x| x.as_str()).unwrap_or("Stage").to_string();
        let kind = s.get("kind").and_then(|x| x.as_str()).unwrap_or("");
        let severity = s.get("severity").and_then(|x| x.as_str()).unwrap_or("blocking").to_string();
        if kind != "shellCommand" && kind != "regressionSweep" {
            return Err(format!("“{name}” is a {kind} stage; this native slice runs shell-command and empty Regression stages"));
        }
        if kind == "regressionSweep" && has_fixed_faults(&root.join("system").join("faults")) {
            return Err(format!("“{name}” has fixed faults to re-ask; the native regression/agent slice is not ported yet"));
        }
        let command = s.get("command").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if kind == "shellCommand" && command.is_empty() { return Err(format!("“{name}” has no command")); }
        plan.push(LoopPlanStage {
            spec: StageSpec { loop_id: loop_id.to_string(), stage_id: id, name, kind: kind.to_string(), command },
            severity,
        });
    }
    if plan.is_empty() { return Err("this loop has no enabled stages".into()); }
    Ok((loop_name, plan))
}

/// Runs every enabled stage of one loop in order. Every shell command is authorised against the host's native
/// approval BEFORE the first process starts, so a changed command anywhere in the loop refuses the whole pass rather
/// than running the earlier stages and then stopping. Blocking failures stop the pass; advisory failures continue.
pub(crate) fn run_loop_gated(root: &Path, loop_id: &str, timeout_secs: Option<u64>, store: &ApprovalStore, token: Option<&str>) -> Result<LoopRunResult, String> {
    let (project, work) = canonical_roots(root)?;
    let (loop_name, plan) = build_loop_plan(root, loop_id)?;
    let shell: Vec<&LoopPlanStage> = plan.iter().filter(|p| p.spec.kind == "shellCommand").collect();
    if !shell.is_empty() {
        let token = token.ok_or_else(|| "this loop has shell commands that need a native host approval before they can run".to_string())?;
        let now = crate::confirm::now_ms();
        for p in &shell {
            store.authorize_stage_at(token, &project, &work, &p.spec.loop_id, &p.spec.stage_id, &p.spec.command, now)?;
        }
    }
    let mut results = Vec::new();
    let mut passed = true;
    for p in plan {
        let run = if p.spec.kind == "regressionSweep" { run_regression(root)? } else { run_command_at(&work, &p.spec.command, timeout_secs)? };
        let ok = !run.timed_out && run.exit_code == Some(0);
        results.push(LoopStageResult { stage_id: p.spec.stage_id, stage_name: p.spec.name, severity: p.severity.clone(), run });
        if !ok {
            passed = false;
            if p.severity == "blocking" { break; }
        }
    }
    Ok(LoopRunResult { loop_id: loop_id.to_string(), loop_name, passed, stages: results })
}

/// Tauri command. The stage id is resolved against the active project's loop.json; no command crosses IPC. A shell
/// stage must carry the host-minted approval token for its exact command.
#[tauri::command]
pub async fn loop_run_stage(stage_id: String, loop_id: Option<String>, approval_token: Option<String>, timeout_secs: Option<u64>, run_id: Option<String>) -> Result<StageRun, String> {
    clear_cancel(run_id.as_deref().unwrap_or(""));
    tauri::async_runtime::spawn_blocking(move || {
        let Some(id) = run_id.as_deref() else {
            let root = crate::project::active_root().ok_or_else(|| "open a project before running a Loop stage".to_string())?;
            crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
            return run_stage_gated(&root, &stage_id, loop_id.as_deref(), timeout_secs, crate::loop_approval::store(), approval_token.as_deref());
        };
        let (project, work) = root_for(Some(id))?;
        run_stage_gated_at(&project, Some((work.as_path(), id)), &stage_id, loop_id.as_deref(), timeout_secs, crate::loop_approval::store(), approval_token.as_deref())
    }).await.map_err(|e| format!("Loop stage task failed: {e}"))?
}

/// Stops one run: `None` is the legacy run (key ""), `Some(run_id)` only that run. A malformed id is ignored.
#[tauri::command]
pub fn loop_cancel(run_id: Option<String>) {
    match run_id.as_deref() {
        None => request_cancel(""),
        Some(id) if crate::loop_worktree::valid_run_id(id) => request_cancel(id),
        Some(_) => {}
    }
}

#[tauri::command]
pub fn loop_work_root() -> Result<String, String> {
    let root = crate::project::active_root().ok_or_else(|| "open a project first".to_string())?;
    crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
    Ok(work_root(&root).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn loop_run_loop(loop_id: String, approval_token: Option<String>, timeout_secs: Option<u64>) -> Result<LoopRunResult, String> {
    // A cancel pressed while idle must not stick and abort the next run before it starts.
    clear_cancel("");
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project::active_root().ok_or_else(|| "open a project before running a Loop".to_string())?;
        crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
        run_loop_gated(&root, &loop_id, timeout_secs, crate::loop_approval::store(), approval_token.as_deref())
    }).await.map_err(|e| format!("Loop task failed: {e}"))?
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentStatus {
    pub python: Option<String>,
    pub node: Option<String>,
    pub git: Option<String>,
}

fn version_of(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    if !out.status.success() { return None; }
    let text = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    if text.is_empty() { None } else { Some(text.chars().take(160).collect()) }
}

/// Fixed environment probe: no command comes from the page. Used by the Mac-style Environment card.
/// Runs the repo's own `mac/Scripts/feature-boundaries.sh` when present, in the git root, and parses its
/// `total: N` line. Absent/too-slow script returns None; the report is informational.
/// Changed paths in the run's worktree, from a fixed `git status --porcelain`. Used by the Loop run record.
/// Reverts a bounded set of repo-relative paths in the resolved worktree. The page supplies paths only; the host
/// rejects absolute/parent traversal and never accepts a command. Used by the protected-path and scope guard.
/// Tracked paths are restored from the index (`git checkout --`). An untracked path is removed only when it is in
/// `created` (the agent run's own `createdPaths`: absent before its Write), as the Mac's `revertUnlisted` does. Any
/// other untracked path (a user's file, an ignored file the agent overwrote) or an untracked directory refuses the whole
/// call before anything changes. Paths are literal pathspecs; a removal never follows a symlink out of `work`.
pub fn revert_paths_in(work: &Path, paths: &[String], created: &[String]) -> Result<(), String> {
    if paths.len() > 100 { return Err("too many paths to revert".into()); }
    for p in paths {
        let rel = std::path::Path::new(p);
        if p.is_empty() || rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
            return Err(format!("unsafe path: {p}"));
        }
    }
    let listed = git_command().arg("--literal-pathspecs").arg("-C").arg(crate::fsutil::plain_path(work)).args(["ls-files", "-z", "--"]).args(paths).output()
        .map_err(|e| format!("cannot run git ls-files: {e}"))?;
    if !listed.status.success() { return Err("git ls-files failed; nothing was reverted".into()); }
    let tracked: HashSet<String> = String::from_utf8_lossy(&listed.stdout).split('\0').map(|s| s.to_string()).collect();
    let (tracked_paths, untracked): (Vec<&String>, Vec<&String>) = paths.iter().partition(|p| tracked.contains(p.as_str()));
    let created: HashSet<&str> = created.iter().map(|s| s.as_str()).collect();
    let canon_work = work.canonicalize().map_err(|e| format!("cannot resolve the worktree: {e}"))?;
    for p in &untracked {
        let full = work.join(p.as_str());
        if full.is_dir() { return Err(format!("cannot revert untracked directory {p}; nothing was reverted")); }
        if !created.contains(p.as_str()) {
            return Err(format!("{p} is not tracked and the agent did not create it, so it may be your own file; nothing was reverted"));
        }
        let parent_ok = full.parent().and_then(|d| d.canonicalize().ok()).is_some_and(|d| d.starts_with(&canon_work));
        if !parent_ok { return Err(format!("{p} is not inside the worktree; nothing was reverted")); }
    }
    if !tracked_paths.is_empty() {
        let mut cmd = git_command();
        cmd.arg("--literal-pathspecs").arg("-C").arg(crate::fsutil::plain_path(work)).arg("checkout").arg("--");
        for p in &tracked_paths { cmd.arg(p.as_str()); }
        let out = cmd.output().map_err(|e| format!("cannot run git checkout: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("git checkout failed: {}", err.lines().next().unwrap_or("unknown error")));
        }
    }
    for p in &untracked {
        let full = work.join(p.as_str());
        // symlink_metadata: a symlink the agent created is removed itself, never its target.
        if std::fs::symlink_metadata(&full).is_ok_and(|m| m.is_file() || m.file_type().is_symlink()) {
            std::fs::remove_file(&full).map_err(|e| format!("cannot remove {p}: {e}"))?;
        }
    }
    Ok(())
}

/// True when `expected` (the project root the UI was given when the run started) names `active`. Separators are
/// compared as one kind: the Auto Task scheduler sends its root with `\` turned into `/`, and a false mismatch would
/// refuse every scheduled call on Windows (`\\?\C:\p` against `//?/C:/p`).
fn same_project_root(active: &Path, expected: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    norm(&active.to_string_lossy()) == norm(expected)
}

/// A main-tree run (no run id) works in whatever project is active at the moment of the call. If the user opened
/// another project mid-run, the run's "dirty before" snapshot belongs to the old project, and a revert judged against
/// it would discard the new project's uncommitted edits. So such a call is refused once the project has changed.
/// A worktree run is pinned by its run id and needs no check.
fn check_expected_root(run_id: Option<&str>, project: &Path, expected_root: Option<&str>) -> Result<(), String> {
    match (run_id, expected_root) {
        (None, Some(expected)) if !same_project_root(project, expected) => {
            Err("the project changed while this run was working; nothing was read or reverted in the other project".into())
        }
        _ => Ok(()),
    }
}

/// `loop_revert_paths` without Tauri: the legacy work root, or the run's worktree when `run_id` is given.
pub(crate) fn revert_paths_for(run_id: Option<&str>, expected_root: Option<&str>, paths: &[String], created: &[String]) -> Result<(), String> {
    let (project, work) = root_for(run_id)?;
    check_expected_root(run_id, &project, expected_root)?;
    revert_paths_in(&work, paths, created)
}

#[tauri::command]
pub async fn loop_revert_paths(paths: Vec<String>, created: Option<Vec<String>>, run_id: Option<String>, expected_root: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || revert_paths_for(run_id.as_deref(), expected_root.as_deref(), &paths, &created.unwrap_or_default()))
        .await.map_err(|e| format!("revert task failed: {e}"))?
}

/// Most paths the snapshot reads. Over this it errors rather than truncating: a cut-off list would make a dirty path
/// look clean, and the revert would then discard its uncommitted edits.
const MAX_CHANGED_PATHS: usize = 20_000;

/// Paths `git status --porcelain -z` reports in `work`, raw (no C-quoting, so spaces, " -> " and non-ASCII names come
/// back exactly as the agent run reports them). Both sides of a rename/copy are listed. Errors when git cannot answer
/// or the list is too long, so a caller never reads "unknown" as "clean" (the revert snapshot depends on that).
pub fn changed_paths_in(work: &Path) -> Result<Vec<String>, String> {
    let out = git_command().arg("-C").arg(crate::fsutil::plain_path(work)).args(["status", "--porcelain", "-z"]).output()
        .map_err(|e| format!("cannot run git status: {e}"))?;
    if !out.status.success() { return Err("git status failed; the changed paths are unknown".into()); }
    parse_porcelain_z(&String::from_utf8_lossy(&out.stdout))
}

/// Parses `git status --porcelain -z` output into sorted, unique paths. Split from `changed_paths_in` so a
/// crafted listing can be tested without a repository.
fn parse_porcelain_z(text: &str) -> Result<Vec<String>, String> {
    let mut paths: Vec<String> = Vec::new();
    let mut fields = text.split('\0');
    while let Some(entry) = fields.next() {
        if entry.len() < 4 { continue; }
        // Byte-indexed `get` rather than slicing: a non-ASCII byte at 3 must not panic the host.
        let (Some(status), Some(path)) = (entry.get(..3), entry.get(3..)) else { continue; };
        if !path.is_empty() { paths.push(path.to_string()); }
        let worktree_status = status.get(1..).unwrap_or("");
        // `-z` puts a rename/copy source in the next field, with no status of its own.
        if status.starts_with('R') || status.starts_with('C') || worktree_status.starts_with('R') || worktree_status.starts_with('C') {
            if let Some(src) = fields.next() { if !src.is_empty() { paths.push(src.to_string()); } }
        }
        if paths.len() > MAX_CHANGED_PATHS { return Err(format!("more than {MAX_CHANGED_PATHS} changed paths; the list is incomplete")); }
    }
    paths.sort(); paths.dedup();
    Ok(paths)
}

/// `loop_changed_paths` without Tauri: the legacy work root, or the run's worktree when `run_id` is given.
pub(crate) fn changed_paths_for(run_id: Option<&str>, expected_root: Option<&str>) -> Result<Vec<String>, String> {
    let (project, work) = root_for(run_id)?;
    check_expected_root(run_id, &project, expected_root)?;
    changed_paths_in(&work)
}

#[tauri::command]
pub async fn loop_changed_paths(run_id: Option<String>, expected_root: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || changed_paths_for(run_id.as_deref(), expected_root.as_deref()))
        .await.map_err(|e| format!("changed paths task failed: {e}"))?
}


#[tauri::command]
pub async fn loop_environment_check() -> Result<EnvironmentStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project::active_root().ok_or_else(|| "open a project first".to_string())?;
        crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
        Ok(EnvironmentStatus {
            python: version_of("python3", &["--version"]),
            node: version_of("node", &["--version"]),
            git: version_of("git", &["--version"]),
        })
    }).await.map_err(|e| format!("environment task failed: {e}"))?
}

#[tauri::command]
pub async fn loop_run_fault_verify(rel: String, approval_token: Option<String>, timeout_secs: Option<u64>) -> Result<StageRun, String> {
    clear_cancel("");
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project::active_root().ok_or_else(|| "open a project first".to_string())?;
        crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
        run_fault_verify_gated(&root, &rel, timeout_secs, crate::loop_approval::store(), approval_token.as_deref())
    }).await.map_err(|e| format!("fault verify task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stage command for the host's stage shell: `printf` under `/bin/sh`, `echo` under `cmd.exe` (whose output
    /// then ends in CRLF, so tests compare `trim_end`).
    fn cmd(s: &str) -> String {
        if cfg!(windows) { s.replace("printf ", "echo ") } else { s.to_string() }
    }

    use crate::loop_approval::{approve_loop_with, approve_stage_with, ApprovalStore};

    fn project(name: &str, command: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("llmide-loop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("system")).unwrap();
        std::fs::write(root.join("system/loop.json"), format!(r#"{{"schemaVersion":2,"loops":[{{"id":"l1","name":"L","config":{{"stages":[{{"id":"s1","name":"T","kind":"shellCommand","command":{command:?},"enabled":true,"order":0}}]}}}}]}}"#)).unwrap();
        root
    }

    fn approve_loop(store: &ApprovalStore, root: &Path) -> String {
        approve_loop_with(store, root, "l1", crate::confirm::now_ms(), |_, _| true)
            .expect("the approval step itself failed").expect("the fake dialog accepted").token
    }

    fn approve_stage(store: &ApprovalStore, root: &Path, stage_id: &str) -> String {
        approve_stage_with(store, root, stage_id, Some("l1"), crate::confirm::now_ms(), |_, _| true)
            .expect("the approval step itself failed").expect("the fake dialog accepted").token
    }

    fn run_approved(root: &Path, stage_id: &str, timeout_secs: u64) -> StageRun {
        let store = ApprovalStore::new();
        let token = approve_stage(&store, root, stage_id);
        run_stage_gated(root, stage_id, Some("l1"), Some(timeout_secs), &store, Some(&token)).unwrap()
    }

    #[test]
    fn only_saved_shell_stages_run_and_output_is_captured() {
        let line = if cfg!(windows) { "echo hello& echo err>&2& exit 3" } else { "printf hello; printf err >&2; exit 3" };
        let root = project("ok", line);
        assert_eq!(stage_command(&root, "s1").unwrap(), line);
        let store = ApprovalStore::new();
        let token = approve_stage(&store, &root, "s1");
        let r = run_stage_gated(&root, "s1", Some("l1"), Some(10), &store, Some(&token)).unwrap();
        assert_eq!(r.stdout.trim_end(), "hello");
        assert_eq!(r.stderr.trim_end(), "err");
        assert_eq!(r.exit_code, Some(3));
        assert!(!r.timed_out);
        assert!(stage_command(&root, "missing").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn loop_runs_shell_stages_in_order_and_stops_at_blocking_failure() {
        let root = project("loop", "printf one");
        std::fs::write(root.join("system/loop.json"), cmd(r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"maxIterations":2,"stages":[{"id":"s1","name":"One","kind":"shellCommand","command":"printf one","enabled":true,"severity":"blocking","order":0},{"id":"s2","name":"Two","kind":"shellCommand","command":"printf two","enabled":true,"severity":"blocking","order":1}]}}]}"#)).unwrap();
        let store = ApprovalStore::new();
        let token = approve_loop(&store, &root);
        let r = run_loop_gated(&root, "l1", Some(10), &store, Some(&token)).unwrap();
        assert!(r.passed);
        assert_eq!(r.stages.len(), 2);
        assert_eq!(r.stages[0].run.stdout.trim_end(), "one");
        assert_eq!(r.stages[1].run.stdout.trim_end(), "two");
        std::fs::write(root.join("system/loop.json"), cmd(r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"stages":[{"id":"s1","name":"One","kind":"shellCommand","command":"exit 1","enabled":true,"severity":"blocking","order":0},{"id":"s2","name":"Two","kind":"shellCommand","command":"printf two","enabled":true,"severity":"blocking","order":1}]}}]}"#)).unwrap();
        let token = approve_loop(&store, &root);
        let r = run_loop_gated(&root, "l1", Some(10), &store, Some(&token)).unwrap();
        assert!(!r.passed);
        assert_eq!(r.stages.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_changed_command_refuses_before_any_process_starts() {
        let root = project("changed", "printf approved > marker.txt");
        let marker = root.join("marker.txt");
        let store = ApprovalStore::new();
        let token = approve_loop(&store, &root);
        run_loop_gated(&root, "l1", Some(10), &store, Some(&token)).unwrap();
        assert!(marker.exists(), "the approved command ran");
        std::fs::remove_file(&marker).unwrap();
        std::fs::write(root.join("system/loop.json"), format!(r#"{{"schemaVersion":2,"loops":[{{"id":"l1","name":"L","config":{{"stages":[{{"id":"s1","name":"T","kind":"shellCommand","command":{command:?},"enabled":true,"order":0}}]}}}}]}}"#, command = cmd("printf changed > marker.txt"))).unwrap();
        let err = run_loop_gated(&root, "l1", Some(10), &store, Some(&token)).unwrap_err();
        assert!(err.contains("changed since it was approved") || err.contains("not approved"), "{err}");
        assert!(!marker.exists(), "nothing may run when the exact command hash no longer matches");
        std::fs::write(root.join("system/loop.json"), format!(r#"{{"schemaVersion":2,"loops":[{{"id":"l1","name":"L","config":{{"stages":[{{"id":"s1","name":"T","kind":"shellCommand","command":{command:?},"enabled":true,"order":0}}]}}}}]}}"#, command = cmd("printf changed > marker.txt"))).unwrap();
        let err = run_stage_gated(&root, "s1", Some("l1"), Some(10), &store, Some(&token)).unwrap_err();
        assert!(err.contains("changed since it was approved") || err.contains("not approved"), "{err}");
        assert!(!marker.exists(), "the single-stage path refuses too");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_denied_or_missing_native_approval_refuses_without_running() {
        let root = project("denied", "printf ran > marker.txt");
        let marker = root.join("marker.txt");
        let store = ApprovalStore::new();
        let denial = approve_loop_with(&store, &root, "l1", crate::confirm::now_ms(), |_, _| false).unwrap();
        assert!(denial.is_none(), "Cancel mints no approval");
        let err = run_loop_gated(&root, "l1", Some(10), &store, None).unwrap_err();
        assert!(err.contains("native host approval"), "{err}");
        assert!(!marker.exists(), "a declined approval runs nothing");
        let err = run_stage_gated(&root, "s1", Some("l1"), Some(10), &store, None).unwrap_err();
        assert!(err.contains("native host approval"), "{err}");
        assert!(!marker.exists(), "a direct caller without a token runs nothing");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_approval_for_another_loop_or_stage_does_not_run_this_command() {
        let root = project("wrong-scope", "printf ran > marker.txt");
        let store = ApprovalStore::new();
        let token = approve_stage(&store, &root, "s1");
        let err = run_stage_gated(&root, "s1", Some("another-loop"), Some(10), &store, Some(&token)).unwrap_err();
        assert!(err.contains("not approved") || err.contains("not in system/loop.json"), "{err}");
        assert!(!root.join("marker.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn work_root_prefers_the_first_code_repo() {
        let root = std::env::temp_dir().join(format!("llmide-loop-cwd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("code/repo/.git")).unwrap();
        assert_eq!(work_root(&root), root.join("code/repo"));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        assert_eq!(work_root(&root), root);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn regression_stage_with_no_fixed_faults_is_a_honest_noop() {
        let root = project("regression-empty", "printf test");
        std::fs::write(root.join("system/loop.json"), cmd(r#"{"schemaVersion":2,"loops":[{"id":"l","name":"R","config":{"stages":[{"id":"s1","name":"Regression","kind":"regressionSweep","enabled":true,"severity":"blocking","order":0},{"id":"s2","name":"Test","kind":"shellCommand","command":"printf ok","enabled":true,"severity":"blocking","order":1}]}}]}"#)).unwrap();
        let store = ApprovalStore::new();
        let token = approve_loop_with(&store, &root, "l", crate::confirm::now_ms(), |_, _| true).unwrap().unwrap().token;
        let r = run_loop_gated(&root, "l", Some(10), &store, Some(&token)).unwrap();
        assert!(r.passed);
        assert_eq!(r.stages.len(), 2);
        assert_eq!(r.stages[0].run.exit_code, Some(0));
        assert_eq!(r.stages[1].run.stdout.trim_end(), "ok");
        std::fs::create_dir_all(root.join("system/faults")).unwrap();
        std::fs::write(root.join("system/faults/f.md"), "---\nstatus: fixed\n---\n").unwrap();
        assert!(run_loop_gated(&root, "l", Some(10), &store, Some(&token)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fault_verify_reads_the_saved_command_only() {
        let root = std::fs::canonicalize(project("fault", "printf ok")).unwrap();
        std::fs::create_dir_all(root.join("system/faults")).unwrap();
        std::fs::write(root.join("system/loop.json"), cmd(r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"stages":[{"id":"r1","name":"Regression","kind":"regressionSweep","enabled":true,"severity":"blocking","order":0}]}}]}"#)).unwrap();
        std::fs::write(root.join("system/faults/f.md"), cmd("---\nverify: \"printf verified\"\nstatus: fixed\n---\nnotes\n")).unwrap();
        let store = ApprovalStore::new();
        let token = approve_stage(&store, &root, "r1");
        let r = run_fault_verify_gated(&root, "system/faults/f.md", Some(5), &store, Some(&token)).unwrap();
        assert_eq!(r.stdout.trim_end(), "verified");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_changed_fault_verify_command_refuses_and_runs_nothing() {
        let root = std::fs::canonicalize(project("fault-changed", "printf ok")).unwrap();
        std::fs::create_dir_all(root.join("system/faults")).unwrap();
        std::fs::write(root.join("system/loop.json"), cmd(r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"stages":[{"id":"r1","name":"Regression","kind":"regressionSweep","enabled":true,"severity":"blocking","order":0}]}}]}"#)).unwrap();
        std::fs::write(root.join("system/faults/f.md"), cmd("---\nverify: \"printf approved > fault-marker.txt\"\nstatus: fixed\n---\nnotes\n")).unwrap();
        let store = ApprovalStore::new();
        let token = approve_stage(&store, &root, "r1");
        let marker = root.join("fault-marker.txt");
        run_fault_verify_gated(&root, "system/faults/f.md", Some(5), &store, Some(&token)).unwrap();
        assert!(marker.exists());
        std::fs::remove_file(&marker).unwrap();
        std::fs::write(root.join("system/faults/f.md"), cmd("---\nverify: \"printf changed > fault-marker.txt\"\nstatus: fixed\n---\nnotes\n")).unwrap();
        let err = run_fault_verify_gated(&root, "system/faults/f.md", Some(5), &store, Some(&token)).unwrap_err();
        assert!(err.contains("changed since it was approved") || err.contains("not approved"), "{err}");
        assert!(!marker.exists(), "nothing may run when the fault verify command changed");
        let err = run_fault_verify_gated(&root, "system/faults/f.md", Some(5), &store, None).unwrap_err();
        assert!(err.contains("native host approval"), "{err}");
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_work_tree_faults_are_included_in_the_approval() {
        let root = std::env::temp_dir().join(format!("llmide-loop-worktree-faults-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("system")).unwrap();
        std::fs::create_dir_all(root.join("code/repo/.git")).unwrap();
        std::fs::create_dir_all(root.join("code/repo/system/faults")).unwrap();
        std::fs::write(root.join("system/loop.json"), cmd(r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"stages":[{"id":"r1","name":"Regression","kind":"regressionSweep","enabled":true,"severity":"blocking","order":0}]}}]}"#)).unwrap();
        std::fs::write(root.join("code/repo/system/faults/f.md"), cmd("---\nverify: \"printf verified\"\nstatus: fixed\n---\n")).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let rel = "code/repo/system/faults/f.md";
        let got = fault_commands(&root).unwrap();
        assert!(got.iter().any(|f| f.rel == rel), "the approval scan must see the working tree's faults: {got:?}");
        let store = ApprovalStore::new();
        let token = approve_stage(&store, &root, "r1");
        let r = run_fault_verify_gated(&root, rel, Some(5), &store, Some(&token)).unwrap();
        assert_eq!(r.stdout.trim_end(), "verified");
        let _ = std::fs::remove_dir_all(&root);
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args)
            .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t")
            .output().map(|o| o.status.success()).unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    }

    fn repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("llmide-loop-repo-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "committed\n").unwrap();
        std::fs::write(dir.join("b.txt"), "committed\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    // Unix only for now: these use file names Windows cannot create ('>', '*', '?') and the Loop revert belongs to the Windows
    // port (shell stages cannot start there yet; MASTER-PLAN S2 'Windows cargo test').
    #[cfg(unix)]
    #[test]
    fn revert_restores_tracked_files_and_removes_only_files_the_agent_created() {
        let dir = repo("revert");
        std::fs::write(dir.join("a.txt"), "agent edit\n").unwrap();
        std::fs::write(dir.join("new.txt"), "agent new\n").unwrap();
        let both = ["a.txt".to_string(), "new.txt".to_string()];
        assert!(revert_paths_in(&dir, &both, &[]).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "agent edit\n", "a refused call changes nothing");
        assert!(dir.join("new.txt").exists());
        revert_paths_in(&dir, &both, &["new.txt".to_string()]).unwrap();
        assert!(!dir.join("new.txt").exists(), "a file the agent created is removed");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "committed\n");
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "committed\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revert_refuses_unsafe_paths_and_untracked_directories_without_changing_anything() {
        let dir = repo("refuse");
        std::fs::write(dir.join("a.txt"), "agent edit\n").unwrap();
        std::fs::create_dir_all(dir.join("newdir")).unwrap();
        std::fs::write(dir.join("newdir/x.txt"), "x\n").unwrap();
        assert!(revert_paths_in(&dir, &["../etc/passwd".to_string()], &[]).is_err());
        assert!(revert_paths_in(&dir, &["/abs".to_string()], &[]).is_err());
        assert!(revert_paths_in(&dir, &["a.txt".to_string(), "newdir".to_string()], &[]).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "agent edit\n");
        assert!(dir.join("newdir/x.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revert_never_removes_an_untracked_or_ignored_file_the_agent_did_not_create() {
        let dir = repo("keep-untracked");
        std::fs::write(dir.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(dir.join("user notes.txt"), "mine\n").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1\n").unwrap();
        std::fs::write(dir.join("a.txt"), "agent edit\n").unwrap();
        // The agent overwrote these, but they existed before (not in createdPaths): refused, nothing changed.
        assert!(revert_paths_in(&dir, &["a.txt".to_string(), "user notes.txt".to_string()], &[]).is_err());
        assert!(revert_paths_in(&dir, &[".env".to_string()], &[]).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("user notes.txt")).unwrap(), "mine\n");
        assert_eq!(std::fs::read_to_string(dir.join(".env")).unwrap(), "SECRET=1\n");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "agent edit\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Unix only for now: these use file names Windows cannot create ('>', '*', '?') and the Loop revert belongs to the Windows
    // port (shell stages cannot start there yet; MASTER-PLAN S2 'Windows cargo test').
    #[cfg(unix)]
    #[test]
    fn revert_handles_names_with_spaces_and_glob_characters_literally() {
        let dir = repo("spaces");
        std::fs::write(dir.join("my file.txt"), "committed\n").unwrap();
        std::fs::write(dir.join("x[1].txt"), "committed\n").unwrap();
        std::fs::write(dir.join("x1.txt"), "committed\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "more"]);
        std::fs::write(dir.join("my file.txt"), "agent\n").unwrap();
        std::fs::write(dir.join("x1.txt"), "user edit\n").unwrap();
        revert_paths_in(&dir, &["my file.txt".to_string(), "x[1].txt".to_string()], &[]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("my file.txt")).unwrap(), "committed\n");
        // "x[1].txt" is a literal name, never a pattern that also matches x1.txt.
        assert_eq!(std::fs::read_to_string(dir.join("x1.txt")).unwrap(), "user edit\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn revert_never_removes_through_a_symlinked_directory() {
        let dir = repo("symlink");
        let outside = std::env::temp_dir().join(format!("llmide-loop-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("victim.txt"), "keep\n").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        assert!(revert_paths_in(&dir, &["link/victim.txt".to_string()], &["link/victim.txt".to_string()]).is_err(), "created or not, never through a symlinked folder");
        assert!(outside.join("victim.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    // Unix only for now: these use file names Windows cannot create ('>', '*', '?') and the Loop revert belongs to the Windows
    // port (shell stages cannot start there yet; MASTER-PLAN S2 'Windows cargo test').
    #[cfg(unix)]
    #[test]
    fn changed_paths_reads_raw_names_for_spaces_arrows_unicode_and_renames() {
        let dir = repo("names");
        for n in ["my file.txt", "a -> b.txt", "日本.txt", "old.txt"] { std::fs::write(dir.join(n), "c\n").unwrap(); }
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "names"]);
        for n in ["my file.txt", "a -> b.txt", "日本.txt"] { std::fs::write(dir.join(n), "user edit\n").unwrap(); }
        git(&dir, &["mv", "old.txt", "new.txt"]);
        let got = changed_paths_in(&dir).unwrap();
        for want in ["my file.txt", "a -> b.txt", "日本.txt", "new.txt", "old.txt"] {
            assert!(got.iter().any(|p| p == want), "{want} missing from {got:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changed_paths_lists_dirty_files_and_errors_outside_a_repo() {
        let dir = repo("changed");
        std::fs::write(dir.join("a.txt"), "edit\n").unwrap();
        std::fs::write(dir.join("new.txt"), "new\n").unwrap();
        assert_eq!(changed_paths_in(&dir).unwrap(), vec!["a.txt".to_string(), "new.txt".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
        let plain = std::env::temp_dir().join(format!("llmide-loop-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&plain);
        std::fs::create_dir_all(&plain).unwrap();
        assert!(changed_paths_in(&plain).is_err(), "a non-repo must not read as clean");
        let _ = std::fs::remove_dir_all(&plain);
    }

    #[test]
    fn porcelain_parse_skips_an_entry_whose_status_ends_inside_a_character() {
        // "ab日x" puts byte 3 inside the three-byte "日": the old split_at(3) panicked there.
        let listing = " M a.txt\0ab日x\0?? 日本.txt\0R  new.txt\0old.txt\0";
        let want: Vec<String> = ["a.txt", "new.txt", "old.txt", "日本.txt"].iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_porcelain_z(listing).unwrap(), want);
    }

    #[cfg(windows)]
    #[test]
    fn a_program_in_the_working_folder_does_not_shadow_path() {
        let root = project("shadow", "hostname");
        std::fs::write(root.join("hostname.bat"), "@echo planted\r\n").unwrap();
        let r = run_approved(&root, "s1", 10);
        assert!(!r.stdout.contains("planted"), "{r:?}");
        assert_eq!(r.exit_code, Some(0), "{r:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn timeout_kills_the_stage() {
        let root = project("timeout", if cfg!(windows) { "ping -n 6 127.0.0.1 >nul" } else { "sleep 5" });
        let r = run_approved(&root, "s1", 1);
        assert!(r.timed_out);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_the_stage_and_its_grandchildren() {
        let pidfile = std::env::temp_dir().join(format!("llmide-loop-grandchild-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pidfile);
        let root = project("grandchild", &format!("sleep 30 & echo $! > {}; wait", pidfile.display()));
        let r = run_approved(&root, "s1", 1);
        assert!(r.timed_out);
        let pid = std::fs::read_to_string(&pidfile).unwrap().trim().to_string();
        let alive = || Command::new("kill").args(["-0", &pid]).stderr(Stdio::null()).status().unwrap().success();
        let end = Instant::now() + Duration::from_secs(3);
        while Instant::now() < end && alive() {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive(), "grandchild {pid} survived the timeout");
        let _ = std::fs::remove_file(&pidfile);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clipped_cuts_on_a_char_boundary() {
        // 3 bytes per character: the 400 KB cut would land inside one.
        let out = clipped("あ".repeat(170_000));
        assert!(out.ends_with("\n… output truncated by the desktop host"));
        assert!(out.len() <= MAX_CAPTURE + 64);
    }

    #[test]
    fn git_commands_drop_inherited_repo_overrides() {
        let c = git_command();
        let removed: Vec<String> = c.get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_LITERAL_PATHSPECS"] {
            assert!(removed.iter().any(|r| r == k), "{k} is not stripped");
        }
    }

    #[test]
    fn a_caller_flag_cancels_and_the_loop_flag_is_not_read() {
        let stop = AtomicBool::new(true);
        let r = run_command_cancellable(&std::env::temp_dir(), &cmd("printf x"), Some(5), None, &stop).unwrap();
        assert!(r.cancelled && r.exit_code.is_none());
        let go = AtomicBool::new(false);
        let r = run_command_cancellable(&std::env::temp_dir(), &cmd("printf ran"), Some(5), None, &go).unwrap();
        assert_eq!(r.stdout.trim_end(), "ran");
    }

    /// A project that is itself a git repo (`a.txt` = "committed\n") with one saved shell stage `l1/s1`. Canonical.
    fn git_project(name: &str, command: &str) -> PathBuf {
        let root = project(name, command);
        git(&root, &["init", "-q"]);
        std::fs::write(root.join("a.txt"), "committed\n").unwrap();
        git(&root, &["add", "a.txt"]);
        git(&root, &["commit", "-q", "-m", "init"]);
        root.canonicalize().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn app_exit_stops_a_running_stage_and_its_children_and_starts_none_after() {
        let dir = std::env::temp_dir();
        let gate = Arc::new(ExitGate::new());
        let pid_file = dir.join(format!("llmide-exit-gate-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        // The stage leaves a grandchild behind (as `make` or `npm test` do) and then waits a long time.
        let command = format!("sleep 300 & echo $! > '{}'; wait", pid_file.display());
        let g = gate.clone();
        let d = dir.clone();
        let stage = std::thread::spawn(move || run_command_at_gated(&d, &command, Some(600), None, &|| false, &g).unwrap());
        let started = Instant::now();
        while !pid_file.exists() || std::fs::read_to_string(&pid_file).map(|s| s.trim().is_empty()).unwrap_or(true) {
            assert!(started.elapsed() < Duration::from_secs(10), "the stage never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        let grandchild: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        let alive = |pid: i32| unsafe { libc::kill(pid, 0) == 0 };
        assert!(alive(grandchild));

        assert_eq!(gate.stop_all(Duration::from_secs(5)), 0, "the exit path waited until the stage was stopped");
        let run = stage.join().unwrap();
        assert!(run.cancelled && !run.timed_out);
        let gone = Instant::now();
        while alive(grandchild) && gone.elapsed() < Duration::from_secs(3) { std::thread::sleep(Duration::from_millis(20)); }
        assert!(!alive(grandchild), "the stage's own children are stopped with it, not left running after the app");

        // Nothing starts once the app is exiting.
        let late = run_command_at_gated(&dir, "printf late", Some(5), None, &|| false, &gate).unwrap();
        assert!(late.cancelled && late.stdout.is_empty());
        // An exit that was called off (a failed update install) lets stages run again.
        gate.reopen();
        let again = run_command_at_gated(&dir, "printf again", Some(5), None, &|| false, &gate).unwrap();
        assert!(!again.cancelled);
        assert_eq!(again.stdout, "again");
        gate.request_stop();
        assert_eq!(gate.stop_all(Duration::from_millis(10)), 0);
        let _ = std::fs::remove_file(&pid_file);
    }

    #[test]
    fn a_main_tree_call_is_refused_once_the_project_changed() {
        let a = Path::new("/projects/a");
        // Same project (a trailing separator is not a different project): allowed.
        assert!(check_expected_root(None, a, Some("/projects/a")).is_ok());
        assert!(check_expected_root(None, a, Some("/projects/a/")).is_ok());
        // The user opened project B mid-run: the run's snapshot is A's, so nothing may be read or reverted in B.
        let err = check_expected_root(None, Path::new("/projects/b"), Some("/projects/a")).unwrap_err();
        assert!(err.contains("the project changed"), "{err}");
        assert!(check_expected_root(None, Path::new("/projects/ab"), Some("/projects/a")).is_err(), "a prefix is not the same project");
        // The scheduler's spelling of a Windows root (separators normalised) is still the same project.
        let win = Path::new(r"\\?\C:\Users\me\proj");
        assert!(check_expected_root(None, win, Some("//?/C:/Users/me/proj")).is_ok());
        assert!(check_expected_root(None, win, Some(r"\\?\C:\Users\me\proj\")).is_ok());
        assert!(check_expected_root(None, win, Some("//?/C:/Users/me/other")).is_err());
        // No expectation given (an older caller): unchanged behaviour.
        assert!(check_expected_root(None, Path::new("/projects/b"), None).is_ok());
        // A worktree run is pinned by its id, whatever project is active.
        assert!(check_expected_root(Some("run-1"), Path::new("/projects/b"), Some("/projects/a")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn work_root_for_run_uses_worktree_not_active_root() {
        let root = git_project("run-root", "cat a.txt");
        let info = crate::loop_worktree::prepare_in(&root, &root, "t5-root", None, "task").unwrap();
        let (project, work) = root_for(Some("t5-root")).unwrap();
        assert_eq!(project, root, "the run's own project, whatever project is active");
        assert_eq!(work, PathBuf::from(&info.worktree));
        assert_ne!(work, work_root(&root), "not the project's main work root");
        // The main tree is edited; the run's stage and changed paths see only the worktree.
        std::fs::write(root.join("a.txt"), "main edit\n").unwrap();
        assert_eq!(changed_paths_for(Some("t5-root"), None).unwrap(), vec![".factory/".to_string()]);
        let store = ApprovalStore::new();
        let token = approve_stage(&store, &root, "s1"); // minted for the project, as the Loop page does today
        let r = run_stage_gated_at(&project, Some((work.as_path(), "t5-root")), "s1", Some("l1"), Some(10), &store, Some(&token)).unwrap();
        assert_eq!(r.stdout.trim_end(), "committed", "the approved command ran in the worktree");
        let legacy = run_stage_gated(&root, "s1", Some("l1"), Some(10), &store, Some(&token)).unwrap();
        assert_eq!(legacy.stdout.trim_end(), "main edit", "no run id: the main work root, unchanged");
        // A run still needs the approval: no token, nothing runs.
        assert!(run_stage_gated_at(&project, Some((work.as_path(), "t5-root")), "s1", Some("l1"), Some(10), &store, None).unwrap_err().contains("native host approval"));
        assert!(root_for(Some("../x")).is_err());
        crate::loop_worktree::remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn cancel_one_run_leaves_other_running() {
        // Unique keys only: "" is the legacy key other tests run under, so this test never cancels it.
        for k in ["t5-cancel-a", "t5-cancel-b", "t5-cancel-c"] {
            clear_cancel(k);
        }
        loop_cancel(Some("t5-cancel-a".to_string()));
        assert!(is_cancelled("t5-cancel-a"));
        assert!(!is_cancelled("t5-cancel-b"), "Stop on one run never stops another");
        let dir = std::env::temp_dir();
        let a = run_command_keyed(&dir, "printf a", Some(5), "t5-cancel-a").unwrap();
        assert!(a.cancelled && a.exit_code.is_none(), "{a:?}");
        let b = run_command_keyed(&dir, "printf b", Some(5), "t5-cancel-b").unwrap();
        assert_eq!(b.stdout.trim_end(), "b");
        assert!(!b.cancelled);
        // Mid-run: cancelling run c stops c, and a run on b started at the same time finishes.
        let slow_b = std::thread::spawn(|| run_command_keyed(&std::env::temp_dir(), "sleep 1; printf done", Some(10), "t5-cancel-b").unwrap());
        let slow_c = std::thread::spawn(|| run_command_keyed(&std::env::temp_dir(), "sleep 5", Some(10), "t5-cancel-c").unwrap());
        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        loop_cancel(Some("t5-cancel-c".to_string()));
        let c = slow_c.join().unwrap();
        assert!(c.cancelled && started.elapsed() < Duration::from_secs(4), "{c:?}");
        let b = slow_b.join().unwrap();
        assert!(!b.cancelled && b.stdout.trim_end() == "done", "{b:?}");
        // An id that is not a run id is ignored, never stored.
        loop_cancel(Some("../bad id".to_string()));
        assert!(!is_cancelled("../bad id"));
        for k in ["t5-cancel-a", "t5-cancel-b", "t5-cancel-c"] {
            clear_cancel(k);
        }
        assert!(!is_cancelled("t5-cancel-a"));
    }

    #[cfg(unix)]
    #[test]
    fn revert_with_run_id_touches_only_worktree() {
        let root = git_project("run-revert", "printf ok");
        let info = crate::loop_worktree::prepare_in(&root, &root, "t5-revert", None, "task").unwrap();
        let wt = PathBuf::from(&info.worktree);
        std::fs::write(root.join("a.txt"), "user edit in main\n").unwrap();
        std::fs::write(wt.join("a.txt"), "agent edit in worktree\n").unwrap();
        std::fs::write(wt.join("new.txt"), "agent new\n").unwrap();
        revert_paths_for(Some("t5-revert"), None, &["a.txt".to_string(), "new.txt".to_string()], &["new.txt".to_string()]).unwrap();
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "committed\n");
        assert!(!wt.join("new.txt").exists());
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "user edit in main\n", "the same path in the main tree is unchanged");
        assert!(revert_paths_for(Some("../x"), None, &["a.txt".to_string()], &[]).is_err());
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "user edit in main\n");
        crate::loop_worktree::remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn regression_stage_refuses_in_a_worktree_run() {
        let root = git_project("run-regression", "cat a.txt");
        std::fs::write(root.join("system/loop.json"), r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"stages":[{"id":"r1","name":"Regression","kind":"regressionSweep","enabled":true,"severity":"blocking","order":0}]}}]}"#).unwrap();
        let info = crate::loop_worktree::prepare_in(&root, &root, "t5-reg", None, "task").unwrap();
        let work = PathBuf::from(&info.worktree);
        let store = ApprovalStore::new();
        let err = run_stage_gated_at(&root, Some((work.as_path(), "t5-reg")), "r1", Some("l1"), Some(10), &store, None).unwrap_err();
        assert!(err.contains("cannot run in a factory worktree"), "{err}");
        crate::loop_worktree::remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
