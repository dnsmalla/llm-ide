import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentHistoryModel, CLEAR_CONFIRM_WORD, clearConfirmed, compactSuccess, formatBytes, healthLines, scopeSentence, whenText } from "../agent-history-model.ts";
import { RoutingModel, TIERS, draftFromLoaded, dropReasonText, isDirty, tierStatusText, validateDraft } from "../routing-model.ts";
import { decodeCompactResult, decodeRoutingTiers, type RoutingTiers } from "../decoders.ts";
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

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), clear: () => data.clear(), key: () => null, get length() { return data.size; } } as Storage;
}

const tiersBody = () => fixture("providers-usage/get-kb-routing-tiers-200.json").response;

test("routing: draft starts from the loaded table; saving sends the WHOLE table and reports dropped entries", async () => {
  const client = fakeClient({
    "GET /kb/routing-tiers": () => ({ status: 200, body: tiersBody() }),
    "POST /kb/routing-tiers": () => reply("providers-usage/post-kb-routing-tiers-200-dropped.json"),
  });
  const m = new RoutingModel(client);
  await m.load();
  // The fixture saves no tier for some roles, so Standard is preselected for them and Save is offered.
  assert.equal(isDirty(m.getState().loaded, m.getState().draft), true);
  m.setTier("cheap", { provider: "deepseek", model: "deepseek-reasoner" });
  assert.equal(isDirty(m.getState().loaded, m.getState().draft), true);
  const r = await m.save();
  assert.equal(r!.dropped.length, 2);
  const sent = client.calls.find((c) => c.method === "POST")!.body as { tiers: Record<string, unknown>; features: Record<string, string> };
  assert.deepEqual(Object.keys(sent.tiers).sort(), ["cheap", "standard", "strong"]);
  assert.equal(sent.features.subagents, "strong");
  assert.match(m.getState().notice!, /ignored 2 entries: tiers\.image \(that tier is not used by the server\); features\.chatPlanning/);
});

test("routing: a focus refresh keeps unsaved edits; a plain load and a clean draft take the server's table", async () => {
  const client = fakeClient({ "GET /kb/routing-tiers": () => ({ status: 200, body: tiersBody() }) });
  const m = new RoutingModel(client);
  await m.load();
  const clean = JSON.stringify(m.getState().draft);
  await m.load(true);
  assert.equal(JSON.stringify(m.getState().draft), clean, "a clean draft follows the server");
  m.setTier("strong", { provider: "edited-provider", model: "edited-model" });
  assert.equal(isDirty(m.getState().loaded, m.getState().draft), true);
  await m.load(true);
  assert.deepEqual(m.getState().draft!.tiers.strong, { provider: "edited-provider", model: "edited-model" }, "the edit survives a focus refresh");
  assert.equal(isDirty(m.getState().loaded, m.getState().draft), true, "Save is still offered");
  await m.load();
  assert.equal(JSON.stringify(m.getState().draft), clean, "an explicit load replaces the draft");
});

test("routing: a focus refresh with only the Standard preselection (no real edit) still picks up a tier changed elsewhere", async () => {
  let tiers = tiersBody();
  const client = fakeClient({ "GET /kb/routing-tiers": () => ({ status: 200, body: tiers }) });
  const m = new RoutingModel(client);
  await m.load();
  // The fixture leaves autoTasks unset, so Standard is preselected for it and the draft is "dirty" with no real edit.
  assert.equal(isDirty(m.getState().loaded, m.getState().draft), true);
  // Another window saves a different Cheap provider while this one is still open.
  const current = tiersBody() as RoutingTiers;
  tiers = { ...current, tiers: { ...current.tiers, cheap: { provider: "deepseek", model: "deepseek-coder" } } };
  await m.load(true);
  assert.deepEqual(m.getState().draft!.tiers.cheap, { provider: "deepseek", model: "deepseek-coder" }, "preselection alone must not freeze the draft against a focus refresh");
});

test("routing: after Revert, a focus refresh adopts a newer table and never re-adds a role the user set to Default", async () => {
  let tiers = tiersBody();
  const client = fakeClient({ "GET /kb/routing-tiers": () => ({ status: 200, body: tiers }), "POST /kb/routing-tiers": () => ({ status: 200, body: { success: true, dropped: [] } }) });
  const m = new RoutingModel(client, memoryStorage());
  await m.load();
  assert.equal(m.getState().draft!.features.autoTasks, "standard", "preselected on first load");
  m.setRole("autoTasks", null);
  await m.save();
  m.setTier("cheap", { provider: "edited", model: "edited" });
  m.revert();
  assert.deepEqual(m.getState().draft, draftFromLoaded(m.getState().loaded!, new Set(["autoTasks"])), "Revert reads as no edits");
  assert.equal(m.getState().draft!.features.autoTasks, undefined, "the saved Default stays");
  // Another window saves a different Cheap provider; the focus refresh must pick it up instead of freezing the old draft.
  const current = tiersBody() as RoutingTiers;
  tiers = { ...current, tiers: { ...current.tiers, cheap: { provider: "deepseek", model: "deepseek-coder" } } };
  await m.load(true);
  assert.deepEqual(m.getState().draft!.tiers.cheap, { provider: "deepseek", model: "deepseek-coder" });
  assert.equal(m.getState().draft!.features.autoTasks, undefined, "never silently re-added");
});

test("routing: an explicit Default survives Save + reload, a later Save and a restart; untouched roles stay preselected", async () => {
  const store = memoryStorage();
  const client = fakeClient({ "GET /kb/routing-tiers": () => ({ status: 200, body: tiersBody() }), "POST /kb/routing-tiers": () => ({ status: 200, body: { success: true, dropped: [] } }) });
  const m = new RoutingModel(client, store);
  await m.load();
  assert.equal(m.getState().draft!.features.internal, "standard");
  m.setRole("autoTasks", null);
  await m.save();
  const posts = () => client.calls.filter((c) => c.method === "POST").map((c) => (c.body as { features: Record<string, string> }).features);
  assert.equal("autoTasks" in posts()[0]!, false);
  assert.equal(m.getState().draft!.features.autoTasks, undefined, "not preselected again after the reload");
  assert.equal(m.getState().draft!.features.internal, "standard", "untouched roles are still preselected");
  m.setTier("cheap", { provider: "deepseek", model: "deepseek-coder" });
  await m.save();
  assert.equal("autoTasks" in posts()[1]!, false, "a later unrelated Save does not write the role");
  const restarted = new RoutingModel(client, store);
  await restarted.load();
  assert.equal(restarted.getState().draft!.features.autoTasks, undefined, "survives an app restart (same webview storage)");
  restarted.setRole("autoTasks", "standard");
  await restarted.save();
  assert.equal(posts()[2]!.autoTasks, "standard", "choosing Standard again clears the mark");
});

test("routing: Default then Revert preselects the role again and stores nothing; Default then Save persists it", async () => {
  const store = memoryStorage();
  const client = fakeClient({ "GET /kb/routing-tiers": () => ({ status: 200, body: tiersBody() }), "POST /kb/routing-tiers": () => ({ status: 200, body: { success: true, dropped: [] } }) });
  const m = new RoutingModel(client, store);
  await m.load();
  m.setRole("autoTasks", null);
  m.revert();
  assert.equal(m.getState().draft!.features.autoTasks, "standard", "Revert undoes the unsaved Default");
  assert.equal(store.getItem("llmide.routing.declinedPreselect"), null, "nothing stored");
  await m.load(true);
  assert.equal(m.getState().draft!.features.autoTasks, "standard");
  m.setRole("autoTasks", null);
  await m.save();
  assert.deepEqual(JSON.parse(store.getItem("llmide.routing.declinedPreselect")!), ["autoTasks"]);
});

test("routing: Default for the last preselected role leaves the table unchanged, so the unsaved choice itself keeps Save on", async () => {
  const store = memoryStorage();
  const client = fakeClient({ "GET /kb/routing-tiers": () => ({ status: 200, body: tiersBody() }), "POST /kb/routing-tiers": () => ({ status: 200, body: { success: true, dropped: [] } }) });
  const m = new RoutingModel(client, store);
  await m.load();
  assert.equal(m.getState().pendingDecision, false);
  m.setRole("autoTasks", null);
  const s = m.getState();
  assert.equal(isDirty(s.loaded, s.draft), false, "the table equals what is saved");
  assert.equal(s.pendingDecision, true, "the choice is not saved yet");
  await m.save();
  assert.equal(m.getState().pendingDecision, false);
  assert.deepEqual(JSON.parse(store.getItem("llmide.routing.declinedPreselect")!), ["autoTasks"]);
  const restarted = new RoutingModel(client, store);
  await restarted.load();
  assert.equal(restarted.getState().draft!.features.autoTasks, undefined, "still Default after a restart");
  restarted.setRole("autoTasks", "standard");
  assert.equal(restarted.getState().pendingDecision, true, "taking the Default back is an unsaved choice too");
  restarted.revert();
  assert.equal(restarted.getState().pendingDecision, false, "Revert drops it");
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
  assert.deepEqual(m.getState().draft, draftFromLoaded(m.getState().loaded!));
  m.setRole("loop", "ghost");
  assert.match(validateDraft(m.getState().draft!)!, /which is not set/);
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

test("history health: the store's raw, rolled and dropped counts and a reset after damage are said in plain words (Mac parity)", async () => {
  const m = new AgentHistoryModel(fakeClient(baseRoutes()));
  await m.load();
  const report = m.getState().report!;
  assert.deepEqual(healthLines(report.agentHistory, report.agentStoreHealth), [
    { text: "Raw rows from 2026-10-20: 5. Rolled-up days: 3, oldest 2026-09-01.", warn: false },
  ]);
  assert.equal(report.agentStoreHealth, "ok");
  const damaged = healthLines({ rawFromDay: null, rawRows: 0, rolledDays: 0, oldestDay: null, quarantinedAt: "2026-10-30T10:00:00Z", droppedRows: 2 }, "ok");
  assert.equal(damaged[0]!.text, "2 rows were dropped by the write queue since the store was created.");
  assert.equal(damaged[1]!.warn, true);
  assert.match(damaged[1]!.text, /reset after damage on /);
  assert.deepEqual(healthLines(null, "down"), [{ text: "The agent history store is down. Restart the backend to reopen it.", warn: true }]);
  assert.deepEqual(healthLines(null, "ok"), []);
  assert.equal(whenText("not a date"), "not a date");
});

test("clear: the sentence says runs in progress are kept (the core deletes only non-running runs)", () => {
  assert.match(scopeSentence("raw", "all"), /Runs still in progress are kept\.$/);
});

test("the provider upgrade lines", async () => {
  const { MIGRATION_TEXT } = await import("../routing-model.ts");
  assert.equal(MIGRATION_TEXT.created(["DeepSeek"]), "Your existing DeepSeek key was added as catalog connections. The old keys are kept.");
  assert.equal(MIGRATION_TEXT.reviewHere("LAN", "http to a public host"), "LAN needs review: it was not carried over (http to a public host). Connect it below once the address is fixed.");
  for (const s of [MIGRATION_TEXT.routerNeeded, MIGRATION_TEXT.routerPending, MIGRATION_TEXT.tools]) assert.ok(typeof s === "string" && s.length > 0);
});
