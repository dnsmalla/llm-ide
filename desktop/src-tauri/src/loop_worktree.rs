//! Factory Loop worktrees, host side (Software Factory Phase A).
//!
//! A factory run works in its own git worktree at `<project>/system/loop-worktrees/<run_id>` on branch
//! `factory/<run_id>`, cut from the chosen repo's `HEAD` (or a chosen base), with the work item at `.factory/TASK.md`.
//! Generalised from `self_heal_fix.rs` (prepare / worktree_of / staged_patch / diff / remove); Self-Heal is unchanged.
//!
//! The webview names a run id only, never a path. The host keeps an in-memory registry (run id -> RunInfo) so a run
//! keeps its own project after the user switches project; after a restart `resolve` rebuilds the entry from disk.
//! Every lookup re-checks ownership with git (the worktree's common git dir must be `<repo>/.git` for a repo inside
//! the project), so neither the registry nor a planted `.git` file can point a run at another repository. Git runs
//! with `git::base_args()` (hooks, fsmonitor, pager, external diff, credential helpers off) and the inherited GIT_*
//! overrides stripped (`loop_runner::git_command`).

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use sha2::{Digest, Sha256};

pub const TASK_REL: &str = ".factory/TASK.md";
const FACTORY_DIR: &str = ".factory";
/// Added to `<project>/.git/info/exclude` when the project root is itself a git repo, so the worktrees folder never
/// shows as untracked in the user's main tree. `.git/info/exclude` is untracked; `.gitignore` is never touched.
const EXCLUDE_LINE: &str = "system/loop-worktrees/";
const TASK_MAX: usize = 1024 * 1024;
const DIFF_TEXT_MAX: usize = 2 * 1024 * 1024;
const MAX_DIFF_FILES: usize = 1000;
const MAX_LISTED: usize = 500;
/// Never part of the diff, so never part of what Ship commits: the run's work item and reports. The top-level
/// `.factory` plus `.factory` at ANY depth (`pkg/.factory/x`), both case-insensitively (R-036 A8).
const EXCLUDES: &[&str] = &[":(exclude,icase).factory", ":(exclude,icase,glob)**/.factory/**"];

/// True when any path segment is `.factory`, in any case: the one predicate the status count and the Ship paths
/// filter use, so a nested report can never be counted, committed or scanned.
fn is_factory_rel(p: &str) -> bool {
    p.split('/').any(|seg| seg.eq_ignore_ascii_case(FACTORY_DIR))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub run_id: String,
    /// Canonical project root the run belongs to (not necessarily the active project).
    pub project: String,
    /// Canonical repo the worktree was cut from: the project root or a folder such as `<project>/code/<name>`.
    pub repo: String,
    /// Canonical `<project>/system/loop-worktrees/<run_id>`.
    pub worktree: String,
    pub branch: String,
    pub base_commit: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    /// The run's base commit versus the worktree (untracked files included, `.factory/` excluded), at most 2 MiB.
    pub text: String,
    pub truncated: bool,
    /// sha256 of the `--binary` patch the text was derived from.
    pub patch_id: String,
    /// Changed paths, at most `MAX_DIFF_FILES`.
    pub files: Vec<String>,
}

static RUNS: Mutex<BTreeMap<String, RunInfo>> = Mutex::new(BTreeMap::new());

fn runs() -> MutexGuard<'static, BTreeMap<String, RunInfo>> {
    RUNS.lock().unwrap_or_else(|p| p.into_inner())
}

/// One lock per run id: `diff_in` stages with `git add -A`, and two stagings of one worktree at once fail with
/// `index.lock`. A second caller waits for the first instead of failing.
static DIFF_LOCKS: Mutex<BTreeMap<String, Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());

fn diff_lock(run_id: &str) -> Arc<Mutex<()>> {
    let mut map = DIFF_LOCKS.lock().unwrap_or_else(|p| p.into_inner());
    map.entry(run_id.to_string()).or_default().clone()
}

fn register(info: RunInfo) {
    runs().insert(info.run_id.clone(), info);
}

fn registered(run_id: &str) -> Option<RunInfo> {
    runs().get(run_id).cloned()
}

fn unregister(run_id: &str) {
    runs().remove(run_id);
}

/// `^[A-Za-z0-9_-]{1,64}$`: the id becomes a folder and a branch name, so nothing else is accepted.
pub fn valid_run_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A base the user chose: a branch, tag or sha. Never an option (`-...`) and never a range (`..`).
fn valid_base(base: &str) -> bool {
    !base.is_empty()
        && base.len() <= 200
        && !base.starts_with('-')
        && !base.contains("..")
        && base.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn git(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = crate::loop_runner::git_command()
        .args(crate::git::base_args())
        .args(args)
        .current_dir(crate::fsutil::plain_path(dir))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {} failed: {}", args.first().copied().unwrap_or(""), err.lines().next().unwrap_or("unknown error")));
    }
    Ok(out.stdout)
}

fn worktrees_dir(project: &Path) -> PathBuf {
    project.join("system").join("loop-worktrees")
}

/// The repo a run is cut from: inside the project (checked BEFORE any git call), a main checkout (`.git` is a folder,
/// so a linked worktree is refused), and the top of its repository. Canonical.
fn checked_repo(project: &Path, repo: &Path) -> Result<PathBuf, String> {
    let repo = repo.canonicalize().map_err(|e| format!("cannot resolve the repo folder: {e}"))?;
    if !repo.starts_with(project) {
        return Err("the repo must be inside the project".into());
    }
    if !repo.join(".git").is_dir() {
        return Err("the repo must be a main git checkout (its .git is a folder)".into());
    }
    let top = PathBuf::from(text(git(&repo, &["rev-parse", "--show-toplevel"])?));
    if top.canonicalize().ok().as_deref() != Some(repo.as_path()) {
        return Err("the repo folder is not the top of its git repository".into());
    }
    Ok(repo)
}

fn base_commit_of(repo: &Path, base: Option<&str>) -> Result<String, String> {
    let rev = match base {
        None => "HEAD".to_string(),
        Some(b) if valid_base(b) => b.to_string(),
        Some(_) => return Err("invalid base".into()),
    };
    let out = git(repo, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")])
        .map_err(|_| format!("{rev} is not a commit in this repo"))?;
    Ok(text(out))
}

/// Appends `EXCLUDE_LINE` to `<project>/.git/info/exclude` once, when the project root is a git repo. Appends only:
/// the user's own lines are never rewritten (a non-UTF-8 file is kept byte for byte).
fn exclude_worktrees(project: &Path) -> Result<(), String> {
    let git_dir = project.join(".git");
    if !git_dir.is_dir() {
        return Ok(());
    }
    let info_dir = git_dir.join("info");
    let path = info_dir.join("exclude");
    let current = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("cannot read .git/info/exclude: {e}")),
    };
    if String::from_utf8_lossy(&current).lines().any(|l| l.trim() == EXCLUDE_LINE) {
        return Ok(());
    }
    std::fs::create_dir_all(&info_dir).map_err(|e| format!("cannot update .git/info/exclude: {e}"))?;
    let sep = if !current.is_empty() && !current.ends_with(b"\n") { "\n" } else { "" };
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)
        .map_err(|e| format!("cannot update .git/info/exclude: {e}"))?;
    f.write_all(format!("{sep}{EXCLUDE_LINE}\n").as_bytes()).map_err(|e| format!("cannot update .git/info/exclude: {e}"))
}

/// Writes the work item into the fresh worktree without following a link the repo itself committed at `.factory`
/// or `.factory/TASK.md`: a symlink there would redirect the write outside the worktree. `symlink_metadata` does not
/// follow links, and `create_new` fails on any existing path, including a dangling symlink.
fn write_task_file(wt: &Path, task: &str) -> Result<(), String> {
    const FOREIGN: &str = "the repository ships its own .factory/ entry; refusing to write TASK.md through it";
    let dir = wt.join(FACTORY_DIR);
    // A fresh worktree has no `.factory` at all: ANY entry (folder, file or link, in any letter case, which a
    // case-insensitive checkout folds onto this name) came from the repo and is refused.
    match std::fs::symlink_metadata(&dir) {
        Ok(_) => return Err(FOREIGN.into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&dir).map_err(|e| format!("cannot write {TASK_REL}: {e}"))?;
        }
        Err(e) => return Err(format!("cannot write {TASK_REL}: {e}")),
    }
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(wt.join(TASK_REL)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            FOREIGN.to_string()
        } else {
            format!("cannot write {TASK_REL}: {e}")
        }
    })?;
    file.write_all(task.as_bytes()).map_err(|e| format!("cannot write {TASK_REL}: {e}"))
}

/// A repo that commits anything named `.factory` (any case; a report, or a symlink such as a dangling `PLAN.md`) could
/// pre-seed a gate verdict or redirect the agent's scoped Write outside the worktree. Checked on the base commit
/// BEFORE any worktree or branch exists, so a refusal leaves no trace.
fn refuse_tracked_factory_entries(repo: &Path, base_commit: &str) -> Result<(), String> {
    // Top-level names only, compared case-insensitively: on a case-insensitive filesystem `.FACTORY/` checks out as
    // `.factory/`, so a case-sensitive pathspec would miss it.
    let top = git(repo, &["ls-tree", "--name-only", "-z", base_commit])?;
    let ships = top.split(|b| *b == 0).any(|name| String::from_utf8_lossy(name).eq_ignore_ascii_case(FACTORY_DIR));
    if ships {
        return Err("the repository ships its own .factory/ entry; refusing to prepare a factory worktree".into());
    }
    Ok(())
}

pub fn prepare_in(project: &Path, repo: &Path, run_id: &str, base: Option<&str>, task: &str) -> Result<RunInfo, String> {
    // Every check that needs no git and no folder comes first: a refused call leaves no trace.
    if !valid_run_id(run_id) {
        return Err("invalid run id".into());
    }
    if task.trim().is_empty() || task.len() > TASK_MAX {
        return Err("the work item is empty or larger than 1 MiB".into());
    }
    let project = crate::fs_ops::checked_root(project).map_err(|e| e.message)?;
    let repo = checked_repo(&project, repo)?;
    let base_commit = base_commit_of(&repo, base)?;
    let dir = worktrees_dir(&project);
    let wt = dir.join(run_id);
    if wt.exists() {
        return Err("that run already has a worktree".into());
    }
    refuse_tracked_factory_entries(&repo, &base_commit)?;
    exclude_worktrees(&project)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create the Loop worktree folder: {e}"))?;
    if dir.canonicalize().ok().as_deref() != Some(dir.as_path()) {
        return Err("system/loop-worktrees must be a plain folder inside the project, not a link".into());
    }
    let branch = format!("factory/{run_id}");
    let wt_s = lossy(&wt);
    git(&repo, &["worktree", "add", "--quiet", "-b", &branch, &wt_s, &base_commit])?;
    let info = RunInfo { run_id: run_id.to_string(), project: lossy(&project), repo: lossy(&repo), worktree: wt_s, branch, base_commit };
    if let Err(e) = write_task_file(&wt, task) {
        let _ = remove_in(&info);
        return Err(e);
    }
    register(info.clone());
    Ok(info)
}

/// The commit a run started from: the oldest entry of its branch's reflog ("branch: Created from <base>"), so a later
/// Ship commit does not move it. Falls back to the worktree's HEAD when reflogs are off.
fn base_of(wt: &Path, branch: &str) -> String {
    let log = git(wt, &["reflog", "show", "--format=%H", &format!("refs/heads/{branch}")]).map(text).unwrap_or_default();
    match log.lines().last().map(str::trim) {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => git(wt, &["rev-parse", "HEAD"]).map(text).unwrap_or_default(),
    }
}

/// Rebuilds a run from disk (the registry's fallback). The worktree must be the plain folder
/// `<project>/system/loop-worktrees/<run_id>`, and its common git dir must be `<repo>/.git` for a repo inside the
/// project (Self-Heal's `worktree_of` check, generalised).
pub fn resolve_in(project: &Path, run_id: &str) -> Result<RunInfo, String> {
    if !valid_run_id(run_id) {
        return Err("invalid run id".into());
    }
    let project = crate::fs_ops::checked_root(project).map_err(|e| e.message)?;
    let expected = worktrees_dir(&project).join(run_id);
    if !expected.join(".git").is_file() {
        return Err("that run's worktree no longer exists".into());
    }
    let wt = expected.canonicalize().map_err(|e| format!("cannot resolve the run's worktree: {e}"))?;
    if wt != expected {
        return Err("the run's worktree folder must not be a link".into());
    }
    let common = PathBuf::from(text(git(&wt, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?));
    let common = common.canonicalize().map_err(|e| format!("cannot resolve the worktree's repository: {e}"))?;
    let foreign = || "that worktree does not belong to a repo in this project".to_string();
    let repo = match (common.file_name(), common.parent()) {
        (Some(name), Some(parent)) if name == OsStr::new(".git") => parent.to_path_buf(),
        _ => return Err(foreign()),
    };
    if !repo.starts_with(&project) || !repo.join(".git").is_dir() {
        return Err(foreign());
    }
    let branch = format!("factory/{run_id}");
    let base_commit = base_of(&wt, &branch);
    Ok(RunInfo { run_id: run_id.to_string(), project: lossy(&project), repo: lossy(&repo), worktree: lossy(&wt), branch, base_commit })
}

/// Re-validates a registry entry against git. The repo and worktree must still be what the entry says.
fn check(info: &RunInfo) -> Result<RunInfo, String> {
    let fresh = resolve_in(Path::new(&info.project), &info.run_id)?;
    if fresh.repo != info.repo || fresh.worktree != info.worktree {
        return Err("that worktree does not belong to the run's repo".into());
    }
    Ok(RunInfo { base_commit: info.base_commit.clone(), ..fresh })
}

/// The run, from the registry (whatever project is active now), else from the active project's worktrees folder.
pub fn resolve(run_id: &str) -> Result<RunInfo, String> {
    if !valid_run_id(run_id) {
        return Err("invalid run id".into());
    }
    if let Some(info) = registered(run_id) {
        return check(&info);
    }
    let project = crate::project::active_root().ok_or_else(|| "open a project first".to_string())?;
    let info = resolve_in(&project, run_id)?;
    register(info.clone());
    Ok(info)
}

fn pathspec() -> Vec<&'static str> {
    let mut v = vec!["--", "."];
    v.extend_from_slice(EXCLUDES);
    v
}

/// The `git add` args that stage a run's worktree (`.factory/` excluded). The shared fixture
/// `schema/factory/staged-patch.json` pins these and `staged_diff_args`; the Ship route mirrors them to
/// compute the same patch id it then verifies.
fn staged_add_args() -> Vec<String> {
    let mut v = vec!["add".to_string(), "-A".to_string()];
    v.extend(pathspec().into_iter().map(str::to_string));
    v
}

/// The `git diff` args that turn the staged index into the patch whose sha256 is the run's patch id.
fn staged_diff_args(binary: bool, base: &str) -> Vec<String> {
    let mut v: Vec<String> = vec!["diff".into(), "--cached".into(), "--no-ext-diff".into(), "--no-textconv".into()];
    if binary {
        v.push("--binary".into());
    }
    v.push(base.to_string());
    v.extend(pathspec().into_iter().map(str::to_string));
    v
}

fn git_owned(dir: &Path, args: &[String]) -> Result<Vec<u8>, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(dir, &refs)
}

/// Stages everything outside `.factory/` in the worktree's own index and returns the diff against HEAD.
fn staged_patch(wt: &Path, base: &str, binary: bool) -> Result<Vec<u8>, String> {
    git_owned(wt, &staged_add_args())?;
    git_owned(wt, &staged_diff_args(binary, base))
}

/// The commit the diff is taken against: the run's base (equal to HEAD until Ship commits, so Ship stays reachable
/// after a local commit). Anything that is not a plain hex object name falls back to HEAD.
fn diff_base(info: &RunInfo) -> &str {
    let b = info.base_commit.as_str();
    if !b.is_empty() && b.len() <= 64 && b.bytes().all(|c| c.is_ascii_hexdigit()) {
        b
    } else {
        "HEAD"
    }
}

/// Stages once; the shown text, the patch id and the file list come from that one index state. Serialised per run.
pub fn diff_in(info: &RunInfo) -> Result<WorktreeDiff, String> {
    let lock = diff_lock(&info.run_id);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    let wt = PathBuf::from(&info.worktree);
    let base = diff_base(info);
    let patch = staged_patch(&wt, base, true)?;
    let mut args = vec!["diff", "--cached", "--no-ext-diff", "--no-textconv", base];
    args.extend(pathspec());
    let full = String::from_utf8_lossy(&git(&wt, &args)?).into_owned();
    let truncated = full.len() > DIFF_TEXT_MAX;
    let text_out = if truncated {
        let mut cut = DIFF_TEXT_MAX;
        while !full.is_char_boundary(cut) {
            cut -= 1;
        }
        full[..cut].to_string()
    } else {
        full
    };
    let mut names = vec!["diff", "--cached", "--name-only", "--no-ext-diff", base];
    names.extend(pathspec());
    let listed = git(&wt, &names)?;
    let files = String::from_utf8_lossy(&listed).lines().filter(|l| !l.is_empty()).map(|l| l.to_string()).take(MAX_DIFF_FILES).collect();
    Ok(WorktreeDiff { text: text_out, truncated, patch_id: sha256_hex(&patch), files })
}

/// True when `rel` is a plain path under the literal `.factory/` folder (no absolute path, no `..`, no root/prefix).
fn is_factory_output_rel(rel: &str) -> bool {
    if !rel.starts_with(".factory/") || rel.contains('\\') {
        return false;
    }
    Path::new(rel)
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Removes one report at `<work>/.factory/<...>` before a stage runs, so a stale verdict from an earlier run can never
/// pass a gate. Run-scoped by the caller. A missing file is fine. Only a file or a symlink is removed (never a folder,
/// never through a link: `symlink_metadata` judges the entry itself, and a `.factory` that is a link is refused).
pub fn clear_factory_output_in(work: &Path, rel: &str) -> Result<(), String> {
    if !is_factory_output_rel(rel) {
        return Err("only a .factory/ report path can be cleared".into());
    }
    let work = work.canonicalize().map_err(|e| format!("cannot resolve the worktree: {e}"))?;
    let factory = work.join(FACTORY_DIR);
    match std::fs::symlink_metadata(&factory) {
        Ok(m) if m.file_type().is_symlink() => return Err("the worktree's .factory/ is a link; refusing to clear a report".into()),
        Ok(m) if !m.is_dir() => return Err("the worktree's .factory/ is not a folder; refusing to clear a report".into()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("cannot read the worktree's .factory/: {e}")),
    }
    let target = work.join(rel);
    match std::fs::symlink_metadata(&target) {
        Ok(m) if m.is_dir() => return Err(format!("{rel} is a folder; refusing to clear it")),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("cannot read {rel}: {e}")),
    }
    let parent = target.parent().ok_or_else(|| format!("{rel} has no parent folder"))?;
    let real_parent = parent.canonicalize().map_err(|e| format!("cannot resolve {rel}: {e}"))?;
    let real_factory = factory.canonicalize().map_err(|e| format!("cannot resolve .factory/: {e}"))?;
    if !real_parent.starts_with(&real_factory) {
        return Err(format!("{rel} is not inside .factory/; refusing to clear it"));
    }
    std::fs::remove_file(&target).map_err(|e| format!("cannot clear {rel}: {e}"))
}

/// `loop_clear_factory_output` without Tauri: the legacy work root, or the run's worktree when `run_id` is given.
pub(crate) fn clear_factory_output_for(run_id: Option<&str>, rel: &str) -> Result<(), String> {
    let (_, work) = crate::loop_runner::root_for(run_id)?;
    clear_factory_output_in(&work, rel)
}

#[tauri::command]
pub async fn loop_clear_factory_output(path: String, run_id: Option<String>) -> Result<(), String> {
    blocking(move || clear_factory_output_for(run_id.as_deref(), &path)).await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    /// Uncommitted changes in the worktree (`.factory/` excluded): what Discard deletes without a commit.
    pub changed_files: usize,
    /// Commits on the Factory branch that are not on `origin/<branch>` (nor in the base when there is no remote).
    pub local_commits: usize,
    /// HEAD is already contained in `origin/<branch>` (a successful Ship pushed it).
    pub pushed: bool,
}

/// The numbers behind Discard's one honest confirm. `changedFiles` comes from `git status` (uncommitted work),
/// `localCommits` from the branch against its remote-tracking ref (or the run's base when nothing was pushed), and
/// `pushed` is true only when HEAD is reachable from `origin/<branch>`. Read-only apart from staging the index.
pub fn status_in(info: &RunInfo) -> Result<WorktreeStatus, String> {
    let wt = PathBuf::from(&info.worktree);
    let head = text(git(&wt, &["rev-parse", "HEAD"])?);
    let base = diff_base(info);
    let changed = crate::loop_runner::changed_paths_in(&wt)?
        .into_iter()
        .filter(|p| !is_factory_rel(p.trim_end_matches('/')))
        .count();
    let remote_ref = format!("refs/remotes/origin/{}", info.branch);
    let remote = git(&wt, &["rev-parse", "--verify", "--quiet", &remote_ref]).ok().map(|b| text(b)).filter(|s| !s.is_empty());
    let range = match &remote {
        Some(r) => format!("{r}..HEAD"),
        None => format!("{base}..HEAD"),
    };
    let local_commits = text(git(&wt, &["rev-list", "--count", &range])?).parse::<usize>().unwrap_or(0);
    let pushed = remote.as_ref().is_some_and(|r| {
        git(&wt, &["merge-base", "--is-ancestor", &head, r]).is_ok()
    });
    Ok(WorktreeStatus { changed_files: changed, local_commits, pushed })
}

#[tauri::command]
pub async fn loop_worktree_status(run_id: String) -> Result<WorktreeStatus, String> {
    blocking(move || status_in(&resolve(&run_id)?)).await
}

/// Removes the run's worktree (dirty or not) and its branch, and forgets the run. Harmless when already gone.
/// Only ever removes `<project>/system/loop-worktrees/<run_id>`.
pub fn remove_in(info: &RunInfo) -> Result<(), String> {
    if !valid_run_id(&info.run_id) {
        return Err("invalid run id".into());
    }
    let wt = worktrees_dir(Path::new(&info.project)).join(&info.run_id);
    if PathBuf::from(&info.worktree) != wt {
        return Err("that is not this run's worktree folder".into());
    }
    let repo = PathBuf::from(&info.repo);
    if wt.exists() {
        git(&repo, &["worktree", "remove", "--force", &lossy(&wt)])?;
    } else {
        let _ = git(&repo, &["worktree", "prune"]);
    }
    let _ = git(&repo, &["branch", "-D", &format!("factory/{}", info.run_id)]);
    unregister(&info.run_id);
    Ok(())
}

/// Every factory worktree of the project that still passes the ownership check, sorted by run id (oldest first,
/// since ids start with a timestamp). Folders that fail the check are skipped, not reported.
pub fn list_in(project: &Path) -> Result<Vec<RunInfo>, String> {
    let project = crate::fs_ops::checked_root(project).map_err(|e| e.message)?;
    let entries = match std::fs::read_dir(worktrees_dir(&project)) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("cannot read system/loop-worktrees: {e}")),
    };
    let mut names: Vec<String> = entries.flatten().filter_map(|e| e.file_name().to_str().map(str::to_string)).filter(|n| valid_run_id(n)).collect();
    names.sort();
    names.truncate(MAX_LISTED);
    Ok(names
        .iter()
        .filter_map(|n| {
            let fresh = resolve_in(&project, n).ok()?;
            Some(match registered(n) {
                Some(r) if r.worktree == fresh.worktree => RunInfo { base_commit: r.base_commit, ..fresh },
                _ => fresh,
            })
        })
        .collect())
}

fn active_project() -> Result<PathBuf, String> {
    let root = crate::project::active_root().ok_or_else(|| "open a project first".to_string())?;
    crate::fs_ops::checked_root(&root).map_err(|e| e.message)
}

#[tauri::command]
pub async fn loop_worktree_prepare(repo_rel: String, run_id: String, base: Option<String>, task: String) -> Result<RunInfo, String> {
    blocking(move || {
        let project = active_project()?;
        let repo = crate::fs_ops::resolve_existing(&project, &repo_rel).map_err(|e| e.message)?;
        if !repo.join(".git").exists() {
            return Err("that folder is not a git repository".into());
        }
        prepare_in(&project, &repo, &run_id, base.as_deref(), &task)
    })
    .await
}

#[tauri::command]
pub async fn loop_worktree_diff(run_id: String) -> Result<WorktreeDiff, String> {
    blocking(move || diff_in(&resolve(&run_id)?)).await
}

#[tauri::command]
pub async fn loop_worktree_remove(run_id: String) -> Result<(), String> {
    blocking(move || remove_in(&resolve(&run_id)?)).await
}

#[tauri::command]
pub async fn loop_worktree_list() -> Result<Vec<RunInfo>, String> {
    blocking(|| list_in(&active_project()?)).await
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("Loop worktree task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh_git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args)
            .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t")
            .output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// `git init` in `dir` with one commit holding `a.txt` = "committed\n".
    fn init_repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        sh_git(dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "committed\n").unwrap();
        sh_git(dir, &["add", "a.txt"]);
        sh_git(dir, &["commit", "-q", "-m", "init"]);
    }

    fn temp(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("llmide-lwt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    /// A project whose root is itself the git repo. Canonical.
    fn project_repo(name: &str) -> PathBuf {
        let root = temp(name);
        init_repo(&root);
        root.canonicalize().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn prepare_creates_branch_worktree_and_task_file() {
        let p = project_repo("prepare");
        let info = prepare_in(&p, &p, "r1", None, "# Fix the login bug\n").unwrap();
        let wt = PathBuf::from(&info.worktree);
        let head = sh_git(&p, &["rev-parse", "HEAD"]).trim().to_string();
        assert_eq!(wt, p.join("system/loop-worktrees/r1"));
        assert_eq!(info.run_id, "r1");
        assert_eq!(info.project, lossy(&p));
        assert_eq!(info.repo, lossy(&p));
        assert_eq!(info.branch, "factory/r1");
        assert_eq!(info.base_commit, head);
        assert_eq!(sh_git(&p, &["rev-parse", "--verify", "refs/heads/factory/r1"]).trim(), head, "the branch exists at the base");
        assert_eq!(std::fs::read_to_string(wt.join(TASK_REL)).unwrap(), "# Fix the login bug\n");
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "committed\n");
        assert_eq!(registered("r1"), Some(info.clone()), "prepare registers the run");
        assert!(prepare_in(&p, &p, "r1", None, "again").unwrap_err().contains("already has a worktree"));
        assert!(prepare_in(&p, &p, "r1x", Some("-x"), "task").unwrap_err().contains("invalid base"));
        assert!(prepare_in(&p, &p, "r1y", Some("no-such-branch"), "task").is_err());
        let explicit = prepare_in(&p, &p, "r1z", Some(&head), "task").unwrap();
        assert_eq!(explicit.base_commit, head);
        remove_in(&explicit).unwrap();
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_ignores_dirty_main_tree() {
        let p = project_repo("dirty");
        std::fs::write(p.join("a.txt"), "user edit\n").unwrap();
        std::fs::write(p.join("user.txt"), "mine\n").unwrap();
        let before = sh_git(&p, &["status", "--porcelain"]);
        let info = prepare_in(&p, &p, "dirty1", None, "task").unwrap();
        let wt = PathBuf::from(&info.worktree);
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "committed\n", "cut from HEAD, not from the dirty tree");
        assert!(!wt.join("user.txt").exists());
        assert_eq!(sh_git(&p, &["status", "--porcelain"]), before, "the main tree's status is unchanged");
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "user edit\n");
        // A detached HEAD works too: the worktree starts from the commit HEAD points at.
        sh_git(&p, &["switch", "-q", "--detach"]);
        let head = sh_git(&p, &["rev-parse", "HEAD"]).trim().to_string();
        let detached = prepare_in(&p, &p, "dirty2", None, "task").unwrap();
        assert_eq!(detached.base_commit, head);
        assert_eq!(sh_git(&p, &["status", "--porcelain"]), before);
        remove_in(&detached).unwrap();
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_rejects_bad_run_ids() {
        let p = project_repo("badid");
        let long = "a".repeat(65);
        for bad in ["../x", "", long.as_str(), "a/b", "a b", "r.lock"] {
            assert!(prepare_in(&p, &p, bad, None, "task").unwrap_err().contains("invalid run id"), "{bad:?}");
        }
        assert!(prepare_in(&p, &p, "okid", None, "  \n").is_err(), "an empty work item is refused");
        assert!(!p.join("system").exists(), "a refused call creates no folder");
        assert_eq!(sh_git(&p, &["branch", "--list", "factory/*"]).trim(), "", "and no branch");
        assert!(valid_run_id(&"a".repeat(64)) && valid_run_id("20261109-101500-a1b2c3") && valid_run_id("R_1-x"));
        let _ = std::fs::remove_dir_all(&p);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_refuses_repo_committed_factory_symlink() {
        // Case 1: `.factory` itself is committed as a symlink to a folder outside the repo.
        let p = project_repo("symlink-dir");
        let outside = temp("symlink-dir-outside");
        std::fs::create_dir_all(&outside).unwrap();
        let outside = outside.canonicalize().unwrap();
        std::os::unix::fs::symlink(&outside, p.join(".factory")).unwrap();
        sh_git(&p, &["add", ".factory"]);
        sh_git(&p, &["commit", "-q", "-m", "link"]);
        let err = prepare_in(&p, &p, "sym1", None, "task").unwrap_err();
        assert!(err.contains("refusing to prepare a factory worktree"), "{err}");
        assert!(!outside.join("TASK.md").exists(), "nothing written outside the worktree");
        assert!(!p.join("system/loop-worktrees/sym1").exists(), "the refused worktree is removed");
        assert_eq!(sh_git(&p, &["branch", "--list", "factory/*"]).trim(), "", "and its branch");
        let _ = std::fs::remove_dir_all(&p);
        let _ = std::fs::remove_dir_all(&outside);

        // Case 2: `.factory/TASK.md` is committed as a symlink to a file outside the repo.
        let q = project_repo("symlink-file");
        let outside_file = temp("symlink-file-outside");
        std::fs::create_dir_all(&outside_file).unwrap();
        let outside_file = outside_file.canonicalize().unwrap().join("keep.txt");
        std::fs::write(&outside_file, "keep\n").unwrap();
        std::fs::create_dir_all(q.join(".factory")).unwrap();
        std::os::unix::fs::symlink(&outside_file, q.join(TASK_REL)).unwrap();
        sh_git(&q, &["add", "-f", TASK_REL]);
        sh_git(&q, &["commit", "-q", "-m", "link"]);
        let err = prepare_in(&q, &q, "sym2", None, "task").unwrap_err();
        assert!(err.contains("refusing to prepare a factory worktree"), "{err}");
        assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "keep\n", "the outside file is untouched");
        assert!(!q.join("system/loop-worktrees/sym2").exists(), "the refused worktree is removed");
        assert_eq!(sh_git(&q, &["branch", "--list", "factory/*"]).trim(), "", "and its branch");
        let _ = std::fs::remove_dir_all(&q);
        let _ = std::fs::remove_dir_all(outside_file.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn prepare_excludes_worktree_dir_when_project_is_repo() {
        let p = project_repo("exclude");
        let one = prepare_in(&p, &p, "ex1", None, "task").unwrap();
        let two = prepare_in(&p, &p, "ex2", None, "task").unwrap();
        let exclude = std::fs::read_to_string(p.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| l.trim() == EXCLUDE_LINE).count(), 1, "added once: {exclude}");
        assert_eq!(sh_git(&p, &["status", "--porcelain"]).trim(), "", "the worktrees never show as untracked");
        remove_in(&one).unwrap();
        remove_in(&two).unwrap();
        let _ = std::fs::remove_dir_all(&p);
        // Split layout: the repo is code/app and the worktrees sit outside it, so its exclude file is not touched.
        let q = temp("exclude-split");
        init_repo(&q.join("code/app"));
        let q = q.canonicalize().unwrap();
        let app = q.join("code/app");
        let before = std::fs::read_to_string(app.join(".git/info/exclude")).unwrap_or_default();
        let info = prepare_in(&q, &app, "ex3", None, "task").unwrap();
        assert_eq!(info.repo, lossy(&app));
        assert_eq!(PathBuf::from(&info.worktree), q.join("system/loop-worktrees/ex3"));
        assert_eq!(std::fs::read_to_string(app.join(".git/info/exclude")).unwrap_or_default(), before);
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&q);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_worktree_of_another_repo() {
        let p = project_repo("owner");
        let other = project_repo("owner-other");
        let wt = p.join("system/loop-worktrees/foreign1");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        sh_git(&other, &["worktree", "add", "-q", "-b", "factory/foreign1", wt.to_str().unwrap()]);
        let err = resolve_in(&p, "foreign1").unwrap_err();
        assert!(err.contains("does not belong"), "{err}");
        // A registry entry that claims this project's repo is re-checked against git, not trusted.
        let forged = RunInfo {
            run_id: "foreign1".into(),
            project: lossy(&p),
            repo: lossy(&p),
            worktree: lossy(&wt),
            branch: "factory/foreign1".into(),
            base_commit: String::new(),
        };
        assert!(check(&forged).unwrap_err().contains("does not belong"));
        // A repo outside the project is refused before any git call or folder.
        assert!(prepare_in(&p, &other, "foreign2", None, "task").unwrap_err().contains("inside the project"));
        assert!(!p.join("system/loop-worktrees/foreign2").exists());
        assert!(resolve_in(&p, "../x").unwrap_err().contains("invalid run id"));
        sh_git(&other, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
        let _ = std::fs::remove_dir_all(&p);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_in_and_list_in_rebuild_a_run_after_restart() {
        let p = project_repo("restart");
        let info = prepare_in(&p, &p, "restart1", None, "task").unwrap();
        unregister("restart1"); // as after an app restart
        assert_eq!(resolve_in(&p, "restart1").unwrap(), info);
        // A commit in the worktree (Ship) does not move the recorded base.
        let wt = PathBuf::from(&info.worktree);
        std::fs::write(wt.join("b.txt"), "x\n").unwrap();
        sh_git(&wt, &["add", "b.txt"]);
        sh_git(&wt, &["commit", "-q", "-m", "ship"]);
        assert_eq!(resolve_in(&p, "restart1").unwrap().base_commit, info.base_commit);
        let listed = list_in(&p).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].run_id, "restart1");
        assert_eq!(listed[0].worktree, info.worktree);
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
    }

    #[cfg(unix)]
    #[test]
    fn diff_excludes_factory_dir_and_includes_untracked() {
        let p = project_repo("diff");
        let info = prepare_in(&p, &p, "diff1", None, "secret task text").unwrap();
        let wt = PathBuf::from(&info.worktree);
        std::fs::write(wt.join("a.txt"), "changed\n").unwrap();
        std::fs::write(wt.join("new.txt"), "brand new\n").unwrap();
        std::fs::write(wt.join(".factory/READINESS.md"), "Verdict: ready\n").unwrap();
        let d = diff_in(&info).unwrap();
        assert!(d.text.contains("+changed") && d.text.contains("+brand new"), "{}", d.text);
        assert!(!d.text.contains(".factory") && !d.text.contains("Verdict") && !d.text.contains("secret task text"), "{}", d.text);
        assert_eq!(d.files, vec!["a.txt".to_string(), "new.txt".to_string()]);
        assert!(!d.truncated);
        assert_eq!(d.patch_id.len(), 64);
        assert_eq!(diff_in(&info).unwrap().patch_id, d.patch_id, "same tree, same id");
        std::fs::write(wt.join("a.txt"), "changed again\n").unwrap();
        assert_ne!(diff_in(&info).unwrap().patch_id, d.patch_id);
        assert_eq!(sh_git(&p, &["status", "--porcelain"]).trim(), "", "diffing never touches the main tree");
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
    }

    #[cfg(unix)]
    #[test]
    fn status_reports_changed_files_local_commits_and_pushed() {
        let p = project_repo("status");
        let remote = temp("status-remote");
        std::fs::create_dir_all(&remote).unwrap();
        sh_git(&remote, &["init", "-q", "--bare"]);
        sh_git(&p, &["remote", "add", "origin", remote.to_str().unwrap()]);
        let info = prepare_in(&p, &p, "st1", None, "task").unwrap();
        let wt = PathBuf::from(&info.worktree);
        assert_eq!(status_in(&info).unwrap(), WorktreeStatus { changed_files: 0, local_commits: 0, pushed: false });
        std::fs::write(wt.join("one.txt"), "1\n").unwrap();
        std::fs::write(wt.join("two.txt"), "2\n").unwrap();
        assert_eq!(status_in(&info).unwrap(), WorktreeStatus { changed_files: 2, local_commits: 0, pushed: false });
        sh_git(&wt, &["add", "one.txt", "two.txt"]);
        sh_git(&wt, &["commit", "-q", "-m", "work"]);
        assert_eq!(status_in(&info).unwrap(), WorktreeStatus { changed_files: 0, local_commits: 1, pushed: false }, "a commit that was never pushed");
        sh_git(&wt, &["push", "-q", "-u", "origin", "factory/st1"]);
        assert_eq!(status_in(&info).unwrap(), WorktreeStatus { changed_files: 0, local_commits: 0, pushed: true });
        std::fs::write(wt.join("three.txt"), "3\n").unwrap();
        assert_eq!(status_in(&info).unwrap(), WorktreeStatus { changed_files: 1, local_commits: 0, pushed: true }, "uncommitted work after a push");
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
        let _ = std::fs::remove_dir_all(&remote);
    }

    #[cfg(unix)]
    #[test]
    fn remove_deletes_worktree_and_branch() {
        let p = project_repo("remove");
        let info = prepare_in(&p, &p, "rm1", None, "task").unwrap();
        std::fs::write(PathBuf::from(&info.worktree).join("new.txt"), "dirty\n").unwrap();
        remove_in(&info).unwrap();
        assert!(!Path::new(&info.worktree).exists(), "a dirty worktree is removed too");
        assert_eq!(sh_git(&p, &["branch", "--list", "factory/*"]).trim(), "");
        assert!(registered("rm1").is_none());
        assert!(resolve_in(&p, "rm1").unwrap_err().contains("no longer exists"));
        remove_in(&info).unwrap(); // harmless when already gone
        assert!(list_in(&p).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&p);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_refuses_repo_that_tracks_factory_entries() {
        // A regular committed report would pre-seed a gate verdict.
        let p = project_repo("tracked-factory");
        std::fs::create_dir_all(p.join(".factory")).unwrap();
        std::fs::write(p.join(".factory/REVIEW.md"), "Verdict: approve\n").unwrap();
        sh_git(&p, &["add", "-f", ".factory/REVIEW.md"]);
        sh_git(&p, &["commit", "-q", "-m", "report"]);
        let err = prepare_in(&p, &p, "trk1", None, "task").unwrap_err();
        assert!(err.contains("ships its own .factory/ entry") && err.contains("refusing to prepare a factory worktree"), "{err}");
        assert!(!p.join("system/loop-worktrees/trk1").exists(), "no worktree");
        assert_eq!(sh_git(&p, &["branch", "--list", "factory/*"]).trim(), "", "no branch");
        assert!(registered("trk1").is_none());
        let _ = std::fs::remove_dir_all(&p);

        // A dangling symlink report would let the agent's Write land outside the worktree.
        let q = project_repo("tracked-dangling");
        std::fs::create_dir_all(q.join(".factory")).unwrap();
        std::os::unix::fs::symlink("../../outside.md", q.join(".factory/PLAN.md")).unwrap();
        sh_git(&q, &["add", "-f", ".factory/PLAN.md"]);
        sh_git(&q, &["commit", "-q", "-m", "dangling"]);
        let err = prepare_in(&q, &q, "trk2", None, "task").unwrap_err();
        assert!(err.contains("refusing to prepare a factory worktree"), "{err}");
        assert!(!q.join("system/loop-worktrees/trk2").exists(), "no worktree");
        assert_eq!(sh_git(&q, &["branch", "--list", "factory/*"]).trim(), "", "no branch");
        let _ = std::fs::remove_dir_all(&q);
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_diffs_of_one_run_both_succeed() {
        let p = project_repo("concurrent");
        let info = prepare_in(&p, &p, "con1", None, "task").unwrap();
        std::fs::write(PathBuf::from(&info.worktree).join("new.txt"), "x\n").unwrap();
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let i = info.clone();
                std::thread::spawn(move || diff_in(&i))
            })
            .collect();
        for h in handles {
            let d = h.join().unwrap().expect("a concurrent diff must wait, not fail with index.lock");
            assert_eq!(d.files, vec!["new.txt".to_string()]);
        }
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
    }

    #[cfg(unix)]
    #[test]
    fn diff_still_lists_files_after_a_local_commit() {
        let p = project_repo("after-commit");
        let info = prepare_in(&p, &p, "aft1", None, "task").unwrap();
        let wt = PathBuf::from(&info.worktree);
        std::fs::write(wt.join("b.txt"), "shipped\n").unwrap();
        let before = diff_in(&info).unwrap();
        sh_git(&wt, &["add", "b.txt"]);
        sh_git(&wt, &["commit", "-q", "-m", "ship"]);
        let after = diff_in(&info).unwrap();
        assert_eq!(after.files, vec!["b.txt".to_string()], "the diff is against the base, so Ship stays reachable");
        assert!(after.text.contains("+shipped"));
        assert_eq!(after.patch_id, before.patch_id);
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_refuses_case_variant_factory_but_not_lookalikes() {
        let p = project_repo("icase-factory");
        std::fs::create_dir_all(p.join(".FACTORY")).unwrap();
        std::fs::write(p.join(".FACTORY/REVIEW.md"), "Verdict: approve\n").unwrap();
        sh_git(&p, &["add", "-f", ".FACTORY/REVIEW.md"]);
        sh_git(&p, &["commit", "-q", "-m", "case variant"]);
        let err = prepare_in(&p, &p, "icase1", None, "task").unwrap_err();
        assert!(err.contains("refusing to prepare a factory worktree"), "{err}");
        assert!(!p.join("system/loop-worktrees/icase1").exists(), "no worktree");
        assert_eq!(sh_git(&p, &["branch", "--list", "factory/*"]).trim(), "", "no branch");
        let _ = std::fs::remove_dir_all(&p);

        let q = project_repo("lookalike-factory");
        std::fs::write(q.join(".factoryx"), "unrelated\n").unwrap();
        sh_git(&q, &["add", "-f", ".factoryx"]);
        sh_git(&q, &["commit", "-q", "-m", "lookalike"]);
        let info = prepare_in(&q, &q, "look1", None, "task").unwrap();
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&q);
    }

    #[cfg(unix)]
    #[test]
    fn write_task_file_refuses_any_preexisting_factory_entry() {
        let wt = temp("preexisting");
        std::fs::create_dir_all(wt.join(".factory")).unwrap();
        let err = write_task_file(&wt, "task").unwrap_err();
        assert!(err.contains("ships its own .factory/ entry"), "{err}");
        assert!(!wt.join(TASK_REL).exists());
        let _ = std::fs::remove_dir_all(&wt);
        std::fs::create_dir_all(&wt).unwrap();
        write_task_file(&wt, "task").unwrap();
        assert_eq!(std::fs::read_to_string(wt.join(TASK_REL)).unwrap(), "task");
        let _ = std::fs::remove_dir_all(&wt);
    }

    #[test]
    fn staged_patch_arguments_match_the_shared_fixture() {
        let fx: serde_json::Value = serde_json::from_str(include_str!("../../../schema/factory/staged-patch.json")).unwrap();
        let list = |key: &str| -> Vec<String> {
            fx[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
        };
        assert_eq!(staged_add_args(), list("add"));
        let want: Vec<String> = list("diff").into_iter().map(|a| if a == "{base}" { "BASE".to_string() } else { a }).collect();
        assert_eq!(staged_diff_args(true, "BASE"), want);
        let no_binary: Vec<String> = want.into_iter().filter(|a| a != "--binary").collect();
        assert_eq!(staged_diff_args(false, "BASE"), no_binary);
    }

    #[cfg(unix)]
    #[test]
    fn clear_factory_output_removes_only_a_factory_report() {
        let p = project_repo("clear-output");
        let info = prepare_in(&p, &p, "clr1", None, "task").unwrap();
        let wt = PathBuf::from(&info.worktree);
        std::fs::write(wt.join(".factory/REVIEW.md"), "Verdict: approve\n").unwrap();
        clear_factory_output_in(&wt, ".factory/REVIEW.md").unwrap();
        assert!(!wt.join(".factory/REVIEW.md").exists());
        clear_factory_output_in(&wt, ".factory/REVIEW.md").unwrap(); // already gone: harmless
        for bad in [".factory", ".factory/", "/.factory/x", "src/a.txt", ".FACTORY/x", ".factory/../a.txt", ".factory/a/../../a.txt"] {
            assert!(clear_factory_output_in(&wt, bad).is_err(), "{bad}");
        }
        std::fs::create_dir_all(wt.join(".factory/sub")).unwrap();
        assert!(clear_factory_output_in(&wt, ".factory/sub").unwrap_err().contains("folder"));
        // A symlink report is removed itself, never its target.
        let outside = temp("clear-output-outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.md"), "keep\n").unwrap();
        std::os::unix::fs::symlink(outside.join("keep.md"), wt.join(".factory/PLAN.md")).unwrap();
        clear_factory_output_in(&wt, ".factory/PLAN.md").unwrap();
        assert!(!wt.join(".factory/PLAN.md").exists());
        assert_eq!(std::fs::read_to_string(outside.join("keep.md")).unwrap(), "keep\n");
        // A .factory that is itself a link is refused, so nothing outside is deleted.
        let linked = temp("clear-output-linked");
        std::fs::create_dir_all(linked.join(".factory")).unwrap();
        std::fs::write(linked.join(".factory/REVIEW.md"), "x\n").unwrap();
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&linked);
    }

    #[cfg(unix)]
    #[test]
    fn clear_factory_output_with_run_id_touches_only_that_worktree() {
        let p = project_repo("clear-run");
        let info = prepare_in(&p, &p, "clr2", None, "task").unwrap();
        let wt = PathBuf::from(&info.worktree);
        std::fs::create_dir_all(p.join(".factory")).unwrap();
        std::fs::write(p.join(".factory/REVIEW.md"), "main tree\n").unwrap();
        std::fs::write(wt.join(".factory/REVIEW.md"), "worktree\n").unwrap();
        clear_factory_output_for(Some("clr2"), ".factory/REVIEW.md").unwrap();
        assert!(!wt.join(".factory/REVIEW.md").exists());
        assert_eq!(std::fs::read_to_string(p.join(".factory/REVIEW.md")).unwrap(), "main tree\n");
        assert!(clear_factory_output_for(Some("clr2"), ".factory/../../x").is_err());
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
    }

    #[cfg(unix)]
    #[test]
    fn diff_never_shows_a_case_variant_factory_path() {
        let p = project_repo("icase-diff");
        let info = prepare_in(&p, &p, "icd1", None, "task").unwrap();
        let wt = PathBuf::from(&info.worktree);
        std::fs::create_dir_all(wt.join(".FACTORY")).unwrap();
        std::fs::write(wt.join(".FACTORY/REVIEW.md"), "Verdict: approve\n").unwrap();
        std::fs::create_dir_all(wt.join("pkg/.factory")).unwrap();
        std::fs::write(wt.join("pkg/.factory/PLAN.md"), "Verdict: approve\n").unwrap();
        std::fs::create_dir_all(wt.join("deep/.FACTORY")).unwrap();
        std::fs::write(wt.join("deep/.FACTORY/READINESS.md"), "Verdict: ready\n").unwrap();
        std::fs::write(wt.join("real.txt"), "x\n").unwrap();
        let d = diff_in(&info).unwrap();
        assert_eq!(d.files, vec!["real.txt".to_string()], "nested .factory/ paths are excluded at any depth: {:?}", d.files);
        assert!(!d.text.to_lowercase().contains(".factory"), "{}", d.text);
        remove_in(&info).unwrap();
        let _ = std::fs::remove_dir_all(&p);
    }
}
