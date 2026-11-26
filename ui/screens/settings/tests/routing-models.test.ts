import { test } from "node:test";
import assert from "node:assert/strict";
import { RoutingModel, dropReasonText, modelIdProblem, roleFallbackWarning, roleFallbacks, roleStatusText, roleEmptyOptionLabel, draftFromLoaded, preselectedRoles, visibleRoles, isDirty, validateDraft } from "../routing-model.ts";
import { ModelListsModel, decodeBuiltinModels, pickerView, OTHER_MODEL } from "../routing-models.ts";
import { fakeClient, reply } from "./helpers.ts";

const ANTHROPIC_BODY = {
  models: ["claude-sonnet-5-5", "claude-opus-5-5[1m]"],
  entries: [
    { id: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "", effortLevels: [] },
    { id: "claude-opus-5-5[1m]", displayName: "Opus 5.5 (1M)", description: "", effortLevels: [] },
  ],
  source: "sdk",
};

test("model lists: anthropic loads entries with display names from /kb/providers/models", async () => {
  const client = fakeClient({ "POST /kb/providers/models": () => ({ status: 200, body: ANTHROPIC_BODY }) });
  const m = new ModelListsModel(client, () => null);
  await m.ensure("anthropic");
  const e = m.getState().lists.anthropic!;
  assert.equal(e.status, "ready");
  assert.deepEqual(e.status === "ready" && e.options, [
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { id: "claude-opus-5-5[1m]", name: "Opus 5.5 (1M)" },
  ]);
  assert.deepEqual(client.calls[0]!.body, { provider: "anthropic" });
});

test("model lists: a plain models array without entries still works", async () => {
  const client = fakeClient({ "POST /kb/providers/models": () => ({ status: 200, body: { models: ["a-1", "b-2"] } }) });
  const m = new ModelListsModel(client, () => null);
  await m.ensure("openai");
  const e = m.getState().lists.openai!;
  assert.equal(e.status === "ready" && e.options.length, 2);
  assert.deepEqual(client.calls[0]!.body, { provider: "openai" });
});

test("model lists: a catalog connection lists through /kb/providers/catalog/models with the connection id", async () => {
  const client = fakeClient({ "POST /kb/providers/catalog/models": () => reply("provider-catalog/post-kb-providers-catalog-models-200-live.json") });
  const m = new ModelListsModel(client, (p) => (p === "custom:cat-groq" ? "cat-groq" : null));
  await m.ensure("custom:cat-groq");
  assert.deepEqual(client.calls[0]!.body, { id: "cat-groq", refresh: false });
  const e = m.getState().lists["custom:cat-groq"]!;
  assert.deepEqual(e.status === "ready" && e.options.map((o) => o.id), ["brand-new-model", "llama-3.3-70b-versatile"]);
});

test("model lists: the connection id falls back to the provider id without its custom: prefix", async () => {
  const client = fakeClient({ "POST /kb/providers/catalog/models": () => reply("provider-catalog/post-kb-providers-catalog-models-200-live.json") });
  const m = new ModelListsModel(client, () => null);
  await m.ensure("custom:cat-groq");
  assert.equal((client.calls[0]!.body as { id: string }).id, "cat-groq");
});

test("model lists: an empty list or a failure becomes failed with plain words, and does not throw", async () => {
  const empty = new ModelListsModel(fakeClient({ "POST /kb/providers/models": () => ({ status: 200, body: { models: [], detail: "no API key configured" } }) }), () => null);
  await empty.ensure("openai");
  const e = empty.getState().lists.openai!;
  assert.equal(e.status, "failed");
  assert.match(e.status === "failed" ? e.detail : "", /no API key configured/);
  const down = new ModelListsModel(fakeClient({}), () => null);
  await down.ensure("anthropic");
  assert.equal(down.getState().lists.anthropic!.status, "failed");
});

test("model lists: one request per provider (cached), and a failed provider is asked again", async () => {
  let n = 0;
  const client = fakeClient({ "POST /kb/providers/models": () => (++n === 1 ? { status: 200, body: { models: [] } } : { status: 200, body: ANTHROPIC_BODY }) });
  const m = new ModelListsModel(client, () => null);
  await Promise.all([m.ensure("anthropic"), m.ensure("anthropic")]);
  assert.equal(client.calls.length, 1);
  assert.equal(m.getState().lists.anthropic!.status, "failed");
  await m.ensure("anthropic");
  assert.equal(m.getState().lists.anthropic!.status, "ready");
  await m.ensure("anthropic");
  assert.equal(client.calls.length, 2);
});

test("model lists: dispose aborts in-flight requests and is not permanent (StrictMode effect, cleanup, effect)", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const client = {
    calls: [] as unknown[],
    request: (_m: string, _p: string, _b: unknown, s?: AbortSignal) => {
      signals.push(s);
      if (signals.length === 1) return new Promise<never>(() => {});
      return Promise.resolve({ status: 200, body: ANTHROPIC_BODY });
    },
  };
  const m = new ModelListsModel(client as never, () => null);
  void m.ensure("anthropic");
  assert.equal(m.getState().lists.anthropic!.status, "loading");
  m.dispose();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(m.getState().lists.anthropic, undefined);
  await m.ensure("anthropic");
  assert.equal(signals.length, 2);
  assert.equal(m.getState().lists.anthropic!.status, "ready");
});

test("model lists: an aborted request never overwrites a newer one", async () => {
  const gates: ((v: unknown) => void)[] = [];
  const client = {
    request: (_m: string, _p: string, _b: unknown, s?: AbortSignal) =>
      new Promise((resolve, reject) => {
        gates.push(resolve);
        s?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  const m = new ModelListsModel(client as never, () => null);
  const first = m.ensure("anthropic");
  m.dispose();
  const second = m.ensure("anthropic");
  gates[1]!({ status: 200, body: ANTHROPIC_BODY });
  await Promise.all([first, second]);
  assert.equal(m.getState().lists.anthropic!.status, "ready");
});

test("model lists: providers with no list endpoint are not fetched and say so", async () => {
  const client = fakeClient({});
  const m = new ModelListsModel(client, () => null);
  await m.ensure("custom:ac-1234");
  assert.equal(client.calls.length, 0);
  const e = m.getState().lists["custom:ac-1234"]!;
  assert.equal(e.status, "failed");
  assert.equal(e.status === "failed" && e.retry, false);
  assert.match(e.status === "failed" ? e.detail : "", /no model list/i);
});

test("model lists: a failed list can be retried, an unreachable core is retryable", async () => {
  const m = new ModelListsModel(fakeClient({}), () => null);
  await m.ensure("anthropic");
  const e = m.getState().lists.anthropic!;
  assert.equal(e.status === "failed" && e.retry, true);
});

test("decode: falls back to models when entries yield nothing; hides ids the server would drop", () => {
  const r = decodeBuiltinModels({ entries: [{ nope: 1 }], models: ["good-1", "bad id", "-x"] });
  assert.deepEqual(r.options.map((o) => o.id), ["good-1"]);
  const r2 = decodeBuiltinModels({ entries: [{ id: "has space", displayName: "x" }, { id: "ok-2", displayName: "Okay" }] });
  assert.deepEqual(r2.options, [{ id: "ok-2", name: "Okay" }]);
});

test("model lists: a catalog list skips rows it cannot read instead of failing", async () => {
  const body = { source: "live", models: [{ id: "good", toolsSupported: true }, { nope: 1 }, "x", { id: "bad id" }, { id: "also-good" }] };
  const client = fakeClient({ "POST /kb/providers/catalog/models": () => ({ status: 200, body }) });
  const m = new ModelListsModel(client, () => "cat-x");
  await m.ensure("custom:cat-x");
  const e = m.getState().lists["custom:cat-x"]!;
  assert.deepEqual(e.status === "ready" && e.options.map((o) => o.id), ["good", "also-good"]);
});

test("picker view: loading, select, Other for an unlisted id, forced Other, failed falls back to text", () => {
  const ready = { status: "ready" as const, options: [{ id: "a", name: "A" }] };
  assert.equal(pickerView(undefined, "", false).kind, "loading");
  assert.equal(pickerView({ status: "loading" }, "", false).kind, "loading");
  assert.deepEqual(pickerView(ready, "a", false), { kind: "select", value: "a", options: ready.options, showText: false });
  assert.deepEqual(pickerView(ready, "", false), { kind: "select", value: "", options: ready.options, showText: false });
  assert.deepEqual(pickerView(ready, "zzz", false), { kind: "select", value: OTHER_MODEL, options: ready.options, showText: true });
  assert.equal((pickerView(ready, "a", true) as { showText: boolean }).showText, true);
  assert.deepEqual(pickerView({ status: "failed", detail: "boom", retry: true }, "x", false), { kind: "text", note: "boom", retry: true });
  // typing pins the text box: a typed id that equals a listed id must not close it
  assert.equal((pickerView(ready, "a", true) as { showText: boolean }).showText, true);
});

test("model id check: same charset as the server, no spaces, optional [1m]", () => {
  assert.equal(modelIdProblem("claude-opus-5-5[1m]"), null);
  assert.equal(modelIdProblem("deepseek-reasoner"), null);
  assert.equal(modelIdProblem("meta/llama-3.3:70b"), null);
  assert.match(modelIdProblem("Claude Sonnet")!, /Model id can only contain letters, digits/);
  assert.match(modelIdProblem("-bad")!, /Model id/);
  assert.match(modelIdProblem("a".repeat(129))!, /Model id/);
  assert.equal(modelIdProblem("  claude-x  "), null);
});

test("validateDraft: a bad model id never reaches the network", async () => {
  const client = fakeClient({
    "GET /kb/routing-tiers": () => ({ status: 200, body: { tiers: {}, features: {}, status: {}, featureStatus: {} } }),
    "POST /kb/routing-tiers": () => ({ status: 200, body: { success: true, dropped: [] } }),
  });
  const m = new RoutingModel(client);
  await m.load();
  m.setTier("cheap", { provider: "anthropic", model: "Claude Sonnet" });
  assert.match(validateDraft(m.getState().draft!)!, /Cheap.*Model id can only contain/);
  await m.save();
  assert.equal(client.calls.filter((c) => c.method === "POST").length, 0);
  assert.match(m.getState().error!, /Model id can only contain/);
});

test("drop reasons use plain wording", () => {
  assert.equal(dropReasonText("invalid_provider"), "that provider id is not supported");
  assert.equal(dropReasonText("invalid_model"), "that model id is not valid");
  assert.equal(dropReasonText("invalid_shape"), "the entry was not complete");
  assert.equal(dropReasonText("unknown_tier"), "that tier is not used by the server");
  assert.equal(dropReasonText("whatever"), "the server did not accept it");
});

test("roles on an unset tier: status text and the list used by the save banner", () => {
  const draft = { tiers: {}, features: { subagents: "cheap", loop: "strong" } };
  assert.deepEqual(roleFallbacks(draft), [
    { role: "subagents", label: "Sub-agents", tier: "cheap", tierLabel: "Cheap" },
    { role: "loop", label: "Loop and Factory", tier: "strong", tierLabel: "Strong" },
  ]);
  assert.equal(roleFallbackWarning(draft), "These roles run the default because their tier is not set: Sub-agents (Cheap), Loop and Factory (Strong).");
  assert.equal(roleFallbackWarning({ tiers: {}, features: {} }), null);
  assert.equal(validateDraft({ tiers: {}, features: { subagents: "cheap" } }), "Sub-agents uses Cheap, which is not set. Set Cheap, or change Sub-agents to Default (built-in).");
  assert.equal(roleStatusText("subagents", draft), "Uses Cheap, which is not set; the default runs.");
  assert.equal(roleStatusText("internal", draft), "No tier saved; the built-in default runs.");
  assert.equal(roleStatusText("subagents", { tiers: { cheap: { provider: "anthropic", model: "x" } }, features: { subagents: "cheap" } }), null);
});

test("save banner names the roles that now fall back to the default", async () => {
  const stored = { tiers: {}, features: { subagents: "cheap" }, status: {}, featureStatus: {} };
  const client = fakeClient({
    "GET /kb/routing-tiers": () => ({ status: 200, body: stored }),
    "POST /kb/routing-tiers": () => ({ status: 200, body: { success: true, dropped: [{ entry: "tiers.cheap", reason: "invalid_model" }] } }),
  });
  const m = new RoutingModel(client);
  await m.load();
  m.setTier("cheap", { provider: "anthropic", model: "claude-x" });
  await m.save();
  const s = m.getState();
  assert.match(s.notice!, /tiers\.cheap \(that model id is not valid\)/);
  assert.match(s.notice!, /Sub-agents now uses the default because Cheap is not set/);
  assert.equal(s.noticeKind, "warning");
});

test("validateDraft: a role on an unset tier is named with labels and the way out", () => {
  assert.equal(validateDraft({ tiers: {}, features: { subagents: "cheap" } }), "Sub-agents uses Cheap, which is not set. Set Cheap, or change Sub-agents to Default (built-in).");
});

test("roles: the empty option says Default (built-in), Decision keeps Default", () => {
  for (const role of ["subagents", "internal", "loop", "autoTasks"]) assert.equal(roleEmptyOptionLabel(role), "Default (built-in)");
  assert.equal(roleEmptyOptionLabel("plan"), "Follows Loop and Factory");
  assert.equal(roleEmptyOptionLabel("decisions"), "Default");
});

test("roles: unset Sub-agents/Internal say no tier is saved; Decision says it uses the default model", () => {
  const draft = { tiers: {}, features: {} };
  assert.equal(roleStatusText("subagents", draft), "No tier saved; the built-in default runs.");
  assert.equal(roleStatusText("internal", draft), "No tier saved; the built-in default runs.");
  assert.equal(roleStatusText("loop", draft), null);
  assert.equal(roleStatusText("decisions", draft), "Decisions use the default model until you choose a Decision model.");
});

const STD = { provider: "anthropic", model: "x" };
const loadedOf = (tiers: Record<string, typeof STD>, features: Record<string, string>) => ({ tiers, features, status: {}, featureStatus: { plan: { usable: true } } }) as never;

test("draft: with Standard set, roles without a saved tier start on Standard; Decision never does", () => {
  const d = draftFromLoaded({ tiers: { standard: STD }, features: { loop: "standard", subagents: "standard" }});
  assert.deepEqual(d.features, { subagents: "standard", internal: "standard", loop: "standard", autoTasks: "standard" });
  const kept = draftFromLoaded({ tiers: { standard: STD, cheap: STD }, features: { internal: "cheap" } });
  assert.equal(kept.features.internal, "cheap");
  assert.equal(kept.features.decisions, undefined);
});

test("draft: without Standard nothing is preselected", () => {
  assert.deepEqual(draftFromLoaded({ tiers: { cheap: STD }, features: {} }).features, {});
});

test("draft: preselecting makes the section dirty (with the roles named); nothing to preselect is clean", () => {
  const loaded = loadedOf({ standard: STD }, { loop: "standard" });
  const draft = draftFromLoaded(loaded);
  assert.equal(isDirty(loaded, draft), true);
  assert.deepEqual(preselectedRoles(loaded, draft), ["subagents", "internal", "autoTasks"]);
  const full = loadedOf({ standard: STD }, { subagents: "standard", internal: "standard", loop: "standard", autoTasks: "standard" });
  assert.equal(isDirty(full, draftFromLoaded(full)), false);
  assert.deepEqual(preselectedRoles(full, draftFromLoaded(full)), []);
});

test("draft: RoutingModel.load puts Standard on unsaved roles and Save sends it explicitly", async () => {
  const client = fakeClient({
    "GET /kb/routing-tiers": () => ({ status: 200, body: { tiers: { standard: STD }, features: {}, status: {}, featureStatus: { plan: { usable: true } } } }),
  });
  const m = new RoutingModel(client);
  await m.load();
  assert.equal(m.getState().draft!.features.subagents, "standard");
  assert.equal(isDirty(m.getState().loaded, m.getState().draft), true);
});

test("old core (no featureStatus.plan): Plan is not preselected or listed, and a save-reload cycle stays clean", async () => {
  const oldBody = { tiers: { standard: STD }, features: { subagents: "standard", internal: "standard", loop: "standard", autoTasks: "standard" }, status: {}, featureStatus: { loop: { usable: true }, autoTasks: { usable: true } } };
  const client = fakeClient({ "GET /kb/routing-tiers": () => ({ status: 200, body: oldBody }) });
  const m = new RoutingModel(client);
  await m.load();
  const s = m.getState();
  assert.equal("plan" in s.draft!.features, false);
  assert.equal(isDirty(s.loaded, s.draft), false);
  assert.deepEqual(preselectedRoles(s.loaded, s.draft), []);
  assert.equal(visibleRoles(s.loaded).some((r) => r.id === "plan"), false);
});

test("new core (featureStatus.plan present): Plan is listed but never preselected (unset follows Loop)", async () => {
  const body = { tiers: { standard: STD }, features: {}, status: {}, featureStatus: { plan: { usable: true } } };
  const m = new RoutingModel(fakeClient({ "GET /kb/routing-tiers": () => ({ status: 200, body }) }));
  await m.load();
  assert.equal("plan" in m.getState().draft!.features, false);
  assert.equal(visibleRoles(m.getState().loaded).some((r) => r.id === "plan"), true);
});
