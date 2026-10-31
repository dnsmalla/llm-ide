import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentHistoryModel, CLEAR_CONFIRM_WORD, clearConfirmed, compactSuccess, formatBytes, scopeSentence } from "../agent-history-model.ts";
import { RoutingModel, TIERS, dropReasonText, isDirty, tierStatusText, validateDraft } from "../routing-model.ts";
import { decodeCompactResult, decodeRoutingTiers } from "../decoders.ts";
import { deferred, fakeClient, fixture, reply } from "./helpers.ts";

const baseRoutes = () => ({
  "GET /kb/storage": () => reply("agent-history/get-kb-storage-200.json"),
  "GET /kb/agent-history/settings": () => reply("agent-history/get-kb-agent-history-settings-200.json"),
});

test("history: load fills the report and the retention draft", async () => {
  const m = new AgentHistoryModel(fakeClient(baseRoutes()));
  await m.load();
  assert.equal(m.getState().report!.groups.length, 5);
  assert.equal(m.getState().retentionDraft, 30);
  assert.deepEqual(m.retentionRange, { min: 7, max: 365 });
});

test("history: Clear = dry run, then the real clear with the signed preview id; nothing is sent before confirm", async () => {
  const client = fakeClient({
    ...baseRoutes(),
    "POST /kb/agent-history/clear": (b) => ((b as { dryRun: boolean }).dryRun ? reply("agent-history/post-kb-agent-history-clear-200-dry-run.json") : reply("agent-history/post-kb-agent-history-clear-200-deleted.json")),
  });
  const m = new AgentHistoryModel(client);
  await m.load();
  await m.beginClear("raw", "older30");
  const dry = client.calls.filter((c) => c.path.endsWith("/clear"));
  assert.equal(dry.length, 1);
  assert.deepEqual(dry[0]!.body, { scope: "raw", beforeDays: 30, dryRun: true });
  const phase = m.getState().clear;
  assert.equal(phase.kind, "confirming");
  await m.confirmClear();
  const real = client.calls.filter((c) => c.path.endsWith("/clear"))[1]!;
  assert.equal((real.body as { dryRun: boolean }).dryRun, false);
  assert.match((real.body as { previewId: string }).previewId, /^eyJ/);
  assert.equal((real.body as { beforeDays: number }).beforeDays, 30);
  const done = m.getState().clear;
  assert.equal(done.kind, "cleared");
});

test("history: a stale preview is counted again, never deleted on", async () => {
  let real = 0;
  const client = fakeClient({
    ...baseRoutes(),
    "POST /kb/agent-history/clear": (b) => {
      if ((b as { dryRun: boolean }).dryRun) return reply("agent-history/post-kb-agent-history-clear-200-dry-run.json");
      real++;
      return reply("agent-history/post-kb-agent-history-clear-409-preview-stale.json");
    },
  });
  const m = new AgentHistoryModel(client);
  await m.load();
  await m.beginClear("raw");
  await m.confirmClear();
  assert.equal(real, 1);
  assert.equal(m.getState().clear.kind, "confirming", "back at a fresh preview");
  assert.match(m.getState().clearNotice!, /history changed after the preview/);
});

test("history: invalid preview and failures are plain sentences", async () => {
  const client = fakeClient({
    ...baseRoutes(),
    "POST /kb/agent-history/clear": (b) => ((b as { dryRun: boolean }).dryRun ? reply("agent-history/post-kb-agent-history-clear-200-dry-run.json") : reply("agent-history/post-kb-agent-history-clear-400-preview-invalid.json")),
  });
  const m = new AgentHistoryModel(client);
  await m.beginClear("all");
  await m.confirmClear();
  assert.match(m.getState().clearNotice!, /no longer matches/);
  const failing = new AgentHistoryModel(fakeClient({ "POST /kb/agent-history/clear": () => ({ status: 503, body: { error: { code: "AGENT_STORE_UNAVAILABLE", message: "x" } } }) }));
  await failing.beginClear("raw");
  const p = failing.getState().clear;
  assert.equal(p.kind, "failed");
  assert.match((p as { message: string }).message, /Restart the backend/);
});

test("history: changing the age drops the old preview at once and re-counts", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  let n = 0;
  const client = fakeClient({
    ...baseRoutes(),
    "POST /kb/agent-history/clear": () => (n++ === 0 ? reply("agent-history/post-kb-agent-history-clear-200-dry-run.json") : (gate.promise as never)),
  });
  const m = new AgentHistoryModel(client);
  await m.beginClear("raw", "all");
  const pending = m.setClearAge("older7");
  assert.equal(m.getState().clear.kind, "previewing");
  await m.confirmClear(); // ignored: no confirming preview
  assert.equal(client.calls.filter((c) => c.path.endsWith("/clear")).length, 2);
  gate.resolve(reply("agent-history/post-kb-agent-history-clear-200-dry-run.json"));
  await pending;
  assert.equal(m.getState().clear.kind, "confirming");
  assert.deepEqual(client.calls.filter((c) => c.path.endsWith("/clear"))[1]!.body, { scope: "raw", beforeDays: 7, dryRun: true });
});

test("history: cancelling a preview in flight never reopens the sheet; clearing cannot be dismissed", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const m = new AgentHistoryModel(fakeClient({ "POST /kb/agent-history/clear": () => gate.promise as never }));
  const p = m.beginClear("raw");
  m.cancelClear();
  gate.resolve(reply("agent-history/post-kb-agent-history-clear-200-dry-run.json"));
  await p;
  assert.equal(m.getState().clear.kind, "idle");
  const slow = deferred<{ status: number; body: unknown }>();
  const m2 = new AgentHistoryModel(fakeClient({
    "POST /kb/agent-history/clear": (b) => ((b as { dryRun: boolean }).dryRun ? reply("agent-history/post-kb-agent-history-clear-200-dry-run.json") : (slow.promise as never)),
  }));
  await m2.beginClear("raw");
  const confirm = m2.confirmClear();
  assert.equal(m2.canDismissClear, false);
  m2.cancelClear();
  assert.equal(m2.getState().clear.kind, "clearing");
  slow.resolve(reply("agent-history/post-kb-agent-history-clear-200-deleted.json"));
  await confirm;
  assert.equal(m2.getState().clear.kind, "cleared");
});

test("history: compact success and busy; retention save reports a clamped value", async () => {
  const ok = new AgentHistoryModel(fakeClient({ ...baseRoutes(), "POST /kb/agent-history/compact": () => reply("agent-history/post-kb-agent-history-compact-200.json") }));
  await ok.compact();
  assert.match(ok.getState().compactMessage!.text, /Compacted \(incremental\): freed 120 pages, 512 KB to 448 KB/);
  const busy = new AgentHistoryModel(fakeClient({ "POST /kb/agent-history/compact": () => reply("agent-history/post-kb-agent-history-compact-409-busy.json") }));
  await busy.compact();
  assert.equal(busy.getState().compactMessage!.isError, true);
  assert.match(busy.getState().compactMessage!.text, /in progress/);
  const ret = new AgentHistoryModel(fakeClient({ ...baseRoutes(), "PUT /kb/agent-history/settings": () => reply("agent-history/put-kb-agent-history-settings-200.json") }));
  await ret.load();
  ret.setRetentionDraft(1000);
  assert.equal(ret.retentionChanged, true);
  await ret.saveRetention();
  assert.match(ret.getState().retentionMessage!, /Saved as 365 days; the limit is 7 to 365/);
  const bad = new AgentHistoryModel(fakeClient({ ...baseRoutes(), "PUT /kb/agent-history/settings": () => reply("agent-history/put-kb-agent-history-settings-400.json") }));
  await bad.load();
  bad.setRetentionDraft(31);
  await bad.saveRetention();
  assert.match(bad.getState().retentionMessage!, /did not accept/);
});

test("history words: confirm word, byte format, scope sentence", () => {
  assert.equal(clearConfirmed(` ${CLEAR_CONFIRM_WORD} `), true);
  assert.equal(clearConfirmed("delete"), false);
  assert.equal(formatBytes(524288), "512 KB");
  assert.equal(formatBytes(12), "12 B");
  assert.match(scopeSentence("raw", "older30"), /daily summaries are kept.*older than 30 days/);
  assert.match(scopeSentence("all", "all"), /including the daily summaries/);
  assert.match(compactSuccess(decodeCompactResult(fixture("agent-history/post-kb-agent-history-compact-200.json").response)), /freed 120/);
});

// ---- routing ----

const tiersBody = () => fixture("providers-usage/get-kb-routing-tiers-200.json").response;

test("routing: draft starts from the loaded table; saving sends the WHOLE table and reports dropped entries", async () => {
  const client = fakeClient({
    "GET /kb/routing-tiers": () => ({ status: 200, body: tiersBody() }),
    "POST /kb/routing-tiers": () => reply("providers-usage/post-kb-routing-tiers-200-dropped.json"),
  });
  const m = new RoutingModel(client);
  await m.load();
  assert.equal(isDirty(m.getState().loaded, m.getState().draft), false);
  m.setTier("cheap", { provider: "deepseek", model: "deepseek-reasoner" });
  assert.equal(isDirty(m.getState().loaded, m.getState().draft), true);
  const r = await m.save();
  assert.equal(r!.dropped.length, 2);
  const sent = client.calls.find((c) => c.method === "POST")!.body as { tiers: Record<string, unknown>; features: Record<string, string> };
  assert.deepEqual(Object.keys(sent.tiers).sort(), ["cheap", "standard", "strong"]);
  assert.equal(sent.features.subagents, "strong");
  assert.match(m.getState().notice!, /ignored 2 entries: tiers\.image \(that tier is not used by the server\); features\.chatPlanning/);
});

test("routing: removing a tier resets roles that used it; invalid drafts never reach the network", async () => {
  const client = fakeClient({ "GET /kb/routing-tiers": () => ({ status: 200, body: tiersBody() }), "POST /kb/routing-tiers": () => ({ status: 200, body: { success: true, dropped: [] } }) });
  const m = new RoutingModel(client);
  await m.load();
  m.setTier("strong", null);
  assert.equal(m.getState().draft!.features.subagents, undefined);
  m.setTier("cheap", { provider: "", model: "x" });
  assert.match(validateDraft(m.getState().draft!)!, /Pick a provider and a model for cheap/);
  await m.save();
  assert.equal(client.calls.filter((c) => c.method === "POST").length, 0);
  m.revert();
  assert.equal(isDirty(m.getState().loaded, m.getState().draft), false);
  m.setRole("loop", "ghost");
  assert.match(validateDraft(m.getState().draft!)!, /tier, which is not set/);
});

test("routing: status sentences explain skipped and non-agent tiers", () => {
  const t = decodeRoutingTiers(tiersBody());
  assert.match(tierStatusText(t.status.cheap), /Skipped: no key is stored for it/);
  assert.match(tierStatusText(t.status.standard), /Not on the Claude engine: it cannot run on the Claude engine/);
  assert.match(tierStatusText(t.status.strong), /signed-in Claude CLI/);
  assert.equal(tierStatusText(undefined), "Not checked yet.");
  assert.equal(TIERS.length, 3);
  assert.match(dropReasonText("unknown_feature"), /role/);
});
