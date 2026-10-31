import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  const outfile = join(bundleDir("extensions"), "entry.mjs");
  await build({ entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") }, jsx: "automatic", logLevel: "silent" });
  X = await import(`${outfile}?t=${Date.now()}`);
  h = requireFromDesktop("react").createElement;
  html = (el) => requireFromDesktop("react-dom/server").renderToStaticMarkup(el);
});

const fx = (n) => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/extensions", `${n}.json`), "utf8")).response;
const E = "e".repeat(40);

function core(routes) {
  return { async request(method, path) { const r = routes[`${method} ${path.split("?")[0]}`]; return r ? { status: 200, body: r() } : { status: 404, body: { error: { code: "NOT_FOUND" } } }; } };
}
async function mk(items, extra = {}) {
  const model = new X.ExtensionsModel(X.createExtensionsApi(core({ [`GET ${P}/installed`]: () => ({ corrupt: false, items }), [`GET ${P}/active`]: () => fx("get-auth-me-extensions-active-200"), [`GET ${P}/catalog`]: () => fx("get-auth-me-extensions-catalog-200-2"), ...extra })));
  await model.init();
  return model;
}
const items = () => structuredClone(fx("get-auth-me-extensions-installed-200-2").items);
const runner = (over = {}) => ({ ...items().find((i) => i.id === "plugin:acme/runner"), declared: { executableKinds: ["hook", "mcp"] }, members: [{ memberId: "hook:Stop", type: "hook", name: "Stop", executable: true }, { memberId: "mcp:srv", type: "mcp", name: "srv", executable: true }], ...over });
const count = (s, re) => (s.match(re) ?? []).length;

test("tabs: a tablist with three tabs, aria-selected, one tabpanel labelled by the selected tab", async () => {
  const model = await mk(items());
  const out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /role="tablist"[^>]*aria-label="Extensions"/);
  assert.equal(count(out, /role="tab"/g), 3);
  assert.match(out, /id="ext-tab-installed"[^>]*aria-selected="true"/);
  assert.match(out, /role="tabpanel"[^>]*aria-labelledby="ext-tab-installed"/);
});

test("installed: a labelled listbox of options grouped by kind, aria-selected on the chosen one, badges as text", async () => {
  const it = items();
  it[0] = { ...it[0], update: { latest: "f".repeat(40), checkedAt: "2026-10-31" } };
  const model = await mk([runner({ update: { latest: "f".repeat(40), checkedAt: "x" } }), ...it.filter((i) => i.id !== "plugin:acme/runner")]);
  model.select("plugin:acme/runner");
  const out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /role="listbox"[^>]*aria-label="Installed extensions"/);
  assert.match(out, /aria-activedescendant="ext-row-plugin:acme\/runner"/);
  assert.ok(count(out, /role="option"/g) >= 3);
  assert.match(out, /role="option" aria-selected="true"/);
  assert.match(out, /Runs code/);
  assert.match(out, /Update available/);
  assert.match(out, /Unverified/);
  assert.match(out, />Skills </);
  assert.match(out, />Plugins </);
});

test("detail: an enable switch with a label, member checkboxes with labels, the full pinned commit, actions in a group", async () => {
  const model = await mk([runner({ update: { latest: "f".repeat(40), checkedAt: "x" }, previous: { pinnedCommit: "d".repeat(40), version: null, installedAt: null } })]);
  model.select("plugin:acme/runner");
  const out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /<input id="ext-switch-plugin:acme\/runner" type="checkbox" role="switch" aria-checked="false"/);
  assert.match(out, /<label for="ext-switch-plugin:acme\/runner">Disabled<\/label>/);
  assert.match(out, /Switching on asks for your consent first/);
  assert.equal(count(out, /type="checkbox" (?:checked="" )?id="ext-member-|id="ext-member-[^"]*" type="checkbox"/g), 2);
  assert.match(out, new RegExp(`<code class="ext-commit">${E}</code>`));
  assert.match(out, /role="group" aria-label="Actions"/);
  for (const b of ["Check for update", "Review update", "Roll back to dddddddd", "Repair", "Remove"]) assert.match(out, new RegExp(`>${b}<`), b);
});

test("detail: Rollback appears only with a previous version; Review update only with an update", async () => {
  const model = await mk([runner()]);
  model.select("plugin:acme/runner");
  const out = html(h(X.ExtensionsView, { model }));
  assert.ok(!out.includes("Roll back to"));
  assert.ok(!out.includes(">Review update<"));
});

test("scan warnings are text inside a details element, with the heuristic caveat", async () => {
  const model = await mk(items());
  model.select("plugin:acme/sketchy");
  const out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /<details class="ext-scan"><summary>Scan warnings \(3\)/);
  assert.match(out, /pipe_to_shell/);
  assert.match(out, /heuristic/);
  assert.ok(!out.includes("<script"));
});

test("hostile item text is rendered as text: markup is escaped, bidi and control characters are gone", async () => {
  const bad = runner({ name: "<img src=x onerror=alert(1)>‮gnp", description: "<script>alert(1)</script>\u0000" });
  const model = await mk([bad]);
  model.select("plugin:acme/runner");
  const out = html(h(X.ExtensionsView, { model }));
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!out.includes("‮"));
  assert.ok(!/<a\s/.test(out), "no links are rendered for item text");
});

test("consent sheet: a labelled modal dialog naming each kind and its commit; Apply is disabled until every kind is ticked", async () => {
  const model = await mk([runner()]);
  await model.requestEnable(model.item("plugin:acme/runner"));
  let out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /role="dialog" aria-modal="true" aria-labelledby="ext-consent-title"/);
  assert.match(out, /id="ext-consent-title"[^>]*>Allow runner to run code\?</);
  assert.match(out, /<label for="ext-consent-hook"><strong>Hooks<\/strong>/);
  assert.match(out, /<label for="ext-consent-mcp"><strong>MCP servers<\/strong>/);
  assert.match(out, /Declared: Stop/);
  assert.match(out, new RegExp(E));
  assert.match(out, /<button[^>]*disabled=""[^>]*aria-disabled="true"[^>]*>Allow and switch on</);
  model.tick("hook", true);
  out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /<button[^>]*disabled=""[^>]*>Allow and switch on</);
  model.tick("mcp", true);
  out = html(h(X.ExtensionsView, { model }));
  assert.ok(!/<button[^>]*disabled=""[^>]*>Allow and switch on</.test(out));
  assert.equal(count(out, /type="checkbox" id="ext-consent-|id="ext-consent-[a-z]+" type="checkbox" checked=""/g), 2);
});

test("confirm sheets name the item and the commit", async () => {
  const model = await mk([runner({ previous: { pinnedCommit: "d".repeat(40), version: null, installedAt: null } })]);
  const it = model.item("plugin:acme/runner");
  model.requestUninstall(it);
  let out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /id="ext-confirm-title"[^>]*>Remove runner\?</);
  assert.match(out, new RegExp(E));
  model.dismissSheet();
  model.requestRollback(it);
  out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /Roll back runner\?/);
  assert.match(out, new RegExp("d".repeat(40)));
  model.dismissSheet();
  model.requestRepair(it);
  assert.match(html(h(X.ExtensionsView, { model })), /Repair runner\?/);
});

test("preview sheet: flags, new code, scan delta, collapsed file groups with expandable controls", async () => {
  const preview = fx("post-auth-me-extensions-update-preview-200");
  const model = await mk([runner({ update: { latest: "f".repeat(40), checkedAt: "x" } })], { [`POST ${P}/update/preview`]: () => preview });
  const core2 = model;
  await core2.openPreview(model.item("plugin:acme/runner"));
  const out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /aria-labelledby="ext-preview-title"/);
  assert.match(out, /Adds a new kind of code that can run/);
  assert.match(out, /New code that can run/);
  assert.match(out, /Warnings before: 0\. After: 1\. Resolved: 0\. New: 1\./);
  assert.match(out, /aria-expanded="false"[^>]*>Show added \(2\)/);
  assert.ok(!out.includes("hooks/hooks.json"), "file rows are not rendered while a group is collapsed");
  assert.match(out, />Continue to consent</);
});

test("preview body with 200 files and 5000 counted: opened group mounts a bounded window and says it is cut short", async () => {
  const preview = JSON.parse(JSON.stringify(fx("post-auth-me-extensions-update-preview-200")));
  preview.files.added = Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.ts`, size: 10 }));
  preview.files.counts.added = 5000;
  preview.files.truncated = true;
  const model = await mk([runner()], { [`POST ${P}/update/preview`]: () => preview });
  await model.openPreview(model.item("plugin:acme/runner"));
  const sheet = model.getSnapshot().sheet;
  const out = html(h(X.PreviewBody, { preview: sheet.preview, initialHeight: 240, openGroups: true }));
  assert.match(out, /5,000 added/);
  assert.match(out, /cut short; the counts are complete/);
  const rows = count(out, /class="ext-filerow"/g);
  assert.ok(rows > 0 && rows < 40, `mounted ${rows} rows`);
  assert.match(out, /Only the first 200 are listed/);
});

test("browse: search box, kind select and Refresh labelled; installable shows Install, browse-only shows a badge with the reason", async () => {
  const page = fx("get-auth-me-extensions-catalog-200-2");
  page.results.push({ ...page.results[0], indexId: "mcp-registry", name: "reg", installable: false, reason: "registry_install_not_supported", source: { url: "https://example.com/x" } });
  page.total = 2;
  const model = await mk(items(), { [`GET ${P}/catalog`]: () => page });
  await model.showTab("browse");
  const out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /role="search"/);
  assert.match(out, /aria-label="Search the catalog"/);
  assert.match(out, /aria-label="Install pdf"/);
  assert.match(out, /Browse only/);
  assert.match(out, /MCP registry entries cannot be installed from here/);
  assert.match(out, /role="list" aria-label="Catalog results"/);
  assert.match(out, /aria-setsize="2"/);
  assert.match(out, /Only Refresh contacts GitHub and the MCP registry/);
  assert.match(out, /Refresh catalog/);
});

test("browse before the first refresh says the catalog has not been fetched", async () => {
  const model = await mk(items(), { [`GET ${P}/catalog`]: () => fx("get-auth-me-extensions-catalog-200") });
  await model.showTab("browse");
  const out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /The catalog has not been fetched yet/);
  assert.match(out, /role="status"/);
});

test("install tab: labelled fields, help text, result card with owner/repo and the full commit, scan findings as warnings", async () => {
  const model = await mk(items(), { [`POST ${P}/install`]: () => fx("post-auth-me-extensions-install-200-4") });
  await model.showTab("install");
  let out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /<label for="ext-install-url">GitHub address<\/label>/);
  assert.match(out, /<label for="ext-install-path">Folder inside the repository \(optional\)<\/label>/);
  assert.match(out, /aria-describedby="ext-install-help"/);
  model.setInstallUrl("https://github.com/acme/sketchy");
  await model.install();
  out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /aria-label="Installed"/);
  assert.match(out, /acme\/sketchy/);
  assert.match(out, new RegExp(E));
  assert.match(out, /The scan found 3 warnings/);
  assert.match(out, /Off/);
});

test("install form shows a validation error with role alert and marks the field invalid", async () => {
  const model = await mk(items());
  await model.showTab("install");
  model.setInstallUrl("ftp://x");
  await model.install();
  const out = html(h(X.ExtensionsView, { model }));
  assert.match(out, /aria-invalid="true"/);
  assert.match(out, /role="alert">Use a https:\/\/github\.com/);
});

test("notice with a retry button for a retryable failure; catalog-off banner", async () => {
  const model = await mk(items(), { [`POST ${P}/install`]: () => { throw 0; } });
  const out0 = html(h(X.ExtensionsView, { model }));
  assert.ok(!out0.includes("The extension catalog is turned off"));
  // drive the state through the real error path
  const m2 = new X.ExtensionsModel(X.createExtensionsApi({ async request(method, path) {
    if (path.endsWith("/installed")) return { status: 200, body: { corrupt: false, items: items() } };
    if (path.endsWith("/install")) return { status: 503, body: { error: { code: "VERIFY_UNAVAILABLE", details: { retryable: true } } } };
    return { status: 404, body: {} };
  } }));
  await m2.init();
  m2.setInstallUrl("https://github.com/acme/tidy");
  await m2.install();
  const out = html(h(X.ExtensionsView, { model: m2 }));
  assert.match(out, /GitHub could not confirm that commit right now\. Nothing was changed/);
  assert.match(out, />Try again</);
  const m3 = new X.ExtensionsModel(X.createExtensionsApi({ async request(m, p) { return p.endsWith("/installed") ? { status: 200, body: { corrupt: false, items: [] } } : { status: 404, body: { error: { code: "CATALOG_DISABLED" } } }; } }));
  await m3.init();
  m3.setInstallUrl("https://github.com/acme/tidy");
  await m3.install();
  assert.match(html(h(X.ExtensionsView, { model: m3 })), /The extension catalog is turned off on this server/);
});

test("corrupt record and empty states are announced", async () => {
  const m = new X.ExtensionsModel(X.createExtensionsApi({ async request() { return { status: 200, body: { corrupt: true, items: [] } }; } }));
  await m.init();
  const out = html(h(X.ExtensionsView, { model: m }));
  assert.match(out, /The installed record is unreadable/);
  assert.match(out, /Nothing installed yet/);
});

test("5,000 installed items render a bounded number of options", async () => {
  const base = items()[0];
  const many = Array.from({ length: 5000 }, (_, i) => ({ ...base, id: `skill:o/n${i}`, name: `n${i}` }));
  const model = await mk(many);
  const out = html(h(X.ExtensionsView, { model, initialHeight: 600 }));
  const n = count(out, /role="option"/g);
  assert.ok(n > 0 && n < 40, `mounted ${n}`);
  assert.match(out, />5,000</);
});

// ---- legacy panes -------------------------------------------------------------------------------
const hx = (n) => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures/health-auth", `${n}.json`), "utf8")).response;
const legacy = async (kind, routes) => {
  const model = new X.LegacyModel(X.createLegacyApi({ async request(method, path) { const r = routes[`${method} ${path}`]; return r ? { status: 200, body: r() } : { status: 404, body: {} }; } }), kind);
  await model.load();
  return model;
};

test("mcp pane: list with a labelled switch per row, consent badge, the command is shown as text", async () => {
  const model = await legacy("mcp-plugins", { "GET /auth/me/mcp-plugins": () => hx("get-auth-me-mcp-plugins-200") });
  const out = html(h(X.LegacyView, { model }));
  assert.match(out, /role="list" aria-label="MCP Plugins"/);
  assert.match(out, /role="switch" aria-checked="false"/);
  assert.match(out, /<label for="ext-leg-mcp-plugins-filesystem"><span class="ext-sr">Filesystem: <\/span>Off<\/label>/);
  assert.match(out, /No consent yet/);
  assert.match(out, /npx -y @modelcontextprotocol\/server-filesystem@2\.0\.1 \/tmp/);
});

test("mcp consent sheet: dialog naming what runs; Apply disabled until the box is ticked", async () => {
  const model = await legacy("mcp-plugins", { "GET /auth/me/mcp-plugins": () => hx("get-auth-me-mcp-plugins-200") });
  await model.setEnabled("filesystem", true);
  let out = html(h(X.LegacyView, { model }));
  assert.match(out, /role="dialog" aria-modal="true" aria-labelledby="ext-leg-title"/);
  assert.match(out, /Allow Filesystem to run\?/);
  assert.match(out, /<button[^>]*disabled=""[^>]*aria-disabled="true"[^>]*>Allow and switch on</);
  model.tickMcp(true);
  out = html(h(X.LegacyView, { model }));
  assert.ok(!/<button[^>]*disabled=""[^>]*>Allow and switch on</.test(out));
});

test("plugin pane: hook trust badge and a Review hooks button; the sheet lists each kind with a checkbox label", async () => {
  const plugin = { name: "runner", displayName: "Runner", enabled: true, format: "claude", hookCount: 1, declaresHooks: true, executableKinds: ["monitors"], hookNotes: ["note <b>x</b>"], hooksTrusted: false };
  const model = await legacy("plugins", { "GET /auth/me/plugins": () => ({ plugins: [plugin] }) });
  let out = html(h(X.LegacyView, { model }));
  assert.match(out, /Hooks not trusted/);
  assert.match(out, /aria-label="Review and trust hooks of Runner"/);
  model.requestHookTrust("runner");
  out = html(h(X.LegacyView, { model }));
  assert.match(out, /Trust the hooks of Runner\?/);
  assert.match(out, /<label for="ext-leg-hook-hooks"><strong>Hooks<\/strong>/);
  assert.match(out, /<label for="ext-leg-hook-monitors">/);
  assert.ok(out.includes("note &lt;b&gt;x&lt;/b&gt;"));
});

test("llm sources pane: counts as text, empty state when none", async () => {
  const model = await legacy("llm-sources", { "GET /auth/me/llm-sources": () => hx("get-auth-me-llm-sources-200") });
  const out = html(h(X.LegacyView, { model }));
  assert.match(out, /Central Skills/);
  assert.match(out, /60 skills · 1 agents · 15 commands/);
  const none = await legacy("llm-sources", { "GET /auth/me/llm-sources": () => ({ sources: [] }) });
  assert.match(html(h(X.LegacyView, { model: none })), /No LLM sources are registered/);
});
