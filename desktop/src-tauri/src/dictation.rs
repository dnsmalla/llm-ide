//! Voice input for the chat composer. The macOS web view exposes no speech engine to apps, so the host starts the
//! system's own Dictation (`startDictation:` down the responder chain) in whatever text field has focus, exactly like
//! the Edit → Start Dictation menu item. The system shows its own mic UI and asks for permission itself; the app
//! never touches the microphone, so it needs no microphone entitlement.

/// Starts macOS Dictation in the focused text field. Off macOS it is refused with a plain message.
/// Errors when no responder handled `startDictation:`, so the composer can say so instead of failing silently.
#[tauri::command]
pub fn start_system_dictation(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        // A main thread busier than the timeout must not start Dictation after the UI already showed an error.
        let abandoned = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let abandoned_main = abandoned.clone();
        app.run_on_main_thread(move || {
            if abandoned_main.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let Some(mtm) = objc2::MainThreadMarker::new() else { return };
            let ns_app = objc2_app_kit::NSApplication::sharedApplication(mtm);
            // NOTE: diagnostic for "Dictation did not start because there is bottom line input" (DictationIM):
            // record which view holds keyboard focus and whether it is an inline text-input client.
            log_responder_state(&ns_app);
            let nil: *mut objc2::runtime::AnyObject = std::ptr::null_mut();
            // SAFETY: a standard NSApplication action on the main thread; nil target = first responder.
            // BOOL is a signed char on x86_64, so a Rust bool here fails objc2's encoding check on Intel Macs.
            let sent: objc2::runtime::Bool =
                unsafe { objc2::msg_send![&*ns_app, sendAction: objc2::sel!(startDictation:), to: nil, from: nil] };
            let sent = sent.as_bool();
            nslog(&format!("dictation: startDictation: sent={sent}"));
            let _ = tx.send(sent);
        })
        .map_err(|e| format!("Dictation could not start: {e}"))?;
        match rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(true) => Ok(()),
            Ok(false) => Err("Dictation could not start: no text field accepted it.".into()),
            Err(_) => {
                abandoned.store(true, std::sync::atomic::Ordering::SeqCst);
                Err("Dictation could not start: the app did not respond.".into())
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("System dictation is only available on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
fn log_responder_state(ns_app: &objc2_app_kit::NSApplication) {
    use objc2::runtime::{AnyObject, Bool};
    // SAFETY: plain AppKit getters on the main thread; every pointer is nil-checked before use.
    unsafe {
        let window: *mut AnyObject = objc2::msg_send![ns_app, keyWindow];
        if window.is_null() {
            nslog("dictation: no key window");
            return;
        }
        let responder: *mut AnyObject = objc2::msg_send![&*window, firstResponder];
        if responder.is_null() {
            nslog("dictation: key window has no first responder");
            return;
        }
        let class = (*responder).class().name().to_string_lossy().into_owned();
        let marked: Bool =
            objc2::msg_send![&*responder, respondsToSelector: objc2::sel!(hasMarkedText)];
        let context: *mut AnyObject = objc2::msg_send![&*responder, inputContext];
        let current: *mut AnyObject =
            objc2::msg_send![objc2::class!(NSTextInputContext), currentInputContext];
        let source: String = if current.is_null() {
            "nil".into()
        } else {
            let id: *mut objc2_foundation::NSString =
                objc2::msg_send![&*current, selectedKeyboardInputSource];
            if id.is_null() {
                "nil".into()
            } else {
                (*id).to_string()
            }
        };
        nslog(&format!(
            "dictation: firstResponder={class} textInputClient={} inputContext={} currentInputContext={} source={source}",
            marked.as_bool(),
            if context.is_null() { "nil" } else { "set" },
            if current.is_null() { "nil" } else if current == context { "same" } else { "other" },
        ));
    }
}

/// Writes one line to the unified log (`log show --predicate 'eventMessage BEGINSWITH "dictation:"'`).
#[cfg(target_os = "macos")]
fn nslog(message: &str) {
    unsafe extern "C" {
        fn NSLog(format: *const objc2_foundation::NSString, ...);
    }
    let text = objc2_foundation::NSString::from_str(message);
    let format = objc2_foundation::ns_string!("%@");
    // SAFETY: "%@" consumes exactly one object argument, which is a live NSString.
    unsafe { NSLog(format, &*text as *const objc2_foundation::NSString) };
}
