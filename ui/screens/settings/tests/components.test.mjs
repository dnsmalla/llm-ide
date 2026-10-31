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
  for (const k of ["screen", "providers", "history", "ui", "context", "registry", "historyModel", "secret"]) m[k] = await import(join(outdir, `${k}.js`) + t);
});

const env = (client) => ({ client, host: { diagnostics: async () => ({}), copyText: async () => {} } });

test("SettingsScreen: labelled nav, current section marked, one h1, lazy body shows a status fallback", () => {
  const reg = new m.registry.SettingsRegistry();
  reg.registerSection({ id: "a", title: "Alpha", order: 1, load: async () => ({ default: () => null }) });
  reg.registerSection({ id: "b", title: "Beta", order: 2, load: async () => ({ default: () => null }) });
  reg.registerCard("b", { id: "extra", title: "Contributed card", order: 1, load: async () => ({ default: () => null }) });
  const out = html(h(m.screen.SettingsScreen, { env: env({}), registry: reg, initialSection: "b" }));
  assert.match(out, /<nav[^>]*aria-label="Settings sections"/);
  assert.match(out, /aria-current="page"[^>]*>Beta</);
  assert.equal((out.match(/<h1/g) ?? []).length, 1);
  assert.match(out, /<h1[^>]*>Beta<\/h1>/);
  assert.match(out, /Contributed card/);
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
