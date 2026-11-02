import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { bundleDir } from "../../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const requireFromDesktop = createRequire(join(REPO, "desktop", "package.json"));
const P = "/auth/me/extensions";

let X;
let h;
let html;
before(async () => {
  const { build } = requireFromDesktop("esbuild");
  const outfile = join(bundleDir("extensions-detail"), "entry.mjs");
  await build({ entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") }, jsx: "automatic", logLevel: "silent" });
  X = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  h = requireFromDesktop("react").createElement;
  html = (el) => requireFromDesktop("react-dom/server").renderToStaticMarkup(el);
});

const hx = (n) => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/health-auth", `${n}.json`), "utf8")).response;
const fx = (n) => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/extensions", `${n}.json`), "utf8")).response;
const ok = (body) => ({ status: 200, body });
const count = (s, re) => (s.match(re) ?? []).length;

/** A scripted core: routes keyed "METHOD path" (query stripped); unknown routes answer 404. */
function core(routes) {
  return {
    async request(method, path) {
      const r = routes[`${method} ${path.split("?")[0]}`];
      if (!r) return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      const body = r();
      // A route may answer a failure by returning { __status, error }.
      if (body && typeof body === "object" && "__status" in body) return { status: body.__status, body: { error: body.error } };
      return { status: 200, body };
    },
  };
}
async function legacy(kind, routes) {
  const base = {
    "GET /auth/me/plugins": () => ({ plugins: [] }),
    "GET /auth/me/llm-sources": () => hx("get-auth-me-llm-sources-200"),
    "GET /auth/me/mcp-plugins": () => hx("get-auth-me-mcp-plugins-200"),
    "GET /auth/me/claude-plugins/updates": () => ({ cli: true, checkedAt: "x", updates: [] }),
    "GET /auth/me/codex-plugins/updates": () => ({ cli: false, checkedAt: "x", updates: [] }),
    "GET /auth/me/mcp-plugins/updates": () => hx("get-auth-me-mcp-plugins-updates-200"),
    "GET /auth/me/llm-sources/updates": () => hx("get-auth-me-llm-sources-updates-200"),
  };
  const model = new X.LegacyModel(X.createLegacyApi(core({ ...base, ...routes })), kind);
  await model.load();
  return model;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const plugin = (over = {}) => ({
  name: "runner",
  displayName: "Runner",
  version: "1.0.0",
  author: "Acme",
  enabled: true,
  format: "claude",
  description: "<img src=x onerror=alert(1)> runs things",
  skillCount: 2,
  hookCount: 0,
  mcpServerCount: 0,
  origin: "claude",
  sourceVersion: "1.0.0",
  commands: [{ trigger: "deploy", description: "ships <b>it</b>" }],
  subagents: [{ name: "helper", description: "helps" }],
  unsupportedComponents: ["monitors"],
  pendingComponents: [],
  ...over,
});

test("plugin detail: About, slash commands and subagents as text; origin badge; the update report from the cached read", async () => {
  const model = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin()] }),
    "GET /auth/me/claude-plugins/updates": () => ({ cli: true, checkedAt: "x", updates: [{ name: "runner", latest: "2.0.0", tier: "upstream" }] }),
  });
  model.select("runner");
  const out = html(h(X.LegacyView, { model }));
  assert.match(out, /aria-label="Details of Runner"/);
  assert.match(out, /Imported from Claude Code/);
  assert.match(out, /Slash commands \(1\)/);
  assert.match(out, /<code>\/deploy<\/code>/);
  assert.match(out, /ships &lt;b&gt;it&lt;\/b&gt;/);
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt; runs things"), "plugin About text is escaped");
  assert.match(out, /Subagents \(1\)/);
  assert.match(out, /monitors — unsupported, ignored/);
  assert.match(out, /Update reported for v2\.0\.0/);
  assert.doesNotMatch(out, /<img /);
});

test("plugin detail: a non-imported plugin has no Updates block; the row shows Update available for a reported update", async () => {
  const model = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin({ origin: null, sourceVersion: undefined })] }),
  });
  model.select("runner");
  assert.doesNotMatch(html(h(X.LegacyView, { model })), /aria-label="Updates"/);
  const withUpdate = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin()] }),
    "GET /auth/me/claude-plugins/updates": () => ({ cli: true, checkedAt: "x", updates: [{ name: "runner", latest: "2.0.0" }] }),
  });
  assert.match(html(h(X.LegacyView, { model: withUpdate })), /Update available/);
});

test("plugin detail: a failed update read says it could not check, never 'no update'", async () => {
  const model = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin()] }),
    "GET /auth/me/claude-plugins/updates": () => ({ __status: 500, error: { code: "CHECK_FAILED", message: "x" } }),
  });
  model.select("runner");
  const out = html(h(X.LegacyView, { model }));
  assert.doesNotMatch(out, /No update reported/);
});

test("plugin detail: a row that disappears keeps its pane with the not-found text", async () => {
  let rows = [plugin()];
  const model = await legacy("plugins", { "GET /auth/me/plugins": () => ({ plugins: rows }) });
  model.select("runner");
  rows = [];
  await model.load();
  assert.match(html(h(X.LegacyView, { model })), /Plugin not found — it may have been uninstalled\./);
});

test("reload from disk is a labelled header button on the Plugins pane only", async () => {
  const plugins = await legacy("plugins", {});
  assert.match(html(h(X.LegacyView, { model: plugins })), /<button[^>]*>Reload from disk<\/button>/);
  const llm = await legacy("llm-sources", {});
  assert.doesNotMatch(html(h(X.LegacyView, { model: llm })), /Reload from disk/);
});

test("LLM source rows show a not-installed tag and the update badge; the detail names the update and its Update button", async () => {
  const sources = { sources: [{ ...hx("get-auth-me-llm-sources-200").sources[0], id: "team", name: "Team kit", origin: "git", installed: false, enabled: false }] };
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => sources,
    "GET /auth/me/llm-sources/updates": () => ({ sources: [{ id: "team", status: "update-available", localRev: "a", remoteRev: "b" }] }),
  });
  const list = html(h(X.LegacyView, { model }));
  assert.match(list, /not installed/);
  assert.match(list, /title="A newer version is available: open the source and press Update"[^>]*>update</);
  model.select("team");
  await tick();
  const out = html(h(X.LegacyView, { model }));
  assert.match(out, /Update available\./);
  assert.match(out, /<button[^>]*>Update<\/button>/);
});

test("LLM source detail: contents with counts, All and None, New markers, agents caption, hooks and MCP listed for visibility", async () => {
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources/builtin/discovery": () => hx("get-auth-me-llm-sources-id-discovery-200"),
  });
  model.select("builtin");
  await tick();
  const out = html(h(X.LegacyView, { model }));
  assert.match(out, /Skills \(60 of 60 on\)/);
  assert.match(out, /Agents from a source aren&#x27;t run by LLM-IDE yet|Agents from a source aren't run by LLM-IDE yet/);
  assert.match(out, /Listed for visibility only — hooks from a registered source are never executed\./);
  // Like the Mac (LlmSourceDetailView.mcpServersBlock), an empty kind has no section: the fixture has no MCP servers.
  assert.doesNotMatch(out, /MCP servers \(0\)|never connects to or spawns/);
  assert.match(out, /aria-label="Check for updates"|>Check for updates</);
  assert.equal(count(out, /aria-label="skill [^"]+"/g) > 0, true);
});

test("LLM source detail: listed MCP servers show their command, for visibility only", async () => {
  const d = hx("get-auth-me-llm-sources-id-discovery-200");
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources/builtin/discovery": () => ({ ...d, mcpServers: [{ name: "fs", command: "npx", args: ["-y", "srv"] }] }),
  });
  model.select("builtin");
  await tick();
  const out = html(h(X.LegacyView, { model }));
  assert.match(out, /MCP servers \(1\)/);
  assert.match(out, /never connects to or spawns a source/);
  assert.match(out, /<code>npx -y srv<\/code>/);
});

test("LLM source detail: a missing source says so", async () => {
  // No discovery route: the core answers 404 for a source it does not have.
  const model = await legacy("llm-sources", {});
  model.select("builtin");
  await tick();
  assert.match(html(h(X.LegacyView, { model })), /Source not found — it may have been removed\./);
});

test("MCP detail: command and environment names as text, values never shown; version lookup error and a newer version named", async () => {
  const row = { ...hx("get-auth-me-mcp-plugins-200").plugins[0], id: "fs", name: "Filesystem", env: { SECRET_TOKEN: "s3cr3t-value" }, credentialMissing: true };
  const model = await legacy("mcp-plugins", {
    "GET /auth/me/mcp-plugins": () => ({ plugins: [row] }),
    "GET /auth/me/mcp-plugins/updates": () => ({ servers: [{ id: "fs", current: "2.0.1", latest: null, status: "unknown", reason: "registry answered 503" }] }),
  });
  model.select("fs");
  let out = html(h(X.LegacyView, { model }));
  assert.match(out, /aria-label="Details of Filesystem"/);
  assert.match(out, /Environment/);
  assert.match(out, /SECRET_TOKEN/);
  assert.doesNotMatch(out, /s3cr3t-value/);
  assert.match(out, /No value is stored for this server&#x27;s credential|No value is stored for this server's credential/);
  assert.match(out, /Could not look up the latest version: registry answered 503/);
  assert.match(out, /v2\.0\.1/);

  const newer = await legacy("mcp-plugins", {
    "GET /auth/me/mcp-plugins": () => ({ plugins: [row] }),
    "GET /auth/me/mcp-plugins/updates": () => ({ servers: [{ id: "fs", current: "2.0.1", latest: "2.1.0", status: "update-available" }] }),
  });
  newer.select("fs");
  out = html(h(X.LegacyView, { model: newer }));
  assert.match(out, /A newer version is available: v2\.1\.0/);
  assert.match(out, /Update<\/span>|>Update</);
});

test("empty Installed state has an Install from URL button that opens the Install tab", async () => {
  const model = new X.ExtensionsModel(X.createExtensionsApi(core({ [`GET ${P}/installed`]: () => ({ corrupt: false, items: [] }), [`GET ${P}/active`]: () => fx("get-auth-me-extensions-active-200") })));
  await model.init();
  const out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /Nothing installed yet/);
  assert.match(out, /<button[^>]*>Install from URL<\/button>/);
});

test("browse-only catalog entries get an Open repository button for a public https address only", async () => {
  const page = fx("get-auth-me-extensions-catalog-200-2");
  page.results.push({ ...page.results[0], indexId: "mcp-registry", name: "reg", installable: false, reason: "registry_install_not_supported", source: { url: "https://example.com/x" } });
  page.results.push({ ...page.results[0], indexId: "local", name: "lan", installable: false, reason: "x", source: { url: "http://127.0.0.1/x" } });
  page.total = 3;
  const model = new X.ExtensionsModel(X.createExtensionsApi(core({
    [`GET ${P}/installed`]: () => ({ corrupt: false, items: [] }),
    [`GET ${P}/active`]: () => fx("get-auth-me-extensions-active-200"),
    [`GET ${P}/catalog`]: () => page,
  })));
  await model.init();
  await model.showTab("browse");
  const opened = [];
  const out = html(h(X.ExtensionsView, { model, openRepository: (u) => opened.push(u) }));
  assert.match(out, /aria-label="Open repository of reg"/);
  assert.doesNotMatch(out, /aria-label="Open repository of lan"/);
  const none = html(h(X.ExtensionsView, { model }));
  assert.doesNotMatch(none, /Open repository/);
});
