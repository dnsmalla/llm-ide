mod ax_probe;
mod core_host;
mod fsutil;
mod graph_file;
mod project;
mod pty;
mod secrets;
mod sse_replay;
mod tray;

use std::sync::OnceLock;

use core_host::CoreHost;
use tauri::ipc::{Channel, Response};
use tauri::{Manager, RunEvent};

/// Process-wide handle so the panic hook can reach the spawned child.
static CORE: OnceLock<CoreHost> = OnceLock::new();

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// Reads a graph-kit `graph.json` from inside the active project root only
/// (see `graph_file`); the root is host-chosen, never supplied by the webview.
#[tauri::command]
fn read_graph_file(path: String) -> Result<String, String> {
    let root = graph_file::project_root().ok_or("no project root configured")?;
    graph_file::read_within(&root, &path)
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

/// Runs PTY work on the blocking pool: async commands never run on the main thread,
/// and the work may block on pty I/O or a full output queue.
async fn pty_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("pty task failed: {e}"))?
}

/// Starts `$SHELL -l` in a pty; output arrives on `on_data` as raw batches.
#[tauri::command]
async fn pty_spawn(cols: u16, rows: u16, on_data: Channel<Response>) -> Result<pty::Spawned, String> {
    pty_blocking(move || pty::spawn(cols, rows, on_data)).await
}

#[tauri::command]
async fn pty_write(id: u32, data: String) -> Result<(), String> {
    pty_blocking(move || pty::write(id, &data)).await
}

/// Flow control: the webview reports output bytes xterm has finished parsing.
#[tauri::command]
fn pty_ack(id: u32, bytes: u64) {
    pty::ack(id, bytes);
}

#[tauri::command]
async fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    pty_blocking(move || pty::resize(id, cols, rows)).await
}

#[tauri::command]
async fn pty_kill(id: u32) -> Result<(), String> {
    pty_blocking(move || pty::kill(id)).await
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
        pty::kill_all_from_panic();
        previous_hook(info);
    }));

    let app = tauri::Builder::default()
        .manage(host)
        .plugin(tauri_plugin_notification::init())
        // A reload drops the webview's terminal state; its shells must not outlive it.
        .on_page_load(|_webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                pty::kill_all();
                pty::reset_consent();
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Opt-in close-to-tray (default off); only when a tray icon exists.
                if window.label() == "main" && tray::should_hide_on_close() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                pty::kill_all();
                pty::reset_consent();
            }
        })
        .setup(move |app| {
            tray::setup(app.handle());
            // SIGTERM/SIGINT bypass Tauri's exit handlers; kill the child first.
            let signal_host = setup_host.clone();
            if let Err(e) = ctrlc::set_handler(move || {
                signal_host.shutdown();
                pty::kill_all();
                std::process::exit(0);
            }) {
                eprintln!("core: signal handler not installed: {e}");
            }
            setup_host.start_in_background(app.path().app_data_dir().ok());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            core_host::core_status,
            secrets::secrets_status,
            read_graph_file,
            project::project_open,
            project::project_open_recent,
            project::project_active,
            project::project_recent,
            tray::notify,
            tray::tray_status,
            tray::tray_set_close_to_tray,
            bench,
            bench_done,
            autobench_mode,
            graph_path_override,
            theme_override,
            section_override,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_ack,
            pty_kill,
            sse_replay::sse_replay_start,
            sse_replay::sse_replay_stop,
            sse_replay::sse_channel_stream,
            ax_probe::ax_probe
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
            pty::kill_all();
            sse_replay::stop();
        }
        _ => {}
    });
}
