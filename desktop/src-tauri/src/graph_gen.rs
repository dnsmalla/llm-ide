//! Generate a project's graph with the GraphKit TypeScript CLI (the schema-compatible sibling of the Mac's
//! Swift scanners), writing the canonical `system/graph/graph.json` the Graph screen reads.
//!
//! Modes match the Mac's Code / InfiniteBrain / All: `code` scans the project, `memory` scans `llm-doc/`, and
//! `all` merges both canonical documents. Runs the bundled CLI with the bundled node; a dev build falls back to
//! the checkout. The page never chooses a path — the active project root and its llm-doc are host state.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphGenerated {
    /// Project-relative, always `system/graph/graph.json`.
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
    let cli = root.join("mac").join("LocalPackages").join("graph-kit").join("bin").join("graph-kit.js");
    let node = crate::core_host::node_binary();
    if cli.is_file() {
        return Ok((node, cli));
    }
    Err("the GraphKit generator is not bundled and no checkout CLI was found".into())
}

static NEXT_COPY: AtomicU64 = AtomicU64::new(0);

fn run_gk(node: &Path, cli: &Path, args: &[String]) -> Result<(), String> {
    // A bundled CLI sits inside the app bundle. In a checkout build the bundle lives under `desktop/`,
    // whose package.json says `"type": "module"`, so Node treats the CLI's `require` calls as ESM and fails.
    // Run a `.cjs` copy from the temp dir: the CLI is self-contained, and this also avoids any package scope
    // when the app is installed under a user's project tree.
    let n = NEXT_COPY.fetch_add(1, Ordering::Relaxed);
    let temp = std::env::temp_dir().join(format!("llmide-graphkit-{}-{n}.cjs", std::process::id()));
    std::fs::copy(cli, &temp).map_err(|e| format!("cannot prepare the GraphKit CLI: {e}"))?;
    let output = Command::new(node)
        .arg(&temp)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("cannot run the GraphKit generator: {e}"))?;
    let _ = std::fs::remove_file(&temp);
    if output.status.success() { return Ok(()); }
    let err = String::from_utf8_lossy(&output.stderr);
    let msg: String = err.chars().filter(|c| !c.is_control()).take(500).collect();
    Err(if msg.trim().is_empty() { "the GraphKit generator failed".into() } else { format!("the GraphKit generator failed: {msg}") })
}

fn generate(app: &tauri::AppHandle, mode: &str, target: Option<&str>) -> Result<GraphGenerated, String> {
    let (node, cli) = toolchain(app)?;
    let root = crate::project::active_root().ok_or_else(|| "open a project before generating a graph".to_string())?;
    if crate::fs_ops::checked_root(&root).is_err() {
        return Err("the project folder is not usable".into());
    }
    let out_dir = root.join("system").join("graph");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create system/graph: {e}"))?;
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
                run_gk(&node, &cli, &["code".into(), scan_code.to_string_lossy().into_owned(), "--out".into(), code_out.to_string_lossy().into_owned()])?;
                Ok(code_out.clone())
            }
            "memory" => {
                if !scan_docs.is_dir() { return Err("this project has no folder to scan for documents".into()); }
                run_gk(&node, &cli, &["memory".into(), scan_docs.to_string_lossy().into_owned(), "--out".into(), doc_out.to_string_lossy().into_owned()])?;
                Ok(doc_out.clone())
            }
            "all" => {
                run_gk(&node, &cli, &["code".into(), scan_code.to_string_lossy().into_owned(), "--out".into(), code_out.to_string_lossy().into_owned()])?;
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
    let dest = out_dir.join("graph.json");
    // Write to a sibling temp then rename so a reader never sees half a graph.
    let partial = out_dir.join("graph.json.partial");
    std::fs::write(&partial, text.as_bytes()).map_err(|e| format!("cannot write system/graph/graph.json: {e}"))?;
    std::fs::rename(&partial, &dest).map_err(|e| format!("cannot install system/graph/graph.json: {e}"))?;
    Ok(GraphGenerated { path: "system/graph/graph.json".into(), nodes, edges })
}

#[tauri::command]
pub async fn graph_generate(app: tauri::AppHandle, mode: Option<String>, target: Option<String>) -> Result<GraphGenerated, String> {
    let mode = mode.unwrap_or_else(|| "code".into());
    tauri::async_runtime::spawn_blocking(move || generate(&app, &mode, target.as_deref())).await.map_err(|e| format!("graph task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_output_path_is_project_relative_and_fixed() {
        assert!(!Path::new("system/graph/graph.json").is_absolute());
    }
}
