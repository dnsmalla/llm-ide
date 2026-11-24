// The Self-Heal host adapter, shared by Settings (Try to fix) and the daily automatic run: same host commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { createSelfHealHost } = await load("self-heal-host.ts");
const { AGENT_TIMEOUT_MS } = await load("../settings/self-heal-run.ts");

test("createSelfHealHost calls the same host commands Settings used", async () => {
  const calls = [];
  const raw = [];
  const sh = createSelfHealHost({
    invoke: async (cmd, args) => { calls.push([cmd, args]); return cmd === "self_heal_source" ? "/src/llm-ide" : null; },
    core: { requestRaw: async (path, opts) => { raw.push([path, opts]); return { status: 200, body: { ran: true } }; } },
  });
  assert.equal(await sh.source(), "/src/llm-ide");
  await sh.remove("r");
  await assert.rejects(sh.prepare("r", "b"), /cannot read/);
  const body = { message: "m", repoRoot: "/w", timeoutMs: 1 };
  assert.deepEqual(await sh.agentRun(body), { status: 200, body: { ran: true } });
  assert.deepEqual(calls, [["self_heal_source", undefined], ["self_heal_remove", { runId: "r" }], ["self_heal_prepare", { runId: "r", batch: "b" }]]);
  assert.deepEqual(raw, [["/kb/loop/agent-run", { method: "POST", body, timeoutMs: AGENT_TIMEOUT_MS + 60_000 }]]);
});
