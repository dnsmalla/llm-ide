//! Voice input for the chat composer. The macOS web view exposes no speech engine to apps, so the host starts the
//! system's own Dictation (`startDictation:` down the responder chain) in whatever text field has focus, exactly like
//! the Edit → Start Dictation menu item. The system shows its own mic UI and asks for permission itself; the app
//! never touches the microphone, so it needs no microphone entitlement.

/// Starts macOS Dictation in the focused text field. Off macOS it is refused with a plain message.
///
/// A click on the composer's mic moves WebKit's focus for a moment, and WKWebView has an input context only while an
/// editable element is focused. Dictation asked to start before the web view catches up finds no input context, falls
/// back to "bottom line input" and refuses (DictationIM logs exactly that). So this waits, off the main thread, until
/// the focused web view has an input context, and only then sends `startDictation:`.
#[tauri::command]
pub async fn start_system_dictation(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || start_when_ready(&app))
            .await
            .map_err(|e| format!("Dictation could not start: {e}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("System dictation is only available on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
const READY_ATTEMPTS: u32 = 10;
#[cfg(target_os = "macos")]
const READY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

/// What one main-thread attempt found.
#[cfg(target_os = "macos")]
enum Attempt {
    /// No editable element has the input context yet.
    NotReady,
    /// `startDictation:` was sent; whether a responder handled it.
    Sent(bool),
}

#[cfg(target_os = "macos")]
fn start_when_ready(app: &tauri::AppHandle) -> Result<(), String> {
    for attempt in 0..READY_ATTEMPTS {
        // Only the last attempt sends without an input context, so the log and the error show what macOS saw.
        let force = attempt + 1 == READY_ATTEMPTS;
        match attempt_on_main(app, force)? {
            Attempt::Sent(true) => return Ok(()),
            Attempt::Sent(false) => {
                return Err("Dictation could not start: no text field accepted it.".into())
            }
            Attempt::NotReady => std::thread::sleep(READY_INTERVAL),
        }
    }
    Err("Dictation could not start: click into the message box, then try again.".into())
}

#[cfg(target_os = "macos")]
fn attempt_on_main(app: &tauri::AppHandle, force: bool) -> Result<Attempt, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Attempt>();
    // A main thread busier than the timeout must not start Dictation after the UI already showed an error.
    let abandoned = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let abandoned_main = abandoned.clone();
    app.run_on_main_thread(move || {
        if abandoned_main.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            return;
        };
        let ns_app = objc2_app_kit::NSApplication::sharedApplication(mtm);
        let ready = focused_input_ready(&ns_app);
        if !ready && !force {
            let _ = tx.send(Attempt::NotReady);
            return;
        }
        let nil: *mut objc2::runtime::AnyObject = std::ptr::null_mut();
        // SAFETY: a standard NSApplication action on the main thread; nil target = first responder.
        // BOOL is a signed char on x86_64, so a Rust bool here fails objc2's encoding check on Intel Macs.
        let sent: objc2::runtime::Bool = unsafe {
            objc2::msg_send![&*ns_app, sendAction: objc2::sel!(startDictation:), to: nil, from: nil]
        };
        let sent = sent.as_bool();
        if !sent || !ready {
            // Only an unusual start is logged; macOS then usually refuses with "bottom line input".
            nslog(&format!(
                "dictation: startDictation: sent={sent} inputReady={ready}"
            ));
        }
        let _ = tx.send(Attempt::Sent(sent));
    })
    .map_err(|e| format!("Dictation could not start: {e}"))?;
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(found) => Ok(found),
        Err(_) => {
            abandoned.store(true, std::sync::atomic::Ordering::SeqCst);
            Err("Dictation could not start: the app did not respond.".into())
        }
    }
}

/// True when the key window's first responder has an input context, i.e. an editable element holds focus and
/// Dictation can type inline into it (WKWebView returns nil otherwise).
#[cfg(target_os = "macos")]
fn focused_input_ready(ns_app: &objc2_app_kit::NSApplication) -> bool {
    use objc2::runtime::AnyObject;
    // SAFETY: plain AppKit getters on the main thread; every pointer is nil-checked before use.
    unsafe {
        let window: *mut AnyObject = objc2::msg_send![ns_app, keyWindow];
        if window.is_null() {
            return false;
        }
        let responder: *mut AnyObject = objc2::msg_send![&*window, firstResponder];
        if responder.is_null() {
            return false;
        }
        // `inputContext` is an NSView / NSTextInputClient method: the window itself (or another plain responder) can
        // be first responder, and an unrecognized selector would abort the app.
        let answers: objc2::runtime::Bool =
            objc2::msg_send![&*responder, respondsToSelector: objc2::sel!(inputContext)];
        if !answers.as_bool() {
            return false;
        }
        let context: *mut AnyObject = objc2::msg_send![&*responder, inputContext];
        !context.is_null()
    }
}

/// Writes one line to the unified log (the text is private there; it also goes to stderr when run from a terminal).
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
