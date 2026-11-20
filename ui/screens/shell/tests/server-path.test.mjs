// SSH server mode: every reveal button copies the absolute server path (the file lives on the server, so this computer's
// file manager cannot show it). These tests pin the path text, the one shared mechanism, and every reveal caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { COPY_SERVER_PATH_LABEL, REVEAL_LABEL, fileManagerActionFor, serverPathOf } from "../server-path.ts";

const SCREENS = fileURLToPath(new URL("../../", import.meta.url));

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

// The reveal sinks are the host command (reveal_in_os) and the host method (revealPath). Every code line that names one
// is counted per file, and the counts are pinned: a new sink, anywhere, fails this test until the table is updated on
// purpose. Each UI sink must sit within SSH_WINDOW lines of an SSH branch (the server-mode flag, the ssh copy helper or
// its label). Host plumbing is pinned per file as well, so each of its sites is listed, not the file as a whole.
// The entry points (fileManagerActionFor, projectLocationReveal) are pinned the same way; each must receive the mode.
const SSH_WINDOW = 12;
const SSH_BRANCH = /serverFiles|mode === "ssh"|inSshMode\(\)|serverPathOf|fileManagerActionFor|revealLabel|COPY_SERVER_PATH_LABEL/;
const SINK = /reveal_in_os|\brevealPath\b/;
const ENTRY = /(?<!function )\bfileManagerActionFor\(|(?<!function )\bprojectLocationReveal\(/;

// file -> pinned count of sink lines and entry lines (code only, comments excluded).
const UI_PINNED = {
  "docgen/section.tsx": { sinks: 1, entries: 0 },
  "explorer/ExplorerScreen.tsx": { sinks: 2, entries: 0 },
  "explorer/scm/ChangesView.tsx": { sinks: 1, entries: 0 },
  "library/extensions/index.tsx": { sinks: 1, entries: 1 },
  "library/index.tsx": { sinks: 1, entries: 1 },
  "library/local-actions.ts": { sinks: 0, entries: 1 },
  "loop/native/NativeLoopScreen.tsx": { sinks: 1, entries: 1 },
  "settings/sections/MemorySection.tsx": { sinks: 2, entries: 1 },
  "settings/sections/PathsSection.tsx": { sinks: 2, entries: 1 },
};
// Host plumbing: the command wrappers and the method type. Not buttons; pinned per site.
const PLUMBING_PINNED = {
  "shell/host.ts": { sinks: 1, entries: 0 },
  "shell/settings-adapter.ts": { sinks: 2, entries: 0 },
  "settings/host.ts": { sinks: 1, entries: 0 },
};

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

/** Line indexes (0-based) of code lines matching `pattern`; comment lines are not code. */
function codeHits(lines, pattern) {
  const hits = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (pattern.test(line)) hits.push(i);
  });
  return hits;
}

test("every_reveal_caller_is_ssh_aware", () => {
  const counted = {};
  for (const file of sourceFiles(SCREENS)) {
    const rel = relative(SCREENS, file).split(sep).join("/");
    const lines = readFileSync(file, "utf8").split("\n");
    const sinks = codeHits(lines, SINK);
    const entries = codeHits(lines, ENTRY);
    if (sinks.length === 0 && entries.length === 0) continue;
    counted[rel] = { sinks: sinks.length, entries: entries.length };
    const pinned = UI_PINNED[rel] ?? PLUMBING_PINNED[rel];
    assert.ok(pinned, `${rel} has reveal sites but is not in the pinned table (sinks ${sinks.length}, entries ${entries.length})`);
    assert.deepEqual({ sinks: sinks.length, entries: entries.length }, pinned, `${rel}: reveal site count changed; review it and update the table`);
    if (UI_PINNED[rel]) {
      for (const i of [...sinks, ...entries]) {
        const from = Math.max(0, i - SSH_WINDOW);
        const to = Math.min(lines.length, i + SSH_WINDOW + 1);
        const near = lines.slice(from, to).join("\n");
        assert.match(near, SSH_BRANCH, `${rel}:${i + 1} reveal site has no SSH branch within ${SSH_WINDOW} lines`);
      }
    }
  }
  for (const rel of [...Object.keys(UI_PINNED), ...Object.keys(PLUMBING_PINNED)]) {
    assert.ok(rel in counted, `${rel} is pinned but has no reveal sites any more; remove it from the table`);
  }
});
