import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptImprovement, revertImprovement, shouldAutoReview, runningLoopIdsOf, reviewStatusLine } from "../native/improve/panel-model.ts";
import { loadLoops } from "../native/store.ts";
import { encodeProjectStore } from "../native/model.ts";
import { initialProjectStore } from "../native/templates.ts";

function fixture() {
  const store = initialProjectStore(null);
  const loop = store.loops.find((l) => l.defaultKey !== null && l.defaultKey !== "factory") ?? store.loops[0];
  return { store, loop };
}
/** An fs that keeps one file and records every write; `conflicts` makes the first N writes throw a hash conflict. */
function stubFs(text, { conflicts = 0, onConflict } = {}) {
  const state = { text, hash: "h0", writes: [], events: [], left: conflicts, lessons: null, changes: null };
  const missing = () => { throw Object.assign(new Error("missing"), { code: "not_found" }); };
  const fs = {
    // system/loop.json is the one file under test; lessons.json is kept apart so the loop.json assertions stay exact.
    read: async (path) => (path === "system/loop.json" ? { status: "ok", text: state.text, hash: state.hash }
      : path === "system/self-improvement/lessons.json" && state.lessons !== null ? { status: "ok", text: state.lessons, hash: "L" }
      : path === "system/self-improvement/changes.jsonl" && state.changes !== null ? { status: "ok", text: state.changes, hash: `C${state.changes.length}` } : missing()),
    create: async (path) => path,
    write: async (path, next, opts) => {
      if (path === "system/self-improvement/lessons.json") { state.lessons = next; return { hash: "L" }; }
      if (path === "system/self-improvement/changes.jsonl") {
        assert.equal(opts.expected_hash, state.changes === null ? null : `C${state.changes.length}`);
        state.events.push("log"); state.changes = next; return { hash: `C${next.length}` };
      }
      state.events.push("write");
      if (state.left > 0) {
        state.left -= 1;
        if (onConflict) onConflict(state);
        throw Object.assign(new Error("conflict"), { code: "conflict" });
      }
      assert.equal(opts.expected_hash, state.hash);
      state.writes.push(next);
      state.text = next;
      state.hash = `h${state.writes.length}`;
      return { hash: state.hash };
    },
  };
  return { fs, state };
}
function stubCore(state, fail = false) {
  const calls = [];
  return {
    calls,
    request: async (path, init) => {
      calls.push({ path, body: init?.body });
      state.events.push("decide");
      if (fail) throw new Error("core down");
      return { improvement: {} };
    },
  };
}
async function deps(over = {}) {
  const { store, loop } = fixture();
  const { fs, state } = stubFs(encodeProjectStore(store));
  const load = await loadLoops(fs);
  return { store, loop, fs, state, load, core: stubCore(state), base: { projectRoot: "/p", runningLoopIds: new Set(), ...over } };
}
const maxIter = (loop, after) => ({ op: "setConfig", field: "maxIterations", before: loop.config.maxIterations, after });

test("shouldAutoReview fires at the configured run count", () => {
  const { loop } = fixture();
  loop.config.reviewEveryRuns = 5;
  assert.equal(shouldAutoReview(4, loop), false);
  assert.equal(shouldAutoReview(5, loop), true);
  assert.equal(shouldAutoReview(6, loop), true);
});

test("accept refuses while the loop runs and writes nothing", async () => {
  const d = await deps();
  const run = { fs: d.fs, core: d.core, load: d.load, ...d.base, runningLoopIds: new Set([d.loop.id]) };
  await assert.rejects(acceptImprovement(run, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 2), kind: "proposal" }, "project"), /Finish or stop the run first/);
  assert.equal(d.state.events.length, 0);
});

test("accept refuses a stale change with zero writes and no decide", async () => {
  const d = await deps();
  const run = { fs: d.fs, core: d.core, load: d.load, ...d.base };
  const stale = { ...maxIter(d.loop, 2), before: 1 };
  await assert.rejects(acceptImprovement(run, { id: "1", loopId: d.loop.id, change: stale, kind: "proposal" }, "project"), /This suggestion is out of date/);
  assert.equal(d.state.writes.length, 0);
  assert.equal(d.core.calls.length, 0);
});

test("accept saves first, then decides with the scope", async () => {
  const d = await deps();
  const run = { fs: d.fs, core: d.core, load: d.load, ...d.base };
  const out = await acceptImprovement(run, { id: "9", loopId: d.loop.id, change: maxIter(d.loop, 2), kind: "proposal", row: { rationale: "token ghp_" + "a".repeat(36) + " leaked", evidence: { signalIds: [1], excerpts: ["run 4 failed"] } } }, "general");
  assert.deepEqual(d.state.events, ["write", "log", "decide"], "loop file, then the change log, then the DB");
  const [line] = d.state.changes.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual([line.id, line.action, line.loopId, line.scope, line.change.after, line.excerpts], ["9", "accept", d.loop.id, "general", 2, ["run 4 failed"]]);
  assert.deepEqual(line.decide, { action: "accept", id: "9", scope: "general", logged: true });
  assert.doesNotMatch(line.rationale, /ghp_/, "the shared log is redacted");
  assert.equal(out.store.loops.find((l) => l.id === d.loop.id).config.maxIterations, 2);
  assert.equal(out.hash, `${d.state.hash}#L:`, "loop.json's hash, plus lessons.json's (none yet)");
  assert.equal(d.core.calls[0].path, "/kb/loop/improve/decide");
  assert.deepEqual(d.core.calls[0].body, { projectRoot: "/p", action: "accept", id: "9", scope: "general", logged: true }, "the log has it, so the DB keeps no copy");
});

test("a hash conflict reloads and retries once; a real change in between makes it stale", async () => {
  const d = await deps();
  const { fs, state } = stubFs(encodeProjectStore(d.store), { conflicts: 1, onConflict: (s) => { s.hash = "h-other"; } });
  const load = await loadLoops(fs);
  const core = stubCore(state);
  const out = await acceptImprovement({ fs, core, load, ...d.base }, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 2), kind: "proposal" }, "project");
  assert.equal(state.writes.length, 1);
  assert.equal(out.store.loops.find((l) => l.id === d.loop.id).config.maxIterations, 2);

  const again = stubFs(encodeProjectStore(d.store), { conflicts: 1, onConflict: (s) => {
    const other = structuredClone(d.store);
    other.loops.find((l) => l.id === d.loop.id).config.maxIterations = 1;
    s.text = encodeProjectStore(other); s.hash = "h-edited";
  } });
  const load2 = await loadLoops(again.fs);
  const core2 = stubCore(again.state);
  await assert.rejects(acceptImprovement({ fs: again.fs, core: core2, load: load2, ...d.base }, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 2), kind: "proposal" }, "project"), /out of date/);
  assert.equal(again.state.writes.length, 0);
  assert.equal(core2.calls.length, 0);
});

test("a second conflict is not retried again", async () => {
  const d = await deps();
  const { fs, state } = stubFs(encodeProjectStore(d.store), { conflicts: 2 });
  const load = await loadLoops(fs);
  await assert.rejects(acceptImprovement({ fs, core: stubCore(state), load, ...d.base }, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 2), kind: "proposal" }, "project"), /conflict/);
});

test("a failed decide after the save keeps the saved store and reports a notice", async () => {
  const d = await deps();
  const core = stubCore(d.state, true);
  const out = await acceptImprovement({ fs: d.fs, core, load: d.load, ...d.base }, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 2), kind: "proposal" }, "project");
  assert.equal(d.state.writes.length, 1);
  assert.match(out.notice, /could not be recorded/);
});

test("an offer applies by stageKey and is adopted with the loop id, no scope", async () => {
  const d = await deps();
  d.loop = d.store.loops.find((l) => l.defaultKey === "plan");
  const stage = d.loop.config.stages.find((s) => s.defaultKey !== null && s.kind === "skill");
  assert.ok(stage, "fixture has a keyed skill stage");
  const change = { op: "setPromptAddendum", stageId: "other-project-id", stageKey: stage.defaultKey, stageName: "x", before: null, after: "Be brief." };
  const out = await acceptImprovement({ fs: d.fs, core: d.core, load: d.load, ...d.base }, { id: "5", loopId: d.loop.id, change, kind: "offer" }, "project");
  assert.equal(out.store.loops.find((l) => l.id === d.loop.id).config.stages.find((s) => s.id === stage.id).promptAddendum, "Be brief.");
  const { newId, ...rest } = d.core.calls[0].body;
  assert.deepEqual(rest, { projectRoot: "/p", action: "adopt", id: "5", loopId: d.loop.id, logged: true });
  const adopted = JSON.parse(d.state.changes.trim().split("\n").pop());
  assert.deepEqual([adopted.id, adopted.action, adopted.origin], [newId, "adopt", "shared:5"], "the log line and the new row share one id");
  // The lesson is saved in the self-improvement folder, never in loop.json.
  assert.doesNotMatch(d.state.text, /Be brief/);
  assert.deepEqual(JSON.parse(d.state.lessons).lessons.map((e) => [e.loopId, e.stageId, e.stageKey, e.text]), [[d.loop.id, stage.id, stage.defaultKey, "Be brief."]]);
});

test("revert restores the before-value and decides revert", async () => {
  const d = await deps();
  const run = { fs: d.fs, core: d.core, load: d.load, ...d.base };
  const change = maxIter(d.loop, 2);
  const accepted = await acceptImprovement(run, { id: "1", loopId: d.loop.id, change, kind: "proposal" }, "project");
  d.core.calls.length = 0;
  const out = await revertImprovement({ ...run, load: { store: accepted.store, hash: accepted.hash } }, { id: "1", loopId: d.loop.id, change });
  assert.equal(out.store.loops.find((l) => l.id === d.loop.id).config.maxIterations, change.before);
  assert.equal(d.core.calls[0].body.action, "revert");
  await assert.rejects(revertImprovement({ ...run, runningLoopIds: new Set([d.loop.id]), load: { store: out.store, hash: out.hash } }, { id: "1", loopId: d.loop.id, change }), /Finish or stop/);
});

test("runningLoopIdsOf adds the Factory loop while the manager has a run for this project", () => {
  const { store } = fixture();
  const factory = store.loops.find((l) => l.defaultKey === "factory");
  assert.ok(factory, "fixture has a Factory loop");
  const ids = runningLoopIdsOf({ store, projectRoot: "/p", activeLoopId: "x", liveRuns: [{ projectRoot: "/p" }, { projectRoot: "/q" }] });
  assert.ok(ids.has("x"));
  assert.ok(ids.has(factory.id));
  assert.equal(runningLoopIdsOf({ store, projectRoot: "/p", activeLoopId: null, liveRuns: [{ projectRoot: "/q" }] }).size, 0);
});

test("the click-time check refuses when a run started after render, with zero writes", async () => {
  const d = await deps();
  let running = false;
  const run = { fs: d.fs, core: d.core, load: d.load, ...d.base, isRunning: () => running };
  running = true; // flips after the panel rendered with an empty runningLoopIds
  await assert.rejects(acceptImprovement(run, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 2), kind: "proposal" }, "project"), /Finish or stop the run first/);
  await assert.rejects(revertImprovement(run, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 2) }), /Finish or stop the run first/);
  assert.equal(d.state.events.length, 0);
});

test("reviewStatusLine shows a failed review with its reason", () => {
  assert.match(reviewStatusLine({ failed: "the reply was not valid JSON" }), /^Review failed: the reply was not valid JSON/);
});

test("when the change log cannot be written the DB keeps its copy (no logged flag) and the user is told", async () => {
  const d = await deps();
  const write = d.fs.write;
  d.fs.write = async (path, next, opts) => { if (path.endsWith("changes.jsonl")) throw Object.assign(new Error("disk full"), { code: "io" }); return write(path, next, opts); };
  d.fs.create = async () => { throw new Error("no"); };
  const out = await acceptImprovement({ fs: d.fs, core: d.core, load: d.load, ...d.base }, { id: "11", loopId: d.loop.id, change: maxIter(d.loop, 2), kind: "proposal" }, "project");
  assert.deepEqual(d.core.calls[0].body, { projectRoot: "/p", action: "accept", id: "11", scope: "project" });
  assert.match(out.notice, /changes\.jsonl could not be written/);
});
