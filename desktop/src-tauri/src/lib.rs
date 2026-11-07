mod attach;
#[cfg(feature = "spike")]
mod ax_probe;
mod capture_validate;
mod capture_delta;
mod capture_model;
mod capture_readers;
mod capture_store;
mod capture_ax_macos;
mod capture_session;
mod capture_host;
mod capture_archivist;
mod chat_archive;
mod chat_cmds;
mod chat_hash;
mod chat_store;
mod confirm;
mod crash_report;
mod export_note;
mod docgen_dest;
mod core_env;
mod core_host;
mod core_log;
mod feature_rebuild;
mod foreign_core;
mod fs_ops;
mod fs_watch;
mod git;
mod git_config;
mod git_scm;
mod host_approval;
mod fsutil;
mod graph_file;
mod mermaid_runtime;
mod menu;
mod loop_runner;
mod notes_fs;
mod notes_write;
mod os_open;
mod proc_tree;
mod project;
mod project_layout;
mod project_scaffold;
mod repo_clone;
mod backend_pick;
mod graph_gen;
mod prefs;
mod project_search;
mod pty;
mod rtk;
mod secrets;
mod self_heal;
mod self_heal_fix;
mod source_pick;
#[cfg(feature = "spike")]
mod sse_replay;
mod trash_guard;
mod updater;
mod notify;
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
    navigation_allowed_for(fsutil::current_os(), cfg!(debug_assertions), url)
}

/// Per-OS origin rule (pure, so every OS is testable anywhere). The packaged webview's origin is
/// `tauri://localhost` on macOS and Linux and `http(s)://tauri.localhost` on Windows ONLY: accepting the
/// other OS's form would let a page on a look-alike origin (or a port) pass the guard. No port is ever allowed
/// for the app's own origin; the Vite dev server (`http://127.0.0.1:5173`) only in debug builds.
fn navigation_allowed_for(os: fsutil::Os, debug: bool, url: &tauri::Url) -> bool {
    if url.username() != "" || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "tauri" => os != fsutil::Os::Windows && url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => {
            if os == fsutil::Os::Windows && url.host_str() == Some("tauri.localhost") && url.port().is_none() {
                return true;
            }
            debug && url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(5173)
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

#[cfg(feature = "spike")]
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// The OS the window chrome is for, as a fixed token (`macos`, `windows`, `linux`, `other`). The webview uses it
/// to leave room for the macOS traffic lights (`titleBarStyle: "Overlay"`); it reveals nothing else.
fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        _ => "other",
    }
}

#[tauri::command]
fn host_platform() -> &'static str {
    platform_name()
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
#[cfg(feature = "spike")]
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
#[cfg(feature = "spike")]
#[tauri::command]
fn bench_done(app: tauri::AppHandle) {
    app.exit(0);
}

/// Value of `LLMIDE_POC_AUTOBENCH` (e.g. `graph`), if set and non-empty.
#[cfg(feature = "spike")]
#[tauri::command]
fn autobench_mode() -> Option<String> {
    autobench_env()
}

/// The autobench env switch. Product builds (no `spike` feature) never honour it: it also skips the
/// single-instance lock and brings the window to the front.
#[cfg(feature = "spike")]
fn autobench_env() -> Option<String> {
    std::env::var("LLMIDE_POC_AUTOBENCH").ok().filter(|v| !v.is_empty())
}

#[cfg(not(feature = "spike"))]
fn autobench_env() -> Option<String> {
    None
}

/// Value of `LLMIDE_POC_GRAPH` (a graph.json path), if set and non-empty. The
/// Graph tab falls back to its built-in path when this is absent.
#[cfg(feature = "spike")]
#[tauri::command]
fn graph_path_override() -> Option<String> {
    std::env::var("LLMIDE_POC_GRAPH")
        .ok()
        .filter(|v| !v.is_empty())
}

/// Value of `LLMIDE_POC_THEME` (dark | light | midnight), if set. Used by the
/// parity screenshots to launch the shell in a given theme; the webview
/// validates it, so any other value is ignored.
#[cfg(feature = "spike")]
#[tauri::command]
fn theme_override() -> Option<String> {
    std::env::var("LLMIDE_POC_THEME")
        .ok()
        .filter(|v| !v.is_empty())
}

/// Value of `LLMIDE_POC_SECTION` (a section id such as `editor`), if set. Lets the
/// parity screenshots open a section directly; the webview validates the id.
#[cfg(feature = "spike")]
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

/// The command list. Product commands are listed once here; the Phase-0 spike/bench commands are added only
/// when the `spike` cargo feature is on (off by default and in every release build), so a product binary does
/// not even contain them. `scripts/check-capabilities.mjs` parses this block.
macro_rules! product_handlers {
    ($($spike:path),* $(,)?) => {
        tauri::generate_handler![
                capture_host::capture_status,
                capture_host::capture_request_permission,
                capture_host::capture_open_settings,
                capture_host::capture_start,
                capture_host::capture_stop,
                capture_host::capture_recover_list,
                capture_host::capture_recover_finish,
                capture_host::capture_recover_discard,
                core_host::core_status,
                core_host::core_stop,
                core_host::core_start,
                core_host::core_restart,
                backend_pick::backend_pick_node,
                backend_pick::backend_pick_dir,
                backend_pick::backend_detect,
                graph_gen::graph_generate,
                graph_gen::graph_cancel,
                loop_runner::loop_run_stage,
                loop_runner::loop_run_loop,
                loop_runner::loop_work_root,
                loop_runner::loop_run_fault_verify,
                loop_runner::loop_environment_check,
                loop_runner::loop_cancel,
                loop_runner::loop_changed_paths,
                loop_runner::loop_revert_paths,
                repo_clone::repo_clone,
                feature_rebuild::feature_rebuild,
                core_log::core_log_read,
                core_log::core_log_clear,
                secrets::secrets_status,
                read_graph_file,
                project::project_open,
                project::project_open_recent,
                project::project_active,
                project::project_recent,
                project::project_recent_all,
                project::project_forget_recent,
                project::project_close,
                project::project_create,
                project_layout::project_paths,
                project_layout::project_rebuild_folders,
                project_layout::project_memory,
                fs_ops::fs_list_dir,
                fs_ops::fs_read_file,
                fs_ops::fs_read_image,
                fs_ops::fs_read_range,
                fs_ops::fs_write_file,
                fs_ops::fs_create,
                fs_ops::fs_rename,
                fs_ops::fs_delete,
                fs_ops::fs_copy,
                fs_ops::fs_open_pdf,
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
                git_scm::git_tags,
                crash_report::crash_report_latest,
                crash_report::crash_report_dismiss,
                self_heal::self_heal_take,
                self_heal_fix::self_heal_source,
                self_heal_fix::self_heal_prepare,
                self_heal_fix::self_heal_verify,
                self_heal_fix::self_heal_diff,
                self_heal_fix::self_heal_apply,
                self_heal_fix::self_heal_remove,
                export_note::export_note,
                docgen_dest::docgen_destination_status,
                docgen_dest::docgen_destination_pick,
                docgen_dest::docgen_destination_clear,
                docgen_dest::docgen_save_external,
                git_scm::git_commit_files,
                git_scm::git_commit_diff,
                git_scm::git_branch_delete,
                git_scm::git_tag_create,
                git_scm::git_stash_list,
                git_scm::git_stash_push,
                git_scm::git_stash_apply,
                git_scm::git_stash_pop,
                git_scm::git_stash_drop,
                git_scm::git_merge,
                git_scm::git_merge_abort,
                git_scm::git_commit_amend,
                git_scm::git_discard_all,
                notify::notify_user,
                notify::notify_focus,
                tray::tray_report,
                tray::tray_status,
                tray::tray_set_close_to_tray,
                tray::tray_set_icon_visible,
                pty_status,
                pty_retry_consent,
                pty_spawn,
                pty_write,
                pty_resize,
                pty_ack,
                pty_kill,
                chat_cmds::chat_bind_session,
                chat_cmds::chat_unbind_session,
                chat_cmds::chat_list,
                chat_cmds::chat_load,
                chat_cmds::chat_save,
                chat_cmds::chat_delete,
                chat_cmds::chat_confirm_truncate,
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
                host_platform,
                prefs::get_prefs,
                prefs::set_prefs,
                updater::update_status,
                updater::update_check,
                updater::update_install,
                os_open::open_external_url,
                os_open::reveal_in_os,
                attach::attach_pick_files,
                attach::attach_read,
                attach::attach_release,
                confirm::bypass_confirm,
                confirm::bypass_confirm_signed,
                confirm::trust_confirm,
                host_approval::host_bus_proof,
                mermaid_runtime::mermaid_runtime_status,
                mermaid_runtime::mermaid_runtime_install,
                mermaid_runtime::mermaid_runtime_remove,
                mermaid_runtime::mermaid_runtime_read,
                rtk::rtk_status,
                rtk::rtk_install,
            $($spike),*
        ]
    };
}

#[cfg(feature = "spike")]
macro_rules! app_handler {
    () => {
        product_handlers![
                ping,
                bench,
                bench_done,
                autobench_mode,
                graph_path_override,
                theme_override,
                section_override,
                sse_replay::sse_replay_start,
                sse_replay::sse_replay_stop,
                sse_replay::sse_channel_stream,
                ax_probe::ax_probe,
                capture_ax_macos::capture_dump_tree
        ]
    };
}

#[cfg(not(feature = "spike"))]
macro_rules! app_handler {
    () => {
        product_handlers![]
    };
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
        // Last-launch notice (the Mac's CrashReportBanner): a small redacted record in the app data dir.
        crash_report::record_panic(info);
        previous_hook(info);
    }));

    let context = tauri::generate_context!();
    let update_problem = updater::config_problem(context.config().plugins.0.get("updater"));
    updater::init(update_problem);

    let builder = tauri::Builder::default()
        .manage(host)
        .manage(chat_cmds::ChatService::new())
        .plugin(navigation_guard())
        .plugin(tauri_plugin_notification::init());
    // The updater exists only in a release build whose overlay carries a valid key and the fixed channel URL.
    let builder = if update_problem.is_none() { builder.plugin(tauri_plugin_updater::Builder::new().build()) } else { builder };
    let app = builder
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
            if let tauri::WindowEvent::Focused(true) = event {
                if window.label() == "main" { notify::on_main_focused(window.app_handle()); }
            }
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
            if autobench_env().is_none() {
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
            graph_gen::start_auto(app.handle().clone());
            if let Ok(res) = app.path().resource_dir() {
                core_host::set_resource_dir(res);
            }
            tray::setup(app.handle());
        tray::start_watch(app.handle().clone());
            menu::setup(app.handle())?;
            // SIGTERM/SIGINT bypass Tauri's exit handlers; kill the child first.
            let signal_host = setup_host.clone();
            let signal_chat = app.state::<chat_cmds::ChatService>().inner().clone();
            if let Err(e) = ctrlc::set_handler(move || {
                let _ = signal_chat.quit_archive(std::time::Duration::from_secs(3));
                signal_host.shutdown();
                graph_gen::graph_cancel();
                pty::kill_all();
                std::process::exit(0);
            }) {
                eprintln!("core: signal handler not installed: {e}");
            }
            let data_dir = fsutil::desktop_data_dir().ok();
            let auto_start = data_dir.as_ref().map(|d| prefs::load_from(d).backend_auto_start).unwrap_or(true);
            if auto_start {
                setup_host.start_in_background(data_dir);
            } else {
                // "Start backend on app launch" is off: the app opens with the core stopped; Start uses this dir.
                setup_host.mark_stopped(data_dir);
            }
            updater::start_background(app.handle().clone());
            Ok(())
        })
        .invoke_handler(app_handler!())
        .build(context)
        .expect("error while building LLM-IDE Desktop PoC");

    app.run(|app_handle, event| match event {
        // Autobench runs must be frontmost: WKWebView does not paint or run rAF/timers for a
        // window that is not key, which stalls the benches. Done after launch so the
        // activation takes effect; the bench needs no external activation step.
        RunEvent::Ready if autobench_env().is_some() => bring_to_front(app_handle),
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            exit_cleanup(app_handle);
            crash_report::clear_own_on_clean_exit();
        }
        // macOS: a Dock click brings the hidden window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => tray::show_main(app_handle),
        _ => {}
    });
}

/// The pre-exit steps, in order: capture, live-then-archive chat while the core is still up (capped, once per
/// process), core, terminals, graph. Idempotent: the exit handler may run again after the updater already ran it.
pub(crate) fn exit_cleanup(app: &tauri::AppHandle) {
    capture_host::shutdown();
    let _ = app.state::<chat_cmds::ChatService>().quit_archive_default();
    app.state::<CoreHost>().shutdown();
    pty::kill_all();
    #[cfg(feature = "spike")]
    sse_replay::stop();
    graph_gen::graph_cancel();
}

#[cfg(test)]
mod tests {
    use super::{navigation_allowed, navigation_allowed_for};
    use crate::fsutil::Os;

    fn url(s: &str) -> tauri::Url {
        s.parse().unwrap()
    }

    #[test]
    fn platform_name_is_one_fixed_token() {
        assert!(["macos", "windows", "linux", "other"].contains(&super::platform_name()));
        assert_eq!(super::host_platform(), super::platform_name());
    }

    const COMMON_BAD: [&str; 14] = [
        "https://example.com/", "http://127.0.0.1:3456/health", "http://localhost/", "file:///etc/passwd",
        "javascript:alert(1)", "data:text/html,hi", "tauri://evil/", "http://tauri.localhost.evil.com/",
        "about:srcdoc", "blob:http://tauri.localhost/x", "ftp://tauri.localhost/", "tauri://user@localhost/",
        "http://user:pw@tauri.localhost/", "tauri://localhost.evil.com/",
    ];

    #[test]
    fn only_the_apps_own_origin_may_be_navigated_to() {
        for ok in ["tauri://localhost/index.html", "about:blank"] {
            assert!(navigation_allowed_for(Os::Mac, false, &url(ok)), "{ok}");
        }
        for bad in COMMON_BAD {
            for os in [Os::Mac, Os::Linux, Os::Windows] {
                assert!(!navigation_allowed_for(os, false, &url(bad)), "{os:?} {bad}");
            }
        }
        // whichever OS runs the tests, the wrapper agrees with the per-OS rule
        assert_eq!(navigation_allowed(&url("about:blank")), true);
    }

    #[test]
    fn macos_and_linux_accept_only_the_tauri_scheme() {
        for os in [Os::Mac, Os::Linux] {
            assert!(navigation_allowed_for(os, false, &url("tauri://localhost/")));
            for bad in ["http://tauri.localhost/", "https://tauri.localhost/x", "tauri://localhost:8080/", "http://tauri.localhost:80/"] {
                assert!(!navigation_allowed_for(os, false, &url(bad)), "{os:?} {bad}");
            }
        }
    }

    #[test]
    fn windows_accepts_only_http_or_https_tauri_localhost_without_a_port() {
        for ok in ["http://tauri.localhost/", "https://tauri.localhost/index.html", "about:blank"] {
            assert!(navigation_allowed_for(Os::Windows, false, &url(ok)), "{ok}");
        }
        for bad in ["tauri://localhost/", "http://tauri.localhost:3456/", "https://tauri.localhost:1/", "http://tauri.localhost.evil.com/"] {
            assert!(!navigation_allowed_for(Os::Windows, false, &url(bad)), "{bad}");
        }
    }

    #[test]
    fn the_dev_server_is_a_debug_build_only_and_port_exact() {
        assert!(navigation_allowed_for(Os::Mac, true, &url("http://127.0.0.1:5173/")));
        assert!(!navigation_allowed_for(Os::Mac, false, &url("http://127.0.0.1:5173/")));
        assert!(!navigation_allowed_for(Os::Mac, true, &url("http://127.0.0.1:5174/")));
        assert!(!navigation_allowed_for(Os::Mac, true, &url("https://127.0.0.1:5173/")));
    }
}
