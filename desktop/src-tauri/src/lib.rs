mod attach;
mod ax_probe;
mod chat_archive;
mod chat_cmds;
mod chat_hash;
mod chat_store;
mod confirm;
mod core_env;
mod core_host;
mod fs_ops;
mod fs_watch;
mod git;
mod git_config;
mod git_scm;
mod fsutil;
mod graph_file;
mod notes_fs;
mod notes_write;
mod os_open;
mod proc_tree;
mod project;
mod prefs;
mod project_search;
mod pty;
mod secrets;
mod source_pick;
mod sse_replay;
mod tray;

use std::sync::OnceLock;

use core_host::CoreHost;
use tauri::ipc::{Channel, Response};
use tauri::{Manager, RunEvent};

/// True for the app's own origin only: the bundled frontend (`tauri://localhost`, or
/// `http(s)://tauri.localhost` on Windows) and `about:blank`; debug builds also allow
/// the Vite dev server. Any other navigation (a link, a redirect, `location=`) is
/// blocked so the webview, which holds the IPC grants, can never show remote content.
fn navigation_allowed(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            if url.host_str() == Some("tauri.localhost") {
                return true;
            }
            cfg!(debug_assertions) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(5173)
        }
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

fn navigation_guard() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry, ()>::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let ok = navigation_allowed(url);
            if !ok {
                eprintln!("blocked navigation to {}://{}", url.scheme(), url.host_str().unwrap_or(""));
            }
            ok
        })
        .build()
}

/// Process-wide handle so the panic hook can reach the spawned child.
static CORE: OnceLock<CoreHost> = OnceLock::new();
/// Kept for the process lifetime; dropping it would release the single-instance lock.
static INSTANCE_LOCK: OnceLock<fsutil::InstanceLock> = OnceLock::new();

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
async fn pty_spawn(cols: u16, rows: u16, on_data: Channel<Response>, on_exit: Channel<serde_json::Value>) -> Result<pty::Spawned, String> {
    pty_blocking(move || pty::spawn(cols, rows, on_data, on_exit)).await
}

/// What the Terminal panel shows before any shell exists: feature toggle, consent state, shell name.
/// Never prompts and never spawns.
#[tauri::command]
fn pty_status() -> pty::Status {
    pty::status()
}

/// "Try again" after a refused consent dialog: re-arms the dialog for the next `pty_spawn`
/// (rate limited, only while refused). Does not spawn.
#[tauri::command]
fn pty_retry_consent() -> Result<pty::Status, String> {
    pty::retry_consent()
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
        .manage(chat_cmds::ChatService::new())
        .plugin(navigation_guard())
        .plugin(tauri_plugin_notification::init())
        // A reload drops the webview's terminal state; its shells must not outlive it.
        .on_page_load(|_webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                pty::kill_all();
                pty::reset_consent();
                fs_watch::stop_all();
                // The webview that held the attachment tokens is gone.
                attach::clear();
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
            // One instance per data dir: two first-run instances would race on the
            // keychain secrets and the DB. (Benches opt out and run on a temp setup.)
            if autobench_mode().is_none() {
                if let Ok(dir) = fsutil::desktop_data_dir() {
                    let dir = fsutil::private_dir(&dir)?;
                    match fsutil::acquire_instance_lock(&dir) {
                        Ok(lock) => {
                            let _ = INSTANCE_LOCK.set(lock);
                        }
                        Err(e) => {
                            eprintln!("{e}; exiting");
                            return Err(e.into());
                        }
                    }
                }
            }
            // Host prefs are read once, before the core is spawned: they decide its environment.
            prefs::init(fsutil::desktop_data_dir().ok().and_then(|d| fsutil::private_dir(&d).ok()));
            if let Ok(res) = app.path().resource_dir() {
                core_host::set_resource_dir(res);
            }
            tray::setup(app.handle());
            // SIGTERM/SIGINT bypass Tauri's exit handlers; kill the child first.
            let signal_host = setup_host.clone();
            let signal_chat = app.state::<chat_cmds::ChatService>().inner().clone();
            if let Err(e) = ctrlc::set_handler(move || {
                let _ = signal_chat.quit_archive(std::time::Duration::from_secs(3));
                signal_host.shutdown();
                pty::kill_all();
                std::process::exit(0);
            }) {
                eprintln!("core: signal handler not installed: {e}");
            }
            setup_host.start_in_background(fsutil::desktop_data_dir().ok());
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
            fs_ops::fs_list_dir,
            fs_ops::fs_read_file,
            fs_ops::fs_read_range,
            fs_ops::fs_write_file,
            fs_ops::fs_create,
            fs_ops::fs_rename,
            fs_ops::fs_delete,
            fs_watch::fs_watch_start,
            fs_watch::fs_watch_set,
            fs_watch::fs_watch_stop,
            project_search::project_search_start,
            project_search::project_search_cancel,
            git::git_status,
            git::git_diff,
            git::git_show,
            git::git_stage,
            git_scm::git_diff_hunks,
            git_scm::git_stage_hunks,
            git_scm::git_stage_all,
            git_scm::git_discard,
            git_scm::git_identity,
            git_scm::git_commit,
            git_scm::git_branches,
            git_scm::git_checkout,
            git_scm::git_create_branch,
            git_scm::git_log,
            git_scm::git_commit_files,
            git_scm::git_commit_diff,
            tray::notify,
            tray::tray_status,
            tray::tray_set_close_to_tray,
            bench,
            bench_done,
            autobench_mode,
            graph_path_override,
            theme_override,
            section_override,
            pty_status,
            pty_retry_consent,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_ack,
            pty_kill,
            sse_replay::sse_replay_start,
            sse_replay::sse_replay_stop,
            sse_replay::sse_channel_stream,
            ax_probe::ax_probe,
            chat_cmds::chat_bind_session,
            chat_cmds::chat_unbind_session,
            chat_cmds::chat_list,
            chat_cmds::chat_load,
            chat_cmds::chat_save,
            chat_cmds::chat_delete,
            chat_cmds::chat_archive_status,
            notes_fs::notes_root_get,
            notes_fs::notes_root_choose,
            notes_fs::notes_root_clear,
            notes_fs::notes_list,
            notes_fs::notes_read,
            notes_fs::notes_heads,
            notes_write::note_open,
            notes_write::note_save,
            notes_write::note_create,
            notes_write::note_rename,
            notes_write::notes_delete_many,
            source_pick::source_pick_folder,
            source_pick::pick_folder,
            source_pick::pick_folder_redeem,
            prefs::get_prefs,
            prefs::set_prefs,
            os_open::open_external_url,
            os_open::reveal_in_os,
            attach::attach_pick_files,
            attach::attach_read,
            attach::attach_release,
            confirm::bypass_confirm,
            confirm::trust_confirm
        ])
        .build(tauri::generate_context!())
        .expect("error while building LLM-IDE Desktop PoC");

    app.run(|app_handle, event| match event {
        // Autobench runs must be frontmost: WKWebView does not paint or run rAF/timers for a
        // window that is not key, which stalls the benches. Done after launch so the
        // activation takes effect; the bench needs no external activation step.
        RunEvent::Ready if autobench_mode().is_some() => bring_to_front(app_handle),
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            // Live-then-archive first (the core must still be up), capped at 6 s, once per process.
            let _ = app_handle.state::<chat_cmds::ChatService>().quit_archive_default();
            app_handle.state::<CoreHost>().shutdown();
            pty::kill_all();
            sse_replay::stop();
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::navigation_allowed;

    fn url(s: &str) -> tauri::Url {
        s.parse().unwrap()
    }

    #[test]
    fn only_the_apps_own_origin_may_be_navigated_to() {
        for ok in ["tauri://localhost/index.html", "http://tauri.localhost/", "https://tauri.localhost/x", "about:blank"] {
            assert!(navigation_allowed(&url(ok)), "{ok}");
        }
        for bad in [
            "https://example.com/", "http://127.0.0.1:3456/health", "http://localhost/", "file:///etc/passwd",
            "javascript:alert(1)", "data:text/html,hi", "tauri://evil/", "http://tauri.localhost.evil.com/",
            "about:srcdoc", "blob:http://tauri.localhost/x", "ftp://tauri.localhost/",
        ] {
            assert!(!navigation_allowed(&url(bad)), "{bad}");
        }
    }
}
