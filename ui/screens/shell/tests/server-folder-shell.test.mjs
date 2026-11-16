// SSH server folder: the shell's picker registration, the root_missing hook, the toolbar badge text and the project
// store's notice. Node-only; the host is a fake bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { serverFolderHandlerFor, setServerFolderHandler, serverFolderHandler } = await load("server-folder.ts");
const { setHostBridge, setSshModeProvider, setRemoteModeProvider, invokeHost, subscribeRootMissing, beginServerFolderOpen, endServerFolderOpen } = await load("host.ts");
const { sshBadgeText } = await load("../settings/ssh-server-model.ts");
const { createProjectStore } = await load("project-store.ts");

const ROOT_MISSING = "This folder is no longer on the server.";

test("picker registration: the opener is registered in ssh mode only", () => {
  const open = () => undefined;
  assert.equal(serverFolderHandlerFor(true, open), open);
  assert.equal(serverFolderHandlerFor(false, open), null);
  setServerFolderHandler(serverFolderHandlerFor(false, open));
  assert.equal(serverFolderHandler(), null, "local mode offers no server folder action");
  setServerFolderHandler(null);
});

test("root_missing from a later host call notifies once, in ssh mode, and not for the workspace commands", async () => {
  const seen = [];
  const off = subscribeRootMissing((message) => seen.push(message));
  let reject = null;
  setHostBridge({ async invoke() { if (reject) throw reject; return null; } });
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    reject = { code: "root_missing", message: ROOT_MISSING };
    await assert.rejects(invokeHost("fs_list_dir", { path: "" }), (e) => e.code === "root_missing");
    assert.deepEqual(seen, [ROOT_MISSING]);

    // The picker's own open is not a "later" call: its refusal shows inline, not as a return home.
    await assert.rejects(invokeHost("remote_ssh_workspace_open", { path: "/x" }));
    assert.deepEqual(seen, [ROOT_MISSING]);

    // Outside ssh mode the same error does not trigger a return home.
    setSshModeProvider(() => false);
    await assert.rejects(invokeHost("fs_list_dir", { path: "" }));
    assert.deepEqual(seen, [ROOT_MISSING]);
  } finally {
    off();
    setSshModeProvider(() => false);
    setRemoteModeProvider(() => false);
    setHostBridge(null);
  }
});

test("toolbar badge: the open folder's name follows the host", () => {
  assert.equal(sshBadgeText("connected", "192.168.100.32", "llm-ide"), "SSH: 192.168.100.32 · llm-ide");
  assert.equal(sshBadgeText("connected", "192.168.100.32"), "SSH: 192.168.100.32");
  assert.equal(sshBadgeText("connected", "192.168.100.32", "  "), "SSH: 192.168.100.32");
  assert.equal(sshBadgeText("reconnecting", "h", "api"), "Reconnecting to h… · api");
  assert.equal(sshBadgeText("off", "h", "api"), null);
});

test("project store: announce sets the notice without touching the project", async () => {
  const store = createProjectStore({
    async projectActive() { return { name: "llm", root: "/x/llm" }; },
    async projectRecent() { return []; },
    async projectOpen() { return null; },
    async projectOpenRecent() { throw new Error("unused"); },
  }, () => []);
  await store.refresh();
  store.announce("Opened, but the server did not register the project: nope");
  const s = store.getSnapshot();
  assert.equal(s.notice, "Opened, but the server did not register the project: nope");
  assert.equal(s.project?.root, "/x/llm");
  store.dismissNotice();
  assert.equal(store.getSnapshot().notice, null);
});

// The root_missing gate: a late answer about the previous folder, or one during an open, must not close the folder.
test("root_missing gate: a call started before the folder changed is ignored; a call started after it counts", async () => {
  const seen = [];
  const off = subscribeRootMissing((message) => seen.push(message));
  let rejectLater = null;
  setHostBridge({ invoke(cmd) { if (cmd === "fs_list_dir") return new Promise((_, rej) => { rejectLater = rej; }); return Promise.resolve(null); } });
  setRemoteModeProvider(() => true);
  setSshModeProvider(() => true);
  try {
    // Started on the old folder, answered after a new folder was opened.
    const old = invokeHost("fs_list_dir", { path: "" });
    beginServerFolderOpen();
    endServerFolderOpen();
    rejectLater({ code: "root_missing", message: ROOT_MISSING });
    await assert.rejects(old);
    assert.deepEqual(seen, [], "the late answer for the previous folder is ignored");

    // Started while an open is in progress: ignored too.
    beginServerFolderOpen();
    const during = invokeHost("fs_list_dir", { path: "" });
    rejectLater({ code: "root_missing", message: ROOT_MISSING });
    await assert.rejects(during);
    endServerFolderOpen();
    assert.deepEqual(seen, []);

    // Started after the open finished, on the current folder: it counts.
    const current = invokeHost("fs_list_dir", { path: "" });
    rejectLater({ code: "root_missing", message: ROOT_MISSING });
    await assert.rejects(current);
    assert.deepEqual(seen, [ROOT_MISSING]);
  } finally {
    off();
    setSshModeProvider(() => false);
    setRemoteModeProvider(() => false);
    setHostBridge(null);
  }
});
