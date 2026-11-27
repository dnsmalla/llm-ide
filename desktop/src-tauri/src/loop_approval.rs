//! Native host approval for Loop shell commands (R-014#2).
//!
//! `system/loop.json` is a plain project file the webview can write. Reading a command from it and feeding it to
//! `/bin/sh` is therefore NOT a security boundary, and a `window.confirm()` in the page proves nothing to the host: a
//! compromised webview can skip it. This module is the boundary.
//!
//! The host resolves the stage list and the fault `verify:` commands ITSELF, shows a native Cancel-first dialog that
//! names the exact commands and the working folder, and only then mints a random token. The token is bound
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
//! mint, so a random 192-bit token is enough; there is no second process to convince.
//!
//! # Persistence ("remember approvals")
//!
//! Approved grants survive an app restart so the dialog is not shown again for the same exact commands, until the
//! 7-day TTL. The app's store is saved to `loop-approvals.json` in the desktop data dir (`fsutil::desktop_data_dir`,
//! the folder of `recent-projects.json`), written atomically with mode 0600. It holds only the grant DATA (command
//! hashes, loop/stage ids, canonical project root, working folder) and the expiry, as `{"version":1,"grants":[..]}`.
//!
//! - Tokens are NEVER written. Every grant loaded from disk is given a fresh random token; `find_at` hands that
//!   token to the page exactly as it does for a grant minted this session.
//! - The file lives outside every project root, so the webview's project-rooted fs commands cannot read or write it.
//!   Anything that can write the user's app-data dir can already replace the app, its secrets and its prefs, so the
//!   file adds no new way to mint an approval without the native dialog. As defence in depth, a loaded grant whose
//!   expiry is later than `now + GRANT_TTL_MS` is dropped (a hand-edited "never expires" entry is not honoured).
//! - A missing, unreadable, corrupt or unknown-version file loads as empty (logged once) and is never treated as
//!   approval. It is loaded lazily on first use and expired grants are dropped on load and on every write.
//! - `loop_revoke_approvals` removes the persisted file as well as the in-memory grants.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};

use crate::confirm::{now_ms, OpenFlag, RateLimit};
use crate::loop_runner::{
    canonical_roots, command_hash, fault_commands, loop_has_enabled_kind, loop_name, loop_shell_stages,
    resolve_stage, FaultSpec, StageSpec,
};

/// How long one approval lasts (7 days; persisted across restarts, see the module doc). User decision 2026-11-25:
/// the old 4 h re-prompt interrupted Factory runs for commands the user had already approved. A changed command
/// still needs a new approval, because the grant is bound to the exact command hashes. The hash covers only the
/// command STRING (e.g. `make test`), not the scripts or repo files it runs, which a Loop's own code steps can
/// rewrite mid-run, so an unbounded grant would let an unattended scheduled run
/// (`loop_approval_status`, invariants.md "A scheduled run never prompts") reuse a stale approval indefinitely.
/// Seven days outlasts any single interactive Factory run while bounding that exposure; after it, a scheduled run
/// skips (the same path as having no grant) instead of reusing something stale.
pub const GRANT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
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

/// Grants keyed by token. One instance (file-backed) is used by the app; tests use their own so they never share
/// state. `new()` is memory-only; `with_file` persists the grant data (never the tokens).
pub struct ApprovalStore {
    grants: Mutex<HashMap<String, Grant>>,
    file: Option<PathBuf>,
    loaded: AtomicBool,
}

/// File name of the persisted grants inside the desktop data dir.
pub const APPROVALS_FILE: &str = "loop-approvals.json";
const FILE_VERSION: u32 = 1;
const FILE_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGrant {
    project: String,
    work: String,
    stages: HashMap<String, HashMap<String, String>>,
    faults: HashMap<String, String>,
    expires_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct StoredFile {
    version: u32,
    grants: Vec<StoredGrant>,
}

fn mint_token() -> Result<String, String> {
    let mut raw = [0u8; 24];
    getrandom::fill(&mut raw).map_err(|e| format!("cannot generate an approval token: {e}"))?;
    Ok(crate::fsutil::hex(&raw))
}

impl ApprovalStore {
    pub fn new() -> Self {
        Self { grants: Mutex::new(HashMap::new()), file: None, loaded: AtomicBool::new(true) }
    }

    /// A store that loads `file` lazily on first use and rewrites it after every change.
    pub fn with_file(file: PathBuf) -> Self {
        Self { grants: Mutex::new(HashMap::new()), file: Some(file), loaded: AtomicBool::new(false) }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Grant>> {
        let mut grants = self.grants.lock().unwrap_or_else(|p| p.into_inner());
        // Checked under the map lock, so exactly one caller loads.
        if !self.loaded.swap(true, Ordering::SeqCst) {
            if let Some(file) = &self.file {
                Self::load_into(&mut grants, file, now_ms());
            }
        }
        grants
    }

    /// Same standard as `fsutil::private_dir`: owned by this user, no group/other permission bits.
    #[cfg(unix)]
    fn is_private_file(meta: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        meta.uid() == me && meta.mode() & 0o077 == 0
    }

    #[cfg(not(unix))]
    fn is_private_file(_meta: &std::fs::Metadata) -> bool {
        true
    }

    fn load_into(grants: &mut HashMap<String, Grant>, file: &Path, now: u64) {
        let raw = match std::fs::symlink_metadata(file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Ok(m) if m.is_file() && m.len() <= FILE_MAX_BYTES as u64 && Self::is_private_file(&m) => std::fs::read_to_string(file),
            Ok(_) => {
                eprintln!(
                    "loop approvals: {} is not a private plain file (symlink, other owner, group/other access or too large); ignored",
                    file.display()
                );
                return;
            }
            Err(e) => Err(e),
        };
        let parsed = raw.map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<StoredFile>(&t).map_err(|e| e.to_string()));
        let stored = match parsed {
            Ok(s) if s.version == FILE_VERSION => s,
            Ok(s) => {
                eprintln!("loop approvals: unknown file version {}; ignored", s.version);
                return;
            }
            Err(e) => {
                eprintln!("loop approvals: cannot read {}: {e}; ignored", file.display());
                return;
            }
        };
        let latest = now.saturating_add(GRANT_TTL_MS);
        for g in stored.grants {
            if g.expires_ms <= now || g.expires_ms > latest {
                continue;
            }
            let Ok(token) = mint_token() else { continue };
            let data = GrantData { project: PathBuf::from(g.project), work: PathBuf::from(g.work), stages: g.stages, faults: g.faults };
            grants.insert(token, Grant { data, expires_ms: g.expires_ms });
        }
    }

    /// Rewrites (or removes, when empty) the file. Callers that only add a grant log a failure (the grant still
    /// works this session); a revoke reports it.
    fn persist(&self, grants: &HashMap<String, Grant>) -> Result<(), String> {
        let Some(file) = &self.file else { return Ok(()) };
        if !grants.is_empty() {
            return Self::write_file(file, grants);
        }
        match std::fs::remove_file(file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            // Removal failed: an empty grant list must still replace the old content, or a revoke would not last.
            Err(_) => Self::write_file(file, grants),
        }
    }

    fn write_file(file: &Path, grants: &HashMap<String, Grant>) -> Result<(), String> {
        let stored = StoredFile {
            version: FILE_VERSION,
            // A path that is not valid UTF-8 cannot round-trip, so that grant stays session-only.
            grants: grants
                .values()
                .filter_map(|g| {
                    Some(StoredGrant {
                        project: g.data.project.to_str()?.to_string(),
                        work: g.data.work.to_str()?.to_string(),
                        stages: g.data.stages.clone(),
                        faults: g.data.faults.clone(),
                        expires_ms: g.expires_ms,
                    })
                })
                .collect(),
        };
        let body = serde_json::to_vec(&stored).map_err(|e| e.to_string())?;
        if let Some(dir) = file.parent() {
            crate::fsutil::private_dir(dir)?;
        }
        crate::fsutil::write_private_atomic(file, &body, FILE_MAX_BYTES)
    }

    fn purge(grants: &mut HashMap<String, Grant>, now: u64) {
        grants.retain(|_, g| g.expires_ms > now);
    }

    fn supersedes(new: &GrantData, old: &GrantData) -> bool {
        if new.project != old.project || new.work != old.work {
            return false;
        }
        // Only a CHANGED command supersedes: a grant that agrees with the new one on every shared key stays valid.
        let changed_stage = new.stages.iter().any(|(lp, st)| {
            old.stages.get(lp).is_some_and(|o| st.iter().any(|(k, h)| o.get(k).is_some_and(|oh| oh != h)))
        });
        changed_stage || new.faults.iter().any(|(k, h)| old.faults.get(k).is_some_and(|oh| oh != h))
    }

    /// Stores `data` under a fresh random token, valid from `now`.
    pub(crate) fn insert_at(&self, data: GrantData, now: u64) -> Result<(String, u64), String> {
        let token = mint_token()?;
        let expires = now + GRANT_TTL_MS;
        let mut grants = self.lock();
        Self::purge(&mut grants, now);
        // A new approval supersedes older ones for the same folders whose command for a shared loop/stage or fault
        // id DIFFERS, so an edited command does not leave the previously approved one valid.
        grants.retain(|_, g| !Self::supersedes(&data, &g.data));
        grants.insert(token.clone(), Grant { data, expires_ms: expires });
        if let Err(e) = self.persist(&grants) {
            eprintln!("loop approvals: cannot save the approvals file: {e}");
        }
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

    /// Drops every grant and the persisted file.
    /// Errors when the persisted file could neither be removed nor emptied, so the caller must not claim a revoke.
    pub(crate) fn clear(&self) -> Result<(), String> {
        let mut grants = self.lock();
        grants.clear();
        self.persist(&grants).map_err(|e| format!("the approvals file could not be cleared: {e}"))
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
    STORE.get_or_init(|| match crate::fsutil::desktop_data_dir() {
        Ok(dir) => ApprovalStore::with_file(dir.join(APPROVALS_FILE)),
        Err(e) => {
            eprintln!("loop approvals: no data dir ({e}); approvals will not survive a restart");
            ApprovalStore::new()
        }
    })
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
    let mut stages = loop_shell_stages(root, loop_id)?;
    // The environment setup command (`config.envCache.setup`) is approved with the loop's other commands, under a
    // reserved stage id, so a cache miss never needs a second dialog in the middle of a run.
    if let Some(spec) = crate::loop_env_cache::read_spec(root, loop_id)? {
        if stages.iter().any(|s| s.stage_id == crate::loop_env_cache::ENV_CACHE_STAGE_ID) {
            return Err("a stage uses the reserved id of the environment setup; rename it".into());
        }
        stages.push(StageSpec {
            loop_id: loop_id.to_string(),
            stage_id: crate::loop_env_cache::ENV_CACHE_STAGE_ID.to_string(),
            name: crate::loop_env_cache::ENV_CACHE_STAGE_NAME.to_string(),
            kind: "shellCommand".to_string(),
            command: spec.setup,
        });
    }
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
         The approval is for this loop, this folder and these command hashes only, and it is remembered for up to 7 days, across app restarts, and is asked again if a command changes. Scheduled runs of this loop will use this approval without asking while it lasts.",
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
    // The grant starts when the dialog closes, not when it opened: time spent reading it must not eat into the TTL.
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
    // The grant starts when the dialog closes, not when it opened: time spent reading it must not eat into the TTL.
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
    crate::workspace_backend::refuse_in_ssh_mode().map_err(|e| e.message)?;
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
    crate::workspace_backend::refuse_in_ssh_mode().map_err(|e| e.message)?;
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
    crate::workspace_backend::refuse_in_ssh_mode().map_err(|e| e.message)?;
    let root = approval_root()?;
    status_with(store(), &root, &loop_id, now_ms())
}

/// Drops every Loop approval this app has minted. Safe to expose: it only removes permissions.
#[tauri::command]
pub fn loop_revoke_approvals() -> Result<(), String> {
    store().clear()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_commands_refuse_in_ssh_mode() {
        let _mode = crate::core_host::process_mode_guard();
        crate::core_host::set_process_mode(2);
        let status = loop_approval_status("any".into());
        let approve = tauri::async_runtime::block_on(loop_approve_loop("any".into()));
        crate::core_host::set_process_mode(0);
        assert!(status.unwrap_err().contains("SSH server mode"));
        assert!(approve.unwrap_err().contains("SSH server mode"));
    }

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
        assert!(shown.contains("7 days"), "{shown}");
        assert!(shown.contains("across app restarts"), "{shown}");
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

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("llmide-approvals-file-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join(APPROVALS_FILE)
    }

    fn cleanup(file: &Path) {
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn a_grant_survives_a_restart_and_matches_only_identical_data() {
        let file = temp_file("restart");
        let root = PathBuf::from("/proj");
        let d = data(&root, &root, "s1", "printf ok");
        let now = now_ms();
        let first = ApprovalStore::with_file(file.clone());
        let (old_token, expires) = first.insert_at(d.clone(), now).unwrap();
        let second = ApprovalStore::with_file(file.clone());
        let (token, found_expires) = second.find_at(&d, now + 1_000).expect("remembered");
        assert_eq!(found_expires, expires);
        assert_ne!(token, old_token, "tokens are re-minted, not restored");
        assert!(second.authorize_stage_at(&token, &root, &root, "l1", "s1", "printf ok", now + 1_000).is_ok());
        assert!(second.authorize_stage_at(&old_token, &root, &root, "l1", "s1", "printf ok", now + 1_000).is_err());
        let changed = data(&root, &root, "s1", "printf changed");
        assert!(second.find_at(&changed, now + 1_000).is_none(), "a changed command is a new approval");
        assert!(second.find_at(&data(&root, Path::new("/other"), "s1", "printf ok"), now + 1_000).is_none(), "another folder");
        cleanup(&file);
    }

    #[test]
    fn tokens_are_never_written_to_disk() {
        let file = temp_file("notoken");
        let root = PathBuf::from("/proj");
        let store = ApprovalStore::with_file(file.clone());
        let (token, _) = store.insert_at(data(&root, &root, "s1", "printf ok"), now_ms()).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains(&token), "{text}");
        assert!(text.contains("\"version\":1"), "{text}");
        cleanup(&file);
    }

    #[test]
    fn expired_and_overlong_grants_are_dropped_on_load() {
        let file = temp_file("expired");
        let root = PathBuf::from("/proj");
        let store = ApprovalStore::with_file(file.clone());
        let now = now_ms();
        store.insert_at(data(&root, &root, "s1", "printf old"), now - GRANT_TTL_MS - 5_000).unwrap();
        store.insert_at(data(&root, &root, "s2", "printf fresh"), now).unwrap();
        // A hand-edited entry that never expires is not honoured.
        let mut stored: StoredFile = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let forged = StoredGrant {
            project: "/proj".into(),
            work: "/proj".into(),
            stages: HashMap::from([("l1".to_string(), HashMap::from([("s3".to_string(), command_hash("printf forged"))]))]),
            faults: HashMap::new(),
            expires_ms: u64::MAX,
        };
        stored.grants.push(forged);
        std::fs::write(&file, serde_json::to_string(&stored).unwrap()).unwrap();
        let loaded = ApprovalStore::with_file(file.clone());
        assert!(loaded.find_at(&data(&root, &root, "s1", "printf old"), now).is_none());
        assert!(loaded.find_at(&data(&root, &root, "s3", "printf forged"), now).is_none());
        assert!(loaded.find_at(&data(&root, &root, "s2", "printf fresh"), now).is_some());
        assert_eq!(loaded.len(), 1);
        cleanup(&file);
    }

    #[test]
    fn revoke_clears_the_file() {
        let file = temp_file("revoke");
        let root = PathBuf::from("/proj");
        let store = ApprovalStore::with_file(file.clone());
        store.insert_at(data(&root, &root, "s1", "printf ok"), now_ms()).unwrap();
        assert!(file.exists());
        store.clear().unwrap();
        assert!(!file.exists());
        assert_eq!(ApprovalStore::with_file(file.clone()).len(), 0);
        cleanup(&file);
    }

    #[test]
    fn a_corrupt_or_unknown_version_file_loads_empty() {
        let file = temp_file("corrupt");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for body in ["{broken", "", "[]", r#"{"version":99,"grants":[]}"#] {
            std::fs::write(&file, body).unwrap();
            let store = ApprovalStore::with_file(file.clone());
            assert_eq!(store.len(), 0, "{body}");
            // The store still works and replaces the bad file on the next write.
            let root = PathBuf::from("/proj");
            store.insert_at(data(&root, &root, "s1", "printf ok"), now_ms()).unwrap();
            assert_eq!(ApprovalStore::with_file(file.clone()).len(), 1, "{body}");
        }
        cleanup(&file);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let file = temp_file("mode");
        let root = PathBuf::from("/proj");
        ApprovalStore::with_file(file.clone()).insert_at(data(&root, &root, "s1", "printf ok"), now_ms()).unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        cleanup(&file);
    }

    #[test]
    fn a_new_approval_supersedes_older_grants_for_the_same_stage() {
        let root = PathBuf::from("/proj");
        let store = ApprovalStore::new();
        let old = data(&root, &root, "s1", "printf old");
        let (old_token, _) = store.insert_at(old.clone(), 1_000).unwrap();
        let other = data(&root, &root, "s9", "printf other");
        let (other_token, _) = store.insert_at(other, 1_000).unwrap();
        let new = data(&root, &root, "s1", "printf new");
        let (new_token, _) = store.insert_at(new, 2_000).unwrap();
        // Approving one stage again with the SAME command keeps a whole-loop grant that covers it.
        let whole = {
            let mut d = data(&root, &root, "s1", "printf new");
            d.stages.get_mut("l1").unwrap().insert("s2".into(), command_hash("printf two"));
            d
        };
        let (whole_token, _) = store.insert_at(whole.clone(), 2_500).unwrap();
        let single = data(&root, &root, "s1", "printf new");
        store.insert_at(single, 2_600).unwrap();
        assert!(store.authorize_stage_at(&whole_token, &root, &root, "l1", "s2", "printf two", 3_000).is_ok(), "whole-loop grant kept");
        assert!(store.find_at(&whole, 3_000).is_some());
        assert!(store.authorize_stage_at(&old_token, &root, &root, "l1", "s1", "printf old", 3_000).is_err());
        assert!(store.find_at(&old, 3_000).is_none());
        assert!(store.authorize_stage_at(&new_token, &root, &root, "l1", "s1", "printf new", 3_000).is_ok());
        assert!(store.authorize_stage_at(&other_token, &root, &root, "l1", "s9", "printf other", 3_000).is_ok(), "unrelated stage kept");
        let elsewhere = data(Path::new("/p2"), Path::new("/p2"), "s1", "printf old");
        store.insert_at(elsewhere.clone(), 3_000).unwrap();
        assert!(store.find_at(&elsewhere, 3_000).is_some() && store.find_at(&data(&root, &root, "s1", "printf new"), 3_000).is_some());
    }

    #[test]
    fn revoke_reports_failure_and_empties_the_file_when_it_cannot_be_removed() {
        // A directory at the file path: remove_file fails, the atomic write over it fails too, so clear() errors.
        let file = temp_file("revoke-fail");
        std::fs::create_dir_all(&file).unwrap();
        let store = ApprovalStore::with_file(file.clone());
        assert!(store.clear().is_err());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn an_unsafe_approvals_file_loads_empty() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = PathBuf::from("/proj");
        let file = temp_file("unsafe");
        ApprovalStore::with_file(file.clone()).insert_at(data(&root, &root, "s1", "printf ok"), now_ms()).unwrap();
        assert_eq!(ApprovalStore::with_file(file.clone()).len(), 1);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(ApprovalStore::with_file(file.clone()).len(), 0, "group/other readable");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let real = file.with_file_name("real.json");
        std::fs::rename(&file, &real).unwrap();
        symlink(&real, &file).unwrap();
        assert_eq!(ApprovalStore::with_file(file.clone()).len(), 0, "symlink");
        cleanup(&file);
    }
}
