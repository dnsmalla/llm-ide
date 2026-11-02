import { test } from "node:test";
import assert from "node:assert/strict";
import { readOnlyCheck } from "../native/read-only.ts";
import { guardedAgentCall } from "../../loop/native/agent-call.ts";
import { resolvePath } from "../native/usage.ts";

test("read-only revert: a clean path is reverted, and only the agent's created files may be deleted", async () => {
  const calls = [];
  const check = readOnlyCheck(async (paths, created) => { calls.push({ paths, created }); });
  const msg = await check(["docs/report.md", "docs/new.md"], new Set(), ["docs/new.md"]);
  assert.equal(msg, null);
  assert.deepEqual(calls, [{ paths: ["docs/report.md", "docs/new.md"], created: ["docs/new.md"] }]);
});

test("read-only revert: a path the user had already edited is never reverted", async () => {
  let reverted = false;
  const check = readOnlyCheck(async () => { reverted = true; });
  const msg = await check(["src/mine.ts"], new Set(["src/mine.ts"]), []);
  assert.equal(reverted, false);
  assert.match(msg, /uncommitted changes before the run/);
});

test("read-only revert: a file inside an untracked directory the user had is never reverted", async () => {
  let reverted = false;
  const check = readOnlyCheck(async () => { reverted = true; });
  assert.match(await check(["notes/draft.md"], new Set(["notes/"]), []), /uncommitted/);
  assert.equal(reverted, false);
});

test("read-only revert: no pre-run snapshot means nothing is reverted", async () => {
  let reverted = false;
  const check = readOnlyCheck(async () => { reverted = true; });
  assert.match(await check(["docs/report.md"], null, []), /snapshot failed/);
  assert.equal(reverted, false);
});

test("read-only revert: a failed host revert is reported, not swallowed", async () => {
  const check = readOnlyCheck(async () => { throw new Error("git checkout failed"); });
  assert.match(await check(["docs/report.md"], new Set(), []), /read-only revert failed: git checkout failed/);
});

test("read-only revert: no writes means nothing to do", async () => {
  let reverted = false;
  const check = readOnlyCheck(async () => { reverted = true; });
  assert.equal(await check([], new Set(), []), null);
  assert.equal(reverted, false);
});

test("a read-only fake agent that writes a report then THROWS has the report reverted", async () => {
  const reverts = [];
  const check = readOnlyCheck(async (paths, created) => { reverts.push({ paths, created }); });
  const g = await guardedAgentCall({
    before: new Set(),
    call: async () => { throw new Error("timed out after 30 min"); },
    changedNow: async () => ["docs/report.md"],
    check,
  });
  assert.equal(g.result, null, "the call threw, so there is no answer");
  assert.equal(g.error, "timed out after 30 min");
  assert.deepEqual(reverts, [{ paths: ["docs/report.md"], created: [] }]);
  assert.equal(g.violation, null, "a clean revert is not a violation");
});

test("a read-only task that THROWS on a dirty tree reverts only its own new edit, never the user's file", async () => {
  const reverts = [];
  const check = readOnlyCheck(async (paths, created) => { reverts.push({ paths, created }); });
  const g = await guardedAgentCall({
    before: new Set(["src/mine.ts"]),
    call: async () => { throw new Error("connection dropped"); },
    changedNow: async () => ["src/mine.ts", "docs/report.md"],
    check,
  });
  assert.equal(g.error, "connection dropped");
  assert.deepEqual(g.writes, ["docs/report.md"]);
  assert.deepEqual(reverts, [{ paths: ["docs/report.md"], created: [] }]);
  assert.equal(g.violation, null);
});

// A fake working tree + git with the host's revert rules (loop_runner.rs `revert_paths_in`): a tracked path is
// restored from HEAD, an untracked one is deleted only when the agent's Write created it, else the whole revert fails.
function fakeRepo({ head, files, untrackedBefore = [] }) {
  const tree = new Map(Object.entries(files));
  const tracked = new Set(Object.keys(head));
  const status = () => [...new Set([...tree.keys(), ...tracked])].filter((p) => tracked.has(p) ? tree.get(p) !== head[p] : tree.has(p)).sort();
  return {
    tree,
    status,
    write(p, text) { tree.set(p, text); },
    async revert(paths, created) {
      for (const p of paths) if (!tracked.has(p) && !created.includes(p)) throw new Error(`${p} is not tracked and the agent did not create it; nothing was reverted`);
      for (const p of paths) { if (tracked.has(p)) tree.set(p, head[p]); else tree.delete(p); }
    },
    untrackedBefore,
  };
}

async function readOnlyRun(repo, { snapshotFails = false, agent }) {
  const before = snapshotFails ? null : new Set(repo.status());
  return guardedAgentCall({ before, call: async () => agent(repo), changedNow: async () => repo.status(), check: readOnlyCheck((p, c) => repo.revert(p, c)) });
}

test("fake repo: an Auto Task on a dirty tree keeps the user's edit and its pre-existing untracked file", async () => {
  const repo = fakeRepo({ head: { "src/mine.ts": "v1", "src/a.ts": "a1" }, files: { "src/mine.ts": "user edit", "src/a.ts": "a1", "scratch.txt": "user's own untracked" } });
  const g = await readOnlyRun(repo, { agent: (r) => { r.write("src/a.ts", "agent edit"); return { reply: "ok", changedPaths: ["src/a.ts"], createdPaths: [] }; } });
  assert.equal(g.violation, null);
  assert.equal(repo.tree.get("src/a.ts"), "a1", "the agent's edit to a clean file is reverted");
  assert.equal(repo.tree.get("src/mine.ts"), "user edit", "the user's uncommitted edit is untouched");
  assert.equal(repo.tree.get("scratch.txt"), "user's own untracked", "a pre-existing untracked file is untouched");
});

test("fake repo: a file the agent created is removed; one it did not report creating is refused, not deleted", async () => {
  const repo = fakeRepo({ head: { "src/a.ts": "a1" }, files: { "src/a.ts": "a1" } });
  const g = await readOnlyRun(repo, { agent: (r) => { r.write("docs/report.md", "findings"); return { reply: "ok", changedPaths: ["docs/report.md"], createdPaths: ["docs/report.md"] }; } });
  assert.equal(g.violation, null);
  assert.equal(repo.tree.has("docs/report.md"), false);

  const repo2 = fakeRepo({ head: {}, files: {} });
  const g2 = await readOnlyRun(repo2, { agent: (r) => { r.write("out.md", "x"); return { reply: "ok", changedPaths: ["out.md"], createdPaths: [] }; } });
  assert.match(g2.violation, /read-only revert failed: out\.md is not tracked/);
  assert.equal(repo2.tree.get("out.md"), "x", "an untracked file nobody said the agent created is kept");
});

test("fake repo: the agent edited the user's dirty file, so nothing is reverted and the user is told", async () => {
  const repo = fakeRepo({ head: { "src/mine.ts": "v1" }, files: { "src/mine.ts": "user edit" } });
  const g = await readOnlyRun(repo, { agent: (r) => { r.write("src/mine.ts", "user edit + agent"); return { reply: "ok", changedPaths: ["src/mine.ts"], createdPaths: [] }; } });
  assert.match(g.violation, /uncommitted changes before the run/);
  assert.equal(repo.tree.get("src/mine.ts"), "user edit + agent", "never reset to HEAD (that would lose the user's edit)");
});

test("fake repo: a failed pre-run snapshot blocks the revert and says so", async () => {
  const repo = fakeRepo({ head: { "src/a.ts": "a1" }, files: { "src/a.ts": "a1" } });
  const g = await readOnlyRun(repo, { snapshotFails: true, agent: (r) => { r.write("src/a.ts", "agent edit"); return { reply: "ok", changedPaths: ["src/a.ts"], createdPaths: [] }; } });
  assert.match(g.violation, /snapshot failed/);
  assert.equal(repo.tree.get("src/a.ts"), "agent edit");
});

test("a normal return passes the agent's createdPaths to the read-only revert", async () => {
  const reverts = [];
  const check = readOnlyCheck(async (paths, created) => { reverts.push({ paths, created }); });
  const g = await guardedAgentCall({
    before: new Set(),
    call: async () => ({ reply: "done", changedPaths: ["docs/new.md"], createdPaths: ["docs/new.md"] }),
    changedNow: async () => [],
    check,
  });
  assert.equal(g.violation, null);
  assert.deepEqual(reverts, [{ paths: ["docs/new.md"], created: ["docs/new.md"] }]);
});

test("the usage resolve request sends the user's model as prefer, and omits it when none is set", () => {
  assert.equal(resolvePath("anthropic"), "/kb/usage/resolve?provider=anthropic");
  assert.equal(resolvePath("anthropic", null), "/kb/usage/resolve?provider=anthropic");
  assert.equal(resolvePath("anthropic", "claude-sonnet-4-6"), "/kb/usage/resolve?provider=anthropic&prefer=claude-sonnet-4-6");
  assert.equal(resolvePath("anthropic", "a b"), "/kb/usage/resolve?provider=anthropic&prefer=a+b");
});
