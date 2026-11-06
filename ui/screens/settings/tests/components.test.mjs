// Server-render tests for the Settings components: ARIA roles and names, write-only secret
// inputs, virtualisation, destructive-confirm gating. Components are bundled with esbuild
// next to desktop/node_modules so `react` resolves to one copy (same approach as ui/kit/tests).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
      builtin: join(SETTINGS, "sections/BuiltinProviders.tsx"),
      history: join(SETTINGS, "sections/AgentHistorySection.tsx"),
      ui: join(SETTINGS, "ui.tsx"),
      context: join(SETTINGS, "context.tsx"),
      registry: join(SETTINGS, "registry.ts"),
      groups: join(SETTINGS, "groups.ts"),
      notices: join(SETTINGS, "sections/NoticeSections.tsx"),
      toolperm: join(SETTINGS, "sections/ToolPermissionsSection.tsx"),
      sdk: join(SETTINGS, "sections/AgentSdkSection.tsx"),
      optional: join(SETTINGS, "sections/OptionalComponentsSection.tsx"),
      server: join(SETTINGS, "sections/ServerSection.tsx"),
      connections: join(SETTINGS, "sections/ConnectionsSection.tsx"),
      repos: join(SETTINGS, "sections/RepositoriesSection.tsx"),
      paths: join(SETTINGS, "sections/PathsSection.tsx"),
      memory: join(SETTINGS, "sections/MemorySection.tsx"),
      token: join(SETTINGS, "sections/TokenSavingSection.tsx"),
      general: join(SETTINGS, "sections/GeneralSection.tsx"),
      appModel: join(SETTINGS, "app-model.ts"),
      componentsModel: join(SETTINGS, "components-model.ts"),
      sourcesModel: join(SETTINGS, "sources-model.ts"),
      projectModel: join(SETTINGS, "project-model.ts"),
      registryDefault: join(SETTINGS, "registry-default.ts"),
      historyModel: join(SETTINGS, "agent-history-model.ts"),
      secret: join(SETTINGS, "secret-field.ts"),
      routing: join(SETTINGS, "sections/RoutingSection.tsx"),
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
  for (const k of ["screen", "providers", "history", "ui", "context", "registry", "groups", "notices", "toolperm", "sdk", "optional", "server", "connections", "repos", "paths", "memory", "token", "general", "appModel", "builtin", "componentsModel", "sourcesModel", "projectModel", "registryDefault", "historyModel", "secret", "routing"]) m[k] = await import(pathToFileURL(join(outdir, `${k}.js`)).href + t);
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

test("SettingsScreen: one 'Settings' h1, a list of collapsed groups, each header a button with aria-expanded=false and aria-controls", () => {
  const out = html(h(m.screen.SettingsScreen, { env: env({}), registry: twoGroupRegistry(), expanded: new m.groups.ExpandedGroups(memStore()) }));
  assert.equal((out.match(/<h1/g) ?? []).length, 1);
  assert.match(out, /<h1[^>]*>Settings<\/h1>/);
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
  for (const [name, status] of [["SelfHealGroup", "Managed in the Mac app"]]) {
    const out = html(h(m.notices[name], {}, null));
    assert.ok(out.includes(status), name);
    assert.match(out, /role="group" aria-label="Status on the desktop"/);
    assert.match(out, /Meanwhile:/);
    assert.ok(!/<(button|input|select|textarea)\b/.test(out), `${name} must not contain a control`);
  }
});

test("Optional components: a real card over the host commands, with no status pretending before data arrives", () => {
  const e = {
    client: {},
    host: {
      diagnostics: async () => ({}),
      copyText: async () => {},
      mermaidStatus: async () => ({ installed: false, version: "11.17.2", sizeBytes: 40_053, host: "cdn.jsdelivr.net" }),
      installMermaid: async () => ({ installed: true, version: "11.17.2", sizeBytes: 40_053, host: "cdn.jsdelivr.net" }),
      removeMermaid: async () => ({ installed: false, version: "11.17.2", sizeBytes: 40_053, host: "cdn.jsdelivr.net" }),
    },
  };
  const wrap = (el) => h(m.context.SettingsEnvProvider, { env: e }, el);
  const out = html(wrap(h(m.optional.default)));
  assert.match(out, /Mermaid diagram renderer/);
  assert.match(out, /Reading the component state/);
  assert.match(out, /<button[^>]*>[^<]*Install renderer<\/button>/);
  assert.ok(!/Installed<\/span>/.test(out), "nothing claims an install before the host answers");
  assert.match(out, /sandboxed frame/);

  const noHost = { client: {}, host: { diagnostics: async () => ({}), copyText: async () => {} } };
  const bare = html(h(m.context.SettingsEnvProvider, { env: noHost }, h(m.optional.default)));
  assert.match(bare, /needs the desktop host/);
});

test("Server & Backend: the log viewer is a labelled, read-only block when the host can read the log", () => {
  const e = {
    client: { request: async () => ({ status: 200, body: {} }) },
    host: {
      diagnostics: async () => ({ appVersion: "0.0.0", coreTrust: "spawned", coreLogPath: "/d/core.log", platform: "macOS", coreUrl: "http://127.0.0.1:3457", coreState: "ready" }),
      copyText: async () => {},
      coreLog: async () => ({ path: "/d/core/server.log", text: "", exists: false }),
      clearCoreLog: async () => {},
      coreStart: async () => {}, coreStop: async () => {}, coreRestart: async () => {},
    },
  };
  const out = html(h(m.context.SettingsEnvProvider, { env: e }, h(m.server.default)));
  assert.match(out, /aria-label="Backend log"/);
  assert.match(out, /No log entries yet/);
  assert.match(out, /Refresh log/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Clear log<\/button>/, "nothing to clear before a log exists");
  assert.match(out, /Managed backend/);
  assert.match(out, /default backend is the core bundled inside the app/);
  assert.match(out, /source checkout/);
  assert.match(out, /Start backend/, "before the diagnostics load the safe action is Start");
  assert.match(out, /Kill &amp; Restart/);
  assert.doesNotMatch(out, /<input/, "the desktop backend is managed; no dead config fields");
});

test("Connections: the catalog card explains selection vs credentials and has no credential inputs", () => {
  const e = { client: { request: async () => ({ status: 200, body: { catalog: [] } }) }, host: { diagnostics: async () => ({}), copyText: async () => {} } };
  const out = html(h(m.context.SettingsEnvProvider, { env: e }, h(m.connections.default)));
  assert.match(out, /only shows or hides/i);
  assert.match(out, /Library → Connections/);
  assert.match(out, /Loading the catalog/);
  assert.match(out, /Refresh catalog/);
  assert.ok(!/<input|<textarea|<select/.test(out), "no credential fields in this group");
  assert.match(out, /On the Mac this group also holds/);
});

test("Repositories: the Mac's GitLab/GitHub tabs, write-only tokens, automation switches and saved repos", () => {
  const e = {
    client: { request: async () => ({ status: 200, body: { repos: [] } }) },
    host: { diagnostics: async () => ({}), copyText: async () => {}, pickFolder: async () => null, activeProjectPath: () => "/p" },
  };
  const out = html(h(m.context.SettingsEnvProvider, { env: e }, h(m.repos.default)));
  assert.match(out, /role="tablist"[^>]*aria-label="Repository provider"/);
  for (const l of ["GitLab", "GitHub"]) assert.match(out, new RegExp(`role="tab"[^>]*>${l}<`));
  assert.match(out, /Instance URL/);
  assert.match(out, /Access Token/);
  assert.match(out, /type="password"/, "the token is write-only and masked");
  assert.match(out, /Save token/);
  assert.match(out, /Automation &amp; actions/);
  assert.match(out, /Pull \/ Re-sync/);
  assert.match(out, /No repositories added yet/);
  assert.match(out, /Open a project to use its code\/ folder as the clone destination/);
  assert.match(out, /Clone repository/);
  assert.doesNotMatch(out, /Core index allow-list/, "the Mac Repositories card has no folder allow-list");
});

test("Token Saving: an rtk detection card whose install is host-run, with no process in the page", () => {
  const e = {
    client: {},
    host: {
      diagnostics: async () => ({}),
      copyText: async () => {},
      rtkStatus: async () => ({ installed: false, version: null, canInstall: true }),
      installRtk: async () => ({ installed: true, version: "rtk 0.4.2", canInstall: true }),
    },
  };
  const out = html(h(m.context.SettingsEnvProvider, { env: e }, h(m.token.default)));
  assert.match(out, /Checking for rtk/);
  assert.match(out, /rtk shrinks shell command output/);
  assert.match(out, /Check again/);
  assert.ok(!/<input/.test(out), "no command or path input");
  const noHost = { client: {}, host: { diagnostics: async () => ({}), copyText: async () => {} } };
  const bare = html(h(m.context.SettingsEnvProvider, { env: noHost }, h(m.token.default)));
  assert.match(bare, /needs the desktop host/);
});

test("Paths and Memory: read-only project views, labelled, with no path the page supplied", () => {
  const e = {
    client: {},
    host: {
      diagnostics: async () => ({}),
      copyText: async () => {},
      projectPaths: async () => ({ root: "/p", folders: [{ name: "system", exists: true }] }),
      projectMemory: async () => ({ root: "/p", graph: null, files: [] }),
      revealPath: async () => {},
    },
  };
  const wrap = (el) => h(m.context.SettingsEnvProvider, { env: e }, el);
  const paths = html(wrap(h(m.paths.default)));
  assert.match(paths, /Loading the project folders/);
  assert.match(paths, /read-only/i);
  assert.match(paths, /The project folder layout is owned by the project on both apps/);
  const memory = html(wrap(h(m.memory.default)));
  assert.match(memory, /Loading project memory/);
  assert.match(memory, /knowledge graph/i);
  assert.ok(!/<input|<select|<textarea/.test(paths + memory), "no editable path fields");
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

test("Built-in providers: Claude subscription and the CLI rows, with no key fields", () => {
  const out = html(h(m.context.SettingsEnvProvider, { env: env({}) }, h(m.builtin.BuiltinProviders)));
  assert.match(out, /Built-in providers/);
  assert.match(out, /Claude \(subscription \/ CLI login\)/);
  assert.match(out, /OpenAI \(Codex CLI\)/);
  assert.match(out, /Google Gemini \(Gemini CLI\)/);
  assert.match(out, /DeepSeek/);
  assert.match(out, /claude login/);
  assert.match(out, /aria-label="Check the claude CLI"/);
  assert.match(out, /aria-label="Check the codex CLI"/);
  assert.match(out, /aria-label="Check the gemini CLI"/);
  assert.match(out, /Checking\.\.\./);
  assert.ok(!/<input|<textarea|<select/.test(out), "no key or command fields in the built-in rows");
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

test("General: synced prefs say Saving… during a save and offer Retry after a failed first load (Mac parity)", async () => {
  const failing = { request: async () => { throw new Error("core down"); } };
  const model = new m.appModel.UserPrefsModel(failing);
  await model.load();
  const failed = html(h(m.general.PrefsBlock, { m: model, s: model.getState() }));
  assert.match(failed, /<button[^>]*class="st-btn"[^>]*>Retry<\/button>/, "a failed first load offers Retry, as the Mac does");
  assert.ok(!failed.includes("Loading..."), "a failed load is not shown as still loading");
  assert.ok(!/<select/.test(failed), "no language control while the prefs are unloaded");

  const loaded = { prefs: { language: "ja", bilingual: false, nativePlugins: true }, saving: true, saved: false, error: null };
  const saving = html(h(m.general.PrefsBlock, { m: model, s: loaded }));
  assert.match(saving, /role="status"[^>]*>Saving…</, "the Mac shows Saving… while a save is in flight");
  assert.match(saving, /<select[^>]*disabled=""/, "controls are disabled while saving");
  const idle = html(h(m.general.PrefsBlock, { m: model, s: { ...loaded, saving: false, saved: true } }));
  assert.ok(!idle.includes("Saving…"));
  assert.match(idle, />Saved\.</);
});

test("Routing: a failed provider-settings load shows the error with Retry, not 'Connect a provider'", async () => {
  const client = { async request(method, path) { if (path === "/kb/providers/catalog") throw new Error("core down"); return { status: 404, body: {} }; } };
  const providers = m.context.sharedProvidersModel(client);
  await providers.load();
  const out = html(h(m.context.SettingsEnvProvider, { env: env(client) }, h(m.routing.default)));
  assert.match(out, /Couldn&#x27;t load the provider settings|Couldn't load the provider settings/);
  assert.match(out, /<button[^>]*>Retry<\/button>/);
  assert.ok(!out.includes("Connect a provider in Providers"), "a failed load is not reported as having no connections");
});

test("Routing: the one-time key carry-over names what was added and what needs review, without keys", async () => {
  const cat = fx("provider-catalog/get-kb-providers-catalog-200.json").response;
  const catalog = { providers: cat.providers, settings: fx("provider-catalog/get-kb-providers-settings-200.json").response, migration: cat.migration };
  const client = { async request(method, path) { return path === "/kb/providers/catalog" ? { status: 200, body: catalog } : { status: 404, body: {} }; } };
  const providers = m.context.sharedProvidersModel(client);
  await providers.load();
  const out = html(h(m.context.SettingsEnvProvider, { env: env(client) }, h(m.routing.default)));
  assert.match(out, /Your existing DeepSeek key was added as catalog connections/);
  assert.match(out, /Lab box needs review/);
  assert.match(out, /SSRF guard/);
  assert.ok(!/sk-|api_key/i.test(out));
});

test("Routing: every upgrade state renders the Mac's words: tools, router needed (with its button), router pending, nothing when unknown", () => {
  const migration = { created: [{ provider: "deepseek", name: "DeepSeek" }], needsReview: [], toolsSuggested: true };
  const off = html(h(m.routing.MigrationNotice, { migration, toolsOn: false, routerState: "off", onTurnOnRouter: () => undefined }));
  assert.match(off, /Tool turns can read files and run commands, subject to your approvals\./, "tools explanation while tools are off");
  assert.match(off, /Chat on these models runs through the session router\. Turning it on applies the next time the backend starts\./);
  assert.match(off, /<button[^>]*>Turn on the session router<\/button>/, "the router switch-on button");
  assert.ok(!off.includes("The session router is on"), "no pending line while the router is off");

  const on = html(h(m.routing.MigrationNotice, { migration, toolsOn: true, routerState: "on", onTurnOnRouter: undefined }));
  assert.match(on, /The session router is on; it applies the next time the backend starts\./, "router pending once it is on");
  assert.ok(!on.includes("Tool turns can read files"), "no tools line once tools are on");
  assert.ok(!on.includes("Turn on the session router"), "no button once the router is on");

  const unknown = html(h(m.routing.MigrationNotice, { migration, toolsOn: undefined, routerState: "unknown", onTurnOnRouter: undefined }));
  assert.ok(!unknown.includes("session router"), "router state not loaded yet: say nothing rather than claim it is off");
  assert.ok(!unknown.includes("Tool turns can read files"), "tools state not loaded yet: say nothing");
  assert.match(unknown, /Your existing DeepSeek key was added as catalog connections\./, "the created line still shows");
});

test("Routing: the 'Turn on the session router' button calls its handler, and RoutePrefs wires it through the prefs save", () => {
  const migration = { created: [{ provider: "deepseek", name: "DeepSeek" }], needsReview: [], toolsSuggested: false };
  let clicked = 0;
  const tree = m.routing.MigrationNotice({ migration, toolsOn: true, routerState: "off", onTurnOnRouter: () => { clicked += 1; } });
  const find = (el) => {
    if (!el || typeof el !== "object") return null;
    if (Array.isArray(el)) { for (const c of el) { const f = find(c); if (f) return f; } return null; }
    if (el.props?.children === "Turn on the session router" && typeof el.props.onClick === "function") return el;
    return find(el.props?.children);
  };
  const button = find(tree);
  assert.ok(button, "the button is rendered");
  button.props.onClick();
  assert.equal(clicked, 1);
  const src = readFileSync(new URL("../sections/RoutingSection.tsx", import.meta.url), "utf8");
  assert.match(src, /onTurnOnRouter=\{setPrefs && prefs \? \(\) => save\(\{ router: true, cap: prefs\.cap \}\) : undefined\}/, "the button saves router on through the existing prefs path");
  assert.match(src, /const save = \(next: \{ router: boolean; cap: boolean \}\) => \{ setLocal\(next\); void setPrefs\?\.\(next\); \};/);
});

test("Server & Backend: the log has an Auto-scroll checkbox that starts on, and the group re-reads the log while open", () => {
  const e = {
    client: { request: async () => ({ status: 200, body: {} }) },
    host: {
      diagnostics: async () => ({ appVersion: "0.0.0", coreTrust: "spawned", coreLogPath: "/d/core.log", platform: "macOS", coreUrl: "http://127.0.0.1:3457", coreState: "ready" }),
      copyText: async () => {},
      coreLog: async () => ({ path: "/d/core/server.log", text: "line", exists: true }),
      clearCoreLog: async () => {},
    },
  };
  const out = html(h(m.context.SettingsEnvProvider, { env: e }, h(m.server.default)));
  assert.match(out, /<button[^>]*role="checkbox"[^>]*aria-checked="true"[^>]*>Auto-scroll<\/button>/, "Auto-scroll is a labelled checkbox, on by default");
  assert.ok(m.componentsModel.LOG_POLL_MS >= 1000 && m.componentsModel.LOG_POLL_MS <= 5000, "the open log is re-read every few seconds");
});
