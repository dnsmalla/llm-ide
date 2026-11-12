//! Voice input for the chat composer. The macOS web view exposes no speech engine to apps, so the host starts the
//! system's own Dictation (`startDictation:` down the responder chain) in whatever text field has focus, exactly like
//! the Edit → Start Dictation menu item. The system shows its own mic UI and asks for permission itself; the app
//! never touches the microphone, so it needs no microphone entitlement.

/// Starts macOS Dictation in the focused text field. Off macOS it is refused with a plain message.
#[tauri::command]
pub fn start_system_dictation(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(|| {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                let ns_app = objc2_app_kit::NSApplication::sharedApplication(mtm);
                let nil: *mut objc2::runtime::AnyObject = std::ptr::null_mut();
                // SAFETY: a standard NSApplication action on the main thread; nil target = first responder.
                let _sent: bool = unsafe { objc2::msg_send![&*ns_app, sendAction: objc2::sel!(startDictation:), to: nil, from: nil] };
            }
        })
        .map_err(|e| format!("Dictation could not start: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("System dictation is only available on macOS.".into())
    }
}
