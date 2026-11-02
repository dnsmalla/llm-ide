// W2a parity rows: LLM source Update confirmation and Mac button mapping, Ref and Reveal, plugin install source,
// read-only hook trust, component "ignored" rule, MCP headers / credential presence / source badge.
// Decoders are checked with fixture-shaped inline data (server route shapes, values redacted as the server sends them).
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

let X;
let L;
let D;
let h;
let html;
before(async () => {
  const { build } = requireFromDesktop("esbuild");
  const outfile = join(bundleDir("extensions-w2a"), "entry.mjs");
  await build({ entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") }, jsx: "automatic", logLevel: "silent" });
  X = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  L = await import("../legacy-labels.ts");
  D = await import("../legacy.ts");
  h = requireFromDesktop("react").createElement;
  html = (el) => requireFromDesktop("react-dom/server").renderToStaticMarkup(el);
});

const hx = (n) => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/health-auth", `${n}.json`), "utf8")).response;
const count = (s, re) => (s.match(re) ?? []).length;
const tick = () => new Promise((r) => setTimeout(r, 0));
const ok = (body) => ({ status: 200, body });

/** A scripted core; `hits` counts the writes so a test can prove nothing ran before Confirm. */
function core(routes, hits = {}) {
  return {
    async request(method, path) {
      const key = `${method} ${path.split("?")[0]}`;
      hits[key] = (hits[key] ?? 0) + 1;
      const r = routes[key];
      if (!r) return { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
      const body = r();
      if (body && typeof body === "object" && "__status" in body) return { status: body.__status, body: { error: body.error } };
      return ok(body);
    },
  };
}
async function legacy(kind, routes, hits) {
  const base = {
    "GET /auth/me/plugins": () => ({ plugins: [] }),
    "GET /auth/me/llm-sources": () => hx("get-auth-me-llm-sources-200"),
    "GET /auth/me/mcp-plugins": () => hx("get-auth-me-mcp-plugins-200"),
    "GET /auth/me/claude-plugins/updates": () => ({ cli: true, checkedAt: "x", updates: [] }),
    "GET /auth/me/codex-plugins/updates": () => ({ cli: false, checkedAt: "x", updates: [] }),
    "GET /auth/me/mcp-plugins/updates": () => ({ servers: [] }),
    "GET /auth/me/llm-sources/updates": () => ({ sources: [] }),
    "POST /auth/me/llm-sources/update": () => ({ ok: true, fromRev: "a", toRev: "b", added: [], removed: [], warnings: [] }),
  };
  const model = new X.LegacyModel(X.createLegacyApi(core({ ...base, ...routes }, hits)), kind);
  await model.load();
  return model;
}

const source = (over = {}) => ({ ...hx("get-auth-me-llm-sources-200").sources[0], id: "team", name: "Team kit", origin: "git", builtin: false, installed: true, location: "/Users/me/kits/team", ...over });
const plugin = (over = {}) => ({
  name: "runner",
  displayName: "Runner",
  version: "1.0.0",
  enabled: true,
  format: "claude",
  description: "runs things",
  skillCount: 0,
  hookCount: 0,
  mcpServerCount: 0,
  origin: null,
  commands: [],
  subagents: [],
  unsupportedComponents: [],
  pendingComponents: [],
  sdkReadable: true,
  nativePluginsOn: true,
  nativeDelivery: false,
  executableKinds: [],
  hookNotes: [],
  hooksTrusted: false,
  trustOutdated: false,
  trustOutdatedKinds: [],
  ...over,
});
const mcp = (over = {}) => ({
  id: "fs",
  name: "Filesystem",
  source: "catalog",
  transport: "stdio",
  command: "npx",
  args: ["-y", "srv"],
  builtin: false,
  enabled: false,
  consented: false,
  credentialMissing: false,
  ...over,
});

// ---- 1. Update confirmation ---------------------------------------------------------------------------------------

test("source Update opens a confirmation and runs nothing before Confirm; Cancel is the first control in the dialog", async () => {
  const hits = {};
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source()] }),
    "GET /auth/me/llm-sources/updates": () => ({ sources: [{ id: "team", status: "update-available" }] }),
    "GET /auth/me/llm-sources/team/discovery": () => ({ skills: [], agents: [], commands: [], templates: [], hooks: [], mcpServers: [] }),
  }, hits);
  model.select("team");
  await tick();
  const before = html(h(X.LegacyView, { model }));
  assert.match(before, /<button[^>]*>Update<\/button>/);
  model.requestSourceUpdate("team");
  assert.equal(hits["POST /auth/me/llm-sources/update"] ?? 0, 0, "no write before Confirm");
  const dialog = html(h(X.LegacyView, { model }));
  assert.match(dialog, /Update Team kit\?/);
  assert.match(dialog, /reset to its remote version/);
  // The core refuses a dirty folder (409) before reset --hard; only commits not on the remote are dropped.
  assert.match(dialog, /uncommitted changes, the update is refused and nothing changes/);
  assert.match(dialog, /\(origin\/main\) with git reset --hard, so commits in its folder that are not on the remote are discarded/);
  assert.doesNotMatch(dialog, /local changes in its folder are discarded/, "uncommitted edits are refused, never discarded");
  const cancelAt = dialog.indexOf(">Cancel<");
  const confirmAt = dialog.indexOf(">Update<", dialog.indexOf('role="dialog"'));
  assert.ok(cancelAt > 0 && confirmAt > cancelAt, "Cancel comes before the confirm button, so the dialog opens on it");
});

/** The button element with this label in a rendered element tree (LegacyDetail has no hooks, so it can be called as a function). */
function findButton(el, label) {
  if (Array.isArray(el)) {
    for (const c of el) {
      const f = findButton(c, label);
      if (f) return f;
    }
    return null;
  }
  if (!el || typeof el !== "object") return null;
  if (el.type === "button" && el.props?.children === label) return el;
  // A function component (SourceDetail) is expanded by calling it: none of them uses hooks.
  if (typeof el.type === "function") return findButton(el.type(el.props), label);
  return findButton(el.props?.children, label);
}

test("clicking the Update button opens the confirmation; only the dialog's Confirm sends the update", async () => {
  const hits = {};
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source()] }),
    "GET /auth/me/llm-sources/updates": () => ({ sources: [{ id: "team", status: "update-available" }] }),
  }, hits);
  model.select("team");
  await tick();
  const btn = findButton(X.LegacyDetail({ model, state: model.getSnapshot() }), "Update");
  assert.ok(btn, "the Update button is rendered for an available update");
  btn.props.onClick();
  assert.equal(hits["POST /auth/me/llm-sources/update"] ?? 0, 0, "the click alone sends nothing");
  assert.equal(model.getSnapshot().sheet?.kind, "source-update");
  await model.confirm();
  assert.equal(hits["POST /auth/me/llm-sources/update"], 1);
});

test("the Rescan button of a local folder runs its update directly (no confirmation)", async () => {
  const hits = {};
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source({ id: "loc", origin: "local", location: "/Users/me/loc" })] }),
    "GET /auth/me/llm-sources/updates": () => ({ sources: [{ id: "loc", status: "local" }] }),
  }, hits);
  model.select("loc");
  await tick();
  const btn = findButton(X.LegacyDetail({ model, state: model.getSnapshot() }), "Rescan");
  assert.ok(btn);
  await btn.props.onClick();
  assert.equal(model.getSnapshot().sheet, null);
  assert.equal(hits["POST /auth/me/llm-sources/update"], 1);
});

test("Cancel leaves the source alone; Confirm sends the one update request", async () => {
  const hits = {};
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source()] }),
    "GET /auth/me/llm-sources/updates": () => ({ sources: [{ id: "team", status: "update-available" }] }),
  }, hits);
  model.requestSourceUpdate("team");
  model.dismissSheet();
  assert.equal(model.getSnapshot().sheet, null);
  assert.equal(hits["POST /auth/me/llm-sources/update"] ?? 0, 0);
  model.requestSourceUpdate("team");
  await model.confirm();
  assert.equal(hits["POST /auth/me/llm-sources/update"], 1);
  assert.equal(model.getSnapshot().sheet, null);
});

test("Central Skills confirmation says what the server does: refused on local changes, then sync-skills.sh, no reset", async () => {
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources/updates": () => ({ sources: [{ id: "builtin", status: "update-available" }] }),
  });
  model.select("builtin");
  await tick();
  model.requestSourceUpdate("builtin");
  const dialog = html(h(X.LegacyView, { model }));
  assert.match(dialog, /fast-forwards/);
  assert.match(dialog, /refused/);
  assert.match(dialog, /scripts\/sync-skills\.sh/);
  assert.match(dialog, /\.skills folder and it moved, scripts\/sync-skills\.sh then/, "the core runs sync-skills.sh only for this checkout's .skills, and only when HEAD moved");
  assert.doesNotMatch(dialog, /local changes in its folder are discarded|git reset --hard/, "the reset wording belongs to git sources only");
});

test("Update is shown only when the core reports an update; an up-to-date source has no Update button", async () => {
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source()] }),
    "GET /auth/me/llm-sources/updates": () => ({ sources: [{ id: "team", status: "up-to-date" }] }),
  });
  model.select("team");
  await tick();
  const out = html(h(X.LegacyView, { model }));
  assert.doesNotMatch(out, />Update<\/button>/);
  assert.match(out, />Check for updates</);
});

// ---- 2. Mac button mapping, Ref, Reveal ---------------------------------------------------------------------------

test("a local folder shows Rescan (no confirmation, the same update route) and never Update", async () => {
  const hits = {};
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source({ id: "loc", origin: "local", location: "/Users/me/loc" })] }),
    "GET /auth/me/llm-sources/updates": () => ({ sources: [{ id: "loc", status: "local" }] }),
  }, hits);
  model.select("loc");
  await tick();
  const out = html(h(X.LegacyView, { model }));
  assert.match(out, />Rescan</);
  assert.doesNotMatch(out, />Update<\/button>/);
  await model.updateSource("loc");
  assert.equal(model.getSnapshot().sheet, null, "a rescan never opens the reset confirmation");
  assert.equal(hits["POST /auth/me/llm-sources/update"], 1);
});

test("a missing bundled kit shows Install, which calls the same update route", async () => {
  const hits = {};
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source({ id: "builtin", name: "Central Skills", origin: "builtin", builtin: true, installed: false, location: "/x/.skills" })] }),
  }, hits);
  model.select("builtin");
  await tick();
  const out = html(h(X.LegacyView, { model }));
  assert.match(out, />Install</);
  assert.doesNotMatch(out, />Update<\/button>/);
});

test("the Ref fact shows the branch a git source follows, and is absent when the source has none", async () => {
  const model = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source({ ref: "main" }), source({ id: "nore", name: "No ref", ref: undefined })] }),
  });
  model.select("team");
  await tick();
  assert.match(html(h(X.LegacyView, { model })), /<dt>Ref<\/dt><dd>main<\/dd>/);
  model.select("nore");
  await tick();
  assert.doesNotMatch(html(h(X.LegacyView, { model })), /<dt>Ref<\/dt>/);
});

test("Reveal appears only for a source folder inside the open project, and asks the host for the project-relative path", async () => {
  const revealed = [];
  const revealer = {
    canReveal: (loc) => L.projectRelativeOf(loc, "/Users/me/proj") !== null,
    reveal: (loc) => revealed.push(loc),
  };
  const inside = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source({ location: "/Users/me/proj/kits/team" })] }),
  });
  inside.select("team");
  await tick();
  const shown = html(h(X.LegacyView, { model: inside, revealer }));
  assert.match(shown, />Reveal</);
  const outside = await legacy("llm-sources", {
    "GET /auth/me/llm-sources": () => ({ sources: [source({ location: "/Users/me/other/team" })] }),
  });
  outside.select("team");
  await tick();
  assert.doesNotMatch(html(h(X.LegacyView, { model: outside, revealer })), />Reveal</);
  assert.doesNotMatch(html(h(X.LegacyView, { model: outside })), />Reveal</, "no revealer, no button");
});

test("projectRelativeOf: only absolute paths strictly inside the project root", () => {
  assert.equal(L.projectRelativeOf("/Users/me/proj/kits/team", "/Users/me/proj"), "kits/team");
  assert.equal(L.projectRelativeOf("/Users/me/proj", "/Users/me/proj"), "");
  assert.equal(L.projectRelativeOf("/Users/me/projx/kits", "/Users/me/proj"), null, "a sibling with the same prefix is outside");
  assert.equal(L.projectRelativeOf("/Users/me/proj/../secret", "/Users/me/proj"), null);
  assert.equal(L.projectRelativeOf("kits/team", "/Users/me/proj"), null, "a relative location is never revealed");
  assert.equal(L.projectRelativeOf("/Users/me/proj/kits", null), null, "no open project, no reveal");
  assert.equal(L.projectRelativeOf("C:\\Users\\me\\proj\\kits", "C:/Users/me/proj"), "kits");
});

// ---- 3. Plugin detail: install source and read-only hook trust ----------------------------------------------------

test("plugin decoder: install source, sdkReadable, nativePluginsOn, nativeDelivery and trustOutdatedKinds from the route's shape", () => {
  const [p] = D.decodePlugins({
    plugins: [
      plugin({
        installSource: { kind: "git", url: "https://example.com/r.git", ref: "v1", commit: "abcdef1234567", installedAt: "2026-10-01" },
        trustOutdated: true,
        trustOutdatedKinds: ["monitors", "sdk"],
        nativeDelivery: true,
      }),
    ],
  });
  assert.deepEqual(p.installSource, { kind: "git", url: "https://example.com/r.git", ref: "v1", commit: "abcdef1234567", entry: undefined, version: undefined, fileName: undefined });
  assert.equal(p.sdkReadable, true);
  assert.equal(p.nativePluginsOn, true);
  assert.equal(p.nativeDelivery, true);
  assert.deepEqual(p.trustOutdatedKinds, ["monitors", "sdk"]);
  // An older server sends none of these: undefined (the Mac's "nil") and empty lists, never a guessed value.
  const [old] = D.decodePlugins({ plugins: [plugin({ sdkReadable: undefined, nativePluginsOn: undefined, trustOutdatedKinds: undefined, installSource: null })] });
  assert.equal(old.sdkReadable, undefined);
  assert.equal(old.nativePluginsOn, undefined);
  assert.deepEqual(old.trustOutdatedKinds, []);
  assert.equal(old.installSource, undefined);
});

test("install source line: git, marketplace and zip wording as the Mac says it; nothing for an unknown kind", () => {
  assert.equal(L.installSourceText({ kind: "git", url: "https://example.com/r.git", ref: "v1", commit: "abcdef1234567" }), "From git: https://example.com/r.git @ v1 (abcdef1)");
  assert.equal(L.installSourceText({ kind: "git", url: "https://example.com/r.git" }), "From git: https://example.com/r.git");
  assert.equal(L.installSourceText({ kind: "marketplace", url: "https://example.com/m.git", entry: "lint", version: "2.1" }), "Marketplace: lint from https://example.com/m.git · v2.1");
  assert.equal(L.installSourceText({ kind: "zip", fileName: "tools.zip" }), "Installed from file tools.zip");
  assert.equal(L.installSourceText({ kind: "git" }), null, "a git source with no address says nothing");
  assert.equal(L.installSourceText({ kind: "future-kind", url: "x" }), null);
  assert.equal(L.installSourceText(undefined), null);
});

test("plugin detail shows the install source line from the list answer", async () => {
  const model = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin({ installSource: { kind: "git", url: "https://example.com/r.git", ref: "main" } })] }),
  });
  model.select("runner");
  assert.match(html(h(X.LegacyView, { model })), /From git: https:\/\/example\.com\/r\.git @ main/);
});

test("hook trust block is read-only: it states the core's trust state and offers no control", async () => {
  const model = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin({ hookCount: 2, hooksTrusted: false, enabled: false, executableKinds: ["hooks"], hookNotes: ["http hooks are not run here"] })] }),
  });
  model.select("runner");
  const out = html(h(X.LegacyView, { model }));
  const block = out.slice(out.indexOf('aria-label="Hook trust"'), out.indexOf("</section>", out.indexOf('aria-label="Hook trust"')));
  assert.match(block, /Not trusted/);
  assert.match(block, /http hooks are not run here/);
  assert.match(block, /Enable the plugin first/);
  assert.doesNotMatch(block, /<button|<input|type="checkbox"/, "no control in the read-only block");
});

test("hook trust block: an outdated trust names only the new kinds and warns about monitors", () => {
  const p = plugin({ hookCount: 1, trustOutdated: true, executableKinds: ["hooks", "monitors"], trustOutdatedKinds: ["monitors"] });
  assert.equal(L.hookTrustState(p), "Trust outdated");
  assert.equal(L.hooksHeading(p), "Hooks & scripts");
  const text = L.outdatedTrustText(p);
  assert.match(text, /now also declares background monitors/);
  assert.doesNotMatch(text, /declares hooks/, "the kinds the earlier trust covered are not named as new");
  assert.match(text, /Background monitors run outside the sandbox\./);
  assert.equal(L.hookTrustState(plugin({ hooksTrusted: true })), "Trusted");
  assert.equal(L.hookTrustState(plugin()), "Not trusted");
  assert.equal(L.hooksHeading(plugin({ hookCount: 1, executableKinds: ["hooks"] })), "Hooks");
});

// ---- 4. MCP detail: headers and credential presence, row badge ---------------------------------------------------

test("MCP decoder keeps header and env NAMES only, and a declared credential as presence", () => {
  const [m] = D.decodeMcpPlugins({
    plugins: [mcp({ headers: { Authorization: "••••" }, env: { SECRET_TOKEN: "••••" }, credential: { vaultKey: "api-key", label: "API key" }, credentialMissing: true })],
  });
  assert.deepEqual(m.headerKeys, ["Authorization"]);
  assert.deepEqual(m.envKeys, ["SECRET_TOKEN"]);
  assert.equal(m.hasCredential, true);
  assert.equal(m.credentialMissing, true);
  const [plain] = D.decodeMcpPlugins({ plugins: [mcp()] });
  assert.deepEqual(plain.headerKeys, []);
  assert.equal(plain.hasCredential, false);
});

test("MCP detail: header names and credential presence (set or not set), never a value", async () => {
  const model = await legacy("mcp-plugins", {
    "GET /auth/me/mcp-plugins": () => ({ plugins: [mcp({ headers: { Authorization: "Bearer sk-live-123" }, credential: { vaultKey: "api-key" }, credentialMissing: true })] }),
  });
  model.select("fs");
  await tick();
  let out = html(h(X.LegacyView, { model }));
  assert.match(out, /<dt>Headers<\/dt><dd>Authorization<\/dd>/);
  assert.match(out, /<dt>Credential<\/dt><dd>not set<\/dd>/);
  assert.doesNotMatch(out, /sk-live-123|Bearer/);

  const set = await legacy("mcp-plugins", {
    "GET /auth/me/mcp-plugins": () => ({ plugins: [mcp({ credential: { vaultKey: "api-key" }, credentialMissing: false })] }),
  });
  set.select("fs");
  await tick();
  out = html(h(X.LegacyView, { model: set }));
  assert.match(out, /<dt>Credential<\/dt><dd>set<\/dd>/);
  assert.doesNotMatch(out, /<dt>Headers<\/dt>/, "no headers, no Headers fact");
});

test("MCP list row shows the Mac's source badge, not the raw source", async () => {
  const model = await legacy("mcp-plugins", {
    "GET /auth/me/mcp-plugins": () => ({ plugins: [mcp({ id: "a", name: "A", source: "claude" }), mcp({ id: "b", name: "B", source: "user-typed-value" }), mcp({ id: "c", name: "C", source: "plugin" })] }),
  });
  const out = html(h(X.LegacyView, { model }));
  assert.match(out, /ext-row-meta">claude · stdio/);
  assert.match(out, /ext-row-meta">manual · stdio/);
  assert.match(out, /ext-row-meta">plugin · stdio/);
  assert.doesNotMatch(out, /user-typed-value/);
});

test("mcpSourceBadge follows the Mac: four known sources stay as they are, anything else is manual", () => {
  for (const s of ["catalog", "claude", "codex", "plugin"]) assert.equal(L.mcpSourceBadge(s), s);
  assert.equal(L.mcpSourceBadge("manual"), "manual");
  assert.equal(L.mcpSourceBadge(""), "manual");
  assert.equal(L.mcpSourceBadge("__proto__"), "manual");
});

// ---- 5. "ignored" is wrong when native plugin loading is on -------------------------------------------------------

test("componentStatus: ignored only when nothing here runs the component", () => {
  const on = { executableKinds: ["monitors"], sdkReadable: true, nativePluginsOn: true };
  assert.equal(L.componentStatus("monitors", on), "agentEngine");
  assert.equal(L.componentStatus("monitors", { ...on, nativePluginsOn: false }), "nativeOff");
  assert.equal(L.componentStatus("monitors", { ...on, sdkReadable: false }), "ignored", "a Codex layout never reaches the SDK");
  assert.equal(L.componentStatus("monitors", { ...on, executableKinds: [] }), "ignored", "the package does not declare it");
  assert.equal(L.componentStatus("themes", { executableKinds: ["themes"], sdkReadable: true, nativePluginsOn: true }), "ignored", "a component no runner knows");
  assert.equal(L.componentStatus(".lsp.json", { executableKinds: ["lsp"], sdkReadable: true, nativePluginsOn: true }), "agentEngine");
  assert.equal(L.componentStatus("bin", { executableKinds: ["bin"] }), "agentEngine", "missing older-server fields read as on, as the Mac does");
  assert.equal(L.componentStatus("constructor", { executableKinds: ["constructor"] }), "ignored", "a name on Object.prototype is not a component");
});

test("component rows: native loading on says the agent engine runs it (with the trust state); off says why; a Codex layout stays ignored", async () => {
  const on = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin({ unsupportedComponents: ["monitors"], executableKinds: ["monitors"], sdkReadable: true, nativePluginsOn: true, hooksTrusted: false })] }),
  });
  on.select("runner");
  let out = html(h(X.LegacyView, { model: on }));
  assert.match(out, /monitors — run by the agent engine once you trust this plugin/);
  assert.doesNotMatch(out, /monitors — unsupported, ignored/);

  const trusted = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin({ unsupportedComponents: ["monitors"], executableKinds: ["monitors"], hooksTrusted: true, enabled: false })] }),
  });
  trusted.select("runner");
  assert.match(html(h(X.LegacyView, { model: trusted })), /monitors — will run once you enable this plugin \(trusted\)/);

  const off = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin({ unsupportedComponents: ["monitors"], executableKinds: ["monitors"], nativePluginsOn: false })] }),
  });
  off.select("runner");
  assert.match(html(h(X.LegacyView, { model: off })), /monitors — not run while native plugin loading is off/);

  const codex = await legacy("plugins", {
    "GET /auth/me/plugins": () => ({ plugins: [plugin({ unsupportedComponents: ["monitors"], executableKinds: ["monitors"], sdkReadable: false, nativePluginsOn: true })] }),
  });
  codex.select("runner");
  assert.match(html(h(X.LegacyView, { model: codex })), /monitors — unsupported, ignored/);
});

test("componentRowText: a trusted, enabled plugin's component says it runs", () => {
  const p = { executableKinds: ["lsp"], sdkReadable: true, nativePluginsOn: true, hooksTrusted: true, enabled: true };
  assert.equal(L.componentRowText(".lsp.json", p), ".lsp.json — run by the agent engine (trusted)");
  assert.equal(L.componentRowText("themes", p), "themes — unsupported, ignored");
});
