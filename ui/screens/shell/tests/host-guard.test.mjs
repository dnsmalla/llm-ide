// R-034 #12: one invoke wrapper refuses local host commands in remote mode; remote-safe ones pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { setHostBridge, setRemoteModeProvider, invokeHost } = await load("host.ts");

test("remote mode refuses local-only host commands and allows the remote-safe set", async () => {
  setHostBridge({ async invoke(cmd) { return cmd; } });
  setRemoteModeProvider(() => true);
  try {
    for (const cmd of ["fs_read_range", "git_status", "project_open", "notes_list", "pty_spawn", "chat_list", "self_heal_prepare", "source_pick_folder"]) {
      await assert.rejects(invokeHost(cmd), (e) => e.code === "remote_mode" && e.command === cmd, cmd);
    }
    for (const cmd of ["core_status", "get_prefs", "app_restart", "remote_deploy_plan", "update_check", "notify_user", "tray_status"]) {
      assert.equal(await invokeHost(cmd), cmd, cmd);
    }
  } finally {
    setRemoteModeProvider(() => false);
  }
});

test("local mode still calls every command", async () => {
  setHostBridge({ async invoke(cmd) { return cmd; } });
  setRemoteModeProvider(() => false);
  assert.equal(await invokeHost("fs_read_range"), "fs_read_range");
  setHostBridge(null);
});
