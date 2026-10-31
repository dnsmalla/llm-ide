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
static BYPASS_OPEN: Mutex<bool> = Mutex::new(false);

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

/// Native, modal confirmation for turning on Bypass permissions. Default button: Cancel.
#[tauri::command]
pub async fn bypass_confirm(summary: Option<String>) -> Result<bool, FsError> {
    if !BYPASS_LIMIT.allow() {
        return Err(herr("rate_limited", "too many confirmation requests"));
    }
    {
        let mut open = BYPASS_OPEN.lock().unwrap_or_else(|p| p.into_inner());
        if *open {
            return Err(herr("busy", "a confirmation is already open"));
        }
        *open = true;
    }
    let text = bypass_text(summary.as_deref().unwrap_or(""));
    let out = tauri::async_runtime::spawn_blocking(move || ask("Turn on Bypass permissions?", &text, "Turn on Bypass", true)).await;
    *BYPASS_OPEN.lock().unwrap_or_else(|p| p.into_inner()) = false;
    out.map_err(|e| herr("io", format!("task failed: {e}")))
}

// ---- trust_confirm ------------------------------------------------------------------------

pub const TRUST_PATH_MAX_CHARS: usize = 300;
static TRUST_LIMIT: RateLimit = RateLimit::new(1_000, 10);
static TRUST_OPEN: Mutex<bool> = Mutex::new(false);

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
    {
        let mut open = TRUST_OPEN.lock().unwrap_or_else(|p| p.into_inner());
        if *open {
            return Err(herr("busy", "a confirmation is already open"));
        }
        *open = true;
    }
    let text = trust_text(&path);
    let out = tauri::async_runtime::spawn_blocking(move || ask("Trust this folder?", &text, "Trust folder", true)).await;
    *TRUST_OPEN.lock().unwrap_or_else(|p| p.into_inner()) = false;
    out.map_err(|e| herr("io", format!("task failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

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
