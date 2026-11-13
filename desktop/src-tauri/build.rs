// Declares every custom command in an AppManifest so each needs an explicit
// `allow-<command>` permission in a capability file (capabilities/*.json). Without a
// manifest Tauri allows all app commands to every window. Keep this list in sync with
// `generate_handler!` in src/lib.rs; the build fails on a capability naming an
// unknown permission, and `scripts/check-capabilities.mjs` fails on a command with
// no grant or a wildcard / broad permission.
const COMMANDS: &[&str] = &[
    "ping",
    "core_status",
    "core_stop",
    "core_start",
    "core_restart",
    "backend_pick_node",
    "backend_pick_dir",
    "backend_detect",
    "graph_generate",
    "graph_cancel",
    "legacy_import_status",
    "legacy_import_run",
    "loop_approve_loop",
    "loop_approve_stage",
    "loop_approval_status",
    "loop_revoke_approvals",
    "loop_run_stage",
    "loop_run_loop",
    "loop_work_root",
    "loop_run_fault_verify",
    "loop_environment_check",
    "loop_cancel",
    "loop_changed_paths",
    "loop_revert_paths",
    "loop_worktree_prepare",
    "loop_worktree_diff",
    "loop_worktree_remove",
    "loop_worktree_list",
    "loop_worktree_status",
    "loop_worktree_checkpoint",
    "loop_worktree_restore",
    "loop_repo_branch",
    "loop_clear_factory_output",
    "repo_clone",
    "feature_rebuild",
    "core_log_read",
    "core_log_clear",
    "secrets_status",
    "capture_status",
    "capture_request_permission",
    "start_system_dictation",
    "stop_system_dictation",
    "capture_open_settings",
    "capture_start",
    "capture_stop",
    "capture_recover_list",
    "capture_recover_finish",
    "capture_recover_discard",
    "read_graph_file",
    "project_open",
    "project_open_recent",
    "project_active",
    "project_recent",
    "project_recent_all",
    "project_forget_recent",
    "project_close",
    "project_create",
    "project_paths",
    "project_rebuild_folders",
    "project_memory",
    "fs_list_dir",
    "fs_read_file",
    "fs_read_image",
    "fs_read_range",
    "fs_write_file",
    "fs_create",
    "fs_rename",
    "fs_delete",
    "fs_copy",
    "fs_open_pdf",
    "fs_watch_start",
    "fs_watch_set",
    "fs_watch_stop",
    "project_search_start",
    "project_search_cancel",
    "git_status",
    "git_diff",
    "git_show",
    "git_stage",
    "git_diff_hunks",
    "git_stage_hunks",
    "git_stage_all",
    "git_discard",
    "git_identity",
    "git_commit",
    "git_branches",
    "git_checkout",
    "git_create_branch",
    "git_log",
    "git_tags",
    "crash_report_latest",
    "crash_report_dismiss",
    "self_heal_take",
    "self_heal_source",
    "self_heal_prepare",
    "self_heal_verify",
    "self_heal_diff",
    "self_heal_apply",
    "self_heal_remove",
    "export_note",
    "docgen_destination_status",
    "docgen_destination_pick",
    "docgen_destination_clear",
    "docgen_save_external",
    "git_commit_files",
    "git_commit_diff",
    "git_branch_delete",
    "git_tag_create",
    "git_stash_list",
    "git_stash_push",
    "git_stash_apply",
    "git_stash_pop",
    "git_stash_drop",
    "git_merge",
    "git_merge_abort",
    "git_commit_amend",
    "git_discard_all",
    "notify_user",
    "notify_focus",
    "tray_report",
    "tray_status",
    "tray_set_close_to_tray",
    "tray_set_icon_visible",
    "bench",
    "bench_done",
    "autobench_mode",
    "graph_path_override",
    "theme_override",
    "section_override",
    "pty_status",
    "pty_retry_consent",
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_ack",
    "pty_kill",
    "sse_replay_start",
    "sse_replay_stop",
    "sse_channel_stream",
    "ax_probe",
    "capture_dump_tree",
    "chat_bind_session",
    "chat_unbind_session",
    "chat_list",
    "chat_load",
    "chat_save",
    "chat_drop_message",
    "chat_delete",
    "chat_confirm_truncate",
    "chat_archive_status",
    "notes_root_get",
    "notes_root_choose",
    "notes_root_clear",
    "notes_list",
    "notes_read",
    "notes_heads",
    "note_open",
    "note_save",
    "note_create",
    "note_rename",
    "notes_delete_many",
    "source_pick_folder",
    "pick_folder",
    "pick_folder_redeem",
    "host_platform",
    "get_prefs",
    "set_prefs",
    "remote_ssh_test",
    "remote_ssh_confirm",
    "app_restart",
    "remote_deploy_plan",
    "remote_deploy_bootstrap",
    "remote_deploy_run",
    "remote_deploy_lock",
    "remote_deploy_rollback",
    "remote_session_store",
    "remote_session_load",
    "remote_session_clear",
    "remote_tls_probe",
    "remote_tls_pin",
    "remote_tls_unpin",
    "remote_hub_check",
    "remote_hub_login",
    "remote_backup_now",
    "remote_logs",
    "remote_uninstall",
    "remote_update",
    "remote_diagnostics",
    "update_status", "update_check", "update_install",
    "open_external_url",
    "reveal_in_os",
    "attach_pick_files",
    "attach_read",
    "attach_release",
    "bypass_confirm",
    "bypass_confirm_signed",
    "trust_confirm",
    "host_bus_proof",
    "mermaid_runtime_status",
    "mermaid_runtime_install",
    "mermaid_runtime_remove",
    "mermaid_runtime_read",
    "rtk_status",
    "rtk_install",
];

/// The `sourceHash` stage-core.mjs wrote into STAGE.json (no JSON dependency: the value is one hex string).
fn staged_hash(stage_json: &str) -> Option<String> {
    let rest = &stage_json[stage_json.find("\"sourceHash\"")? + "\"sourceHash\"".len()..];
    let rest = rest[rest.find('"')? + 1..].to_string();
    Some(rest[..rest.find('"')?].to_string()).filter(|h| !h.is_empty())
}

/// A release build bundles `resources/core` as it is, and only scripts/build-desktop-mac.sh and the release
/// workflow stage it first, so a bare `npm run tauri build` used to ship whatever the last stage left behind.
/// Debug builds (`cargo check`, `cargo test`, `tauri dev`) never look: CI keeps an empty `resources/core` for them.
/// Escape hatch for a deliberate offline experiment: LLMIDE_SKIP_STAGE_CHECK=1.
fn check_staged_core() {
    println!("cargo:rerun-if-env-changed=LLMIDE_SKIP_STAGE_CHECK");
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        return;
    }
    // Cargo does not track extension/ edits; a path that never exists makes this script run on every release build.
    println!("cargo:rerun-if-changed=.stage-check-always");
    if std::env::var("LLMIDE_SKIP_STAGE_CHECK").as_deref() == Ok("1") {
        println!("cargo:warning=LLMIDE_SKIP_STAGE_CHECK=1: not checking that resources/core is up to date");
        return;
    }
    let fix = "run `node scripts/stage-core.mjs` in desktop/ (or scripts/build-desktop-mac.sh) and build again";
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()));
    let stage_json = manifest.join("..").join("resources").join("core").join("STAGE.json");
    let Ok(text) = std::fs::read_to_string(&stage_json) else {
        fail(&format!("resources/core has not been staged (no STAGE.json); {fix}"));
    };
    let Some(staged) = staged_hash(&text) else {
        fail(&format!("resources/core/STAGE.json has no sourceHash (staged by an older script); {fix}"));
    };
    let current = std::process::Command::new("node")
        .arg(manifest.join("..").join("scripts").join("stage-hash.mjs"))
        .output();
    let current = match current {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Ok(o) => fail(&format!("could not fingerprint the source (stage-hash.mjs: {}); {fix}", String::from_utf8_lossy(&o.stderr).trim())),
        Err(e) => fail(&format!("could not run node to fingerprint the source ({e}); {fix}")),
    };
    if current != staged {
        fail(&format!("resources/core is stale: the extension/schema source changed since it was staged; {fix}"));
    }
}

fn fail(message: &str) -> ! {
    eprintln!("error: {message}");
    std::process::exit(1);
}

fn main() {
    check_staged_core();
    // Without the `spike` cargo feature the spike commands are not registered, and their capability file
    // is not even embedded: only `default.json` is compiled in. (The commands stay in the manifest so
    // `capabilities/spike.json` still validates when the feature is on.)
    println!("cargo:rerun-if-changed=capabilities");
    let spike = std::env::var_os("CARGO_FEATURE_SPIKE").is_some();
    let mut attrs = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if !spike {
        attrs = attrs.capabilities_path_pattern("./capabilities/default.json");
    }
    tauri_build::try_build(attrs).expect("tauri build failed");
}
