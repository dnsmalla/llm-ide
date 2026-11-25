//! Host-run native confirmation dialogs and the small guards the new host commands share.
//!
//! - `bypass_confirm_signed(chatId, summary)`: the chat screen must get a host-signed token here before it turns on
//!   Bypass permissions mode (and fails closed without it). The dialog text is a FIXED
//!   template; the webview's `summary` is only quoted as a capped, single-line detail with
//!   control and bidi characters removed.
//! - `ask`: a modal rfd dialog whose DEFAULT button is Cancel. rfd's custom-button dialogs
//!   return the label of the pressed button; the first button is the default (Return key on
//!   macOS, first TaskDialog button on Windows), so Cancel is listed first and only an exact
//!   `Custom(accept_label)` counts as consent. Anything else (Cancel, Esc, close, an
//!   unexpected backend result) is a refusal: the check fails closed.
//! - `RateLimit`: a minimum gap between calls plus a per-minute cap, with an explicit clock
//!   so it can be tested.
//!
//! The webview cannot prove a user gesture to the host. These dialogs (and the rate limits)
//! are the mitigation: a script that was not driven by the user still needs a human click on
//! a native window the page cannot draw or dismiss.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::fs_ops::FsError;

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub(crate) fn herr(code: &'static str, message: impl Into<String>) -> FsError {
    FsError { code, message: message.into() }
}

/// "A native dialog of this kind is open". `acquire` hands out a guard that clears the flag when it is DROPPED, so an
/// early return, a panic or a cancelled future can never leave the flag stuck on (which would block the dialog until
/// the app restarts).
pub(crate) struct OpenFlag(std::sync::atomic::AtomicBool);

pub(crate) struct OpenGuard<'a>(&'a OpenFlag);

impl OpenFlag {
    pub(crate) const fn new() -> Self {
        Self(std::sync::atomic::AtomicBool::new(false))
    }

    /// `Some(guard)` when no dialog was open (and now one is); `None` when one already is.
    pub(crate) fn acquire(&self) -> Option<OpenGuard<'_>> {
        use std::sync::atomic::Ordering;
        (!self.0.swap(true, Ordering::SeqCst)).then_some(OpenGuard(self))
    }

    #[cfg(test)]
    pub(crate) fn is_open(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Drop for OpenGuard<'_> {
    fn drop(&mut self) {
        (self.0).0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Minimum `min_gap_ms` between accepted calls and at most `per_minute` in any 60 s window.
pub(crate) struct RateLimit {
    min_gap_ms: u64,
    per_minute: usize,
    hits: Mutex<VecDeque<u64>>,
}

impl RateLimit {
    pub(crate) const fn new(min_gap_ms: u64, per_minute: usize) -> Self {
        Self { min_gap_ms, per_minute, hits: Mutex::new(VecDeque::new()) }
    }

    /// True (and records the call) when a call at `now` is allowed.
    pub(crate) fn allow_at(&self, now: u64) -> bool {
        let mut h = self.hits.lock().unwrap_or_else(|p| p.into_inner());
        while h.front().is_some_and(|t| now.saturating_sub(*t) >= 60_000) {
            h.pop_front();
        }
        if h.back().is_some_and(|t| now.saturating_sub(*t) < self.min_gap_ms) || h.len() >= self.per_minute {
            return false;
        }
        h.push_back(now);
        true
    }

    pub(crate) fn allow(&self) -> bool {
        self.allow_at(now_ms())
    }
}

/// One native destructive dialog at a time plus a rate limit, for commands a page could call in a loop.
pub(crate) struct DialogGuard {
    limit: RateLimit,
    open: std::sync::atomic::AtomicBool,
}

impl DialogGuard {
    pub(crate) const fn new(min_gap_ms: u64, per_minute: usize) -> Self {
        Self { limit: RateLimit::new(min_gap_ms, per_minute), open: std::sync::atomic::AtomicBool::new(false) }
    }

    /// Runs `f` (which shows the dialog) unless another one is open (`busy`) or the page is asking too fast
    /// (`rate_limited`). The open flag is released on every path, a panic included.
    pub(crate) fn run<T>(&self, f: impl FnOnce() -> Result<T, FsError>) -> Result<T, FsError> {
        self.run_at(now_ms(), f)
    }

    pub(crate) fn run_at<T>(&self, now: u64, f: impl FnOnce() -> Result<T, FsError>) -> Result<T, FsError> {
        use std::sync::atomic::Ordering;
        if !self.limit.allow_at(now) {
            return Err(herr("rate_limited", "too many confirmation requests; wait a moment"));
        }
        if self.open.swap(true, Ordering::SeqCst) {
            return Err(herr("busy", "a confirmation is already open"));
        }
        struct Release<'a>(&'a std::sync::atomic::AtomicBool);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                self.0.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let _release = Release(&self.open);
        f()
    }
}

// Shared with the core crate (llmide_workspace_core::text); the rule is documented there.
pub(crate) use llmide_workspace_core::text::sanitize_line;

/// True only if the user pressed `accept` in a modal native dialog. Cancel is listed first
/// (the default button) and wins on any other outcome. Blocks: call from a blocking thread.
pub(crate) fn ask(title: &str, description: &str, accept: &str, warn: bool) -> bool {
    let result = rfd::MessageDialog::new()
        .set_level(if warn { rfd::MessageLevel::Warning } else { rfd::MessageLevel::Info })
        .set_title(title)
        .set_description(description)
        .set_buttons({
            let (first, second) = button_labels(accept);
            rfd::MessageButtons::OkCancelCustom(first, second)
        })
        .show();
    accepted(&result, accept)
}

/// The two button labels in dialog order: Cancel FIRST (the default / Return button), accept second.
pub(crate) fn button_labels(accept: &str) -> (String, String) {
    ("Cancel".to_string(), accept.to_string())
}

pub(crate) fn accepted(result: &rfd::MessageDialogResult, accept: &str) -> bool {
    matches!(result, rfd::MessageDialogResult::Custom(label) if label == accept)
}

// ---- bypass_confirm_signed ----------------------------------------------------------------

pub const SUMMARY_MAX_CHARS: usize = 120;
static BYPASS_LIMIT: RateLimit = RateLimit::new(1_000, 6);
static BYPASS_OPEN: OpenFlag = OpenFlag::new();

/// The dialog text for a summary. The template is fixed; only the quoted detail varies.
pub(crate) fn bypass_text(summary: &str) -> String {
    let detail = sanitize_line(summary, SUMMARY_MAX_CHARS);
    let base = "Bypass lets the assistant edit files and run commands without asking you first. \
                It applies to this chat for 30 minutes or until you turn Bypass off.";
    if detail.is_empty() {
        base.to_string()
    } else {
        format!("{base}\n\nChat: \u{201C}{detail}\u{201D}")
    }
}

async fn bypass_dialog(summary: Option<String>) -> Result<bool, FsError> {
    if !BYPASS_LIMIT.allow() {
        return Err(herr("rate_limited", "too many confirmation requests"));
    }
    let _open = BYPASS_OPEN.acquire().ok_or_else(|| herr("busy", "a confirmation is already open"))?;
    let text = bypass_text(summary.as_deref().unwrap_or(""));
    let out = tauri::async_runtime::spawn_blocking(move || ask("Turn on Bypass permissions?", &text, "Turn on Bypass", true)).await;
    out.map_err(|e| herr("io", format!("task failed: {e}")))
}

/// The signed variant, as a pure step after the dialog: validates the chat id and mints the chat-bound token.
/// `None` when the chat id cannot be bound (the host never signs for a malformed id).
pub(crate) fn mint_bypass_token(chat_id: &str) -> Result<String, FsError> {
    let purpose = crate::host_approval::bypass_purpose(chat_id).ok_or_else(|| herr("invalid", "not a valid chat id"))?;
    crate::host_approval::mint(&purpose).map_err(|e| herr("io", e))
}

/// The token step shared by the command and its tests: with `skip` (the host-owned pref) the dialog is never built;
/// otherwise `dialog` decides. The chat id is validated first either way, and the token is the same chat-bound,
/// 60 s, single-use v2 token.
pub(crate) async fn signed_for<F, Fut>(chat_id: &str, skip: bool, silent_limit: &RateLimit, dialog: F) -> Result<Option<String>, FsError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<bool, FsError>>,
{
    if crate::host_approval::bypass_purpose(chat_id).is_none() {
        return Err(herr("invalid", "not a valid chat id"));
    }
    if skip {
        if !silent_limit.allow() {
            return Err(herr("rate_limited", "too many Bypass approvals requested"));
        }
    } else if !dialog().await? {
        return Ok(None);
    }
    mint_bypass_token(chat_id).map(Some)
}

/// Same dialog for ONE chat; on accept returns a 60 s, single-use, host-signed token (format v2, purpose
/// `bypass:<chatId>`, see `host_approval`) for the core's `x-llmide-host-approval` header, else `None`. The core refuses
/// the token for any other chat, requires `x-llmide-client: desktop-ui` and the bus host proof alongside it. An
/// invalid chat id is refused BEFORE the dialog is shown. While the host-owned `bypassSkipConfirm` pref is on (only
/// `bypass_skip_confirm_set`, behind its own dialog, can turn it on) the token is signed without the dialog.
#[tauri::command]
pub async fn bypass_confirm_signed(chat_id: String, summary: Option<String>) -> Result<Option<String>, FsError> {
    signed_for(&chat_id, crate::prefs::bypass_skip_confirm(), &SILENT_MINT_LIMIT, || bypass_dialog(summary)).await
}

// ---- bypass_skip_confirm_set --------------------------------------------------------------

static SKIP_LIMIT: RateLimit = RateLimit::new(1_000, 6);
// C: minting with the pref on shows no dialog, so it gets its own cap.
static SILENT_MINT_LIMIT: RateLimit = RateLimit::new(0, 30);
/// A: declined "Stop asking" dialogs since launch; at the cap the host stops asking until the app restarts.
static SKIP_DECLINES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
pub(crate) const SKIP_MAX_DECLINES: u32 = 3;

/// Fixed text of the dialog that turns "Don't ask before Bypass" on. No webview-supplied text reaches it.
pub(crate) const BYPASS_SKIP_TEXT: &str = "Bypass will turn on without asking in every chat. Tools then run without asking, \
    including commands that change or delete files, until you turn it off in Settings > Security.";

/// Refuses once the user declined `SKIP_MAX_DECLINES` times since launch (a page cannot nag until someone gives in).
pub(crate) fn check_declines(declines: &std::sync::atomic::AtomicU32) -> Result<(), FsError> {
    if declines.load(std::sync::atomic::Ordering::SeqCst) >= SKIP_MAX_DECLINES {
        return Err(herr("declined_too_many", "Declined too many times; restart LLM-IDE to ask again."));
    }
    Ok(())
}

/// Writes the pref. Turning it ON asks first (`ask` is the host's native dialog) and writes nothing on a decline;
/// turning it OFF (or setting the value it already has) never asks. Returns the value now stored.
pub(crate) fn skip_confirm_apply(
    enabled: bool,
    current: bool,
    declines: &std::sync::atomic::AtomicU32,
    ask: impl FnOnce() -> bool,
    write: impl FnOnce(bool) -> Result<(), FsError>,
) -> Result<bool, FsError> {
    if enabled == current {
        return Ok(current);
    }
    if enabled {
        check_declines(declines)?;
        if !ask() {
            declines.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            return Ok(current);
        }
    }
    write(enabled)?;
    Ok(enabled)
}

/// Turns the host-owned `bypassSkipConfirm` pref on (after its own native, Cancel-first dialog) or off (no dialog).
/// Returns the value now stored. The generic `set_prefs` cannot write this key.
#[tauri::command]
pub async fn bypass_skip_confirm_set(enabled: bool) -> Result<bool, FsError> {
    let current = crate::prefs::bypass_skip_confirm();
    if enabled && !current {
        check_declines(&SKIP_DECLINES)?; // before any dialog is built
        if !SKIP_LIMIT.allow() {
            return Err(herr("rate_limited", "too many confirmation requests"));
        }
        let _open = BYPASS_OPEN.acquire().ok_or_else(|| herr("busy", "a confirmation is already open"))?;
        let ok = tauri::async_runtime::spawn_blocking(|| ask("Stop asking before Bypass?", BYPASS_SKIP_TEXT, "Stop asking", true))
            .await
            .map_err(|e| herr("io", format!("task failed: {e}")))?;
        return skip_confirm_apply(true, current, &SKIP_DECLINES, || ok, |v| crate::prefs::set_bypass_skip_confirm(v).map(|_| ()));
    }
    skip_confirm_apply(enabled, current, &SKIP_DECLINES, || false, |v| crate::prefs::set_bypass_skip_confirm(v).map(|_| ()))
}

// ---- trust_confirm ------------------------------------------------------------------------

pub const TRUST_PATH_MAX_CHARS: usize = 300;
static TRUST_LIMIT: RateLimit = RateLimit::new(1_000, 10);
static TRUST_OPEN: OpenFlag = OpenFlag::new();

/// A folder path the dialog may name: absolute (unix `/...`, Windows `C:\...` or `\\server\...`), no NUL.
pub(crate) fn valid_trust_path(path: &str) -> bool {
    let b = path.as_bytes();
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\0')
        && (path.starts_with('/') || path.starts_with("\\\\") || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')))
}

/// The dialog text. The template is FIXED; only the folder path is quoted (control and bidi characters
/// removed, capped). The page's own title and body text never reach the dialog.
pub(crate) fn trust_text(path: &str) -> String {
    let shown = sanitize_line(path, TRUST_PATH_MAX_CHARS);
    format!(
        "Trust this folder?\n\n\u{201C}{shown}\u{201D}\n\nChats in a trusted folder start the MCP servers its .mcp.json \
         defines, and those programs run on this computer with your permissions. Only trust a folder \
         whose contents you wrote or have reviewed."
    )
}

/// Native, modal confirmation for trusting a project folder. Default button: Cancel. The webview can
/// only say which path it is about to trust; it cannot change the text or press the button.
#[tauri::command]
pub async fn trust_confirm(path: String) -> Result<bool, FsError> {
    if !valid_trust_path(&path) {
        return Err(herr("invalid", "not an absolute folder path"));
    }
    // Only an existing folder can be trusted, and the dialog names the resolved path, not the webview's text.
    let folder = std::fs::canonicalize(&path).ok().filter(|p| p.is_dir()).ok_or_else(|| herr("invalid", "not an existing folder"))?;
    if !TRUST_LIMIT.allow() {
        return Err(herr("rate_limited", "too many confirmation requests"));
    }
    let _open = TRUST_OPEN.acquire().ok_or_else(|| herr("busy", "a confirmation is already open"))?;
    let text = trust_text(&crate::fsutil::plain_path(&folder).to_string_lossy());
    let out = tauri::async_runtime::spawn_blocking(move || ask("Trust this folder?", &text, "Trust folder", true)).await;
    out.map_err(|e| herr("io", format!("task failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_confirm_refuses_a_missing_folder_before_any_dialog() {
        let err = tauri::async_runtime::block_on(trust_confirm("/ Your Mac is infected".into())).unwrap_err();
        assert_eq!(err.code, "invalid");
    }

    #[test]
    fn the_open_flag_is_released_on_drop_even_after_a_panic_or_early_return() {
        let f = OpenFlag::new();
        {
            let _g = f.acquire().expect("first");
            assert!(f.is_open());
            assert!(f.acquire().is_none(), "second is refused while open");
        }
        assert!(!f.is_open(), "released on drop");
        let f = std::sync::Arc::new(OpenFlag::new());
        let f2 = f.clone();
        let r = std::thread::spawn(move || {
            let _g = f2.acquire().unwrap();
            panic!("boom");
        })
        .join();
        assert!(r.is_err());
        assert!(!f.is_open(), "released after a panic");
        assert!(f.acquire().is_some());
    }

    #[test]
    fn the_signed_bypass_token_is_chat_bound_and_refuses_a_bad_chat_id() {
        let t = mint_bypass_token("chat-9").unwrap();
        assert!(t.starts_with("v2."));
        let key = crate::host_approval::key().unwrap();
        let v = crate::host_approval::Verifier::default();
        let now = now_ms();
        assert!(!v.verify_at(key, &t, "bypass:chat-8", now), "another chat");
        assert!(v.verify_at(key, &t, "bypass:chat-9", now));
        for bad in ["", "a|b", "a b"] {
            assert_eq!(mint_bypass_token(bad).unwrap_err().code, "invalid");
        }
    }

    use std::sync::atomic::AtomicU32;

    #[test]
    fn the_silent_mint_is_rate_limited() {
        let limit = RateLimit::new(0, 2);
        for _ in 0..2 {
            assert!(tauri::async_runtime::block_on(signed_for("chat-4", true, &limit, || -> std::future::Ready<Result<bool, FsError>> { panic!("no dialog") })).unwrap().is_some());
        }
        let err = tauri::async_runtime::block_on(signed_for("chat-4", true, &limit, || -> std::future::Ready<Result<bool, FsError>> { panic!("no dialog") })).unwrap_err();
        assert_eq!(err.code, "rate_limited");
    }

    #[test]
    fn three_declines_stop_the_skip_dialog_until_restart() {
        let declines = AtomicU32::new(0);
        for _ in 0..SKIP_MAX_DECLINES {
            assert!(!skip_confirm_apply(true, false, &declines, || false, |_| panic!("no write")).unwrap());
        }
        let err = skip_confirm_apply(true, false, &declines, || panic!("must not ask again"), |_| panic!("no write")).unwrap_err();
        assert_eq!(err.code, "declined_too_many");
        assert_eq!(check_declines(&declines).unwrap_err().code, "declined_too_many");
        // turning off is still allowed
        assert!(!skip_confirm_apply(false, true, &declines, || panic!("off asks nothing"), |_| Ok(())).unwrap());
    }

    fn ready(v: bool) -> impl std::future::Future<Output = Result<bool, FsError>> {
        std::future::ready(Ok(v))
    }

    #[test]
    fn with_the_pref_on_the_token_is_signed_without_a_dialog_and_stays_chat_bound() {
        let t = tauri::async_runtime::block_on(signed_for("chat-4", true, &RateLimit::new(0, 30), || -> std::future::Ready<Result<bool, FsError>> { panic!("no dialog while the pref is on") }))
            .unwrap()
            .expect("a token");
        assert!(t.starts_with("v2."));
        let key = crate::host_approval::key().unwrap();
        let v = crate::host_approval::Verifier::default();
        let now = now_ms();
        assert!(!v.verify_at(key, &t, "bypass:chat-5", now), "another chat");
        assert!(v.verify_at(key, &t, "bypass:chat-4", now));
        assert!(!v.verify_at(key, &t, "bypass:chat-4", now), "single use");
        let bad = tauri::async_runtime::block_on(signed_for("a|b", true, &RateLimit::new(0, 30), || ready(true))).unwrap_err();
        assert_eq!(bad.code, "invalid", "a bad chat id is refused even with the pref on");
    }

    #[test]
    fn with_the_pref_off_the_dialog_decides() {
        assert!(tauri::async_runtime::block_on(signed_for("chat-4", false, &RateLimit::new(0, 30), || ready(false))).unwrap().is_none());
        assert!(tauri::async_runtime::block_on(signed_for("chat-4", false, &RateLimit::new(0, 30), || ready(true))).unwrap().is_some());
        let bad = tauri::async_runtime::block_on(signed_for("a b", false, &RateLimit::new(0, 30), || -> std::future::Ready<Result<bool, FsError>> { panic!("invalid id: no dialog") })).unwrap_err();
        assert_eq!(bad.code, "invalid");
    }

    #[test]
    fn the_skip_pref_is_written_true_only_after_the_dialog_is_accepted() {
        let wrote = std::cell::Cell::new(None);
        let write = |v: bool| { wrote.set(Some(v)); Ok(()) };
        assert!(!skip_confirm_apply(true, false, &AtomicU32::new(0), || false, write).unwrap(), "declined: stays off");
        assert_eq!(wrote.get(), None, "a decline writes nothing");
        assert!(skip_confirm_apply(true, false, &AtomicU32::new(0), || true, write).unwrap());
        assert_eq!(wrote.get(), Some(true));
    }

    #[test]
    fn turning_the_skip_pref_off_needs_no_dialog() {
        let wrote = std::cell::Cell::new(None);
        let write = |v: bool| { wrote.set(Some(v)); Ok(()) };
        assert!(!skip_confirm_apply(false, true, &AtomicU32::new(0), || panic!("off asks nothing"), write).unwrap());
        assert_eq!(wrote.get(), Some(false));
        assert!(skip_confirm_apply(true, true, &AtomicU32::new(0), || panic!("already on"), |_| panic!("no write")).unwrap());
    }

    #[test]
    fn a_failed_write_is_an_error_not_a_false_success() {
        let err = skip_confirm_apply(true, false, &AtomicU32::new(0), || true, |_| Err(herr("io", "disk"))).unwrap_err();
        assert_eq!(err.code, "io");
    }

    #[test]
    fn the_skip_dialog_text_names_the_risk_and_cancel_is_first() {
        assert!(BYPASS_SKIP_TEXT.starts_with("Bypass will turn on without asking in every chat."));
        assert!(BYPASS_SKIP_TEXT.contains("change or delete files"));
        assert!(BYPASS_SKIP_TEXT.ends_with("until you turn it off in Settings > Security."));
        assert_eq!(button_labels("Stop asking").0, "Cancel");
    }

    #[test]
    fn rate_limit_gap_and_window() {
        let r = RateLimit::new(100, 3);
        assert!(r.allow_at(1_000));
        assert!(!r.allow_at(1_050), "inside the minimum gap");
        assert!(r.allow_at(1_100));
        assert!(r.allow_at(1_300));
        assert!(!r.allow_at(1_500), "per-minute cap");
        assert!(r.allow_at(61_100), "old hits age out");
    }

    #[test]
    fn dialog_guard_allows_one_at_a_time_and_rate_limits() {
        let g = DialogGuard::new(100, 10);
        // nested call = a second dialog while the first is open
        let r: Result<u8, FsError> = g.run_at(1_000, || {
            let inner: Result<u8, FsError> = g.run_at(1_200, || Ok(2));
            assert_eq!(inner.unwrap_err().code, "busy");
            Ok(1)
        });
        assert_eq!(r.unwrap(), 1);
        // released afterwards (even after an error): next call past the gap works
        assert_eq!(g.run_at(1_300, || -> Result<u8, FsError> { Err(herr("x", "y")) }).unwrap_err().code, "x");
        assert_eq!(g.run_at(1_500, || Ok(3)).unwrap(), 3);
        // too fast, and the per-minute cap
        assert_eq!(g.run_at(1_501, || Ok(4)).unwrap_err().code, "rate_limited");
        assert_eq!(g.run_at(1_700, || Ok(5)).unwrap(), 5);
        let capped = DialogGuard::new(0, 2);
        assert!(capped.run_at(1_000, || Ok(1)).is_ok() && capped.run_at(1_001, || Ok(1)).is_ok());
        assert_eq!(capped.run_at(1_002, || Ok(1)).unwrap_err().code, "rate_limited", "per-minute cap");
        assert!(capped.run_at(62_000, || Ok(1)).is_ok(), "ages out");
    }

    #[test]
    fn sanitize_strips_control_bidi_and_collapses() {
        assert_eq!(sanitize_line("a\u{202E}b\n\n c\t\u{200B}d", 50), "ab c d");
        assert_eq!(sanitize_line("  \u{0007}hi  ", 50), "hi");
        assert_eq!(sanitize_line(&"x".repeat(500), SUMMARY_MAX_CHARS).chars().count(), SUMMARY_MAX_CHARS);
        assert_eq!(sanitize_line("", 5), "");
    }

    #[test]
    fn bypass_text_is_fixed_template_plus_quoted_detail() {
        let base = bypass_text("");
        assert!(base.starts_with("Bypass lets the assistant edit files and run commands without asking"));
        assert!(!base.contains("Chat:"));
        assert!(base.contains("30 minutes"));
        let t = bypass_text("fix\u{202E} the\nbuild");
        assert!(t.starts_with(&base));
        assert!(t.ends_with("Chat: \u{201C}fix the build\u{201D}"));
        assert!(!t.contains('\u{202E}'));
    }

    #[test]
    fn only_the_exact_accept_label_is_consent() {
        use rfd::MessageDialogResult as M;
        assert!(accepted(&M::Custom("Open".into()), "Open"));
        for no in [M::Custom("Cancel".into()), M::Cancel, M::Ok, M::Yes, M::No, M::Custom("open".into())] {
            assert!(!accepted(&no, "Open"), "{no:?}");
        }
    }

    #[test]
    fn trust_text_is_a_fixed_template_naming_the_sanitised_path() {
        let t = trust_text("/Users/me/proj\u{202E}evil\nline");
        assert!(t.starts_with("Trust this folder?"));
        assert!(t.contains("\u{201C}/Users/me/proj evil") || t.contains("\u{201C}/Users/me/projevil"), "{t}");
        assert!(!t.contains('\u{202E}') && !t.contains("proj\nevil"));
        assert!(t.contains(".mcp.json") && t.contains("run on this computer"));
        let long = trust_text(&format!("/{}", "a".repeat(2000)));
        assert!(long.chars().count() < 700);
    }

    #[test]
    fn only_absolute_paths_are_accepted_for_the_trust_dialog() {
        for ok in ["/Users/me/proj", "C:\\work\\p", "c:/work/p", "\\\\srv\\share\\p"] {
            assert!(valid_trust_path(ok), "{ok}");
        }
        for bad in ["", "relative/path", "~/proj", "proj", "/a\0b", "C:", "file:///etc"] {
            assert!(!valid_trust_path(bad), "{bad:?}");
        }
    }
}
