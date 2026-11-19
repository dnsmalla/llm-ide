// Phase 4: one Extensions screen. Four Installed views, a Problems filter on each, the Add tab's choices opening the
// existing dialogs, deep links (including chat commands), the sidebar's problem count and a wording guard.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
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
  const outfile = join(bundleDir("extensions-one-screen"), "entry.mjs");
  await build({ entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") }, jsx: "automatic", logLevel: "silent" });
  X = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  h = requireFromDesktop("react").createElement;
  html = (el) => requireFromDesktop("react-dom/server").renderToStaticMarkup(el);
});

const fx = (dir, n) => JSON.parse(readFileSync(join(REPO, "schema/http", "fixtures", dir, `${n}.json`), "utf8")).response;
const plugin = (name) => ({ name, displayName: name, version: "1.0.0", enabled: true, format: "claude", description: "", skillCount: 0, hookCount: 0, mcpServerCount: 0, origin: null, commands: [], subagents: [], unsupportedComponents: [], pendingComponents: [], sdkReadable: true, nativePluginsOn: true, nativeDelivery: false, executableKinds: [], hookNotes: [], hooksTrusted: false, trustOutdated: false, trustOutdatedKinds: [] });
function core(routes) {
  return { async request(method, path) { const r = routes[`${method} ${path.split("?")[0]}`]; return r ? { status: 200, body: r() } : { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } }; } };
}
async function screenModels() {
  const c = core({
    [`GET ${P}/installed`]: () => ({ corrupt: false, items: [] }),
    [`GET ${P}/active`]: () => fx("extensions", "get-auth-me-extensions-active-200"),
    "GET /auth/me/plugins": () => ({ plugins: [plugin("runner"), plugin("other")] }),
    "GET /auth/me/llm-sources": () => fx("health-auth", "get-auth-me-llm-sources-200"),
    "GET /auth/me/mcp-plugins": () => fx("health-auth", "get-auth-me-mcp-plugins-200"),
  });
  const model = new X.ExtensionsModel(X.createExtensionsApi(c));
  await model.init();
  const api = X.createLegacyApi(c);
  const legacy = Object.fromEntries(["plugins", "mcp-plugins", "llm-sources"].map((k) => [k, new X.LegacyModel(api, k)]));
  for (const m of Object.values(legacy)) await m.load();
  return { model, legacy };
}

test("Installed has four views; the Catalog is the default and each deep-linked view renders its own list", async () => {
  const { model, legacy } = await screenModels();
  const out = html(h(X.ExtensionsView, { model, legacy }));
  assert.match(out, /role="tablist" aria-label="Kind of extension"/);
  for (const l of ["Catalog", "Plugins", "MCP servers", "Skill kits"]) assert.match(out, new RegExp(`role="tab"[^>]*>${l}</button>`));
  assert.match(out, /Nothing installed yet/, "the catalog list");
  for (const [anchor, label] of [["plugins", "Plugins"], ["mcp-plugins", "MCP servers"], ["llm-sources", "Skill kits"]]) {
    const v = html(h(X.ExtensionsView, { model, legacy, request: { id: anchor, n: 1 } }));
    assert.match(v, new RegExp(`role="list" aria-label="${label}"`), anchor);
    assert.doesNotMatch(v, /Nothing installed yet/);
  }
});

test("the Problems filter works on a legacy view: only rows with a known problem stay", async () => {
  const { legacy } = await screenModels();
  const m = legacy.plugins;
  const key = `${X.HEALTH_KIND.plugins}:runner`;
  const rows = m.getSnapshot().rows;
  const health = { [key]: { status: "problem", problems: [] } };
  assert.deepEqual(X.filterRows(rows, "", { only: true, kind: "plugins", health }).map((r) => r.id), ["runner"]);
  assert.equal(X.filterRows(rows, "", { only: false, kind: "plugins", health }).length, 2);
  m.setProblemsOnly(true);
  const out = html(h(X.LegacyView, { model: m }));
  assert.match(out, /aria-pressed="true">Problems</);
  assert.match(out, /No item has a known problem/);
  assert.equal(X.countProblems(health), 1);
});

test("the Add tab lists every way to add, and each choice opens the existing dialog for its kind", async () => {
  const { model, legacy } = await screenModels();
  await model.showTab("install");
  const state = model.getSnapshot();
  const out = html(h(X.AddTab, { model, state, legacy, initialChoice: null }));
  for (const c of X.ADD_CHOICES) assert.ok(out.includes(`>${c.label}</button>`), c.label);
  assert.deepEqual(X.ADD_CHOICES.map((c) => c.label), ["From the catalog", "From GitHub", "Plugin from Git", "Import from Claude Code", "Import from Codex", "MCP server", "Skill kit"]);
  const dialogs = { git: "Add a plugin from Git", claude: "Import from Claude Code", codex: "Import from Codex", mcp: "Add an MCP server", kit: "Add a skill kit" };
  for (const [choice, title] of Object.entries(dialogs)) {
    const d = html(h(X.AddTab, { model, state, legacy, initialChoice: choice }));
    assert.match(d, new RegExp(`<h2[^>]*>${title}</h2>`), choice);
  }
  const gh = html(h(X.AddTab, { model, state, legacy, initialChoice: "github" }));
  assert.match(gh, /aria-label="Install from GitHub"/);
  assert.doesNotMatch(html(h(X.AddTab, { model, state, legacy, initialChoice: "catalog" })), /<h2/);
  assert.deepEqual(X.ADD_CHOICES.filter((c) => c.kind).map((c) => [c.id, c.kind]), [["git", "plugins"], ["claude", "plugins"], ["codex", "plugins"], ["mcp", "mcp-plugins"], ["kit", "llm-sources"]]);
});

test("the Add tab's catalog choice goes to Browse", async () => {
  const { model, legacy } = await screenModels();
  assert.equal(model.getSnapshot().tab, "installed");
  await model.showTab("install");
  assert.equal(model.getSnapshot().tab, "install");
  const out = html(h(X.ExtensionsView, { model, legacy }));
  assert.match(out, /id="ext-tab-install"[^>]*aria-selected="true"[^>]*>Add</);
});

test("deep links: every old pane id and extensions:add resolve to the one entry with the right tab and view", () => {
  assert.deepEqual(X.targetFor("plugins"), { tab: "installed", view: "plugins" });
  assert.deepEqual(X.targetFor("mcp-plugins"), { tab: "installed", view: "mcp-plugins" });
  assert.deepEqual(X.targetFor("llm-sources"), { tab: "installed", view: "llm-sources" });
  assert.deepEqual(X.targetFor("extensions"), { tab: "installed", view: "catalog" });
  assert.deepEqual(X.targetFor("extensions:add"), { tab: "install", view: "catalog" });
  assert.equal(X.targetFor("constructor"), null);
  assert.equal(X.targetFor("connectors"), null);
  for (const a of ["plugins", "mcp-plugins", "llm-sources", "extensions", "extensions:add"]) assert.equal(X.entryFor(a), "extensions");
  assert.equal(X.entryFor("email"), "email", "other entries are their own");
});

test("deep links from chat commands and the MCP notice reach a pane that exists", async () => {
  const { BUILTINS } = await import("../../../chat/slash/builtins.ts");
  const { splitSectionTarget } = await import("../../../chat/slash/section-target.ts");
  const lib = BUILTINS.map((b) => b.action).filter((a) => a.kind === "openSection" && a.section.startsWith("library:"));
  assert.ok(lib.length >= 4);
  for (const a of lib) {
    const { base, pane } = splitSectionTarget(a.section);
    assert.equal(base, "library");
    assert.ok(X.targetFor(pane), a.section);
  }
  assert.deepEqual(splitSectionTarget("library:extensions:add"), { base: "library", pane: "extensions:add" });
  assert.deepEqual(splitSectionTarget("loop"), { base: "loop", pane: "" });
  for (const f of ["../../../chat/MessageView.tsx", "../../../chat/surface.tsx"]) {
    for (const m of readFileSync(join(HERE, f), "utf8").matchAll(/section: "library", anchor: ([^}]+?) \}/g)) {
      for (const id of m[1].match(/"([a-z]+-[a-z]+|plugins)"/g) ?? []) assert.ok(X.targetFor(id.slice(1, -1)), `${f} ${id}`);
    }
  }
});

test("the problem count the sidebar shows is the total of the lists' known problems", () => {
  X.problemStore.reset();
  let seen = 0;
  const off = X.problemStore.subscribe(() => { seen++; });
  X.problemStore.set("catalog", 2);
  X.problemStore.set("plugins", 1);
  X.problemStore.set("plugins", 1);
  assert.equal(X.problemStore.getSnapshot(), 3);
  assert.equal(seen, 2, "an unchanged count does not notify");
  X.problemStore.set("catalog", 0);
  assert.equal(X.problemStore.getSnapshot(), 1);
  off();
  X.problemStore.reset();
});

// ---- wording guard ---------------------------------------------------------------------------------------------------
// Scans the string literals and JSX text of the extensions screen and the Library sidebar for words and internals a user
// must never read (see the plan's Vocabulary table). Comments and identifiers are not scanned.
const BANNED = [/MCP Plugin/i, /LLM Source/i, /Skill bundle/i, /Uninstall/, /\bEnabled\b/, /\bDisabled\b/, /\bEnable\b/, /\bDisable\b/, /LLMIDE_/, /\.json\b/, /git reset/, /mcp__/, /Remove server/, /Remove source/];
// A literal that is code, not text a user reads: wire values, routes and decoder keys. Each needs a reason.
const ALLOW = [
  { file: "legacy-labels.ts", text: ".lsp.json", why: "the core's component name, mapped to a plain label before display" },
  { file: "legacy.ts", text: "mcp-plugins", why: "route and kind ids" },
];

const SKILL_KIT_FILES = ["LegacyPane.tsx", "LegacyDetail.tsx", "legacy.ts", "legacy-labels.ts"];
const SOURCE_OK = ["Claude plugin source"]; // the Import dialog's tab label: where a Claude Code plugin comes from

function literals(src) {
  const out = [];
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, a) => a + " ".repeat(m.length - a.length));
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  // JSX text: between a closing > and the next < on a line, with no braces or quotes.
  for (const m of code.matchAll(/>([^<>{}"'\n]*[A-Za-z][^<>{}"'\n]*)</g)) out.push(m[1]);
  return out;
}

test("wording guard: no banned word or internal reaches a user-visible string in the extensions screen or the sidebar", () => {
  const dir = resolve(HERE, "..");
  const files = [...readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f)), resolve(dir, "../LibraryNav.tsx")];
  const bad = [];
  for (const f of files) {
    const name = f.slice(f.lastIndexOf("/") + 1);
    for (const s of literals(readFileSync(f, "utf8"))) {
      if (ALLOW.some((a) => a.file === name && s.includes(a.text))) continue;
      // Wire and style tokens (kind ids, class names, routes) have no spaces or capitals around the banned word.
      if (/^[a-z0-9:_\-\/.${}]+$/.test(s)) continue;
      // In the skill-kit files, text a user reads must say "skill kit", not "source" (other files use "source" for repositories).
      if (SKILL_KIT_FILES.includes(name) && /\s/.test(s) && /[A-Z]/.test(s) && !s.startsWith("/") && /\bsources?\b/i.test(s) && !SOURCE_OK.some((t) => s.includes(t))) bad.push(`${name}: ${JSON.stringify(s.slice(0, 90))} says source for a skill kit`);
      for (const re of BANNED) if (re.test(s)) bad.push(`${name}: ${JSON.stringify(s.slice(0, 90))} matches ${re}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("wording guard catches what it is meant to catch", () => {
  const found = literals('const a = "Open MCP Plugins"; const b = <p>LLM Sources arrive</p>; // "Uninstall" in a comment');
  assert.ok(found.some((s) => /MCP Plugin/.test(s)));
  assert.ok(found.some((s) => /LLM Source/.test(s)));
  assert.ok(!found.some((s) => /Uninstall/.test(s)), "comments are not scanned");
});
