// Server-render tests for the Settings components: ARIA roles and names, write-only secret
// inputs, virtualisation, destructive-confirm gating. Components are bundled with esbuild
// next to desktop/node_modules so `react` resolves to one copy (same approach as ui/kit/tests).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = resolve(HERE, "..");
const REPO = resolve(SETTINGS, "../../..");
const DESKTOP = join(REPO, "desktop");
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";
const req = createRequire(join(DESKTOP, "package.json"));
const { build } = req("esbuild");
const { createElement: h } = req("react");
const { renderToStaticMarkup } = req("react-dom/server");

const fx = (rel) => JSON.parse(readFileSync(join(REPO, "schema/http/fixtures", rel), "utf8"));
const html = (el) => renderToStaticMarkup(el);

let m;
before(async () => {
  const outdir = bundleDir("settings");
  await build({
    entryPoints: {
      screen: join(SETTINGS, "SettingsScreen.tsx"),
      providers: join(SETTINGS, "sections/ProvidersSection.tsx"),
      history: join(SETTINGS, "sections/AgentHistorySection.tsx"),
      ui: join(SETTINGS, "ui.tsx"),
      context: join(SETTINGS, "context.tsx"),
      registry: join(SETTINGS, "registry.ts"),
      groups: join(SETTINGS, "groups.ts"),
      notices: join(SETTINGS, "sections/NoticeSections.tsx"),
      toolperm: join(SETTINGS, "sections/ToolPermissionsSection.tsx"),
      sdk: join(SETTINGS, "sections/AgentSdkSection.tsx"),
      registryDefault: join(SETTINGS, "registry-default.ts"),
      historyModel: join(SETTINGS, "agent-history-model.ts"),
      secret: join(SETTINGS, "secret-field.ts"),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    logLevel: "silent",
    loader: { ".css": "empty" },
    alias: {
      "@llmide/ui-kit/styles.css": join(REPO, "ui/kit/src/styles/kit.css"),
      "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts"),
    },
  });
  const t = `?t=${Date.now()}`;
  m = {};
  for (const k of ["screen", "providers", "history", "ui", "context", "registry", "groups", "notices", "toolperm", "sdk", "registryDefault", "historyModel", "secret"]) m[k] = await import(join(outdir, `${k}.js`) + t);
});

const env = (client) => ({ client, host: { diagnostics: async () => ({}), copyText: async () => {} } });

const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), map: m };
};

function twoGroupRegistry() {
  const reg = new m.registry.SettingsRegistry();
  reg.registerSection({ id: "a", title: "Alpha", order: 1, load: async () => ({ default: () => h("p", null, "ALPHA-BODY") }) });
  reg.registerSection({ id: "b", title: "Beta", order: 2, load: async () => ({ default: () => h("p", null, "BETA-BODY") }) });
  reg.registerSection({ id: "p", title: "Proj", order: 3, band: "project", load: async () => ({ default: () => null }) });
  reg.registerCard("b", { id: "extra", title: "Contributed card", order: 1, load: async () => ({ default: () => null }) });
  return reg;
}

test("SettingsScreen: one 'App' h1, a list of collapsed groups, each header a button with aria-expanded=false and aria-controls", () => {
  const out = html(h(m.screen.SettingsScreen, { env: env({}), registry: twoGroupRegistry(), expanded: new m.groups.ExpandedGroups(memStore()) }));
  assert.equal((out.match(/<h1/g) ?? []).length, 1);
  assert.match(out, /<h1[^>]*>App<\/h1>/);
  assert.equal((out.match(/<h2/g) ?? []).length, 2); // Alpha, Beta; Proj needs a project
  assert.equal((out.match(/aria-expanded="false"/g) ?? []).length, 2);
  assert.match(out, /<h2[^>]*><button[^>]*aria-controls="st-group-b-a"/);
  assert.match(out, /Alpha<\/span>/);
  assert.ok(!out.includes("ALPHA-BODY"), "a collapsed group renders no body");
  assert.ok(!out.includes("Contributed card"));
  assert.ok(!out.includes("Proj"));
  assert.ok(!/class="st-nav/.test(out), "no left list any more");
});

test("SettingsScreen: a remembered group renders open with a labelled region; the project band needs a project", () => {
  const store = memStore();
  store.setItem("settings.group.b.expanded", "true");
  const e = { client: {}, host: { diagnostics: async () => ({}), copyText: async () => {}, activeProjectPath: () => "/p" } };
  const out = html(h(m.screen.SettingsScreen, { env: e, registry: twoGroupRegistry(), expanded: new m.groups.ExpandedGroups(store) }));
  assert.match(out, /aria-expanded="true"[^>]*aria-controls="st-group-b-b"/);
  assert.match(out, /role="region"[^>]*aria-labelledby="st-group-h-b"|aria-labelledby="st-group-h-b"[^>]*role="region"/);
  assert.match(out, /Proj<\/span>/);
  assert.match(out, /aria-labelledby="st-band-project"/);
});

test("SettingsScreen: a deep link (id, settings:<id>, or an old anchor) opens that group and remembers it", () => {
  for (const anchor of ["b", "settings:b"]) {
    const store = memStore();
    const out = html(h(m.screen.SettingsScreen, { env: env({}), registry: twoGroupRegistry(), initialSection: anchor, expanded: new m.groups.ExpandedGroups(store) }));
    assert.match(out, /aria-expanded="true"/);
    assert.equal(store.map.get("settings.group.b.expanded"), "true");
  }
  const reg = m.registryDefault.createSettingsRegistry();
  const out = html(h(m.screen.SettingsScreen, { env: env({}), registry: reg, initialSection: "providers", expanded: new m.groups.ExpandedGroups(memStore()) }));
  assert.match(out, /id="st-group-providers"/);
  assert.match(out, /aria-controls="st-group-b-providers"/);
  assert.equal(m.screen.targetGroup(reg, "settings:folder-trust"), "folder-trust");
  assert.equal(m.screen.targetGroup(reg, "extensions-trust"), "folder-trust");
  assert.equal(m.screen.targetGroup(reg, "nope"), null);
});

test("SettingsScreen: the real registry renders the Mac's 19 App groups in order, uppercase via the kit class, no project band without a project", () => {
  const reg = m.registryDefault.createSettingsRegistry();
  const out = html(h(m.screen.SettingsScreen, { env: env({}), registry: reg, expanded: new m.groups.ExpandedGroups(memStore()) }));
  const titles = [...out.matchAll(/class="ui-settings-title">([^<]*)</g)].map((x) => x[1].replaceAll("&amp;", "&"));
  assert.deepEqual(titles, m.groups.APP_GROUPS.map((g) => g.title));
  assert.equal(titles.length, 19);
  assert.ok(!out.includes("st-band-project"));
});

test("Mac-only and planned groups render an honest status card with no control (buttons, inputs, switches)", () => {
  for (const [name, status] of [["BuildGroup", "Managed in the Mac app"], ["MobileGroup", "Managed in the Mac app"], ["SelfHealGroup", "Managed in the Mac app"], ["TokenSavingGroup", "Status: planned"], ["LoopDefaultsGroup", "Status: planned"], ["DocGenGroup", "Status: planned"], ["OptionalComponentsGroup", "Status: planned"]]) {
    const out = html(h(m.notices[name], {}, null));
    assert.ok(out.includes(status), name);
    assert.match(out, /role="group" aria-label="Status on the desktop"/);
    assert.match(out, /Meanwhile:/);
    assert.ok(!/<(button|input|select|textarea)\b/.test(out), `${name} must not contain a control`);
  }
});

test("Tool permissions and Agent SDK render labelled controls before any data arrives (loading state)", () => {
  const e = { client: { request: async () => ({ status: 200, body: {} }) }, host: { diagnostics: async () => ({}), copyText: async () => {} } };
  const wrap = (el) => h(m.context.SettingsEnvProvider, { env: e }, el);
  const tp = html(wrap(h(m.toolperm.default)));
  assert.match(tp, /role="status"[^>]*>Loading/);
  assert.match(tp, /aria-label="Refresh"/);
  const sdk = html(wrap(h(m.sdk.default)));
  assert.match(sdk, /aria-label="Check now"/);
  assert.match(sdk, /Claude Agent SDK/);
});

test("SecretInput: password type, no value attribute, autocomplete off", () => {
  const f = new m.secret.SecretField();
  f.set("sk-must-not-render");
  const out = html(h(m.ui.SecretInput, { label: "API key", field: f, resetKey: 0 }));
  assert.match(out, /type="password"/);
  assert.match(out, /autoComplete="off"|autocomplete="off"/i);
  assert.ok(!/value=/.test(out));
  assert.ok(!out.includes("sk-must-not-render"));
});

test("Switch and TypedConfirm: roles, names, and the destructive button is disabled until the word is typed", () => {
  assert.match(html(h(m.ui.Switch, { label: "Allow tools", checked: true, onChange() {} })), /role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/);
  const out = html(h(m.ui.TypedConfirm, { title: "Delete 5 rows?", body: "x", word: "DELETE", actionLabel: "Delete", onConfirm() {}, onCancel() {} }));
  assert.match(out, /role="alertdialog"/);
  assert.match(out, /aria-label="Delete 5 rows\?"/);
  assert.match(out, /Type DELETE to confirm/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Delete<\/button>/);
});

test("VirtualList: 5,000 items render a small window with list semantics", () => {
  const items = Array.from({ length: 5000 }, (_, i) => ({ id: `r${i}` }));
  const out = html(h(m.ui.VirtualList, { items, rowHeight: 40, label: "Rows", keyOf: (x) => x.id, render: (x) => x.id }));
  assert.match(out, /role="list"[^>]*aria-label="Rows"|aria-label="Rows"[^>]*role="list"/);
  assert.match(out, /aria-rowcount="5000"/);
  const rendered = (out.match(/role="listitem"/g) ?? []).length;
  assert.ok(rendered > 0 && rendered < 60, `rendered ${rendered}`);
  assert.match(out, /aria-setsize="5000"/);
});

test("ProvidersSection with a loaded catalog: connections listed with names, key status from hasKey only, no key text", async () => {
  const catalog = {
    providers: fx("provider-catalog/get-kb-providers-catalog-200.json").response.providers,
    settings: fx("provider-catalog/get-kb-providers-settings-200.json").response,
  };
  const client = { async request(method, path) { return path === "/kb/providers/catalog" ? { status: 200, body: catalog } : { status: 404, body: {} }; } };
  const model = m.context.sharedProvidersModel(client);
  await model.load();
  const out = html(h(m.context.SettingsEnvProvider, { env: env(client) }, h(m.providers.default)));
  assert.match(out, /aria-label="Filter connections"/);
  assert.match(out, /aria-label="Test Groq"/);
  assert.match(out, /aria-label="Remove Groq"/);
  assert.match(out, /role="switch"[^>]*aria-label="Enable Groq"|aria-label="Enable Groq"[^>]*role="switch"/);
  assert.match(out, /Key stored/);
  assert.match(out, /OpenAI-compatible \(adapter\)/);
  assert.ok(!/sk-/.test(out));
});

test("Agent history ClearSheet: names the rows, requires typing DELETE, shows the stale notice", async () => {
  const dry = fx("agent-history/post-kb-agent-history-clear-200-dry-run.json").response;
  const client = { async request(method, path, body) { return body?.dryRun ? { status: 200, body: dry } : { status: 404, body: {} }; } };
  const model = new m.historyModel.AgentHistoryModel(client);
  await model.beginClear("raw", "older30");
  const out = html(h(m.context.SettingsEnvProvider, { env: env(client) }, h(m.history.ClearSheet, { model })));
  assert.match(out, /Delete 5 rows\?/);
  assert.match(out, /Runs: 2/);
  assert.match(out, /Tool events: 3/);
  assert.match(out, /daily summaries are kept/);
  assert.match(out, /Type DELETE to confirm/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Delete<\/button>/);
  assert.match(out, /<option[^>]*value="older30"[^>]*selected|selected=""[^>]*value="older30"|value="older30"[^>]*selected=""/);
});
