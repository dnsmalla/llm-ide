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
//! Branch delete (safe `-d` first), tag create (never moves a tag), stash (list, push, apply, pop,
//! drop), merge (plus abort), amend and discard all are here too. Not here (deferred, they need credentials
//! or are not v1): push/pull/fetch/remote, blame, hosted PR/issue actions.

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
        // Collapsed untracked folders undercount the files `add -A` hashes (10k files in 100 folders = 100 entries),
        // so the floor is the same 180 s hang guard the unstage branch uses.
        let bulk = Opts { timeout: Some(crate::git::scaled_timeout(st.entries.len()).max(std::time::Duration::from_secs(180))), ..Opts::default() };
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
            "untracked" => {
                if has_nested_repo(&root.join(&rel)) {
                    return gerr("nested_repo", format!("{rel} contains a nested git repository; discard it inside that repository"));
                }
                if let Some(why) = keep_reason(root, &rel).filter(|w| *w != "missing") {
                    return gerr("kept", format!("{rel} is {why}; it is left in place"));
                }
                plan.push(Plan::Trash(rel))
            }
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
    /// What the user's own git would have done for this commit and this app did not: `"hooks"`, `"signing"`. The
    /// panel says so, because a skipped secret scanner or an unsigned commit is otherwise found out only at push.
    pub skipped: Vec<&'static str>,
}

const COMMIT_HOOKS: [&str; 4] = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"];

/// The commit-time steps this app never runs (hooks are forced off and nothing is signed) that this repository or
/// user has set up. Best effort: an unreadable hooks folder counts as none.
fn commit_skips(root: &Path, home: &Option<PathBuf>) -> Vec<&'static str> {
    let mut out = Vec::new();
    let hooks_path_set = run_git(root, &["config", "--local", "--get", "core.hooksPath"], 4096).is_ok_and(|o| !o.stdout.iter().all(u8::is_ascii_whitespace));
    let hook_files = || {
        // Not `--git-path hooks`: the runner points `core.hooksPath` at the null device, and git answers with that.
        let out = run_git(root, &["rev-parse", "--git-common-dir"], 4096).ok()?;
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let dir = if Path::new(&p).is_absolute() { PathBuf::from(p) } else { root.join(p) }.join("hooks");
        Some(COMMIT_HOOKS.iter().any(|h| dir.join(h).is_file()))
    };
    if hooks_path_set || hook_files().unwrap_or(false) {
        out.push("hooks");
    }
    if config_value(root, "commit.gpgsign", home).ok().flatten().is_some_and(|v| v.eq_ignore_ascii_case("true")) {
        out.push("signing");
    }
    out
}

pub fn commit(root: &Path, message: &str, home: &Option<PathBuf>) -> R<CommitResult> {
    let msg = validate_message(message)?;
    let id = identity(root, home)?;
    // A commit made here is authored as the current user and takes this message. In the middle of a rebase,
    // cherry-pick or revert that would replace the original author and bypass the operation's own message, so those
    // are finished with git's `--continue` in a terminal. Concluding a merge is an ordinary commit and is allowed.
    if let Some(what) = operation_in_progress(root)? {
        if what != "A merge" {
            return gerr("in_progress", format!("{what} is in progress. Finish it with git in a terminal (--continue) or abort it first: a commit made here would not keep the original author."));
        }
    }
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
    Ok(CommitResult { hash: String::from_utf8_lossy(&out.stdout).trim().to_string(), skipped: commit_skips(root, home) })
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

// ---- tags (read-only) -----------------------------------------------------------------

const MAX_TAGS: usize = 500;

#[derive(Serialize, Debug, PartialEq)]
pub struct Tag {
    pub name: String,
    /// Short id of the commit the tag names (an annotated tag's peeled commit).
    pub target: String,
    pub annotated: bool,
}

#[derive(Serialize, Debug)]
pub struct TagList {
    pub tags: Vec<Tag>,
    pub truncated: bool,
}

/// Local tags, newest first by creator date (the commit date for a lightweight tag). Read-only:
/// creating, deleting or pushing tags is not in this host.
pub fn tags(root: &Path) -> R<TagList> {
    let out = run_git(
        root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            &format!("--count={}", MAX_TAGS + 1),
            "--format=%(refname:lstrip=2)%1f%(objecttype)%1f%(objectname:short)%1f%(*objectname:short)",
            "refs/tags/",
        ],
        1024 * 1024,
    )?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut list: Vec<Tag> = text
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            if f.len() != 4 {
                return None;
            }
            let annotated = f[1] == "tag";
            let target = if annotated { f[3] } else { f[2] };
            Some(Tag { name: line(f[0], 200), target: target.to_string(), annotated })
        })
        .filter(|t| !t.name.is_empty())
        .collect();
    let truncated = list.len() > MAX_TAGS;
    list.truncate(MAX_TAGS);
    Ok(TagList { tags: list, truncated })
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
    // `switch` only ever resolves a BRANCH: a tag or path with the same name cannot be picked instead
    // (`checkout <name>` is ambiguous), and `--no-guess` never creates a branch from a remote one.
    run_git(root, &["switch", "--no-guess", name], 64 * 1024).map(|_| ()).map_err(map_checkout_error)
}

pub fn create_branch(root: &Path, name: &str) -> R<()> {
    valid_branch_name(name)?;
    if branch_exists(root, name) {
        return gerr("exists", format!("a branch named {} already exists", line(name, 80)));
    }
    run_git(root, &["switch", "-c", name], 64 * 1024).map(|_| ()).map_err(map_checkout_error)
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

// ---- branch delete, tag create, stash ----------------------------------------------------

/// `git` said no (exit 1 for a plain question such as `--is-ancestor`): `false`. Refused repos, timeouts and a
/// missing git stay errors.
fn git_says(res: R<crate::git::Out>) -> R<bool> {
    match res {
        Ok(_) => Ok(true),
        Err(e) if e.code == "git_failed" => Ok(false),
        Err(e) => Err(e),
    }
}

fn map_git_error<T>(res: R<T>, code: &'static str, message: &str) -> R<T> {
    res.map_err(|e| if e.code == "git_failed" { FsError { code, message: message.into() } } else { e })
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BranchDelete {
    Deleted,
    /// Refused without changing anything: the branch has commits no merged branch contains. Carries what the
    /// second, explicit confirmation needs to name.
    NotMerged { tip: String, unique_commits: usize },
}

/// Merged means: an ancestor of HEAD, or of the branch's upstream (the two places `git branch -d` looks).
fn merged(root: &Path, name: &str) -> R<bool> {
    let r = format!("refs/heads/{name}");
    if git_says(run_git(root, &["merge-base", "--is-ancestor", &r, "HEAD"], 256))? {
        return Ok(true);
    }
    match run_git(root, &["rev-parse", "--verify", "-q", &format!("{r}@{{upstream}}")], 256) {
        Ok(up) => {
            let up = String::from_utf8_lossy(&up.stdout).trim().to_string();
            git_says(run_git(root, &["merge-base", "--is-ancestor", &r, &up], 256))
        }
        Err(e) if e.code == "git_failed" => Ok(false),
        Err(e) => Err(e),
    }
}

/// Commits reachable from the branch and from no other local branch (or HEAD): what a forced delete loses.
fn unique_commits(root: &Path, name: &str) -> R<usize> {
    let r = format!("refs/heads/{name}");
    // Every other local branch is listed explicitly: `--exclude` did not drop the branch itself on git 2.54.
    let others = run_git(root, &["for-each-ref", "--format=%(refname)", "refs/heads/"], 4 * 1024 * 1024)?;
    let mut args: Vec<String> = vec!["rev-list".into(), "--count".into(), r.clone(), "--not".into()];
    if has_head(root)? {
        args.push("HEAD".into());
    }
    args.extend(String::from_utf8_lossy(&others.stdout).lines().filter(|l| *l != r).map(str::to_string));
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_git(root, &refs, 256)?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0))
}

/// Deletes a local branch. Refuses the current branch and anything that is not a local branch ref; a branch
/// that is not merged is NOT deleted: the result says so (`NotMerged`) and the caller decides on a forced delete.
/// Every actual deletion goes through `confirm` first (the host's native dialog in the app).
pub fn branch_delete(root: &Path, name: &str, force: bool, confirm: &dyn Fn(&str) -> bool) -> R<BranchDelete> {
    valid_branch_name(name)?;
    if !branch_exists(root, name) {
        return gerr("not_found", format!("no local branch named {}", line(name, 80)));
    }
    if status(root)?.branch.as_deref() == Some(name) {
        return gerr("current_branch", "you are on this branch. Switch to another branch, then delete it");
    }
    let wt = run_git(root, &["worktree", "list", "--porcelain"], 1024 * 1024)?;
    let checked_out = format!("branch refs/heads/{name}");
    if String::from_utf8_lossy(&wt.stdout).lines().any(|l| l == checked_out) {
        return gerr("checked_out", "this branch is checked out in another worktree. Switch that worktree to another branch first");
    }
    let shown = line(name, 80);
    let tip_of = || run_git(root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")], 256).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    if !force {
        if !merged(root, name)? {
            let tip = String::from_utf8_lossy(&run_git(root, &["rev-parse", "--short", &format!("refs/heads/{name}")], 256)?.stdout).trim().to_string();
            return Ok(BranchDelete::NotMerged { tip, unique_commits: unique_commits(root, name)? });
        }
        if !confirm(&format!("Delete the local branch \u{201C}{shown}\u{201D}? It is fully merged, so no commits are lost. Remote branches are not touched.")) {
            return gerr("cancelled", "branch delete cancelled");
        }
        map_git_error(run_git(root, &["branch", "-d", name], 64 * 1024), "not_merged", "the branch is no longer fully merged (it changed while the confirmation was open). Nothing was deleted")?;
    } else {
        let tip = tip_of()?;
        let n = unique_commits(root, name)?;
        let prompt = format!("Delete the unmerged branch \u{201C}{shown}\u{201D} at {}? This loses {n} commit(s) that are not on any other local branch.", &tip[..7.min(tip.len())]);
        if !confirm(&prompt) {
            return gerr("cancelled", "branch delete cancelled");
        }
        // The dialog named this tip and count: a branch that moved meanwhile is not force-deleted.
        if tip_of().ok().as_deref() != Some(tip.as_str()) {
            return gerr("changed", "the branch changed while the confirmation was open. Nothing was deleted");
        }
        run_git(root, &["branch", "-D", name], 64 * 1024)?;
    }
    Ok(BranchDelete::Deleted)
}

fn valid_tag_name(root: &Path, name: &str) -> R<()> {
    let bad = |why: &str| gerr("invalid_ref", format!("not a valid tag name: {why}"));
    if name.is_empty() || name.len() > 200 {
        return bad("1 to 200 bytes");
    }
    if name.starts_with('-') {
        return bad("it must not start with '-'");
    }
    if name.chars().any(|c| c.is_control() || crate::tray::is_invisible_format(c)) {
        return bad("it contains a control or invisible character");
    }
    // Git's own rule, so nothing we accept is looser than git's (`--allow-onelevel` as the tag command uses).
    map_git_error(
        run_git(root, &["check-ref-format", "--allow-onelevel", &format!("refs/tags/{name}")], 256).map(|_| ()),
        "invalid_ref",
        "not a valid tag name: git does not allow that name (no spaces, ~ ^ : ? * [ \\, \"..\", \"@{\", or a part ending in .lock)",
    )
}

/// Full commit id for a tag target: HEAD (the default), a commit id, or a branch / tag name.
fn tag_target(root: &Path, target: Option<&str>) -> R<String> {
    let t = target.map(str::trim).filter(|t| !t.is_empty()).unwrap_or("HEAD");
    let plain = t == "HEAD" || is_hex(&t.to_ascii_lowercase()) || valid_branch_name(t).is_ok();
    if !plain {
        return gerr("invalid_ref", "the tag target must be HEAD, a branch, a tag or a commit id");
    }
    let spec = format!("{t}^{{commit}}");
    let out = map_git_error(run_git(root, &["rev-parse", "--verify", "-q", &spec], 256), "not_found", &format!("there is no commit named {}", line(t, 80)))?;
    let full = String::from_utf8_lossy(&out.stdout).trim().to_ascii_lowercase();
    if !is_hex(&full) {
        return gerr("not_found", format!("there is no commit named {}", line(t, 80)));
    }
    Ok(full)
}

/// Creates a tag and never moves an existing one (no `-f`). With a message it is annotated, with the
/// user's own identity as tagger (never GPG-signed); without one it is lightweight and needs no identity. Nothing is pushed.
pub fn tag_create(root: &Path, name: &str, message: Option<&str>, target: Option<&str>, home: &Option<PathBuf>) -> R<Tag> {
    valid_tag_name(root, name)?;
    if message.is_some_and(|m| m.len() > MAX_TAG_MESSAGE) {
        return gerr("too_large", format!("the tag message is longer than {MAX_TAG_MESSAGE} bytes"));
    }
    if run_git(root, &["rev-parse", "--verify", "-q", &format!("refs/tags/{name}")], 256).is_ok() {
        return gerr("exists", format!("a tag named {} already exists. Tags are never moved here", line(name, 80)));
    }
    let commit = tag_target(root, target)?;
    let text = message.map(str::trim).filter(|m| !m.is_empty()).map(validate_message).transpose()?;
    match &text {
        None => {
            run_git(root, &["tag", name, &commit], 64 * 1024)?;
        }
        Some(msg) => {
            let id = identity(root, home)?;
            let env = vec![("GIT_COMMITTER_NAME", id.name), ("GIT_COMMITTER_EMAIL", id.email)];
            run_git_opts(
                root,
                &["-c", "tag.gpgsign=false", "-c", "tag.forceSignAnnotated=false", "tag", "-a", "-F", "-", name, &commit],
                64 * 1024,
                &Opts { stdin: Some(msg.as_bytes()), env, ..Opts::default() },
            )?;
        }
    }
    Ok(Tag { name: name.to_string(), target: commit.chars().take(7).collect(), annotated: text.is_some() })
}

const MAX_TAG_MESSAGE: usize = 2048;
pub const MAX_STASHES: usize = 100;
const MAX_STASH_MESSAGE: usize = 2048;

#[derive(Serialize, Debug, PartialEq)]
pub struct Stash {
    /// Position in the list: `stash@{index}`. Newest is 0.
    pub index: usize,
    /// Full commit id of the entry. Apply, pop and drop send it back so a list that changed since it was shown
    /// is refused instead of acting on whatever entry now sits at `index`.
    pub hash: String,
    pub message: String,
}

#[derive(Serialize, Debug)]
pub struct StashList {
    pub stashes: Vec<Stash>,
    pub truncated: bool,
}

/// Stash entries, newest first, at most `MAX_STASHES`. Read-only. Records are NUL-separated, the hash and the
/// subject unit-separated (neither can contain either byte).
pub fn stash_list(root: &Path) -> R<StashList> {
    let out = run_git(root, &["stash", "list", "-z", "--format=%H%x1f%gs", &format!("--max-count={}", MAX_STASHES + 1)], 1024 * 1024)?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut all: Vec<(&str, &str)> = text.split('\0').filter_map(|s| s.split_once('\u{1f}')).filter(|(h, _)| is_hex(h)).collect();
    let truncated = all.len() > MAX_STASHES;
    all.truncate(MAX_STASHES);
    let stashes =
        all.into_iter().enumerate().map(|(index, (h, m))| Stash { index, hash: h.to_string(), message: line(m, 200) }).collect();
    Ok(StashList { stashes, truncated })
}

/// `stash@{N}` and a dialog label, for an entry that sits at `index` with commit `hash` right now. The index is
/// an integer and the hash is checked as hex, so no refspec text from the webview ever reaches git.
fn stash_entry(root: &Path, index: usize, hash: &str) -> R<(String, String)> {
    let hash = hash.to_ascii_lowercase();
    if hash.len() < 40 || !is_hex(&hash) {
        return gerr("invalid_ref", "not a stash id");
    }
    let spec = format!("stash@{{{index}}}");
    let out = map_git_error(run_git(root, &["rev-parse", "--verify", "-q", &format!("refs/{spec}")], 256), "not_found", &format!("there is no stash {index}"))?;
    if String::from_utf8_lossy(&out.stdout).trim() != hash {
        return gerr("changed", "the stash list changed since it was shown. Nothing was changed: check the list and try again");
    }
    let subject = run_git(root, &["stash", "list", "--skip", &index.to_string(), "--max-count=1", "--format=%gs"], 1024)
        .map(|o| line(&String::from_utf8_lossy(&o.stdout), 200))
        .unwrap_or_default();
    Ok((spec, format!("{subject} ({})", &hash[..7])))
}

fn conflicted(root: &Path) -> bool {
    status(root).is_ok_and(|s| s.entries.iter().any(|e| e.kind == "unmerged"))
}

/// Maps a failed apply or pop: conflicts are git's own state (left in place for the user), a dirty tree is
/// refused by git before anything changes.
fn map_stash_error(root: &Path, e: FsError) -> FsError {
    if e.code != "git_failed" {
        return e;
    }
    if conflicted(root) {
        return FsError { code: "conflicts", message: "The stash did not apply cleanly. The conflicted files are marked in Source Control: edit them, then stage each one. Git kept the stash in the list.".into() };
    }
    if e.message.contains("would be overwritten") || e.message.contains("local changes") {
        return FsError { code: "dirty_stash", message: "your uncommitted changes would be overwritten. Commit or discard them first. Nothing was changed.".into() };
    }
    e
}

/// Stashes the working tree (tracked changes, and untracked files when asked), like the Mac's stash. Needs the
/// user's identity because a stash is a commit. Refuses an unmerged tree and an empty change set.
pub fn stash_push(root: &Path, message: &str, include_untracked: bool, home: &Option<PathBuf>) -> R<()> {
    if message.len() > MAX_STASH_MESSAGE {
        return gerr("too_large", format!("the stash message is longer than {MAX_STASH_MESSAGE} bytes"));
    }
    let msg = line(message, 200);
    let st = status(root)?;
    if st.entries.iter().any(|e| e.kind == "unmerged") {
        return gerr("conflict", "resolve the conflicted files before stashing");
    }
    let any = if include_untracked { !st.entries.is_empty() } else { st.entries.iter().any(|e| e.kind != "untracked") };
    if !any {
        return gerr("nothing_to_stash", "there are no local changes to stash");
    }
    if !has_head(root)? {
        return gerr("no_commits", "make the first commit before stashing");
    }
    let id = identity(root, home)?;
    let env = vec![
        ("GIT_AUTHOR_NAME", id.name.clone()),
        ("GIT_AUTHOR_EMAIL", id.email.clone()),
        ("GIT_COMMITTER_NAME", id.name),
        ("GIT_COMMITTER_EMAIL", id.email),
    ];
    let mut args = vec!["-c", "commit.gpgsign=false", "stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    let m = format!("--message={msg}");
    if !msg.is_empty() {
        args.push(&m);
    }
    // No paths are passed, so the glob setting only lets git see the untracked files it must stash.
    run_git_opts(root, &args, 64 * 1024, &Opts { env, glob_pathspecs: true, ..Opts::default() }).map(|_| ())
}

/// Git refuses to apply onto an unmerged index; saying so first keeps that apart from a stash that conflicts.
fn refuse_unmerged(root: &Path) -> R<()> {
    if conflicted(root) {
        return gerr("conflict", "resolve the conflicted files before applying a stash");
    }
    Ok(())
}

pub fn stash_apply(root: &Path, index: usize, hash: &str) -> R<()> {
    refuse_unmerged(root)?;
    let (spec, _) = stash_entry(root, index, hash)?;
    run_git(root, &["stash", "apply", &spec], 64 * 1024).map(|_| ()).map_err(|e| map_stash_error(root, e))
}

pub fn stash_pop(root: &Path, index: usize, hash: &str, confirm: &dyn Fn(&str) -> bool) -> R<()> {
    refuse_unmerged(root)?;
    let (_, label) = stash_entry(root, index, hash)?;
    let prompt = format!(
        "Pop the stash \u{201C}{label}\u{201D}? Its changes go into your working tree and the stash is removed from the list. If they conflict with your files, Git stops and keeps the stash."
    );
    if !confirm(&prompt) {
        return gerr("cancelled", "pop cancelled");
    }
    // Checked again: the list can change while the dialog is open.
    let (spec, _) = stash_entry(root, index, hash)?;
    run_git(root, &["stash", "pop", &spec], 64 * 1024).map(|_| ()).map_err(|e| map_stash_error(root, e))
}

pub fn stash_drop(root: &Path, index: usize, hash: &str, confirm: &dyn Fn(&str) -> bool) -> R<()> {
    let (_, label) = stash_entry(root, index, hash)?;
    if !confirm(&format!("Drop the stash \u{201C}{label}\u{201D}? Its changes are removed from the list and cannot be recovered from LLM-IDE.")) {
        return gerr("cancelled", "drop cancelled");
    }
    let (spec, _) = stash_entry(root, index, hash)?;
    run_git(root, &["stash", "drop", &spec], 64 * 1024).map(|_| ())
}

// ---- merge, amend, discard all ---------------------------------------------------------------

const MAX_AMEND_MESSAGE: usize = 64 * 1024;
/// Untracked items one whole-tree discard may move to the Trash.
pub const MAX_TRASH_ENTRIES: usize = 2_000;
const MAX_CONFLICT_PATHS: usize = 200;
const BULK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// The git operation in progress (merge, cherry-pick, revert, rebase, am), read from git's own state files.
fn operation_in_progress(root: &Path) -> R<Option<&'static str>> {
    for (refname, what) in [("MERGE_HEAD", "A merge"), ("CHERRY_PICK_HEAD", "A cherry-pick"), ("REVERT_HEAD", "A revert")] {
        if git_says(run_git(root, &["rev-parse", "-q", "--verify", refname], 256))? {
            return Ok(Some(what));
        }
    }
    for (dir, what) in [("rebase-merge", "A rebase"), ("rebase-apply", "A rebase or mail patch")] {
        let out = run_git(root, &["rev-parse", "--git-path", dir], 4096)?;
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let full = if Path::new(&path).is_absolute() { PathBuf::from(&path) } else { root.join(&path) };
        if full.exists() {
            return Ok(Some(what));
        }
    }
    Ok(None)
}

fn refuse_in_progress<T>(what: &str) -> R<T> {
    gerr("in_progress", format!("{what} is in progress. Finish it or abort it first."))
}

/// Full id of the commit `refname` names (`HEAD`, `refs/heads/x`).
fn full_id(root: &Path, refname: &str) -> R<String> {
    let out = run_git(root, &["rev-parse", "--verify", "-q", &format!("{refname}^{{commit}}")], 256)?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn short_head(root: &Path) -> R<String> {
    let out = run_git(root, &["rev-parse", "--short", "HEAD"], 256)?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The branch HEAD names, or `None` when HEAD is detached.
fn head_branch(root: &Path) -> R<Option<String>> {
    match run_git(root, &["symbolic-ref", "-q", "HEAD"], 1024) {
        Ok(o) => Ok(String::from_utf8_lossy(&o.stdout).trim().strip_prefix("refs/heads/").map(str::to_string)),
        Err(e) if e.code == "git_failed" => Ok(None),
        Err(e) => Err(e),
    }
}

fn identity_env(id: &Identity) -> Vec<(&'static str, String)> {
    vec![
        ("GIT_AUTHOR_NAME", id.name.clone()),
        ("GIT_AUTHOR_EMAIL", id.email.clone()),
        ("GIT_COMMITTER_NAME", id.name.clone()),
        ("GIT_COMMITTER_EMAIL", id.email.clone()),
    ]
}

// ---- merge ------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MergeMode {
    FastForward,
    NoFastForward,
}

/// Absent or `ff` fast-forwards when git can (the Mac's plain merge); `no_ff` always records a merge commit.
pub fn merge_mode(raw: Option<&str>) -> R<MergeMode> {
    match raw {
        None | Some("ff") => Ok(MergeMode::FastForward),
        Some("no_ff") => Ok(MergeMode::NoFastForward),
        Some(_) => gerr("invalid_mode", "the merge mode must be ff or no_ff"),
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MergeOutcome {
    /// `hash` is the new short HEAD; `fast_forward` means no merge commit was made.
    Merged { hash: String, fast_forward: bool },
    /// Git stopped with conflicts and kept the merge in progress: resolve in Changes, or abort the merge.
    Conflicts { paths: Vec<String>, truncated: bool },
}

/// Merges the local branch `name` into the current branch. Refuses any uncommitted change (untracked files
/// included), an operation already in progress, a detached HEAD and the current branch itself. The dialog
/// names both branches and whether git will fast-forward or create a merge commit; a branch that moved while it
/// was open is refused (`changed`).
pub fn merge(root: &Path, name: &str, mode: MergeMode, home: &Option<PathBuf>, confirm: &dyn Fn(&str) -> bool) -> R<MergeOutcome> {
    valid_branch_name(name)?;
    if !branch_exists(root, name) {
        return gerr("not_found", format!("no local branch named {}", line(name, 80)));
    }
    if let Some(what) = operation_in_progress(root)? {
        return refuse_in_progress(what);
    }
    let Some(current) = head_branch(root)? else {
        return gerr("detached", "HEAD is not on a branch. Switch to a branch, then merge into it");
    };
    if current == name {
        return gerr("current_branch", "you are on this branch. Merge a different branch into it");
    }
    if !has_head(root)? {
        return gerr("no_commits", "there are no commits yet, so there is nothing to merge into");
    }
    let st = status(root)?;
    if st.entries.iter().any(|e| e.kind == "unmerged") {
        return gerr("conflict", "resolve the conflicted files first");
    }
    if !st.entries.is_empty() {
        let untracked = st.entries.iter().filter(|e| e.kind == "untracked").count();
        return gerr("dirty", format!("{} uncommitted change(s), {untracked} of them untracked, are in the working tree or index. Untracked files count too, because a merge can overwrite them. Commit, stash or discard them first. Nothing was merged.", st.entries.len()));
    }
    let id = identity(root, home)?;
    let target = format!("refs/heads/{name}");
    if git_says(run_git(root, &["merge-base", "--is-ancestor", &target, "HEAD"], 256))? {
        return gerr("up_to_date", format!("{} is already part of {}. Nothing to merge.", line(name, 80), line(&current, 80)));
    }
    let fast = git_says(run_git(root, &["merge-base", "--is-ancestor", "HEAD", &target], 256))?;
    let fast_forward = fast && mode == MergeMode::FastForward;
    let (head, tip) = (full_id(root, "HEAD")?, full_id(root, &target)?);
    let (src, dst) = (line(name, 80), line(&current, 80));
    let prompt = if fast_forward {
        format!("Merge \u{201C}{src}\u{201D} into \u{201C}{dst}\u{201D}? It fast-forwards \u{201C}{dst}\u{201D} to \u{201C}{src}\u{201D}, so no merge commit is made.")
    } else {
        format!("Merge \u{201C}{src}\u{201D} into \u{201C}{dst}\u{201D}? It creates a merge commit on \u{201C}{dst}\u{201D}. If both branches changed the same lines, Git stops with conflicts and keeps the merge in progress for you to resolve.")
    };
    if !confirm(&prompt) {
        return gerr("cancelled", "merge cancelled");
    }
    // The dialog named these two tips and this branch: anything that moved meanwhile is not merged.
    if full_id(root, "HEAD")? != head || full_id(root, &target)? != tip || head_branch(root)?.as_deref() != Some(current.as_str()) {
        return gerr("changed", "a branch moved while the confirmation was open. Nothing was merged");
    }
    let flag = if fast_forward { "--ff" } else { "--no-ff" };
    // Explicit flag and no hooks: a repo-local `merge.ff` or hook cannot change what the dialog named.
    let res = run_git_opts(
        root,
        &["-c", "commit.gpgsign=false", "merge", flag, "--no-edit", "--no-verify", "--no-gpg-sign", &target],
        64 * 1024,
        &Opts { env: identity_env(&id), timeout: Some(BULK_TIMEOUT), ..Opts::default() },
    );
    match res {
        Ok(_) => Ok(MergeOutcome::Merged { hash: short_head(root)?, fast_forward }),
        Err(e) if e.code == "git_failed" => {
            let st = status(root)?;
            let mut paths: Vec<String> = st.entries.iter().filter(|e| e.kind == "unmerged").map(|e| line(&e.path, 300)).collect();
            if paths.is_empty() {
                return Err(map_merge_error(e));
            }
            let truncated = paths.len() > MAX_CONFLICT_PATHS;
            paths.truncate(MAX_CONFLICT_PATHS);
            Ok(MergeOutcome::Conflicts { paths, truncated })
        }
        Err(e) => Err(e),
    }
}

fn map_merge_error(e: FsError) -> FsError {
    if e.message.contains("would be overwritten") {
        return FsError { code: "would_overwrite", message: "the merge would overwrite local files. Commit, stash or move them first. Nothing was merged.".into() };
    }
    e
}

/// Runs `git merge --abort` when a merge is in progress (MERGE_HEAD exists). Asks first: the files the merge touched go
/// back to how they were before it, so edits made to resolve conflicts are lost.
pub fn merge_abort(root: &Path, confirm: &dyn Fn(&str) -> bool) -> R<()> {
    if !git_says(run_git(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"], 256))? {
        return gerr("not_in_progress", "no merge is in progress");
    }
    if !confirm("Abort the merge? Git puts the files back to how they were before the merge. Edits you made to resolve conflicts are lost.") {
        return gerr("cancelled", "abort cancelled");
    }
    run_git(root, &["merge", "--abort"], 64 * 1024).map(|_| ())
}

// ---- amend ------------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AmendReq {
    #[serde(default)]
    pub message: Option<String>,
    /// Second step after `already_pushed`: amend a commit that is already on a remote branch.
    #[serde(default)]
    pub force: bool,
}

/// The new message, validated and ending in one newline, or `None` when blank (the old message stays).
fn amend_message(raw: Option<&str>) -> R<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.len() > MAX_AMEND_MESSAGE {
        return gerr("too_large", "the commit message is longer than 64 KB");
    }
    let clean = sanitize_text(&raw.replace("\r\n", "\n").replace('\r', "\n"));
    let msg = clean.trim();
    if msg.is_empty() {
        return Ok(None);
    }
    if msg.starts_with('-') {
        return gerr("invalid_message", "the commit message must not start with '-'");
    }
    Ok(Some(format!("{msg}\n")))
}

/// The staged entries, as `path<US>index` strings: what the amended commit would hold.
fn staged_of(st: &GitStatus) -> Vec<String> {
    st.entries.iter().filter(|e| e.kind != "untracked" && e.index != '.').map(|e| format!("{}\u{1f}{}", e.path, e.index)).collect()
}

/// True when HEAD's commit is reachable from a remote-tracking branch, so it has been published.
fn published(root: &Path) -> R<bool> {
    let out = run_git(root, &["branch", "-r", "--contains", "HEAD", "--format=%(refname)"], 1024 * 1024)?;
    Ok(!String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

fn head_message(root: &Path) -> R<String> {
    let out = run_git(root, &["log", "-1", "--format=%B", "HEAD"], MAX_AMEND_MESSAGE + 4096)?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `abc1234 “subject”` for the last commit, for the dialog.
fn head_summary(root: &Path) -> R<String> {
    let out = run_git(root, &["log", "-1", "--format=%h%x1f%s", "HEAD"], 4096)?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (hash, subject) = text.trim().split_once('\u{1f}').unwrap_or(("", ""));
    Ok(format!("{hash} \u{201C}{}\u{201D}", line(subject, 120)))
}

/// Amends the last commit with the staged changes and an optional new message. The author is kept; the committer is
/// the user. A published commit is refused (`already_pushed`) unless `force` is set, and then the dialog says so.
pub fn commit_amend(root: &Path, message: Option<&str>, force: bool, home: &Option<PathBuf>, confirm: &dyn Fn(&str) -> bool) -> R<CommitResult> {
    let msg = amend_message(message)?;
    if !has_head(root)? {
        return gerr("no_commits", "there is no commit to amend yet. Make the first commit instead");
    }
    if let Some(what) = operation_in_progress(root)? {
        return refuse_in_progress(what);
    }
    let st = status(root)?;
    if st.entries.iter().any(|e| e.kind == "unmerged") {
        return gerr("conflict", "resolve the conflicted files before amending");
    }
    let staged = staged_of(&st);
    if msg.is_none() && staged.is_empty() {
        return gerr("nothing_to_amend", "nothing is staged and there is no new message, so there is nothing to amend");
    }
    if staged.is_empty() && msg.as_deref().map(str::trim_end) == Some(head_message(root)?.trim_end()) {
        return gerr("nothing_to_amend", "nothing is staged and the message is the same, so there is nothing to amend");
    }
    let id = identity(root, home)?;
    let is_published = published(root)?;
    if is_published && !force {
        return gerr("already_pushed", "this commit is already on a remote branch. Amending rewrites it, so a later push needs a force push. Amend anyway only if you are sure.");
    }
    let head = full_id(root, "HEAD")?;
    let mut prompt = format!(
        "Amend the last commit {}? The {} staged file(s) become its changes. {}The author stays the same and the committer becomes you. The old version can be recovered only from the reflog.",
        head_summary(root)?,
        staged.len(),
        if msg.is_some() { "Its message is replaced. " } else { "Its message stays the same. " },
    );
    if is_published {
        prompt.push_str(" This commit already exists on a remote. Amending it changes its id, so a later push will need a force push.");
    }
    if !confirm(&prompt) {
        return gerr("cancelled", "amend cancelled");
    }
    let after = status(root)?;
    if full_id(root, "HEAD")? != head || staged_of(&after) != staged {
        return gerr("changed", "the last commit or the staged files changed while the confirmation was open. Nothing was amended");
    }
    // Only the committer comes from the identity: `--amend` keeps the original author (no GIT_AUTHOR_* is set).
    let env = vec![("GIT_COMMITTER_NAME", id.name), ("GIT_COMMITTER_EMAIL", id.email)];
    let mut args = vec!["-c", "commit.gpgsign=false", "commit", "--amend", "--no-verify", "--no-gpg-sign", "--cleanup=whitespace"];
    if msg.is_some() {
        args.extend(["-F", "-"]);
    } else {
        args.push("--no-edit");
    }
    run_git_opts(root, &args, 64 * 1024, &Opts { stdin: msg.as_deref().map(str::as_bytes), env, ..Opts::default() })?;
    Ok(CommitResult { hash: short_head(root)?, skipped: commit_skips(root, home) })
}

// ---- discard all -----------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
pub struct DiscardAllResult {
    /// Tracked paths reset to HEAD (staged and unstaged).
    pub restored: u32,
    /// Untracked items moved to the Trash.
    pub trashed: u32,
    /// Items left in place: symbolic links, nested repositories, or a Trash refusal.
    pub skipped: u32,
}

#[derive(Deserialize)]
pub struct DiscardAllReq {
    #[serde(default)]
    pub include_untracked: bool,
}

#[derive(Debug, PartialEq)]
struct AllPlan {
    restore: Vec<String>,
    trash: Vec<String>,
    skipped: u32,
}

/// Why an untracked path stays where it is: a symbolic link (or a path behind one), a nested repository.
/// `Some("missing")` when it is gone already. `None` when it is a plain file or folder that may be trashed.
fn keep_reason(root: &Path, rel: &str) -> Option<&'static str> {
    let mut cur = root.to_path_buf();
    for part in rel.split('/') {
        cur.push(part);
        match std::fs::symlink_metadata(&cur) {
            Err(_) => return Some("missing"),
            Ok(m) if m.file_type().is_symlink() => return Some("a symbolic link"),
            Ok(_) => {}
        }
    }
    if cur.is_dir() && cur.join(".git").exists() {
        return Some("a nested git repository");
    }
    None
}

/// True when `dir` or any folder under it holds a `.git` (ignored folders included). Symlinks are not followed.
fn has_nested_repo(dir: &Path) -> bool {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if d.join(".git").exists() {
            return true;
        }
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(e.path());
            }
        }
    }
    false
}

/// Classifies every change from a fresh status. Nothing is touched here.
fn plan_discard_all(root: &Path, include_untracked: bool) -> R<AllPlan> {
    if !has_head(root)? {
        return gerr("no_commits", "there are no commits yet, so there is no HEAD to restore to");
    }
    if let Some(what) = operation_in_progress(root)? {
        return refuse_in_progress(what);
    }
    let st = status(root)?;
    if st.entries.iter().any(|e| e.kind == "unmerged") {
        return gerr("conflict", "resolve the conflicted files first");
    }
    if st.truncated {
        return gerr("too_many", "there are too many changes to list in one step. Nothing was changed.");
    }
    let mut plan = AllPlan { restore: Vec::new(), trash: Vec::new(), skipped: 0 };
    let mut added = Vec::new();
    for e in &st.entries {
        if e.submodule {
            return gerr("submodule", format!("{} is a submodule; discard its changes inside it", line(&e.path, 200)));
        }
        if e.kind != "untracked" {
            plan.restore.push(e.path.clone());
            // A staged new, renamed or copied file, or an intent-to-add one, is untracked once the index is reset.
            if matches!(e.index, 'A' | 'R' | 'C') || e.worktree == 'A' {
                added.push(e.path.clone());
            }
        }
    }
    if include_untracked {
        // Files, never folders: status folds an untracked folder into `dir/`, which can hold ignored files and a
        // nested repository at any depth. `ls-files --others` lists each file and stops at a nested repo (`sub/`).
        let out = run_git(root, &["ls-files", "-z", "--others", "--exclude-standard"], 8 * 1024 * 1024)?;
        if out.truncated {
            return gerr("too_many", "there are too many untracked files to list in one step. Nothing was changed.");
        }
        let mut cands: Vec<String> = out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
        // A force-added ignored file becomes ignored, not untracked, once unstaged: it stays (as on the Mac).
        // check-ignore rejects literal pathspecs; it only reads, and a magic-looking name at worst fails the plan.
        if !added.is_empty() {
            let list: Vec<u8> = added.iter().flat_map(|p| p.bytes().chain([0])).collect();
            let res = run_git_opts(root, &["check-ignore", "--no-index", "-z", "--stdin"], 1024 * 1024, &Opts { stdin: Some(&list), glob_pathspecs: true, ..Opts::default() });
            let ignored: Vec<String> = match res {
                Ok(o) => o.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect(),
                Err(e) if e.code == "git_failed" && e.message.is_empty() => Vec::new(), // exit 1: none ignored
                Err(e) => return Err(e),
            };
            cands.extend(added.into_iter().filter(|p| !ignored.contains(p)));
        }
        for rel in cands {
            // A nested repository (`sub/`), or a name the Trash step refuses (control characters): counted, left.
            if rel.ends_with('/') || rel.chars().any(char::is_control) || rel_arg(&rel).is_err() {
                plan.skipped += 1;
                continue;
            }
            match keep_reason(root, &rel) {
                None => plan.trash.push(rel),
                Some("missing") => {}
                Some(_) => plan.skipped += 1,
            }
        }
    }
    if plan.trash.len() > MAX_TRASH_ENTRIES {
        return gerr("too_many", format!("{} untracked items would be moved to the Trash, more than the {MAX_TRASH_ENTRIES} allowed in one step. Move some by hand, then try again. Nothing was changed.", plan.trash.len()));
    }
    Ok(plan)
}

fn discard_all_prompt(plan: &AllPlan, include_untracked: bool) -> String {
    let mut s = format!("{} file(s) will be reset to HEAD, staged and unstaged. This cannot be undone.\n", plan.restore.len());
    if include_untracked {
        s.push_str(&format!("{} untracked item(s) will be moved to the Trash.\n", plan.trash.len()));
    } else {
        s.push_str("Untracked files are not touched.\n");
    }
    if plan.skipped > 0 {
        s.push_str(&format!("{} item(s) will be left in place (symbolic links, nested repositories, names with control characters).\n", plan.skipped));
    }
    // The repository's ignore rules and the user's global ignore file both apply (`git::user_data_args`).
    s.push_str("Ignored files (the repository's .gitignore and your global ignore file) are never touched. Folders stay; only files move.\n\n");
    for p in plan.restore.iter().chain(plan.trash.iter()).take(12) {
        s.push_str(&format!("  {}\n", line(p, 80)));
    }
    let total = plan.restore.len() + plan.trash.len();
    if total > 12 {
        s.push_str(&format!("  ...and {} more\n", total - 12));
    }
    s
}

/// Restores every tracked change to HEAD (index and worktree) and moves untracked items to the Trash when asked.
/// Never `git clean`, never a permanent delete, never an ignored file. Asks first; the plan and the file contents are
/// checked again after the dialog and anything that changed meanwhile aborts with `changed_since_confirm`.
pub fn discard_all_with(root: &Path, include_untracked: bool, confirm: &dyn Fn(&str) -> bool, trasher: &dyn crate::trash_guard::Trasher) -> R<DiscardAllResult> {
    let plan = plan_discard_all(root, include_untracked)?;
    if plan.restore.is_empty() && plan.trash.is_empty() {
        return gerr("nothing_to_discard", "there are no changes to discard");
    }
    let fingerprints_of = |p: &AllPlan| -> Vec<String> { p.restore.iter().chain(p.trash.iter()).map(|rel| fingerprint(root, rel)).collect() };
    let before = fingerprints_of(&plan);
    if !confirm(&discard_all_prompt(&plan, include_untracked)) {
        return gerr("cancelled", "discard cancelled");
    }
    let again = plan_discard_all(root, include_untracked)?;
    if again != plan || fingerprints_of(&again) != before {
        return gerr("changed_since_confirm", "the files changed while the dialog was open; nothing was discarded");
    }
    if !plan.restore.is_empty() {
        // Two steps, never one: `--staged --worktree` together deleted a staged NEW file from disk. Unstaging first
        // leaves such a file on disk as an untracked file, and the worktree step then only writes tracked paths.
        // `.` is literal under the runner's literal-pathspec setting: the whole tree.
        let opts = Opts { timeout: Some(crate::git::scaled_timeout(plan.restore.len())), ..Opts::default() };
        run_git_opts(root, &["restore", "--source=HEAD", "--staged", "--", "."], 64 * 1024, &opts)?;
        run_git_opts(root, &["restore", "--source=HEAD", "--worktree", "--", "."], 64 * 1024, &opts)?;
    }
    let (mut trashed, mut skipped) = (0u32, plan.skipped);
    for rel in &plan.trash {
        // A refusing Trash leaves the item in place and is counted, never turned into a permanent delete.
        match crate::fs_ops::delete_with(root, rel, trasher) {
            Ok(()) => trashed += 1,
            Err(_) => skipped += 1,
        }
    }
    Ok(DiscardAllResult { restored: plan.restore.len() as u32, trashed, skipped })
}

pub fn discard_all(root: &Path, include_untracked: bool, confirm: &dyn Fn(&str) -> bool) -> R<DiscardAllResult> {
    discard_all_with(root, include_untracked, confirm, &crate::trash_guard::OsTrash)
}

// ---- Tauri commands --------------------------------------------------------------------

use crate::git::{blocking, blocking_scm};

#[derive(Deserialize)]
pub struct HunksReq {
    pub path: String,
    #[serde(default)]
    pub staged: bool,
}

#[tauri::command]
pub async fn git_diff_hunks(req: HunksReq) -> R<HunkDiff> {
    blocking_scm(move |s| diff_hunks(&s.repo, &s.to_repo(&req.path)?, req.staged)).await
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
    blocking_scm(move |s| stage_hunks(&s.repo, &s.to_repo(&req.path)?, req.staged, &req.diff_id, &req.hunks)).await
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
    blocking_scm(move |s| {
        let paths = s.to_repo_all(&paths)?;
        DESTRUCTIVE_DIALOGS.run(|| discard(&s.repo, &paths, &native_ask("Discard changes?", "Discard")))
    })
    .await
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
pub async fn git_tags() -> R<TagList> {
    blocking(|root| tags(&root)).await
}

#[tauri::command]
pub async fn git_log(req: LogReq) -> R<LogPage> {
    blocking(move |root| log(&root, req.skip, req.limit)).await
}

#[tauri::command]
pub async fn git_commit_files(hash: String) -> R<CommitDetail> {
    blocking_scm(move |s| {
        let mut detail = commit_files(&s.repo, &hash)?;
        for f in &mut detail.files {
            f.path = s.to_project(&f.path);
        }
        Ok(detail)
    })
    .await
}

#[derive(Deserialize)]
pub struct CommitDiffReq {
    pub hash: String,
    pub path: String,
}

#[tauri::command]
pub async fn git_commit_diff(req: CommitDiffReq) -> R<CommitDiff> {
    blocking_scm(move |s| commit_diff(&s.repo, &req.hash, &s.to_repo(&req.path)?)).await
}

#[tauri::command]
pub async fn git_branch_delete(name: String, force: bool) -> R<BranchDelete> {
    blocking(move |root| {
        let ask = if force { native_ask("Delete unmerged branch?", "Delete anyway") } else { native_ask("Delete branch?", "Delete") };
        DESTRUCTIVE_DIALOGS.run(|| branch_delete(&root, &name, force, &ask))
    })
    .await
}

#[tauri::command]
pub async fn git_tag_create(name: String, message: Option<String>, target: Option<String>) -> R<Tag> {
    blocking(move |root| tag_create(&root, &name, message.as_deref(), target.as_deref(), &None)).await
}

#[tauri::command]
pub async fn git_stash_list() -> R<StashList> {
    blocking(|root| stash_list(&root)).await
}

#[derive(Deserialize)]
pub struct StashPushReq {
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub include_untracked: bool,
}

#[tauri::command]
pub async fn git_stash_push(req: StashPushReq) -> R<()> {
    blocking(move |root| stash_push(&root, &req.message, req.include_untracked, &None)).await
}

#[tauri::command]
pub async fn git_stash_apply(index: usize, hash: String) -> R<()> {
    blocking(move |root| stash_apply(&root, index, &hash)).await
}

#[tauri::command]
pub async fn git_stash_pop(index: usize, hash: String) -> R<()> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| stash_pop(&root, index, &hash, &native_ask("Pop stash?", "Pop")))).await
}

#[tauri::command]
pub async fn git_stash_drop(index: usize, hash: String) -> R<()> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| stash_drop(&root, index, &hash, &native_ask("Drop stash?", "Drop")))).await
}

#[derive(Deserialize)]
pub struct MergeReq {
    pub name: String,
    #[serde(default)]
    pub mode: Option<String>,
}

#[tauri::command]
pub async fn git_merge(req: MergeReq) -> R<MergeOutcome> {
    blocking_scm(move |s| {
        let mode = merge_mode(req.mode.as_deref())?;
        let mut outcome = DESTRUCTIVE_DIALOGS.run(|| merge(&s.repo, &req.name, mode, &None, &native_ask("Merge branch?", "Merge")))?;
        if let MergeOutcome::Conflicts { paths, .. } = &mut outcome {
            for p in paths.iter_mut() {
                *p = s.to_project(p);
            }
        }
        Ok(outcome)
    })
    .await
}

#[tauri::command]
pub async fn git_merge_abort() -> R<()> {
    blocking(|root| DESTRUCTIVE_DIALOGS.run(|| merge_abort(&root, &native_ask("Abort merge?", "Abort merge")))).await
}

#[tauri::command]
pub async fn git_commit_amend(req: AmendReq) -> R<CommitResult> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| commit_amend(&root, req.message.as_deref(), req.force, &None, &native_ask("Amend last commit?", "Amend")))).await
}

#[tauri::command]
pub async fn git_discard_all(req: DiscardAllReq) -> R<DiscardAllResult> {
    blocking(move |root| DESTRUCTIVE_DIALOGS.run(|| discard_all(&root, req.include_untracked, &native_ask("Discard all changes?", "Discard all")))).await
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
            .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1")
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

    /// Whatever `valid_branch_name` accepts, git itself must accept (ours may be stricter, never looser).
    #[test]
    fn branch_name_validation_is_never_looser_than_git() {
        if !have_git() {
            return;
        }
        let mut corpus: Vec<String> = ["main", "a/b/c", "a.b", "a-b", "a_b", "ünï", "fix/é", "x@y", "@x", "a@", "a.lock", "a/.b", "a/b.lock/c", "a//b", "a/", "/a", "a.", ".a", "a..b", "a b", "a~", "a^", "a:", "a?", "a*", "a[", "a\\b", "a@{b", "@", "HEAD", "-a", "a\u{7f}b", "a\u{200b}b", "a\u{feff}", "💥", "a\u{85}b", "a.lock/", "refs/heads/x", "heads/x"].iter().map(|s| s.to_string()).collect();
        for i in 0..200u32 {
            let c = char::from_u32(i + 1).unwrap();
            corpus.push(format!("a{c}b"));
            corpus.push(format!("{c}ab"));
            corpus.push(format!("ab{c}"));
        }
        for name in corpus {
            if valid_branch_name(&name).is_ok() {
                let ok = Command::new("git").args(["check-ref-format", "--branch", &name]).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().map(|o| o.status.success()).unwrap_or(false);
                assert!(ok, "we accept {name:?} but git refuses it");
            }
        }
    }

    #[test]
    fn checkout_picks_the_branch_even_when_a_tag_has_the_same_name() {
        if !have_git() {
            return;
        }
        let r = repo("tagbranch");
        fs::write(r.join("a.txt"), "1\n").unwrap();
        g(&r, &["add", "."]);
        g(&r, &["commit", "-q", "-m", "one"]);
        g(&r, &["branch", "feat"]);
        g(&r, &["switch", "-q", "feat"]);
        fs::write(r.join("a.txt"), "2\n").unwrap();
        g(&r, &["commit", "-qam", "two"]);
        g(&r, &["switch", "-q", "main"]);
        // a tag named like the branch, pointing at main's commit
        g(&r, &["tag", "feat"]);
        checkout(&r, "feat", &yes).unwrap();
        assert_eq!(status(&r).unwrap().branch.as_deref(), Some("feat"), "on the branch, not detached at the tag");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "2\n");
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
    fn an_untracked_folder_holding_a_nested_repo_is_refused_and_not_moved() {
        if !have_git() {
            return;
        }
        let r = repo("discard-nested");
        fs::write(r.join("a.txt"), "x\n").unwrap();
        g(&r, &["add", "a.txt"]);
        g(&r, &["commit", "-q", "-m", "i"]);
        fs::create_dir_all(r.join("outer/inner/deep")).unwrap();
        g(&r.join("outer/inner/deep"), &["init", "-q"]);
        fs::write(r.join("outer/f.txt"), "f\n").unwrap();
        let trash = scratch("discard-nested-trash");
        let res = discard_with(&r, &["outer/".into()], &yes, &crate::trash_guard::tests::FakeTrash::into(&trash));
        assert_eq!(code(res), "nested_repo");
        assert!(r.join("outer/f.txt").exists() && r.join("outer/inner/deep/.git").exists(), "nothing moved");
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
        let out = Command::new("git").args(["log", "-1", "--format=%an <%ae>|%cn|%B"]).current_dir(&r).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(text.starts_with("Ada Lovelace <ada@example.com>|Ada Lovelace|feat: add a\n\nbody line"), "{text}");
        assert!(!fs::read_to_string(r.join(".git/config")).unwrap().contains("[user]"));
        assert_eq!(code(commit(&r, "again", &h)), "nothing_staged");
        assert_eq!(code(commit(&r, "-bad", &h)), "invalid_message");
    }

    #[test]
    #[cfg(unix)] // sets the hook's executable bit through the unix-only PermissionsExt
    fn hooks_do_not_run_and_signing_is_off() {
        if !have_git() {
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
        assert!(try_g(&outer, &["submodule", "add", "-q", crate::fsutil::plain_path(&inner).to_str().unwrap(), "sub"]));
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
        g(&outer, &["worktree", "add", "-q", "-b", "wtb", crate::fsutil::plain_path(&wt).to_str().unwrap()]);
        let wst = status(&wt).unwrap();
        assert_eq!(wst.branch.as_deref(), Some("wtb"));
        assert_eq!(branches(&wt).unwrap().branches.len(), 2);
        // Shallow clone
        let shallow = scratch("shallow");
        let inner_url = crate::fsutil::plain_path(&inner).to_string_lossy().replace('\\', "/");
        let url = if inner_url.starts_with('/') { format!("file://{inner_url}") } else { format!("file:///{inner_url}") };
        assert!(Command::new("git").args(["clone", "-q", "--depth", "1", &url, "."]).current_dir(&shallow).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap().success());
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
    fn a_commit_says_which_hooks_and_signing_it_skipped() {
        if !have_git() {
            return;
        }
        let r = repo("commit-skips");
        fs::write(r.join("a.txt"), "1\n").unwrap();
        stage(&r, &["a.txt".into()], true).unwrap();
        assert!(commit(&r, "plain", &home("cs-plain", true)).unwrap().skipped.is_empty(), "nothing set up, nothing to report");

        // A pre-commit hook (a secret scanner, a linter) that would have refused this commit: it is not run, and the
        // result says so.
        let hook = r.join(".git/hooks/pre-commit");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let signer = scratch("cs-sign");
        fs::write(signer.join(".gitconfig"), "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n[commit]\n\tgpgsign = true\n").unwrap();
        fs::write(r.join("a.txt"), "2\n").unwrap();
        stage(&r, &["a.txt".into()], true).unwrap();
        let res = commit(&r, "with a hook", &Some(signer)).unwrap();
        assert_eq!(res.skipped, vec!["hooks", "signing"]);
    }

    #[test]
    fn a_commit_is_refused_in_the_middle_of_a_cherry_pick() {
        if !have_git() {
            return;
        }
        let r = repo("commit-mid-pick");
        fs::write(r.join("a.txt"), "base\n").unwrap();
        g(&r, &["add", "a.txt"]);
        g(&r, &["commit", "-q", "-m", "base"]);
        g(&r, &["switch", "-q", "-c", "other"]);
        fs::write(r.join("a.txt"), "theirs\n").unwrap();
        g(&r, &["commit", "-q", "-am", "theirs", "--author", "Someone Else <else@example.com>"]);
        g(&r, &["switch", "-q", "-"]);
        fs::write(r.join("a.txt"), "ours\n").unwrap();
        g(&r, &["commit", "-q", "-am", "ours"]);
        // The pick stops on a conflict; the user resolves and stages it, then presses Commit in the app.
        let _ = Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t", "cherry-pick", "other"]).current_dir(&r)
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" }).env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
        fs::write(r.join("a.txt"), "resolved\n").unwrap();
        g(&r, &["add", "a.txt"]);
        let err = commit(&r, "resolved", &home("cmp", true)).unwrap_err();
        assert_eq!(err.code, "in_progress");
        assert!(err.message.contains("cherry-pick") && err.message.contains("original author"), "{}", err.message);
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

#[cfg(test)]
mod tag_tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn have_git() -> bool {
        Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-tags-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    /// Runs git with a fixed identity and no global config; `date` pins the committer date.
    fn g_at(root: &Path, args: &[&str], date: Option<&str>) {
        let mut c = Command::new("git");
        c.args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1");
        if let Some(d) = date {
            c.env("GIT_COMMITTER_DATE", d).env("GIT_AUTHOR_DATE", d);
        }
        let out = c.output().unwrap();
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn g(root: &Path, args: &[&str]) {
        g_at(root, args, None);
    }

    fn head(root: &Path) -> String {
        let out = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(root).output().unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn commit(root: &Path, text: &str, date: &str) {
        fs::write(root.join("a.txt"), text).unwrap();
        g_at(root, &["add", "."], None);
        g_at(root, &["commit", "-q", "-m", text], Some(date));
    }

    #[test]
    fn lists_lightweight_and_annotated_tags_with_their_commit() {
        if !have_git() {
            return;
        }
        let r = scratch("kinds");
        g(&r, &["init", "-q"]);
        commit(&r, "one", "2020-01-01T00:00:00Z");
        let c = head(&r);
        g(&r, &["tag", "light"]);
        g(&r, &["tag", "-a", "ann", "-m", "release"]);
        let list = tags(&r).unwrap();
        assert!(!list.truncated);
        assert_eq!(list.tags.len(), 2);
        let light = list.tags.iter().find(|t| t.name == "light").unwrap();
        let ann = list.tags.iter().find(|t| t.name == "ann").unwrap();
        assert!(!light.annotated);
        assert!(ann.annotated, "annotated tag must be flagged");
        // Both name the commit, the annotated one peeled through its tag object.
        assert_eq!(light.target, c[..7]);
        assert_eq!(ann.target, c[..7]);
    }

    #[test]
    fn no_tags_is_an_empty_list() {
        if !have_git() {
            return;
        }
        let r = scratch("none");
        g(&r, &["init", "-q"]);
        assert!(tags(&r).unwrap().tags.is_empty());
        commit(&r, "one", "2020-01-01T00:00:00Z");
        assert!(tags(&r).unwrap().tags.is_empty());
    }

    #[test]
    fn unusual_names_round_trip() {
        if !have_git() {
            return;
        }
        let r = scratch("names");
        g(&r, &["init", "-q"]);
        commit(&r, "one", "2020-01-01T00:00:00Z");
        g(&r, &["tag", "release/v1.0-rc1"]);
        g(&r, &["tag", "\u{7248}\u{672C}/\u{00FC}ber"]);
        let names: Vec<String> = tags(&r).unwrap().tags.into_iter().map(|t| t.name).collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"release/v1.0-rc1".to_string()));
        assert!(names.contains(&"\u{7248}\u{672C}/\u{00FC}ber".to_string()));
    }

    #[test]
    fn newest_first_by_creator_date() {
        if !have_git() {
            return;
        }
        let r = scratch("order");
        g(&r, &["init", "-q"]);
        commit(&r, "old", "2019-01-01T00:00:00Z");
        g(&r, &["tag", "old"]);
        commit(&r, "new", "2024-01-01T00:00:00Z");
        g(&r, &["tag", "new"]);
        commit(&r, "mid", "2021-01-01T00:00:00Z");
        g(&r, &["tag", "mid"]);
        let names: Vec<String> = tags(&r).unwrap().tags.into_iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["new", "mid", "old"]);
    }

    #[test]
    fn listing_is_capped_at_500_and_says_so() {
        if !have_git() {
            return;
        }
        let r = scratch("cap");
        g(&r, &["init", "-q"]);
        commit(&r, "one", "2020-01-01T00:00:00Z");
        // Loose ref files written directly: 600 tags without 600 git processes.
        let c = head(&r);
        let dir = r.join(".git").join("refs").join("tags");
        fs::create_dir_all(&dir).unwrap();
        for i in 0..600 {
            fs::write(dir.join(format!("t{i:04}")), format!("{c}\n")).unwrap();
        }
        let list = tags(&r).unwrap();
        assert_eq!(list.tags.len(), MAX_TAGS);
        assert!(list.truncated);
    }

    #[test]
    fn option_shaped_names_are_listed_as_text_never_parsed_as_options() {
        if !have_git() {
            return;
        }
        let r = scratch("dash");
        g(&r, &["init", "-q"]);
        commit(&r, "one", "2020-01-01T00:00:00Z");
        let c = head(&r);
        // Loose ref files: `git tag` itself refuses these names, a hostile clone need not.
        let dir = r.join(".git").join("refs").join("tags");
        fs::create_dir_all(&dir).unwrap();
        for n in ["-n", "--output=x", "--sort=refname"] {
            fs::write(dir.join(n), format!("{c}\n")).unwrap();
        }
        let mut names: Vec<String> = tags(&r).unwrap().tags.into_iter().map(|t| t.name).collect();
        names.sort();
        assert_eq!(names, ["--output=x", "--sort=refname", "-n"]);
        assert!(!r.join("x").exists(), "no option took effect");
    }

    #[test]
    fn refuses_a_root_that_is_not_a_repository() {
        let d = scratch("not-a-repo");
        assert!(tags(&d).is_err());
    }
}

#[cfg(test)]
mod mutate_tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;
    use std::process::Command;

    fn have_git() -> bool {
        Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-mut-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    fn g_at(root: &Path, args: &[&str], date: Option<&str>) {
        let mut c = Command::new("git");
        c.args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1");
        if let Some(d) = date {
            c.env("GIT_COMMITTER_DATE", d).env("GIT_AUTHOR_DATE", d);
        }
        let out = c.output().unwrap();
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn g(root: &Path, args: &[&str]) {
        g_at(root, args, None);
    }

    fn out(root: &Path, args: &[&str]) -> String {
        let o = Command::new("git").args(args).current_dir(root).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
        String::from_utf8(o.stdout).unwrap().trim().to_string()
    }

    fn exists(root: &Path, refname: &str) -> bool {
        Command::new("git").args(["rev-parse", "--verify", "-q", refname]).current_dir(root).output().is_ok_and(|o| o.status.success())
    }

    /// A repository with one commit on `main` (a.txt = "base").
    fn repo(name: &str) -> PathBuf {
        let r = scratch(name);
        g(&r, &["init", "-q"]);
        fs::write(r.join("a.txt"), "base\n").unwrap();
        g_at(&r, &["add", "."], None);
        g_at(&r, &["commit", "-q", "-m", "base"], Some("2020-01-01T00:00:00Z"));
        r
    }

    fn commit_text(root: &Path, text: &str) {
        fs::write(root.join("a.txt"), text).unwrap();
        g_at(root, &["add", "."], None);
        g_at(root, &["commit", "-q", "-m", text], Some("2021-01-01T00:00:00Z"));
    }

    fn code<T>(r: R<T>) -> &'static str {
        match r {
            Ok(_) => "ok",
            Err(e) => e.code,
        }
    }

    /// The hash the list shows at `index`, or a well-formed id that names no stash.
    fn h_at(r: &Path, index: usize) -> String {
        stash_list(r).unwrap().stashes.get(index).map(|s| s.hash.clone()).unwrap_or_else(|| "0".repeat(40))
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

    // ---- branch delete ----------------------------------------------------------------------

    #[test]
    fn deletes_a_merged_branch_after_one_confirmation() {
        if !have_git() {
            return;
        }
        let r = repo("bd-merged");
        g(&r, &["branch", "feature"]);
        let asked = Cell::new(0);
        let ask = |_: &str| {
            asked.set(asked.get() + 1);
            true
        };
        assert_eq!(branch_delete(&r, "feature", false, &ask).unwrap(), BranchDelete::Deleted);
        assert_eq!(asked.get(), 1, "a merged delete asks exactly once");
        assert!(!exists(&r, "refs/heads/feature"));
    }

    #[test]
    fn an_unmerged_branch_is_refused_without_asking_then_force_deletes_it() {
        if !have_git() {
            return;
        }
        let r = repo("bd-unmerged");
        g(&r, &["checkout", "-q", "-b", "feat"]);
        commit_text(&r, "feat work");
        let tip = out(&r, &["rev-parse", "--short", "refs/heads/feat"]);
        g(&r, &["checkout", "-q", "main"]);
        let asked = Cell::new(0);
        let ask = |_: &str| {
            asked.set(asked.get() + 1);
            true
        };
        assert_eq!(
            branch_delete(&r, "feat", false, &ask).unwrap(),
            BranchDelete::NotMerged { tip: tip.clone(), unique_commits: 1 }
        );
        assert_eq!(asked.get(), 0, "an unmerged refusal changes nothing and asks nothing");
        assert!(exists(&r, "refs/heads/feat"), "the branch survives the refusal");
        // The explicit force path: cancelled leaves it, accepted deletes it.
        assert_eq!(code(branch_delete(&r, "feat", true, &no)), "cancelled");
        assert!(exists(&r, "refs/heads/feat"));
        assert_eq!(branch_delete(&r, "feat", true, &yes).unwrap(), BranchDelete::Deleted);
        assert!(!exists(&r, "refs/heads/feat"));
    }

    #[test]
    fn the_current_branch_is_refused() {
        if !have_git() {
            return;
        }
        let r = repo("bd-current");
        assert_eq!(code(branch_delete(&r, "main", false, &yes)), "current_branch");
        assert_eq!(code(branch_delete(&r, "main", true, &yes)), "current_branch");
        assert!(exists(&r, "refs/heads/main"));
    }

    #[test]
    fn option_shaped_and_odd_names_are_refused_before_git_runs() {
        if !have_git() {
            return;
        }
        let r = repo("bd-names");
        g(&r, &["branch", "keep"]);
        for bad in ["-x", "--all", "-D", "a..b", "HEAD", "a b", "", "a:b", "a\u{202E}b", "a\nb", "keep\u{0}"] {
            assert_eq!(code(branch_delete(&r, bad, true, &yes)), "invalid_ref", "{bad:?}");
        }
        assert!(exists(&r, "refs/heads/keep"));
    }

    #[test]
    fn a_missing_branch_is_not_found() {
        if !have_git() {
            return;
        }
        let r = repo("bd-missing");
        assert_eq!(code(branch_delete(&r, "nope", false, &yes)), "not_found");
    }

    #[test]
    fn remote_tracking_refs_are_never_deleted() {
        if !have_git() {
            return;
        }
        let r = repo("bd-remote");
        g(&r, &["update-ref", "refs/remotes/origin/feat", "HEAD"]);
        assert_eq!(code(branch_delete(&r, "origin/feat", true, &yes)), "not_found");
        assert!(exists(&r, "refs/remotes/origin/feat"), "a remote-tracking ref is untouched");
    }

    // ---- tag create -------------------------------------------------------------------------

    #[test]
    fn a_lightweight_tag_at_head_needs_no_identity() {
        if !have_git() {
            return;
        }
        let r = repo("tc-light");
        let no_id = home("tc-light-home", false);
        let t = tag_create(&r, "v1", None, None, &no_id).unwrap();
        assert!(!t.annotated);
        assert_eq!(t.name, "v1");
        assert_eq!(out(&r, &["cat-file", "-t", "refs/tags/v1"]), "commit");
        assert_eq!(t.target, out(&r, &["rev-parse", "--short", "HEAD"]));
        // A blank message is no message.
        assert!(!tag_create(&r, "v2", Some("   "), None, &no_id).unwrap().annotated);
    }

    #[test]
    fn an_annotated_tag_is_tagged_with_the_users_identity() {
        if !have_git() {
            return;
        }
        let r = repo("tc-ann");
        let t = tag_create(&r, "v1.0", Some("first release"), None, &home("tc-ann-home", true)).unwrap();
        assert!(t.annotated);
        assert_eq!(out(&r, &["cat-file", "-t", "refs/tags/v1.0"]), "tag");
        let body = out(&r, &["cat-file", "-p", "refs/tags/v1.0"]);
        assert!(body.contains("tagger Ada Lovelace <ada@example.com>"), "{body}");
        assert!(body.contains("first release"));
    }

    #[test]
    fn an_annotated_tag_without_an_identity_is_refused_and_nothing_is_written() {
        if !have_git() {
            return;
        }
        let r = repo("tc-noid");
        let before = fs::read(r.join(".git").join("config")).unwrap();
        assert_eq!(code(tag_create(&r, "v1", Some("notes"), None, &home("tc-noid-home", false))), "identity_missing");
        assert!(!exists(&r, "refs/tags/v1"));
        assert_eq!(fs::read(r.join(".git").join("config")).unwrap(), before, "git config is never written");
    }

    #[test]
    fn an_existing_tag_is_refused_and_never_moved() {
        if !have_git() {
            return;
        }
        let r = repo("tc-exists");
        tag_create(&r, "v1", None, None, &None).unwrap();
        let before = out(&r, &["rev-parse", "refs/tags/v1"]);
        commit_text(&r, "second");
        assert_eq!(code(tag_create(&r, "v1", None, None, &home("tc-exists-home", true))), "exists");
        assert_eq!(out(&r, &["rev-parse", "refs/tags/v1"]), before, "the tag still names its old commit");
    }

    #[test]
    fn invalid_tag_names_are_refused() {
        if !have_git() {
            return;
        }
        let r = repo("tc-names");
        for bad in ["-x", "--force", "a..b", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "x.lock", "a/.b", "", "a\u{202E}b", "a\u{0}b", "a\tb"] {
            assert_eq!(code(tag_create(&r, bad, None, None, &None)), "invalid_ref", "{bad:?}");
        }
        assert!(!exists(&r, "refs/tags/a"));
    }

    #[test]
    fn a_unicode_tag_name_round_trips() {
        if !have_git() {
            return;
        }
        let r = repo("tc-unicode");
        let name = "\u{7248}\u{672C}/\u{00FC}ber-1";
        assert_eq!(tag_create(&r, name, None, None, &None).unwrap().name, name);
        assert!(exists(&r, &format!("refs/tags/{name}")));
    }

    #[test]
    fn target_defaults_to_head_and_accepts_a_commit_or_a_branch() {
        if !have_git() {
            return;
        }
        let r = repo("tc-target");
        let first = out(&r, &["rev-parse", "HEAD"]);
        commit_text(&r, "second");
        let t = tag_create(&r, "old", None, Some(&first), &None).unwrap();
        assert_eq!(t.target, first[..7]);
        g(&r, &["branch", "side", &first]);
        assert_eq!(tag_create(&r, "from-branch", None, Some("side"), &None).unwrap().target, first[..7]);
        assert!(tag_create(&r, "head", None, Some("HEAD"), &None).is_ok());
        assert_eq!(code(tag_create(&r, "nope", None, Some("no-such-thing"), &None)), "not_found");
        assert_eq!(code(tag_create(&r, "dash", None, Some("-x"), &None)), "invalid_ref");
    }

    #[test]
    fn tag_messages_are_bounded_and_not_option_shaped() {
        if !have_git() {
            return;
        }
        let r = repo("tc-msg");
        let h = home("tc-msg-home", true);
        assert_eq!(code(tag_create(&r, "big", Some(&"x".repeat(2049)), None, &h)), "too_large");
        assert_eq!(code(tag_create(&r, "dash", Some("-n"), None, &h)), "invalid_message");
        assert!(!exists(&r, "refs/tags/big"));
        assert!(tag_create(&r, "ok", Some(&"x".repeat(2048)), None, &h).is_ok());
    }

    // ---- stash ------------------------------------------------------------------------------

    #[test]
    fn stash_push_list_apply_pop_and_drop_round_trip() {
        if !have_git() {
            return;
        }
        let r = repo("st-cycle");
        let h = home("st-cycle-home", true);
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        stash_push(&r, "first\nline two", false, &h).unwrap();
        let list = stash_list(&r).unwrap();
        assert_eq!(list.stashes.len(), 1);
        assert!(list.stashes[0].message.contains("first"));
        assert!(!list.stashes[0].message.contains('\n'), "one line");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "base\n", "the tree is clean after push");

        stash_apply(&r, 0, &h_at(&r, 0)).unwrap();
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "changed\n");
        assert_eq!(stash_list(&r).unwrap().stashes.len(), 1, "apply keeps the stash");

        g(&r, &["checkout", "--", "a.txt"]);
        stash_pop(&r, 0, &h_at(&r, 0), &yes).unwrap();
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "changed\n");
        assert!(stash_list(&r).unwrap().stashes.is_empty(), "pop removes it");

        g(&r, &["checkout", "--", "a.txt"]);
        fs::write(r.join("a.txt"), "second\n").unwrap();
        stash_push(&r, "second", false, &h).unwrap();
        assert_eq!(stash_list(&r).unwrap().stashes.len(), 1);
        stash_drop(&r, 0, &h_at(&r, 0), &yes).unwrap();
        assert!(stash_list(&r).unwrap().stashes.is_empty());
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "base\n", "drop does not touch the tree");
    }

    #[test]
    fn a_cancelled_pop_or_drop_changes_nothing() {
        if !have_git() {
            return;
        }
        let r = repo("st-cancel");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        stash_push(&r, "keep me", false, &home("st-cancel-home", true)).unwrap();
        assert_eq!(code(stash_pop(&r, 0, &h_at(&r, 0), &no)), "cancelled");
        assert_eq!(code(stash_drop(&r, 0, &h_at(&r, 0), &no)), "cancelled");
        assert_eq!(stash_list(&r).unwrap().stashes.len(), 1);
    }

    #[test]
    fn nothing_to_stash_is_a_typed_refusal() {
        if !have_git() {
            return;
        }
        let r = repo("st-nothing");
        assert_eq!(code(stash_push(&r, "", false, &home("st-nothing-home", true))), "nothing_to_stash");
        assert!(stash_list(&r).unwrap().stashes.is_empty());
    }

    #[test]
    fn untracked_files_only_stash_when_asked() {
        if !have_git() {
            return;
        }
        let r = repo("st-untracked");
        let h = home("st-untracked-home", true);
        fs::write(r.join("new.txt"), "hello\n").unwrap();
        assert_eq!(code(stash_push(&r, "", false, &h)), "nothing_to_stash", "an untracked file is not a change without the flag");
        stash_push(&r, "with new", true, &h).unwrap();
        assert!(!r.join("new.txt").exists(), "the untracked file was stashed");
        stash_apply(&r, 0, &h_at(&r, 0)).unwrap();
        assert_eq!(fs::read_to_string(r.join("new.txt")).unwrap(), "hello\n");
    }

    #[test]
    fn stash_needs_an_identity_and_a_bounded_message() {
        if !have_git() {
            return;
        }
        let r = repo("st-id");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        assert_eq!(code(stash_push(&r, "", false, &home("st-id-home", false))), "identity_missing");
        assert!(stash_list(&r).unwrap().stashes.is_empty());
        assert_eq!(code(stash_push(&r, &"m".repeat(2049), false, &home("st-id-home2", true))), "too_large");
    }

    #[test]
    fn a_pop_that_conflicts_is_a_typed_error_and_keeps_the_stash() {
        if !have_git() {
            return;
        }
        let r = repo("st-conflict");
        fs::write(r.join("a.txt"), "two\n").unwrap();
        stash_push(&r, "two", false, &home("st-conflict-home", true)).unwrap();
        commit_text(&r, "three");
        assert_eq!(code(stash_pop(&r, 0, &h_at(&r, 0), &yes)), "conflicts");
        assert_eq!(stash_list(&r).unwrap().stashes.len(), 1, "git kept the stash");
        let st = status(&r).unwrap();
        assert!(st.entries.iter().any(|e| e.kind == "unmerged"), "the conflict is in git's own state");
        // While those files are unmerged, another apply or pop is refused up front (not reported as a new conflict).
        assert_eq!(code(stash_apply(&r, 0, &h_at(&r, 0))), "conflict");
        assert_eq!(code(stash_pop(&r, 0, &h_at(&r, 0), &yes)), "conflict");
        assert_eq!(stash_list(&r).unwrap().stashes.len(), 1);
    }

    #[test]
    fn an_index_outside_the_list_is_refused() {
        if !have_git() {
            return;
        }
        let r = repo("st-index");
        assert_eq!(code(stash_apply(&r, 0, &h_at(&r, 0))), "not_found");
        assert_eq!(code(stash_pop(&r, 0, &h_at(&r, 0), &yes)), "not_found");
        assert_eq!(code(stash_drop(&r, 0, &h_at(&r, 0), &yes)), "not_found");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        stash_push(&r, "one", false, &home("st-index-home", true)).unwrap();
        assert_eq!(code(stash_apply(&r, 1, &h_at(&r, 1))), "not_found");
        assert_eq!(code(stash_drop(&r, 1, &h_at(&r, 1), &yes)), "not_found");
        assert_eq!(stash_list(&r).unwrap().stashes.len(), 1);
    }

    #[test]
    fn the_stash_list_is_capped_at_100_and_says_so() {
        if !have_git() {
            return;
        }
        let r = repo("st-cap");
        for i in 0..150 {
            fs::write(r.join("a.txt"), format!("change {i}\n")).unwrap();
            g(&r, &["stash", "push", "-q", "-m", &format!("s{i}")]);
        }
        let list = stash_list(&r).unwrap();
        assert_eq!(list.stashes.len(), MAX_STASHES);
        assert!(list.truncated);
        assert_eq!(list.stashes[0].index, 0);
        assert!(list.stashes[0].message.contains("s149"), "newest first: {}", list.stashes[0].message);
    }
    // ---- review additions -------------------------------------------------------------------

    #[test]
    fn a_stale_stash_index_is_refused_and_nothing_is_dropped() {
        if !have_git() {
            return;
        }
        let r = repo("st-stale");
        let h = home("st-stale-home", true);
        fs::write(r.join("a.txt"), "one\n").unwrap();
        stash_push(&r, "older", false, &h).unwrap();
        let seen = stash_list(&r).unwrap().stashes.remove(0); // the user sees "older" at 0
        fs::write(r.join("a.txt"), "two\n").unwrap();
        stash_push(&r, "newer", false, &h).unwrap(); // now "newer" is at 0
        assert_eq!(code(stash_drop(&r, 0, &seen.hash, &yes)), "changed");
        assert_eq!(code(stash_pop(&r, 0, &seen.hash, &yes)), "changed");
        assert_eq!(code(stash_apply(&r, 0, &seen.hash)), "changed");
        assert_eq!(stash_list(&r).unwrap().stashes.len(), 2, "nothing was dropped or popped");
        for bad in ["", "stash@{0}", "-x", "HEAD", &"g".repeat(40)] {
            assert_eq!(code(stash_drop(&r, 1, bad, &yes)), "invalid_ref", "{bad:?}");
        }
        // The list changing while the dialog is open is caught too.
        let older = h_at(&r, 1);
        let ask = |_: &str| {
            fs::write(r.join("a.txt"), "three\n").unwrap();
            g(&r, &["stash", "push", "-q", "-m", "during"]);
            true
        };
        assert_eq!(code(stash_drop(&r, 1, &older, &ask)), "changed");
        assert_eq!(stash_list(&r).unwrap().stashes.len(), 3);
        assert_eq!(code(stash_drop(&r, 2, &older, &yes)), "ok", "the right index and hash still work");
        assert!(stash_list(&r).unwrap().stashes.iter().all(|s| s.hash != older));
    }

    #[test]
    fn a_branch_that_moves_during_the_dialog_is_not_deleted() {
        if !have_git() {
            return;
        }
        // Merged when asked, unmerged when git runs: `-d` must refuse it (a `-D` here would lose the commit).
        let r = repo("bd-moved");
        g(&r, &["branch", "feature"]);
        let ask = |_: &str| {
            g(&r, &["checkout", "-q", "feature"]);
            commit_text(&r, "late work");
            g(&r, &["checkout", "-q", "main"]);
            true
        };
        assert_eq!(code(branch_delete(&r, "feature", false, &ask)), "not_merged");
        assert!(exists(&r, "refs/heads/feature"), "the late commit is still on its branch");
        // Forced: the dialog named the old tip, so a moved branch is refused as well.
        let ask = |_: &str| {
            g(&r, &["checkout", "-q", "feature"]);
            commit_text(&r, "later work");
            g(&r, &["checkout", "-q", "main"]);
            true
        };
        assert_eq!(code(branch_delete(&r, "feature", true, &ask)), "changed");
        assert!(exists(&r, "refs/heads/feature"));
    }

    #[test]
    fn a_branch_checked_out_in_another_worktree_is_refused_before_asking() {
        if !have_git() {
            return;
        }
        let r = repo("bd-wt");
        let wt = scratch("bd-wt-linked");
        fs::remove_dir_all(&wt).unwrap();
        g(&r, &["worktree", "add", "-q", "-b", "other", crate::fsutil::plain_path(&wt).to_str().unwrap()]);
        let asked = Cell::new(false);
        let ask = |_: &str| {
            asked.set(true);
            true
        };
        assert_eq!(code(branch_delete(&r, "other", true, &ask)), "checked_out");
        assert!(!asked.get());
        assert!(exists(&r, "refs/heads/other"));
    }

    #[test]
    fn a_stash_message_is_never_a_pathspec_and_ignored_files_stay() {
        if !have_git() {
            return;
        }
        let r = repo("st-magic");
        let h = home("st-magic-home", true);
        fs::write(r.join(".gitignore"), "*.log\n").unwrap();
        g(&r, &["add", ".gitignore"]);
        g(&r, &["commit", "-q", "-m", "ignore"]);
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        fs::write(r.join("new.txt"), "new\n").unwrap();
        fs::write(r.join("keep.log"), "ignored\n").unwrap();
        stash_push(&r, ":(glob)nothing -- a.txt", true, &h).unwrap();
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "base\n", "the whole tree was stashed");
        assert!(!r.join("new.txt").exists());
        assert!(r.join("keep.log").exists(), "ignored files are never stashed (no --all)");
        assert!(stash_list(&r).unwrap().stashes[0].message.contains(":(glob)nothing -- a.txt"));
    }

    #[test]
    fn stash_in_a_repo_without_commits_is_a_plain_refusal() {
        if !have_git() {
            return;
        }
        let r = scratch("st-empty");
        g(&r, &["init", "-q"]);
        fs::write(r.join("a.txt"), "x\n").unwrap();
        assert_eq!(code(stash_push(&r, "", true, &home("st-empty-home", true))), "no_commits");
        assert!(stash_list(&r).unwrap().stashes.is_empty());
    }

    #[test]
    fn repo_signing_config_never_starts_gpg_for_a_tag_or_a_stash() {
        if !have_git() {
            return;
        }
        // A repo that asks for signing (or names a gpg program) is refused before git runs at all.
        for (k, v) in [("tag.gpgSign", "true"), ("tag.forceSignAnnotated", "true"), ("gpg.program", "/nonexistent/gpg"), ("commit.gpgSign", "true")] {
            let r = repo(&format!("sign-cfg-{}", k.replace('.', "-")));
            let h = home(&format!("sign-cfg-home-{}", k.replace('.', "-")), true);
            g(&r, &["config", k, v]);
            let tag = tag_create(&r, "v1", Some("notes"), None, &h);
            fs::write(r.join("a.txt"), "changed\n").unwrap();
            let st = stash_push(&r, "s", false, &h);
            // Either refused as untrusted, or (an allowed key) run with signing forced off: never a gpg failure.
            for res in [tag.map(|_| ()), st] {
                assert!(matches!(&res, Ok(()) | Err(FsError { code: "untrusted_repo_config", .. })), "{k}: {res:?}");
            }
        }
    }
}

#[cfg(test)]
mod merge_amend_discard_tests {
    use super::*;
    use crate::trash_guard::tests::FakeTrash;
    use std::cell::{Cell, RefCell};
    use std::fs;
    use std::process::Command;

    fn have_git() -> bool {
        Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-mad-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    /// Git with a fixed identity and no global config; an optional author and pinned dates.
    fn gx(root: &Path, args: &[&str], author: Option<(&str, &str)>) {
        let mut c = Command::new("git");
        c.args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_COMMITTER_DATE", "2021-01-01T00:00:00Z")
            .env("GIT_AUTHOR_DATE", "2021-01-01T00:00:00Z");
        if let Some((n, e)) = author {
            c.env("GIT_AUTHOR_NAME", n).env("GIT_AUTHOR_EMAIL", e);
        }
        let out = c.output().unwrap();
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn g(root: &Path, args: &[&str]) {
        gx(root, args, None);
    }

    fn out(root: &Path, args: &[&str]) -> String {
        let o = Command::new("git").args(args).current_dir(root).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
        String::from_utf8(o.stdout).unwrap().trim().to_string()
    }

    fn has_ref(root: &Path, refname: &str) -> bool {
        Command::new("git").args(["rev-parse", "--verify", "-q", refname]).current_dir(root).output().is_ok_and(|o| o.status.success())
    }

    /// A repository with one commit on `main`: a.txt = "base".
    fn repo(name: &str) -> PathBuf {
        let r = scratch(name);
        g(&r, &["init", "-q"]);
        fs::write(r.join("a.txt"), "base\n").unwrap();
        g(&r, &["add", "."]);
        g(&r, &["commit", "-q", "-m", "base"]);
        r
    }

    /// Writes `name`, stages it and commits it.
    fn commit_file(root: &Path, name: &str, text: &str, subject: &str) {
        fs::write(root.join(name), text).unwrap();
        g(root, &["add", "."]);
        g(root, &["commit", "-q", "-m", subject]);
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

    /// Made once: `scratch` wipes its folder, so parallel tests recreating it raced into `identity_missing`.
    fn ada() -> Option<PathBuf> {
        static ADA: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
        ADA.get_or_init(|| home("mad-ada", true)).clone()
    }

    /// `main` at base plus a `feat` branch with one commit (b.txt), HEAD on main.
    fn repo_with_feat(name: &str) -> PathBuf {
        let r = repo(name);
        g(&r, &["checkout", "-q", "-b", "feat"]);
        commit_file(&r, "b.txt", "feat\n", "feat work");
        g(&r, &["checkout", "-q", "main"]);
        r
    }

    /// Both branches change a.txt: merging `feat` into `main` conflicts. Leaves the merge in progress.
    fn conflicted_merge(name: &str) -> PathBuf {
        let r = repo(name);
        g(&r, &["checkout", "-q", "-b", "feat"]);
        commit_file(&r, "a.txt", "feat\n", "feat edit");
        g(&r, &["checkout", "-q", "main"]);
        commit_file(&r, "a.txt", "main\n", "main edit");
        let res = merge(&r, "feat", MergeMode::FastForward, &ada(), &yes).unwrap();
        assert_eq!(res, MergeOutcome::Conflicts { paths: vec!["a.txt".into()], truncated: false });
        r
    }

    // ---- merge ------------------------------------------------------------------------------

    #[test]
    fn merge_fast_forwards_when_it_can_and_says_so() {
        if !have_git() {
            return;
        }
        let r = repo_with_feat("mg-ff");
        let tip = out(&r, &["rev-parse", "refs/heads/feat"]);
        let prompts = RefCell::new(Vec::new());
        let ask = |p: &str| {
            prompts.borrow_mut().push(p.to_string());
            true
        };
        let res = merge(&r, "feat", MergeMode::FastForward, &ada(), &ask).unwrap();
        assert_eq!(res, MergeOutcome::Merged { hash: out(&r, &["rev-parse", "--short", "HEAD"]), fast_forward: true });
        assert_eq!(out(&r, &["rev-parse", "HEAD"]), tip, "main moved to feat");
        assert_eq!(out(&r, &["rev-list", "--count", "--merges", "HEAD"]), "0", "no merge commit");
        assert!(prompts.borrow().len() == 1 && prompts.borrow()[0].contains("fast-forwards"), "{:?}", prompts.borrow());
    }

    #[test]
    fn no_ff_always_records_a_merge_commit() {
        if !have_git() {
            return;
        }
        let r = repo_with_feat("mg-noff");
        let res = merge(&r, "feat", MergeMode::NoFastForward, &ada(), &yes).unwrap();
        assert_eq!(res, MergeOutcome::Merged { hash: out(&r, &["rev-parse", "--short", "HEAD"]), fast_forward: false });
        assert_eq!(out(&r, &["rev-list", "--count", "--merges", "HEAD"]), "1");
        assert_eq!(out(&r, &["rev-parse", "HEAD^2"]), out(&r, &["rev-parse", "refs/heads/feat"]));
    }

    #[test]
    fn conflicts_are_reported_then_abort_restores_the_tree() {
        if !have_git() {
            return;
        }
        let r = conflicted_merge("mg-conflict");
        assert!(has_ref(&r, "MERGE_HEAD"), "git keeps the merge in progress");
        assert!(status(&r).unwrap().merging, "status says a merge is in progress");
        assert_eq!(code(merge_abort(&r, &no)), "cancelled");
        assert!(has_ref(&r, "MERGE_HEAD"), "a cancelled abort changes nothing");
        assert_eq!(code(merge_abort(&r, &yes)), "ok");
        assert!(!has_ref(&r, "MERGE_HEAD"));
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "main\n", "back to the pre-merge file");
        assert!(!status(&r).unwrap().merging);
        assert_eq!(code(merge_abort(&r, &yes)), "not_in_progress");
    }

    #[test]
    fn a_dirty_tree_is_refused_before_any_question() {
        if !have_git() {
            return;
        }
        let r = repo_with_feat("mg-dirty");
        let head = out(&r, &["rev-parse", "HEAD"]);
        let asked = Cell::new(false);
        let ask = |_: &str| {
            asked.set(true);
            true
        };
        fs::write(r.join("a.txt"), "edit\n").unwrap();
        let err = merge(&r, "feat", MergeMode::FastForward, &ada(), &ask);
        assert_eq!(code(err), "dirty");
        assert!(!asked.get());
        assert_eq!(out(&r, &["rev-parse", "HEAD"]), head);
        g(&r, &["checkout", "--", "a.txt"]);
        fs::write(r.join("new.txt"), "untracked\n").unwrap();
        let err = merge(&r, "feat", MergeMode::FastForward, &ada(), &ask);
        assert!(matches!(&err, Err(e) if e.code == "dirty" && e.message.starts_with("1 uncommitted change(s), 1 of them untracked")), "{err:?}");
        assert!(!asked.get());
    }

    #[test]
    fn an_operation_in_progress_is_refused() {
        if !have_git() {
            return;
        }
        let r = conflicted_merge("mg-busy");
        assert_eq!(code(merge(&r, "feat", MergeMode::FastForward, &ada(), &yes)), "in_progress");
        g(&r, &["merge", "--abort"]);
        fs::create_dir_all(r.join(".git").join("rebase-merge")).unwrap();
        assert_eq!(code(merge(&r, "feat", MergeMode::FastForward, &ada(), &yes)), "in_progress", "a rebase directory counts");
    }

    #[test]
    fn the_current_branch_a_detached_head_and_a_missing_branch_are_refused() {
        if !have_git() {
            return;
        }
        let r = repo_with_feat("mg-refuse");
        assert_eq!(code(merge(&r, "main", MergeMode::FastForward, &ada(), &yes)), "current_branch");
        assert_eq!(code(merge(&r, "nope", MergeMode::FastForward, &ada(), &yes)), "not_found");
        g(&r, &["checkout", "-q", "--detach"]);
        assert_eq!(code(merge(&r, "feat", MergeMode::FastForward, &ada(), &yes)), "detached");
    }

    #[test]
    fn option_shaped_and_odd_names_and_modes_are_refused() {
        if !have_git() {
            return;
        }
        let r = repo_with_feat("mg-names");
        for bad in ["-x", "--all", "a..b", "HEAD", "a b", "", "a:b", "feat\u{0}"] {
            assert_eq!(code(merge(&r, bad, MergeMode::FastForward, &ada(), &yes)), "invalid_ref", "{bad:?}");
        }
        assert_eq!(code(merge_mode(Some("squash"))), "invalid_mode");
        assert_eq!(merge_mode(None).unwrap(), MergeMode::FastForward);
        assert_eq!(merge_mode(Some("ff")).unwrap(), MergeMode::FastForward);
        assert_eq!(merge_mode(Some("no_ff")).unwrap(), MergeMode::NoFastForward);
        assert_eq!(out(&r, &["rev-parse", "--abbrev-ref", "HEAD"]), "main", "nothing moved");
    }

    #[test]
    fn a_missing_identity_is_refused_before_the_dialog() {
        if !have_git() {
            return;
        }
        let r = repo_with_feat("mg-noid");
        let asked = Cell::new(false);
        let ask = |_: &str| {
            asked.set(true);
            true
        };
        assert_eq!(code(merge(&r, "feat", MergeMode::FastForward, &home("mg-noid-home", false), &ask)), "identity_missing");
        assert!(!asked.get());
    }

    #[test]
    fn a_branch_already_in_the_current_one_has_nothing_to_merge() {
        if !have_git() {
            return;
        }
        let r = repo("mg-uptodate");
        g(&r, &["branch", "old"]);
        assert_eq!(code(merge(&r, "old", MergeMode::FastForward, &ada(), &yes)), "up_to_date");
    }

    #[test]
    fn a_branch_that_moves_during_the_dialog_is_not_merged() {
        if !have_git() {
            return;
        }
        let r = repo_with_feat("mg-moved");
        let head = out(&r, &["rev-parse", "HEAD"]);
        let ask = |_: &str| {
            g(&r, &["update-ref", "refs/heads/feat", "HEAD"]);
            true
        };
        assert_eq!(code(merge(&r, "feat", MergeMode::FastForward, &ada(), &ask)), "changed");
        assert_eq!(out(&r, &["rev-parse", "HEAD"]), head);
        assert!(!r.join("b.txt").exists());
    }

    // ---- amend ------------------------------------------------------------------------------

    /// A repository with two commits on `main`: a.txt = "second".
    fn two_commits(name: &str) -> PathBuf {
        let r = repo(name);
        commit_file(&r, "a.txt", "second\n", "second");
        r
    }

    #[test]
    fn a_staged_change_is_amended_into_the_last_commit_only() {
        if !have_git() {
            return;
        }
        let r = two_commits("ca-staged");
        fs::write(r.join("a.txt"), "third\n").unwrap();
        g(&r, &["add", "."]);
        let prompts = RefCell::new(Vec::new());
        let ask = |p: &str| {
            prompts.borrow_mut().push(p.to_string());
            true
        };
        let res = commit_amend(&r, None, false, &ada(), &ask).unwrap();
        assert_eq!(res.hash, out(&r, &["rev-parse", "--short", "HEAD"]));
        assert_eq!(out(&r, &["show", "HEAD:a.txt"]), "third");
        assert_eq!(out(&r, &["show", "HEAD~1:a.txt"]), "base", "the first commit is untouched");
        assert_eq!(out(&r, &["log", "-1", "--format=%s"]), "second", "the message stays");
        assert!(prompts.borrow()[0].contains("1 staged file(s)") && prompts.borrow()[0].contains("message stays"), "{:?}", prompts.borrow());
        assert_eq!(out(&r, &["status", "--porcelain"]), "");
    }

    #[test]
    fn a_message_only_amend_keeps_the_tree() {
        if !have_git() {
            return;
        }
        let r = two_commits("ca-msg");
        let tree = out(&r, &["rev-parse", "HEAD^{tree}"]);
        commit_amend(&r, Some("  New subject\n\nbody line\n"), false, &ada(), &yes).unwrap();
        let msg = out(&r, &["log", "-1", "--format=%B"]);
        assert!(msg.starts_with("New subject") && msg.contains("body line"), "{msg}");
        assert_eq!(out(&r, &["rev-parse", "HEAD^{tree}"]), tree, "same tree");
    }

    #[test]
    fn nothing_staged_and_no_message_is_nothing_to_amend() {
        if !have_git() {
            return;
        }
        let r = two_commits("ca-nothing");
        assert_eq!(code(commit_amend(&r, None, false, &ada(), &yes)), "nothing_to_amend");
        assert_eq!(code(commit_amend(&r, Some("   \n"), false, &ada(), &yes)), "nothing_to_amend", "a blank message is no message");
    }

    #[test]
    fn a_repository_without_commits_has_nothing_to_amend() {
        if !have_git() {
            return;
        }
        let r = scratch("ca-empty");
        g(&r, &["init", "-q"]);
        fs::write(r.join("a.txt"), "x\n").unwrap();
        g(&r, &["add", "."]);
        assert_eq!(code(commit_amend(&r, Some("x"), false, &ada(), &yes)), "no_commits");
    }

    #[test]
    fn a_published_commit_is_refused_then_amended_only_with_force_and_a_warning() {
        if !have_git() {
            return;
        }
        let r = two_commits("ca-pushed");
        fs::write(r.join("a.txt"), "third\n").unwrap();
        g(&r, &["add", "."]);
        g(&r, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        let head = out(&r, &["rev-parse", "HEAD"]);
        let asked = Cell::new(0u32);
        let prompts = RefCell::new(Vec::new());
        let ask = |p: &str| {
            asked.set(asked.get() + 1);
            prompts.borrow_mut().push(p.to_string());
            true
        };
        assert_eq!(code(commit_amend(&r, None, false, &ada(), &ask)), "already_pushed");
        assert_eq!(asked.get(), 0, "a refusal asks nothing");
        assert_eq!(code(commit_amend(&r, None, true, &ada(), &no)), "cancelled");
        assert_eq!(out(&r, &["rev-parse", "HEAD"]), head, "a cancelled amend changes nothing");
        commit_amend(&r, None, true, &ada(), &ask).unwrap();
        assert_ne!(out(&r, &["rev-parse", "HEAD"]), head);
        assert_eq!(asked.get(), 1, "the cancelled attempt used another dialog");
        assert!(prompts.borrow()[0].contains("already exists on a remote") && prompts.borrow()[0].contains("force push"));
        assert_eq!(out(&r, &["rev-parse", "refs/remotes/origin/main"]), head, "the remote-tracking ref is not touched");
    }

    #[test]
    fn the_author_is_kept_and_the_committer_is_the_user() {
        if !have_git() {
            return;
        }
        let r = scratch("ca-author");
        g(&r, &["init", "-q"]);
        fs::write(r.join("a.txt"), "base\n").unwrap();
        g(&r, &["add", "."]);
        gx(&r, &["commit", "-q", "-m", "base"], Some(("Bob Builder", "bob@example.com")));
        fs::write(r.join("a.txt"), "two\n").unwrap();
        g(&r, &["add", "."]);
        commit_amend(&r, None, false, &ada(), &yes).unwrap();
        assert_eq!(out(&r, &["log", "-1", "--format=%an <%ae>|%cn <%ce>"]), "Bob Builder <bob@example.com>|Ada Lovelace <ada@example.com>");
    }

    #[test]
    fn an_amend_during_a_merge_or_without_an_identity_writes_nothing() {
        if !have_git() {
            return;
        }
        let r = conflicted_merge("ca-merge");
        assert_eq!(code(commit_amend(&r, Some("x"), false, &ada(), &yes)), "in_progress");
        g(&r, &["merge", "--abort"]);
        fs::write(r.join("a.txt"), "staged\n").unwrap();
        g(&r, &["add", "."]);
        let head = out(&r, &["rev-parse", "HEAD"]);
        assert_eq!(code(commit_amend(&r, None, false, &home("ca-noid", false), &yes)), "identity_missing");
        assert_eq!(out(&r, &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn the_amend_message_is_bounded_and_not_option_shaped() {
        if !have_git() {
            return;
        }
        let r = two_commits("ca-bounds");
        fs::write(r.join("a.txt"), "third\n").unwrap();
        g(&r, &["add", "."]);
        assert_eq!(code(commit_amend(&r, Some(&"m".repeat(65_537)), false, &ada(), &yes)), "too_large");
        assert_eq!(code(commit_amend(&r, Some("-n"), false, &ada(), &yes)), "invalid_message");
        assert_eq!(out(&r, &["log", "-1", "--format=%s"]), "second");
        assert_eq!(code(commit_amend(&r, Some(&"m".repeat(65_536)), false, &ada(), &yes)), "ok", "64 KB is the limit");
    }

    #[test]
    fn a_commit_made_during_the_dialog_aborts_the_amend() {
        if !have_git() {
            return;
        }
        let r = two_commits("ca-moved");
        fs::write(r.join("a.txt"), "third\n").unwrap();
        g(&r, &["add", "."]);
        let ask = |_: &str| {
            g(&r, &["commit", "-q", "--allow-empty", "-m", "moved"]);
            true
        };
        assert_eq!(code(commit_amend(&r, None, false, &ada(), &ask)), "changed");
        assert_eq!(out(&r, &["log", "-1", "--format=%s"]), "moved");
    }

    // ---- discard all ------------------------------------------------------------------------

    fn porcelain(r: &Path) -> String {
        out(r, &["status", "--porcelain"])
    }

    #[test]
    fn staged_and_unstaged_changes_and_deletions_are_restored_to_head() {
        if !have_git() {
            return;
        }
        let r = repo("da-restore");
        commit_file(&r, "c.txt", "c\n", "add c");
        fs::write(r.join("a.txt"), "one\n").unwrap();
        g(&r, &["add", "."]);
        fs::write(r.join("a.txt"), "two\n").unwrap();
        fs::remove_file(r.join("c.txt")).unwrap();
        let res = discard_all_with(&r, false, &yes, &FakeTrash::refusing()).unwrap();
        assert_eq!(res, DiscardAllResult { restored: 2, trashed: 0, skipped: 0 });
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "base\n");
        assert_eq!(fs::read_to_string(r.join("c.txt")).unwrap(), "c\n");
        assert_eq!(porcelain(&r), "", "clean, staged and unstaged alike");
    }

    #[test]
    fn untracked_files_are_untouched_without_the_flag_and_trashed_with_it() {
        if !have_git() {
            return;
        }
        let r = repo("da-untracked");
        let trash = scratch("da-untracked-trash");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        fs::write(r.join("new.txt"), "hello\n").unwrap();
        let res = discard_all_with(&r, false, &yes, &FakeTrash::into(&trash)).unwrap();
        assert_eq!(res, DiscardAllResult { restored: 1, trashed: 0, skipped: 0 });
        assert_eq!(fs::read_to_string(r.join("new.txt")).unwrap(), "hello\n", "untouched");
        assert!(porcelain(&r).contains("?? new.txt"));

        fs::write(r.join("a.txt"), "changed again\n").unwrap();
        let res = discard_all_with(&r, true, &yes, &FakeTrash::into(&trash)).unwrap();
        assert_eq!(res, DiscardAllResult { restored: 1, trashed: 1, skipped: 0 });
        assert!(!r.join("new.txt").exists(), "moved out of the repository");
        assert_eq!(fs::read_to_string(trash.join("1-new.txt")).unwrap(), "hello\n", "it is in the trash, not deleted");
        assert_eq!(porcelain(&r), "");
    }

    #[test]
    fn a_staged_new_file_follows_the_flag_once_the_index_is_reset() {
        if !have_git() {
            return;
        }
        let r = repo("da-added");
        let trash = scratch("da-added-trash");
        fs::write(r.join("added.txt"), "new\n").unwrap();
        g(&r, &["add", "added.txt"]);
        discard_all_with(&r, false, &yes, &FakeTrash::refusing()).unwrap();
        assert_eq!(fs::read_to_string(r.join("added.txt")).unwrap(), "new\n", "the file stays, now untracked");
        assert!(porcelain(&r).contains("?? added.txt"));
        g(&r, &["add", "added.txt"]);
        let res = discard_all_with(&r, true, &yes, &FakeTrash::into(&trash)).unwrap();
        assert_eq!(res.trashed, 1);
        assert!(!r.join("added.txt").exists());
    }

    #[test]
    fn ignored_files_are_never_touched() {
        if !have_git() {
            return;
        }
        let r = repo("da-ignored");
        fs::write(r.join(".gitignore"), "*.log\n").unwrap();
        g(&r, &["add", ".gitignore"]);
        g(&r, &["commit", "-q", "-m", "ignore"]);
        fs::write(r.join("keep.log"), "ignored\n").unwrap();
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        let trash = scratch("da-ignored-trash");
        discard_all_with(&r, true, &yes, &FakeTrash::into(&trash)).unwrap();
        assert_eq!(fs::read_to_string(r.join("keep.log")).unwrap(), "ignored\n");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_left_in_place_and_their_targets_never_trashed() {
        if !have_git() {
            return;
        }
        let r = repo("da-links");
        let outside = scratch("da-links-outside");
        fs::write(outside.join("target.txt"), "keep\n").unwrap();
        std::os::unix::fs::symlink(outside.join("target.txt"), r.join("link.txt")).unwrap();
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        let trash = scratch("da-links-trash");
        let res = discard_all_with(&r, true, &yes, &FakeTrash::into(&trash)).unwrap();
        assert_eq!(res, DiscardAllResult { restored: 1, trashed: 0, skipped: 1 });
        assert!(fs::symlink_metadata(r.join("link.txt")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(outside.join("target.txt")).unwrap(), "keep\n");
    }

    #[test]
    fn a_nested_repository_is_left_in_place() {
        if !have_git() {
            return;
        }
        let r = repo("da-nested");
        let nested = r.join("nested");
        fs::create_dir_all(&nested).unwrap();
        g(&nested, &["init", "-q"]);
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        let trash = scratch("da-nested-trash");
        let res = discard_all_with(&r, true, &yes, &FakeTrash::into(&trash)).unwrap();
        assert_eq!(res.skipped, 1);
        assert!(nested.join(".git").exists());
    }

    #[test]
    fn more_than_2000_untracked_items_are_refused_before_anything_moves() {
        if !have_git() {
            return;
        }
        let r = repo("da-many");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        for i in 0..2001 {
            fs::write(r.join(format!("u{i}.txt")), "x").unwrap();
        }
        let asked = Cell::new(false);
        let ask = |_: &str| {
            asked.set(true);
            true
        };
        let err = discard_all_with(&r, true, &ask, &FakeTrash::refusing());
        assert!(matches!(&err, Err(e) if e.code == "too_many"), "{err:?}");
        assert!(!asked.get());
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "changed\n");
        assert!(r.join("u0.txt").exists());
    }

    #[test]
    fn a_refusing_trash_leaves_the_item_and_counts_it() {
        if !have_git() {
            return;
        }
        let r = repo("da-refuse");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        fs::write(r.join("new.txt"), "keep\n").unwrap();
        let res = discard_all_with(&r, true, &yes, &FakeTrash::refusing()).unwrap();
        assert_eq!(res, DiscardAllResult { restored: 1, trashed: 0, skipped: 1 });
        assert_eq!(fs::read_to_string(r.join("new.txt")).unwrap(), "keep\n");
    }

    #[test]
    fn no_commits_a_clean_tree_a_merge_and_a_cancel_are_refused() {
        if !have_git() {
            return;
        }
        let empty = scratch("da-empty");
        g(&empty, &["init", "-q"]);
        fs::write(empty.join("a.txt"), "x\n").unwrap();
        assert_eq!(code(discard_all_with(&empty, true, &yes, &FakeTrash::refusing())), "no_commits");

        let clean = repo("da-clean");
        assert_eq!(code(discard_all_with(&clean, true, &yes, &FakeTrash::refusing())), "nothing_to_discard");

        let merging = conflicted_merge("da-merge");
        assert_eq!(code(discard_all_with(&merging, true, &yes, &FakeTrash::refusing())), "in_progress");

        let r = repo("da-cancel");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        assert_eq!(code(discard_all_with(&r, false, &no, &FakeTrash::refusing())), "cancelled");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "changed\n", "a cancelled discard changes nothing");
    }

    #[test]
    fn a_change_made_during_the_dialog_aborts_the_discard() {
        if !have_git() {
            return;
        }
        let r = repo("da-changed");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        let ask = |_: &str| {
            fs::write(r.join("a.txt"), "edited during the dialog\n").unwrap();
            true
        };
        assert_eq!(code(discard_all_with(&r, false, &ask, &FakeTrash::refusing())), "changed_since_confirm");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "edited during the dialog\n");
    }

    #[test]
    fn the_dialog_names_the_counts_and_the_trash_choice() {
        if !have_git() {
            return;
        }
        let r = repo("da-prompt");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        fs::write(r.join("new.txt"), "x\n").unwrap();
        let seen = RefCell::new(String::new());
        let ask = |p: &str| {
            *seen.borrow_mut() = p.to_string();
            false
        };
        let _ = discard_all_with(&r, true, &ask, &FakeTrash::refusing());
        let text = seen.borrow().clone();
        assert!(text.contains("1 file(s) will be reset to HEAD"), "{text}");
        assert!(text.contains("1 untracked item(s) will be moved to the Trash"), "{text}");
        assert!(text.contains("Ignored files (the repository's .gitignore and your global ignore file) are never touched"), "{text}");
        let _ = discard_all_with(&r, false, &ask, &FakeTrash::refusing());
        assert!(seen.borrow().contains("Untracked files are not touched"));
    }

    // ---- review additions -------------------------------------------------------------------

    #[test]
    fn discard_all_trashes_files_only_never_ignored_files_or_a_deep_nested_repo() {
        if !have_git() {
            return;
        }
        let r = repo("rv-classes");
        fs::write(r.join(".gitignore"), "*.env\n").unwrap();
        commit_file(&r, "c.txt", "c\n", "c");
        commit_file(&r, "old.txt", "old\n", "old");
        // An untracked folder holding an ignored file and a nested repository two levels down.
        fs::create_dir_all(r.join("d/deep/n")).unwrap();
        g(&r.join("d/deep/n"), &["init", "-q"]);
        fs::write(r.join("d/deep/n/inner.txt"), "inner\n").unwrap();
        fs::write(r.join("d/f.txt"), "f\n").unwrap();
        fs::write(r.join("d/secret.env"), "secret\n").unwrap();
        // Intent-to-add, a force-added ignored file, a staged deletion, a rename in the index, an odd name.
        fs::write(r.join("ita.txt"), "ita\n").unwrap();
        g(&r, &["add", "-N", "ita.txt"]);
        fs::write(r.join("forced.env"), "forced\n").unwrap();
        g(&r, &["add", "-f", "forced.env"]);
        g(&r, &["rm", "-q", "c.txt"]);
        g(&r, &["mv", "old.txt", "new.txt"]);
        let odd = "sp ace \u{e9}.txt";
        fs::write(r.join(odd), "odd\n").unwrap();
        // Windows forbids control characters in names, so only the nested repository is skipped there.
        let ctl = !cfg!(windows);
        if ctl {
            fs::write(r.join("new\nline.txt"), "kept\n").unwrap();
        }
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        let trash = scratch("rv-classes-trash");
        let seen = RefCell::new(String::new());
        let ask = |p: &str| {
            *seen.borrow_mut() = p.to_string();
            true
        };
        let res = discard_all_with(&r, true, &ask, &FakeTrash::into(&trash)).unwrap();
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "base\n");
        assert_eq!(fs::read_to_string(r.join("c.txt")).unwrap(), "c\n", "staged deletion restored");
        assert_eq!(fs::read_to_string(r.join("old.txt")).unwrap(), "old\n", "rename undone");
        for gone in ["new.txt", "ita.txt", odd, "d/f.txt"] {
            assert!(!r.join(gone).exists(), "{gone:?} still there: {res:?}");
        }
        assert_eq!(fs::read_to_string(r.join("d/secret.env")).unwrap(), "secret\n", "an ignored file inside an untracked folder stays");
        assert_eq!(fs::read_to_string(r.join("forced.env")).unwrap(), "forced\n", "a force-added ignored file stays once unstaged");
        assert!(r.join("d/deep/n/.git").exists() && r.join("d/deep/n/inner.txt").exists(), "the nested repository stays");
        assert!(!ctl || r.join("new\nline.txt").exists(), "a control-character name is left, never deleted");
        assert_eq!(res.trashed, 4, "{res:?}");
        assert_eq!(res.skipped, 1 + u32::from(ctl), "the nested repository and the control-character name: {res:?}");
        assert!(seen.borrow().contains("4 untracked item(s)"), "the dialog counted what was then done: {}", seen.borrow());
    }

    #[test]
    fn a_file_added_during_the_dialog_aborts_the_discard() {
        if !have_git() {
            return;
        }
        let r = repo("rv-added");
        fs::write(r.join("a.txt"), "changed\n").unwrap();
        let ask = |_: &str| {
            fs::write(r.join("late.txt"), "late\n").unwrap();
            true
        };
        assert_eq!(code(discard_all_with(&r, true, &ask, &FakeTrash::refusing())), "changed_since_confirm");
        assert_eq!(fs::read_to_string(r.join("a.txt")).unwrap(), "changed\n");
        assert!(r.join("late.txt").exists());
    }

    #[cfg(unix)]
    fn hostile_hooks(r: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let marker = r.parent().unwrap().join(format!("{}-hook-ran", r.file_name().unwrap().to_string_lossy()));
        let _ = fs::remove_file(&marker);
        for h in ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit", "pre-merge-commit", "post-merge", "post-rewrite", "post-checkout", "reference-transaction"] {
            let p = r.join(".git/hooks").join(h);
            fs::write(&p, format!("#!/bin/sh\necho {h} >> '{}'\n", marker.display())).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        marker
    }

    #[cfg(unix)]
    #[test]
    fn hostile_hooks_never_run_for_merge_amend_abort_or_discard_all() {
        if !have_git() {
            return;
        }
        let r = repo_with_feat("rv-hooks");
        let marker = hostile_hooks(&r);
        merge(&r, "feat", MergeMode::NoFastForward, &ada(), &yes).unwrap();
        fs::write(r.join("a.txt"), "x\n").unwrap();
        g(&r, &["add", "a.txt"]);
        commit_amend(&r, Some("amended"), false, &ada(), &yes).unwrap();
        fs::write(r.join("a.txt"), "y\n").unwrap();
        discard_all_with(&r, false, &yes, &FakeTrash::refusing()).unwrap();
        assert!(!marker.exists(), "a hook ran: {:?}", fs::read_to_string(&marker));
        let c = conflicted_merge("rv-hooks-abort");
        let marker = hostile_hooks(&c);
        merge_abort(&c, &yes).unwrap();
        assert!(!marker.exists(), "a hook ran on abort");
    }

    #[cfg(unix)]
    #[test]
    fn a_hostile_merge_driver_never_runs() {
        if !have_git() {
            return;
        }
        // Configured driver: the repo config is not on the allowlist, so nothing runs at all.
        let r = repo("rv-driver");
        g(&r, &["checkout", "-q", "-b", "feat"]);
        commit_file(&r, "a.txt", "feat\n", "feat edit");
        g(&r, &["checkout", "-q", "main"]);
        commit_file(&r, "a.txt", "main\n", "main edit");
        fs::write(r.join(".gitattributes"), "* merge=evil\n").unwrap();
        g(&r, &["add", "."]);
        g(&r, &["commit", "-q", "-m", "attrs"]);
        let marker = r.parent().unwrap().join("rv-driver-ran");
        let _ = fs::remove_file(&marker);
        let clean = fs::read_to_string(r.join(".git/config")).unwrap();
        fs::write(r.join(".git/config"), format!("{clean}[merge \"evil\"]\n\tdriver = touch {} %A\n", marker.display())).unwrap();
        assert_ne!(code(merge(&r, "feat", MergeMode::FastForward, &ada(), &yes)), "ok");
        assert_eq!(code(status(&r)), "untrusted_repo_config");
        assert!(!marker.exists());
        // Attributes alone name a driver git does not have: a plain text merge, conflicts reported.
        fs::write(r.join(".git/config"), clean).unwrap();
        let res = merge(&r, "feat", MergeMode::FastForward, &ada(), &yes).unwrap();
        assert!(matches!(res, MergeOutcome::Conflicts { .. }), "{res:?}");
        assert!(!marker.exists());
    }

    #[test]
    fn a_same_message_amend_with_nothing_staged_is_nothing_to_amend() {
        if !have_git() {
            return;
        }
        let r = two_commits("rv-same");
        let head = out(&r, &["rev-parse", "HEAD"]);
        assert_eq!(code(commit_amend(&r, Some("second"), false, &ada(), &yes)), "nothing_to_amend");
        assert_eq!(out(&r, &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn a_force_amend_always_asks_natively() {
        if !have_git() {
            return;
        }
        // The webview may send force: true without the already_pushed step: the host still asks.
        let r = two_commits("rv-force");
        let head = out(&r, &["rev-parse", "HEAD"]);
        assert_eq!(code(commit_amend(&r, Some("new"), true, &ada(), &no)), "cancelled");
        assert_eq!(out(&r, &["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn merging_a_branch_checked_out_in_another_worktree_leaves_it_alone() {
        if !have_git() {
            return;
        }
        let r = repo_with_feat("rv-wt");
        let wt = r.parent().unwrap().join(format!("llmide-mad-{}-rv-wt-linked", std::process::id()));
        let _ = fs::remove_dir_all(&wt);
        g(&r, &["worktree", "add", "-q", crate::fsutil::plain_path(&wt).to_str().unwrap(), "feat"]);
        let tip = out(&r, &["rev-parse", "refs/heads/feat"]);
        merge(&r, "feat", MergeMode::NoFastForward, &ada(), &yes).unwrap();
        assert_eq!(out(&r, &["rev-parse", "refs/heads/feat"]), tip);
        assert_eq!(out(&r, &["rev-parse", "HEAD^2"]), tip);
        let _ = fs::remove_dir_all(&wt);
    }
}
