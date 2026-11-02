import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DecodeError } from "../decoders.ts";
import { LegacyModel, RELOAD_BUSY, createLegacyApi, decodeDiscovery, decodeItemsSaved, decodeLegacyUpdates, decodeMcpPlugins, decodeMcpVersions, decodePlugins, decodeReload, decodeSourceUpdated, decodeSourceUpdates } from "../legacy.ts";
import { err, fakeCore, REPO, type Handler } from "./helpers.ts";

const hx = (n: string): unknown => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/health-auth", `${n}.json`), "utf8")).response;
const ok = (body: unknown) => ({ status: 200, body });
const P = "/auth/me";

test("fixtures decode: reload, vendor updates, MCP versions, source updates, discovery, item and update answers", () => {
  assert.deepEqual(decodeReload(hx("post-auth-me-plugins-reload-200")), { pluginDir: "/tmp/example", count: 0, warnings: [] });
  assert.deepEqual(decodeLegacyUpdates(hx("get-auth-me-claude-plugins-updates-200")), []);
  const v = decodeMcpVersions(hx("get-auth-me-mcp-plugins-updates-200"))[0];
  assert.deepEqual([v?.id, v?.current, v?.latest, v?.status, v?.reason], ["filesystem", "2.0.1", "2.0.1", "up-to-date", undefined]);
  assert.equal(decodeSourceUpdates(hx("get-auth-me-llm-sources-updates-200"))[0]?.status, "up-to-date");
  const d = decodeDiscovery(hx("get-auth-me-llm-sources-id-discovery-200"));
  assert.deepEqual([d.skills.length, d.agents.length, d.commands.length, d.templates.length, d.hooks.length, d.mcpServers.length], [60, 1, 15, 9, 3, 0]);
  assert.deepEqual({ name: d.skills[0]?.name, enabled: d.skills[0]?.enabled, isNew: d.skills[0]?.isNew }, { name: "app-council", enabled: true, isNew: false });
  assert.doesNotThrow(() => decodeItemsSaved(hx("post-auth-me-llm-sources-items-200")));
  const mcp = decodeMcpPlugins(hx("get-auth-me-mcp-plugins-200"))[0]!;
  assert.deepEqual([mcp.versionLabel, mcp.packageName, mcp.envKeys], ["v2.0.1", "@modelcontextprotocol/server-filesystem", []]);
});

test("the update answer for a write is checked; its warnings are cleaned and its counts are the list lengths", () => {
  const r = decodeSourceUpdated({ ok: true, fromRev: "a", toRev: "b", added: [{ kind: "skill", name: "x" }], removed: [], corrected: [], warnings: ["w\u0007 ok"] });
  assert.deepEqual(r, { warnings: ["w ok"], added: 1, removed: 0 });
  assert.throws(() => decodeSourceUpdated({ ok: false }), DecodeError);
  assert.throws(() => decodeItemsSaved({ ok: "yes" }), DecodeError);
});

test("discovery drops names the server could not store instead of offering a switch that always fails", () => {
  const d = decodeDiscovery({ skills: [{ name: "fine", enabled: true }, { name: "bad\u0007name", enabled: true }, { name: "x".repeat(121), enabled: false }, { name: "", enabled: true }] });
  assert.deepEqual(d.skills.map((s) => s.name), ["fine"]);
  assert.throws(() => decodeDiscovery({ skills: [{ enabled: true }] }), DecodeError);
});

test("hostile plugin text is cleaned and capped; commands, subagents and component notes decode", () => {
  const p = decodePlugins({
    plugins: [
      {
        name: "runner",
        enabled: true,
        origin: "claude",
        sourceVersion: "1.2.0",
        commands: [{ trigger: "dep‮loy", description: "<img src=x onerror=alert(1)>" }],
        subagents: [{ name: "helper", description: "d".repeat(400) }],
        unsupportedComponents: ["monitors"],
        pendingComponents: ["mcp"],
      },
    ],
  })[0]!;
  assert.equal(p.origin, "claude");
  assert.equal(p.sourceVersion, "1.2.0");
  assert.deepEqual(p.commands, [{ trigger: "deploy", description: "<img src=x onerror=alert(1)>" }]);
  assert.equal(p.subagents[0]?.description.length, 300);
  assert.deepEqual([p.unsupportedComponents, p.pendingComponents], [["monitors"], ["mcp"]]);
  const bare = decodePlugins({ plugins: [{ name: "plain", enabled: false }] })[0]!;
  assert.deepEqual([bare.origin, bare.commands, bare.subagents], [null, [], []]);
});

test("a server that sends a wrong status type fails the read rather than showing a guess", () => {
  assert.throws(() => decodeMcpVersions({ servers: [{ id: "x", status: 3 }] }), DecodeError);
  assert.throws(() => decodeLegacyUpdates({ updates: [{ name: "a‮b" }] }), DecodeError);
});

function setup(kind: "plugins" | "llm-sources" | "mcp-plugins", routes: Record<string, Handler> = {}) {
  const core = fakeCore({
    "GET /auth/me/plugins": () => ok({ plugins: [{ name: "runner", displayName: "Runner", enabled: true, format: "claude", hookCount: 0 }] }),
    "GET /auth/me/llm-sources": () => ok(hx("get-auth-me-llm-sources-200")),
    "GET /auth/me/mcp-plugins": () => ok(hx("get-auth-me-mcp-plugins-200")),
    "GET /auth/me/claude-plugins/updates": () => ok({ cli: true, checkedAt: "x", updates: [] }),
    "GET /auth/me/codex-plugins/updates": () => ok({ cli: false, checkedAt: "x", updates: [] }),
    "GET /auth/me/mcp-plugins/updates": () => ok(hx("get-auth-me-mcp-plugins-updates-200")),
    "GET /auth/me/llm-sources/updates": () => ok(hx("get-auth-me-llm-sources-updates-200")),
    ...routes,
  });
  return { core, model: new LegacyModel(createLegacyApi(core), kind) };
}
const posts = (core: { calls: { method: string; path: string; body: unknown }[] }, p: string) => core.calls.filter((c) => c.method === "POST" && c.path === `${P}/${p}`);

test("plugins: a claude update report marks its row; a failed codex read is shown and keeps the claude answer", async () => {
  const { model } = setup("plugins", {
    "GET /auth/me/claude-plugins/updates": () => ok({ cli: true, checkedAt: "x", updates: [{ name: "runner", latest: "2.0.0", tier: "upstream" }] }),
    "GET /auth/me/codex-plugins/updates": () => err(500, "CHECK_FAILED"),
  });
  await model.load();
  const s = model.getSnapshot();
  assert.equal(s.pluginUpdates.runner?.latest, "2.0.0");
  assert.ok(s.statusError, "the failed codex read is reported");
  assert.equal(s.statusLoading, false);
});

test("plugins: a clean status read leaves no error; status is never a fake 'no update'", async () => {
  const { model } = setup("plugins");
  await model.load();
  assert.equal(model.getSnapshot().statusError, null);
  assert.deepEqual(Object.keys(model.getSnapshot().pluginUpdates), []);
});

test("reload from disk posts an empty body, reloads the list and reports the count and warnings", async () => {
  const { core, model } = setup("plugins", {
    "POST /auth/me/plugins/reload": () => ok({ pluginDir: "/p", count: 2, warnings: ["skipped bad.json"] }),
  });
  await model.load();
  await model.reloadPlugins();
  assert.deepEqual(posts(core, "plugins/reload")[0]!.body, {});
  assert.equal(model.getSnapshot().notice?.text, "Reloaded 2 plugins from disk. skipped bad.json");
  assert.equal(model.getSnapshot().busy.includes(RELOAD_BUSY), false);
});

test("a non-admin reload is refused with the server's message and changes nothing", async () => {
  const { model } = setup("plugins", { "POST /auth/me/plugins/reload": () => err(403, "FORBIDDEN") });
  await model.load();
  await model.reloadPlugins();
  assert.equal(model.getSnapshot().notice?.error, true);
  assert.equal(model.getSnapshot().rows.length, 1);
});

test("LLM source: selecting it reads its contents; switching one item posts exactly that name and patches the row", async () => {
  const { core, model } = setup("llm-sources", {
    "GET /auth/me/llm-sources/builtin/discovery": () => ok(hx("get-auth-me-llm-sources-id-discovery-200")),
    "POST /auth/me/llm-sources/items": () => ok({ ok: true, disabled: ["skill:app-council"] }),
  });
  await model.load();
  model.select("builtin");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(model.getSnapshot().discovery?.data?.skills.length, 60);
  await model.setItems("skill", ["app-council"], false);
  assert.deepEqual(posts(core, "llm-sources/items")[0]!.body, { sourceId: "builtin", kind: "skill", names: ["app-council"], enabled: false });
  const d = model.getSnapshot().discovery!.data!;
  assert.equal(d.skills.find((s) => s.name === "app-council")?.enabled, false);
});

test("setItems sends nothing when no contents are on screen", async () => {
  const { core, model } = setup("llm-sources");
  await model.load();
  await model.setItems("skill", ["x"], true);
  assert.equal(posts(core, "llm-sources/items").length, 0);
});

test("a source that vanished says so; a row removed from the list keeps its pane with a not-found state", async () => {
  const { model } = setup("llm-sources", { "GET /auth/me/llm-sources/builtin/discovery": () => err(404, "NOT_FOUND") });
  await model.load();
  model.select("builtin");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(model.getSnapshot().discovery?.error, "Source not found — it may have been removed.");
});

test("check for updates forces the upstream check; an update posts the id and reports the counts", async () => {
  const { core, model } = setup("llm-sources", {
    "POST /auth/me/llm-sources/update": () => ok({ ok: true, fromRev: "a", toRev: "b", added: [{ kind: "skill", name: "n" }], removed: [], corrected: [], warnings: [] }),
  });
  await model.load();
  await model.checkSourceUpdates();
  assert.ok(core.calls.some((c) => c.method === "GET" && c.path === `${P}/llm-sources/updates?force=1`));
  await model.updateSource("builtin");
  assert.deepEqual(posts(core, "llm-sources/update")[0]!.body, { id: "builtin" });
  assert.equal(model.getSnapshot().notice?.text, "Updated: 1 added, 0 removed.");
});

test("mcp version: the list keeps the registry status per server", async () => {
  const { model } = setup("mcp-plugins");
  await model.load();
  assert.equal(model.getSnapshot().mcpVersions.filesystem?.status, "up-to-date");
});

// ---- review fixes ------------------------------------------------------------------------------------

test("route-shaped vendor update rows decode: claude (null claudeVersion/latest, legacy fields) and codex (pluginId null)", () => {
  // extension/plugins/claude-update.mjs updateRow + withLegacyFields; extension/routes/extension-routes.mjs codex route.
  const claude = decodeLegacyUpdates({
    cli: true,
    checkedAt: "2026-11-01T00:00:00.000Z",
    updates: [{ name: "runner", pluginId: "runner@mkt", importedVersion: "1.0.0", claudeVersion: null, latest: null, tier: "reimport", sourceVersion: "", source: "installed" }],
  });
  assert.deepEqual(claude, [{ name: "runner", importedVersion: "1.0.0", claudeVersion: undefined, latest: undefined, tier: "reimport" }]);
  const codex = decodeLegacyUpdates({
    cli: false,
    checkedAt: "x",
    updates: [{ name: "codex-tool", pluginId: null, importedVersion: "0.1.0", claudeVersion: "0.2.0", latest: "0.2.0", tier: "upstream", sourceVersion: "0.2.0", source: "installed" }],
  });
  assert.equal(codex[0]?.latest, "0.2.0");
});

test("route-shaped source update answers decode: a git pull and a Central Skills first install (no added/removed)", () => {
  // extension/llm-sources/registry.mjs updateSource and syncBuiltin.
  assert.deepEqual(decodeSourceUpdated({ ok: true, installed: true }), { warnings: [], added: 0, removed: 0 });
  const r = decodeSourceUpdated({ ok: true, fromRev: null, toRev: null, added: [], removed: [{ kind: "agent", name: "a" }, { kind: "skill", name: "b" }], corrected: [".skills-lock"], warnings: [] });
  assert.deepEqual(r, { warnings: [], added: 0, removed: 2 });
});

test("a plugin named like an Object member never shows a phantom update", async () => {
  const core = fakeCore({
    "GET /auth/me/plugins": () => ok({ plugins: [{ name: "constructor", displayName: "C", enabled: true, format: "claude", hookCount: 0 }] }),
    "GET /auth/me/claude-plugins/updates": () => ok({ updates: [] }),
    "GET /auth/me/codex-plugins/updates": () => ok({ updates: [] }),
  });
  const model = new LegacyModel(createLegacyApi(core), "plugins");
  assert.equal(model.getSnapshot().pluginUpdates.constructor, undefined, "before the first read");
  await model.load();
  assert.equal(model.getSnapshot().pluginUpdates.constructor, undefined, "after the read");
  assert.equal(model.getSnapshot().pluginUpdates.toString, undefined);
});

test("the vendor update check (which spawns the claude CLI on the core) is reused for 60 s across loads and remounts; reload forces it", async () => {
  const { core } = setup("plugins", { "POST /auth/me/plugins/reload": () => ok({ pluginDir: "/p", count: 1, warnings: [] }) });
  const api = createLegacyApi(core);
  const model = new LegacyModel(api, "plugins");
  const claudeReads = () => core.calls.filter((c) => c.method === "GET" && c.path === `${P}/claude-plugins/updates`).length;
  await model.load();
  await model.load(); // e.g. the reload a toggle does
  await new LegacyModel(api, "plugins").load(); // same client, new mount
  const again = new LegacyModel(createLegacyApi(core), "plugins"); // a different client: its own cache
  assert.equal(claudeReads(), 1);
  await model.reloadPlugins();
  assert.equal(claudeReads(), 2, "Reload from disk re-checks");
  await model.load(true);
  assert.equal(claudeReads(), 3, "Reload list re-checks");
  await again.load();
  assert.equal(claudeReads(), 4);
});

test("a failed status read is not cached: the next load asks again", async () => {
  let fail = true;
  const { core, model } = setup("mcp-plugins", { "GET /auth/me/mcp-plugins/updates": () => (fail ? err(500, "X") : ok({ servers: [] })) });
  await model.load();
  assert.ok(model.getSnapshot().statusError);
  fail = false;
  await model.load();
  assert.equal(model.getSnapshot().statusError, null);
  assert.equal(core.calls.filter((c) => c.path === `${P}/mcp-plugins/updates`).length, 2);
});

test("MCP environment key names are sorted like the Mac's detail pane; values never reach the row", () => {
  const r = decodeMcpPlugins({ plugins: [{ id: "x", name: "X", source: "manual", transport: "stdio", runs: "x", enabled: false, consented: false, credentialMissing: false, builtin: false, env: { ZED: "secret-z", ALPHA: "secret-a" } }] });
  assert.deepEqual(r[0]?.envKeys, ["ALPHA", "ZED"]);
  assert.equal(JSON.stringify(r).includes("secret"), false);
});
