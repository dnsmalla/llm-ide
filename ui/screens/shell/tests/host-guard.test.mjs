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

test('host guard: read_file is refused in ssh mode with RemoteModeError', async () => {
  const { isRemoteCoreMode } = await load("host.ts");
  setHostBridge({ async invoke(cmd) { return cmd; } });
  setRemoteModeProvider(() => isRemoteCoreMode("ssh"));
  try {
    await assert.rejects(invokeHost("read_file"), (e) => e.code === "remote_mode" && e.command === "read_file");
    assert.equal(await invokeHost("remote_ssh_server_connect"), "remote_ssh_server_connect");
  } finally {
    setRemoteModeProvider(() => false);
    setHostBridge(null);
  }
});

test('status: mode "ssh" + link "reconnecting" decodes; link "weird" decodes to "failed"', async () => {
  const { normalizeCoreStatus, isRemoteCoreMode, sshForwardReady } = await load("host.ts");
  const s = normalizeCoreStatus({ state: "ssh", mode: "ssh", trust: "ssh_forward", link: "reconnecting", url: "http://127.0.0.1:3456" });
  assert.equal(s.mode, "ssh");
  assert.equal(s.state, "ssh");
  assert.equal(s.trust, "ssh_forward");
  assert.equal(s.link, "reconnecting");
  assert.equal(normalizeCoreStatus({ state: "ssh", mode: "ssh", link: "weird" }).link, "failed");
  assert.equal(normalizeCoreStatus({ state: "ready" }).link, null);
  assert.equal(isRemoteCoreMode("ssh"), true);
  assert.equal(isRemoteCoreMode("remote"), true);
  assert.equal(isRemoteCoreMode("local"), false);
  assert.equal(isRemoteCoreMode(undefined), false);
  assert.equal(sshForwardReady(s), true);
  assert.equal(sshForwardReady({ ...s, link: "needs_password" }), false);
  assert.equal(sshForwardReady({ ...s, url: "" }), false);
});
