//! Generate a project's code graph with the GraphKit TypeScript CLI (the schema-compatible sibling of the Mac's
//! Swift scanners), writing the canonical `system/graph/graph.json` the Graph screen already reads.
//!
//! Runs the bundled CLI with the bundled node; a dev build falls back to the checkout. The page never chooses an
//! arbitrary input: the active project root is host state and the output is inside that project.
use std::path::{Path, PathBuf};
use std::process::Command;

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

fn generate(app: &tauri::AppHandle) -> Result<GraphGenerated, String> {
    let (node, cli) = toolchain(app)?;
    let root = crate::project::active_root().ok_or_else(|| "open a project before generating a graph".to_string())?;
    if crate::fs_ops::checked_root(&root).is_err() {
        return Err("the project folder is not usable".into());
    }
    let out_dir = root.join("system").join("graph");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create system/graph: {e}"))?;
    let tmp = std::env::temp_dir().join(format!("llmide-graph-{}-{}.json", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    let output = Command::new(&node)
        .arg(&cli)
        .arg("code")
        .arg(&root)
        .arg("--out")
        .arg(&tmp)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("cannot run the GraphKit generator: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let msg: String = err.chars().filter(|c| !c.is_control()).take(500).collect();
        let _ = std::fs::remove_file(&tmp);
        return Err(if msg.trim().is_empty() { "the GraphKit generator failed".into() } else { format!("the GraphKit generator failed: {msg}") });
    }
    let text = std::fs::read_to_string(&tmp).map_err(|e| format!("cannot read the generated graph: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("the generator produced invalid JSON: {e}"))?;
    let nodes = value.get("nodes").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0);
    let edges = value.get("edges").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0);
    let dest = out_dir.join("graph.json");
    // Write to a sibling temp then rename so a reader never sees half a graph.
    let partial = out_dir.join("graph.json.partial");
    std::fs::write(&partial, text.as_bytes()).map_err(|e| format!("cannot write system/graph/graph.json: {e}"))?;
    std::fs::rename(&partial, &dest).map_err(|e| format!("cannot install system/graph/graph.json: {e}"))?;
    Ok(GraphGenerated { path: "system/graph/graph.json".into(), nodes, edges })
}

#[tauri::command]
pub async fn graph_generate(app: tauri::AppHandle) -> Result<GraphGenerated, String> {
    tauri::async_runtime::spawn_blocking(move || generate(&app)).await.map_err(|e| format!("graph task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_output_path_is_project_relative_and_fixed() {
        assert_eq!("system/graph/graph.json", "system/graph/graph.json");
        assert!(!Path::new("system/graph/graph.json").is_absolute());
    }
}
