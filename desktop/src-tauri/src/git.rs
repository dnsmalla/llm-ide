//! Local git for the Explorer: status, diff, file-at-revision and stage/unstage.
//! No commit, push or pull here (those are later Source Control slices).
//!
//! Hardening, because the repository content is untrusted (a cloned project can try to make
//! `git` run a program):
//! - `git` is spawned directly with an argument array, never through a shell, with a cleared
//!   environment (PATH only, plus the few variables Windows needs) and
//!   `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointing at the null device so only the repo's own
//!   config applies. `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_LITERAL_PATHSPECS=1`
//!   (a file named `:(glob)*` is just a file), `GIT_PAGER=cat`, `LC_ALL=C`.
//! - `core.fsmonitor`, `core.hooksPath`, `core.pager`, `core.sshCommand` and `diff.external`
//!   are forced off on the command line, and diffs run with `--no-ext-diff --no-textconv`.
//! - The repo config (and `config.worktree`, and the linked worktree / submodule git dirs) must pass
//!   the strict ALLOWLIST in `git_config.rs`; anything else makes the repo `untrusted_repo_config`:
//!   nothing runs until the user reviews it outside the app. Submodules are never descended into.
//! - `GIT_CEILING_DIRECTORIES` is the root's parent, so discovery never climbs out of the project.
//! - Output is capped and every call has a wall-clock timeout; the child is killed on either.
//! - Paths are the same relative, validated paths as the fs commands; `--` precedes them.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::fs_ops::{split_rel, FsError, R};

const TIMEOUT: Duration = Duration::from_secs(30);
const STATUS_CAP: usize = 16 * 1024 * 1024;
const DIFF_CAP: usize = 2 * 1024 * 1024;
const SHOW_CAP: usize = 5 * 1024 * 1024;
const MAX_STATUS_ENTRIES: usize = 20_000;
const MAX_STAGE_PATHS: usize = 500;

fn gerr<T>(code: &'static str, message: impl Into<String>) -> R<T> {
    Err(FsError { code, message: message.into() })
}

#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

/// Reads one config file for the scan. `None` = absent; a symlink, a non-regular file or a read
/// error is untrusted (git would follow/parse it, we cannot vouch for it).
fn read_config(path: &Path) -> R<Option<Vec<u8>>> {
    let untrusted = |why: &str| gerr("untrusted_repo_config", format!("{why}: {}", path.display()));
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return untrusted("cannot inspect git config"),
        Ok(m) if m.file_type().is_symlink() || !m.is_file() => return untrusted("git config is not a regular file"),
        Ok(_) => {}
    }
    let f = crate::fs_ops::open_nofollow(path, false).map_err(|_| FsError { code: "untrusted_repo_config", message: format!("cannot read git config: {}", path.display()) })?;
    let mut b = Vec::new();
    let _ = f.take(crate::git_config::MAX_CONFIG_BYTES as u64 + 1).read_to_end(&mut b);
    Ok(Some(b))
}

/// Validates `<dir>/config` and `<dir>/config.worktree` (git reads the latter with
/// `extensions.worktreeConfig`, which the allowlist forbids; it is scanned regardless).
fn check_git_dir(dir: &Path, allow_worktree: bool) -> R<Option<String>> {
    let mut wt = None;
    for name in ["config", "config.worktree"] {
        let f = dir.join(name);
        if let Some(bytes) = read_config(&f)? {
            match crate::git_config::check_config_ex(&bytes, allow_worktree && name == "config") {
                Ok(w) => wt = wt.or(w),
                Err(why) => {
                    return gerr(
                        "untrusted_repo_config",
                        format!("the repository config contains a setting that is not on the safe list ({why}); review {} first", f.display()),
                    )
                }
            }
        }
    }
    Ok(wt)
}

fn untrusted<T>(why: &str) -> R<T> {
    gerr("untrusted_repo_config", why.to_string())
}

fn read_small(path: &Path) -> Option<String> {
    let f = std::fs::File::open(path).ok()?;
    let mut s = String::new();
    f.take(4096).read_to_string(&mut s).ok()?;
    Some(s)
}

/// Resolves and validates every git directory git would read for `root`.
fn check_repo(root: &Path) -> R<()> {
    let dotgit = root.join(".git");
    let meta = match std::fs::symlink_metadata(&dotgit) {
        Ok(m) => m,
        Err(_) => return gerr("not_a_repo", "this folder is not a git repository"),
    };
    if meta.file_type().is_symlink() {
        return untrusted(".git is a symbolic link");
    }
    if meta.is_dir() {
        check_git_dir(&dotgit, false)?;
        return Ok(());
    }
    // `.git` FILE: `gitdir: <path>` (linked worktree, or a submodule checkout).
    let Some(text) = read_small(&dotgit) else { return untrusted("cannot read the .git file") };
    let Some(target) = text.trim().strip_prefix("gitdir:") else { return gerr("not_a_repo", "this folder is not a git repository") };
    let croot = std::fs::canonicalize(root).map_err(|e| FsError { code: "io", message: format!("cannot resolve the project root: {e}") })?;
    let target = Path::new(target.trim());
    let gd = std::fs::canonicalize(if target.is_absolute() { target.to_path_buf() } else { root.join(target) })
        .map_err(|_| FsError { code: "untrusted_repo_config", message: "the .git file points at a missing folder".into() })?;
    if !gd.is_dir() {
        return untrusted("the .git file does not point at a folder");
    }
    let inside = gd.starts_with(&croot);
    // Outside the project it must be a real linked worktree (its `gitdir` back-pointer names this
    // checkout) or a submodule git dir whose `core.worktree` names exactly this folder.
    let back_ok = read_small(&gd.join("gitdir"))
        .and_then(|b| std::fs::canonicalize(Path::new(b.trim())).ok())
        .is_some_and(|p| p == croot.join(".git") || p == dotgit);
    let wt = check_git_dir(&gd, !inside && !back_ok)?;
    if !inside && !back_ok {
        let ok = wt.is_some_and(|w| std::fs::canonicalize(gd.join(w)).is_ok_and(|p| p == croot))
            && gd.components().any(|c| c.as_os_str() == "modules");
        if !ok {
            return untrusted("the .git file points outside the project and is not a linked worktree or submodule of it");
        }
    }
    if let Some(c) = read_small(&gd.join("commondir")) {
        let common = std::fs::canonicalize(gd.join(c.trim())).map_err(|_| FsError { code: "untrusted_repo_config", message: "commondir is missing".into() })?;
        if common != gd {
            if !(inside && common.starts_with(&croot)) && !back_ok {
                return untrusted("commondir points outside the project");
            }
            check_git_dir(&common, false)?;
        }
    }
    Ok(())
}

fn fallback_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    let extras: &[&str] = if cfg!(windows) { &["C:\\Program Files\\Git\\cmd"] } else { &["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"] };
    for extra in extras {
        let p = PathBuf::from(extra);
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Absolute path of `git`, searched only in ABSOLUTE PATH entries (a relative entry, or `.`,
/// could pick up a program planted in the project).
fn find_git() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["git.exe", "git.cmd"] } else { &["git"] };
    std::env::split_paths(&fallback_path())
        .filter(|d| d.is_absolute())
        .flat_map(|d| names.iter().map(move |n| d.join(n)).collect::<Vec<_>>())
        .find(|p| p.is_file())
}

/// The arguments that precede every git subcommand (config overrides).
pub fn base_args() -> Vec<String> {
    [
        "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "core.quotepath=false",
        "-c", "core.sshCommand=false", "-c", "diff.external=", "-c", "credential.helper=", "-c", "gc.auto=0",
        "-c", "core.untrackedCache=false", "-c", "core.attributesFile=/dev/null", "-c", "submodule.recurse=false",
        "-c", "protocol.allow=never", "-c", "status.submoduleSummary=false", "-c", "maintenance.auto=false",
        "-c", "diff.ignoreSubmodules=dirty",
    ]
    .iter()
    .map(|s| s.to_string())
    .map(|s| if cfg!(windows) { s.replace("/dev/null", "NUL") } else { s })
    .collect()
}

pub struct Out {
    pub stdout: Vec<u8>,
    pub truncated: bool,
}

/// Per-call extras for the hardened runner. The defaults are the read-only, no-input case.
#[derive(Default)]
pub(crate) struct Opts<'a> {
    /// Bytes written to the child's stdin (a commit message, a patch); `None` = closed stdin.
    pub stdin: Option<&'a [u8]>,
    /// Let git read the USER'S global config (only for `config --get user.*`); never set for
    /// anything that can run a program.
    pub user_config: bool,
    /// Home directory override for `user_config` (tests); default is the process's own.
    pub home: Option<PathBuf>,
    /// Extra environment (author/committer identity).
    pub env: Vec<(&'static str, String)>,
    /// Wall-clock limit; default 30 s. Bulk index writes on huge trees use more.
    pub timeout: Option<Duration>,
}

/// Runs `git <base> args` in `root`. `Err` on spawn failure, timeout or non-zero exit (stderr in the message).
pub(crate) fn run_git(root: &Path, args: &[&str], cap: usize) -> R<Out> {
    run_git_opts(root, args, cap, &Opts::default())
}

pub(crate) fn run_git_opts(root: &Path, args: &[&str], cap: usize, opts: &Opts) -> R<Out> {
    check_repo(root)?;
    let git = find_git().ok_or(FsError { code: "git_unavailable", message: "git was not found on PATH".into() })?;
    let mut cmd = Command::new(git);
    cmd.args(base_args()).args(args).current_dir(root).env_clear();
    cmd.env("PATH", fallback_path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_SYSTEM", NULL_DEVICE)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_PAGER", "cat")
        .env("LC_ALL", "C");
    if opts.user_config {
        // Read-only lookup of the user's own identity: point git at their real global config.
        match &opts.home {
            Some(h) => {
                cmd.env("HOME", h).env("USERPROFILE", h).env("XDG_CONFIG_HOME", h.join(".config"));
            }
            None => {
                for k in ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"] {
                    if let Some(v) = std::env::var_os(k) {
                        cmd.env(k, v);
                    }
                }
            }
        }
    } else {
        cmd.env("GIT_CONFIG_GLOBAL", NULL_DEVICE);
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    if let Some(parent) = root.parent() {
        cmd.env("GIT_CEILING_DIRECTORIES", parent);
    }
    for k in ["SYSTEMROOT", "TEMP", "TMP", "TMPDIR"] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    cmd.stdin(if opts.stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| FsError { code: "git_unavailable", message: format!("cannot run git: {e}") })?;
    if let (Some(data), Some(mut si)) = (opts.stdin, child.stdin.take()) {
        // Written on its own thread so a child that stops reading cannot block us; dropping `si` closes stdin.
        let data = data.to_vec();
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = si.write_all(&data);
        });
    }
    let mut so = child.stdout.take().expect("piped");
    let mut se = child.stderr.take().expect("piped");
    let err_thread = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = (&mut se).take(8192).read_to_end(&mut b);
        // Keep draining so the child never blocks on a full pipe.
        let _ = std::io::copy(&mut se, &mut std::io::sink());
        b
    });
    let out_thread = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = (&mut so).take(cap as u64 + 1).read_to_end(&mut b);
        let over = b.len() > cap;
        b.truncate(cap);
        (b, over)
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if start.elapsed() > opts.timeout.unwrap_or(TIMEOUT) => break None,
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => return gerr("io", format!("git wait failed: {e}")),
        }
        // Output cap reached: stop the child instead of waiting for it to fill the disk.
        if out_thread.is_finished() {
            let _ = child.kill();
            break child.wait().ok();
        }
    };
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let (stdout, truncated) = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    match status {
        None => gerr("git_timeout", "git took too long"),
        Some(s) if s.success() || truncated => Ok(Out { stdout, truncated }),
        Some(_) => {
            let msg = String::from_utf8_lossy(&stderr).trim().to_string();
            let code = if msg.contains("not a git repository") { "not_a_repo" } else { "git_failed" };
            gerr(code, msg)
        }
    }
}

// ---- status ------------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    /// Index column (`.` unchanged, `M`, `A`, `D`, `R`, `C`, `T`, `U`).
    pub index: char,
    /// Worktree column.
    pub worktree: char,
    /// `changed`, `renamed`, `unmerged`, `untracked`.
    pub kind: &'static str,
    /// The path is a submodule (gitlink): staged as a commit pointer, never discarded here.
    pub submodule: bool,
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<StatusEntry>,
    pub truncated: bool,
}

/// Parses `git status --porcelain=v2 -z --branch` output.
pub fn parse_status(raw: &[u8]) -> GitStatus {
    let text = String::from_utf8_lossy(raw);
    let mut st = GitStatus::default();
    let mut it = text.split('\0').peekable();
    while let Some(rec) = it.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(h) = rec.strip_prefix("# ") {
            let mut p = h.splitn(2, ' ');
            match (p.next(), p.next()) {
                (Some("branch.oid"), Some(v)) => st.head = (v != "(initial)").then(|| v.to_string()),
                (Some("branch.head"), Some(v)) => st.branch = (v != "(detached)").then(|| v.to_string()),
                (Some("branch.upstream"), Some(v)) => st.upstream = Some(v.to_string()),
                (Some("branch.ab"), Some(v)) => {
                    for tok in v.split(' ') {
                        if let Some(n) = tok.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = tok.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if st.entries.len() >= MAX_STATUS_ENTRIES {
            st.truncated = true;
            break;
        }
        let kind = rec.as_bytes()[0];
        let xy = |s: &str| {
            let mut c = s.chars();
            (c.next().unwrap_or('.'), c.next().unwrap_or('.'))
        };
        match kind {
            b'1' => {
                // 1 XY sub mH mI mW hH hI path
                let f: Vec<&str> = rec.splitn(9, ' ').collect();
                if f.len() == 9 {
                    let (i, w) = xy(f[1]);
                    st.entries.push(StatusEntry { path: f[8].into(), orig_path: None, index: i, worktree: w, kind: "changed", submodule: f[2].starts_with('S') });
                }
            }
            b'2' => {
                // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
                let f: Vec<&str> = rec.splitn(10, ' ').collect();
                if f.len() == 10 {
                    let (i, w) = xy(f[1]);
                    let orig = it.next().map(str::to_string);
                    st.entries.push(StatusEntry { path: f[9].into(), orig_path: orig, index: i, worktree: w, kind: "renamed", submodule: f[2].starts_with('S') });
                }
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let f: Vec<&str> = rec.splitn(11, ' ').collect();
                if f.len() == 11 {
                    let (i, w) = xy(f[1]);
                    st.entries.push(StatusEntry { path: f[10].into(), orig_path: None, index: i, worktree: w, kind: "unmerged", submodule: f[2].starts_with('S') });
                }
            }
            b'?' => st.entries.push(StatusEntry { path: rec[2..].into(), orig_path: None, index: '.', worktree: '?', kind: "untracked", submodule: false }),
            _ => {}
        }
    }
    st
}

pub fn status(root: &Path) -> R<GitStatus> {
    let out = run_git(root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=normal", "--ignore-submodules=dirty"], STATUS_CAP)?;
    let mut s = parse_status(&out.stdout);
    s.truncated |= out.truncated;
    Ok(s)
}

// ---- diff / show / stage -----------------------------------------------------------------

pub(crate) fn rel_arg(rel: &str) -> R<String> {
    let parts = split_rel(rel)?;
    if parts.is_empty() {
        return gerr("invalid_path", "a file path is required");
    }
    if parts.iter().any(|p| p.eq_ignore_ascii_case(".git")) {
        return gerr("invalid_path", "the .git folder is not addressable");
    }
    Ok(rel.to_string())
}

#[derive(Serialize, Debug)]
pub struct DiffResult {
    pub text: String,
    pub truncated: bool,
}

pub fn diff(root: &Path, path: &str, staged: bool) -> R<DiffResult> {
    let p = rel_arg(path)?;
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", &p]);
    let out = run_git(root, &args, DIFF_CAP)?;
    Ok(DiffResult { text: String::from_utf8_lossy(&out.stdout).into_owned(), truncated: out.truncated })
}

#[derive(Serialize, Debug)]
pub struct ShowResult {
    /// False when the file is not in that revision (new file): `text` is empty.
    pub exists: bool,
    pub text: String,
    pub truncated: bool,
}

/// Content of `path` at `HEAD` (`rev = "head"`) or in the index (`"index"`), for the diff editor.
pub fn show(root: &Path, path: &str, rev: &str) -> R<ShowResult> {
    let p = rel_arg(path)?;
    let spec = match rev {
        "head" => format!("HEAD:{p}"),
        "index" => format!(":{p}"),
        _ => return gerr("invalid_path", "rev must be head or index"),
    };
    // `cat-file -e` first: a missing path is a normal answer, not an error.
    if run_git(root, &["cat-file", "-e", &spec], 16).is_err() {
        return Ok(ShowResult { exists: false, text: String::new(), truncated: false });
    }
    let out = run_git(root, &["--no-pager", "show", "--no-textconv", &spec], SHOW_CAP)?;
    Ok(ShowResult { exists: true, text: String::from_utf8_lossy(&out.stdout).into_owned(), truncated: out.truncated })
}

pub fn stage(root: &Path, paths: &[String], stage: bool) -> R<()> {
    if paths.is_empty() || paths.len() > MAX_STAGE_PATHS {
        return gerr("too_large", format!("stage between 1 and {MAX_STAGE_PATHS} paths per call"));
    }
    let rels = paths.iter().map(|p| rel_arg(p)).collect::<R<Vec<_>>>()?;
    let mut args: Vec<&str> = if stage {
        vec!["add", "-A", "--"]
    } else if run_git(root, &["rev-parse", "--verify", "-q", "HEAD"], 256).is_ok() {
        vec!["restore", "--staged", "--"]
    } else {
        // No commit yet: there is no HEAD to restore from.
        vec!["rm", "--cached", "-r", "-q", "--"]
    };
    args.extend(rels.iter().map(String::as_str));
    // `add`/`restore` write the index, so they must not use optional-lock avoidance of reads only; they take their own lock.
    run_git(root, &args, 64 * 1024).map(|_| ())
}

// ---- Tauri commands ------------------------------------------------------------------------

pub(crate) async fn blocking<T, F>(f: F) -> R<T>
where
    T: Send + 'static,
    F: FnOnce(PathBuf) -> R<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(crate::fs_ops::active_root()?))
        .await
        .map_err(|e| FsError { code: "io", message: format!("task failed: {e}") })?
}

#[tauri::command]
pub async fn git_status() -> R<GitStatus> {
    blocking(|root| status(&root)).await
}

#[derive(Deserialize)]
pub struct DiffReq {
    pub path: String,
    #[serde(default)]
    pub staged: bool,
}

#[tauri::command]
pub async fn git_diff(req: DiffReq) -> R<DiffResult> {
    blocking(move |root| diff(&root, &req.path, req.staged)).await
}

#[derive(Deserialize)]
pub struct ShowReq {
    pub path: String,
    pub rev: String,
}

#[tauri::command]
pub async fn git_show(req: ShowReq) -> R<ShowResult> {
    blocking(move |root| show(&root, &req.path, &req.rev)).await
}

#[derive(Deserialize)]
pub struct StageReq {
    pub paths: Vec<String>,
    pub stage: bool,
}

#[tauri::command]
pub async fn git_stage(req: StageReq) -> R<()> {
    blocking(move |root| stage(&root, &req.paths, req.stage)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn have_git() -> bool {
        Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("llmide-git-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    fn g(root: &Path, args: &[&str]) {
        let o = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
            .output()
            .unwrap();
        assert!(o.status.success(), "{args:?}: {}", String::from_utf8_lossy(&o.stderr));
    }

    #[test]
    fn runner_forces_the_hardening_flags() {
        let a = base_args().join(" ");
        for f in [
            "submodule.recurse=false", "protocol.allow=never", "status.submoduleSummary=false", "maintenance.auto=false",
            "gc.auto=0", "core.attributesFile=", "core.hooksPath=", "core.fsmonitor=false", "diff.ignoreSubmodules=dirty",
        ] {
            assert!(a.contains(f), "{f} missing from {a}");
        }
    }

    #[test]
    fn parses_status_v2() {
        let raw = b"# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 h1 h2 src/a b.rs\0\
2 R. N... 100644 100644 100644 h1 h2 R100 new.rs\0old.rs\0\
u UU N... 1 2 3 4 h1 h2 h3 conflict.txt\0\
? untracked.txt\0";
        let s = parse_status(raw);
        assert_eq!((s.branch.as_deref(), s.head.as_deref(), s.upstream.as_deref(), s.ahead, s.behind), (Some("main"), Some("abc123"), Some("origin/main"), 2, 1));
        assert_eq!(s.entries.len(), 4);
        assert_eq!((s.entries[0].path.as_str(), s.entries[0].worktree), ("src/a b.rs", 'M'));
        assert_eq!((s.entries[1].path.as_str(), s.entries[1].orig_path.as_deref(), s.entries[1].index), ("new.rs", Some("old.rs"), 'R'));
        assert_eq!(s.entries[2].kind, "unmerged");
        assert_eq!((s.entries[3].kind, s.entries[3].path.as_str()), ("untracked", "untracked.txt"));
        assert_eq!(parse_status(b"# branch.oid (initial)\0# branch.head main\0").head, None);
    }

    #[test]
    fn status_diff_show_stage_roundtrip() {
        if !have_git() {
            return;
        }
        let root = scratch("rt");
        g(&root, &["init", "-q"]);
        fs::write(root.join("a.txt"), "one\n").unwrap();
        assert_eq!(status(&root).unwrap().entries[0].kind, "untracked");
        stage(&root, &["a.txt".into()], true).unwrap();
        assert_eq!(status(&root).unwrap().entries[0].index, 'A');
        g(&root, &["commit", "-q", "-m", "init"]);
        fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(root.join(":(glob)*"), "literal pathspec\n").unwrap();
        let st = status(&root).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(st.entries.iter().any(|e| e.path == "a.txt" && e.worktree == 'M'));
        let d = diff(&root, "a.txt", false).unwrap();
        assert!(d.text.contains("+two"), "{}", d.text);
        assert_eq!(show(&root, "a.txt", "head").unwrap().text, "one\n");
        assert!(!show(&root, "nope.txt", "head").unwrap().exists);
        stage(&root, &["a.txt".into()], true).unwrap();
        assert!(diff(&root, "a.txt", true).unwrap().text.contains("+two"));
        assert_eq!(show(&root, "a.txt", "index").unwrap().text, "one\ntwo\n");
        stage(&root, &["a.txt".into()], false).unwrap();
        assert!(status(&root).unwrap().entries.iter().any(|e| e.path == "a.txt" && e.index == '.' && e.worktree == 'M'));
        // Literal pathspec: staging the weird name does not glob.
        stage(&root, &[":(glob)*".into()], true).unwrap();
        let st = status(&root).unwrap();
        assert!(st.entries.iter().any(|e| e.path == ":(glob)*" && e.index == 'A'));
        assert!(st.entries.iter().any(|e| e.path == "a.txt" && e.index == '.'));
    }

    #[test]
    fn refuses_bad_input_and_untrusted_config() {
        if !have_git() {
            return;
        }
        let root = scratch("bad");
        assert_eq!(status(&root).unwrap_err().code, "not_a_repo");
        g(&root, &["init", "-q"]);
        assert_eq!(diff(&root, "../x", false).unwrap_err().code, "invalid_path");
        assert_eq!(diff(&root, ".git/config", false).unwrap_err().code, "invalid_path");
        assert_eq!(show(&root, "a", "bogus").unwrap_err().code, "invalid_path");
        assert_eq!(stage(&root, &[], true).unwrap_err().code, "too_large");
        // A repo whose config would run a program is refused before git starts.
        let marker = root.join("pwned");
        let cfg = fs::read_to_string(root.join(".git/config")).unwrap();
        fs::write(root.join(".git/config"), format!("{cfg}[core]\n\tfsmonitor = touch {}\n", marker.display())).unwrap();
        assert_eq!(status(&root).unwrap_err().code, "untrusted_repo_config");
        assert!(!marker.exists());
    }

    fn cfg_append(root: &Path, bytes: &[u8]) {
        let mut cur = fs::read(root.join(".git/config")).unwrap();
        cur.extend_from_slice(bytes);
        fs::write(root.join(".git/config"), cur).unwrap();
    }

    /// Each of these defeated the old line-based denylist; each must now be refused before git starts.
    #[test]
    fn denylist_bypasses_are_refused() {
        if !have_git() {
            return;
        }
        let marker_dir = scratch("bypass-marker");
        let marker = marker_dir.join("pwned");
        let m = marker.display().to_string();
        let mut cases: Vec<(&str, Vec<u8>)> = vec![
            ("dotted filter subsection", format!("[filter.x]\n\tclean = touch {m}\n").into_bytes()),
            ("dotted diff subsection", format!("[diff.x]\n\ttextconv = touch {m}\n").into_bytes()),
            ("dotted includeif", b"[includeif.gitdir:/]\n\tpath = x\n".to_vec()),
            ("core.worktree", b"[core]\n\tworktree = /\n".to_vec()),
            ("submodule.recurse", b"[submodule]\n\trecurse = true\n".to_vec()),
            ("protocol.ext.allow", b"[protocol \"ext\"]\n\tallow = always\n".to_vec()),
            ("extensions.worktreeconfig", b"[extensions]\n\tworktreeConfig = true\n".to_vec()),
            ("alias", format!("[alias]\n\tx = !touch {m}\n").into_bytes()),
            ("http", b"[http]\n\tproxy = http://evil\n".to_vec()),
            ("merge driver", format!("[merge \"x\"]\n\tdriver = touch {m}\n").into_bytes()),
            ("line continuation", b"[core]\n\tfilemode = true \\\n[filter \"x\"]\n\tclean = x\n".to_vec()),
            ("unknown key", b"[core]\n\tsomethingnew = 1\n".to_vec()),
        ];
        // Invalid UTF-8 before the dangerous key (read_to_string used to give an empty scan).
        let mut bad = vec![0xff, 0xfe, b'\n'];
        bad.extend_from_slice(format!("[core]\n\tfsmonitor = touch {m}\n").as_bytes());
        cases.push(("invalid utf-8", bad));
        // A BOM makes the first line not start with '['.
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(format!("[filter \"x\"]\n\tclean = touch {m}\n").as_bytes());
        cases.push(("bom", bom));
        for (name, bytes) in &cases {
            let root = scratch("bypass");
            g(&root, &["init", "-q"]);
            fs::write(root.join("a.txt"), "x\n").unwrap();
            if *name == "bom" || *name == "invalid utf-8" {
                // The BOM / bad bytes replace the start of the file.
                let mut cur = bytes.clone();
                cur.extend_from_slice(&fs::read(root.join(".git/config")).unwrap());
                fs::write(root.join(".git/config"), cur).unwrap();
            } else {
                cfg_append(&root, bytes);
            }
            assert_eq!(status(&root).unwrap_err().code, "untrusted_repo_config", "{name}");
            assert_eq!(stage(&root, &["a.txt".into()], true).unwrap_err().code, "untrusted_repo_config", "{name}");
            assert!(!marker.exists(), "{name} ran a program");
        }
    }

    #[test]
    fn writing_git_config_through_the_fs_commands_then_staging_runs_nothing() {
        if !have_git() {
            return;
        }
        let root = scratch("combined");
        g(&root, &["init", "-q"]);
        let marker = root.join("combined-pwned");
        fs::write(root.join("a.txt"), "x\n").unwrap();
        let evil = format!("[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch {}\n[filter \"x\"]\n\tclean = touch {}\n", marker.display(), marker.display());
        for rel in [".git/config", ".GIT/config"] {
            let req = crate::fs_ops::WriteReq { path: rel.into(), text: evil.clone(), encoding: "utf-8".into(), bom: false, expected_hash: None, force: true };
            assert_eq!(crate::fs_ops::write_file(&root, &req).unwrap_err().code, "protected_path");
        }
        stage(&root, &["a.txt".into()], true).unwrap();
        assert!(!marker.exists());
    }

    #[test]
    fn config_worktree_is_scanned() {
        if !have_git() {
            return;
        }
        let root = scratch("cfgwt");
        g(&root, &["init", "-q"]);
        fs::write(root.join(".git/config.worktree"), "[core]\n\tfsmonitor = touch x\n").unwrap();
        assert_eq!(status(&root).unwrap_err().code, "untrusted_repo_config");
    }

    #[test]
    fn ordinary_configs_are_accepted() {
        if !have_git() {
            return;
        }
        let root = scratch("ordinary");
        g(&root, &["init", "-q"]);
        cfg_append(&root, b"[remote \"origin\"]\n\turl = https://example.com/x.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n[user]\n\tname = A\n\temail = a@b\n");
        status(&root).unwrap();
    }

    #[test]
    fn malicious_gitattributes_alone_runs_nothing() {
        if !have_git() || cfg!(windows) {
            return;
        }
        let root = scratch("attrs");
        g(&root, &["init", "-q"]);
        let marker = root.join("attr-pwned");
        fs::write(root.join(".gitattributes"), "* filter=evil diff=evil merge=evil\n").unwrap();
        fs::write(root.join("a.txt"), "x\n").unwrap();
        stage(&root, &["a.txt".into()], true).unwrap();
        status(&root).unwrap();
        diff(&root, "a.txt", true).unwrap();
        assert!(!marker.exists());
    }

    #[test]
    fn gitdir_file_must_point_into_the_project_or_be_a_real_worktree() {
        if !have_git() {
            return;
        }
        let evil = scratch("gd-evil");
        g(&evil, &["init", "-q"]);
        let root = scratch("gd-root");
        fs::write(root.join(".git"), format!("gitdir: {}\n", evil.join(".git").display())).unwrap();
        assert_eq!(status(&root).unwrap_err().code, "untrusted_repo_config");
        // A genuine linked worktree (back-pointer present) still works.
        let main = scratch("gd-main");
        g(&main, &["init", "-q"]);
        fs::write(main.join("f"), "x").unwrap();
        g(&main, &["add", "."]);
        g(&main, &["commit", "-q", "-m", "i"]);
        let wt = scratch("gd-wt");
        let _ = fs::remove_dir_all(&wt);
        g(&main, &["worktree", "add", "-q", "-b", "w", wt.to_str().unwrap()]);
        status(&wt).unwrap();
        // The backing config is scanned too.
        let mut cur = fs::read(main.join(".git/config")).unwrap();
        cur.extend_from_slice(b"[core]\n\tfsmonitor = x\n");
        fs::write(main.join(".git/config"), cur).unwrap();
        assert_eq!(status(&wt).unwrap_err().code, "untrusted_repo_config");
    }

    #[test]
    fn submodule_config_cannot_run_a_program() {
        if !have_git() || cfg!(windows) {
            return;
        }
        let inner = scratch("sm-inner");
        g(&inner, &["init", "-q"]);
        fs::write(inner.join("i"), "i").unwrap();
        g(&inner, &["add", "."]);
        g(&inner, &["commit", "-q", "-m", "i"]);
        let outer = scratch("sm-outer");
        g(&outer, &["init", "-q"]);
        fs::write(outer.join("o"), "o").unwrap();
        g(&outer, &["add", "."]);
        g(&outer, &["commit", "-q", "-m", "o"]);
        let o = Command::new("git").args(["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner.to_str().unwrap(), "sub"]).current_dir(&outer).env("GIT_CONFIG_GLOBAL", NULL_DEVICE).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        // The submodule's own config tries to run a program on any status/diff inside it.
        let marker = scratch("sm-marker").join("pwned");
        let gitfile = fs::read_to_string(outer.join("sub/.git")).unwrap();
        let gd = outer.join("sub").join(gitfile.trim().strip_prefix("gitdir:").unwrap().trim());
        let gd = fs::canonicalize(gd).unwrap();
        let mut cur = fs::read(gd.join("config")).unwrap();
        cur.extend_from_slice(format!("[core]\n\tfsmonitor = touch {}\n", marker.display()).as_bytes());
        fs::write(gd.join("config"), cur).unwrap();
        fs::write(outer.join("sub/new.txt"), "n").unwrap();
        status(&outer).unwrap();
        stage(&outer, &["sub".into()], true).unwrap();
        diff(&outer, "sub", true).unwrap();
        assert!(!marker.exists(), "git descended into the submodule and ran its fsmonitor");
    }

    #[test]
    fn repo_above_root_is_not_discovered() {
        if !have_git() {
            return;
        }
        let outer = scratch("outer");
        g(&outer, &["init", "-q"]);
        let inner = outer.join("proj");
        fs::create_dir(&inner).unwrap();
        // `proj` has no .git of its own: refused up front, never the outer repo's status.
        assert_eq!(status(&inner).unwrap_err().code, "not_a_repo");
    }
}
