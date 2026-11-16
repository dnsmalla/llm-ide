// SSH server mode: every reveal button copies the absolute server path (the file lives on the server, so this computer's
// file manager cannot show it). These tests pin the path text, the one shared mechanism, and every reveal caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { COPY_SERVER_PATH_LABEL, REVEAL_LABEL, fileManagerActionFor, serverPathOf } from "../server-path.ts";

const SCREENS = new URL("../../", import.meta.url).pathname;

test("serverPathOf joins the open root and the relative path with '/'", () => {
  assert.equal(serverPathOf("/home/me/proj", "llm-doc/notes/a.md"), "/home/me/proj/llm-doc/notes/a.md");
  assert.equal(serverPathOf("/home/me/proj/", "/llm-doc"), "/home/me/proj/llm-doc", "extra slashes are not doubled");
  assert.equal(serverPathOf("/home/me/proj", ""), "/home/me/proj", "empty relative path is the root");
  assert.equal(serverPathOf("/", "etc"), "/etc");
  assert.equal(serverPathOf("/", ""), "/");
});

test("fileManagerActionFor: local mode reveals; ssh mode copies the server path and never reveals", async () => {
  const revealed = [];
  const copied = [];
  const local = fileManagerActionFor(false, "/p", async (rel) => { revealed.push(rel); }, (t) => copied.push(t));
  assert.equal(local.label, REVEAL_LABEL);
  await local.run("system");
  assert.deepEqual(revealed, ["system"]);
  assert.deepEqual(copied, []);

  const ssh = fileManagerActionFor(true, "/home/me/p", async () => { throw new Error("must not reveal"); }, (t) => copied.push(t));
  assert.equal(ssh.label, COPY_SERVER_PATH_LABEL);
  await ssh.run("system");
  assert.deepEqual(copied, ["/home/me/p/system"]);
});

test("fileManagerActionFor: nothing to offer without a reveal (local) or without a root (ssh)", () => {
  assert.equal(fileManagerActionFor(false, "/p", undefined), undefined);
  assert.equal(fileManagerActionFor(true, null, async () => undefined), undefined);
});

test("paths_copy_path_in_ssh_mode: a folder row copies its absolute server path", async () => {
  // PathsSection builds its buttons from fileManagerActionFor with the project root; a folder row copies root + name.
  const copied = [];
  const data = { root: "/srv/work/proj", folders: [{ name: "system", exists: true }, { name: "meetings", exists: false }] };
  const action = fileManagerActionFor(true, data.root, undefined, (t) => copied.push(t));
  for (const f of data.folders) await action.run(f.name);
  assert.deepEqual(copied, ["/srv/work/proj/system", "/srv/work/proj/meetings"]);
  assert.equal(action.label, COPY_SERVER_PATH_LABEL);
});

// Every file under ui/screens that shows or wires a reveal. A new reveal caller must be added here with the marker that
// shows it is SSH-aware (it reads the server mode or builds the server path); a file that drops its marker fails.
const SSH_MARKER = /serverPathOf|fileManagerActionFor|COPY_SERVER_PATH_LABEL|inSshMode\(\)|serverFiles|mode === "ssh"|revealLabel|revealMeetingsLabel|revealer\?\.label/;
const REVEAL_CALLERS = {
  "explorer/ExplorerScreen.tsx": "serverPathOf",
  "explorer/menus.ts": "COPY_SERVER_PATH_LABEL",
  "explorer/scm/ChangesView.tsx": "serverFiles",
  "explorer/scm/ScmPanel.tsx": "serverFiles",
  "docgen/section.tsx": "serverFiles",
  "docgen/DocGenScreen.tsx": "revealLabel",
  "docgen/ResultPanel.tsx": "revealLabel",
  "docgen/SourcePanel.tsx": "revealLabel",
  "library/index.tsx": "fileManagerActionFor",
  "library/local-actions.ts": "fileManagerActionFor",
  "library/LibraryScreen.tsx": "revealLabel",
  "library/LibraryNav.tsx": "revealMeetingsLabel",
  "library/NoteMenuItems.tsx": "revealLabel",
  "library/write/NoteWorkspace.tsx": "revealLabel",
  "library/extensions/index.tsx": "inSshMode()",
  "library/extensions/LegacyDetail.tsx": "revealer",
  "loop/native/NativeLoopScreen.tsx": "serverFiles",
  "settings/sections/PathsSection.tsx": "fileManagerActionFor",
  "settings/sections/MemorySection.tsx": "fileManagerActionFor",
  "shell/StatusBar.tsx": "COPY_SERVER_PATH_LABEL",
};
// Not callers: the host plumbing (the command and its types), label text, pass-through props, comments, and the one
// helper module. Each one's button lives in a listed caller above.
const HOST_PLUMBING = new Set([
  "shell/host.ts", "shell/settings-adapter.ts", "settings/host.ts", "docgen/reveal.ts", "shell/server-path.ts",
  "settings/project-model.ts", // the "Show in Finder" label text; PathsSection draws the button
  "library/extensions/LegacyPane.tsx", // passes the LocationReveal through to LegacyDetail
  "library/extensions/legacy-labels.ts", // the LocationReveal type; local-actions.ts builds it
  "library/project-files.ts", // a comment and the meetings candidate list; LibraryScreen draws the button
  "shell/Shell.tsx", // the chat approval badge, unrelated to file reveal
  "welcome/help.ts", // help text
]);
// Reveal buttons that exist only outside ssh mode: the caller hides them there, and the check reads that gate.
const HIDDEN_IN_SSH = { "explorer/Dialogs.tsx": { gate: "explorer/ExplorerScreen.tsx", pattern: /shellHost\.isAvailable\(\) && !serverFiles/ } };
const REVEAL_WORDS = /reveal_in_os|revealPath|Reveal in Finder|Show in Finder|Reveal meetings folder|Reveal JSON|>Reveal<|\bReveal\b|onRevealPath|onReveal\b|projectLocationReveal/;

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "tests" || name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

test("every_reveal_caller_is_ssh_aware", () => {
  const callers = [];
  for (const file of sourceFiles(SCREENS)) {
    const rel = relative(SCREENS, file).split(sep).join("/");
    if (HOST_PLUMBING.has(rel)) continue;
    if (REVEAL_WORDS.test(readFileSync(file, "utf8"))) callers.push(rel);
  }
  const unknown = callers.filter((rel) => !(rel in REVEAL_CALLERS) && !(rel in HIDDEN_IN_SSH));
  assert.deepEqual(unknown, [], "a new reveal caller must be SSH-aware and listed in REVEAL_CALLERS");
  for (const [rel, { gate, pattern }] of Object.entries(HIDDEN_IN_SSH)) {
    assert.match(readFileSync(join(SCREENS, gate), "utf8"), pattern, `${gate} must hide ${rel} in ssh mode`);
  }
  for (const rel of Object.keys(REVEAL_CALLERS)) {
    const text = readFileSync(join(SCREENS, rel), "utf8");
    assert.ok(callers.includes(rel) || REVEAL_CALLERS[rel], `${rel} is listed but no longer a reveal caller`);
    assert.match(text, SSH_MARKER, `${rel} has no SSH-aware marker`);
    assert.ok(text.includes(REVEAL_CALLERS[rel]), `${rel} lost its ${REVEAL_CALLERS[rel]} wiring`);
  }
});
