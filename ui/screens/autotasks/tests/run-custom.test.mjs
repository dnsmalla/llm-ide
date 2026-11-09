import assert from "node:assert/strict";
import test from "node:test";
import { runCustomTask } from "../native/run-custom.ts";

const base = { id: "custom-1", projectRoot: "/p", name: "Check", prompt: "Review the build", mode: "review", cron: "", enabled: true, createdAt: "x" };

test("custom runner: Implement is refused before any request", async () => {
  let called = 0;
  const r = await runCustomTask({ ...base, mode: "implement" }, {
    request: async () => { called++; return { status: "ok", model: null }; },
    workRoot: async () => "/p", changedPaths: async () => [], revert: async () => {},
  });
  assert.equal(r.ok, false); assert.match(r.error, /Mac app/); assert.equal(called, 0);
});

test("custom runner: Review sends the prompt, reverts agent writes and reports success", async () => {
  const calls = [];
  const reverted = [];
  const r = await runCustomTask(base, {
    request: async (path, init) => {
      calls.push([path, init]);
      if (path.startsWith("/kb/usage/resolve")) return { provider: "anthropic", model: null, status: "ok" };
      return { reply: "looks good", resultSubtype: "success", changedPaths: ["src/a.ts"], createdPaths: [] };
    },
    workRoot: async () => "/p", changedPaths: async () => [], revert: async (paths, created) => { reverted.push([paths, created]); },
  });
  assert.equal(r.ok, true); assert.equal(r.reply, "looks good"); assert.deepEqual(reverted, [[["src/a.ts"], []]]);
  const agent = calls.find(([p]) => p === "/kb/loop/agent-run");
  assert.ok(agent);
  assert.deepEqual(agent[1].body.repoRoot, "/p");
  assert.equal(agent[1].body.message, "Review the build");
  const resolve = calls.find(([p]) => p.startsWith("/kb/usage/resolve"));
  assert.equal(resolve?.[1]?.body, undefined, "GET resolve must not send a body");
});

test("custom runner: a paused model chain does not call the agent", async () => {
  let agent = 0;
  const r = await runCustomTask(base, {
    request: async (path) => path.startsWith("/kb/usage/resolve") ? { provider: "anthropic", model: null, status: "paused", reason: "cap reached" } : (agent++, { reply: "x" }),
    workRoot: async () => "/p", changedPaths: async () => [], revert: async () => {},
  });
  assert.equal(r.ok, false); assert.equal(r.paused, true); assert.equal(agent, 0); assert.match(r.error, /cap reached/);
});

test("custom runner: a failed agent call with a changed tree is reported as not completed", async () => {
  const r = await runCustomTask(base, {
    request: async (path) => {
      if (path.startsWith("/kb/usage/resolve")) return { provider: "anthropic", model: null, status: "ok" };
      throw new Error("timeout");
    },
    workRoot: async () => "/p", changedPaths: async () => ["src/a.ts"], revert: async () => {},
  });
  assert.equal(r.ok, false); assert.match(r.error, /timeout/); assert.deepEqual(r.writes, [], "successfully reverted writes are not reported as left behind");
});


test("custom runner: a failed revert is reported and its writes are left behind", async () => {
  const r = await runCustomTask(base, {
    request: async (path) => {
      if (path.startsWith("/kb/usage/resolve")) return { provider: "anthropic", model: null, status: "ok" };
      throw new Error("timeout");
    },
    workRoot: async () => "/p", changedPaths: (() => { let n = 0; return async () => (n++ === 0 ? [] : ["src/a.ts"]); })(), revert: async () => { throw new Error("disk full"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout/);
  assert.match(r.error, /revert failed/);
  assert.deepEqual(r.writes, ["src/a.ts"]);
});

test("custom runner: the page's abort signal reaches the agent call, and an aborted call is a failed run", async () => {
  const ctrl = new AbortController();
  let agentSignal = null;
  const r = await runCustomTask(base, {
    request: async (path, init) => {
      if (path.startsWith("/kb/usage/resolve")) return { provider: "anthropic", model: null, status: "ok" };
      agentSignal = init?.signal ?? null;
      ctrl.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    },
    workRoot: async () => "/p", changedPaths: async () => [], revert: async () => {},
    signal: ctrl.signal,
  });
  assert.equal(agentSignal, ctrl.signal);
  assert.equal(r.ok, false);
  assert.match(r.error, /aborted/);
});
