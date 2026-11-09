import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  activeClaims, decodeClaimable, finishResult, finishStateFor, issueRowsFor, noteRunFinished, pollOnce, resetBusRunnerForTests,
} from "../native/bus-runner.ts";

const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
const command = (id, over = {}) => ({ id, kind: "issues.implement", projectRoot: "/p", args: { projectId: "p-1", issueIds: [`i-${id}`], ship: false, ...over } });

/** A fake core: records every request; answers claimable and claim from the world. */
function world(over = {}) {
  const calls = [];
  const w = {
    nowMs: NOW,
    active: "/p",
    liveRuns: [],
    cap: 2,
    claimable: [],
    claimStatus: 200,
    sendResult: (ids) => ({ runIds: ids.map((id) => `run-${id}`), missing: [] }),
    notices: [],
    calls,
    deps: {
      requestRaw: async (path, opts = {}) => {
        calls.push([path, opts.method ?? "GET", opts.body]);
        if (path === "/bus/claimable") return { status: 200, body: { items: w.claimable } };
        if (path.endsWith("/claim")) {
          if (w.claimStatus !== 200) return { status: w.claimStatus, body: { error: { code: "LEASE_HELD" } } };
          const id = path.split("/")[3];
          w.claimable = w.claimable.filter((c) => c.id !== id); // the real core lists queued rows only
          return { status: 200, body: { claimToken: `tok-${id}`, leaseExpiresAt: "2026-11-09T10:01:30Z" } };
        }
        return { status: 200, body: {} };
      },
      activeProject: () => w.active,
      live: () => w.liveRuns,
      concurrency: () => w.cap,
      sendItems: async (root, ids) => { w.sent = [...(w.sent ?? []), [root, ids]]; return w.sendResult(ids); },
      now: () => w.nowMs,
      notice: (m) => w.notices.push(m),
      ...over,
    },
  };
  return w;
}
const posts = (w, suffix) => w.calls.filter(([p, m]) => m === "POST" && p.endsWith(suffix)).map(([, , b]) => b);

beforeEach(() => resetBusRunnerForTests());

test("claims up to the free run slots of the open project only, one claim per command", async () => {
  const w = world();
  w.claimable = [command("c1"), command("c2"), command("c3", { projectRoot: "/other" })];
  const out = await pollOnce(w.deps);
  assert.equal(out.claimed, 2);
  assert.deepEqual(w.sent, [["/p", ["i-c1"]], ["/p", ["i-c2"]]]);
  assert.deepEqual(activeClaims().map((c) => [c.commandId, c.runIds]), [["c1", ["run-i-c1"]], ["c2", ["run-i-c2"]]]);
  assert.equal(w.calls.some(([p]) => p === "/kb/loop/ship"), false, "a claimed command never ships");
});

test("a full project claims nothing; another project's command is skipped", async () => {
  const w = world();
  w.liveRuns = [{ runId: "x", projectRoot: "/p", log: [] }, { runId: "y", projectRoot: "/p", log: [] }];
  w.claimable = [command("c1")];
  assert.equal((await pollOnce(w.deps)).claimed, 0);
  w.liveRuns = [];
  w.active = null;
  assert.equal((await pollOnce(w.deps)).claimed, 0);
});

test("progress reports the last stage and doubles as the heartbeat", async () => {
  const w = world();
  w.claimable = [command("c1")];
  await pollOnce(w.deps);
  assert.equal(posts(w, "/events").length, 0, "nothing to report before a stage runs");
  w.liveRuns = [{ runId: "run-i-c1", projectRoot: "/p", log: ["▶ Factory (full)", "$ Implement", "wrote tests", ""] }];
  w.nowMs += 31_000;
  const out = await pollOnce(w.deps);
  assert.equal(out.progressed, 1);
  assert.deepEqual(posts(w, "/events").at(-1), { claimToken: "tok-c1", type: "progress", payload: { step: "stage: Implement" } });
  // The same stage and a fresh heartbeat: no second event.
  const again = await pollOnce({ ...w.deps, now: () => w.nowMs + 5_000 });
  assert.equal(again.progressed, 0);
});

test("a finished run ends the command: succeeded means ready to ship and never shipped", async () => {
  const w = world();
  w.claimable = [command("c1", { ship: true })];
  await pollOnce(w.deps);
  noteRunFinished("run-i-c1", "success");
  const out = await pollOnce(w.deps);
  assert.equal(out.finished, 1);
  const fin = posts(w, "/finish").at(-1);
  assert.equal(fin.state, "succeeded");
  assert.deepEqual(fin.result, { readyToShip: true, shipped: false });
  assert.equal(w.calls.some(([p]) => p === "/kb/loop/ship"), false, "ship: true from the phone never ships");
  assert.deepEqual(activeClaims(), []);
});

test("a cancelled run is an interruption; a failed run is a failure", async () => {
  const w = world();
  w.claimable = [command("c1")];
  await pollOnce(w.deps);
  noteRunFinished("run-i-c1", "aborted", "run cancelled");
  await pollOnce(w.deps);
  assert.equal(posts(w, "/finish").at(-1).state, "interrupted");

  resetBusRunnerForTests();
  const w2 = world();
  w2.claimable = [command("c2")];
  await pollOnce(w2.deps);
  noteRunFinished("run-i-c2", "failed", "Verify failed");
  await pollOnce(w2.deps);
  const fin = posts(w2, "/finish").at(-1);
  assert.equal(fin.state, "failed");
  assert.equal(fin.result.readyToShip, false);
  assert.match(fin.result.summary, /Verify failed/);
});

test("a command whose issues cannot be found fails with a notice instead of holding the lease", async () => {
  const w = world();
  w.sendResult = () => ({ runIds: [], missing: ["i-c1"] });
  w.claimable = [command("c1")];
  await pollOnce(w.deps);
  const fin = posts(w, "/finish").at(-1);
  assert.equal(fin.state, "failed");
  assert.match(fin.result.summary, /not found/);
  assert.match(w.notices.at(-1), /not found/);
  assert.deepEqual(activeClaims(), []);
});

test("a claim refused by the core leaves a notice and starts nothing", async () => {
  const w = world();
  w.claimable = [command("c1")];
  w.claimStatus = 409;
  await pollOnce(w.deps);
  assert.deepEqual(activeClaims(), []);
  assert.match(w.notices.at(-1), /could not be claimed/);
  assert.equal(w.sent, undefined);
});

test("claimable rows and issue rows are decoded defensively", () => {
  const rows = decodeClaimable({ items: [
    { id: "c1", kind: "issues.implement", projectRoot: "/p", args: { projectId: "p", issueIds: ["a", 2], ship: true } },
    { id: "c2", kind: "issues.implement", args: {} },
    { id: 3 }, "junk", { id: "c3", kind: "issues.implement" },
  ] });
  assert.deepEqual(rows, [
    { id: "c1", kind: "issues.implement", projectRoot: "/p", args: { projectId: "p", issueIds: ["a"], ship: true } },
    { id: "c2", kind: "issues.implement", projectRoot: null, args: { projectId: undefined, issueIds: [], ship: false } },
  ]);
  assert.deepEqual(decodeClaimable(null), []);
  const { rows: issues, missing } = issueRowsFor({ issues: [
    { id: "a", title: "A", provider: "github", repo: "o/r", number: 1, body: "", url: "" },
    { id: "b", title: "A PR", isPR: true },
    { id: "c", title: "  " },
  ] }, ["a", "b", "c", "d"]);
  assert.deepEqual(issues.map((r) => r.id), ["a"]);
  assert.deepEqual(missing, ["b", "c", "d"]);
});

test("the terminal state and result mapping", () => {
  assert.equal(finishStateFor(["success", "success"]), "succeeded");
  assert.equal(finishStateFor(["success", "failed"]), "failed");
  assert.equal(finishStateFor(["success", "aborted"]), "interrupted");
  assert.deepEqual(finishResult("succeeded"), { readyToShip: true, shipped: false });
  assert.equal(finishResult("failed", "boom").shipped, false);
});
