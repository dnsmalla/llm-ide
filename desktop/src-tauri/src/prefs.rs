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
const FEATURE_KEYS: [&str; 8] = [
    "agent_chat", "file_explorer", "code_graph_3d", "gantt_issues", "terminal", "doc_gen", "mobile_sync", "auto_tasks",
];

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
}

impl Default for Prefs {
    fn default() -> Self {
        Self { lta_mode: LtaMode::Off, router: false, cap: false, compress: false, learn: false, terminal: true, theme: Theme::Dark }
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
    serde_json::from_str::<Prefs>(text).map(|p| Prefs::default().patched(&PrefsPatch {
        lta_mode: Some(p.lta_mode), router: Some(p.router), cap: Some(p.cap), compress: Some(p.compress),
        learn: Some(p.learn), terminal: Some(p.terminal), theme: Some(p.theme),
    })).unwrap_or_default()
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
pub fn effective_features(host_env: Option<&str>, terminal: bool) -> Option<String> {
    let base: Option<Vec<&str>> = host_env.map(str::trim).filter(|v| !v.is_empty()).map(|v| v.split(',').map(str::trim).filter(|k| !k.is_empty()).collect());
    if terminal {
        return host_env.map(str::trim).filter(|v| !v.is_empty()).map(String::from);
    }
    let list: Vec<&str> = base.unwrap_or_else(|| FEATURE_KEYS.to_vec()).into_iter().filter(|k| *k != "terminal").collect();
    // Never an empty value (that would read as "all"); chat is always on.
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
    if !p.terminal {
        if let Some(f) = effective_features(host_features, false) { v.push(("LLMIDE_FEATURES", f)); }
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
    let restart_needed = Prefs { theme: launch.theme, ..stored.clone() } != launch;
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
    let eff = effective_features(host_features, launch().terminal);
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
