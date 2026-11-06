//! Native notifications: a fixed table of kinds, host-built generic text, and the rules that decide whether one is
//! shown (category switch, focus, de-duplication, coalescing) and where a click leads.
//!
//! Privacy: a notification never carries chat text, file paths, captions, tokens, project, account or device names.
//! The webview names a KIND plus an opaque de-dup key and a count; the host builds the words from this table. The
//! webview cannot raise `update_ready` or `core_down` (host-only facts).
//!
//! Clicks: tauri-plugin-notification 2.4 reports no click on desktop. The host keeps the last notification's route
//! for `ROUTE_TTL_MS` and hands it to the webview once, when the main window next gains focus (a click on the
//! notification activates the app) or when the tray opens the window.

use std::collections::{HashMap, VecDeque};

use crate::prefs::NotifyPrefs;

pub const TITLE: &str = "LLM-IDE";
/// At most one notification per kind in this window; later ones in a burst are dropped (the next carries the count).
pub const COALESCE_MS: u64 = 10_000;
/// How long a shown notification's route waits for the window to be focused.
pub const ROUTE_TTL_MS: u64 = 120_000;
pub const KEY_MAX: usize = 64;
pub const SEEN_MAX: usize = 256;

/// The section ids the webview may report (`SectionId` in ui/screens/shell/sections.ts; a TS test keeps them in step).
pub const SECTIONS: [&str; 15] = [
    "welcome", "chat", "explorer", "library", "live", "settings", "graph", "issues", "gantt", "loop", "docgen", "visual",
    "autotasks", "conflicts", "spike",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    ApprovalChat,
    ApprovalJob,
    LoopDone,
    LoopFailed,
    AutoTaskDone,
    AutoTaskFailed,
    GraphDone,
    GraphFailed,
    DocGenDone,
    DocGenFailed,
    SyncAttention,
    UpdateReady,
    CoreDown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Approvals,
    Tasks,
    Sync,
    Updates,
    Core,
}

impl Kind {
    pub const ALL: [Kind; 13] = [
        Kind::ApprovalChat, Kind::ApprovalJob, Kind::LoopDone, Kind::LoopFailed, Kind::AutoTaskDone, Kind::AutoTaskFailed,
        Kind::GraphDone, Kind::GraphFailed, Kind::DocGenDone, Kind::DocGenFailed, Kind::SyncAttention, Kind::UpdateReady,
        Kind::CoreDown,
    ];

    pub fn wire(self) -> &'static str {
        match self {
            Kind::ApprovalChat => "approval_chat",
            Kind::ApprovalJob => "approval_job",
            Kind::LoopDone => "loop_done",
            Kind::LoopFailed => "loop_failed",
            Kind::AutoTaskDone => "autotask_done",
            Kind::AutoTaskFailed => "autotask_failed",
            Kind::GraphDone => "graph_done",
            Kind::GraphFailed => "graph_failed",
            Kind::DocGenDone => "docgen_done",
            Kind::DocGenFailed => "docgen_failed",
            Kind::SyncAttention => "sync_attention",
            Kind::UpdateReady => "update_ready",
            Kind::CoreDown => "core_down",
        }
    }

    /// A kind the webview may raise; `update_ready` and `core_down` come from the host only.
    pub fn from_webview(s: &str) -> Option<Kind> {
        Self::ALL.into_iter().find(|k| k.wire() == s && !matches!(k, Kind::UpdateReady | Kind::CoreDown))
    }

    pub fn group(self) -> Group {
        match self {
            Kind::ApprovalChat | Kind::ApprovalJob => Group::Approvals,
            Kind::SyncAttention => Group::Sync,
            Kind::UpdateReady => Group::Updates,
            Kind::CoreDown => Group::Core,
            _ => Group::Tasks,
        }
    }

    /// Where a click leads: a section id, `section:anchor` (a Settings group), or `inbox` (the status-bar inbox).
    pub fn route(self) -> &'static str {
        match self {
            Kind::ApprovalChat => "chat",
            Kind::ApprovalJob => "inbox",
            Kind::LoopDone | Kind::LoopFailed => "loop",
            Kind::AutoTaskDone | Kind::AutoTaskFailed => "autotasks",
            Kind::GraphDone | Kind::GraphFailed => "graph",
            Kind::DocGenDone | Kind::DocGenFailed => "docgen",
            Kind::SyncAttention => "settings:mobile",
            Kind::UpdateReady => "settings:updates",
            Kind::CoreDown => "settings:server",
        }
    }

    /// The body: fixed words from this table. `count` is how many are waiting (approvals only).
    pub fn body(self, count: u32) -> String {
        let n = if count > 99 { "99+".to_string() } else { count.to_string() };
        let many = count > 1;
        match self {
            Kind::ApprovalChat if many => format!("{n} tools are waiting for your approval in Chat."),
            Kind::ApprovalChat => "A tool is waiting for your approval in Chat.".into(),
            Kind::ApprovalJob if many => format!("{n} jobs are waiting for your approval."),
            Kind::ApprovalJob => "A job is waiting for your approval.".into(),
            Kind::LoopDone => "A Loop run passed.".into(),
            Kind::LoopFailed => "A Loop run did not pass.".into(),
            Kind::AutoTaskDone => "An Auto Task finished.".into(),
            Kind::AutoTaskFailed => "An Auto Task did not complete.".into(),
            Kind::GraphDone => "The code graph is ready.".into(),
            Kind::GraphFailed => "Code graph generation failed.".into(),
            Kind::DocGenDone => "A generated document is ready.".into(),
            Kind::DocGenFailed => "Document generation failed.".into(),
            Kind::SyncAttention => "Sync needs your attention in Settings.".into(),
            Kind::UpdateReady => "An LLM-IDE update is available.".into(),
            Kind::CoreDown => "The LLM-IDE backend stopped. Open the app to restart it.".into(),
        }
    }
}

/// The category switch for `kind`.
pub fn enabled(kind: Kind, p: &NotifyPrefs) -> bool {
    match kind.group() {
        Group::Approvals => p.approvals,
        Group::Tasks => p.tasks,
        Group::Sync => p.sync,
        Group::Updates => p.updates,
        Group::Core => p.core,
    }
}

/// True when the user is already looking: the main window is focused and shows the kind's place. The approvals
/// inbox and the backend-down panel are visible from every section.
pub fn suppressed(kind: Kind, focused: bool, active: &str) -> bool {
    focused
        && match kind.route() {
            "inbox" | "settings:server" => true,
            r => r.split(':').next() == Some(active),
        }
}

/// De-duplication (each key once) and per-kind coalescing.
#[derive(Default)]
pub struct Gate {
    seen: VecDeque<(Kind, String)>,
    last: HashMap<Kind, u64>,
}

impl Gate {
    /// True when this notification may be shown now. A key is remembered even when the burst rule drops it.
    pub fn admit(&mut self, kind: Kind, key: Option<&str>, now: u64) -> bool {
        if let Some(k) = key {
            if self.seen.iter().any(|(sk, sv)| *sk == kind && sv == k) {
                return false;
            }
            self.seen.push_back((kind, k.to_string()));
            if self.seen.len() > SEEN_MAX {
                self.seen.pop_front();
            }
        }
        if self.last.get(&kind).is_some_and(|t| now.saturating_sub(*t) < COALESCE_MS) {
            return false;
        }
        self.last.insert(kind, now);
        true
    }
}

/// The pending route, once, while it is fresh; a stale one is dropped.
pub fn take_route(pending: &mut Option<(&'static str, u64)>, now: u64) -> Option<&'static str> {
    pending.take().filter(|(_, at)| now.saturating_sub(*at) <= ROUTE_TTL_MS).map(|(r, _)| r)
}

/// An opaque de-dup key: short, plain ASCII, never shown.
pub fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= KEY_MAX && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

/// The fixed section id equal to `s`, or None.
pub fn section_id(s: &str) -> Option<&'static str> {
    SECTIONS.iter().copied().find(|x| *x == s)
}

// ---- process state and commands --------------------------------------------------------------------------------

use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};

static GATE: Mutex<Option<Gate>> = Mutex::new(None);
static ACTIVE_SECTION: Mutex<&'static str> = Mutex::new("welcome");
static PENDING_ROUTE: Mutex<Option<(&'static str, u64)>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn main_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

/// Shows `kind` unless its switch is off, the user is already looking, or the gate drops it. Ok(true) = shown.
/// No lock is held across a window or notification call.
fn fire(app: &AppHandle, kind: Kind, key: Option<&str>, count: u32) -> Result<bool, String> {
    if !enabled(kind, &crate::prefs::stored().notifications) {
        return Ok(false);
    }
    let focused = main_focused(app);
    let active = *lock(&ACTIVE_SECTION);
    if suppressed(kind, focused, active) {
        return Ok(false);
    }
    let now = crate::confirm::now_ms();
    if !lock(&GATE).get_or_insert_with(Gate::default).admit(kind, key, now) {
        return Ok(false);
    }
    let n = app.notification();
    let mut state = n.permission_state().map_err(|e| e.to_string())?;
    if state == PermissionState::Prompt || state == PermissionState::PromptWithRationale {
        state = n.request_permission().map_err(|e| e.to_string())?;
    }
    if state != PermissionState::Granted {
        return Err("notification permission not granted".into());
    }
    n.builder().title(TITLE).body(kind.body(count)).show().map_err(|e| e.to_string())?;
    if !focused {
        *lock(&PENDING_ROUTE) = Some((kind.route(), now));
    }
    Ok(true)
}

/// A host-side fact (update found, backend down). Failures are logged, never raised.
pub fn fire_host(app: &AppHandle, kind: Kind, key: Option<&str>) {
    if let Err(e) = fire(app, kind, key, 1) {
        eprintln!("notify: {}: {e}", kind.wire());
    }
}

/// The webview names a kind (never text), an optional opaque de-dup key and a count.
#[tauri::command]
pub fn notify_user(app: AppHandle, kind: String, key: Option<String>, count: Option<u32>) -> Result<bool, String> {
    let k = Kind::from_webview(&kind).ok_or("unknown notification kind")?;
    if key.as_deref().is_some_and(|x| !valid_key(x)) {
        return Err("invalid notification key".into());
    }
    fire(&app, k, key.as_deref(), count.unwrap_or(1).min(999))
}

/// The section the main window shows (for "already looking" suppression).
#[tauri::command]
pub fn notify_focus(section: String) -> Result<(), String> {
    *lock(&ACTIVE_SECTION) = section_id(&section).ok_or("unknown section")?;
    Ok(())
}

/// The main window gained focus or the tray opened it: hand a fresh notification's route to the webview once.
pub fn on_main_focused(app: &AppHandle) {
    let route = take_route(&mut lock(&PENDING_ROUTE), crate::confirm::now_ms());
    if let Some(r) = route {
        let _ = app.emit("tray-action", format!("route:{r}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prefs::NotifyPrefs;

    #[test]
    fn every_kind_has_a_unique_wire_name() {
        let wires: std::collections::HashSet<_> = Kind::ALL.iter().map(|k| k.wire()).collect();
        assert_eq!(wires.len(), Kind::ALL.len());
    }

    #[test]
    fn the_webview_cannot_raise_host_only_kinds() {
        assert_eq!(Kind::from_webview("approval_chat"), Some(Kind::ApprovalChat));
        assert_eq!(Kind::from_webview("docgen_failed"), Some(Kind::DocGenFailed));
        assert_eq!(Kind::from_webview("update_ready"), None);
        assert_eq!(Kind::from_webview("core_down"), None);
        assert_eq!(Kind::from_webview("approval_old"), None, "the old template names are gone");
        assert_eq!(Kind::from_webview(""), None);
    }

    #[test]
    fn bodies_are_short_generic_and_counted() {
        assert_eq!(Kind::ApprovalChat.body(1), "A tool is waiting for your approval in Chat.");
        assert_eq!(Kind::ApprovalChat.body(0), "A tool is waiting for your approval in Chat.");
        assert_eq!(Kind::ApprovalJob.body(3), "3 jobs are waiting for your approval.");
        assert_eq!(Kind::ApprovalJob.body(500), "99+ jobs are waiting for your approval.");
        assert_eq!(Kind::LoopFailed.body(1), "A Loop run did not pass.");
        for k in Kind::ALL {
            let b = k.body(2);
            assert!(!b.is_empty() && b.chars().count() <= 80, "{b}");
            assert!(!b.contains('/') && !b.contains('\\') && !b.contains('@') && !b.contains("://"), "{b}");
        }
    }

    #[test]
    fn routes_point_at_known_sections_or_the_inbox() {
        for k in Kind::ALL {
            let r = k.route();
            assert!(r == "inbox" || SECTIONS.contains(&r.split(':').next().unwrap()), "{r}");
        }
        assert_eq!(Kind::SyncAttention.route(), "settings:mobile");
        assert_eq!(Kind::CoreDown.route(), "settings:server");
    }

    #[test]
    fn each_switch_silences_its_own_kinds_only() {
        let on = NotifyPrefs::default();
        for k in Kind::ALL {
            assert!(enabled(k, &on), "{k:?}");
        }
        let no_tasks = NotifyPrefs { tasks: false, ..on };
        assert!(!enabled(Kind::LoopFailed, &no_tasks) && !enabled(Kind::GraphDone, &no_tasks) && !enabled(Kind::AutoTaskDone, &no_tasks));
        assert!(enabled(Kind::ApprovalChat, &no_tasks) && enabled(Kind::CoreDown, &no_tasks));
        assert!(!enabled(Kind::ApprovalJob, &NotifyPrefs { approvals: false, ..on }));
        assert!(!enabled(Kind::SyncAttention, &NotifyPrefs { sync: false, ..on }));
        assert!(!enabled(Kind::UpdateReady, &NotifyPrefs { updates: false, ..on }));
        assert!(!enabled(Kind::CoreDown, &NotifyPrefs { core: false, ..on }));
    }

    #[test]
    fn a_focused_window_on_the_place_is_silent() {
        assert!(suppressed(Kind::ApprovalChat, true, "chat"));
        assert!(!suppressed(Kind::ApprovalChat, true, "explorer"));
        assert!(!suppressed(Kind::ApprovalChat, false, "chat"), "a hidden or unfocused window always notifies");
        assert!(suppressed(Kind::ApprovalJob, true, "graph"), "the inbox is on every section");
        assert!(suppressed(Kind::CoreDown, true, "loop"), "the core-down panel covers every section");
        assert!(suppressed(Kind::UpdateReady, true, "settings"));
        assert!(!suppressed(Kind::UpdateReady, true, "chat"));
        assert!(suppressed(Kind::DocGenDone, true, "docgen"));
    }

    #[test]
    fn the_gate_shows_each_key_once_and_coalesces_bursts_per_kind() {
        let mut g = Gate::default();
        let t = 1_000_000;
        assert!(g.admit(Kind::ApprovalJob, Some("a"), t));
        assert!(!g.admit(Kind::ApprovalJob, Some("a"), t + 60_000), "same approval: never twice");
        assert!(!g.admit(Kind::ApprovalJob, Some("b"), t + 1_000), "a burst is coalesced");
        assert!(!g.admit(Kind::ApprovalJob, Some("b"), t + 20_000), "b was seen in the burst; the next new one carries the count");
        assert!(g.admit(Kind::ApprovalJob, Some("c"), t + 20_000));
        assert!(g.admit(Kind::LoopDone, None, t + 20_001), "kinds coalesce separately");
        assert!(!g.admit(Kind::LoopDone, None, t + 25_000));
        assert!(g.admit(Kind::LoopDone, None, t + 31_000));
    }

    #[test]
    fn the_seen_list_is_bounded() {
        let mut g = Gate::default();
        for i in 0..(SEEN_MAX as u64 + 10) {
            g.admit(Kind::ApprovalJob, Some(&format!("k{i}")), 1_000_000 + i * COALESCE_MS * 2);
        }
        assert_eq!(g.seen.len(), SEEN_MAX);
    }

    #[test]
    fn a_route_is_taken_once_and_only_while_fresh() {
        let mut p = Some(("chat", 1_000));
        assert_eq!(take_route(&mut p, 1_000 + ROUTE_TTL_MS), Some("chat"));
        assert_eq!(take_route(&mut p, 2_000), None, "taken once");
        let mut old = Some(("loop", 1_000));
        assert_eq!(take_route(&mut old, 1_001 + ROUTE_TTL_MS), None);
        assert!(old.is_none(), "a stale route is dropped");
    }

    #[test]
    fn keys_and_sections_are_validated() {
        assert!(valid_key("7c1d2e3f-0000-4000-8000-0000000000a2"));
        assert!(valid_key("activity:12"));
        assert!(!valid_key(""));
        assert!(!valid_key(&"a".repeat(KEY_MAX + 1)));
        assert!(!valid_key("a b"));
        assert!(!valid_key("../x/y"));
        assert_eq!(section_id("loop"), Some("loop"));
        assert_eq!(section_id("Loop"), None);
        assert_eq!(section_id("inbox"), None, "the inbox is a route, not a section");
    }
}
