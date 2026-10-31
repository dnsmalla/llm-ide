//! Host-run native confirmation dialogs and the small guards the new host commands share.
//!
//! - `bypass_confirm(summary)`: the chat screen must get `true` here before it turns on
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

/// Single line of plain text: control and invisible format characters (bidi overrides,
/// zero-width joiners, BOM, tag characters) are dropped, whitespace runs collapse to one
/// space, capped at `max` characters.
pub(crate) fn sanitize_line(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in s.chars() {
        if c.is_whitespace() || c.is_control() {
            gap = !out.is_empty();
            continue;
        }
        if crate::tray::is_invisible_format(c) {
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(c);
        if out.chars().count() >= max {
            break;
        }
    }
    out.chars().take(max).collect()
}

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

// ---- bypass_confirm -----------------------------------------------------------------------

pub const SUMMARY_MAX_CHARS: usize = 120;
static BYPASS_LIMIT: RateLimit = RateLimit::new(1_000, 6);
static BYPASS_OPEN: OpenFlag = OpenFlag::new();

/// The dialog text for a summary. The template is fixed; only the quoted detail varies.
pub(crate) fn bypass_text(summary: &str) -> String {
    let detail = sanitize_line(summary, SUMMARY_MAX_CHARS);
    let base = "Bypass permissions lets the assistant edit files and run commands in your \
                project without asking you first. Only continue if you trust this project \
                and what you are asking it to do.";
    if detail.is_empty() {
        base.to_string()
    } else {
        format!("{base}\n\nRequested for: \u{201C}{detail}\u{201D}")
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

/// Native, modal confirmation for turning on Bypass permissions. Default button: Cancel.
/// Advisory (UX): see `bypass_confirm_signed` for the host-signed variant.
#[tauri::command]
pub async fn bypass_confirm(summary: Option<String>) -> Result<bool, FsError> {
    bypass_dialog(summary).await
}

/// The signed variant, as a pure step after the dialog: validates the chat id and mints the chat-bound token.
/// `None` when the chat id cannot be bound (the host never signs for a malformed id).
pub(crate) fn mint_bypass_token(chat_id: &str) -> Result<String, FsError> {
    let purpose = crate::host_approval::bypass_purpose(chat_id).ok_or_else(|| herr("invalid", "not a valid chat id"))?;
    crate::host_approval::mint(&purpose).map_err(|e| herr("io", e))
}

/// Same dialog for ONE chat; on accept returns a 60 s, single-use, host-signed token (format v2, purpose
/// `bypass:<chatId>`, see `host_approval`) for the core's `x-llmide-host-approval` header, else `None`. The core refuses
/// the token for any other chat, requires `x-llmide-client: desktop-ui` and the bus host proof alongside it. An
/// invalid chat id is refused BEFORE the dialog is shown.
#[tauri::command]
pub async fn bypass_confirm_signed(chat_id: String, summary: Option<String>) -> Result<Option<String>, FsError> {
    if crate::host_approval::bypass_purpose(&chat_id).is_none() {
        return Err(herr("invalid", "not a valid chat id"));
    }
    if !bypass_dialog(summary).await? {
        return Ok(None);
    }
    mint_bypass_token(&chat_id).map(Some)
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
    if !TRUST_LIMIT.allow() {
        return Err(herr("rate_limited", "too many confirmation requests"));
    }
    let _open = TRUST_OPEN.acquire().ok_or_else(|| herr("busy", "a confirmation is already open"))?;
    let text = trust_text(&path);
    let out = tauri::async_runtime::spawn_blocking(move || ask("Trust this folder?", &text, "Trust folder", true)).await;
    out.map_err(|e| herr("io", format!("task failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(base.starts_with("Bypass permissions lets the assistant"));
        assert!(!base.contains("Requested for"));
        let t = bypass_text("fix\u{202E} the\nbuild");
        assert!(t.starts_with(&base));
        assert!(t.ends_with("Requested for: \u{201C}fix the build\u{201D}"));
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
