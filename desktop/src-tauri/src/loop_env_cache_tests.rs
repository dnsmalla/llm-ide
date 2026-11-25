use super::*;
use crate::loop_approval::{approve_loop_with, ApprovalStore};

static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn temp(name: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("llmide-envcache-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

fn spec(setup: &str) -> EnvCacheSpec {
    EnvCacheSpec { key_files: vec!["requirements.txt".into()], setup: setup.into(), paths: vec![".venv".into()] }
}

fn worktree(project: &Path, id: &str, requirements: &str) -> PathBuf {
    let wt = project.join("system").join("loop-worktrees").join(id);
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join("requirements.txt"), requirements).unwrap();
    std::fs::canonicalize(wt).unwrap()
}

/// A project whose Factory loop `l1` declares an envCache with `setup`.
fn project_with(setup: &str) -> PathBuf {
    let root = temp("project");
    write_loop(&root, setup);
    root
}

fn write_loop(root: &Path, setup: &str) {
    std::fs::create_dir_all(root.join("system")).unwrap();
    let json = serde_json::json!({
        "schemaVersion": 2,
        "loops": [{ "id": "l1", "name": "Factory", "config": {
            "stages": [{ "id": "s1", "name": "Verify", "kind": "shellCommand", "command": "true", "enabled": true }],
            "envCache": { "keyFiles": ["requirements.txt"], "setup": setup, "paths": [".venv"] }
        } }]
    });
    std::fs::write(root.join("system/loop.json"), json.to_string()).unwrap();
}

fn approved(store: &ApprovalStore, root: &Path) -> String {
    approve_loop_with(store, root, "l1", crate::confirm::now_ms(), |_, _| true).unwrap().expect("accepted").token
}

#[test]
fn a_spec_needs_a_setup_command_key_files_and_plain_relative_paths() {
    let ok = serde_json::json!({ "keyFiles": ["requirements.txt"], "setup": " make env ", "paths": [".venv", "./node_modules"] });
    let got = parse_spec(&ok).unwrap();
    assert_eq!(got.setup, "make env");
    assert_eq!(got.paths, vec![".venv", "node_modules"]);
    for bad in [
        serde_json::json!({ "keyFiles": ["a"], "setup": "", "paths": [".venv"] }),
        serde_json::json!({ "keyFiles": [], "setup": "x", "paths": [".venv"] }),
        serde_json::json!({ "keyFiles": ["a"], "setup": "x", "paths": [] }),
        serde_json::json!({ "keyFiles": ["a"], "setup": "x", "paths": ["../out"] }),
        serde_json::json!({ "keyFiles": ["a"], "setup": "x", "paths": ["/abs"] }),
        serde_json::json!({ "keyFiles": ["a"], "setup": "x", "paths": [".git"] }),
        serde_json::json!({ "keyFiles": ["a"], "setup": "x", "paths": [".factory/x"] }),
        serde_json::json!({ "keyFiles": ["a\\b"], "setup": "x", "paths": [".venv"] }),
        serde_json::json!("nope"),
    ] {
        assert!(parse_spec(&bad).is_err(), "{bad}");
    }
}

#[test]
fn the_key_follows_the_manifest_the_setup_and_the_paths_only() {
    let project = temp("key");
    let a = worktree(&project, "a", "pytest==8\n");
    let b = worktree(&project, "b", "pytest==8\n");
    let s = spec("make env");
    assert_eq!(cache_key(&a, &s).unwrap(), cache_key(&b, &s).unwrap(), "another worktree, same manifest: same key");
    std::fs::write(b.join("requirements.txt"), "pytest==9\n").unwrap();
    assert_ne!(cache_key(&a, &s).unwrap(), cache_key(&b, &s).unwrap(), "a changed manifest is a new key");
    assert_ne!(cache_key(&a, &s).unwrap(), cache_key(&a, &spec("make other")).unwrap(), "a changed setup is a new key");
    let mut moved = spec("make env");
    moved.paths = vec!["env".into()];
    assert_ne!(cache_key(&a, &s).unwrap(), cache_key(&a, &moved).unwrap(), "other paths are a new key");
    std::fs::remove_file(a.join("requirements.txt")).unwrap();
    assert!(cache_key(&a, &s).is_ok(), "a missing key file counts as absent");
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn restore_gives_each_worktree_its_own_copy_pointed_at_itself() {
    use std::os::unix::fs::PermissionsExt;
    let project = temp("restore");
    let a = worktree(&project, "a", "x\n");
    let s = spec("make env");
    let venv = a.join(".venv");
    std::fs::create_dir_all(venv.join("bin")).unwrap();
    std::fs::write(venv.join("bin/tool"), format!("#!{}/.venv/bin/python\nprint('hi')\n", a.display())).unwrap();
    std::fs::set_permissions(venv.join("bin/tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink("/usr/bin/env", venv.join("bin/python")).unwrap();
    std::fs::write(venv.join("pyvenv.cfg"), format!("home = /usr/bin\nvenv = {}\n", a.display())).unwrap();
    let mut binary = a.display().to_string().into_bytes();
    binary.push(0);
    std::fs::write(venv.join("native.bin"), &binary).unwrap();
    let key = cache_key(&a, &s).unwrap();
    save(&project, &a, &s, &key).unwrap();

    let b = worktree(&project, "b", "x\n");
    assert!(restore(&project, &b, &s, &key).unwrap(), "hit");
    let tool = std::fs::read_to_string(b.join(".venv/bin/tool")).unwrap();
    assert!(tool.starts_with(&format!("#!{}/.venv/bin/python\n", b.display())), "{tool}");
    assert!(!tool.contains(&a.display().to_string()), "the old worktree is no longer named");
    assert_eq!(std::fs::metadata(b.join(".venv/bin/tool")).unwrap().permissions().mode() & 0o777, 0o755, "still executable");
    assert_eq!(std::fs::read_link(b.join(".venv/bin/python")).unwrap(), Path::new("/usr/bin/env"), "links stay links");
    assert!(std::fs::read_to_string(b.join(".venv/pyvenv.cfg")).unwrap().contains(&b.display().to_string()));
    assert_eq!(std::fs::read(b.join(".venv/native.bin")).unwrap(), binary, "binary files are never rewritten");

    std::fs::write(b.join(".venv/bin/tool"), "changed in b").unwrap();
    assert!(std::fs::read_to_string(a.join(".venv/bin/tool")).unwrap().starts_with("#!"), "a's copy is not shared with b");
    assert!(std::fs::read_to_string(cache_root(&project).join(&key).join("files/.venv/bin/tool")).unwrap().contains(&a.display().to_string()), "the cache entry itself is never edited");

    let c = worktree(&project, "c", "x\n");
    std::fs::create_dir_all(c.join(".venv")).unwrap();
    std::fs::write(c.join(".venv/mine"), "keep").unwrap();
    assert!(restore(&project, &c, &s, &key).unwrap());
    assert_eq!(std::fs::read_to_string(c.join(".venv/mine")).unwrap(), "keep", "a path that already exists is left alone");
    assert!(!c.join(".venv/bin").exists());
    let _ = std::fs::remove_dir_all(project);
}

#[test]
fn an_unknown_key_is_a_miss_and_save_keeps_the_first_entry() {
    let project = temp("miss");
    let a = worktree(&project, "a", "x\n");
    let s = spec("make env");
    assert!(!restore(&project, &a, &s, &"0".repeat(64)).unwrap());
    std::fs::create_dir_all(a.join(".venv")).unwrap();
    std::fs::write(a.join(".venv/one"), "1").unwrap();
    let key = cache_key(&a, &s).unwrap();
    save(&project, &a, &s, &key).unwrap();
    std::fs::write(a.join(".venv/one"), "2").unwrap();
    save(&project, &a, &s, &key).unwrap();
    assert_eq!(std::fs::read_to_string(cache_root(&project).join(&key).join("files/.venv/one")).unwrap(), "1", "the first entry wins");
    let err = save(&project, &a, &EnvCacheSpec { paths: vec!["missing".into()], ..s }, &"1".repeat(64)).unwrap_err();
    assert!(err.contains("did not create missing"), "{err}");
    let leftovers = std::fs::read_dir(cache_root(&project)).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(".tmp-")).count();
    assert_eq!(leftovers, 0, "a failed save leaves no half-built folder");
    let _ = std::fs::remove_dir_all(project);
}

#[test]
fn only_the_most_recent_keys_are_kept() {
    let project = temp("prune");
    let root = cache_root(&project);
    std::fs::create_dir_all(&root).unwrap();
    let keys: Vec<String> = (0..MAX_KEYS_KEPT + 3).map(|i| format!("{i:x}").repeat(64)[..64].to_string()).collect();
    for (i, k) in keys.iter().enumerate() {
        std::fs::create_dir_all(root.join(k)).unwrap();
        let meta = root.join(k).join("meta.json");
        std::fs::write(&meta, "{}").unwrap();
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs(1000 - i as u64 * 10);
        std::fs::OpenOptions::new().write(true).open(&meta).unwrap().set_modified(when).unwrap();
    }
    prune(&root, &keys[0]);
    let left: Vec<String> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left.len(), MAX_KEYS_KEPT + 1, "the newest keys plus the one in use: {left:?}");
    assert!(left.contains(&keys[0]), "the key in use is never dropped, however old");
    assert!(left.contains(keys.last().unwrap()));
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn the_setup_runs_once_and_later_worktrees_reuse_the_result() {
    let counter = temp("counter").join("runs");
    let setup = format!("mkdir -p .venv && echo built > .venv/marker && echo run >> {}", counter.display());
    let project = project_with(&setup);
    let store = ApprovalStore::new();
    let token = approved(&store, &project);

    let a = worktree(&project, "a", "pytest==8\n");
    let first = prepare_gated(&project, &a, "a", "l1", Some(60), &store, Some(&token)).unwrap();
    assert_eq!(first.status, "built", "{first:?}");
    assert!(a.join(".venv/marker").is_file());

    let again = prepare_gated(&project, &a, "a", "l1", Some(60), &store, None).unwrap();
    assert_eq!(again.status, "present", "a worktree that has it needs nothing, not even a token");

    let b = worktree(&project, "b", "pytest==8\n");
    let second = prepare_gated(&project, &b, "b", "l1", Some(60), &store, None).unwrap();
    assert_eq!(second.status, "restored", "{second:?}");
    assert_eq!(std::fs::read_to_string(b.join(".venv/marker")).unwrap().trim(), "built");
    assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 1, "the setup command ran once in total");

    let c = worktree(&project, "c", "pytest==9\n");
    let third = prepare_gated(&project, &c, "c", "l1", Some(60), &store, Some(&token)).unwrap();
    assert_eq!(third.status, "built", "a changed manifest builds again");
    assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 2);
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn a_miss_runs_nothing_without_the_exact_approval() {
    let marker = temp("unapproved").join("ran");
    let setup = format!("mkdir -p .venv && touch {}", marker.display());
    let project = project_with(&setup);
    let store = ApprovalStore::new();
    let wt = worktree(&project, "a", "x\n");

    let err = prepare_gated(&project, &wt, "a", "l1", Some(60), &store, None).unwrap_err();
    assert!(err.contains("approval"), "{err}");
    let err = prepare_gated(&project, &wt, "a", "l1", Some(60), &store, Some("not-a-token")).unwrap_err();
    assert!(err.contains("approval"), "{err}");
    assert!(!marker.exists(), "nothing ran");

    let token = approved(&store, &project);
    write_loop(&project, &format!("{setup} && echo changed"));
    let err = prepare_gated(&project, &wt, "a", "l1", Some(60), &store, Some(&token)).unwrap_err();
    assert!(err.contains("changed since it was approved"), "an approval for the old command does not cover an edited one: {err}");
    assert!(!marker.exists(), "nothing ran");
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn a_failing_setup_is_reported_and_never_cached() {
    let project = project_with("mkdir -p .venv && echo broken >&2 && exit 3");
    let store = ApprovalStore::new();
    let token = approved(&store, &project);
    let wt = worktree(&project, "a", "x\n");
    let got = prepare_gated(&project, &wt, "a", "l1", Some(60), &store, Some(&token)).unwrap();
    assert_eq!(got.status, "failed", "{got:?}");
    assert!(got.output.unwrap_or_default().contains("broken"));
    let entries = std::fs::read_dir(cache_root(&project)).map(|d| d.flatten().count()).unwrap_or(0);
    assert_eq!(entries, 0, "a failed build leaves nothing in the cache");
    let _ = std::fs::remove_dir_all(project);
}

/// A loop whose envCache lists several `paths`.
fn write_loop_paths(root: &Path, setup: &str, paths: &[&str]) {
    std::fs::create_dir_all(root.join("system")).unwrap();
    let json = serde_json::json!({
        "schemaVersion": 2,
        "loops": [{ "id": "l1", "name": "Factory", "config": {
            "stages": [{ "id": "s1", "name": "Verify", "kind": "shellCommand", "command": "true", "enabled": true }],
            "envCache": { "keyFiles": ["requirements.txt"], "setup": setup, "paths": paths }
        } }]
    });
    std::fs::write(root.join("system/loop.json"), json.to_string()).unwrap();
}

#[cfg(unix)]
#[test]
fn a_failed_setup_removes_what_it_created_and_the_next_prepare_runs_it_again() {
    let project = temp("failclean");
    write_loop_paths(&project, "mkdir -p .venv && echo half > .venv/marker && exit 3", &[".venv", "keep"]);
    let store = ApprovalStore::new();
    let token = approved(&store, &project);
    let wt = worktree(&project, "a", "x\n");
    std::fs::create_dir_all(wt.join("keep")).unwrap();
    std::fs::write(wt.join("keep/mine"), "mine").unwrap();

    let got = prepare_gated(&project, &wt, "a", "l1", Some(60), &store, Some(&token)).unwrap();
    assert_eq!(got.status, "failed", "{got:?}");
    assert!(!wt.join(".venv").exists(), "the half-built environment is gone");
    assert_eq!(std::fs::read_to_string(wt.join("keep/mine")).unwrap(), "mine", "a path that existed before is untouched");

    write_loop_paths(&project, "mkdir -p .venv && echo ok > .venv/marker", &[".venv", "keep"]);
    let token = approved(&store, &project);
    let again = prepare_gated(&project, &wt, "a", "l1", Some(60), &store, Some(&token)).unwrap();
    assert_eq!(again.status, "built", "setup ran again instead of reporting present: {again:?}");
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn a_failed_setup_removes_a_symlink_as_a_link_and_leaves_its_target() {
    let outside = temp("linktarget");
    std::fs::write(outside.join("precious"), "data").unwrap();
    let project = temp("failsymlink");
    let setup = format!("ln -s {} .venv && exit 1", outside.display());
    write_loop_paths(&project, &setup, &[".venv"]);
    let store = ApprovalStore::new();
    let token = approved(&store, &project);
    let wt = worktree(&project, "a", "x\n");

    let got = prepare_gated(&project, &wt, "a", "l1", Some(60), &store, Some(&token)).unwrap();
    assert_eq!(got.status, "failed", "{got:?}");
    assert!(std::fs::symlink_metadata(wt.join(".venv")).is_err(), "the link itself is gone");
    assert_eq!(std::fs::read_to_string(outside.join("precious")).unwrap(), "data", "the target is untouched");
    let _ = std::fs::remove_dir_all(project);
    let _ = std::fs::remove_dir_all(outside);
}

#[cfg(unix)]
#[test]
fn a_stale_cancel_flag_does_not_cancel_the_next_prepare() {
    let project = project_with("mkdir -p .venv && echo ok > .venv/marker");
    let store = ApprovalStore::new();
    let token = approved(&store, &project);
    let wt = worktree(&project, "a", "x\n");
    crate::loop_runner::request_cancel("a");

    let got = prepare_gated(&project, &wt, "a", "l1", Some(60), &store, Some(&token)).unwrap();
    assert_eq!(got.status, "built", "{got:?}");
    let _ = std::fs::remove_dir_all(project);
}

#[test]
fn a_loop_without_an_env_cache_is_untouched() {
    let root = temp("none");
    std::fs::create_dir_all(root.join("system")).unwrap();
    std::fs::write(root.join("system/loop.json"), r#"{"schemaVersion":2,"loops":[{"id":"l1","name":"L","config":{"stages":[]}}]}"#).unwrap();
    let wt = worktree(&root, "a", "x\n");
    let got = prepare_gated(&root, &wt, "a", "l1", None, &ApprovalStore::new(), None).unwrap();
    assert_eq!(got.status, "none");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn the_loop_approval_lists_the_setup_command_with_the_others() {
    let project = project_with("make env-setup");
    let store = ApprovalStore::new();
    let mut shown = String::new();
    let out = approve_loop_with(&store, &project, "l1", 1_000, |_, text| {
        shown = text.to_string();
        false
    })
    .unwrap();
    assert!(out.is_none());
    assert!(shown.contains("Set up environment"), "{shown}");
    assert!(shown.contains("make env-setup"), "{shown}");
    assert!(shown.contains("Verify"), "{shown}");
    let granted = approve_loop_with(&store, &project, "l1", 1_000, |_, _| true).unwrap().unwrap();
    assert!(granted.stage_ids.contains(&ENV_CACHE_STAGE_ID.to_string()), "{granted:?}");
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn a_real_python_venv_still_runs_after_it_is_restored_into_another_worktree() {
    let python = std::process::Command::new("python3").arg("--version").output();
    if !python.map(|o| o.status.success()).unwrap_or(false) {
        return;
    }
    let project = temp("venv");
    let a = worktree(&project, "a", "x\n");
    let s = spec("python3 -m venv .venv");
    let built = std::process::Command::new("python3").args(["-m", "venv", ".venv"]).current_dir(&a).output().unwrap();
    if !built.status.success() {
        // A python3 without venv/ensurepip (some Linux images) cannot build the fixture; that is not this module's fault.
        eprintln!("skipped: python3 -m venv failed: {}", String::from_utf8_lossy(&built.stderr));
        let _ = std::fs::remove_dir_all(project);
        return;
    }
    let key = cache_key(&a, &s).unwrap();
    save(&project, &a, &s, &key).unwrap();
    std::fs::remove_dir_all(&a).unwrap();

    let b = worktree(&project, "b", "x\n");
    assert!(restore(&project, &b, &s, &key).unwrap());
    let out = std::process::Command::new(b.join(".venv/bin/pip")).arg("--version").output().unwrap();
    assert!(out.status.success(), "pip console script must run from the new worktree: {}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains(&b.display().to_string()), "pip runs from the new worktree's venv: {}", String::from_utf8_lossy(&out.stdout));
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn stage_commands_run_with_the_prepared_environment_first_on_path() {
    let setup = "mkdir -p .venv/bin && printf '#!/bin/sh\\necho from-the-cached-env\\n' > .venv/bin/envtool && chmod +x .venv/bin/envtool && touch .venv/pyvenv.cfg";
    let project = project_with(setup);
    let store = ApprovalStore::new();
    let token = approved(&store, &project);

    let a = worktree(&project, "a", "x\n");
    let run = |wt: &Path| crate::loop_runner::run_command_keyed(wt, "envtool && echo venv=$VIRTUAL_ENV", Some(30), "k").unwrap();
    let before = run(&a);
    assert_ne!(before.exit_code, Some(0), "an unprepared worktree does not see the tool: {before:?}");

    assert_eq!(prepare_gated(&project, &a, "a", "l1", Some(60), &store, Some(&token)).unwrap().status, "built");
    let built = run(&a);
    assert!(built.stdout.contains("from-the-cached-env"), "{built:?}");
    assert!(built.stdout.contains(&format!("venv={}", a.join(".venv").display())), "{built:?}");

    let b = worktree(&project, "b", "x\n");
    assert_eq!(prepare_gated(&project, &b, "b", "l1", Some(60), &store, None).unwrap().status, "restored");
    let restored = run(&b);
    assert!(restored.stdout.contains("from-the-cached-env"), "a restored environment is used too: {restored:?}");
    assert!(restored.stdout.contains(&format!("venv={}", b.join(".venv").display())), "{restored:?}");

    let c = worktree(&project, "c", "y\n");
    assert_ne!(run(&c).exit_code, Some(0), "another worktree is not affected");
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn a_failed_restore_is_evicted_and_falls_back_to_setup() {
    use std::os::unix::fs::PermissionsExt;
    let setup = "mkdir -p .venv && echo fresh > .venv/marker";
    let project = project_with(setup);
    let store = ApprovalStore::new();
    let token = approved(&store, &project);
    let a = worktree(&project, "a", "x\n");
    let s = spec(setup);
    std::fs::create_dir_all(a.join(".venv")).unwrap();
    // A copy of this file keeps its mode and names the old worktree, so rewriting it has to cope with read-only.
    std::fs::write(a.join(".venv/cfg"), format!("home={}\n", a.display())).unwrap();
    let key = cache_key(&a, &s).unwrap();
    save(&project, &a, &s, &key).unwrap();
    // Make the restore fail for real: a cached folder that cannot be listed breaks the copy.
    let cached = cache_root(&project).join(&key).join("files/.venv");
    std::fs::set_permissions(&cached, std::fs::Permissions::from_mode(0o000)).unwrap();

    let b = worktree(&project, "b", "x\n");
    let got = prepare_gated(&project, &b, "b", "l1", Some(60), &store, Some(&token));
    std::fs::set_permissions(&cached, std::fs::Permissions::from_mode(0o755)).ok();
    let got = got.unwrap();
    assert_eq!(got.status, "built", "{got:?}");
    assert!(got.message.contains("could not be restored"), "{}", got.message);
    assert_eq!(std::fs::read_to_string(b.join(".venv/marker")).unwrap().trim(), "fresh");
    assert!(!cache_root(&project).join(&key).join("files/.venv/cfg").exists(), "the bad entry was evicted (the new build is a fresh one)");
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn a_read_only_text_file_is_still_rewritten_and_keeps_its_mode() {
    use std::os::unix::fs::PermissionsExt;
    let project = temp("readonly");
    let a = worktree(&project, "a", "x\n");
    let s = spec("make env");
    std::fs::create_dir_all(a.join(".venv")).unwrap();
    std::fs::write(a.join(".venv/cfg"), format!("home={}\n", a.display())).unwrap();
    std::fs::set_permissions(a.join(".venv/cfg"), std::fs::Permissions::from_mode(0o444)).unwrap();
    let key = cache_key(&a, &s).unwrap();
    save(&project, &a, &s, &key).unwrap();
    let b = worktree(&project, "b", "x\n");
    assert!(restore(&project, &b, &s, &key).unwrap());
    let text = std::fs::read_to_string(b.join(".venv/cfg")).unwrap();
    assert!(text.contains(&b.display().to_string()), "{text}");
    assert_eq!(std::fs::metadata(b.join(".venv/cfg")).unwrap().permissions().mode() & 0o777, 0o444);
    let _ = std::fs::remove_dir_all(project);
}

#[cfg(unix)]
#[test]
fn a_symlinked_parent_makes_restore_refuse_and_save_skip_without_touching_outside() {
    let project = temp("symparent");
    let s = EnvCacheSpec { key_files: vec!["requirements.txt".into()], setup: "x".into(), paths: vec!["web/node_modules".into()] };
    let a = worktree(&project, "a", "x\n");
    std::fs::create_dir_all(a.join("web/node_modules")).unwrap();
    std::fs::write(a.join("web/node_modules/m"), "1").unwrap();
    let key = cache_key(&a, &s).unwrap();
    save(&project, &a, &s, &key).unwrap();

    let b = worktree(&project, "b", "x\n");
    let outside = temp("outside");
    std::os::unix::fs::symlink(&outside, b.join("web")).unwrap();
    let err = restore(&project, &b, &s, &key).unwrap_err();
    assert!(err.contains("symlink"), "{err}");
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0, "nothing was written outside");

    // Save: the built entry sits behind a symlinked parent, so it is not cached.
    std::fs::create_dir_all(outside.join("node_modules")).unwrap();
    let other = "1".repeat(64);
    let err = save(&project, &b, &s, &other).unwrap_err();
    assert!(err.contains("symlink"), "{err}");
    assert!(!cache_root(&project).join(&other).exists());
    let _ = std::fs::remove_dir_all(project);
}
