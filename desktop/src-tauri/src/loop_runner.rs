//! Native Loop stage execution, first slice. Only a `shellCommand` stage that is already present in the project's
//! committed `system/loop.json` can run: the webview names a stage id, never a command string, so it cannot ask the
//! host to execute arbitrary shell. The user starts the stage from the Loop page.
//!
//! Output is captured with bounded buffers; the process is killed on timeout or when the caller cancels by dropping
//! the task (the async command is blocking, so cancellation is bounded by the timeout).
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;

static CANCEL: AtomicBool = AtomicBool::new(false);

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
        s.truncate(MAX_CAPTURE);
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

/// Finds the command of a shell stage in `system/loop.json`. No command is accepted from the caller.
pub fn stage_command(root: &Path, stage_id: &str) -> Result<String, String> {
    let path = root.join("system").join("loop.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read system/loop.json: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("system/loop.json is not valid JSON: {e}"))?;
    let loops = v.get("loops").and_then(|x| x.as_array()).ok_or("system/loop.json has no loops")?;
    for l in loops {
        let Some(stages) = l.get("config").and_then(|c| c.get("stages")).and_then(|s| s.as_array()) else { continue };
        for s in stages {
            if s.get("id").and_then(|x| x.as_str()) != Some(stage_id) { continue; }
            if s.get("kind").and_then(|x| x.as_str()) != Some("shellCommand") {
                return Err("only shellCommand stages can run in this slice".into());
            }
            let cmd = s.get("command").and_then(|x| x.as_str()).unwrap_or("").trim();
            if cmd.is_empty() { return Err("this stage has no command".into()); }
            return Ok(cmd.to_string());
        }
    }
    Err("that stage is not in system/loop.json".into())
}

fn stage_kind(root: &Path, stage_id: &str) -> Result<String, String> {
    let text = std::fs::read_to_string(root.join("system").join("loop.json")).map_err(|e| format!("cannot read system/loop.json: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("system/loop.json is not valid JSON: {e}"))?;
    for l in v.get("loops").and_then(|x| x.as_array()).into_iter().flatten() {
        for s in l.get("config").and_then(|c| c.get("stages")).and_then(|s| s.as_array()).into_iter().flatten() {
            if s.get("id").and_then(|x| x.as_str()) == Some(stage_id) {
                return Ok(s.get("kind").and_then(|x| x.as_str()).unwrap_or("").to_string());
            }
        }
    }
    Err("that stage is not in system/loop.json".into())
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

/// Runs one already-saved shell stage. The caller is the Loop page's explicit Run action.
/// Reads a fault report's `verify` command (frontmatter) and runs it in the git root. The webview supplies only the
/// project-relative fault path, never a command.
pub fn run_fault_verify(root: &Path, rel: &str, timeout_secs: Option<u64>) -> Result<StageRun, String> {
    let p = crate::fs_ops::resolve_existing(root, rel).map_err(|e| e.message)?;
    let text = std::fs::read_to_string(&p).map_err(|e| format!("cannot read the fault report: {e}"))?;
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
    let command = verify.filter(|c| !c.trim().is_empty()).ok_or("this fault has no verify command")?;
    run_command(root, &command, timeout_secs)
}

pub fn run_stage(root: &Path, stage_id: &str, timeout_secs: Option<u64>) -> Result<StageRun, String> {
    let command = stage_command(root, stage_id)?;
    run_command(root, &command, timeout_secs)
}

pub fn run_command(root: &Path, command: &str, timeout_secs: Option<u64>) -> Result<StageRun, String> {
    run_command_with(root, command, timeout_secs, None)
}

pub fn run_command_with(root: &Path, command: &str, timeout_secs: Option<u64>, sink: Option<Arc<dyn Fn(&str, bool) + Send + Sync>>) -> Result<StageRun, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, 86_400));
    let started = Instant::now();
    if CANCEL.load(Ordering::SeqCst) {
        return Ok(StageRun { exit_code: None, stdout: String::new(), stderr: String::new(), timed_out: false, cancelled: true, duration_ms: 0 });
    }
    let mut child = Command::new("/bin/sh")
        .arg("-lc")
        .arg(command)
        .current_dir(work_root(root))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start the stage command: {e}"))?;
    let out_rx = child.stdout.take().map(|r| read_capped_stream(r, sink.clone(), true));
    let err_rx = child.stderr.take().map(|r| read_capped_stream(r, sink.clone(), false));
    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        match child.try_wait().map_err(|e| format!("cannot wait for the stage: {e}"))? {
            Some(s) => break Some(s),
            None if CANCEL.load(Ordering::SeqCst) => {
                cancelled = true;
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            None if started.elapsed() >= timeout => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
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

/// Runs every enabled stage of one loop in order. This slice supports only `shellCommand` stages: a loop with any
/// other enabled stage is refused before anything runs, instead of silently reporting a green run that skipped the
/// verification the user asked for. Blocking failures stop the pass; advisory failures are recorded and continue.
pub fn run_loop(root: &Path, loop_id: &str, timeout_secs: Option<u64>) -> Result<LoopRunResult, String> {
    let text = std::fs::read_to_string(root.join("system").join("loop.json"))
        .map_err(|e| format!("cannot read system/loop.json: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("system/loop.json is not valid JSON: {e}"))?;
    let loops = v.get("loops").and_then(|x| x.as_array()).ok_or("system/loop.json has no loops")?;
    let loop_v = loops.iter().find(|l| l.get("id").and_then(|x| x.as_str()) == Some(loop_id)).ok_or("that loop is not in system/loop.json")?;
    let loop_name = loop_v.get("name").and_then(|x| x.as_str()).unwrap_or("Loop").to_string();
    let stages = loop_v.get("config").and_then(|c| c.get("stages")).and_then(|s| s.as_array()).ok_or("loop has no stages")?;
    let mut plan: Vec<(String, String, String, String, String)> = Vec::new();
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
        let cmd = s.get("command").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if kind == "shellCommand" && cmd.is_empty() { return Err(format!("“{name}” has no command")); }
        plan.push((id, name, severity, kind.to_string(), cmd));
    }
    if plan.is_empty() { return Err("this loop has no enabled stages".into()); }
    let mut results = Vec::new();
    let mut passed = true;
    for (id, name, severity, kind, _cmd) in plan {
        let run = if kind == "regressionSweep" { run_regression(root)? } else { run_stage(root, &id, timeout_secs)? };
        let ok = !run.timed_out && run.exit_code == Some(0);
        results.push(LoopStageResult { stage_id: id, stage_name: name, severity: severity.clone(), run });
        if !ok {
            passed = false;
            if severity == "blocking" { break; }
        }
    }
    Ok(LoopRunResult { loop_id: loop_id.to_string(), loop_name, passed, stages: results })
}

/// Tauri command. The stage id is resolved against the active project's loop.json; no command crosses IPC.
#[tauri::command]
pub async fn loop_run_stage(stage_id: String, timeout_secs: Option<u64>) -> Result<StageRun, String> {
    CANCEL.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project::active_root().ok_or_else(|| "open a project before running a Loop stage".to_string())?;
        crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
        if stage_kind(&root, &stage_id)? == "regressionSweep" { run_regression(&root) } else { run_stage(&root, &stage_id, timeout_secs) }
    }).await.map_err(|e| format!("Loop stage task failed: {e}"))?
}

#[tauri::command]
pub fn loop_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn loop_work_root() -> Result<String, String> {
    let root = crate::project::active_root().ok_or_else(|| "open a project first".to_string())?;
    crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
    Ok(work_root(&root).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn loop_run_loop(loop_id: String, timeout_secs: Option<u64>) -> Result<LoopRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project::active_root().ok_or_else(|| "open a project before running a Loop".to_string())?;
        crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
        run_loop(&root, &loop_id, timeout_secs)
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
#[tauri::command]
pub async fn loop_boundary_warnings() -> Result<Option<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project::active_root().ok_or_else(|| "open a project first".to_string())?;
        crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
        let script = work_root(&root).join("mac").join("Scripts").join("feature-boundaries.sh");
        if !script.is_file() { return Ok(None); }
        let run = run_command(&root, "bash mac/Scripts/feature-boundaries.sh", Some(120))?;
        let output = format!("{}\n{}", run.stdout, run.stderr);
        for line in output.lines() {
            if let Some(rest) = line.strip_prefix("total: ") {
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = digits.parse::<u32>() { return Ok(Some(n)); }
            }
        }
        Ok(None)
    }).await.map_err(|e| format!("boundary probe task failed: {e}"))?
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
pub async fn loop_run_fault_verify(rel: String, timeout_secs: Option<u64>) -> Result<StageRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project::active_root().ok_or_else(|| "open a project first".to_string())?;
        crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
        run_fault_verify(&root, &rel, timeout_secs)
    }).await.map_err(|e| format!("fault verify task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, command: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("llmide-loop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("system")).unwrap();
        std::fs::write(root.join("system/loop.json"), format!(r#"{{"schemaVersion":2,"loops":[{{"name":"L","config":{{"stages":[{{"id":"s1","name":"T","kind":"shellCommand","command":{command:?},"order":0}}]}}}}]}}"#)).unwrap();
        root
    }

    #[test]
    fn only_saved_shell_stages_run_and_output_is_captured() {
        let root = project("ok", "printf hello; printf err >&2; exit 3");
        let cmd = stage_command(&root, "s1").unwrap();
        assert_eq!(cmd, "printf hello; printf err >&2; exit 3");
        let r = run_stage(&root, "s1", Some(10)).unwrap();
        assert_eq!(r.stdout, "hello");
        assert_eq!(r.stderr, "err");
        assert_eq!(r.exit_code, Some(3));
        assert!(!r.timed_out);
        assert!(stage_command(&root, "missing").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn loop_runs_shell_stages_in_order_and_stops_at_blocking_failure() {
        let root = project("loop", "printf one");
        std::fs::write(root.join("system/loop.json"), r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"maxIterations":2,"stages":[{"id":"s1","name":"One","kind":"shellCommand","command":"printf one","enabled":true,"severity":"blocking","order":0},{"id":"s2","name":"Two","kind":"shellCommand","command":"printf two","enabled":true,"severity":"blocking","order":1}]}}]}"#).unwrap();
        let r = run_loop(&root, "l1", Some(10)).unwrap();
        assert!(r.passed);
        assert_eq!(r.stages.len(), 2);
        assert_eq!(r.stages[0].run.stdout, "one");
        assert_eq!(r.stages[1].run.stdout, "two");
        std::fs::write(root.join("system/loop.json"), r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"stages":[{"id":"s1","name":"One","kind":"shellCommand","command":"exit 1","enabled":true,"severity":"blocking","order":0},{"id":"s2","name":"Two","kind":"shellCommand","command":"printf two","enabled":true,"severity":"blocking","order":1}]}}]}"#).unwrap();
        let r = run_loop(&root, "l1", Some(10)).unwrap();
        assert!(!r.passed);
        assert_eq!(r.stages.len(), 1);
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
        std::fs::write(root.join("system/loop.json"), r#"{"schemaVersion":2,"loops":[{"id":"l","name":"R","config":{"stages":[{"id":"s1","name":"Regression","kind":"regressionSweep","enabled":true,"severity":"blocking","order":0},{"id":"s2","name":"Test","kind":"shellCommand","command":"printf ok","enabled":true,"severity":"blocking","order":1}]}}]}"#).unwrap();
        let r = run_loop(&root, "l", Some(10)).unwrap();
        assert!(r.passed);
        assert_eq!(r.stages.len(), 2);
        assert_eq!(r.stages[0].run.exit_code, Some(0));
        assert_eq!(r.stages[1].run.stdout, "ok");
        std::fs::create_dir_all(root.join("system/faults")).unwrap();
        std::fs::write(root.join("system/faults/f.md"), "---\nstatus: fixed\n---\n").unwrap();
        assert!(run_loop(&root, "l", Some(10)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fault_verify_reads_the_saved_command_only() {
        let root = std::fs::canonicalize(project("fault", "printf ok")).unwrap();
        std::fs::create_dir_all(root.join("system/faults")).unwrap();
        std::fs::write(root.join("system/faults/f.md"), "---\nverify: \"printf verified\"\nstatus: fixed\n---\nnotes\n").unwrap();
        let r = run_fault_verify(&root, "system/faults/f.md", Some(5)).unwrap();
        assert_eq!(r.stdout, "verified");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn timeout_kills_the_stage() {
        let root = project("timeout", "sleep 5");
        let r = run_stage(&root, "s1", Some(1)).unwrap();
        assert!(r.timed_out);
        let _ = std::fs::remove_dir_all(&root);
    }
}
