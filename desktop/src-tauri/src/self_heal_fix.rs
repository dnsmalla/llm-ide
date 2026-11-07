//! Self-Heal fix runs, host side (plan B: docs/superpowers/plans/2026-11-07-self-heal-b-fix-loop.md).
//!
//! Debug builds only: every command refuses unless `self_heal::enabled()`. The webview drives one manual run:
//! 1. the core picks the batch (`POST /kb/self-heal/runs`);
//! 2. `self_heal_prepare` adds a fresh git worktree of the source checkout at
//!    `<data dir>/self-heal/loop-worktrees/<run id>` (the `loop-worktrees` segment is what the core's Loop agent
//!    accepts) on branch `self-heal/<run id>`, and writes `.self-heal/BATCH.md` there;
//! 3. the core's Loop agent (`POST /kb/loop/agent-run`) edits the worktree;
//! 4. `self_heal_verify` reads the answered batch, reverts the verifier's own files, notes whether a diff is left, and
//!    runs the SOURCE CHECKOUT's `scripts/self-heal-verify.sh` (`make regression`) in the worktree;
//! 5. `self_heal_diff` / `self_heal_apply` show and apply exactly the reviewed patch to the source checkout (never a
//!    commit); `self_heal_remove` removes the worktree and its branch.
//!
//! The webview names a run id only, never a path or a command. Git runs directly (`loop_runner::git_command`, the
//! GIT_* overrides stripped) with `git::base_args()` (hooks, fsmonitor, pager, external diff and credential helpers
//! off). The hardened Explorer runner (`git::run_git_opts`) is not used: its config allowlist refuses this repo's own
//! config (`core.hookspath` from setup.sh), and the source checkout is the developer's own repository.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::AtomicBool;

use serde::Serialize;
use sha2::{Digest, Sha256};

pub const BATCH_REL: &str = ".self-heal/BATCH.md";
const BATCH_MAX: usize = 1024 * 1024;
/// The Mac's Verify stage budget: a cold `make regression` builds graph-kit in release mode.
const VERIFY_TIMEOUT_SECS: u64 = 5_400;
const OUTPUT_TAIL: usize = 4_000;
const DIFF_TEXT_MAX: usize = 2 * 1024 * 1024;
/// Never part of a proposal: the batch, the submodule copies and the borrowed dependencies.
// `**/node_modules` alone matches the folder, not the files under it: a glob pathspec must match the whole path.
const EXCLUDES: &[&str] = &[":(exclude).self-heal", ":(exclude).skills", ":(exclude)graph-kit", ":(exclude,glob)**/node_modules/**"];

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub main_repo: String,
    pub worktree_path: String,
    pub branch: String,
    pub base_commit: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    /// The answered `.self-heal/BATCH.md` (the core parses it), at most 1 MiB.
    pub batch: String,
    pub passed: bool,
    pub timed_out: bool,
    /// The worktree differs from its base outside the excluded paths (measured before the verify run).
    pub has_changes: bool,
    /// Protected paths the agent touched, reverted before anything was judged.
    pub reverted: Vec<String>,
    pub output: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDiff {
    /// The text diff the page shows (binary changes read "Binary files differ"), at most 2 MiB.
    pub text: String,
    pub truncated: bool,
    /// sha256 of the `--binary` patch this text was derived from: Apply applies only that patch.
    pub patch_id: String,
}

/// A run id is the core's lowercase uuid: it becomes a folder and a branch name, so nothing else is accepted.
pub fn valid_run_id(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_digit() || ('a'..='f').contains(&c) })
}

/// The verifier's own files: the Makefile gates, the scripts and the npm scripts `make regression` runs.
pub fn protected(path: &str) -> bool {
    path == "Makefile" || path.starts_with("scripts/") || path.ends_with(".sh") || path == "package.json" || path.ends_with("/package.json")
}

fn git(dir: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut cmd = crate::loop_runner::git_command();
    cmd.args(crate::git::base_args())
        .args(args)
        .current_dir(crate::fsutil::plain_path(dir))
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("cannot run git: {e}"))?;
    if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) {
        // Written on its own thread so a git that exits early cannot block us (Rust ignores SIGPIPE: EPIPE is an Err).
        let data = data.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let out = child.wait_with_output().map_err(|e| format!("git failed: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {} failed: {}", args.first().copied().unwrap_or(""), err.lines().next().unwrap_or("unknown error")));
    }
    Ok(out.stdout)
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

/// The source checkout a run fixes: holds the core, is the top of a MAIN git checkout (the Loop agent accepts only
/// a worktree under `<root>/.git/worktrees`). Canonical.
pub fn checked_source(root: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| format!("cannot resolve the source checkout: {e}"))?;
    if !root.join("extension").join("server.mjs").is_file() {
        return Err(format!("{} has no extension/server.mjs", root.display()));
    }
    if !root.join(".git").is_dir() {
        return Err("the source checkout must be a main git checkout (its .git is a folder)".into());
    }
    let top = PathBuf::from(text(git(&root, &["rev-parse", "--show-toplevel"], None)?));
    if top.canonicalize().ok().as_deref() != Some(root.as_path()) {
        return Err("the source checkout is not the top of its git repository".into());
    }
    Ok(root)
}

/// The root the core runs from in this debug build (the repo checkout or the source-checkout backend).
fn source_root() -> Result<PathBuf, String> {
    let rt = crate::core_host::runtime_for(&crate::prefs::launch())?;
    if rt.mode == "bundled" {
        return Err("Self-Heal needs a source checkout, and this app runs its bundled core".into());
    }
    checked_source(&rt.root)
}

fn worktrees_dir() -> Result<PathBuf, String> {
    Ok(crate::fsutil::desktop_data_dir()?.join("self-heal").join("loop-worktrees"))
}

pub fn prepare_in(main: &Path, dir: &Path, run_id: &str, batch: &str) -> Result<Prepared, String> {
    if !valid_run_id(run_id) {
        return Err("invalid run id".into());
    }
    if batch.trim().is_empty() || batch.len() > BATCH_MAX {
        return Err("the batch is empty or larger than 1 MiB".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create the Self-Heal worktree folder: {e}"))?;
    let wt = dir.join(run_id);
    if wt.exists() {
        return Err("that run already has a worktree".into());
    }
    let base = text(git(main, &["rev-parse", "HEAD"], None)?);
    let branch = format!("self-heal/{run_id}");
    let wt_s = wt.to_string_lossy().into_owned();
    git(main, &["worktree", "add", "--quiet", "-b", &branch, &wt_s, &base], None)?;
    let written = (|| -> Result<Prepared, String> {
        std::fs::create_dir_all(wt.join(".self-heal")).map_err(|e| e.to_string())?;
        std::fs::write(wt.join(BATCH_REL), batch).map_err(|e| e.to_string())?;
        let real = wt.canonicalize().map_err(|e| e.to_string())?;
        Ok(Prepared {
            main_repo: main.to_string_lossy().into_owned(),
            worktree_path: real.to_string_lossy().into_owned(),
            branch: branch.clone(),
            base_commit: base.clone(),
        })
    })();
    if written.is_err() {
        let _ = remove_in(main, dir, run_id);
    }
    written.map_err(|e| format!("cannot write {BATCH_REL}: {e}"))
}

/// The run's worktree, only when it exists AND belongs to `main` (its common git dir is `main/.git`).
fn worktree_of(main: &Path, dir: &Path, run_id: &str) -> Result<PathBuf, String> {
    if !valid_run_id(run_id) {
        return Err("invalid run id".into());
    }
    let wt = dir.join(run_id);
    if !wt.join(".git").is_file() {
        return Err("that Self-Heal worktree no longer exists".into());
    }
    let common = PathBuf::from(text(git(&wt, &["rev-parse", "--path-format=absolute", "--git-common-dir"], None)?));
    if common.canonicalize().ok() != main.join(".git").canonicalize().ok() {
        return Err("that worktree does not belong to the source checkout".into());
    }
    Ok(wt)
}

fn pathspec() -> Vec<&'static str> {
    let mut v = vec!["--", "."];
    v.extend_from_slice(EXCLUDES);
    v
}

/// Stages everything outside the excludes and returns the diff against the base (HEAD: a run never commits).
fn staged_patch(wt: &Path, binary: bool) -> Result<Vec<u8>, String> {
    let mut add = vec!["add", "-A"];
    add.extend(pathspec());
    git(wt, &add, None)?;
    let mut diff = vec!["diff", "--cached", "--no-ext-diff", "--no-textconv"];
    if binary {
        diff.push("--binary");
    }
    diff.push("HEAD");
    diff.extend(pathspec());
    git(wt, &diff, None)
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn tail(s: &str, max: usize) -> String {
    let mut start = s.len().saturating_sub(max);
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

pub fn verify_in(main: &Path, dir: &Path, run_id: &str, timeout_secs: u64) -> Result<Verified, String> {
    if cfg!(windows) {
        return Err("Self-Heal verify runs bash, so it needs macOS or Linux".into());
    }
    let wt = worktree_of(main, dir, run_id)?;
    let mut batch = String::new();
    if let Ok(f) = std::fs::File::open(wt.join(BATCH_REL)) {
        let _ = f.take(BATCH_MAX as u64).read_to_string(&mut batch);
    }
    let _ = std::fs::remove_dir_all(wt.join(".self-heal"));
    // The verifier's own files go back first, so an edit to them can never make `make regression` pass.
    let reverted: Vec<String> = crate::loop_runner::changed_paths_in(&wt)?.into_iter().filter(|p| protected(p)).collect();
    if !reverted.is_empty() {
        // A fresh worktree: nobody but the agent wrote in it, so every untracked path in it is the agent's.
        crate::loop_runner::revert_paths_in(&wt, &reverted, &reverted)?;
    }
    // Before the verify run, which borrows dependencies into the worktree and may write build output.
    let has_changes = !staged_patch(&wt, false)?.is_empty();
    let script = main.join("scripts").join("self-heal-verify.sh");
    if !script.is_file() {
        return Err("scripts/self-heal-verify.sh is missing from the source checkout".into());
    }
    let never = AtomicBool::new(false);
    let command = format!("bash {}", sh_quote(&script.to_string_lossy()));
    let run = crate::loop_runner::run_command_cancellable(&wt, &command, Some(timeout_secs), None, &never)?;
    // A kept proposal needs its sources only; a release build of graph-kit is hundreds of MB.
    let _ = std::fs::remove_dir_all(wt.join("graph-kit").join(".build"));
    Ok(Verified {
        batch,
        passed: !run.timed_out && run.exit_code == Some(0),
        timed_out: run.timed_out,
        has_changes,
        reverted,
        output: tail(&format!("{}\n{}", run.stdout, run.stderr), OUTPUT_TAIL),
    })
}

/// Removes the run's worktree (borrowed links and copies included) and its branch. Harmless when already gone.
pub fn remove_in(main: &Path, dir: &Path, run_id: &str) -> Result<(), String> {
    if !valid_run_id(run_id) {
        return Err("invalid run id".into());
    }
    let wt = dir.join(run_id);
    if wt.exists() {
        let wt_s = wt.to_string_lossy().into_owned();
        git(main, &["worktree", "remove", "--force", &wt_s], None)?;
    } else {
        let _ = git(main, &["worktree", "prune"], None);
    }
    let _ = git(main, &["branch", "-D", &format!("self-heal/{run_id}")], None);
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Stages once; the shown text and the applicable patch come from that one index state (the Mac's reviewedPatch).
pub fn diff_in(main: &Path, dir: &Path, run_id: &str) -> Result<ProposalDiff, String> {
    let wt = worktree_of(main, dir, run_id)?;
    let patch = staged_patch(&wt, true)?;
    let mut args = vec!["diff", "--cached", "--no-ext-diff", "--no-textconv", "HEAD"];
    args.extend(pathspec());
    let full = String::from_utf8_lossy(&git(&wt, &args, None)?).into_owned();
    let truncated = full.len() > DIFF_TEXT_MAX;
    let text = if truncated {
        let mut cut = DIFF_TEXT_MAX;
        while !full.is_char_boundary(cut) {
            cut -= 1;
        }
        full[..cut].to_string()
    } else {
        full
    };
    Ok(ProposalDiff { text, truncated, patch_id: sha256_hex(&patch) })
}

/// Applies exactly the reviewed patch to the source checkout, never a commit, then removes the worktree.
pub fn apply_in(main: &Path, dir: &Path, run_id: &str, patch_id: &str) -> Result<(), String> {
    let wt = worktree_of(main, dir, run_id)?;
    let patch = staged_patch(&wt, true)?;
    if patch.is_empty() {
        return Err("The proposal has no changes.".into());
    }
    if sha256_hex(&patch) != patch_id {
        return Err("The proposal changed since you opened it. Close it and review it again.".into());
    }
    // All or nothing: a partial apply would leave the checkout half changed.
    git(main, &["apply", "--check", "-"], Some(&patch))?;
    git(main, &["apply", "-"], Some(&patch))?;
    // Applied: a failed cleanup must not read as a failed apply (a retry would then fail its --check).
    let _ = remove_in(main, dir, run_id);
    Ok(())
}

#[tauri::command]
pub async fn self_heal_source() -> Result<String, String> {
    blocking(|| Ok(ready()?.0.to_string_lossy().into_owned())).await
}

#[tauri::command]
pub async fn self_heal_prepare(run_id: String, batch: String) -> Result<Prepared, String> {
    blocking(move || {
        let (main, dir) = ready()?;
        prepare_in(&main, &dir, &run_id, &batch)
    })
    .await
}

#[tauri::command]
pub async fn self_heal_verify(run_id: String) -> Result<Verified, String> {
    blocking(move || {
        let (main, dir) = ready()?;
        verify_in(&main, &dir, &run_id, VERIFY_TIMEOUT_SECS)
    })
    .await
}

#[tauri::command]
pub async fn self_heal_diff(run_id: String) -> Result<ProposalDiff, String> {
    blocking(move || {
        let (main, dir) = ready()?;
        diff_in(&main, &dir, &run_id)
    })
    .await
}

#[tauri::command]
pub async fn self_heal_apply(run_id: String, patch_id: String) -> Result<(), String> {
    blocking(move || {
        let (main, dir) = ready()?;
        apply_in(&main, &dir, &run_id, &patch_id)
    })
    .await
}

#[tauri::command]
pub async fn self_heal_remove(run_id: String) -> Result<(), String> {
    blocking(move || {
        let (main, dir) = ready()?;
        remove_in(&main, &dir, &run_id)
    })
    .await
}

fn ready() -> Result<(PathBuf, PathBuf), String> {
    if !crate::self_heal::enabled() {
        return Err("Self-Heal runs only in a debug build".into());
    }
    Ok((source_root()?, worktrees_dir()?))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("Self-Heal task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const RUN: &str = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

    fn sh_git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args)
            .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t")
            .output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A source checkout shaped like this repo's (extension/server.mjs, a Makefile, the verify script = `exit <code>`),
    /// and the worktrees folder for it.
    pub(super) fn checkout(name: &str, verify_exit: i32) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("llmide-shfix-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let main = root.join("main");
        std::fs::create_dir_all(main.join("extension")).unwrap();
        std::fs::create_dir_all(main.join("scripts")).unwrap();
        std::fs::write(main.join("extension/server.mjs"), "export const v = 1;\n").unwrap();
        std::fs::write(main.join("Makefile"), "regression:\n\ttrue\n").unwrap();
        std::fs::write(main.join("scripts/self-heal-verify.sh"), format!("#!/usr/bin/env bash\nexit {verify_exit}\n")).unwrap();
        sh_git(&main, &["init", "-q"]);
        sh_git(&main, &["add", "."]);
        sh_git(&main, &["commit", "-q", "-m", "init"]);
        let root = root.canonicalize().unwrap();
        (root.join("main"), root.join("data").join("self-heal").join("loop-worktrees"))
    }

    pub(super) fn self_heal_branches(main: &Path) -> String {
        sh_git(main, &["branch", "--list", "self-heal/*"]).trim().to_string()
    }

    #[test]
    fn run_ids_and_protected_paths() {
        assert!(valid_run_id(RUN));
        for bad in ["", "6F1C2B3A-4D5E-4F60-8A7B-9C0D1E2F3A4B", "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4", "6f1c2b3a_4d5e-4f60-8a7b-9c0d1e2f3a4b", "../../../../../../../../../../../../x"] {
            assert!(!valid_run_id(bad), "{bad}");
        }
        for p in ["Makefile", "scripts/self-heal-verify.sh", "scripts/new/", "desktop/build.sh", "package.json", "desktop/package.json"] {
            assert!(protected(p), "{p}");
        }
        for p in ["extension/server.mjs", "docs/Makefile.md", "ui/kit/src/index.ts", "mk/scripts.txt"] {
            assert!(!protected(p), "{p}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn verify_reads_the_answer_reverts_the_verifier_and_reports_a_diff() {
        let (main, dir) = checkout("verify", 0);
        let p = prepare_in(&main, &dir, RUN, "# Self-Heal batch\n\n## Results\n").unwrap();
        let wt = PathBuf::from(&p.worktree_path);
        assert!(wt.starts_with(&dir), "under the app's worktrees folder, not in the repo");
        assert_eq!(p.branch, format!("self-heal/{RUN}"));
        assert_eq!(p.base_commit, sh_git(&main, &["rev-parse", "HEAD"]).trim());
        assert_eq!(std::fs::read_to_string(wt.join(BATCH_REL)).unwrap(), "# Self-Heal batch\n\n## Results\n");
        assert!(prepare_in(&main, &dir, RUN, "x").is_err(), "one worktree per run");
        // The agent: a real fix, an edit to the verifier, a new script, and its verdict.
        std::fs::write(wt.join("extension/server.mjs"), "export const v = 2;\n").unwrap();
        std::fs::write(wt.join("Makefile"), "regression:\n\t@echo skipped\n").unwrap();
        std::fs::write(wt.join("scripts/evil.sh"), "exit 0\n").unwrap();
        std::fs::write(wt.join(BATCH_REL), "## Results\n\n- 3f9a1c0b7d2e4a65: fixed — off by one\n").unwrap();
        let v = verify_in(&main, &dir, RUN, 60).unwrap();
        assert!(v.passed && v.has_changes && !v.timed_out, "{v:?}");
        assert!(v.batch.contains("- 3f9a1c0b7d2e4a65: fixed"));
        assert_eq!(v.reverted, vec!["Makefile".to_string(), "scripts/evil.sh".to_string()]);
        assert!(!wt.join(".self-heal").exists() && !wt.join("scripts/evil.sh").exists());
        assert_eq!(std::fs::read_to_string(wt.join("Makefile")).unwrap(), "regression:\n\ttrue\n");
        assert_eq!(std::fs::read_to_string(wt.join("extension/server.mjs")).unwrap(), "export const v = 2;\n", "the fix stays");
        remove_in(&main, &dir, RUN).unwrap();
        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_verify_is_reported_and_remove_cleans_up() {
        let (main, dir) = checkout("fail", 1);
        let p = prepare_in(&main, &dir, RUN, "batch").unwrap();
        let v = verify_in(&main, &dir, RUN, 60).unwrap();
        assert!(!v.passed && !v.has_changes && v.reverted.is_empty(), "{v:?}");
        assert_eq!(v.batch, "batch");
        remove_in(&main, &dir, RUN).unwrap();
        assert!(!Path::new(&p.worktree_path).exists());
        assert_eq!(self_heal_branches(&main), "");
        assert!(verify_in(&main, &dir, RUN, 60).unwrap_err().contains("no longer exists"));
        remove_in(&main, &dir, RUN).unwrap();
        assert!(remove_in(&main, &dir, "../x").is_err());
        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn the_source_checkout_must_be_a_main_git_checkout_with_the_core() {
        let (main, dir) = checkout("source", 0);
        assert_eq!(checked_source(&main).unwrap(), main);
        let p = prepare_in(&main, &dir, RUN, "batch").unwrap();
        assert!(checked_source(Path::new(&p.worktree_path)).unwrap_err().contains("main git checkout"), "a linked worktree is refused");
        assert!(checked_source(&main.join("extension")).unwrap_err().contains("extension/server.mjs"));
        let plain = main.parent().unwrap().join("plain");
        std::fs::create_dir_all(plain.join("extension")).unwrap();
        std::fs::write(plain.join("extension/server.mjs"), "").unwrap();
        assert!(checked_source(&plain).is_err(), "not a git repo");
        remove_in(&main, &dir, RUN).unwrap();
        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn apply_takes_exactly_the_reviewed_patch_into_the_checkout_without_a_commit() {
        let (main, dir) = checkout("apply", 0);
        let p = prepare_in(&main, &dir, RUN, "batch").unwrap();
        let wt = PathBuf::from(&p.worktree_path);
        std::fs::write(wt.join("extension/server.mjs"), "export const v = 2;\n").unwrap();
        std::fs::create_dir_all(wt.join("extension/node_modules")).unwrap();
        std::fs::write(wt.join("extension/node_modules/x.js"), "borrowed\n").unwrap();
        let d = diff_in(&main, &dir, RUN).unwrap();
        assert!(d.text.contains("+export const v = 2;") && !d.text.contains("node_modules") && !d.truncated, "{}", d.text);
        assert_eq!(d.patch_id.len(), 64);
        // The worktree moves on after review: Apply refuses the stale id and changes nothing.
        std::fs::write(wt.join("extension/server.mjs"), "export const v = 3;\n").unwrap();
        assert!(apply_in(&main, &dir, RUN, &d.patch_id).unwrap_err().contains("changed since"));
        assert_eq!(std::fs::read_to_string(main.join("extension/server.mjs")).unwrap(), "export const v = 1;\n");
        let d = diff_in(&main, &dir, RUN).unwrap();
        apply_in(&main, &dir, RUN, &d.patch_id).unwrap();
        assert_eq!(std::fs::read_to_string(main.join("extension/server.mjs")).unwrap(), "export const v = 3;\n");
        assert_eq!(sh_git(&main, &["status", "--porcelain"]).trim(), "M extension/server.mjs", "applied, never committed");
        assert_eq!(sh_git(&main, &["rev-parse", "HEAD"]).trim(), p.base_commit);
        assert!(!wt.exists(), "the worktree is removed after apply");
        assert_eq!(self_heal_branches(&main), "");
        let _ = std::fs::remove_dir_all(main.parent().unwrap());
    }
}
