mod core_host;

use std::sync::OnceLock;

use core_host::CoreHost;
use tauri::{Manager, RunEvent};

/// Process-wide handle so the panic hook can reach the spawned child.
static CORE: OnceLock<CoreHost> = OnceLock::new();

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Upper bound on a graph file the webview may load (the real graph is ~1 MB).
const GRAPH_FILE_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Reads a graph-kit `graph.json`. PoC: any path named graph.json is accepted.
/// Phase 1 must restrict this to the active project root (canonical path
/// prefix check) before the Graph tab can open arbitrary projects. The webview cannot read arbitrary files, so
/// this is the only file read the Graph tab can trigger, and it is limited to
/// files named exactly `graph.json`.
#[tauri::command]
fn read_graph_file(path: String) -> Result<String, String> {
    let canonical =
        std::fs::canonicalize(&path).map_err(|e| format!("cannot resolve {path}: {e}"))?;
    let is_graph = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "graph.json");
    if !is_graph {
        return Err("only files named graph.json can be read".into());
    }
    let meta = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > GRAPH_FILE_MAX_BYTES {
        return Err("graph.json is not a regular file within the size limit".into());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("read failed: {e}"))
}

/// Prints one measurement as `BENCH <json>` on stdout. The line must be a
/// single JSON object so the report task can parse it.
#[tauri::command]
fn bench(line: String) -> Result<(), String> {
    if line.contains('\n') {
        return Err("bench line must be single-line JSON".into());
    }
    serde_json::from_str::<serde_json::Value>(&line)
        .map_err(|e| format!("bench line is not JSON: {e}"))?;
    println!("BENCH {line}");
    Ok(())
}

/// Ends the bench run through the normal exit path, so `RunEvent::ExitRequested`
/// shuts the Node core child down.
#[tauri::command]
fn bench_done(app: tauri::AppHandle) {
    app.exit(0);
}

/// Value of `LLMIDE_POC_AUTOBENCH` (e.g. `graph`), if set and non-empty.
#[tauri::command]
fn autobench_mode() -> Option<String> {
    std::env::var("LLMIDE_POC_AUTOBENCH")
        .ok()
        .filter(|v| !v.is_empty())
}

/// Value of `LLMIDE_POC_GRAPH` (a graph.json path), if set and non-empty. The
/// Graph tab falls back to its built-in path when this is absent.
#[tauri::command]
fn graph_path_override() -> Option<String> {
    std::env::var("LLMIDE_POC_GRAPH")
        .ok()
        .filter(|v| !v.is_empty())
}

/// Value of `LLMIDE_POC_THEME` (dark | light | midnight), if set. Used by the
/// parity screenshots to launch the shell in a given theme; the webview
/// validates it, so any other value is ignored.
#[tauri::command]
fn theme_override() -> Option<String> {
    std::env::var("LLMIDE_POC_THEME")
        .ok()
        .filter(|v| !v.is_empty())
}

/// Value of `LLMIDE_POC_SECTION` (a section id such as `editor`), if set. Lets the
/// parity screenshots open a section directly; the webview validates the id.
#[tauri::command]
fn section_override() -> Option<String> {
    std::env::var("LLMIDE_POC_SECTION")
        .ok()
        .filter(|v| !v.is_empty())
}

/// Shows and focuses the main window, and activates the app on macOS.
fn bring_to_front(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    #[cfg(target_os = "macos")]
    if let Some(mtm) = objc2::MainThreadMarker::new() {
        let app_kit = objc2_app_kit::NSApplication::sharedApplication(mtm);
        // Best effort: macOS refuses self-activation for a process the user did
        // not launch (a terminal-started bench stays inactive ~30 s), so benches
        // still activate it from outside. A Finder/Dock launch is frontmost anyway.
        #[allow(deprecated)]
        app_kit.activateIgnoringOtherApps(true);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let host = CoreHost::new();
    let setup_host = host.clone();
    let _ = CORE.set(host.clone());

    // A panic on any thread unwinds past Drop only if clones are gone, which
    // they never are (CORE and the ctrlc closure hold them), so kill the child
    // from the hook before chaining to the previous hook.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(h) = CORE.get() {
            h.shutdown_from_panic();
        }
        previous_hook(info);
    }));

    let app = tauri::Builder::default()
        .manage(host)
        .setup(move |_app| {
            // SIGTERM/SIGINT bypass Tauri's exit handlers; kill the child first.
            let signal_host = setup_host.clone();
            if let Err(e) = ctrlc::set_handler(move || {
                signal_host.shutdown();
                std::process::exit(0);
            }) {
                eprintln!("core: signal handler not installed: {e}");
            }
            setup_host.start_in_background();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            core_host::core_status,
            read_graph_file,
            bench,
            bench_done,
            autobench_mode,
            graph_path_override,
            theme_override,
            section_override
        ])
        .build(tauri::generate_context!())
        .expect("error while building LLM-IDE Desktop PoC");

    app.run(|app_handle, event| match event {
        // Autobench runs must be frontmost: WKWebView does not paint or run rAF/timers for a
        // window that is not key, which stalls the benches. Done after launch so the
        // activation takes effect; the bench needs no external activation step.
        RunEvent::Ready if autobench_mode().is_some() => bring_to_front(app_handle),
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            app_handle.state::<CoreHost>().shutdown();
        }
        _ => {}
    });
}
