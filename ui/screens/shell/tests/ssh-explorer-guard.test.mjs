// SSH server mode admits the Explorer's commands (they run on the server); hub mode keeps refusing them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { setHostBridge, setRemoteModeProvider, setSshModeProvider, invokeHost, host } = await load("host.ts");

// Every command the Explorer, its search, watch, source control and terminal send to the host.
const FS = ["fs_list_dir", "fs_read_file", "fs_read_image", "fs_read_range", "fs_write_file", "fs_create", "fs_rename", "fs_copy", "fs_delete", "fs_watch_start", "fs_watch_set", "fs_watch_stop"];
const GIT = ["git_status", "git_diff", "git_diff_hunks", "git_stage", "git_stage_all", "git_stage_hunks", "git_discard", "git_discard_all", "git_identity", "git_commit", "git_commit_amend", "git_branches", "git_checkout", "git_create_branch", "git_log", "git_commit_files", "git_commit_diff", "git_tags", "git_tag_create", "git_branch_delete", "git_stash_list", "git_stash_push", "git_stash_apply", "git_stash_pop", "git_stash_drop", "git_merge", "git_merge_abort", "git_show", "git_config"];
const SEARCH_AND_PROJECT = ["project_search_start", "project_search_cancel", "project_active", "project_close"];
const PTY = ["pty_spawn", "pty_write", "pty_ack", "pty_resize", "pty_kill", "pty_status", "pty_retry_consent"];
const PROJECT_SETUP = ["project_paths", "project_memory", "project_rebuild_folders", "read_graph_file", "repo_clone"];
const ADMITTED_IN_SSH = [...FS, ...GIT, ...SEARCH_AND_PROJECT, ...PTY, ...PROJECT_SETUP];

// Each of these touches this computer (native dialogs, the OS file manager or viewer, local project lists) or is not an Explorer command.
const REFUSED_IN_SSH = [
  "fs_open_pdf", "reveal_in_os", "project_open", "project_create", "project_open_recent", "project_recent", "project_recent_all",
  "project_forget_recent", "project_layout", "project_root", "project_scaffold",
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

test("ssh_admits_project_setup_commands: Paths, Memory, graph reads and clone run on the server folder", async () => {
  bridge();
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    for (const cmd of PROJECT_SETUP) assert.equal(await invokeHost(cmd), cmd, cmd);
  } finally {
    reset();
  }
});

test("ssh_still_refuses_reveal_and_project_create", async () => {
  bridge();
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    for (const cmd of ["reveal_in_os", "project_create", "fs_open_pdf"]) {
      await assert.rejects(invokeHost(cmd), (e) => e.code === "remote_mode" && e.command === cmd, cmd);
    }
  } finally {
    reset();
  }
});

test("refusal_text_names_ssh_mode in ssh mode, and keeps the remote text in hub mode", async () => {
  bridge();
  setRemoteModeProvider(() => true);
  try {
    setSshModeProvider(() => true);
    await assert.rejects(invokeHost("reveal_in_os", { relPath: "" }), (e) => {
      assert.equal(e.code, "remote_mode");
      assert.equal(e.message, "This action uses the local computer and is unavailable in SSH server mode.");
      return true;
    });
    setSshModeProvider(() => false);
    await assert.rejects(invokeHost("reveal_in_os", { relPath: "" }), (e) => {
      assert.equal(e.message, "This action uses the local computer and is unavailable in remote mode.");
      return true;
    });
  } finally {
    reset();
  }
});

// The saved-login commands: the host keeps the login per server in SSH mode and refuses them itself in hub mode.
const SAVED_LOGIN = ["local_login_save", "local_login_session", "local_login_relogin", "local_login_store_refresh", "local_login_status", "local_login_forget"];

function recordingBridge() {
  const calls = [];
  setHostBridge({ async invoke(cmd) { calls.push(cmd); return cmd; } });
  return calls;
}

test("ssh mode admits the six saved-login commands", async () => {
  const calls = recordingBridge();
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    for (const cmd of SAVED_LOGIN) assert.equal(await invokeHost(cmd), cmd, cmd);
    assert.deepEqual(calls, SAVED_LOGIN);
  } finally {
    reset();
  }
});

test("hub mode still refuses the saved-login commands", async () => {
  const calls = recordingBridge();
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => false);
  try {
    for (const cmd of SAVED_LOGIN) {
      await assert.rejects(invokeHost(cmd), (e) => e.code === "remote_mode" && e.command === cmd, cmd);
    }
    assert.deepEqual(calls, []);
  } finally {
    reset();
  }
});

test("local mode is unchanged for the saved-login commands", async () => {
  const calls = recordingBridge();
  try {
    for (const cmd of SAVED_LOGIN) assert.equal(await invokeHost(cmd), cmd, cmd);
    assert.deepEqual(calls, SAVED_LOGIN);
  } finally {
    reset();
  }
});

test("ssh mode: the real host wrappers reach the bridge with the saved-login command names", async () => {
  const calls = [];
  setHostBridge({ async invoke(cmd) { calls.push(cmd); return null; } });
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    await host.localLoginSave("a@b.c", "pw");
    await host.localLoginSession();
    await host.localLoginStatus();
    await host.localLoginForget();
    assert.deepEqual(calls, ["local_login_save", "local_login_session", "local_login_status", "local_login_forget"]);
  } finally {
    reset();
  }
});
