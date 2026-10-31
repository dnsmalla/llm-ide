//! Source Control, local actions only (S-K): hunk staging, discard, commit, branches, log.
//! Everything goes through the hardened runner in `git.rs` (cleared env, no hooks/pager/
//! fsmonitor/credential helper, literal pathspecs, absolute git, timeout, output caps, the
//! `untrusted_repo_config` refusal). This module adds the validation around it:
//!
//! - paths are the same relative, validated paths as the fs commands and always follow `--`;
//! - ref names are validated here (a `git check-ref-format` equivalent) and never start with `-`;
//! - hunk patches are rebuilt from git's own `git diff` output for ONE path (the webview sends
//!   hunk indexes and the diff id it saw, never patch text), size-capped, applied with
//!   `git apply --cached --whitespace=nowarn` (no `--unsafe-paths`);
//! - the commit message goes over stdin (`-F -`), is sanitized, and the author/committer come
//!   only from the user's own git config (`user.name` / `user.email`); nothing is invented and
//!   no config is ever written;
//! - destructive actions (discard, checkout) ask in a native, host-run dialog that names the
//!   files or branch; the webview cannot answer it;
//! - text that came from the repository (diffs, subjects, author names) is untrusted: it is
//!   size-capped, control characters and bidi/invisible format characters are removed, and the
//!   UI renders it as plain text.
//!
//! Not here (deferred, they need credentials or are not v1): push/pull/fetch/remote, amend,
//! stash, blame, hosted PR/issue actions.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fs_ops::{FsError, R};
use crate::git::{rel_arg, run_git, run_git_opts, status, GitStatus, Opts, StatusEntry};

const DIFF_CAP: usize = 2 * 1024 * 1024;
const PATCH_CAP: usize = 1024 * 1024;
const MAX_DISCARD_PATHS: usize = 200;
const MAX_MESSAGE_BYTES: usize = 20_000;
const MAX_LOG_PAGE: usize = 200;
const MAX_LOG_SKIP: usize = 1_000_000;
const MAX_COMMIT_FILES: usize = 5_000;
const MAX_BRANCHES: usize = 500;

fn gerr<T>(code: &'static str, message: impl Into<String>) -> R<T> {
    Err(FsError { code, message: message.into() })
}

// ---- untrusted text --------------------------------------------------------------------

/// Multi-line plain text from the repository: no control characters (except `\n` and `\t`), no
/// bidi/invisible format characters, CR removed.
pub fn sanitize_text(s: &str) -> String {
    s.chars()
        .filter(|&c| c == '\n' || c == '\t' || (!c.is_control() && !crate::tray::is_invisible_format(c)))
        .collect()
}

fn line(s: &str, max: usize) -> String {
    crate::confirm::sanitize_line(s, max)
}

// ---- ref names -------------------------------------------------------------------------

/// `git check-ref-format --branch`-equivalent for a short branch name, stricter where it is
/// cheap: no leading dash, no control/invisible characters, at most 200 bytes.
pub fn valid_branch_name(name: &str) -> R<()> {
    let bad = |why: &str| gerr("invalid_ref", format!("not a valid branch name: {why}"));
    if name.is_empty() || name.len() > 200 {
        return bad("1 to 200 bytes");
    }
    if name.starts_with('-') {
        return bad("it must not start with '-'");
    }
    if name == "@" || name.eq_ignore_ascii_case("HEAD") {
        return bad("reserved name");
    }
    if name.starts_with('/') || name.ends_with('/') || name.contains("//") {
        return bad("empty path component");
    }
    if name.contains("..") || name.contains("@{") || name.ends_with('.') {
        return bad("it contains '..', '@{' or ends with '.'");
    }
    if name.chars().any(|c| c.is_control() || c == ' ' || "~^:?*[\\".contains(c) || crate::tray::is_invisible_format(c)) {
        return bad("it contains a space, control character or one of ~ ^ : ? * [ \\");
    }
    for comp in name.split('/') {
        if comp.starts_with('.') || comp.ends_with(".lock") {
            return bad("a component starts with '.' or ends with '.lock'");
        }
    }
    Ok(())
}

fn branch_exists(root: &Path, name: &str) -> bool {
    run_git(root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")], 256).is_ok()
}

/// Whether HEAD names a commit. Only "git said no" means false; a refused repo (untrusted
/// config, not a repo, no git) stays an error.
fn has_head(root: &Path) -> R<bool> {
    match run_git(root, &["rev-parse", "--verify", "-q", "HEAD"], 256) {
        Ok(_) => Ok(true),
        Err(e) if e.code == "git_failed" => Ok(false),
        Err(e) => Err(e),
    }
}

// ---- hunks -----------------------------------------------------------------------------

struct RawDiff {
    header: Vec<u8>,
    hunks: Vec<Vec<u8>>,
}

fn fnv(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Splits `git diff` output for one path into its header and hunks. Refuses anything that is
/// not exactly one plain text diff (binary, several files, odd line markers).
fn parse_raw(diff: &[u8]) -> R<RawDiff> {
    let mut header = Vec::new();
    let mut hunks: Vec<Vec<u8>> = Vec::new();
    let mut seen_diff_header = false;
    for l in diff.split_inclusive(|b| *b == b'\n') {
        if l.starts_with(b"@@ ") {
            hunks.push(l.to_vec());
            continue;
        }
        if let Some(h) = hunks.last_mut() {
            match l.first() {
                Some(b' ' | b'+' | b'-' | b'\\') => h.extend_from_slice(l),
                _ => return gerr("unsupported_diff", "this change is not a single plain text diff; stage the whole file"),
            }
        } else {
            if l.starts_with(b"diff --git ") {
                if seen_diff_header {
                    return gerr("unsupported_diff", "this change touches more than one file entry; stage the whole file");
                }
                seen_diff_header = true;
            }
            if l.starts_with(b"Binary files ") || l.starts_with(b"GIT binary patch") {
                return gerr("binary", "binary files cannot be staged by hunk");
            }
            header.extend_from_slice(l);
        }
    }
    // A last line without a newline cannot be a valid hunk body for apply.
    if hunks.iter().any(|h| !h.ends_with(b"\n")) {
        return gerr("unsupported_diff", "diff ended without a newline");
    }
    Ok(RawDiff { header, hunks })
}

#[derive(Serialize, Debug)]
pub struct HunkView {
    pub index: usize,
    pub header: String,
    pub added: u32,
    pub removed: u32,
    /// Each line keeps its `+`, `-`, ` ` or `\` marker. Display text only.
    pub lines: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct HunkDiff {
    /// Identifies this exact diff; `git_stage_hunks` refuses when the file changed since.
    pub diff_id: String,
    pub hunks: Vec<HunkView>,
    pub truncated: bool,
}

fn diff_args(staged: bool, p: &str) -> Vec<&str> {
    let mut a = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "-U3"];
    if staged {
        a.push("--cached");
    }
    a.extend(["--", p]);
    a
}

pub fn diff_hunks(root: &Path, path: &str, staged: bool) -> R<HunkDiff> {
    let p = rel_arg(path)?;
    let out = run_git(root, &diff_args(staged, &p), DIFF_CAP)?;
    if out.truncated {
        return Ok(HunkDiff { diff_id: String::new(), hunks: Vec::new(), truncated: true });
    }
    let raw = parse_raw(&out.stdout)?;
    let hunks = raw
        .hunks
        .iter()
        .enumerate()
        .map(|(index, h)| {
            let text = String::from_utf8_lossy(h);
            let mut lines = text.lines();
            let header = line(lines.next().unwrap_or(""), 200);
            let (mut added, mut removed) = (0, 0);
            let lines: Vec<String> = lines
                .take(5_000)
                .map(|l| {
                    match l.as_bytes().first() {
                        Some(b'+') => added += 1,
                        Some(b'-') => removed += 1,
                        _ => {}
                    }
                    let mut s = sanitize_text(l);
                    if s.chars().count() > 2_000 {
                        s = s.chars().take(2_000).collect::<String>() + "…";
                    }
                    s
                })
                .collect();
            HunkView { index, header, added, removed, lines }
        })
        .collect();
    Ok(HunkDiff { diff_id: fnv(&out.stdout), hunks, truncated: false })
}

/// Stages (or, with `staged`, unstages) the hunks `indexes` of `path`.
pub fn stage_hunks(root: &Path, path: &str, staged: bool, diff_id: &str, indexes: &[usize]) -> R<()> {
    let p = rel_arg(path)?;
    if indexes.is_empty() {
        return gerr("invalid_path", "select at least one hunk");
    }
    let out = run_git(root, &diff_args(staged, &p), DIFF_CAP)?;
    if out.truncated {
        return gerr("too_large", "the diff is too large to stage by hunk; stage the whole file");
    }
    if fnv(&out.stdout) != diff_id {
        return gerr("changed", "the file changed since the hunks were listed; reload and select again");
    }
    let raw = parse_raw(&out.stdout)?;
    let mut sel: Vec<usize> = indexes.to_vec();
    sel.sort_unstable();
    sel.dedup();
    if sel.iter().any(|i| *i >= raw.hunks.len()) {
        return gerr("invalid_path", "hunk index out of range");
    }
    if raw.header.is_empty() {
        return gerr("unsupported_diff", "no file header in the diff");
    }
    let mut patch = raw.header.clone();
    for i in sel {
        patch.extend_from_slice(&raw.hunks[i]);
    }
    if patch.len() > PATCH_CAP {
        return gerr("too_large", "the selected patch is too large");
    }
    let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
    if staged {
        args.push("--reverse");
    }
    args.push("-");
    run_git_opts(root, &args, 64 * 1024, &Opts { stdin: Some(&patch), ..Opts::default() }).map(|_| ())
}

// ---- stage all -------------------------------------------------------------------------

/// Stages every change, or unstages everything. Refuses while files are in conflict (a bulk
/// `add` would mark them resolved with their markers still in them).
pub fn stage_all(root: &Path, stage: bool) -> R<()> {
    let bulk = Opts { timeout: Some(std::time::Duration::from_secs(180)), ..Opts::default() };
    if stage {
        let st = status(root)?;
        let bulk = Opts { timeout: Some(crate::git::scaled_timeout(st.entries.len()).max(std::time::Duration::from_secs(60))), ..Opts::default() };
        if st.entries.iter().any(|e| e.kind == "unmerged") {
            return gerr("conflict", "resolve the conflicted files first; Stage All would mark them resolved");
        }
        run_git_opts(root, &["add", "-A"], 64 * 1024, &bulk).map(|_| ())
    } else if has_head(root)? {
        run_git_opts(root, &["restore", "--staged", "--", "."], 64 * 1024, &bulk).map(|_| ())
    } else {
        run_git_opts(root, &["rm", "--cached", "-r", "-q", "--", "."], 64 * 1024, &bulk).map(|_| ())
    }
}

// ---- discard ---------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
pub struct DiscardResult {
    pub restored: u32,
    pub trashed: u32,
}

#[derive(Debug, PartialEq, Clone)]
enum Plan {
    Restore(String),
    Trash(String),
}

/// Classifies each requested path from a fresh status. Nothing is touched here.
fn plan_discard(root: &Path, paths: &[String]) -> R<Vec<Plan>> {
    if paths.is_empty() || paths.len() > MAX_DISCARD_PATHS {
        return gerr("too_large", format!("discard between 1 and {MAX_DISCARD_PATHS} paths per call"));
    }
    let mut rels = Vec::new();
    for p in paths {
        let trimmed = p.strip_suffix('/').unwrap_or(p);
        rels.push(rel_arg(trimmed)?);
    }
    let st: GitStatus = status(root)?;
    let find = |rel: &str| -> Option<&StatusEntry> { st.entries.iter().find(|e| e.path == rel || e.path.strip_suffix('/') == Some(rel)) };
    let mut plan = Vec::new();
    for rel in rels {
        let Some(e) = find(&rel) else {
            return gerr("nothing_to_discard", format!("{rel} has no changes to discard"));
        };
        if e.submodule {
            return gerr("submodule", format!("{rel} is a submodule; discard its changes inside it"));
        }
        match e.kind {
            "unmerged" => return gerr("conflict", format!("{rel} is in conflict; resolve it by editing")),
            "untracked" => plan.push(Plan::Trash(rel)),
            _ if e.worktree == '.' => return gerr("nothing_to_discard", format!("{rel} has only staged changes; unstage it instead")),
            _ => plan.push(Plan::Restore(rel)),
        }
    }
    Ok(plan)
}

fn discard_prompt(plan: &[Plan]) -> String {
    let mut s = String::new();
    let (mut r, mut t) = (0, 0);
    for p in plan {
        match p {
            Plan::Restore(_) => r += 1,
            Plan::Trash(_) => t += 1,
        }
    }
    if r > 0 {
        s.push_str(&format!("{r} changed file(s) will be reset to the staged version. This cannot be undone.\n"));
    }
    if t > 0 {
        s.push_str(&format!("{t} untracked item(s) will be moved to the trash.\n"));
    }
    s.push('\n');
    for p in plan.iter().take(12) {
        let (Plan::Restore(n) | Plan::Trash(n)) = p;
        s.push_str(&format!("  {}\n", line(n, 80)));
    }
    if plan.len() > 12 {
        s.push_str(&format!("  ...and {} more\n", plan.len() - 12));
    }
    s
}

/// What a path looks like right now: file = SHA-256 of its content (size+mtime past 64 MB), folder = a bounded
/// digest of its entries' names, kinds, sizes and mtimes, symlink = its target. Taken before the confirm
/// dialog and compared after it, so a file edited while the dialog was open is never discarded.
fn fingerprint(root: &Path, rel: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::time::UNIX_EPOCH;
    const FILE_HASH_MAX: u64 = 64 * 1024 * 1024;
    const DIR_ENTRIES_MAX: usize = 20_000;
    let mtime = |m: &std::fs::Metadata| m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    let mut h = Sha256::new();
    let mut stack = vec![root.join(rel)];
    let mut seen = 0usize;
    while let Some(p) = stack.pop() {
        seen += 1;
        if seen > DIR_ENTRIES_MAX {
            h.update(b"[truncated]");
            break;
        }
        let name = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().into_owned();
        h.update(name.as_bytes());
        match std::fs::symlink_metadata(&p) {
            Err(_) => h.update(b"|missing"),
            Ok(m) if m.file_type().is_symlink() => {
                h.update(b"|link|");
                h.update(std::fs::read_link(&p).map(|t| t.to_string_lossy().into_owned()).unwrap_or_default().as_bytes());
            }
            Ok(m) if m.is_dir() => {
                h.update(b"|dir");
                let mut kids: Vec<_> = std::fs::read_dir(&p).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
                kids.sort();
                stack.extend(kids.into_iter().rev());
            }
            Ok(m) => {
                h.update(format!("|file|{}|{}", m.len(), mtime(&m)).as_bytes());
                if m.len() <= FILE_HASH_MAX {
                    if let Ok(mut f) = std::fs::File::open(&p) {
                        let mut buf = [0u8; 64 * 1024];
                        while let Ok(n) = std::io::Read::read(&mut f, &mut buf) {
                            if n == 0 {
                                break;
                            }
                            h.update(&buf[..n]);
                        }
                    }
                }
            }
        }
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn fingerprints(root: &Path, plan: &[Plan]) -> Vec<String> {
    plan.iter().map(|p| fingerprint(root, match p {
        Plan::Restore(n) | Plan::Trash(n) => n,
    })).collect()
}

/// `confirm` is the native dialog (host) or a stub (tests); it is asked once with the full list.
pub fn discard(root: &Path, paths: &[String], confirm: &dyn Fn(&str) -> bool) -> R<DiscardResult> {
    discard_with(root, paths, confirm, &crate::trash_guard::OsTrash)
}

/// `discard` through an injectable trash. After the dialog the plan and every file's fingerprint are
/// re-checked: anything that changed while the user was deciding aborts with `changed_since_confirm` and
/// nothing is touched.
pub fn discard_with(root: &Path, paths: &[String], confirm: &dyn Fn(&str) -> bool, trasher: &dyn crate::trash_guard::Trasher) -> R<DiscardResult> {
    let plan = plan_discard(root, paths)?;
    let before = fingerprints(root, &plan);
    if !confirm(&discard_prompt(&plan)) {
        return gerr("cancelled", "discard cancelled");
    }
    let again = plan_discard(root, paths).map_err(|_| FsError { code: "changed_since_confirm", message: "the files changed while the dialog was open; nothing was discarded".into() })?;
    if again != plan || fingerprints(root, &again) != before {
        return gerr("changed_since_confirm", "the files changed while the dialog was open; nothing was discarded");
    }
    let restore: Vec<&str> = plan.iter().filter_map(|p| if let Plan::Restore(n) = p { Some(n.as_str()) } else { None }).collect();
    let mut res = DiscardResult { restored: 0, trashed: 0 };
    if !restore.is_empty() {
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(restore.iter().copied());
        run_git(root, &args, 64 * 1024)?;
        res.restored = restore.len() as u32;
    }
    for p in &plan {
        if let Plan::Trash(n) = p {
            crate::fs_ops::delete_with(root, n, trasher)?;
            res.trashed += 1;
        }
    }
    Ok(res)
}

// ---- identity and commit ----------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

/// `Ok(None)` = the key is unset (git exits 1); a refused repo is still an error.
fn config_value(root: &Path, key: &str, home: &Option<PathBuf>) -> R<Option<String>> {
    let out = match run_git_opts(root, &["config", "--get", key], 4096, &Opts { user_config: true, home: home.clone(), ..Opts::default() }) {
        Ok(o) => o,
        Err(e) if e.code == "git_failed" => return Ok(None),
        Err(e) => return Err(e),
    };
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let clean = !v.is_empty() && v.len() <= 256 && !v.chars().any(|c| c.is_control() || crate::tray::is_invisible_format(c)) && !v.contains(['<', '>']);
    Ok(clean.then_some(v))
}

const IDENTITY_HELP: &str = "Git does not know who you are. Run these in a terminal, then try again:\n  git config --global user.name \"Your Name\"\n  git config --global user.email \"you@example.com\"\nLLM-IDE never writes your git config.";

/// The user's own configured identity, or the `identity_missing` error carrying the commands.
pub fn identity(root: &Path, home: &Option<PathBuf>) -> R<Identity> {
    match (config_value(root, "user.name", home)?, config_value(root, "user.email", home)?) {
        (Some(name), Some(email)) => Ok(Identity { name, email }),
        _ => gerr("identity_missing", IDENTITY_HELP),
    }
}

/// Validated, sanitized commit message ending in one newline.
pub fn validate_message(raw: &str) -> R<String> {
    if raw.len() > MAX_MESSAGE_BYTES * 2 {
        return gerr("too_large", format!("the commit message is longer than {MAX_MESSAGE_BYTES} bytes"));
    }
    let clean = sanitize_text(&raw.replace("\r\n", "\n").replace('\r', "\n"));
    let msg = clean.trim().to_string();
    if msg.is_empty() {
        return gerr("empty_message", "write a commit message");
    }
    if msg.len() > MAX_MESSAGE_BYTES {
        return gerr("too_large", format!("the commit message is longer than {MAX_MESSAGE_BYTES} bytes"));
    }
    if msg.starts_with('-') {
        return gerr("invalid_message", "the commit message must not start with '-'");
    }
    Ok(msg + "\n")
}

#[derive(Serialize, Debug)]
pub struct CommitResult {
    pub hash: String,
}

pub fn commit(root: &Path, message: &str, home: &Option<PathBuf>) -> R<CommitResult> {
    let msg = validate_message(message)?;
    let id = identity(root, home)?;
    let st = status(root)?;
    if st.entries.iter().any(|e| e.kind == "unmerged") {
        return gerr("conflict", "resolve the conflicted files (and stage them) before committing");
    }
    if !st.entries.iter().any(|e| e.index != '.' && e.kind != "untracked") {
        return gerr("nothing_staged", "nothing is staged; stage changes first");
    }
    let env = vec![
        ("GIT_AUTHOR_NAME", id.name.clone()),
        ("GIT_AUTHOR_EMAIL", id.email.clone()),
        ("GIT_COMMITTER_NAME", id.name),
        ("GIT_COMMITTER_EMAIL", id.email),
    ];
    // Hooks never run (`core.hooksPath` is forced off by the runner) and signing is forced off:
    // a repo-local `commit.gpgsign` would otherwise start `gpg`.
    run_git_opts(
        root,
        &["-c", "commit.gpgsign=false", "commit", "-F", "-", "--cleanup=whitespace", "--no-verify", "--no-gpg-sign", "--no-edit"],
        64 * 1024,
        &Opts { stdin: Some(msg.as_bytes()), env, ..Opts::default() },
    )?;
    let out = run_git(root, &["rev-parse", "--short", "HEAD"], 256)?;
    Ok(CommitResult { hash: String::from_utf8_lossy(&out.stdout).trim().to_string() })
}

// ---- branches -------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub hash: String,
    pub upstream: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct BranchList {
    pub branches: Vec<Branch>,
    pub truncated: bool,
}

pub fn branches(root: &Path) -> R<BranchList> {
    let out = run_git(
        root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--count={}", MAX_BRANCHES + 1),
            "--format=%(HEAD)%1f%(refname:lstrip=2)%1f%(objectname:short)%1f%(upstream:short)",
            "refs/heads/",
        ],
        1024 * 1024,
    )?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut list: Vec<Branch> = text
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            (f.len() == 4).then(|| Branch { name: line(f[1], 200), current: f[0] == "*", hash: f[2].into(), upstream: (!f[3].is_empty()).then(|| line(f[3], 200)) })
        })
        .collect();
    let truncated = list.len() > MAX_BRANCHES;
    list.truncate(MAX_BRANCHES);
    Ok(BranchList { branches: list, truncated })
}

fn map_checkout_error(e: FsError) -> FsError {
    if e.message.contains("would be overwritten") || e.message.contains("local changes") {
        FsError { code: "dirty_conflict", message: "your uncommitted changes would be overwritten by that checkout; commit or discard them first".into() }
    } else {
        e
    }
}

pub fn checkout(root: &Path, name: &str, confirm: &dyn Fn(&str) -> bool) -> R<()> {
    valid_branch_name(name)?;
    if !branch_exists(root, name) {
        return gerr("not_found", format!("no local branch named {}", line(name, 80)));
    }
    let st = status(root)?;
    if st.entries.iter().any(|e| e.kind == "unmerged") {
        return gerr("conflict", "finish resolving the conflicts before switching branches");
    }
    if st.branch.as_deref() == Some(name) {
        return Ok(());
    }
    let dirty = st.entries.iter().filter(|e| e.kind != "untracked").count();
    let prompt = format!(
        "Switch to branch \u{201C}{}\u{201D}?\n{}",
        line(name, 80),
        if dirty > 0 { format!("\n{dirty} file(s) have uncommitted changes. Git will refuse the switch if they would be overwritten; nothing is forced.") } else { String::new() }
    );
    if !confirm(&prompt) {
        return gerr("cancelled", "checkout cancelled");
    }
    // `--` ends the revision list so a branch can never be read as a path.
    run_git(root, &["checkout", name, "--"], 64 * 1024).map(|_| ()).map_err(map_checkout_error)
}

pub fn create_branch(root: &Path, name: &str) -> R<()> {
    valid_branch_name(name)?;
    if branch_exists(root, name) {
        return gerr("exists", format!("a branch named {} already exists", line(name, 80)));
    }
    run_git(root, &["checkout", "-b", name], 64 * 1024).map(|_| ()).map_err(map_checkout_error)
}

// ---- log -------------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
pub struct LogEntry {
    pub hash: String,
    pub short: String,
    pub author: String,
    /// Author time, seconds since the epoch.
    pub time: i64,
    pub subject: String,
    pub parents: usize,
}

#[derive(Serialize, Debug)]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    pub has_more: bool,
}

pub fn log(root: &Path, skip: usize, limit: usize) -> R<LogPage> {
    if skip > MAX_LOG_SKIP {
        return gerr("too_large", "history offset too large");
    }
    let limit = limit.clamp(1, MAX_LOG_PAGE);
    if !has_head(root)? {
        return Ok(LogPage { entries: Vec::new(), has_more: false });
    }
    let out = run_git(
        root,
        &[
            "-c",
            "log.showSignature=false",
            "log",
            "--no-color",
            "--no-decorate",
            "--no-show-signature",
            "--no-mailmap",
            "-z",
            &format!("--skip={skip}"),
            &format!("--max-count={}", limit + 1),
            "--format=%H%x1f%an%x1f%at%x1f%P%x1f%s",
        ],
        4 * 1024 * 1024,
    )?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut entries: Vec<LogEntry> = text
        .split('\0')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').splitn(5, '\x1f').collect();
            (f.len() == 5 && is_hex(f[0])).then(|| LogEntry {
                hash: f[0].into(),
                short: f[0].chars().take(7).collect(),
                author: line(f[1], 120),
                time: f[2].parse().unwrap_or(0),
                subject: line(f[4], 300),
                parents: f[3].split_whitespace().count(),
            })
        })
        .collect();
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    Ok(LogPage { entries, has_more })
}

fn is_hex(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CommitFile {
    /// `A`, `M`, `D`, `T`.
    pub status: String,
    pub path: String,
}

#[derive(Serialize, Debug)]
pub struct CommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub message: String,
    pub files: Vec<CommitFile>,
    pub truncated: bool,
}

/// Resolves a user-supplied hex id to the full commit id and its parents.
fn resolve_commit(root: &Path, hash: &str) -> R<(String, Vec<String>)> {
    let h = hash.to_ascii_lowercase();
    if !is_hex(&h) {
        return gerr("invalid_ref", "not a commit id");
    }
    let nf = || FsError { code: "not_found", message: "no such commit".into() };
    let out = run_git(root, &["log", "-1", "--no-show-signature", "--format=%H %P", &format!("{h}^{{commit}}"), "--"], 4096).map_err(|_| nf())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut it = text.split_whitespace().map(str::to_string);
    let full = it.next().filter(|f| is_hex(f)).ok_or_else(nf)?;
    Ok((full, it.filter(|p| is_hex(p)).collect()))
}

pub fn commit_files(root: &Path, hash: &str) -> R<CommitDetail> {
    let (full, parents) = resolve_commit(root, hash)?;
    let msg = run_git(root, &["log", "-1", "--no-show-signature", "--format=%B", &full, "--"], 64 * 1024)?;
    let message = sanitize_text(String::from_utf8_lossy(&msg.stdout).trim_end());
    let out = match parents.first() {
        Some(p) => run_git(root, &["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", p, &full, "--"], 8 * 1024 * 1024)?,
        None => run_git(root, &["diff-tree", "--root", "--no-commit-id", "--no-renames", "-r", "--name-status", "-z", &full], 8 * 1024 * 1024)?,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut toks = text.split('\0');
    let mut files = Vec::new();
    let mut truncated = out.truncated;
    while let (Some(s), Some(p)) = (toks.next(), toks.next()) {
        if s.is_empty() {
            break;
        }
        if files.len() >= MAX_COMMIT_FILES {
            truncated = true;
            break;
        }
        files.push(CommitFile { status: s.chars().take(1).collect(), path: p.to_string() });
    }
    Ok(CommitDetail { hash: full, parents, message, files, truncated })
}

#[derive(Serialize, Debug)]
pub struct CommitDiff {
    pub text: String,
    pub truncated: bool,
}

pub fn commit_diff(root: &Path, hash: &str, path: &str) -> R<CommitDiff> {
    let p = rel_arg(path)?;
    let (full, parents) = resolve_commit(root, hash)?;
    let flags = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
    let out = match parents.first() {
        Some(par) => {
            let mut a = vec!["diff"];
            a.extend(flags);
            a.extend([par.as_str(), full.as_str(), "--", p.as_str()]);
            run_git(root, &a, DIFF_CAP)?
        }
        None => {
            let mut a = vec!["show", "--format="];
            a.extend(flags);
            a.extend([full.as_str(), "--", p.as_str()]);
            run_git(root, &a, DIFF_CAP)?
        }
    };
    Ok(CommitDiff { text: sanitize_text(&String::from_utf8_lossy(&out.stdout)), truncated: out.truncated })
}

// ---- Tauri commands --------------------------------------------------------------------

use crate::git::blocking;

#[derive(Deserialize)]
pub struct HunksReq {
    pub path: String,
    #[serde(default)]
    pub staged: bool,
}

#[tauri::command]
pub async fn git_diff_hunks(req: HunksReq) -> R<HunkDiff> {
    blocking(move |root| diff_hunks(&root, &req.path, req.staged)).await
}

#[derive(Deserialize)]
pub struct StageHunksReq {
    pub path: String,
    pub staged: bool,
    pub diff_id: String,
    pub hunks: Vec<usize>,
}

#[tauri::command]
pub async fn git_stage_hunks(req: StageHunksReq) -> R<()> {
    blocking(move |root| stage_hunks(&root, &req.path, req.staged, &req.diff_id, &req.hunks)).await
}

#[tauri::command]
pub async fn git_stage_all(stage: bool) -> R<()> {
    blocking(move |root| stage_all(&root, stage)).await
}

fn native_ask(title: &'static str, accept: &'static str) -> impl Fn(&str) -> bool {
    move |text: &str| crate::confirm::ask(title, text, accept, true)
}

/// One native destructive dialog at a time, and not more often than a person can read them: a page that
/// loops over `git_discard` / `git_checkout` gets `busy` / `rate_limited` instead of a stream of dialogs.
static DESTRUCTIVE_DIALOGS: crate::confirm::DialogGuard = crate::confirm::DialogGuard::new(1_500, 10);

#[tauri::command]
pub async fn git_discard(paths: Vec<String>) -> R<DiscardResult> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| discard(&root, &paths, &native_ask("Discard changes?", "Discard")))).await
}

#[tauri::command]
pub async fn git_identity() -> R<Identity> {
    blocking(|root| identity(&root, &None)).await
}

#[tauri::command]
pub async fn git_commit(message: String) -> R<CommitResult> {
    blocking(move |root| commit(&root, &message, &None)).await
}

#[tauri::command]
pub async fn git_branches() -> R<BranchList> {
    blocking(|root| branches(&root)).await
}

#[tauri::command]
pub async fn git_checkout(name: String) -> R<()> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| checkout(&root, &name, &native_ask("Switch branch?", "Switch")))).await
}

#[tauri::command]
pub async fn git_create_branch(name: String) -> R<()> {
    blocking(move |root| create_branch(&root, &name)).await
}

#[derive(Deserialize)]
pub struct LogReq {
    #[serde(default)]
    pub skip: usize,
    #[serde(default = "default_page")]
    pub limit: usize,
}

fn default_page() -> usize {
    100
}

#[tauri::command]
pub async fn git_log(req: LogReq) -> R<LogPage> {
    blocking(move |root| log(&root, req.skip, req.limit)).await
}

#[tauri::command]
pub async fn git_commit_files(hash: String) -> R<CommitDetail> {
    blocking(move |root| commit_files(&root, &hash)).await
}

#[derive(Deserialize)]
pub struct CommitDiffReq {
    pub hash: String,
    pub path: String,
}

#[tauri::command]
pub async fn git_commit_diff(req: CommitDiffReq) -> R<CommitDiff> {
    blocking(move |root| commit_diff(&root, &req.hash, &req.path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{diff, parse_status, stage};
    use std::fs;
    use std::process::Command;

    fn have_git() -> bool {
        Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-scm-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    fn try_g(root: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always"])
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap()
            .status
            .success()
    }

    fn g(root: &Path, args: &[&str]) {
        assert!(try_g(root, args), "git {args:?} failed");
    }

    fn repo(name: &str) -> PathBuf {
        let r = scratch(name);
        g(&r, &["init", "-q"]);
        r
    }

    fn code<T>(r: R<T>) -> &'static str {
        match r {
            Ok(_) => "ok",
            Err(e) => e.code,
        }
    }

    fn yes(_: &str) -> bool {
        true
    }
    fn no(_: &str) -> bool {
        false
    }

    /// A home directory holding the user's git identity (or none).
    fn home(name: &str, ident: bool) -> Option<PathBuf> {
        let h = scratch(name);
        if ident {
            fs::write(h.join(".gitconfig"), "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n").unwrap();
        }
        Some(h)
    }

    #[test]
    fn branch_names() {
        for ok in ["main", "feature/x-1", "fix_é", "a.b", "v1.0.1", "ünï"] {
            assert!(valid_branch_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "-x", "--force", "a..b", "a b", "a\tb", "a\nb", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "/a", "a/", "a//b", ".a", "a/.b", "a.lock", "a/b.lock", "a.", "@", "HEAD", "head", "a@{b", "a\u{202E}b", "a\u{0}b",
        ] {
            assert_eq!(code(valid_branch_name(bad)), "invalid_ref", "{bad:?}");
        }
        assert_eq!(code(valid_branch_name(&"a".repeat(201))), "invalid_ref");
    }

    #[test]
    fn commit_message_validation() {
        assert_eq!(validate_message("  fix: x \r\n\r\nbody\u{202E}\u{7}\n").unwrap(), "fix: x \n\nbody\n");
        assert_eq!(code(validate_message("   \n")), "empty_message");
        assert_eq!(code(validate_message("-n hello")), "invalid_message");
        assert_eq!(code(validate_message(&"x".repeat(MAX_MESSAGE_BYTES + 1))), "too_large");
        // Trailer text cannot smuggle extra lines through control characters.
        assert_eq!(validate_message("a\u{0}\u{1b}[31mb").unwrap(), "a[31mb\n");
    }

    #[test]
    fn untrusted_text_is_plain() {
        assert_eq!(sanitize_text("a\u{202E}b\u{200B}c\r\nd\te\u{1b}"), "abc\nd\te");
    }

    #[test]
    fn hunk_stage_and_unstage_with_weird_names() {
        if !have_git() {
            return;
        }
        let r = repo("hunks");
        for name in ["plain.txt", "-dash é.txt", "sp ace.txt"] {
            let body: String = (1..=40).map(|i| format!("line {i}\n")).collect();
            fs::write(r.join(name), &body).unwrap();
            g(&r, &["add", "--", name]);
        }
        g(&r, &["commit", "-q", "-m", "init"]);
        for name in ["plain.txt", "-dash é.txt", "sp ace.txt"] {
            let body: String = (1..=40).map(|i| if i == 2 || i == 38 { format!("CHANGED {i}\n") } else { format!("line {i}\n") }).collect();
            fs::write(r.join(name), body).unwrap();
            let hd = diff_hunks(&r, name, false).unwrap();
            assert_eq!(hd.hunks.len(), 2, "{name}");
            assert_eq!((hd.hunks[0].added, hd.hunks[0].removed), (1, 1));
            // Stage only the second hunk.
            stage_hunks(&r, name, false, &hd.diff_id, &[1]).unwrap();
            let staged = diff(&r, name, true).unwrap().text;
            assert!(staged.contains("+CHANGED 38") && !staged.contains("CHANGED 2\n"), "{staged}");
            let wt = diff(&r, name, false).unwrap().text;
            assert!(wt.contains("+CHANGED 2") && !wt.contains("CHANGED 38"), "{wt}");
            // A stale id (file changed since listing) is refused.
            assert_eq!(code(stage_hunks(&r, name, false, &hd.diff_id, &[0])), "changed");
            // Unstage it again via the cached diff.
            let sd = diff_hunks(&r, name, true).unwrap();
            assert_eq!(sd.hunks.len(), 1);
            stage_hunks(&r, name, true, &sd.diff_id, &[0]).unwrap();
            assert_eq!(diff(&r, name, true).unwrap().text, "");
        }
    }

    #[test]
    fn hunk_refusals() {
        if !have_git() {
            return;
        }
        let r = repo("hunk-bad");
        fs::write(r.join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(r.join("b.bin"), [0u8, 1, 2, 3]).unwrap();
        g(&r, &["add", "."]);
        g(&r, &["commit", "-q", "-m", "i"]);
        fs::write(r.join("a.txt"), "one\nTWO\n").unwrap();
        fs::write(r.join("b.bin"), [0u8, 9, 9, 3]).unwrap();
        fs::write(r.join("new.txt"), "x\n").unwrap();
        let hd = diff_hunks(&r, "a.txt", false).unwrap();
        assert_eq!(code(stage_hunks(&r, "a.txt", false, &hd.diff_id, &[])), "invalid_path");
        assert_eq!(code(stage_hunks(&r, "a.txt", false, &hd.diff_id, &[7])), "invalid_path");
        assert_eq!(code(stage_hunks(&r, "../a.txt", false, &hd.diff_id, &[0])), "invalid_path");
        assert_eq!(code(stage_hunks(&r, "a/.git/x", false, &hd.diff_id, &[0])), "invalid_path");
        assert_eq!(code(diff_hunks(&r, "b.bin", false)), "binary");
        // Untracked: no diff, nothing to select.
        assert!(diff_hunks(&r, "new.txt", false).unwrap().hunks.is_empty());
    }

    #[test]
    fn discard_restores_tracked_and_plans_untracked() {
        if !have_git() {
            return;
        }
        let r = repo("discard");
        fs::write(r.join("a.txt"), "one\n").unwrap();
        fs::write(r.join("-weird name.txt"), "w\n").unwrap();
        g(&r, &["add", "."]);
        g(&r, &["commit", "-q", "-m", "i"]);
        fs::write(r.join("a.txt"), "edited\n").unwrap();
        fs::write(r.join("-weird name.txt"), "edited\n").unwrap();
        fs::create_dir(r.join("newdir")).unwrap();
        fs::write(r.join("newdir/f.txt"), "n\n").unwrap();
        fs::write(r.join("u.txt"), "u\n").unwrap();
        // Cancelled: nothing changes.
        assert_eq!(code(discard(&r, &["a.txt".into()], &no)), "cancelled");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "edited\n");
        // The prompt names the files.
        let asked = std::cell::RefCell::new(String::new());
        let spy = |t: &str| {
            *asked.borrow_mut() = t.to_string();
            true
        };
        let res = discard(&r, &["a.txt".into(), "-weird name.txt".into()], &spy).unwrap();
        assert_eq!(res, DiscardResult { restored: 2, trashed: 0 });
        assert!(asked.borrow().contains("a.txt") && asked.borrow().contains("-weird name.txt"), "{}", asked.borrow());
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "one\n");
        assert_eq!(fs::read_to_string(r.join("-weird name.txt")).unwrap(), "w\n");
        // Untracked files and folders are planned for the trash (a trailing slash is the folder form).
        let plan = plan_discard(&r, &["newdir/".into(), "u.txt".into()]).unwrap();
        assert!(matches!(&plan[0], Plan::Trash(n) if n == "newdir") && matches!(&plan[1], Plan::Trash(n) if n == "u.txt"));
        // Never broad: unknown paths, globs, traversal, .git and empty lists are refused.
        assert_eq!(code(discard(&r, &["*".into()], &yes)), "nothing_to_discard");
        assert_eq!(code(discard(&r, &[":(glob)**".into()], &yes)), "nothing_to_discard");
        assert_eq!(code(discard(&r, &["../x".into()], &yes)), "invalid_path");
        assert_eq!(code(discard(&r, &[".git/config".into()], &yes)), "invalid_path");
        assert_eq!(code(discard(&r, &[], &yes)), "too_large");
        assert!(r.join("u.txt").exists() && r.join("newdir/f.txt").exists(), "no broad clean happened");
        // A change that is only staged is not discardable (unstage it instead).
        fs::write(r.join("a.txt"), "staged\n").unwrap();
        g(&r, &["add", "a.txt"]);
        assert_eq!(code(discard(&r, &["a.txt".into()], &yes)), "nothing_to_discard");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "staged\n");
    }

    #[test]
    fn a_file_edited_while_the_dialog_is_open_is_not_discarded() {
        if !have_git() {
            return;
        }
        let r = repo("discard-race");
        fs::write(r.join("a.txt"), "one\n").unwrap();
        g(&r, &["add", "."]);
        g(&r, &["commit", "-q", "-m", "i"]);
        fs::write(r.join("a.txt"), "edited\n").unwrap();
        fs::write(r.join("u.txt"), "u\n").unwrap();
        let bin = r.parent().unwrap().join(format!("{}-bin", r.file_name().unwrap().to_string_lossy()));
        let fake = crate::trash_guard::tests::FakeTrash::into(&bin);
        // The user keeps typing while the dialog is open.
        let edit_during = |_: &str| {
            fs::write(r.join("a.txt"), "edited AND then more work\n").unwrap();
            true
        };
        assert_eq!(code(discard_with(&r, &["a.txt".into()], &edit_during, &fake)), "changed_since_confirm");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "edited AND then more work\n", "the new work was not thrown away");
        // An untracked file replaced meanwhile is not trashed either.
        let replace_during = |_: &str| {
            fs::write(r.join("u.txt"), "somebody else wrote this\n").unwrap();
            true
        };
        assert_eq!(code(discard_with(&r, &["u.txt".into()], &replace_during, &fake)), "changed_since_confirm");
        assert!(r.join("u.txt").exists() && fake.seen.borrow().is_empty());
        // An unchanged world still discards, through the injected trash.
        let res = discard_with(&r, &["a.txt".into(), "u.txt".into()], &yes, &fake).unwrap();
        assert_eq!(res, DiscardResult { restored: 1, trashed: 1 });
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "one\n");
        assert!(!r.join("u.txt").exists());
        // A refusing trash leaves the untracked file in place.
        fs::write(r.join("v.txt"), "v\n").unwrap();
        let refusing = crate::trash_guard::tests::FakeTrash::refusing();
        assert_eq!(code(discard_with(&r, &["v.txt".into()], &yes, &refusing)), "trash_unavailable");
        assert!(r.join("v.txt").exists());
    }

    #[test]
    fn a_folder_changing_while_the_dialog_is_open_is_detected() {
        let d = scratch("fp");
        fs::create_dir_all(d.join("dir/sub")).unwrap();
        fs::write(d.join("dir/sub/f.txt"), "1").unwrap();
        let a = fingerprint(&d, "dir");
        assert_eq!(a, fingerprint(&d, "dir"), "stable");
        fs::write(d.join("dir/sub/f.txt"), "2").unwrap();
        assert_ne!(a, fingerprint(&d, "dir"), "content");
        let b = fingerprint(&d, "dir");
        fs::write(d.join("dir/new.txt"), "").unwrap();
        assert_ne!(b, fingerprint(&d, "dir"), "new entry");
        assert_ne!(fingerprint(&d, "dir"), fingerprint(&d, "missing"));
    }

    #[test]
    fn discard_untracked_goes_to_trash_when_available() {
        if !have_git() || std::env::var_os("LLMIDE_TEST_TRASH").is_none() {
            return; // moves a real temp file into the user's trash: opt-in
        }
        let r = repo("trash");
        fs::write(r.join("u.txt"), "u\n").unwrap();
        let res = discard(&r, &["u.txt".into()], &yes).unwrap();
        assert_eq!(res.trashed, 1);
        assert!(!r.join("u.txt").exists());
    }

    #[test]
    fn commit_needs_the_users_identity_and_never_writes_config() {
        if !have_git() {
            return;
        }
        let r = repo("commit");
        fs::write(r.join("a.txt"), "x\n").unwrap();
        // Nothing staged.
        assert_eq!(code(commit(&r, "msg", &home("h0", true))), "nothing_staged");
        g(&r, &["add", "a.txt"]);
        // No identity: a clear message with the exact commands, and no commit.
        let e = commit(&r, "msg", &home("h1", false)).unwrap_err();
        assert_eq!(e.code, "identity_missing");
        assert!(e.message.contains("git config --global user.name") && e.message.contains("user.email"));
        assert!(!has_head(&r).unwrap());
        assert!(!fs::read_to_string(r.join(".git/config")).unwrap().contains("[user]"));
        // With identity: the commit carries it, the message is exact.
        let h = home("h2", true);
        let res = commit(&r, "feat: add a\n\nbody line\n", &h).unwrap();
        assert!(res.hash.len() >= 7);
        let out = Command::new("git").args(["log", "-1", "--format=%an <%ae>|%cn|%B"]).current_dir(&r).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(text.starts_with("Ada Lovelace <ada@example.com>|Ada Lovelace|feat: add a\n\nbody line"), "{text}");
        assert!(!fs::read_to_string(r.join(".git/config")).unwrap().contains("[user]"));
        assert_eq!(code(commit(&r, "again", &h)), "nothing_staged");
        assert_eq!(code(commit(&r, "-bad", &h)), "invalid_message");
    }

    #[test]
    fn hooks_do_not_run_and_signing_is_off() {
        if !have_git() || cfg!(windows) {
            return;
        }
        let r = repo("hooks");
        let marker = r.join("hook-ran");
        let hook = r.join(".git/hooks/pre-commit");
        fs::create_dir_all(r.join(".git/hooks")).unwrap();
        fs::write(&hook, format!("#!/bin/sh\ntouch '{}'\nexit 1\n", marker.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        // A repo-local gpgsign that would start `gpg` is overridden too.
        let cfg = fs::read_to_string(r.join(".git/config")).unwrap();
        fs::write(r.join(".git/config"), format!("{cfg}[commit]\n\tgpgsign = true\n")).unwrap();
        fs::write(r.join("a.txt"), "x\n").unwrap();
        g(&r, &["add", "a.txt"]);
        commit(&r, "hooked", &home("h3", true)).unwrap();
        assert!(!marker.exists(), "pre-commit hook must not run");
    }

    #[test]
    fn malicious_config_is_refused_everywhere() {
        if !have_git() {
            return;
        }
        let marker_dir = scratch("evil-marker");
        let marker = marker_dir.join("pwned");
        let m = marker.display().to_string();
        let evils = [
            format!("[filter \"x\"]\n\tclean = touch {m}\n\tsmudge = touch {m}\n"),
            format!("[include]\n\tpath = {m}\n"),
            format!("[includeIf \"gitdir:/\"]\n\tpath = {m}\n"),
            format!("[core]\n\tfsmonitor = touch {m}\n"),
            format!("[core]\n\tsshCommand = touch {m}\n"),
            format!("[diff \"x\"]\n\ttextconv = touch {m}\n"),
            format!("[credential]\n\thelper = !touch {m}\n"),
        ];
        for (i, evil) in evils.iter().enumerate() {
            let r = repo(&format!("evil{i}"));
            fs::write(r.join("a.txt"), "x\n").unwrap();
            let cfg = fs::read_to_string(r.join(".git/config")).unwrap();
            fs::write(r.join(".git/config"), format!("{cfg}{evil}")).unwrap();
            let h = home("hevil", true);
            for c in [
                code(status(&r)),
                code(stage_all(&r, true)),
                code(diff_hunks(&r, "a.txt", false)),
                code(commit(&r, "m", &h)),
                code(branches(&r)),
                code(log(&r, 0, 10)),
                code(create_branch(&r, "x")),
                code(identity(&r, &h)),
            ] {
                assert_eq!(c, "untrusted_repo_config", "evil {i}");
            }
            assert!(!marker.exists(), "evil {i} ran a program");
        }
        // Aliases are not on the allowlist at all: the repo is refused (and no alias ever runs).
        let r = repo("alias");
        let cfg = fs::read_to_string(r.join(".git/config")).unwrap();
        fs::write(r.join(".git/config"), format!("{cfg}[alias]\n\tstatus = !touch {m}\n\tlog = !touch {m}\n\tcommit = !touch {m}\n")).unwrap();
        fs::write(r.join("a.txt"), "x\n").unwrap();
        assert_eq!(code(status(&r)), "untrusted_repo_config");
        assert!(!marker.exists(), "alias ran");
    }

    #[test]
    fn weird_file_names_round_trip() {
        if !have_git() || cfg!(windows) {
            return;
        }
        let r = repo("names");
        let names = ["with space.txt", "ünï ç0dé.txt", "-leading-dash.txt", "new\nline.txt", "quote\"d.txt", "--force", ":(glob)*", "tab\there.txt"];
        for n in names {
            fs::write(r.join(n), "v1\n").unwrap();
        }
        let st = status(&r).unwrap();
        for n in names {
            assert!(st.entries.iter().any(|e| e.path == n && e.kind == "untracked"), "missing {n:?} in {:?}", st.entries.iter().map(|e| &e.path).collect::<Vec<_>>());
        }
        let all: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        stage(&r, &all, true).unwrap();
        commit(&r, "names", &home("hn", true)).unwrap();
        for n in names {
            fs::write(r.join(n), "v2\n").unwrap();
        }
        let st = status(&r).unwrap();
        assert_eq!(st.entries.iter().filter(|e| e.worktree == 'M').count(), names.len());
        let res = discard(&r, &all, &yes).unwrap();
        assert_eq!(res.restored as usize, names.len());
        for n in names {
            assert_eq!(fs::read_to_string(r.join(n)).unwrap(), "v1\n", "{n:?}");
        }
        assert!(status(&r).unwrap().entries.is_empty());
    }

    #[test]
    fn branches_checkout_create_and_dirty_refusal() {
        if !have_git() {
            return;
        }
        let r = repo("branches");
        fs::write(r.join("a.txt"), "main\n").unwrap();
        g(&r, &["add", "."]);
        g(&r, &["commit", "-q", "-m", "i"]);
        create_branch(&r, "feature/x").unwrap();
        assert_eq!(code(create_branch(&r, "feature/x")), "exists");
        assert_eq!(code(create_branch(&r, "-b")), "invalid_ref");
        assert_eq!(code(create_branch(&r, "a..b")), "invalid_ref");
        fs::write(r.join("a.txt"), "feature\n").unwrap();
        g(&r, &["commit", "-qam", "f"]);
        let list = branches(&r).unwrap();
        assert_eq!(list.branches.len(), 2);
        assert!(list.branches.iter().any(|b| b.name == "feature/x" && b.current));
        // Cancel keeps the branch; a missing or invalid name is refused before git runs.
        assert_eq!(code(checkout(&r, "main", &no)), "cancelled");
        assert_eq!(code(checkout(&r, "nope", &yes)), "not_found");
        assert_eq!(code(checkout(&r, "--detach", &yes)), "invalid_ref");
        // Dirty tree that conflicts with the target: refused by git, nothing forced.
        fs::write(r.join("a.txt"), "dirty\n").unwrap();
        assert_eq!(code(checkout(&r, "main", &yes)), "dirty_conflict");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "dirty\n");
        g(&r, &["checkout", "--", "a.txt"]);
        checkout(&r, "main", &yes).unwrap();
        assert_eq!(status(&r).unwrap().branch.as_deref(), Some("main"));
    }

    #[test]
    fn detached_head_and_log_paging() {
        if !have_git() {
            return;
        }
        let r = repo("log");
        assert!(log(&r, 0, 10).unwrap().entries.is_empty(), "unborn branch");
        assert!(branches(&r).unwrap().branches.is_empty());
        for i in 0..5 {
            fs::write(r.join("a.txt"), format!("{i}\n")).unwrap();
            g(&r, &["add", "."]);
            g(&r, &["commit", "-q", "-m", &format!("commit {i}\u{202E}")]);
        }
        let p1 = log(&r, 0, 2).unwrap();
        assert_eq!((p1.entries.len(), p1.has_more), (2, true));
        assert_eq!(p1.entries[0].subject, "commit 4");
        assert_eq!(p1.entries[0].author, "t");
        let p3 = log(&r, 4, 2).unwrap();
        assert_eq!((p3.entries.len(), p3.has_more), (1, false));
        assert_eq!(p3.entries[0].parents, 0);
        // Detached HEAD: no branch name, a head hash, and everything still works.
        g(&r, &["checkout", "-q", "--detach", "HEAD~1"]);
        let st = status(&r).unwrap();
        assert_eq!(st.branch, None);
        assert!(st.head.is_some());
        assert_eq!(branches(&r).unwrap().branches.len(), 1);
        // Commit detail + lazy per-file diff, for a normal and the root commit.
        let tip = log(&r, 0, 1).unwrap().entries.remove(0);
        let d = commit_files(&r, &tip.short).unwrap();
        assert_eq!(d.hash, tip.hash);
        assert_eq!(d.files, vec![CommitFile { status: "M".into(), path: "a.txt".into() }]);
        assert!(commit_diff(&r, &tip.hash, "a.txt").unwrap().text.contains("+3"));
        let root = log(&r, 0, 10).unwrap().entries.pop().unwrap();
        assert_eq!(commit_files(&r, &root.hash).unwrap().files[0].status, "A");
        assert!(commit_diff(&r, &root.hash, "a.txt").unwrap().text.contains("+0"));
        // Bad ids and paths.
        assert_eq!(code(commit_files(&r, "--all")), "invalid_ref");
        assert_eq!(code(commit_files(&r, "zzzzzzz")), "invalid_ref");
        assert_eq!(code(commit_files(&r, "deadbeef")), "not_found");
        assert_eq!(code(commit_diff(&r, &tip.hash, "../x")), "invalid_path");
        assert_eq!(code(log(&r, MAX_LOG_SKIP + 1, 10)), "too_large");
    }

    #[test]
    fn conflict_state_is_listed_and_blocks_bulk_actions() {
        if !have_git() {
            return;
        }
        let r = repo("conflict");
        fs::write(r.join("a.txt"), "base\n").unwrap();
        g(&r, &["add", "."]);
        g(&r, &["commit", "-q", "-m", "base"]);
        g(&r, &["checkout", "-q", "-b", "other"]);
        fs::write(r.join("a.txt"), "other\n").unwrap();
        g(&r, &["commit", "-qam", "other"]);
        g(&r, &["checkout", "-q", "main"]);
        fs::write(r.join("a.txt"), "main\n").unwrap();
        g(&r, &["commit", "-qam", "main"]);
        assert!(!try_g(&r, &["merge", "other"]), "must conflict");
        let st = status(&r).unwrap();
        assert!(st.entries.iter().any(|e| e.kind == "unmerged" && e.path == "a.txt"));
        let h = home("hc", true);
        assert_eq!(code(commit(&r, "m", &h)), "conflict");
        assert_eq!(code(stage_all(&r, true)), "conflict");
        assert_eq!(code(discard(&r, &["a.txt".into()], &yes)), "conflict");
        assert_eq!(code(checkout(&r, "other", &yes)), "conflict");
        // Mark resolved = stage the file, then commit.
        fs::write(r.join("a.txt"), "resolved\n").unwrap();
        stage(&r, &["a.txt".into()], true).unwrap();
        commit(&r, "merge", &h).unwrap();
    }

    #[test]
    fn ignored_files_are_not_listed() {
        if !have_git() {
            return;
        }
        let r = repo("ignore");
        fs::write(r.join(".gitignore"), "*.log\nbuild/\n").unwrap();
        fs::write(r.join("x.log"), "l\n").unwrap();
        fs::create_dir(r.join("build")).unwrap();
        fs::write(r.join("build/o.bin"), "o\n").unwrap();
        fs::write(r.join("keep.txt"), "k\n").unwrap();
        let paths: Vec<String> = status(&r).unwrap().entries.into_iter().map(|e| e.path).collect();
        assert!(paths.contains(&".gitignore".to_string()) && paths.contains(&"keep.txt".to_string()));
        assert!(!paths.iter().any(|p| p.contains("x.log") || p.contains("build")), "{paths:?}");
        assert_eq!(code(discard(&r, &["x.log".into()], &yes)), "nothing_to_discard");
    }

    #[test]
    fn submodule_worktree_shallow_and_bare_do_not_crash() {
        if !have_git() {
            return;
        }
        // Submodule
        let inner = repo("sub-inner");
        fs::write(inner.join("i.txt"), "i\n").unwrap();
        g(&inner, &["add", "."]);
        g(&inner, &["commit", "-q", "-m", "i"]);
        let outer = repo("sub-outer");
        fs::write(outer.join("o.txt"), "o\n").unwrap();
        g(&outer, &["add", "."]);
        g(&outer, &["commit", "-q", "-m", "o"]);
        assert!(try_g(&outer, &["submodule", "add", "-q", inner.to_str().unwrap(), "sub"]));
        let st = status(&outer).unwrap();
        let sub = st.entries.iter().find(|e| e.path == "sub").expect("sub entry");
        assert!(sub.submodule);
        assert_eq!(code(discard(&outer, &["sub".into()], &yes)), "submodule");
        // The submodule itself opened as a project (its .git is a file pointing into the parent).
        fs::write(outer.join("sub/new.txt"), "n\n").unwrap();
        let sst = status(&outer.join("sub")).unwrap();
        assert!(sst.entries.iter().any(|e| e.path == "new.txt"));
        assert_eq!(log(&outer.join("sub"), 0, 5).unwrap().entries.len(), 1);
        // Linked worktree
        g(&outer, &["commit", "-q", "-m", "add sub"]);
        let wt = outer.parent().unwrap().join(format!("{}-wt", outer.file_name().unwrap().to_string_lossy()));
        let _ = fs::remove_dir_all(&wt);
        g(&outer, &["worktree", "add", "-q", "-b", "wtb", wt.to_str().unwrap()]);
        let wst = status(&wt).unwrap();
        assert_eq!(wst.branch.as_deref(), Some("wtb"));
        assert_eq!(branches(&wt).unwrap().branches.len(), 2);
        // Shallow clone
        let shallow = scratch("shallow");
        let url = format!("file://{}", inner.display());
        assert!(Command::new("git").args(["clone", "-q", "--depth", "1", &url, "."]).current_dir(&shallow).env("GIT_CONFIG_GLOBAL", "/dev/null").status().unwrap().success());
        assert!(status(&shallow).unwrap().entries.is_empty());
        assert_eq!(log(&shallow, 0, 10).unwrap().entries.len(), 1);
        // Bare repository: refused cleanly, not a crash.
        let bare = scratch("bare");
        g(&bare, &["init", "-q", "--bare"]);
        assert_eq!(code(status(&bare)), "not_a_repo");
        assert_eq!(code(log(&bare, 0, 5)), "not_a_repo");
        assert_eq!(code(branches(&bare)), "not_a_repo");
        let _ = fs::remove_dir_all(&wt);
    }

    #[test]
    fn lfs_pointer_files_are_plain_text() {
        if !have_git() {
            return;
        }
        let r = repo("lfs");
        fs::write(r.join("big.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n").unwrap();
        stage(&r, &["big.bin".into()], true).unwrap();
        commit(&r, "pointer", &home("hl", true)).unwrap();
        fs::write(r.join("big.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:def\nsize 99\n").unwrap();
        assert_eq!(diff_hunks(&r, "big.bin", false).unwrap().hunks.len(), 1);
    }

    #[test]
    fn status_cap_and_ten_thousand_files() {
        // Synthetic overflow: the parser stops at the cap and says so.
        let mut raw = Vec::new();
        for i in 0..20_050 {
            raw.extend_from_slice(format!("? f{i}.txt\0").as_bytes());
        }
        let s = parse_status(&raw);
        assert!(s.truncated && s.entries.len() == 20_000);
        if !have_git() {
            return;
        }
        let r = repo("tenk");
        for d in 0..100 {
            fs::create_dir(r.join(format!("d{d}"))).unwrap();
            for f in 0..100 {
                fs::write(r.join(format!("d{d}/f{f}.txt")), format!("{d} {f}\n")).unwrap();
            }
        }
        let t = std::time::Instant::now();
        stage_all(&r, true).unwrap();
        let t_add = t.elapsed();
        commit(&r, "ten thousand", &home("h10k", true)).unwrap();
        for d in 0..100 {
            for f in 0..100 {
                fs::write(r.join(format!("d{d}/f{f}.txt")), format!("{d} {f} changed\n")).unwrap();
            }
        }
        let t = std::time::Instant::now();
        let st = status(&r).unwrap();
        let t_status = t.elapsed();
        assert_eq!(st.entries.len(), 10_000);
        assert!(!st.truncated);
        let t = std::time::Instant::now();
        stage_all(&r, true).unwrap();
        let t_stage = t.elapsed();
        let t = std::time::Instant::now();
        assert_eq!(status(&r).unwrap().entries.iter().filter(|e| e.index == 'M').count(), 10_000);
        let t_status2 = t.elapsed();
        stage_all(&r, false).unwrap();
        assert_eq!(status(&r).unwrap().entries.iter().filter(|e| e.index == '.' && e.worktree == 'M').count(), 10_000);
        eprintln!("10k files: add-all {t_add:?}, status(10k modified) {t_status:?}, stage-all {t_stage:?}, status(10k staged) {t_status2:?}");
        assert!(t_status < std::time::Duration::from_secs(10), "status too slow: {t_status:?}");
    }
}
