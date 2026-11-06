//! Host-persisted preferences (`prefs.json` in the app data dir).
//!
//! What lives here is what the HOST must decide before (or without) a webview: the switches the
//! spawned core reads from its environment at start, the live-then-archive mode, and the Terminal
//! feature toggle. The webview reads and writes them through `get_prefs` / `set_prefs` with a strict
//! typed schema (unknown keys and bad values are refused, nothing is stored as free text).
//!
//! Rules:
//! - `prefs.json` is bounded (16 KB), written atomically with 0600 in the private data dir, and an
//!   unreadable, oversized or hand-edited file falls back to the defaults (never a crash, never a
//!   partially trusted value).
//! - A change applies at the NEXT app start. `launch()` is the snapshot taken once at startup and is
//!   what the core environment, the archive policy and the Terminal gate use; `stored()` is what the
//!   file says now. `restartNeeded` is their difference, so Settings can say "applies at next start".
//! - Token-affecting switches (router, cap, compress, learn) default OFF and reach the core only as the
//!   exact value `on` (see `extension/core/router-flags.mjs`); the core's environment is otherwise
//!   scrubbed, so nothing in the host's own environment can turn them on.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::confirm::{herr, RateLimit};
use crate::fs_ops::FsError;

pub const FILE_NAME: &str = "prefs.json";
pub const MAX_BYTES: usize = 16 * 1024;

/// The feature keys the server knows (`FEATURE_KEYS` in `extension/core/config.mjs`). Used only to turn
/// "everything except terminal" into an explicit list; a test pins the order and content.
pub(crate) const FEATURE_KEYS: [&str; 8] = [
    "agent_chat", "file_explorer", "code_graph_3d", "gantt_issues", "terminal", "doc_gen", "mobile_sync", "auto_tasks",
];

/// True for a key the server knows (`FEATURE_KEYS`).

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum LtaMode {
    #[default]
    Off,
    Shadow,
    On,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
    Midnight,
}

/// App-wide Loop defaults for loops added to a project the first time. Stored with the other host prefs; read by
/// the Loop screen when it re-adds a missing default loop.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct LoopDefaults {
    pub max_iterations: u32,
    pub consecutive_failure_stop: u32,
    /// 0 = no wall-clock limit.
    pub wall_clock_minutes: u32,
    pub max_repairs_per_stage: u32,
    /// 0 = no pause timeout.
    pub pause_timeout_minutes: u32,
    /// revert | stop | warn | off
    pub protected_path_policy: String,
    pub write_summary_note: bool,
}

impl LoopDefaults {
    /// The same bounds the Settings card and the TypeScript decoder enforce. A hand-edited or hostile
    /// prefs.json cannot hand the Loop engine a zero/absurd budget.
    fn clamped(mut self) -> Self {
        self.max_iterations = self.max_iterations.clamp(1, 100);
        self.consecutive_failure_stop = self.consecutive_failure_stop.clamp(1, 20);
        self.wall_clock_minutes = self.wall_clock_minutes.min(1440);
        self.max_repairs_per_stage = self.max_repairs_per_stage.min(20);
        self.pause_timeout_minutes = self.pause_timeout_minutes.min(240);
        self.protected_path_policy = match self.protected_path_policy.as_str() {
            "stop" => "stop", "warn" => "warn", "off" => "off", _ => "revert",
        }.to_string();
        self
    }
}

impl Default for LoopDefaults {
    fn default() -> Self {
        Self {
            max_iterations: 10,
            consecutive_failure_stop: 2,
            wall_clock_minutes: 0,
            max_repairs_per_stage: 3,
            pause_timeout_minutes: 30,
            protected_path_policy: "revert".to_string(),
            write_summary_note: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Prefs {
    pub lta_mode: LtaMode,
    pub router: bool,
    pub cap: bool,
    pub compress: bool,
    pub learn: bool,
    pub terminal: bool,
    pub theme: Theme,
    /// The feature profile (an explicit subset of `FEATURE_KEYS`; empty = every feature, the historical behaviour).
    pub features: Vec<String>,
    // ---- backend (Server & Backend) ----
    // The three paths below are written only by the native pickers (backend_pick.rs), never by set_prefs.
    /// False = the app's bundled core (the default); true = run the core from a source checkout.
    pub backend_source: bool,
    /// Source-checkout mode only: node binary (empty = auto-detect).
    pub backend_node: String,
    /// Source-checkout mode only: the checkout's `extension` folder (empty = auto-detect).
    pub backend_dir: String,
    /// Source-checkout mode only: loopback port (0 = the app's 3456-3459 range).
    pub backend_port: u16,
    /// Start the core when the app starts (false leaves it stopped until Start).
    pub backend_auto_start: bool,
    /// App-wide defaults for loops added to a newly detected project.
    pub loop_defaults: LoopDefaults,
    /// Minutes between automatic Code Graph refreshes; 0 = off. Values 1-4 are raised to 5.
    pub graph_auto_update_minutes: u32,
    /// Look for a signed update once a day (check only; installing always asks). Applies at once.
    pub update_checks: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            lta_mode: LtaMode::Off, router: false, cap: false, compress: false, learn: false, terminal: true, theme: Theme::Dark,
            features: Vec::new(), backend_source: false, backend_node: String::new(), backend_dir: String::new(), backend_port: 0, backend_auto_start: true,
            loop_defaults: LoopDefaults::default(), graph_auto_update_minutes: 0, update_checks: true,
        }
    }
}

/// A partial update: absent fields stay as they are.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrefsPatch {
    pub lta_mode: Option<LtaMode>,
    pub router: Option<bool>,
    pub cap: Option<bool>,
    pub compress: Option<bool>,
    pub learn: Option<bool>,
    pub terminal: Option<bool>,
    pub theme: Option<Theme>,
    pub features: Option<Vec<String>>,
    /// The toggle only: the node binary and checkout folder are host-picked (`set_backend_paths`), never patched.
    pub backend_source: Option<bool>,
    pub backend_port: Option<u16>,
    pub backend_auto_start: Option<bool>,
    pub loop_defaults: Option<LoopDefaults>,
    pub graph_auto_update_minutes: Option<u32>,
    pub update_checks: Option<bool>,
}

/// An explicit feature list: only keys the server knows, in the canonical order, with `agent_chat` always on.
fn normalize_features(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = FEATURE_KEYS
        .iter()
        .filter(|k| list.iter().any(|x| x == *k))
        .map(|k| (*k).to_string())
        .collect();
    if !out.iter().any(|k| k == "agent_chat") {
        out.insert(0, "agent_chat".to_string());
    }
    out
}

impl Prefs {
    pub fn patched(&self, p: &PrefsPatch) -> Prefs {
        let mut n = self.clone();
        if let Some(v) = p.lta_mode { n.lta_mode = v; }
        if let Some(v) = p.router { n.router = v; }
        if let Some(v) = p.cap { n.cap = v; }
        if let Some(v) = p.compress { n.compress = v; }
        if let Some(v) = p.learn { n.learn = v; }
        if let Some(v) = p.terminal { n.terminal = v; }
        if let Some(v) = p.theme { n.theme = v; }
        if let Some(v) = p.backend_source { n.backend_source = v; }
        if let Some(v) = p.backend_port { n.backend_port = v; }
        if let Some(v) = p.backend_auto_start { n.backend_auto_start = v; }
        if let Some(v) = &p.loop_defaults {
            n.loop_defaults = v.clone().clamped();
        }
        if let Some(v) = p.graph_auto_update_minutes {
            n.graph_auto_update_minutes = if v == 0 { 0 } else { v.clamp(5, 1440) };
        }
        if let Some(v) = p.update_checks {
            n.update_checks = v;
        }
        if let Some(v) = &p.features {
            if v.is_empty() {
                // Empty stays "inherit every feature"; the Terminal flag is left as it was.
                n.features = Vec::new();
            } else {
                n.features = normalize_features(v);
                // An explicit profile owns the Terminal feature; keep the legacy flag in step so both views agree.
                n.terminal = n.features.iter().any(|k| k == "terminal");
            }
        } else if p.terminal.is_some() && !n.features.is_empty() {
            // The legacy Terminal switch (Settings > Workspace > Features) edits the same profile.
            n.features.retain(|k| k != "terminal");
            if n.terminal {
                n.features = normalize_features(&[n.features.clone(), vec!["terminal".to_string()]].concat());
            }
        }
        // Cap and compress only act while the router is on; never store a state that cannot mean what it says.
        if !n.router {
            n.cap = false;
            n.compress = false;
        }
        n
    }
}

/// Parses file text; any problem (too big, not JSON, unknown key, wrong type) yields the defaults.
pub fn parse(text: &str) -> Prefs {
    if text.len() > MAX_BYTES {
        return Prefs::default();
    }
    serde_json::from_str::<Prefs>(text).map(|p| {
        let mut out = Prefs::default().patched(&PrefsPatch {
            lta_mode: Some(p.lta_mode), router: Some(p.router), cap: Some(p.cap), compress: Some(p.compress),
            learn: Some(p.learn), terminal: Some(p.terminal), theme: Some(p.theme),
            // Empty stays "inherit every feature"; a non-empty list is the explicit profile.
            features: if p.features.is_empty() { None } else { Some(p.features.clone()) },
            backend_source: Some(p.backend_source), backend_port: Some(p.backend_port), backend_auto_start: Some(p.backend_auto_start),
            loop_defaults: Some(p.loop_defaults.clone()), graph_auto_update_minutes: Some(p.graph_auto_update_minutes),
            update_checks: Some(p.update_checks),
        });
        out.backend_node = p.backend_node.trim().to_string();
        out.backend_dir = p.backend_dir.trim().to_string();
        out
    }).unwrap_or_default()
}

pub fn load_from(dir: &Path) -> Prefs {
    let path = dir.join(FILE_NAME);
    match std::fs::metadata(&path) {
        Ok(m) if m.is_file() && m.len() <= MAX_BYTES as u64 => std::fs::read_to_string(&path).map(|t| parse(&t)).unwrap_or_default(),
        _ => Prefs::default(),
    }
}

pub fn save_to(dir: &Path, prefs: &Prefs) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?;
    crate::fsutil::write_private_atomic(&dir.join(FILE_NAME), &body, MAX_BYTES)
}

// ---- what the core and the Terminal gate get --------------------------------------------------

/// `LLMIDE_FEATURES` for the core and the Terminal gate: the host's own value, minus `terminal` when
/// the pref turns it off. `None` = leave it unset (every feature on). Unset or empty means all.
#[cfg(test)]
pub fn effective_features(host_env: Option<&str>, terminal: bool) -> Option<String> {
    effective_features_with(host_env, terminal, &[])
}

/// `LLMIDE_FEATURES` for the core: an explicit profile wins over the host's own value. Dependencies are enforced
/// in the UI (the same rule as the Mac's `AppFeature.validated`); here the list is filtered to known keys, chat is
/// kept, and `terminal` follows the Terminal switch. Never an empty value (that would read as "all").
pub fn effective_features_with(host_env: Option<&str>, terminal: bool, features: &[String]) -> Option<String> {
    if !features.is_empty() {
        let mut list: Vec<&str> = FEATURE_KEYS
            .iter()
            .copied()
            .filter(|k| features.iter().any(|x| x == k) && (terminal || *k != "terminal"))
            .collect();
        if !list.contains(&"agent_chat") {
            list.insert(0, "agent_chat");
        }
        return Some(list.join(","));
    }
    let base: Option<Vec<&str>> = host_env.map(str::trim).filter(|v| !v.is_empty()).map(|v| v.split(',').map(str::trim).filter(|k| !k.is_empty()).collect());
    if terminal {
        return host_env.map(str::trim).filter(|v| !v.is_empty()).map(String::from);
    }
    let list: Vec<&str> = base.unwrap_or_else(|| FEATURE_KEYS.to_vec()).into_iter().filter(|k| *k != "terminal").collect();
    Some(if list.is_empty() { "agent_chat".to_string() } else { list.join(",") })
}

/// The `LLMIDE_*` variables the spawned core gets from the prefs: only ever the exact value `on`.
pub fn core_env_pairs(p: &Prefs, host_features: Option<&str>) -> Vec<(&'static str, String)> {
    let mut v = Vec::new();
    if p.router {
        v.push(("LLMIDE_ROUTER", "on".to_string()));
        if p.cap { v.push(("LLMIDE_ROUTER_CAP", "on".to_string())); }
        if p.compress { v.push(("LLMIDE_ROUTER_COMPRESS", "on".to_string())); }
    }
    if p.learn { v.push(("LLMIDE_ROUTER_LEARN", "on".to_string())); }
    if !p.terminal || !p.features.is_empty() {
        if let Some(f) = effective_features_with(host_features, p.terminal, &p.features) { v.push(("LLMIDE_FEATURES", f)); }
    }
    v
}

// ---- process state ----------------------------------------------------------------------------

struct State {
    dir: Option<PathBuf>,
    stored: Prefs,
}

static LAUNCH: OnceLock<Prefs> = OnceLock::new();
static STATE: Mutex<Option<State>> = Mutex::new(None);
static LIMIT: RateLimit = RateLimit::new(50, 120);

fn state() -> std::sync::MutexGuard<'static, Option<State>> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Reads the file once at startup and fixes the launch snapshot. Call before the core is spawned.
pub fn init(dir: Option<PathBuf>) {
    let stored = dir.as_deref().map(load_from).unwrap_or_default();
    let _ = LAUNCH.set(stored.clone());
    *state() = Some(State { dir, stored });
}

/// What this launch runs with (defaults before `init`, e.g. in unit tests).
pub fn launch() -> Prefs {
    LAUNCH.get().cloned().unwrap_or_default()
}

pub fn stored() -> Prefs {
    state().as_ref().map(|s| s.stored.clone()).unwrap_or_default()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrefsView {
    pub stored: Prefs,
    pub launch: Prefs,
    /// True when the stored values differ from what this launch runs with.
    pub restart_needed: bool,
    /// False when there is no data dir to save into (changes last for this session only).
    pub persisted: bool,
}

fn view(stored: Prefs, persisted: bool) -> PrefsView {
    let launch = launch();
    // The theme applies at once; only the others need a restart.
    let restart_needed = Prefs { theme: launch.theme, loop_defaults: launch.loop_defaults.clone(), graph_auto_update_minutes: launch.graph_auto_update_minutes, update_checks: launch.update_checks, ..stored.clone() } != launch;
    PrefsView { stored, launch, restart_needed, persisted }
}

#[tauri::command]
pub fn get_prefs() -> PrefsView {
    let persisted = state().as_ref().is_some_and(|s| s.dir.is_some());
    view(stored(), persisted)
}

/// Strict typed update. Unknown keys and invalid values fail at deserialisation (before this runs).
#[tauri::command]
pub fn set_prefs(patch: PrefsPatch) -> Result<PrefsView, FsError> {
    if !LIMIT.allow() {
        return Err(herr("rate_limited", "too many preference changes"));
    }
    apply(patch)
}

fn apply(patch: PrefsPatch) -> Result<PrefsView, FsError> {
    let mut g = state();
    let st = g.get_or_insert_with(|| State { dir: None, stored: Prefs::default() });
    let next = st.stored.patched(&patch);
    if let Some(dir) = &st.dir {
        save_to(dir, &next).map_err(|e| herr("io", format!("cannot save preferences: {e}")))?;
    }
    st.stored = next.clone();
    let persisted = st.dir.is_some();
    drop(g);
    Ok(view(next, persisted))
}

/// Host-side writer for the native pickers only: a picked checkout turns source mode on and stores the path.
/// Takes effect at the next app start, like every other backend path (see `launch()`).
pub(crate) fn set_backend_paths(node: Option<String>, folder: Option<String>) -> Result<PrefsView, FsError> {
    let mut g = state();
    let st = g.get_or_insert_with(|| State { dir: None, stored: Prefs::default() });
    let mut next = st.stored.clone();
    next.backend_source = true;
    if let Some(n) = node { next.backend_node = n.trim().to_string(); }
    if let Some(d) = folder { next.backend_dir = d.trim().to_string(); }
    if let Some(dir) = &st.dir {
        save_to(dir, &next).map_err(|e| herr("io", format!("cannot save preferences: {e}")))?;
    }
    st.stored = next.clone();
    let persisted = st.dir.is_some();
    drop(g);
    Ok(view(next, persisted))
}

/// The archive policy this launch uses.
pub fn archive_policy() -> crate::chat_archive::ArchivePolicy {
    use crate::chat_archive::ArchivePolicy as P;
    match launch().lta_mode {
        LtaMode::Off => P::Off,
        LtaMode::Shadow => P::Shadow,
        LtaMode::On => P::On,
    }
}

/// The Terminal feature for this launch: the host's own `LLMIDE_FEATURES` AND the pref.
pub fn terminal_enabled(host_features: Option<&str>) -> bool {
    let launch = launch();
    let eff = effective_features_with(host_features, launch.terminal, &launch.features);
    crate::pty::feature_enabled(eff.as_deref(), "terminal")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-prefs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn defaults_are_off_for_every_token_affecting_switch() {
        let d = Prefs::default();
        assert!(!d.router && !d.cap && !d.compress && !d.learn);
        assert_eq!(d.lta_mode, LtaMode::Off);
        assert!(d.terminal);
        assert!(core_env_pairs(&d, None).is_empty(), "defaults pass nothing to the core");
    }

    #[test]
    fn core_env_is_exactly_on_and_cap_compress_need_the_router() {
        let mut p = Prefs { router: true, cap: true, compress: true, learn: true, ..Prefs::default() };
        let v = core_env_pairs(&p, None);
        let names: Vec<&str> = v.iter().map(|(k, _)| *k).collect();
        assert_eq!(names, ["LLMIDE_ROUTER", "LLMIDE_ROUTER_CAP", "LLMIDE_ROUTER_COMPRESS", "LLMIDE_ROUTER_LEARN"]);
        assert!(v.iter().all(|(_, val)| val == "on"));
        p.router = false;
        let v = core_env_pairs(&p, None);
        assert_eq!(v.iter().map(|(k, _)| *k).collect::<Vec<_>>(), ["LLMIDE_ROUTER_LEARN"]);
    }

    #[test]
    fn patching_the_router_off_clears_cap_and_compress() {
        let on = Prefs::default().patched(&PrefsPatch { router: Some(true), cap: Some(true), compress: Some(true), ..Default::default() });
        assert!(on.cap && on.compress);
        let off = on.patched(&PrefsPatch { router: Some(false), ..Default::default() });
        assert!(!off.router && !off.cap && !off.compress);
        let stray = Prefs::default().patched(&PrefsPatch { cap: Some(true), ..Default::default() });
        assert!(!stray.cap, "cap alone cannot be stored while the router is off");
    }

    #[test]
    fn an_explicit_profile_is_normalized_ordered_and_always_keeps_chat() {
        let p = Prefs::default().patched(&PrefsPatch {
            features: Some(vec!["doc_gen".into(), "nope".into(), "agent_chat".into(), "file_explorer".into(), "doc_gen".into()]),
            ..Default::default()
        });
        assert_eq!(p.features, ["agent_chat", "file_explorer", "doc_gen"], "known keys only, canonical order, chat forced");
        assert!(!p.terminal, "an explicit profile without the terminal key turns the legacy flag off");
        let all = Prefs::default().patched(&PrefsPatch { features: Some(vec!["file_explorer".into()]), ..Default::default() });
        assert_eq!(all.features, ["agent_chat", "file_explorer"]);
        let empty = Prefs::default().patched(&PrefsPatch { features: Some(vec![]), ..Default::default() });
        assert!(empty.features.is_empty(), "an empty list stays 'inherit every feature'");
    }

    #[test]
    fn the_terminal_switch_and_the_profile_stay_in_step() {
        let with_terminal = Prefs::default().patched(&PrefsPatch {
            features: Some(vec!["agent_chat".into(), "file_explorer".into(), "terminal".into()]),
            ..Default::default()
        });
        assert!(with_terminal.terminal);
        let off = with_terminal.patched(&PrefsPatch { terminal: Some(false), ..Default::default() });
        assert!(!off.terminal);
        assert!(!off.features.iter().any(|k| k == "terminal"), "turning Terminal off removes it from the profile");
        let back = off.patched(&PrefsPatch { terminal: Some(true), ..Default::default() });
        assert!(back.features.iter().any(|k| k == "terminal"));
    }

    #[test]
    fn an_explicit_profile_sets_llmide_features_for_the_core() {
        let p = Prefs::default().patched(&PrefsPatch {
            features: Some(vec!["agent_chat".into(), "file_explorer".into(), "terminal".into()]),
            ..Default::default()
        });
        let v = core_env_pairs(&p, Some("agent_chat,doc_gen"));
        assert_eq!(v, vec![("LLMIDE_FEATURES", "agent_chat,file_explorer,terminal".to_string())]);
        // Terminal off removes it from the explicit profile too.
        let off = p.patched(&PrefsPatch { terminal: Some(false), ..Default::default() });
        assert_eq!(core_env_pairs(&off, None), vec![("LLMIDE_FEATURES", "agent_chat,file_explorer".to_string())]);
        // The profile wins over the host's own value.
        let two = effective_features_with(None, true, &["agent_chat".into(), "auto_tasks".into()]).unwrap();
        assert_eq!(two, "agent_chat,auto_tasks");
    }

    #[test]
    fn a_legacy_file_without_features_keeps_its_terminal_setting() {
        let text = r#"{"ltaMode":"off","router":false,"cap":false,"compress":false,"learn":false,"terminal":false,"theme":"dark"}"#;
        let p = parse(text);
        assert!(!p.terminal);
        assert!(p.features.is_empty());
        assert_eq!(effective_features_with(None, p.terminal, &p.features).unwrap(), "agent_chat,file_explorer,code_graph_3d,gantt_issues,doc_gen,mobile_sync,auto_tasks");
    }

    #[test]
    fn terminal_off_lists_every_other_feature_and_never_empties() {
        assert_eq!(effective_features(None, true), None);
        assert_eq!(effective_features(Some(" "), true), None);
        let all = effective_features(None, false).unwrap();
        assert_eq!(all, "agent_chat,file_explorer,code_graph_3d,gantt_issues,doc_gen,mobile_sync,auto_tasks");
        assert_eq!(effective_features(Some("agent_chat, terminal,file_explorer"), false).unwrap(), "agent_chat,file_explorer");
        assert_eq!(effective_features(Some("terminal"), false).unwrap(), "agent_chat");
        assert_eq!(effective_features(Some("agent_chat,terminal"), true).unwrap(), "agent_chat,terminal");
        let v = core_env_pairs(&Prefs { terminal: false, ..Prefs::default() }, Some("agent_chat,terminal"));
        assert_eq!(v, vec![("LLMIDE_FEATURES", "agent_chat".to_string())]);
    }

    #[test]
    fn feature_keys_match_the_servers_list() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../extension/core/config.mjs")).unwrap();
        let start = src.find("export const FEATURE_KEYS").unwrap();
        let block = &src[start..start + src[start..].find(']').unwrap()];
        let found: Vec<&str> = block.split('\'').skip(1).step_by(2).collect();
        assert_eq!(found, FEATURE_KEYS, "update prefs.rs FEATURE_KEYS to match config.mjs");
    }

    #[test]
    fn the_webview_cannot_set_the_backend_paths() {
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendNode":"/bin/sh"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendDir":"/tmp"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendSource":true}"#).is_ok());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"backendPort":3458}"#).is_ok());
    }

    #[test]
    fn strict_schema_refuses_unknown_keys_and_bad_values() {
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"router":true}"#).is_ok());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"routerr":true}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"ltaMode":"always"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"theme":"neon"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"router":"on"}"#).is_err());
        assert!(serde_json::from_str::<PrefsPatch>(r#"{"__proto__":1}"#).is_err());
    }

    #[test]
    fn a_hand_edited_file_never_widens_anything() {
        assert_eq!(parse("not json"), Prefs::default());
        assert_eq!(parse(r#"{"router":true,"extra":1}"#), Prefs::default(), "unknown key: whole file ignored");
        assert_eq!(parse(r#"{"cap":true}"#), Prefs::default(), "cap without router is normalised away");
        assert_eq!(parse(&"x".repeat(MAX_BYTES + 1)), Prefs::default());
        let p = parse(r#"{"router":true,"cap":true,"ltaMode":"shadow","terminal":false,"theme":"light"}"#);
        assert!(p.router && p.cap && !p.terminal);
        assert_eq!((p.lta_mode, p.theme), (LtaMode::Shadow, Theme::Light));
    }

    #[test]
    fn saves_atomically_private_and_round_trips() {
        let d = tmp("rt");
        let p = Prefs { router: true, learn: true, lta_mode: LtaMode::On, ..Prefs::default() };
        save_to(&d, &p).unwrap();
        assert_eq!(load_from(&d), p);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(FILE_NAME)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(!d.join("prefs.tmp").exists());
        std::fs::write(d.join(FILE_NAME), vec![b' '; MAX_BYTES + 10]).unwrap();
        assert_eq!(load_from(&d), Prefs::default(), "an oversized file is ignored");
    }

    #[test]
    fn restart_needed_compares_with_the_launch_snapshot_and_ignores_theme() {
        // LAUNCH is the defaults in unit tests.
        let same = view(Prefs { theme: Theme::Light, ..Prefs::default() }, true);
        assert!(!same.restart_needed, "theme applies at once");
        let graph = view(Prefs { graph_auto_update_minutes: 15, ..Prefs::default() }, true);
        assert!(!graph.restart_needed, "the timer reads stored() live");
        let diff = view(Prefs { learn: true, ..Prefs::default() }, true);
        assert!(diff.restart_needed);
    }

    #[test]
    fn set_prefs_without_a_data_dir_keeps_the_change_for_the_session() {
        let v = apply(PrefsPatch { learn: Some(true), ..Default::default() }).unwrap();
        assert!(v.stored.learn && v.restart_needed);
        let _ = apply(PrefsPatch { learn: Some(false), ..Default::default() });
    }

    #[test]
    fn the_terminal_gate_needs_both_the_env_and_the_pref() {
        // `terminal_enabled` reads the launch snapshot (defaults in unit tests: terminal on); the pure part is `effective_features`.
        let on = |env: Option<&str>, pref: bool| crate::pty::feature_enabled(effective_features(env, pref).as_deref(), "terminal");
        assert!(on(None, true));
        assert!(!on(None, false), "the pref turns it off with no env");
        assert!(!on(Some("agent_chat,file_explorer"), true), "the env without terminal keeps it off");
        assert!(!on(Some("agent_chat,terminal"), false), "the pref wins over the env");
        assert!(on(Some("agent_chat,terminal"), true));
        assert!(terminal_enabled(None), "default launch: on");
    }
}

#[cfg(test)]
mod loop_default_tests {
    use super::*;

    #[test]
    fn loop_defaults_round_trip_and_clamp_the_policy() {
        let d = LoopDefaults {
            max_iterations: 4, consecutive_failure_stop: 1, wall_clock_minutes: 15,
            max_repairs_per_stage: 0, pause_timeout_minutes: 0,
            protected_path_policy: "bogus".to_string(), write_summary_note: true,
        };
        let p = Prefs::default().patched(&PrefsPatch { loop_defaults: Some(d), ..Default::default() });
        assert_eq!(p.loop_defaults.max_iterations, 4);
        assert_eq!(p.loop_defaults.protected_path_policy, "revert");
        assert!(p.loop_defaults.write_summary_note);
        let back = parse(&serde_json::to_string(&p).unwrap());
        assert_eq!(back.loop_defaults, p.loop_defaults);
    }

    #[test]
    fn loop_defaults_clamp_every_bound() {
        let d = LoopDefaults {
            max_iterations: 0, consecutive_failure_stop: 99, wall_clock_minutes: 99_999,
            max_repairs_per_stage: 999, pause_timeout_minutes: 999,
            protected_path_policy: "off".to_string(), write_summary_note: false,
        };
        let p = Prefs::default().patched(&PrefsPatch { loop_defaults: Some(d), ..Default::default() });
        assert_eq!(p.loop_defaults.max_iterations, 1);
        assert_eq!(p.loop_defaults.consecutive_failure_stop, 20);
        assert_eq!(p.loop_defaults.wall_clock_minutes, 1440);
        assert_eq!(p.loop_defaults.max_repairs_per_stage, 20);
        assert_eq!(p.loop_defaults.pause_timeout_minutes, 240);
        assert_eq!(p.loop_defaults.protected_path_policy, "off");
        let high = LoopDefaults { max_iterations: 500, consecutive_failure_stop: 0, ..LoopDefaults::default() };
        let q = Prefs::default().patched(&PrefsPatch { loop_defaults: Some(high), ..Default::default() });
        assert_eq!(q.loop_defaults.max_iterations, 100);
        assert_eq!(q.loop_defaults.consecutive_failure_stop, 1);
    }

    #[test]
    fn update_checks_default_on_patchable_and_never_need_a_restart() {
        assert!(Prefs::default().update_checks);
        let off = Prefs::default().patched(&PrefsPatch { update_checks: Some(false), ..Default::default() });
        assert!(!off.update_checks);
        assert!(!parse(&serde_json::to_string(&off).unwrap()).update_checks);
        // An old file without the key keeps the default.
        assert!(parse(r#"{"ltaMode":"off"}"#).update_checks);
    }

    #[test]
    fn graph_auto_update_is_off_or_between_five_and_a_day() {
        let mut p = Prefs::default();
        assert_eq!(p.graph_auto_update_minutes, 0);
        p = p.patched(&PrefsPatch { graph_auto_update_minutes: Some(1), ..Default::default() });
        assert_eq!(p.graph_auto_update_minutes, 5);
        p = p.patched(&PrefsPatch { graph_auto_update_minutes: Some(99_999), ..Default::default() });
        assert_eq!(p.graph_auto_update_minutes, 1440);
        p = p.patched(&PrefsPatch { graph_auto_update_minutes: Some(0), ..Default::default() });
        assert_eq!(p.graph_auto_update_minutes, 0);
        let back = parse(&serde_json::to_string(&p).unwrap());
        assert_eq!(back.graph_auto_update_minutes, 0);
    }
}
