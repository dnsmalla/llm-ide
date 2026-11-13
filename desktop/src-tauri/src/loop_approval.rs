//! Native host approval for Loop shell commands (R-014#2).
//!
//! `system/loop.json` is a plain project file the webview can write. Reading a command from it and feeding it to
//! `/bin/sh` is therefore NOT a security boundary, and a `window.confirm()` in the page proves nothing to the host: a
//! compromised webview can skip it. This module is the boundary.
//!
//! The host resolves the stage list and the fault `verify:` commands ITSELF, shows a native Cancel-first dialog that
//! names the exact commands and the working folder, and only then mints a random in-memory token. The token is bound
//! to:
//!
//! - the exact command bytes' SHA-256 (editing a command invalidates the approval),
//! - the loop id and stage id (or the fault's project-relative path),
//! - the canonical project root and Loop working folder, and
//! - an expiry (`GRANT_TTL_MS`).
//!
//! A Loop shell stage, a whole-loop run and a fault verify command must all present a matching token before any
//! process is spawned. The token is reusable until it expires so a multi-iteration run does not re-prompt, but it is
//! explicitly scoped to the shown command hashes and folder: it is not a blanket "allow all commands" switch. The
//! webview cannot mint a token without the native dialog; it can only ask for one.
//!
//! Unlike `host_approval` (which signs a token for the Node core), the verifier lives in the same process as the
//! mint, so a random 192-bit in-memory token is enough; there is no second process to convince.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::Serialize;

use crate::confirm::{now_ms, OpenFlag, RateLimit};
use crate::loop_runner::{
    canonical_roots, command_hash, fault_commands, loop_has_enabled_kind, loop_name, loop_shell_stages,
    resolve_stage, FaultSpec, StageSpec,
};

/// How long one approval lasts. It is released sooner by `loop_revoke_approvals` or by quitting the app.
pub const GRANT_TTL_MS: u64 = 4 * 60 * 60 * 1000;
/// The one button that approves a Loop command set.
pub const APPROVE_ACCEPT: &str = "Run these commands";
/// A dialog longer than this is refused rather than silently truncating the commands the user is approving.
const MAX_DIALOG_CHARS: usize = 6000;
const MAX_COMMAND_CHARS: usize = 800;

/// What a successful approval returns to the page. The token is opaque and is the only thing that unlocks a run.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoopApproval {
    pub token: String,
    pub expires_at_ms: u64,
    pub stage_ids: Vec<String>,
    pub fault_count: usize,
}

/// Read-only view for the Loop page: whether a valid approval already covers the loop's exact current commands.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoopApprovalStatus {
    pub approved: bool,
    /// Commands that still need a native approval (shell stages plus fault verify commands).
    pub pending: usize,
    pub expires_at_ms: Option<u64>,
    /// The existing token when approved, so a scheduled run can reuse it without a dialog.
    pub token: Option<String>,
}

/// The immutable part of a grant: exactly what the human approved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GrantData {
    pub project: PathBuf,
    pub work: PathBuf,
    /// loop id -> stage id -> SHA-256 of the exact command.
    pub stages: HashMap<String, HashMap<String, String>>,
    /// project-relative fault path -> SHA-256 of its exact `verify:` command.
    pub faults: HashMap<String, String>,
}

struct Grant {
    data: GrantData,
    expires_ms: u64,
}

/// In-memory grants. One instance is used by the app; tests use their own so they never share state.
pub struct ApprovalStore {
    grants: Mutex<HashMap<String, Grant>>,
}

impl ApprovalStore {
    pub fn new() -> Self {
        Self { grants: Mutex::new(HashMap::new()) }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Grant>> {
        self.grants.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn purge(grants: &mut HashMap<String, Grant>, now: u64) {
        grants.retain(|_, g| g.expires_ms > now);
    }

    /// Stores `data` under a fresh random token, valid from `now`.
    pub(crate) fn insert_at(&self, data: GrantData, now: u64) -> Result<(String, u64), String> {
        let mut raw = [0u8; 24];
        getrandom::fill(&mut raw).map_err(|e| format!("cannot generate an approval token: {e}"))?;
        let token = crate::host_approval::to_hex(&raw);
        let expires = now + GRANT_TTL_MS;
        let mut grants = self.lock();
        Self::purge(&mut grants, now);
        grants.insert(token.clone(), Grant { data, expires_ms: expires });
        Ok((token, expires))
    }

    /// The token of an existing, unexpired grant for EXACTLY this data, if any.
    pub(crate) fn find_at(&self, data: &GrantData, now: u64) -> Option<(String, u64)> {
        let mut grants = self.lock();
        Self::purge(&mut grants, now);
        grants.iter().find(|(_, g)| &g.data == data).map(|(t, g)| (t.clone(), g.expires_ms))
    }

    /// True only when `token` covers this exact stage/loop/folder and the CURRENT command hash matches.
    pub(crate) fn authorize_stage_at(
        &self,
        token: &str,
        project: &Path,
        work: &Path,
        loop_id: &str,
        stage_id: &str,
        command: &str,
        now: u64,
    ) -> Result<(), String> {
        let mut grants = self.lock();
        Self::purge(&mut grants, now);
        let g = grants.get(token).ok_or_else(|| "this shell stage has no valid native host approval; run the Loop again to approve it".to_string())?;
        if g.data.project != project || g.data.work != work {
            return Err("that approval is for another project or working folder".into());
        }
        let stages = g.data.stages.get(loop_id).ok_or_else(|| "that approval does not cover this loop".to_string())?;
        let approved = stages.get(stage_id).ok_or_else(|| "that approval does not cover this stage".to_string())?;
        if approved != &command_hash(command) {
            return Err("the command changed since it was approved; nothing ran".into());
        }
        Ok(())
    }

    /// True only when `token` covers this exact fault path and its CURRENT verify command hash.
    pub(crate) fn authorize_fault_at(
        &self,
        token: &str,
        project: &Path,
        work: &Path,
        rel: &str,
        command: &str,
        now: u64,
    ) -> Result<(), String> {
        let mut grants = self.lock();
        Self::purge(&mut grants, now);
        let g = grants.get(token).ok_or_else(|| "this fault verify command has no valid native host approval; approve the Loop again".to_string())?;
        if g.data.project != project || g.data.work != work {
            return Err("that approval is for another project or working folder".into());
        }
        let approved = g.data.faults.get(rel).ok_or_else(|| "that approval does not cover this fault verify command".to_string())?;
        if approved != &command_hash(command) {
            return Err("the command changed since it was approved; nothing ran".into());
        }
        Ok(())
    }

    pub(crate) fn clear(&self) {
        self.lock().clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().len()
    }
}

impl Default for ApprovalStore {
    fn default() -> Self {
        Self::new()
    }
}

static STORE: OnceLock<ApprovalStore> = OnceLock::new();

/// The process-wide store the Tauri commands use.
pub fn store() -> &'static ApprovalStore {
    STORE.get_or_init(ApprovalStore::new)
}

/// A native dialog request: exactly the commands and folder the user is about to approve.
struct ApprovalRequest {
    data: GrantData,
    loop_name: String,
    stages: Vec<StageSpec>,
    faults: Vec<FaultSpec>,
}

impl ApprovalRequest {
    fn is_empty(&self) -> bool {
        self.stages.is_empty() && self.faults.is_empty()
    }
}

fn data_for(project: PathBuf, work: PathBuf, stages: &[StageSpec], faults: &[FaultSpec]) -> GrantData {
    let mut by_loop: HashMap<String, HashMap<String, String>> = HashMap::new();
    for s in stages {
        by_loop.entry(s.loop_id.clone()).or_default().insert(s.stage_id.clone(), command_hash(&s.command));
    }
    let faults = faults.iter().map(|f| (f.rel.clone(), command_hash(&f.command))).collect();
    GrantData { project, work, stages: by_loop, faults }
}

fn loop_request(root: &Path, loop_id: &str) -> Result<ApprovalRequest, String> {
    let (project, work) = canonical_roots(root)?;
    let loop_name = loop_name(root, loop_id)?;
    let stages = loop_shell_stages(root, loop_id)?;
    let faults = if loop_has_enabled_kind(root, loop_id, "regressionSweep")? { fault_commands(root)? } else { Vec::new() };
    let data = data_for(project, work, &stages, &faults);
    Ok(ApprovalRequest { data, loop_name, stages, faults })
}

fn stage_request(root: &Path, stage_id: &str, loop_id: Option<&str>) -> Result<ApprovalRequest, String> {
    let spec = resolve_stage(root, stage_id, loop_id)?;
    let (project, work) = canonical_roots(root)?;
    let loop_name = loop_name(root, &spec.loop_id)?;
    let (stages, faults) = match spec.kind.as_str() {
        "shellCommand" => {
            if spec.command.is_empty() { return Err("this stage has no command".into()); }
            (vec![spec], Vec::new())
        }
        "regressionSweep" => (Vec::new(), fault_commands(root)?),
        _ => return Err("this stage does not run a shell command, so it needs no approval".into()),
    };
    let data = data_for(project, work, &stages, &faults);
    Ok(ApprovalRequest { data, loop_name, stages, faults })
}

fn approval_from(token: String, expires_ms: u64, req: &ApprovalRequest) -> LoopApproval {
    LoopApproval {
        token,
        expires_at_ms: expires_ms,
        stage_ids: req.stages.iter().map(|s| s.stage_id.clone()).collect(),
        fault_count: req.faults.len(),
    }
}

fn empty_approval() -> LoopApproval {
    LoopApproval { token: String::new(), expires_at_ms: 0, stage_ids: Vec::new(), fault_count: 0 }
}

fn display_text(s: &str, max: usize) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c == '\n' || c == '\t' {
            out.push(c);
        } else if c.is_control() {
            out.push(' ');
        } else if crate::tray::is_invisible_format(c) {
            continue;
        } else {
            out.push(c);
        }
        if out.chars().count() >= max {
            out.push('…');
            break;
        }
    }
    out
}

fn display_command(command: &str) -> String {
    display_text(command, MAX_COMMAND_CHARS)
}

fn dialog_title(req: &ApprovalRequest) -> &'static str {
    if req.stages.is_empty() {
        "Approve Loop fault verify commands?"
    } else if req.stages.len() == 1 && req.faults.is_empty() {
        "Approve this Loop command?"
    } else {
        "Approve Loop shell commands?"
    }
}

/// Builds the native dialog body. The fixed template names the exact commands and the folder; the approval binds
/// their hashes, not this text. Too many commands are refused instead of hiding some behind a truncation marker.
fn approval_text(req: &ApprovalRequest) -> Result<String, String> {
    let mut body = String::new();
    if !req.stages.is_empty() {
        body.push_str(&format!(
            "Loop \u{201C}{}\u{201D} wants to run these shell commands in:\n{}\n\n",
            display_text(&req.loop_name, 120),
            display_text(&req.data.work.to_string_lossy(), 300),
        ));
        for (i, s) in req.stages.iter().enumerate() {
            body.push_str(&format!("{}. {}:\n{}\n\n", i + 1, display_text(&s.name, 80), display_command(&s.command)));
        }
    }
    if !req.faults.is_empty() {
        let verb = if req.stages.is_empty() { "wants to run" } else { "will also run" };
        body.push_str(&format!(
            "Loop \u{201C}{}\u{201D} {} {} fault verify command(s) from system/faults. Each is pinned to its exact command hash:\n\n",
            display_text(&req.loop_name, 120),
            verb,
            req.faults.len(),
        ));
        for f in &req.faults {
            body.push_str(&format!("- {}:\n{}\n\n", display_text(&f.rel, 240), display_command(&f.command)));
        }
    }
    body.push_str(
        "Only these exact commands are approved. If a command changes, the approval no longer matches and nothing runs. \
         The approval is for this loop, this folder and these command hashes only, and it expires in 4 hours.",
    );
    if body.chars().count() > MAX_DIALOG_CHARS {
        return Err("there are too many commands to show in one approval dialog; split the loop or run the stages individually".into());
    }
    Ok(body)
}

/// The dialog + mint step for a whole loop. `ask` is the native dialog in production and a closure in tests; on
/// `false` no grant is stored. The loop and fault files are re-read after the dialog, and a change while it was open
/// declines the approval rather than approving commands the user did not see.
pub(crate) fn approve_loop_with(
    store: &ApprovalStore,
    root: &Path,
    loop_id: &str,
    now: u64,
    ask: impl FnOnce(&str, &str) -> bool,
) -> Result<Option<LoopApproval>, String> {
    let req = loop_request(root, loop_id)?;
    if req.is_empty() {
        return Ok(Some(empty_approval()));
    }
    if let Some((token, expires)) = store.find_at(&req.data, now) {
        return Ok(Some(approval_from(token, expires, &req)));
    }
    let text = approval_text(&req)?;
    let opened = std::time::Instant::now();
    if !ask(dialog_title(&req), &text) {
        return Ok(None);
    }
    // The grant starts when the dialog closes, not when it opened: time spent reading it must not eat into the 4 h.
    let now = now.saturating_add(opened.elapsed().as_millis() as u64);
    let after = loop_request(root, loop_id)?;
    if after.data != req.data {
        return Err("system/loop.json or the fault reports changed while the approval was open; nothing was approved".into());
    }
    let (token, expires) = store.insert_at(after.data.clone(), now)?;
    Ok(Some(approval_from(token, expires, &after)))
}

/// The dialog + mint step for one stage (a shell command, or a Regression stage's fault verify commands).
pub(crate) fn approve_stage_with(
    store: &ApprovalStore,
    root: &Path,
    stage_id: &str,
    loop_id: Option<&str>,
    now: u64,
    ask: impl FnOnce(&str, &str) -> bool,
) -> Result<Option<LoopApproval>, String> {
    let req = stage_request(root, stage_id, loop_id)?;
    if req.is_empty() {
        return Ok(Some(empty_approval()));
    }
    if let Some((token, expires)) = store.find_at(&req.data, now) {
        return Ok(Some(approval_from(token, expires, &req)));
    }
    let text = approval_text(&req)?;
    let opened = std::time::Instant::now();
    if !ask(dialog_title(&req), &text) {
        return Ok(None);
    }
    // The grant starts when the dialog closes, not when it opened: time spent reading it must not eat into the 4 h.
    let now = now.saturating_add(opened.elapsed().as_millis() as u64);
    let after = stage_request(root, stage_id, loop_id)?;
    if after.data != req.data {
        return Err("system/loop.json or the fault reports changed while the approval was open; nothing was approved".into());
    }
    let (token, expires) = store.insert_at(after.data.clone(), now)?;
    Ok(Some(approval_from(token, expires, &after)))
}

pub(crate) fn status_with(store: &ApprovalStore, root: &Path, loop_id: &str, now: u64) -> Result<LoopApprovalStatus, String> {
    let req = loop_request(root, loop_id)?;
    let pending = req.stages.len() + req.faults.len();
    if pending == 0 {
        return Ok(LoopApprovalStatus { approved: true, pending: 0, expires_at_ms: None, token: None });
    }
    if let Some((token, expires)) = store.find_at(&req.data, now) {
        return Ok(LoopApprovalStatus { approved: true, pending: 0, expires_at_ms: Some(expires), token: Some(token) });
    }
    Ok(LoopApprovalStatus { approved: false, pending, expires_at_ms: None, token: None })
}

// ---- Tauri commands -----------------------------------------------------------------------

static APPROVAL_LIMIT: RateLimit = RateLimit::new(500, 20);
static APPROVAL_OPEN: OpenFlag = OpenFlag::new();

fn approval_root() -> Result<PathBuf, String> {
    let root = crate::project::active_root().ok_or_else(|| "open a project before approving Loop commands".to_string())?;
    crate::fs_ops::checked_root(&root).map_err(|e| e.message)
}

fn in_dialog<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if !APPROVAL_LIMIT.allow() {
        return Err("too many approval requests; wait a moment".into());
    }
    let _open = APPROVAL_OPEN.acquire().ok_or_else(|| "a confirmation is already open".to_string())?;
    f()
}

/// Native approval for a whole loop's enabled shell stages plus (when it has a Regression stage) every fault
/// `verify:` command. Reuses a still-valid grant for exactly the same commands/folder without re-prompting.
#[tauri::command]
pub async fn loop_approve_loop(loop_id: String) -> Result<Option<LoopApproval>, String> {
    let root = approval_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        in_dialog(|| {
            let now = now_ms();
            approve_loop_with(store(), &root, &loop_id, now, |title, text| {
                crate::confirm::ask(title, text, APPROVE_ACCEPT, true)
            })
        })
    })
    .await
    .map_err(|e| format!("Loop approval task failed: {e}"))?
}

/// Native approval for one stage: its shell command, or a Regression stage's fault verify commands.
#[tauri::command]
pub async fn loop_approve_stage(stage_id: String, loop_id: Option<String>) -> Result<Option<LoopApproval>, String> {
    let root = approval_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        in_dialog(|| {
            let now = now_ms();
            approve_stage_with(store(), &root, &stage_id, loop_id.as_deref(), now, |title, text| {
                crate::confirm::ask(title, text, APPROVE_ACCEPT, true)
            })
        })
    })
    .await
    .map_err(|e| format!("Loop approval task failed: {e}"))?
}

/// Whether a valid approval already covers the loop's exact current commands. Never shows a dialog.
#[tauri::command]
pub fn loop_approval_status(loop_id: String) -> Result<LoopApprovalStatus, String> {
    let root = approval_root()?;
    status_with(store(), &root, &loop_id, now_ms())
}

/// Drops every Loop approval this app has minted. Safe to expose: it only removes permissions.
#[tauri::command]
pub fn loop_revoke_approvals() {
    store().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, command: &str, extra_stage: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("llmide-loop-approval-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("system/faults")).unwrap();
        std::fs::write(
            root.join("system/loop.json"),
            format!(r#"{{"schemaVersion":2,"loops":[{{"id":"l1","name":"L","config":{{"stages":[{{"id":"s1","name":"T","kind":"shellCommand","command":{command:?},"enabled":true}}{extra_stage}]}}}}]}}"#),
        )
        .unwrap();
        std::fs::canonicalize(root).unwrap()
    }

    fn data(project: &Path, work: &Path, stage: &str, command: &str) -> GrantData {
        GrantData {
            project: project.to_path_buf(),
            work: work.to_path_buf(),
            stages: HashMap::from([("l1".to_string(), HashMap::from([(stage.to_string(), command_hash(command))]))]),
            faults: HashMap::new(),
        }
    }

    #[test]
    fn the_grant_is_stamped_when_the_dialog_closes_not_when_it_opened() {
        let root = project("stamp", "printf approved", "");
        let store = ApprovalStore::new();
        let out = approve_loop_with(&store, &root, "l1", 1_000, |_, _| {
            std::thread::sleep(std::time::Duration::from_millis(80));
            true
        })
        .unwrap()
        .expect("accepted");
        assert!(out.expires_at_ms >= 1_000 + 70 + GRANT_TTL_MS, "grant expiry ignores the time the dialog was open: {out:?}");
    }

    #[test]
    fn a_grant_is_bound_to_the_exact_command_hash_and_scope() {
        let root = std::env::temp_dir().join(format!("llmide-loop-approval-store-{}", std::process::id()));
        let store = ApprovalStore::new();
        let d = data(&root, &root, "s1", "printf ok");
        let (token, expires) = store.insert_at(d, 1_000).unwrap();
        assert_eq!(expires, 1_000 + GRANT_TTL_MS);
        assert!(store.authorize_stage_at(&token, &root, &root, "l1", "s1", "printf ok", 2_000).is_ok());
        assert!(store.authorize_stage_at(&token, &root, &root, "l1", "s1", "printf changed", 2_000).is_err(), "changed command");
        assert!(store.authorize_stage_at(&token, &root, &root, "l2", "s1", "printf ok", 2_000).is_err(), "another loop");
        assert!(store.authorize_stage_at(&token, &root, &root, "l1", "s2", "printf ok", 2_000).is_err(), "another stage");
        assert!(store.authorize_stage_at(&token, &root, Path::new("/elsewhere"), "l1", "s1", "printf ok", 2_000).is_err(), "another folder");
        assert!(store.authorize_stage_at("", &root, &root, "l1", "s1", "printf ok", 2_000).is_err(), "no token");
        assert!(store.authorize_stage_at(&token, &root, &root, "l1", "s1", "printf ok", 1_000 + GRANT_TTL_MS).is_err(), "expired");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_fault_grant_is_bound_to_its_path_and_command_hash() {
        let root = std::env::temp_dir().join(format!("llmide-loop-approval-fault-store-{}", std::process::id()));
        let store = ApprovalStore::new();
        let d = GrantData {
            project: root.clone(),
            work: root.clone(),
            stages: HashMap::new(),
            faults: HashMap::from([("system/faults/f.md".to_string(), command_hash("printf ok"))]),
        };
        let (token, _) = store.insert_at(d, 1_000).unwrap();
        assert!(store.authorize_fault_at(&token, &root, &root, "system/faults/f.md", "printf ok", 2_000).is_ok());
        assert!(store.authorize_fault_at(&token, &root, &root, "system/faults/f.md", "printf changed", 2_000).is_err());
        assert!(store.authorize_fault_at(&token, &root, &root, "system/faults/other.md", "printf ok", 2_000).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_grant_is_reused_only_for_the_identical_command_set() {
        let root = std::env::temp_dir().join(format!("llmide-loop-approval-reuse-{}", std::process::id()));
        let store = ApprovalStore::new();
        let a = data(&root, &root, "s1", "printf one");
        let (token, _) = store.insert_at(a.clone(), 1_000).unwrap();
        assert_eq!(store.find_at(&a, 2_000).map(|x| x.0), Some(token));
        let mut b = a.clone();
        b.stages.get_mut("l1").unwrap().insert("s1".into(), command_hash("printf two"));
        assert!(store.find_at(&b, 2_000).is_none(), "a changed command is a new approval");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_native_dialog_names_the_exact_command_and_declines_cleanly() {
        let root = project("dialog", "printf approved", "");
        let store = ApprovalStore::new();
        let mut shown = String::new();
        let out = approve_loop_with(&store, &root, "l1", 1_000, |title, text| {
            assert!(title.contains("Approve"), "{title}");
            shown = text.to_string();
            false
        })
        .unwrap();
        assert!(out.is_none(), "Cancel mints no token");
        assert!(shown.contains("printf approved"), "{shown}");
        assert!(shown.contains("exact commands"), "{shown}");
        assert!(shown.contains("4 hours"), "{shown}");
        assert_eq!(store.len(), 0, "a declined dialog stores nothing");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_accepted_dialog_mints_a_scoped_token_and_a_changed_file_is_refused() {
        let root = project("accept", "printf approved", "");
        let store = ApprovalStore::new();
        let out = approve_loop_with(&store, &root, "l1", 1_000, |_, _| true).unwrap().expect("accepted");
        assert_eq!(out.stage_ids, vec!["s1".to_string()]);
        assert_eq!(out.fault_count, 0);
        assert!(!out.token.is_empty());
        assert_eq!(store.len(), 1);
        // Change loop.json after the dialog: a fresh request no longer matches, and the run gate refuses.
        std::fs::write(
            root.join("system/loop.json"),
            format!(r#"{{"schemaVersion":2,"loops":[{{"id":"l1","name":"L","config":{{"stages":[{{"id":"s1","name":"T","kind":"shellCommand","command":{command:?},"enabled":true}}]}}}}]}}"#, command = "printf changed"),
        )
        .unwrap();
        let (project, work) = canonical_roots(&root).unwrap();
        let err = store.authorize_stage_at(&out.token, &project, &work, "l1", "s1", "printf changed", 2_000).unwrap_err();
        assert!(err.contains("changed since it was approved"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_loop_with_a_regression_stage_binds_every_fault_verify_command() {
        let root = project("faults", "printf ok", r#",{"id":"r1","name":"Regression","kind":"regressionSweep","enabled":true}"#);
        std::fs::write(root.join("system/faults/f.md"), "---\nverify: \"printf fault-ok\"\nstatus: fixed\n---\n").unwrap();
        let store = ApprovalStore::new();
        let out = approve_loop_with(&store, &root, "l1", 1_000, |_, _| true).unwrap().expect("accepted");
        assert_eq!(out.fault_count, 1);
        let (project, work) = canonical_roots(&root).unwrap();
        assert!(store.authorize_fault_at(&out.token, &project, &work, "system/faults/f.md", "printf fault-ok", 2_000).is_ok());
        assert!(store.authorize_fault_at(&out.token, &project, &work, "system/faults/f.md", "printf changed", 2_000).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn status_reports_pending_and_then_the_reusable_token() {
        let root = project("status", "printf ok", "");
        let store = ApprovalStore::new();
        let before = status_with(&store, &root, "l1", 1_000).unwrap();
        assert!(!before.approved);
        assert_eq!(before.pending, 1);
        assert!(before.token.is_none());
        let out = approve_loop_with(&store, &root, "l1", 1_000, |_, _| true).unwrap().unwrap();
        let after = status_with(&store, &root, "l1", 2_000).unwrap();
        assert!(after.approved);
        assert_eq!(after.pending, 0);
        assert_eq!(after.token.as_deref(), Some(out.token.as_str()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_loop_with_no_shell_or_fault_commands_needs_no_dialog() {
        let root = project("empty", "printf ok", "");
        // Replace the shell stage with a stage this approval path ignores.
        std::fs::write(
            root.join("system/loop.json"),
            r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"stages":[{"id":"a1","name":"Artifact","kind":"artifactCheck","enabled":true}]}}]}"#,
        )
        .unwrap();
        let store = ApprovalStore::new();
        let out = approve_loop_with(&store, &root, "l1", 1_000, |_, _| panic!("must not prompt")).unwrap();
        assert!(out.is_some());
        let status = status_with(&store, &root, "l1", 1_000).unwrap();
        assert!(status.approved && status.token.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
