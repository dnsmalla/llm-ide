import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DecodeError } from "../decoders.ts";
import { LegacyModel, createLegacyApi, decodeConsented, decodeHookTrust, decodeLlmSources, decodeMcpPlugins, decodePlugins, decodeToggled, shownHookKinds } from "../legacy.ts";
import { deferred, err, fakeCore, REPO, tick, type Handler } from "./helpers.ts";

const hx = (n: string): { status: number; response: unknown } => {
  const j = JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/health-auth", `${n}.json`), "utf8"));
  return { status: j.status, response: j.response };
};
const ok = (body: unknown) => ({ status: 200, body });

const plugin = (over: Record<string, unknown> = {}) => ({ name: "runner", displayName: "Runner", version: "1.0.0", enabled: false, format: "claude", skillCount: 2, hookCount: 1, declaresHooks: true, executableKinds: ["monitors"], hookNotes: ["runs on Stop"], hooksTrusted: false, ...over });

test("legacy fixtures decode: llm-sources, mcp-plugins, toggles, consent, plugin list", () => {
  assert.equal(decodeLlmSources(hx("get-auth-me-llm-sources-200").response)[0]?.skillCount, 60);
  const mcp = decodeMcpPlugins(hx("get-auth-me-mcp-plugins-200").response)[0]!;
  assert.equal(mcp.consented, false);
  assert.equal(mcp.runs, "npx -y @modelcontextprotocol/server-filesystem@2.0.1 /tmp");
  assert.deepEqual(decodePlugins(hx("get-auth-me-plugins-200").response), []);
  assert.equal(decodeToggled(hx("post-auth-me-llm-sources-toggle-200").response).enabled, true);
  assert.equal(decodeToggled(hx("post-auth-me-mcp-plugins-toggle-200").response).enabled, true);
  assert.equal(decodeConsented(hx("post-auth-me-mcp-plugins-consent-200").response).consented, true);
  assert.equal(decodeHookTrust({ ok: true, hooksTrusted: true }).hooksTrusted, true);
});

test("hostile or wrong shapes are DecodeErrors; ids with control characters are refused", () => {
  assert.throws(() => decodePlugins({ plugins: [{ name: "a‮b", enabled: true }] }), DecodeError);
  assert.throws(() => decodeMcpPlugins({ plugins: [{ id: "x" }] }), DecodeError);
  assert.throws(() => decodeToggled({ ok: false, enabled: true }), DecodeError);
  const row = decodePlugins({ plugins: [plugin({ displayName: "<b>x</b>\u0000" })] })[0]!;
  assert.equal(row.displayName, "<b>x</b>");
});

const P = "/auth/me";
function setup(kind: "plugins" | "llm-sources" | "mcp-plugins", routes: Record<string, Handler> = {}, rows: unknown = {}) {
  const core = fakeCore({
    "GET /auth/me/plugins": () => ok({ plugins: [plugin()] }),
    "GET /auth/me/llm-sources": () => ok(hx("get-auth-me-llm-sources-200").response),
    "GET /auth/me/mcp-plugins": () => ok(hx("get-auth-me-mcp-plugins-200").response),
    ...routes,
  });
  void rows;
  return { core, model: new LegacyModel(createLegacyApi(core), kind) };
}
const posts = (core: { calls: { method: string; path: string; body: unknown }[] }, p: string) => core.calls.filter((c) => c.method === "POST" && c.path === `${P}/${p}`);

test("llm sources: list and switch", async () => {
  const { core, model } = setup("llm-sources", { "POST /auth/me/llm-sources/toggle": () => ok({ ok: true, enabled: false }) });
  await model.load();
  await model.setEnabled("builtin", false);
  assert.deepEqual(posts(core, "llm-sources/toggle")[0]!.body, { id: "builtin", enabled: false });
  assert.equal((model.getSnapshot().rows[0] as { enabled: boolean }).enabled, false);
});

test("mcp: switching on without consent opens the sheet and sends nothing; Apply needs the tick; then consent and toggle are sent in order", async () => {
  const order: string[] = [];
  const { core, model } = setup("mcp-plugins", {
    "POST /auth/me/mcp-plugins/consent": () => (order.push("consent"), ok({ ok: true, consented: true })),
    "POST /auth/me/mcp-plugins/toggle": () => (order.push("toggle"), ok({ ok: true, enabled: true })),
  });
  await model.load();
  await model.setEnabled("filesystem", true);
  assert.equal(model.getSnapshot().sheet?.kind, "mcp");
  assert.equal(core.calls.filter((c) => c.method === "POST").length, 0);
  await model.confirm();
  assert.equal(core.calls.filter((c) => c.method === "POST").length, 0);
  assert.equal(model.getSnapshot().sheet?.kind, "mcp");
  model.tickMcp(true);
  const a = model.confirm();
  const b = model.confirm(); // double tap
  await Promise.all([a, b]);
  assert.deepEqual(order, ["consent", "toggle"]);
  const row = model.getSnapshot().rows[0] as { enabled: boolean; consented: boolean };
  assert.deepEqual([row.consented, row.enabled], [true, true]);
});

test("mcp: an already consented server switches directly; CONSENT_REQUIRED from the core reloads the list", async () => {
  let consented = true;
  const { model } = setup("mcp-plugins", {
    "GET /auth/me/mcp-plugins": () => ok({ plugins: [{ ...(hx("get-auth-me-mcp-plugins-200").response as { plugins: Record<string, unknown>[] }).plugins[0], consented }] }),
    "POST /auth/me/mcp-plugins/toggle": () => err(409, "CONSENT_REQUIRED"),
  });
  await model.load();
  consented = false;
  await model.setEnabled("filesystem", true);
  assert.match(model.getSnapshot().notice!.text, /Consent to each kind/);
  assert.equal((model.getSnapshot().rows[0] as { consented: boolean }).consented, false);
});

test("plugin hook trust: the sheet names the kinds shown, sends exactly them once all are ticked", async () => {
  const { core, model } = setup("plugins", { "POST /auth/me/plugins/hook-trust": () => ok({ ok: true, hooksTrusted: true }) });
  await model.load();
  model.requestHookTrust("runner");
  const sh = model.getSnapshot().sheet as { kinds: string[] };
  assert.deepEqual(sh.kinds.sort(), ["hooks", "monitors"]);
  model.tickKind("hooks", true);
  assert.equal(model.canConfirm, false);
  await model.confirm();
  assert.equal(posts(core, "plugins/hook-trust").length, 0);
  model.tickKind("monitors", true);
  await model.confirm();
  const body = posts(core, "plugins/hook-trust")[0]!.body as { name: string; trusted: boolean; kinds: string[] };
  assert.deepEqual([body.name, body.trusted, body.kinds.slice().sort()], ["runner", true, ["hooks", "monitors"]]);
  assert.equal((model.getSnapshot().rows[0] as { hooksTrusted: boolean }).hooksTrusted, true);
});

test("plugin hook trust: a 409 (the plugin now declares more) reloads and shows the refusal", async () => {
  const { model } = setup("plugins", { "POST /auth/me/plugins/hook-trust": () => err(409, "VALIDATION_FAILED") });
  await model.load();
  model.requestHookTrust("runner");
  model.tickKind("hooks", true);
  model.tickKind("monitors", true);
  await model.confirm();
  assert.equal(model.getSnapshot().notice?.error, true);
});

test("revoking hook trust needs no ticks and sends trusted:false", async () => {
  const { core, model } = setup("plugins", {
    "GET /auth/me/plugins": () => ok({ plugins: [plugin({ hooksTrusted: true })] }),
    "POST /auth/me/plugins/hook-trust": () => ok({ ok: true, hooksTrusted: false }),
  });
  await model.load();
  await model.revokeHookTrust("runner");
  assert.deepEqual(posts(core, "plugins/hook-trust")[0]!.body, { name: "runner", trusted: false });
  assert.equal((model.getSnapshot().rows[0] as { hooksTrusted: boolean }).hooksTrusted, false);
});

test("a plugin without hooks has no trust sheet; enabling it never grants hook trust", async () => {
  const { core, model } = setup("plugins", {
    "GET /auth/me/plugins": () => ok({ plugins: [plugin({ hookCount: 0, declaresHooks: false, executableKinds: [] })] }),
    "POST /auth/me/plugins/toggle": () => ok({ ok: true, enabled: true }),
  });
  await model.load();
  model.requestHookTrust("runner");
  assert.equal(model.getSnapshot().sheet, null);
  await model.setEnabled("runner", true);
  assert.deepEqual(posts(core, "plugins/toggle")[0]!.body, { name: "runner", enabled: true });
  assert.equal(posts(core, "plugins/hook-trust").length, 0);
  assert.deepEqual(shownHookKinds({ executableKinds: [], hookCount: 0 }), []);
});

test("busy: a second switch on the same row says so; dispose cancels a pending load", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const { model } = setup("llm-sources", { "POST /auth/me/llm-sources/toggle": () => gate.promise });
  await model.load();
  const a = model.setEnabled("builtin", false);
  await tick();
  await model.setEnabled("builtin", true);
  assert.equal(model.getSnapshot().notice?.text, "Busy, try again.");
  gate.resolve(ok({ ok: true, enabled: false }));
  await a;
  const slow = deferred<{ status: number; body: unknown }>();
  let sig: AbortSignal | undefined;
  const m2 = new LegacyModel(createLegacyApi(fakeCore({ "GET /auth/me/plugins": (c) => ((sig = c.opts.signal), slow.promise) })), "plugins");
  const p = m2.load();
  await tick();
  m2.dispose();
  assert.equal(sig?.aborted, true);
  slow.resolve(ok({ plugins: [plugin()] }));
  await p;
  assert.equal(m2.getSnapshot().rows.length, 0);
});

test("a failing list is a message with no rows", async () => {
  const { model } = setup("plugins", { "GET /auth/me/plugins": () => err(500, "STATE_UNREADABLE") });
  await model.load();
  assert.match(model.getSnapshot().error!, /could not be read/);
});


test("mcp: add sends the manual server shape, reloads, and remove sends DELETE", async () => {
  const { core, model } = setup("mcp-plugins", {
    "POST /auth/me/mcp-plugins/add": () => ok({ ok: true, plugin: { id: "manual-one", name: "Manual", enabled: false } }),
    "DELETE /auth/me/mcp-plugins/manual-one": () => ok({ ok: true }),
  });
  await model.load();
  const before = core.calls.filter((c) => c.method === "GET" && c.path === "/auth/me/mcp-plugins").length;
  assert.equal(await model.addMcp({ name: "Manual", transport: "stdio", command: "npx", args: ["-y", "server"] }), true);
  assert.deepEqual(posts(core, "mcp-plugins/add")[0]!.body, { name: "Manual", transport: "stdio", command: "npx", args: ["-y", "server"] });
  assert.ok(core.calls.filter((c) => c.method === "GET" && c.path === "/auth/me/mcp-plugins").length > before, "reloads after add");
  await model.removeMcp("manual-one");
  assert.ok(core.calls.some((c) => c.method === "DELETE" && c.path === "/auth/me/mcp-plugins/manual-one"));
});


test("llm source: add sends git/local shape, reloads, and remove sends DELETE", async () => {
  const { core, model } = setup("llm-sources", {
    "POST /auth/me/llm-sources/add": () => ok({ ok: true, source: { id: "new-source" } }),
    "DELETE /auth/me/llm-sources/new-source": () => ok({ ok: true }),
  });
  await model.load();
  assert.equal(await model.addLlmSource({ url: "https://github.com/o/r", ref: "main", name: "R" }), true);
  assert.deepEqual(posts(core, "llm-sources/add")[0]!.body, { url: "https://github.com/o/r", ref: "main", name: "R" });
  await model.removeLlmSource("new-source");
  assert.ok(core.calls.some((c) => c.method === "DELETE" && c.path === "/auth/me/llm-sources/new-source"));
});


test("claude plugins: list decodes and import sends the installed source", async () => {
  const { core, model } = setup("plugins", {
    "GET /auth/me/claude-plugins/installed": () => ok({ plugins: [{ name: "helper", version: "1.2.0", skillCount: 2, commandCount: 1, alreadyImported: false, hasUpdate: true }] }),
    "POST /auth/me/claude-plugins/import": () => ok({ ok: true, plugin: { name: "claude-helper" } }),
  });
  const rows = await model.claudePlugins();
  assert.equal(rows[0]?.skillCount, 2);
  assert.equal(await model.importClaude("helper"), true);
  assert.deepEqual(posts(core, "claude-plugins/import")[0]!.body, { name: "helper", source: "installed" });
});


test("codex plugins: list decodes and import sends the installed source", async () => {
  const { core, model } = setup("plugins", {
    "GET /auth/me/codex-plugins/installed": () => ok({ plugins: [{ name: "helper", version: "1.0.0", skillCount: 1, commandCount: 0, alreadyImported: false, hasUpdate: false }] }),
    "POST /auth/me/codex-plugins/import": () => ok({ ok: true, plugin: { name: "codex-helper" } }),
  });
  const rows = await model.codexPlugins();
  assert.equal(rows[0]?.name, "helper");
  assert.equal(await model.importCodex("helper"), true);
  assert.deepEqual(posts(core, "codex-plugins/import")[0]!.body, { name: "helper", source: "installed" });
});


test("claude marketplace: list decodes and import sends the marketplace source", async () => {
  const { core, model } = setup("plugins", {
    "GET /auth/me/claude-plugins/marketplace": () => ok({ plugins: [{ name: "market-helper", version: "2.0.0", skillCount: 0, commandCount: 0, alreadyImported: false }] }),
    "POST /auth/me/claude-plugins/import": () => ok({ ok: true, plugin: { name: "claude-market-helper" } }),
  });
  assert.equal((await model.claudeMarketplace())[0]?.name, "market-helper");
  assert.equal(await model.importClaude("market-helper", "marketplace"), true);
  assert.deepEqual(posts(core, "claude-plugins/import")[0]!.body, { name: "market-helper", source: "marketplace" });
});


test("plugin git install sends the URL/ref and reloads", async () => {
  const { core, model } = setup("plugins", {
    "POST /auth/me/plugins/install-git": () => ok({ ok: true, plugin: { name: "git-plugin" } }),
  });
  await model.load();
  assert.equal(await model.installPluginGit("https://github.com/o/r", "main"), true);
  assert.deepEqual(core.calls.find((c) => c.method === "POST" && c.path === "/auth/me/plugins/install-git")!.body, { url: "https://github.com/o/r", ref: "main" });
});

test("bulk switch: ticked rows switch through the per-row toggle; an MCP server without consent is never switched on in bulk", async () => {
  const { core, model } = setup("mcp-plugins", { "POST /auth/me/mcp-plugins/toggle": () => ok(hx("post-auth-me-mcp-plugins-toggle-200").response) });
  await model.load();
  model.toggleAllShown();
  assert.equal(model.getSnapshot().checked.length, model.getSnapshot().rows.length);
  await model.bulkSwitch(true);
  assert.equal(posts(core, "mcp-plugins/toggle").length, 0, "the unconsented server was not switched on");
  assert.equal(posts(core, "mcp-plugins/consent").length, 0, "and no consent was implied");
  assert.equal(model.getSnapshot().sheet, null);
  assert.match(model.getSnapshot().notice!.text, /consent/);
});

test("legacy filter: rows match by id, name or description; select all ticks only the shown rows", async () => {
  const { model } = setup("plugins");
  await model.load();
  model.setFilter("no-such-thing");
  model.toggleAllShown();
  assert.deepEqual(model.getSnapshot().checked, []);
  model.setFilter("run");
  model.toggleAllShown();
  assert.deepEqual(model.getSnapshot().checked, ["runner"]);
});
