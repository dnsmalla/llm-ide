//! Generate a project's graph with the GraphKit TypeScript CLI (the schema-compatible sibling of the Mac's
//! Swift scanners), writing one file per mode: `system/graph/graph-code.json`, `graph-memory.json` or `graph-all.json`, which the Graph screen reads.
//!
//! Modes match the Mac's Code / InfiniteBrain / All: `code` scans the project, `memory` scans `llm-doc/`, and
//! `all` merges both canonical documents. Runs the bundled CLI with the bundled node; a dev build falls back to
//! the checkout. The page never chooses a path — the active project root and its llm-doc are host state.
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphGenerated {
    /// Project-relative mode file: `graph-code.json`, `graph-memory.json` or `graph-all.json`.
    pub path: String,
    pub nodes: usize,
    pub edges: usize,
}

fn node_file() -> &'static str {
    if cfg!(windows) { "node.exe" } else { "node" }
}

/// The bundled CLI + node, or the checkout pair in a dev run. Both must exist.
fn toolchain(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resources = app.path().resource_dir().map_err(|e| format!("resource dir: {e}"))?;
    let bundled_node = resources.join("core").join("node").join(node_file());
    let bundled_cli = resources.join("core").join("root").join("graph-kit").join("bin").join("graph-kit.js");
    if bundled_node.is_file() && bundled_cli.is_file() {
        return Ok((bundled_node, bundled_cli));
    }
    let root = crate::core_host::repo_root()?;
    let cli = root.join("graph-kit").join("bin").join("graph-kit.js");
    let node = crate::core_host::node_binary();
    if cli.is_file() {
        return Ok((node, cli));
    }
    Err("the GraphKit generator is not bundled and no checkout CLI was found".into())
}

static NEXT_COPY: AtomicU64 = AtomicU64::new(0);
static RUNNING: AtomicBool = AtomicBool::new(false);
static CHILD: Mutex<Option<Child>> = Mutex::new(None);

fn graph_rel(mode: &str) -> &'static str {
    match mode {
        "memory" => "system/graph/graph-memory.json",
        "all" => "system/graph/graph-all.json",
        _ => "system/graph/graph-code.json",
    }
}

/// The error a cancelled run returns; callers (and the screen) tell it apart from "the generator failed".
pub const CANCELLED: &str = "graph generation cancelled";

fn run_gk(node: &Path, cli: &Path, args: &[String]) -> Result<(), String> {
    // A bundled CLI sits inside the app bundle. In a checkout build the bundle lives under `desktop/`,
    // whose package.json says `"type": "module"`, so Node treats the CLI's `require` calls as ESM and fails.
    // Run a `.cjs` copy from the temp dir: the CLI is self-contained, and this also avoids any package scope
    // when the app is installed under a user's project tree.
    let n = NEXT_COPY.fetch_add(1, Ordering::Relaxed);
    let temp = std::env::temp_dir().join(format!("llmide-graphkit-{}-{n}.cjs", std::process::id()));
    std::fs::copy(cli, &temp).map_err(|e| format!("cannot prepare the GraphKit CLI: {e}"))?;
    let child = Command::new(node)
        .arg(&temp)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .spawn()
        .map_err(|e| format!("cannot run the GraphKit generator: {e}"))?;
    // Publish the child while it runs so graph_cancel can kill exactly this process. A cancel between
    // spawn and the lock is impossible from the UI's single-threaded command path in practice, but the
    // lock still makes the hand-off atomic.
    {
        let mut slot = CHILD.lock().map_err(|_| "the graph runner is unavailable")?;
        *slot = Some(child);
    }
    let status = loop {
        let mut slot = CHILD.lock().map_err(|_| "the graph runner is unavailable")?;
        let Some(running) = slot.as_mut() else {
            let _ = std::fs::remove_file(&temp);
            return Err(CANCELLED.into());
        };
        match running.try_wait().map_err(|e| format!("cannot wait for the GraphKit generator: {e}"))? {
            Some(status) => {
                slot.take();
                break status;
            }
            None => {
                drop(slot);
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
        }
    };
    let _ = std::fs::remove_file(&temp);
    if status.success() { return Ok(()); }
    Err("the GraphKit generator failed".into())
}

/// A project-relative graph output folder a Loop run may use: under `system/loop-runs/`, no `..`, safe characters only.
fn valid_out(out: &str) -> bool {
    out.starts_with("system/loop-runs/")
        && out.split('/').all(|seg| !seg.is_empty() && seg != "..")
        && out.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
}

/// `graph-kit code` arguments. A Loop run (`light`) passes `--no-calls`: call edges are most of a large graph
/// and the Loop never reads them, while the Graph screen keeps the full graph.
fn code_args(scan: &str, out: &str, light: bool) -> Vec<String> {
    let mut args = vec!["code".to_string(), scan.to_string(), "--out".to_string(), out.to_string()];
    if light {
        args.push("--no-calls".to_string());
    }
    args
}

fn generate(app: &tauri::AppHandle, mode: &str, target: Option<&str>, out: Option<&str>) -> Result<GraphGenerated, String> {
    let (node, cli) = toolchain(app)?;
    let root = crate::project::active_root().ok_or_else(|| "open a project before generating a graph".to_string())?;
    if crate::fs_ops::checked_root(&root).is_err() {
        return Err("the project folder is not usable".into());
    }
    // A worktree run writes into its own system/loop-runs folder, so the project's main graph is never replaced.
    let out_dir = match out {
        Some(o) if !valid_out(o) => return Err("the graph output folder must be under system/loop-runs/".into()),
        Some(o) => root.join(o),
        None => root.join("system").join("graph"),
    };
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create {}: {e}", out.unwrap_or("system/graph")))?;
    let explicit = match target.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => {
            let p = crate::fs_ops::resolve_existing(&root, t).map_err(|e| e.message)?;
            if !p.is_dir() { return Err("the graph target is not a folder".into()); }
            Some(p)
        }
        None => None,
    };
    let scan_code = explicit.clone().unwrap_or_else(|| root.clone());
    // InfiniteBrain walks the selected repo for .md/.txt (the Mac's activeRepoRoot), not only the
    // library's llm-doc folder — a repo's README/docs are exactly its doc graph.
    let scan_docs = explicit.clone().unwrap_or_else(|| {
        // The Mac's activeRepoRoot: the first code repo is the default doc target, so InfiniteBrain
        // works without an explicit pick. Fall back to the library's llm-doc when there is no repo.
        let code = root.join("code");
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(&code).ok()
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && !p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with('.')).unwrap_or(false))
            .collect();
        dirs.sort();
        dirs.into_iter().next().unwrap_or_else(|| root.join("llm-doc"))
    });
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let temp = |suffix: &str| std::env::temp_dir().join(format!("llmide-graph-{}-{stamp}-{suffix}.json", std::process::id()));
    let code_out = temp("code");
    let doc_out = temp("doc");
    let final_out = temp("final");
    let clean_doc = temp("doc-clean");
    let chunks_out = temp("chunks");
    let result = (|| -> Result<PathBuf, String> {
        match mode {
            "code" => {
                run_gk(&node, &cli, &code_args(&scan_code.to_string_lossy(), &code_out.to_string_lossy(), out.is_some()))?;
                Ok(code_out.clone())
            }
            "memory" => {
                if !scan_docs.is_dir() { return Err("this project has no folder to scan for documents".into()); }
                run_gk(&node, &cli, &["memory".into(), scan_docs.to_string_lossy().into_owned(), "--out".into(), doc_out.to_string_lossy().into_owned()])?;
                Ok(doc_out.clone())
            }
            "all" => {
                run_gk(&node, &cli, &code_args(&scan_code.to_string_lossy(), &code_out.to_string_lossy(), out.is_some()))?;
                if !scan_docs.is_dir() { return Err("this project has no folder to scan for documents".into()); }
                run_gk(&node, &cli, &["memory".into(), scan_docs.to_string_lossy().into_owned(), "--out".into(), doc_out.to_string_lossy().into_owned()])?;
                // `memory` emits additive `chunks`/`docCount` keys, but `merge` parses the doc strictly. Split them
                // into the canonical document and the chunk array the merger expects.
                let raw = std::fs::read_to_string(&doc_out).map_err(|e| format!("cannot read the memory graph: {e}"))?;
                let mut value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("invalid memory graph JSON: {e}"))?;
                let chunks = value.get("chunks").cloned().unwrap_or_else(|| serde_json::Value::Array(vec![]));
                if let Some(obj) = value.as_object_mut() {
                    obj.remove("chunks");
                    obj.remove("docCount");
                }
                std::fs::write(&clean_doc, serde_json::to_vec(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                std::fs::write(&chunks_out, serde_json::to_vec(&chunks).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                run_gk(&node, &cli, &[
                    "merge".into(), code_out.to_string_lossy().into_owned(), clean_doc.to_string_lossy().into_owned(),
                    chunks_out.to_string_lossy().into_owned(), "--out".into(), final_out.to_string_lossy().into_owned(),
                ])?;
                Ok(final_out.clone())
            }
            other => Err(format!("unknown graph mode: {other}")),
        }
    })();
    let source = match result {
        Ok(p) => p,
        Err(e) => {
            for p in [&code_out, &doc_out, &final_out, &clean_doc, &chunks_out] { let _ = std::fs::remove_file(p); }
            return Err(e);
        }
    };
    let text = std::fs::read_to_string(&source).map_err(|e| format!("cannot read the generated graph: {e}"))?;
    for p in [&code_out, &doc_out, &final_out, &clean_doc, &chunks_out] { let _ = std::fs::remove_file(p); }
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("the generator produced invalid JSON: {e}"))?;
    let nodes = value.get("nodes").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0);
    let edges = value.get("edges").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0);
    if mode == "memory" && nodes == 0 {
        return Err("This target has no .md/.txt documents to graph yet.".into());
    }
    let file = graph_rel(mode).rsplit('/').next().unwrap_or("graph.json");
    let rel = match out {
        Some(o) => format!("{o}/{file}"),
        None => graph_rel(mode).to_string(),
    };
    let dest = out_dir.join(file);
    // One graph per mode: a memory graph never replaces the code graph. Write a sibling then rename so
    // a reader never sees half a graph.
    let partial = dest.with_extension("json.partial");
    std::fs::write(&partial, text.as_bytes()).map_err(|e| format!("cannot write {rel}: {e}"))?;
    std::fs::rename(&partial, &dest).map_err(|e| format!("cannot install {rel}: {e}"))?;
    Ok(GraphGenerated { path: rel, nodes, edges })
}

/// The repo the Graph screen picks by default: the only `code/<child>`, or None when there are zero/many.
pub fn default_auto_target(root: &Path) -> Option<String> {
    let mut dirs: Vec<String> = std::fs::read_dir(root.join("code")).ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| !n.starts_with('.'))
        .collect();
    dirs.sort();
    (dirs.len() == 1).then(|| format!("code/{}", dirs[0]))
}

/// True when a timer tick should run: off at 0, otherwise at or past the interval.
pub fn auto_due(minutes: u32, elapsed_secs: u64) -> bool {
    minutes > 0 && elapsed_secs >= u64::from(minutes) * 60
}

/// Background timer for Settings → Code Graph. It runs immediately on project open/switch and then every N
/// minutes, regenerating the code graph (the screen's default mode). File-watch debouncing and the memory
/// graph stay Mac-only for now.
pub fn start_auto(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last_root: Option<String> = None;
        let mut last_minutes = u32::MAX;
        let mut last_run = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(30));
            let launch = crate::prefs::launch();
            let enabled = launch.features.is_empty() || launch.features.iter().any(|f| f == "code_graph_3d");
            let minutes = crate::prefs::stored().graph_auto_update_minutes;
            if minutes != last_minutes { last_minutes = minutes; last_run = Instant::now(); }
            if minutes == 0 || !enabled { last_root = None; continue; }
            let root = crate::project::active_root().map(|p| p.to_string_lossy().into_owned());
            let changed = root != last_root;
            if changed { last_root = root.clone(); last_run = Instant::now(); }
            if root.is_none() { continue; }
            if !changed && !auto_due(minutes, last_run.elapsed().as_secs()) { continue; }
            if RUNNING.load(Ordering::SeqCst) { continue; }
            let target = root.as_ref().and_then(|r| default_auto_target(Path::new(r)));
            let result = tauri::async_runtime::block_on(graph_generate(app.clone(), Some("code".into()), target, None));
            last_run = Instant::now();
            match result {
                Ok(_) => { let _ = tauri::Emitter::emit(&app, "graph-auto-updated", serde_json::json!({})); }
                Err(e) => eprintln!("graph auto-update: {e}"),
            }
        }
    });
}

#[tauri::command]
pub async fn graph_generate(app: tauri::AppHandle, mode: Option<String>, target: Option<String>, out: Option<String>) -> Result<GraphGenerated, String> {
    let mode = mode.unwrap_or_else(|| "code".into());
    let result = tauri::async_runtime::spawn_blocking(move || {
        // A manual/loop request waits for an in-flight auto run instead of failing the caller. The wait is
        // bounded so a wedged scan cannot queue requests forever.
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if !RUNNING.swap(true, Ordering::SeqCst) { break; }
            if Instant::now() >= deadline { return Err("a graph generation is still running".into()); }
            std::thread::sleep(Duration::from_millis(100));
        }
        let result = generate(&app, &mode, target.as_deref(), out.as_deref());
        RUNNING.store(false, Ordering::SeqCst);
        result
    }).await.map_err(|e| format!("graph task failed: {e}"));
    result?
}

/// Stop the running GraphKit child. The generate call returns its cancellation to the screen.
#[tauri::command]
pub fn graph_cancel() -> bool {
    let Ok(mut slot) = CHILD.lock() else { return false };
    // Take the child OUT of the slot: the runner polls the slot, and an empty one is how it learns the run
    // was cancelled (a killed child left in place was reported as "the generator failed").
    let Some(mut child) = slot.take() else { return false };
    drop(slot);
    let _ = child.kill();
    let _ = child.wait(); // reap it
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_mode_has_its_own_project_relative_graph() {
        assert_eq!(graph_rel("code"), "system/graph/graph-code.json");
        assert_eq!(graph_rel("memory"), "system/graph/graph-memory.json");
        assert_eq!(graph_rel("all"), "system/graph/graph-all.json");
        assert!(!Path::new(graph_rel("code")).is_absolute());
    }

    #[test]
    fn a_loop_run_scan_skips_call_edges_and_the_graph_screen_keeps_them() {
        let light = code_args("/repo", "/out.json", true);
        assert_eq!(light, ["code", "/repo", "--out", "/out.json", "--no-calls"]);
        let full = code_args("/repo", "/out.json", false);
        assert_eq!(full, ["code", "/repo", "--out", "/out.json"]);
    }

    #[test]
    fn only_loop_run_folders_are_valid_graph_outputs() {
        assert!(valid_out("system/loop-runs/r1/graph"));
        assert!(!valid_out("system/graph"));
        assert!(!valid_out("system/loop-runs/../x"));
        assert!(!valid_out("/abs"));
        assert!(!valid_out("system/loop-runs/a b"));
    }

    #[cfg(unix)]
    #[test]
    fn a_cancelled_run_reports_cancellation_not_a_generator_failure() {
        let dir = std::env::temp_dir().join(format!("llmide-gk-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("slow.js");
        std::fs::write(&script, "sleep 30\n").unwrap();
        // `sh` stands in for node: it runs the copied script.
        let runner = std::thread::spawn(move || run_gk(Path::new("/bin/sh"), &script, &[]));
        let deadline = Instant::now() + Duration::from_secs(10);
        while CHILD.lock().map(|g| g.is_none()).unwrap_or(true) {
            assert!(Instant::now() < deadline, "the child never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(graph_cancel());
        assert_eq!(runner.join().unwrap().unwrap_err(), CANCELLED);
        assert!(!graph_cancel(), "nothing left to cancel");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auto_due_honours_off_and_the_interval() {
        assert!(!auto_due(0, 99_999));
        assert!(!auto_due(5, 299));
        assert!(auto_due(5, 300));
    }

    #[test]
    fn the_auto_target_matches_the_screen_default() {
        let dir = std::env::temp_dir().join(format!("llmide-graph-target-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("code/b")).unwrap();
        std::fs::create_dir_all(dir.join("code/a")).unwrap();
        assert_eq!(default_auto_target(&dir), None, "two repos need the screen's choice");
        std::fs::remove_dir_all(dir.join("code/b")).unwrap();
        assert_eq!(default_auto_target(&dir).as_deref(), Some("code/a"));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(default_auto_target(&dir), None);
    }
}
