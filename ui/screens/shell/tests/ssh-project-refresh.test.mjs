// SSH server mode: the project refresh reads the active project and must not fail because the local recent lists are
// refused on the server (that failure left the Explorer with no project even with a server folder open).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { projectStore, setHostBridge, setRemoteModeProvider, setSshModeProvider } = await load("tests/project-refresh-entry.ts");

test("project refresh in ssh mode: the server folder is the project, no error, no local recent command sent", async () => {
  const calls = [];
  setHostBridge({
    async invoke(cmd) {
      calls.push(cmd);
      if (cmd === "project_active") return { name: "proj", root: "/home/me/proj" };
      // The guard refuses these in ssh mode; the store must never ask.
      if (cmd === "project_recent" || cmd === "project_recent_all") throw Object.assign(new Error("refused"), { code: "remote_mode" });
      throw new Error(`unexpected ${cmd}`);
    },
  });
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    await projectStore.refresh();
    const snap = projectStore.getSnapshot();
    assert.equal(snap.error, null);
    assert.equal(snap.loaded, true);
    assert.equal(snap.project?.root, "/home/me/proj");
    assert.deepEqual(snap.recent, []);
    assert.deepEqual(calls, ["project_active"]);
  } finally {
    setRemoteModeProvider(() => false);
    setSshModeProvider(() => false);
    setHostBridge(null);
  }
});

// A server call that finds no open folder (the host reset its backend on a disconnect or stop) tells the shell to read
// the active project again. Only in ssh mode, and never for the workspace commands, which answer their own errors.
test("no_project in ssh mode notifies the project listeners; other modes and the workspace commands do not", async () => {
  const hostMod = await load("host.ts");
  let calls = 0;
  const off = hostMod.subscribeNoProject(() => { calls += 1; });
  const fail = (code) => ({ async invoke() { throw Object.assign(new Error("no folder"), { code }); } });
  try {
    hostMod.setHostBridge(fail("no_project"));
    hostMod.setSshModeProvider(() => true);
    await assert.rejects(hostMod.invokeHost("fs_list_dir", { path: "" }));
    assert.equal(calls, 1, "ssh: the explorer's no_project refreshes the project");

    hostMod.setSshModeProvider(() => false);
    await assert.rejects(hostMod.invokeHost("fs_list_dir", { path: "" }));
    assert.equal(calls, 1, "local: no refresh");

    hostMod.setSshModeProvider(() => true);
    await assert.rejects(hostMod.invokeHost("remote_ssh_workspace_open", { path: "/x" }));
    assert.equal(calls, 1, "workspace commands answer their own errors");
  } finally {
    off();
    hostMod.setSshModeProvider(() => false);
    hostMod.setHostBridge(null);
  }
});
