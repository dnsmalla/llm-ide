// Health fixes and automatic checks, through the real models and the rendered detail (Health has no hooks, so
// the element tree can be walked and a button's onClick called).
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
let X, h, html;
before(async () => {
  const { build } = requireFromDesktop("esbuild");
  const outfile = join(bundleDir("extensions-health-actions"), "entry.mjs");
  await build({ entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") }, jsx: "automatic", logLevel: "silent" });
  X = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  h = requireFromDesktop("react").createElement;
  html = (el) => requireFromDesktop("react-dom/server").renderToStaticMarkup(el);
});

const hx = (n) => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/health-auth", `${n}.json`), "utf8")).response;
const tick = () => new Promise((r) => setTimeout(r, 0));
const problem = (fix, extra = {}) => ({ status: "problem", checkedAt: Date.now(), problems: [{ code: "X", message: "Something is wrong.", fix, ...extra }] });

/** A scripted core recording every call as "METHOD path". */
function core(routes, calls) {
  return {
    async request(method, path, body) {
      const key = `${method} ${path.split("?")[0]}`;
      calls.push({ key, body });
      const r = routes[key];
      if (!r) return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      return { status: 200, body: r(body) };
    },
  };
}
const plugin = (over = {}) => ({ name: "runner", displayName: "Runner", version: "1", enabled: true, format: "claude", skillCount: 0, hookCount: 0, mcpServerCount: 0, origin: "claude", commands: [], subagents: [], unsupportedComponents: [], pendingComponents: [], executableKinds: [], hookNotes: [], hooksTrusted: false, trustOutdated: false, trustOutdatedKinds: [], ...over });
const mcp = (over = {}) => ({ id: "fs", name: "Filesystem", source: "catalog", transport: "stdio", command: "npx", args: [], builtin: false, enabled: true, consented: true, credentialMissing: false, ...over });
const source = (over = {}) => ({ ...hx("get-auth-me-llm-sources-200").sources[0], id: "team", name: "Team kit", origin: "git", builtin: false, installed: true, location: "/x/team", ...over });

async function legacy(kind, rows, health, calls) {
  const routes = {
    "GET /auth/me/plugins": () => ({ plugins: kind === "plugins" ? rows : [] }),
    "GET /auth/me/llm-sources": () => ({ sources: kind === "llm-sources" ? rows : [] }),
    "GET /auth/me/mcp-plugins": () => ({ plugins: kind === "mcp-plugins" ? rows : [] }),
    "GET /auth/me/claude-plugins/updates": () => ({ cli: true, checkedAt: "x", updates: [] }),
    "GET /auth/me/codex-plugins/updates": () => ({ cli: false, checkedAt: "x", updates: [] }),
    "GET /auth/me/mcp-plugins/updates": () => ({ servers: [] }),
    "GET /auth/me/llm-sources/updates": () => ({ sources: [] }),
    "POST /auth/me/llm-sources/update": () => ({ ok: true, fromRev: "a", toRev: "b", added: [], removed: [], warnings: [] }),
    "POST /auth/me/mcp-plugins/toggle": (b) => ({ ok: true, enabled: b.enabled }),
    "POST /auth/me/mcp-plugins/consent": () => ({ ok: true, consented: true }),
    "POST /auth/me/plugins/toggle": (b) => ({ ok: true, enabled: b.enabled }),
    "POST /auth/me/extensions/check": () => health,
  };
  const model = new X.LegacyModel(X.createLegacyApi(core(routes, calls)), kind);
  await model.load();
  return model;
}
const checks = (calls) => calls.filter((c) => c.key === "POST /auth/me/extensions/check");

function findButton(el, label) {
  if (Array.isArray(el)) { for (const c of el) { const f = findButton(c, label); if (f) return f; } return null; }
  if (!el || typeof el !== "object") return null;
  if (el.type === "button" && el.props?.children === label) return el;
  if (typeof el.type === "function") return findButton(el.type(el.props), label);
  return findButton(el.props?.children, label);
}
const detail = (model) => X.LegacyDetail({ model, state: model.getSnapshot() });

test("selecting an MCP server sends no check; selecting a plugin or a skill kit does", async () => {
  const c1 = [];
  const m = await legacy("mcp-plugins", [mcp()], problem("none"), c1);
  m.select("fs"); await tick();
  assert.equal(checks(c1).length, 0);
  const c2 = [];
  const p = await legacy("plugins", [plugin()], problem("none"), c2);
  p.select("runner"); await tick();
  assert.deepEqual(checks(c2).map((c) => c.body), [{ kind: "plugin", id: "runner" }]);
  const c3 = [];
  const s = await legacy("llm-sources", [source()], problem("none"), c3);
  s.select("team"); await tick();
  assert.deepEqual(checks(c3).map((c) => c.body), [{ kind: "skill-kit", id: "team" }]);
});

test("an automatic check that fails raises no notice and is not retried on the next open", async () => {
  const calls = [];
  const model = await legacy("plugins", [plugin()], null, calls);
  const routes404 = new X.LegacyModel(X.createLegacyApi({ request: async (m, p) => (p.endsWith("/check") ? (calls.push({ key: "POST /auth/me/extensions/check" }), { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }) : { status: 200, body: p === "/auth/me/plugins" ? { plugins: [plugin()] } : {} }) }), "plugins");
  await routes404.load();
  routes404.select("runner"); await tick();
  assert.equal(routes404.getSnapshot().notice, null);
  routes404.select(null); routes404.select("runner"); await tick();
  assert.equal(checks(calls).length, 1);
  void model;
});

test("each fix button runs its own action on its own item", async () => {
  // MCP: Switch off switches that server off and removes nothing; Allow… opens the consent sheet.
  const calls = [];
  const m = await legacy("mcp-plugins", [mcp()], problem("switch-off"), calls);
  m.select("fs"); await m.check("fs");
  await findButton(detail(m), "Switch off").props.onClick();
  assert.ok(calls.some((c) => c.key === "POST /auth/me/mcp-plugins/toggle" && c.body.id === "fs" && c.body.enabled === false));
  assert.ok(!calls.some((c) => c.key.startsWith("DELETE")));
  const c2 = [];
  const m2 = await legacy("mcp-plugins", [mcp({ consented: false, enabled: false })], problem("consent"), c2);
  m2.select("fs"); await m2.check("fs");
  findButton(detail(m2), "Allow…").props.onClick();
  assert.equal(m2.getSnapshot().sheet?.kind, "mcp");
  assert.equal(m2.getSnapshot().sheet?.id, "fs");
  // Skill kit: Repair re-runs that source's update.
  const c3 = [];
  const s = await legacy("llm-sources", [source()], problem("repair"), c3);
  s.select("team"); await tick(); await s.check("team");
  await findButton(detail(s), "Repair").props.onClick();
  assert.deepEqual(c3.filter((c) => c.key === "POST /auth/me/llm-sources/update").map((c) => c.body), [{ id: "team" }]);
  // Plugin: consent opens the hook-trust sheet of that plugin.
  const p = await legacy("plugins", [plugin({ hookCount: 1, executableKinds: ["hook"] })], problem("consent"), []);
  p.select("runner"); await tick(); await p.check("runner");
  findButton(detail(p), "Allow…").props.onClick();
  assert.equal(p.getSnapshot().sheet?.kind, "hooks");
});

test("a plugin's repair offers no button and never runs an update; a fix with no action gets the hint", async () => {
  const calls = [];
  const p = await legacy("plugins", [plugin()], problem("repair"), calls);
  p.select("runner"); await tick();
  const out = html(detail(p));
  assert.match(out, /Remove this plugin and install it again from its source\./);
  assert.doesNotMatch(out, />Repair</);
  assert.ok(!calls.some((c) => c.key === "POST /auth/me/claude-plugins/update"));
  const m = await legacy("mcp-plugins", [mcp()], problem("repair"), []);
  m.select("fs"); await m.check("fs");
  assert.match(html(detail(m)), /Fix it, then press Check\./);
});

test("after a fix, a server the user pressed Check on is checked again", async () => {
  const calls = [];
  const m = await legacy("mcp-plugins", [mcp()], problem("switch-off"), calls);
  await m.check("fs");
  const n = checks(calls).length;
  await m.setEnabled("fs", false);
  assert.equal(checks(calls).length, n + 1);
});

test("bulk switching sends no check and clears the old results", async () => {
  const calls = [];
  const m = await legacy("mcp-plugins", [mcp({ id: "a", name: "A" }), mcp({ id: "b", name: "B" })], problem("none"), calls);
  await m.check("a"); await m.check("b");
  const n = checks(calls).length;
  m.toggleChecked("a"); m.toggleChecked("b");
  await m.bulkSwitch(false);
  assert.equal(checks(calls).length, n);
  assert.deepEqual(Object.keys(m.getSnapshot().health), []);
});

test("results of rows that are no longer listed are dropped on the next load", async () => {
  const calls = [];
  let rows = [mcp({ id: "a" }), mcp({ id: "b" })];
  const model = new X.LegacyModel(X.createLegacyApi(core({
    "GET /auth/me/mcp-plugins": () => ({ plugins: rows }),
    "GET /auth/me/mcp-plugins/updates": () => ({ servers: [] }),
    "POST /auth/me/extensions/check": () => problem("none"),
  }, calls)), "mcp-plugins");
  await model.load(); await model.check("a"); await model.check("b");
  rows = [mcp({ id: "a" })];
  await model.load();
  assert.deepEqual(Object.keys(model.getSnapshot().health), ["mcp:a"]);
});
