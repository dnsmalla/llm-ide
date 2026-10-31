import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DecodeError, decodeAgentHistorySettings, decodeAllowlist, decodeCatalog, decodeClearResult, decodeCompactResult, decodeConnectResult,
  decodeHealth, decodeMe, decodeModelList, decodeProviderSettings, decodeRemoved, decodeRoutingSave, decodeRoutingTiers, decodeSdkStatus,
  decodeSecretNames, decodeStorageReport, decodeTestResult, decodeWorkspaceTrustList, decodeWorkspaceTrustSet,
} from "../decoders.ts";
import { fixture } from "./helpers.ts";

const r = (rel: string): unknown => fixture(rel).response;

test("provider catalog fixtures decode, connections carry hasKey only", () => {
  const cat = decodeCatalog({ providers: (r("provider-catalog/get-kb-providers-catalog-200.json") as { providers: unknown[] }).providers, settings: r("provider-catalog/get-kb-providers-settings-200.json") });
  assert.ok(cat.providers.length >= 10);
  const groq = cat.providers.find((p) => p.id === "groq")!;
  assert.equal(groq.connections[0]!.hasKey, true);
  assert.ok(!JSON.stringify(cat).includes("sk-"));
  assert.equal(cat.settings.fallbackOrder[1]!.model, undefined);
  decodeCatalog({ providers: [], settings: r("provider-catalog/get-kb-providers-settings-200-defaults.json") });
  decodeProviderSettings(r("provider-catalog/put-kb-providers-settings-200.json"));
  decodeCatalog({ providers: (r("provider-catalog/get-kb-providers-catalog-200-empty.json") as { providers: unknown[] }).providers, settings: r("provider-catalog/get-kb-providers-settings-200.json") });
});

test("connect, test, models, disconnect fixtures decode", () => {
  assert.equal(decodeConnectResult(r("provider-catalog/post-kb-providers-catalog-connect-200.json")).id, "cat-groq");
  assert.equal(decodeConnectResult(r("provider-catalog/post-kb-providers-catalog-connect-200-private-gateway.json")).allowPrivate, true);
  assert.equal(decodeConnectResult(r("provider-catalog/post-kb-providers-catalog-connect-200-disabled.json")).enabled, false);
  assert.equal(decodeTestResult(r("provider-catalog/post-kb-providers-catalog-test-200.json")).modelCount, 2);
  assert.equal(decodeTestResult(r("provider-catalog/post-kb-providers-catalog-test-200-refused.json")).ok, false);
  const live = decodeModelList(r("provider-catalog/post-kb-providers-catalog-models-200-live.json"));
  assert.equal(live.source, "live");
  assert.equal(live.models[0]!.toolsSource, "override");
  assert.equal(decodeModelList(r("provider-catalog/post-kb-providers-catalog-models-200-static.json")).source, "static");
  assert.equal(decodeRemoved(r("provider-catalog/post-kb-providers-catalog-disconnect-200.json")), true);
});

test("routing fixtures decode", () => {
  const t = decodeRoutingTiers(r("providers-usage/get-kb-routing-tiers-200.json"));
  assert.deepEqual(Object.keys(t.tiers), ["strong", "standard", "cheap"]);
  assert.equal(t.status.cheap!.reason, "no_key");
  assert.equal(t.status.standard!.agentReason, "not_agent_capable");
  assert.equal(t.featureStatus.loop!.usable, false);
  assert.equal(decodeRoutingSave(r("providers-usage/post-kb-routing-tiers-200-dropped.json")).dropped.length, 2);
  assert.equal(decodeSdkStatus(r("providers-usage/get-kb-agent-sdk-200-offline.json")).running, "0.3.301");
});

test("agent history fixtures decode", () => {
  assert.equal(decodeAgentHistorySettings(r("agent-history/get-kb-agent-history-settings-200.json")).retentionDays, 30);
  const s = decodeStorageReport(r("agent-history/get-kb-storage-200.json"));
  assert.equal(s.groups[0]!.key, "agent_history");
  assert.deepEqual(s.groups[0]!.actions, ["clear", "compact"]);
  assert.equal(s.agentStoreState, "ok");
  const dry = decodeClearResult(r("agent-history/post-kb-agent-history-clear-200-dry-run.json"));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.total, 5);
  assert.ok(dry.previewId);
  assert.equal(dry.counts.agent_runs, 2);
  const done = decodeClearResult(r("agent-history/post-kb-agent-history-clear-200-deleted.json"));
  assert.equal(done.previewId, undefined);
  assert.equal(done.counts.agent_tool_events, 3);
  assert.equal(decodeCompactResult(r("agent-history/post-kb-agent-history-compact-200.json")).pagesFreed, 120);
});

test("extensions trust fixtures decode", () => {
  const a = decodeAllowlist(r("extensions/get-auth-me-extensions-allowlist-200-2.json"));
  assert.deepEqual(a.ignored, ["evil/x"]);
  assert.deepEqual(a.ceiling, ["acme/*"]);
  assert.equal(decodeAllowlist(r("extensions/get-auth-me-extensions-allowlist-200.json")).ceiling, null);
  assert.deepEqual(decodeAllowlist(r("extensions/put-auth-me-extensions-allowlist-200.json")).user, ["acme/tools", "foo/*"]);
  assert.equal(decodeWorkspaceTrustList(r("extensions/get-auth-me-workspace-trust-200-2.json")).items.length, 2);
  assert.equal(decodeWorkspaceTrustList(r("extensions/get-auth-me-workspace-trust-200.json")).enforced, true);
  assert.equal(decodeWorkspaceTrustSet(r("extensions/put-auth-me-workspace-trust-200.json")).trusted, true);
});

test("account, health and vault fixtures decode; the vault listing yields names only", () => {
  assert.equal(decodeMe(r("health-auth/get-auth-me-200.json")).role, "admin");
  const h = decodeHealth(r("health-auth/get-health-200.json"));
  assert.equal(h.apiVersion, 80);
  assert.equal(h.features, null);
  assert.equal(h.checks.db, true);
  assert.deepEqual(decodeSecretNames(r("health-auth/get-auth-me-secrets-200.json")), ["claude.apiKey"]);
});

test("wrong shapes are DecodeErrors, not half-typed objects", () => {
  assert.throws(() => decodeCatalog({ providers: "x" }), DecodeError);
  assert.throws(() => decodeConnectResult({ ok: false }), DecodeError);
  assert.throws(() => decodeAllowlist({ operator: [1] }), DecodeError);
  assert.throws(() => decodeClearResult({ dryRun: true, scope: "weird", total: 1 }), DecodeError);
  assert.throws(() => decodeModelList({ models: [], source: "psychic" }), DecodeError);
  assert.throws(() => decodeWorkspaceTrustList(null), DecodeError);
});
