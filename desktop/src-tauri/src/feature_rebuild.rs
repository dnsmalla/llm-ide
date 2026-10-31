//! Apply & Rebuild: start a reduced build of this app from the source checkout it was built from.
//!
//! The app stays usable while the detached script builds; the script then waits for this process to exit, swaps the
//! installed `.app` (keeping one rollback slot) and reopens it. The webview supplies feature KEYS only; the source
//! root comes from the bundle's `Resources/source-root.txt`, written by `scripts/build-desktop-mac.sh` for a local
//! build and omitted (`LLMIDE_OMIT_SOURCE_ROOT=1`) for a distributed release, where this command refuses.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;

const SCRIPT_REL: &str = "scripts/rebuild-desktop-features.sh";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RebuildStarted {
    pub started: bool,
    pub message: String,
}

/// Known keys only, in the server's order, with `agent_chat` always present (same rule as the prefs profile).
pub fn normalized(features: &[String]) -> Vec<String> {
    let mut list: Vec<String> = crate::prefs::FEATURE_KEYS
        .iter()
        .filter(|k| features.iter().any(|f| f == *k))
        .map(|k| (*k).to_string())
        .collect();
    if !list.iter().any(|k| k == "agent_chat") {
        list.insert(0, "agent_chat".to_string());
    }
    list
}

/// The checkout this bundle was built from, if the marker is present and still looks like one.
pub fn source_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?; // <app>/Contents/MacOS/<binary> -> <app>/Contents
    let text = std::fs::read_to_string(contents.join("Resources").join("source-root.txt")).ok()?;
    let root = PathBuf::from(text.trim());
    let ok = root.is_absolute() && root.join("desktop").is_dir() && root.join(SCRIPT_REL).is_file();
    ok.then_some(root)
}

/// macOS only: the swap script uses `open`/`ditto`, and the desktop ships macOS first.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn feature_rebuild(features: Vec<String>) -> Result<RebuildStarted, String> {
    let root = source_root().ok_or_else(|| {
        "This app was not built from a source checkout, so it cannot rebuild itself. Use a distributed update instead."
            .to_string()
    })?;
    let list = normalized(&features);
    let script = root.join(SCRIPT_REL);
    let mut cmd = Command::new("bash");
    cmd.arg(&script)
        .arg(std::process::id().to_string())
        .arg(list.join(","))
        .arg(root.to_string_lossy().into_owned())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Its own process group, so quitting this app (which stops its whole tree) does not kill the build.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map_err(|e| format!("cannot start the rebuild: {e}"))?;
    Ok(RebuildStarted {
        started: true,
        message: format!(
            "Rebuilding with {} feature(s). This window stays usable; the app restarts on its own when the build is ready.",
            list.len()
        ),
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn feature_rebuild(_features: Vec<String>) -> Result<RebuildStarted, String> {
    Err("Rebuilding from inside the app is macOS-only for now.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_keys_survive_and_chat_is_forced() {
        let out = normalized(&["doc_gen".into(), "nope".into(), "file_explorer".into(), "doc_gen".into()]);
        assert_eq!(out, ["agent_chat", "file_explorer", "doc_gen"], "canonical order, chat added, unknown dropped");
        assert_eq!(normalized(&[]), ["agent_chat"], "never empty");
        assert_eq!(normalized(&["terminal".into()]), ["agent_chat", "terminal"]);
    }

    #[test]
    fn the_source_marker_must_point_at_a_real_checkout() {
        // The test process has no <app>/Contents/Resources/source-root.txt, so there is no checkout.
        assert_eq!(source_root(), None);
    }
}
