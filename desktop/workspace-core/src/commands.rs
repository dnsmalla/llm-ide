//! The one command table of the Explorer: every file and git command, named as the UI names it and called with the
//! argument object the UI sends.
//!
//! The desktop's local path and the SSH helper both call [`run`], so a command exists once and the two paths cannot
//! disagree about its arguments, its repository-path mapping or its result. What each side keeps is what it must
//! own: the open folder, the native dialogs (the `ask` parameter) and the trash (the `trasher` parameter).
//!
//! NOTE: git is not probed here. The helper answers `git_missing` before it calls `run`; the desktop lets git's own
//! error through, as it always did.

use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::fs::{
    copy, create, delete_with, list_dir, read_file, read_image, read_range, rename, write_file, CopyReq, CreateReq, ListReq,
    RangeReq, ReadReq, RenameReq, WriteReq,
};
use crate::git::{diff, scm_root, show, stage, status, DiffReq, ScmRoot, ShowReq, StageReq};
use crate::scm::{
    branch_delete, branches, checkout, commit, commit_amend, commit_diff, commit_files, confirm_spec, create_branch, diff_hunks,
    discard_all_with, discard_with, identity, log, merge, merge_abort, merge_mode, stage_all, stage_hunks, stash_apply,
    stash_drop, stash_list, stash_pop, stash_push, tag_create, tags, AmendReq, CommitDiffReq, ConfirmSpec, DiscardAllReq,
    HunksReq, LogReq, MergeOutcome, MergeReq, StageHunksReq, StashPushReq, CONFIRMED_COMMANDS,
};
use crate::trash::Trasher;
use crate::{err, FsError, R};

/// The answer to a destructive command's question: `true` only when the user accepted. The spec carries the dialog's
/// title and accept label; the text is the question itself.
pub type Ask<'a> = &'a dyn Fn(&ConfirmSpec, &str) -> bool;

/// The fs commands. Each one is the body of its Tauri wrapper in the desktop.
const FS_COMMANDS: [&str; 9] = [
    "fs_list_dir",
    "fs_read_file",
    "fs_read_range",
    "fs_read_image",
    "fs_write_file",
    "fs_create",
    "fs_rename",
    "fs_copy",
    "fs_delete",
];

pub fn is_fs_command(cmd: &str) -> bool {
    FS_COMMANDS.contains(&cmd)
}

pub fn is_git_command(cmd: &str) -> bool {
    cmd.starts_with("git_")
}

/// Whether the command asks a native dialog first (the helper runs these in two phases).
pub fn is_confirmed_command(cmd: &str) -> bool {
    CONFIRMED_COMMANDS.contains(&cmd)
}

/// Decodes the named argument. A missing key counts as `null`, so an optional field is `Option<T>`.
pub fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> R<T> {
    let raw = args.get(key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(raw)
        .map_err(|e| FsError { code: "bad_request", message: format!("the argument `{key}` is missing or invalid: {e}") })
}

/// Like `arg`, for a boolean that defaults to `false` when the key is absent.
pub fn arg_or_false(args: &Value, key: &str) -> R<bool> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(_) => arg(args, key),
    }
}

/// Serialises a result the core returned. A failure here is a bug in a result type, not the caller's fault.
pub fn to_value<T: Serialize>(value: &T) -> R<Value> {
    serde_json::to_value(value).map_err(|e| FsError { code: "internal", message: format!("cannot encode the result: {e}") })
}

fn unsupported<T>(cmd: &str) -> R<T> {
    err("unsupported", format!("the helper does not run `{cmd}`"))
}

/// Runs one fs or git command against `root`. Git commands resolve the repository with `scm_root` and map every path
/// between the project and the repository. `ask` is called only by the commands in `CONFIRMED_COMMANDS`.
pub fn run(root: &Path, cmd: &str, args: &Value, ask: Ask<'_>, trasher: &dyn Trasher) -> R<Value> {
    if is_fs_command(cmd) {
        return run_fs(root, cmd, args, trasher);
    }
    if !is_git_command(cmd) {
        return unsupported(cmd);
    }
    let scm = scm_root(root);
    if is_confirmed_command(cmd) {
        return run_confirmed(&scm, cmd, args, ask, trasher);
    }
    match cmd {
        "git_status" | "git_diff" | "git_show" | "git_stage" | "git_diff_hunks" | "git_stage_hunks" | "git_stage_all" => {
            run_working_tree(&scm, cmd, args)
        }
        _ => run_history(&scm, cmd, args),
    }
}

fn run_fs(root: &Path, cmd: &str, args: &Value, trasher: &dyn Trasher) -> R<Value> {
    match cmd {
        "fs_list_dir" => to_value(&list_dir(root, &arg::<ListReq>(args, "req")?)?),
        "fs_read_file" => to_value(&read_file(root, &arg::<ReadReq>(args, "req")?)?),
        "fs_read_range" => to_value(&read_range(root, &arg::<RangeReq>(args, "req")?)?),
        "fs_read_image" => to_value(&read_image(root, &arg::<String>(args, "path")?)?),
        "fs_write_file" => to_value(&write_file(root, &arg::<WriteReq>(args, "req")?)?),
        "fs_create" => to_value(&create(root, &arg::<CreateReq>(args, "req")?)?),
        "fs_rename" => to_value(&rename(root, &arg::<RenameReq>(args, "req")?)?),
        "fs_copy" => to_value(&copy(root, &arg::<CopyReq>(args, "req")?)?),
        "fs_delete" => {
            delete_with(root, &arg::<String>(args, "path")?, trasher)?;
            Ok(Value::Null)
        }
        other => unsupported(other),
    }
}

/// Status, diff and stage: the commands that read or change the index and the working tree without asking.
fn run_working_tree(scm: &ScmRoot, cmd: &str, args: &Value) -> R<Value> {
    match cmd {
        "git_status" => {
            let mut st = status(&scm.repo)?;
            for entry in &mut st.entries {
                entry.path = scm.to_project(&entry.path);
                entry.orig_path = entry.orig_path.as_deref().map(|p| scm.to_project(p));
            }
            to_value(&st)
        }
        "git_diff" => {
            let r = arg::<DiffReq>(args, "req")?;
            to_value(&diff(&scm.repo, &scm.to_repo(&r.path)?, r.staged)?)
        }
        "git_show" => {
            let r = arg::<ShowReq>(args, "req")?;
            to_value(&show(&scm.repo, &scm.to_repo(&r.path)?, &r.rev)?)
        }
        "git_stage" => {
            let r = arg::<StageReq>(args, "req")?;
            stage(&scm.repo, &scm.to_repo_all(&r.paths)?, r.stage).map(|()| Value::Null)
        }
        "git_diff_hunks" => {
            let r = arg::<HunksReq>(args, "req")?;
            to_value(&diff_hunks(&scm.repo, &scm.to_repo(&r.path)?, r.staged)?)
        }
        "git_stage_hunks" => {
            let r = arg::<StageHunksReq>(args, "req")?;
            stage_hunks(&scm.repo, &scm.to_repo(&r.path)?, r.staged, &r.diff_id, &r.hunks).map(|()| Value::Null)
        }
        "git_stage_all" => stage_all(&scm.repo, arg::<bool>(args, "stage")?).map(|()| Value::Null),
        other => unsupported(other),
    }
}

/// Identity, commit, branches, tags, log and stash. None of these asks a dialog.
fn run_history(scm: &ScmRoot, cmd: &str, args: &Value) -> R<Value> {
    let repo = scm.repo.as_path();
    match cmd {
        "git_identity" => to_value(&identity(repo, &None)?),
        "git_commit" => to_value(&commit(repo, &arg::<String>(args, "message")?, &None)?),
        "git_branches" => to_value(&branches(repo)?),
        "git_create_branch" => create_branch(repo, &arg::<String>(args, "name")?).map(|()| Value::Null),
        "git_tags" => to_value(&tags(repo)?),
        "git_log" => {
            let r = arg::<LogReq>(args, "req")?;
            to_value(&log(repo, r.skip, r.limit)?)
        }
        "git_commit_files" => {
            let mut detail = commit_files(repo, &arg::<String>(args, "hash")?)?;
            for file in &mut detail.files {
                file.path = scm.to_project(&file.path);
            }
            to_value(&detail)
        }
        "git_commit_diff" => {
            let r = arg::<CommitDiffReq>(args, "req")?;
            to_value(&commit_diff(repo, &r.hash, &scm.to_repo(&r.path)?)?)
        }
        "git_tag_create" => {
            let name = arg::<String>(args, "name")?;
            let message = arg::<Option<String>>(args, "message")?;
            let target = arg::<Option<String>>(args, "target")?;
            to_value(&tag_create(repo, &name, message.as_deref(), target.as_deref(), &None)?)
        }
        "git_stash_list" => to_value(&stash_list(repo)?),
        "git_stash_push" => {
            let r = arg::<StashPushReq>(args, "req")?;
            stash_push(repo, &r.message, r.include_untracked, &None).map(|()| Value::Null)
        }
        "git_stash_apply" => {
            let index = arg::<usize>(args, "index")?;
            stash_apply(repo, index, &arg::<String>(args, "hash")?).map(|()| Value::Null)
        }
        other => unsupported(other),
    }
}

/// The destructive commands. The question the core asks goes to `ask` with the command's dialog spec.
fn run_confirmed(scm: &ScmRoot, cmd: &str, args: &Value, ask: Ask<'_>, trasher: &dyn Trasher) -> R<Value> {
    let repo = scm.repo.as_path();
    // Only the branch delete's wording depends on an argument: `force` names an unmerged branch.
    let force = cmd == "git_branch_delete" && arg_or_false(args, "force")?;
    let Some(spec) = confirm_spec(cmd, force) else {
        return unsupported(cmd);
    };
    let ask = |question: &str| ask(&spec, question);
    match cmd {
        "git_discard" => {
            let paths = scm.to_repo_all(&arg::<Vec<String>>(args, "paths")?)?;
            to_value(&discard_with(repo, &paths, &ask, trasher)?)
        }
        "git_checkout" => checkout(repo, &arg::<String>(args, "name")?, &ask).map(|()| Value::Null),
        "git_branch_delete" => to_value(&branch_delete(repo, &arg::<String>(args, "name")?, force, &ask)?),
        "git_stash_pop" => {
            let (index, hash) = (arg::<usize>(args, "index")?, arg::<String>(args, "hash")?);
            stash_pop(repo, index, &hash, &ask).map(|()| Value::Null)
        }
        "git_stash_drop" => {
            let (index, hash) = (arg::<usize>(args, "index")?, arg::<String>(args, "hash")?);
            stash_drop(repo, index, &hash, &ask).map(|()| Value::Null)
        }
        "git_merge_abort" => merge_abort(repo, &ask).map(|()| Value::Null),
        "git_merge" => run_merge(scm, args, &ask),
        "git_commit_amend" => {
            let r = arg::<AmendReq>(args, "req")?;
            to_value(&commit_amend(repo, r.message.as_deref(), r.force, &None, &ask)?)
        }
        "git_discard_all" => {
            let r = arg::<DiscardAllReq>(args, "req")?;
            to_value(&discard_all_with(repo, r.include_untracked, &ask, trasher)?)
        }
        other => unsupported(other),
    }
}

/// Merge, with the conflicting paths turned back into project-relative paths for the Changes panel.
fn run_merge(scm: &ScmRoot, args: &Value, ask: &dyn Fn(&str) -> bool) -> R<Value> {
    let r = arg::<MergeReq>(args, "req")?;
    let mode = merge_mode(r.mode.as_deref())?;
    let mut outcome: MergeOutcome = merge(&scm.repo, &r.name, mode, &None, ask)?;
    if let MergeOutcome::Conflicts { paths, .. } = &mut outcome {
        for path in paths.iter_mut() {
            *path = scm.to_project(path);
        }
    }
    to_value(&outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trash::OsTrash;
    use serde_json::json;
    use std::cell::Cell;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("llmide-commands-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Canonical, because the fs commands refuse a root that resolves elsewhere (/var is a link on macOS).
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn an_fs_command_runs_from_the_json_the_ui_sends() {
        let dir = scratch("fs");
        std::fs::write(dir.join("a.txt"), "hi").unwrap();
        let asked = Cell::new(false);
        let ask = |_: &ConfirmSpec, _: &str| {
            asked.set(true);
            false
        };
        let listed = run(&dir, "fs_list_dir", &json!({"req": {"path": ""}}), &ask, &OsTrash).unwrap();
        assert!(listed.to_string().contains("a.txt"));
        assert!(!asked.get(), "a command that is not destructive never asks");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_argument_or_unknown_command_is_a_typed_error() {
        let dir = scratch("bad");
        let no = |_: &ConfirmSpec, _: &str| false;
        assert_eq!(run(&dir, "fs_read_image", &json!({}), &no, &OsTrash).unwrap_err().code, "bad_request");
        assert_eq!(run(&dir, "no_such", &json!({}), &no, &OsTrash).unwrap_err().code, "unsupported");
        assert_eq!(run(&dir, "git_no_such", &json!({}), &no, &OsTrash).unwrap_err().code, "unsupported");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_confirmed_command_has_a_dialog_and_is_a_git_command() {
        for cmd in CONFIRMED_COMMANDS {
            assert!(is_git_command(cmd) && confirm_spec(cmd, false).is_some(), "{cmd}");
        }
    }
}
