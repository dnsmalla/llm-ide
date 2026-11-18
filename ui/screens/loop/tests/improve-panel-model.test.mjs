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
  const state = { text, hash: "h0", writes: [], events: [], left: conflicts };
  const fs = {
    read: async () => ({ status: "ok", text: state.text, hash: state.hash }),
    write: async (_path, next, opts) => {
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
  await assert.rejects(acceptImprovement(run, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 7), kind: "proposal" }, "project"), /Finish or stop the run first/);
  assert.equal(d.state.events.length, 0);
});

test("accept refuses a stale change with zero writes and no decide", async () => {
  const d = await deps();
  const run = { fs: d.fs, core: d.core, load: d.load, ...d.base };
  const stale = { ...maxIter(d.loop, 7), before: d.loop.config.maxIterations + 1 };
  await assert.rejects(acceptImprovement(run, { id: "1", loopId: d.loop.id, change: stale, kind: "proposal" }, "project"), /This suggestion is out of date/);
  assert.equal(d.state.writes.length, 0);
  assert.equal(d.core.calls.length, 0);
});

test("accept saves first, then decides with the scope", async () => {
  const d = await deps();
  const run = { fs: d.fs, core: d.core, load: d.load, ...d.base };
  const out = await acceptImprovement(run, { id: "9", loopId: d.loop.id, change: maxIter(d.loop, 7), kind: "proposal" }, "general");
  assert.deepEqual(d.state.events, ["write", "decide"]);
  assert.equal(out.store.loops.find((l) => l.id === d.loop.id).config.maxIterations, 7);
  assert.equal(out.hash, d.state.hash);
  assert.equal(d.core.calls[0].path, "/kb/loop/improve/decide");
  assert.deepEqual(d.core.calls[0].body, { projectRoot: "/p", action: "accept", id: "9", scope: "general" });
});

test("a hash conflict reloads and retries once; a real change in between makes it stale", async () => {
  const d = await deps();
  const { fs, state } = stubFs(encodeProjectStore(d.store), { conflicts: 1, onConflict: (s) => { s.hash = "h-other"; } });
  const load = await loadLoops(fs);
  const core = stubCore(state);
  const out = await acceptImprovement({ fs, core, load, ...d.base }, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 7), kind: "proposal" }, "project");
  assert.equal(state.writes.length, 1);
  assert.equal(out.store.loops.find((l) => l.id === d.loop.id).config.maxIterations, 7);

  const again = stubFs(encodeProjectStore(d.store), { conflicts: 1, onConflict: (s) => {
    const other = structuredClone(d.store);
    other.loops.find((l) => l.id === d.loop.id).config.maxIterations = 12;
    s.text = encodeProjectStore(other); s.hash = "h-edited";
  } });
  const load2 = await loadLoops(again.fs);
  const core2 = stubCore(again.state);
  await assert.rejects(acceptImprovement({ fs: again.fs, core: core2, load: load2, ...d.base }, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 7), kind: "proposal" }, "project"), /out of date/);
  assert.equal(again.state.writes.length, 0);
  assert.equal(core2.calls.length, 0);
});

test("a second conflict is not retried again", async () => {
  const d = await deps();
  const { fs, state } = stubFs(encodeProjectStore(d.store), { conflicts: 2 });
  const load = await loadLoops(fs);
  await assert.rejects(acceptImprovement({ fs, core: stubCore(state), load, ...d.base }, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 7), kind: "proposal" }, "project"), /conflict/);
});

test("a failed decide after the save keeps the saved store and reports a notice", async () => {
  const d = await deps();
  const core = stubCore(d.state, true);
  const out = await acceptImprovement({ fs: d.fs, core, load: d.load, ...d.base }, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 7), kind: "proposal" }, "project");
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
  assert.deepEqual(d.core.calls[0].body, { projectRoot: "/p", action: "adopt", id: "5", loopId: d.loop.id });
});

test("revert restores the before-value and decides revert", async () => {
  const d = await deps();
  const run = { fs: d.fs, core: d.core, load: d.load, ...d.base };
  const change = maxIter(d.loop, 7);
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
  await assert.rejects(acceptImprovement(run, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 7), kind: "proposal" }, "project"), /Finish or stop the run first/);
  await assert.rejects(revertImprovement(run, { id: "1", loopId: d.loop.id, change: maxIter(d.loop, 7) }), /Finish or stop the run first/);
  assert.equal(d.state.events.length, 0);
});

test("reviewStatusLine shows a failed review with its reason", () => {
  assert.match(reviewStatusLine({ failed: "the reply was not valid JSON" }), /^Review failed: the reply was not valid JSON/);
});
