// SSH server mode admits the Explorer's commands (they run on the server); hub mode keeps refusing them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { setHostBridge, setRemoteModeProvider, setSshModeProvider, invokeHost } = await load("host.ts");

// Every command the Explorer, its search, watch, source control and terminal send to the host.
const FS = ["fs_list_dir", "fs_read_file", "fs_read_image", "fs_read_range", "fs_write_file", "fs_create", "fs_rename", "fs_copy", "fs_delete", "fs_watch_start", "fs_watch_set", "fs_watch_stop"];
const GIT = ["git_status", "git_diff", "git_diff_hunks", "git_stage", "git_stage_all", "git_stage_hunks", "git_discard", "git_discard_all", "git_identity", "git_commit", "git_commit_amend", "git_branches", "git_checkout", "git_create_branch", "git_log", "git_commit_files", "git_commit_diff", "git_tags", "git_tag_create", "git_branch_delete", "git_stash_list", "git_stash_push", "git_stash_apply", "git_stash_pop", "git_stash_drop", "git_merge", "git_merge_abort", "git_show", "git_config"];
const SEARCH_AND_PROJECT = ["project_search_start", "project_search_cancel", "project_active", "project_close"];
const PTY = ["pty_spawn", "pty_write", "pty_ack", "pty_resize", "pty_kill", "pty_status", "pty_retry_consent"];
const ADMITTED_IN_SSH = [...FS, ...GIT, ...SEARCH_AND_PROJECT, ...PTY];

// Each of these touches this computer (native dialogs, the OS file manager or viewer, local project lists) or is not an Explorer command.
const REFUSED_IN_SSH = [
  "fs_open_pdf", "reveal_in_os", "project_open", "project_create", "project_open_recent", "project_recent", "project_recent_all",
  "project_forget_recent", "project_paths", "project_rebuild_folders", "project_memory", "project_layout", "project_root", "project_scaffold",
  "read_file", "notes_list", "chat_list", "self_heal_prepare", "source_pick_folder",
];

function bridge() {
  setHostBridge({ async invoke(cmd) { return cmd; } });
}

function reset() {
  setRemoteModeProvider(() => false);
  setSshModeProvider(() => false);
  setHostBridge(null);
}

test("ssh mode admits exactly the Explorer command set and refuses the rest", async () => {
  bridge();
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    for (const cmd of ADMITTED_IN_SSH) assert.equal(await invokeHost(cmd), cmd, cmd);
    for (const cmd of REFUSED_IN_SSH) {
      await assert.rejects(invokeHost(cmd), (e) => e.code === "remote_mode" && e.command === cmd, cmd);
    }
  } finally {
    reset();
  }
});

test("ssh mode still refuses fs_open_pdf: it opens a file in this computer's viewer", async () => {
  bridge();
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    await assert.rejects(invokeHost("fs_open_pdf", { path: "a.pdf" }), (e) => e.code === "remote_mode");
  } finally {
    reset();
  }
});

test("hub mode refuses the Explorer commands; its remote-safe set is unchanged", async () => {
  bridge();
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => false);
  try {
    for (const cmd of [...ADMITTED_IN_SSH, "fs_open_pdf", "reveal_in_os", "project_open"]) {
      await assert.rejects(invokeHost(cmd), (e) => e.code === "remote_mode" && e.command === cmd, cmd);
    }
    assert.equal(await invokeHost("core_status"), "core_status");
    assert.equal(await invokeHost("remote_ssh_server_connect"), "remote_ssh_server_connect");
  } finally {
    reset();
  }
});

test("local mode calls every command", async () => {
  bridge();
  try {
    for (const cmd of [...ADMITTED_IN_SSH, ...REFUSED_IN_SSH]) assert.equal(await invokeHost(cmd), cmd, cmd);
  } finally {
    reset();
  }
});
