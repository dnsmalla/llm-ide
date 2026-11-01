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
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StageRun {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
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

fn read_capped<R: Read + Send + 'static>(mut r: R) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = r.read(&mut chunk) {
            if n == 0 { break; }
            if buf.len() < MAX_CAPTURE {
                let room = MAX_CAPTURE - buf.len();
                buf.extend_from_slice(&chunk[..n.min(room)]);
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    rx
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

/// Runs one already-saved shell stage. The caller is the Loop page's explicit Run action.
pub fn run_stage(root: &Path, stage_id: &str, timeout_secs: Option<u64>) -> Result<StageRun, String> {
    let command = stage_command(root, stage_id)?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, 86_400));
    let started = Instant::now();
    let mut child = Command::new("/bin/sh")
        .arg("-lc")
        .arg(&command)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start the stage command: {e}"))?;
    let out_rx = child.stdout.take().map(read_capped);
    let err_rx = child.stderr.take().map(read_capped);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait().map_err(|e| format!("cannot wait for the stage: {e}"))? {
            Some(s) => break Some(s),
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
    let mut plan: Vec<(String, String, String, String)> = Vec::new();
    for s in stages {
        if s.get("enabled").and_then(|x| x.as_bool()) != Some(true) { continue; }
        let id = s.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let name = s.get("name").and_then(|x| x.as_str()).unwrap_or("Stage").to_string();
        let kind = s.get("kind").and_then(|x| x.as_str()).unwrap_or("");
        let severity = s.get("severity").and_then(|x| x.as_str()).unwrap_or("blocking").to_string();
        if kind != "shellCommand" {
            return Err(format!("“{name}” is a {kind} stage; only shell-command stages run in this slice"));
        }
        let cmd = s.get("command").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if cmd.is_empty() { return Err(format!("“{name}” has no command")); }
        plan.push((id, name, severity, cmd));
    }
    if plan.is_empty() { return Err("this loop has no enabled stages".into()); }
    let mut results = Vec::new();
    let mut passed = true;
    for (id, name, severity, _cmd) in plan {
        let run = run_stage(root, &id, timeout_secs)?;
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
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project::active_root().ok_or_else(|| "open a project before running a Loop stage".to_string())?;
        crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
        run_stage(&root, &stage_id, timeout_secs)
    }).await.map_err(|e| format!("Loop stage task failed: {e}"))?
}

#[tauri::command]
pub async fn loop_run_loop(loop_id: String, timeout_secs: Option<u64>) -> Result<LoopRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::project::active_root().ok_or_else(|| "open a project before running a Loop".to_string())?;
        crate::fs_ops::checked_root(&root).map_err(|e| e.message)?;
        run_loop(&root, &loop_id, timeout_secs)
    }).await.map_err(|e| format!("Loop task failed: {e}"))?
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
    fn timeout_kills_the_stage() {
        let root = project("timeout", "sleep 5");
        let r = run_stage(&root, "s1", Some(1)).unwrap();
        assert!(r.timed_out);
        let _ = std::fs::remove_dir_all(&root);
    }
}
