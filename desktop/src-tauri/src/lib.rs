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
        .invoke_handler(tauri::generate_handler![ping, core_host::core_status])
        .build(tauri::generate_context!())
        .expect("error while building LLM-IDE Desktop PoC");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            app_handle.state::<CoreHost>().shutdown();
        }
    });
}
