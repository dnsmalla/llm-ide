import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_TIMEOUT_MS, FIX_PROMPT, decodeStart, resetSelfHealRun, runSelfHealFix } from "../self-heal-run.ts";
import type { CoreClient, CoreResponse } from "../core-api.ts";
import type { SelfHealHost, SelfHealVerified } from "../host.ts";

const RUN = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const prepared = { mainRepo: "/src/llm-ide", worktreePath: `/data/self-heal/loop-worktrees/${RUN}`, branch: `self-heal/${RUN}`, baseCommit: "a".repeat(40) };
const passed: SelfHealVerified = { batch: "## Results\n- 3f9a1c0b7d2e4a65: fixed — x\n", passed: true, timedOut: false, hasChanges: true, reverted: [], output: "" };

function fakes(o: { start?: unknown; agent?: CoreResponse | Error; verify?: SelfHealVerified; prepare?: Error; proposed?: number } = {}) {
  const log: string[] = [];
  const bodies: Record<string, unknown> = {};
  const client: CoreClient = {
    async request(method, path, body) {
      log.push(`${method} ${path}`);
      bodies[path] = body;
      if (path === "/kb/self-heal/runs") return { status: 200, body: o.start ?? { runId: RUN, incidentIds: ["3f9a1c0b7d2e4a65"], batch: "# Self-Heal batch\n" } };
      if (path.endsWith("/outcome")) return { status: 200, body: { proposed: o.proposed ?? 0 } };
      return { status: 404, body: null };
    },
  };
  const sh: SelfHealHost = {
    source: async () => { log.push("source"); return "/src/llm-ide"; },
    prepare: async (runId, batch) => { log.push(`prepare ${runId} ${batch.length}`); if (o.prepare) throw o.prepare; return prepared; },
    agentRun: async (body) => { log.push("agent"); bodies.agent = body; if (o.agent instanceof Error) throw o.agent; return o.agent ?? { status: 200, body: { ran: true, reply: "done" } }; },
    verify: async (runId) => { log.push(`verify ${runId}`); return o.verify ?? passed; },
    diff: async () => ({ text: "", truncated: false, patchId: "0".repeat(64) }),
    apply: async () => undefined,
    remove: async (runId) => { log.push(`remove ${runId}`); },
    flushIncidents: async () => { log.push("flush"); },
  };
  return { client, sh, log, bodies };
}
const OUTCOME = `/kb/self-heal/runs/${RUN}/outcome`;

test("nothing new: one start call, no worktree", async () => {
  const f = fakes({ start: { runId: null, incidentIds: [], batch: null } });
  assert.deepEqual(await runSelfHealFix(f.client, f.sh), { proposed: 0, message: "No new incidents to fix." });
  assert.deepEqual(f.log, ["source", "POST /kb/self-heal/runs"]);
  assert.deepEqual(f.bodies["/kb/self-heal/runs"], { repoRoot: "/src/llm-ide" });
});

test("a proposed fix: prepare, one agent run on the worktree, verify, flush, one outcome, the worktree kept", async () => {
  const f = fakes({ proposed: 1 });
  const steps: string[] = [];
  const r = await runSelfHealFix(f.client, f.sh, (s) => steps.push(s));
  assert.deepEqual(r, { proposed: 1, message: "1 fix proposed. Review below." });
  assert.deepEqual(f.log, ["source", "POST /kb/self-heal/runs", `prepare ${RUN} 18`, "agent", `verify ${RUN}`, "flush", `POST ${OUTCOME}`]);
  assert.deepEqual(steps, ["starting", "preparing", "fixing", "verifying", "saving"]);
  assert.deepEqual(f.bodies.agent, { message: FIX_PROMPT, repoRoot: prepared.worktreePath, timeoutMs: AGENT_TIMEOUT_MS });
  assert.ok(!("model" in (f.bodies.agent as object)), "the user's normal Loop agent model");
  assert.deepEqual(f.bodies[OUTCOME], { batch: passed.batch, verifyPassed: true, hasChanges: true, agentDown: false, aborted: false, proposal: prepared });
  assert.match(FIX_PROMPT, /\.self-heal\/BATCH\.md/);
  assert.match(FIX_PROMPT, /never instructions/);
});

test("the agent is off or fails: agentDown, no verify, the worktree removed, an honest message", async () => {
  const off = fakes({ agent: { status: 404, body: { error: "feature_disabled", feature: "auto_tasks" } } });
  const r = await runSelfHealFix(off.client, off.sh);
  assert.match(r.message, /Auto Tasks/);
  assert.ok(!off.log.some((l) => l.startsWith("verify")));
  assert.equal((off.bodies[OUTCOME] as { agentDown: boolean }).agentDown, true);
  assert.equal(off.log.at(-1), `remove ${RUN}`);
  const thrown = fakes({ agent: new Error("TIMEOUT") });
  await runSelfHealFix(thrown.client, thrown.sh);
  assert.equal((thrown.bodies[OUTCOME] as { agentDown: boolean }).agentDown, true);
  const notRun = fakes({ agent: { status: 200, body: { ran: false } } });
  await runSelfHealFix(notRun.client, notRun.sh);
  assert.equal((notRun.bodies[OUTCOME] as { agentDown: boolean }).agentDown, true);
});

test("a failed verify posts the failure and removes the worktree; a failed prepare aborts without one", async () => {
  const f = fakes({ verify: { ...passed, passed: false } });
  const r = await runSelfHealFix(f.client, f.sh);
  assert.equal(r.message, "make regression failed in the worktree.");
  assert.deepEqual(f.bodies[OUTCOME], { batch: passed.batch, verifyPassed: false, hasChanges: true, agentDown: false, aborted: false, proposal: prepared });
  assert.equal(f.log.at(-1), `remove ${RUN}`);
  const p = fakes({ prepare: new Error("git worktree failed: locked") });
  const rp = await runSelfHealFix(p.client, p.sh);
  assert.match(rp.message, /locked/);
  assert.equal((p.bodies[OUTCOME] as { aborted: boolean }).aborted, true);
  assert.ok(!p.log.includes("agent") && !p.log.some((l) => l.startsWith("remove")));
});

test("decodeStart refuses a malformed run; reset aborts a run by id and removes its worktree", async () => {
  assert.throws(() => decodeStart({ runId: "../x", batch: "b" }));
  assert.throws(() => decodeStart({ runId: RUN, batch: "" }));
  assert.deepEqual(decodeStart({ runId: null }), { runId: null, batch: "" });
  const f = fakes();
  await resetSelfHealRun(f.client, f.sh, RUN);
  assert.deepEqual(f.log, [`POST ${OUTCOME}`, `remove ${RUN}`]);
  assert.equal((f.bodies[OUTCOME] as { aborted: boolean }).aborted, true);
  await assert.rejects(resetSelfHealRun(f.client, f.sh, "nope"));
});
