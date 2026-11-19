// Mounted tests (a real React tree in happy-dom): what the screen does on open, on a view switch and on a second deep
// link, and that it survives React StrictMode's mount, unmount, mount. happy-dom is the extension package's dev
// dependency; where it is not installed these tests skip instead of failing.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { bundleDir } from "../../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const requireFromDesktop = createRequire(join(REPO, "desktop", "package.json"));
const P = "/auth/me/extensions";
const HAS_DOM = existsSync(join(REPO, "extension/node_modules/happy-dom/package.json"));
const opts = { skip: HAS_DOM ? false : "happy-dom is not installed" };

let X;
let React;
let createRoot;
let act;
before(async () => {
  if (!HAS_DOM) return;
  const { Window } = createRequire(join(REPO, "extension", "package.json"))("happy-dom");
  const win = new Window({ url: "http://localhost/" });
  for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    try { Object.defineProperty(globalThis, k, { value: k === "window" ? win : win[k], configurable: true, writable: true }); } catch { /* read-only global */ }
  }
  globalThis.window = win;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (!win.ResizeObserver) win.ResizeObserver = globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const { build } = requireFromDesktop("esbuild");
  const outfile = join(bundleDir("extensions-mount"), "entry.mjs");
  await build({ entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") }, jsx: "automatic", logLevel: "silent" });
  X = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  React = requireFromDesktop("react");
  createRoot = requireFromDesktop("react-dom/client").createRoot;
  act = React.act;
});

const fx = (dir, n) => JSON.parse(readFileSync(join(REPO, "schema/http", "fixtures", dir, `${n}.json`), "utf8")).response;
const plugin = (name) => ({ name, displayName: name, version: "1.0.0", enabled: true, format: "claude", description: "", skillCount: 0, hookCount: 0, mcpServerCount: 0, origin: null, commands: [], subagents: [], unsupportedComponents: [], pendingComponents: [], sdkReadable: true, nativePluginsOn: true, nativeDelivery: false, executableKinds: [], hookNotes: [], hooksTrusted: false, trustOutdated: false, trustOutdatedKinds: [] });

/** A core that records every call; the catalog holds an item with an MCP member, the MCP list a health-capable server. */
function recorder() {
  const calls = [];
  const inst = fx("extensions", "get-auth-me-extensions-installed-200-2").items;
  const withMcp = { ...inst.find((i) => i.id === "plugin:acme/runner"), members: [{ memberId: "mcp:srv", type: "mcp", name: "srv", executable: true }] };
  const routes = {
    [`GET ${P}/installed`]: () => ({ corrupt: false, items: [withMcp] }),
    [`GET ${P}/active`]: () => fx("extensions", "get-auth-me-extensions-active-200"),
    "GET /auth/me/plugins": () => ({ plugins: [plugin("runner"), plugin("other")] }),
    "GET /auth/me/llm-sources": () => fx("health-auth", "get-auth-me-llm-sources-200"),
    "GET /auth/me/mcp-plugins": () => fx("health-auth", "get-auth-me-mcp-plugins-200"),
    "GET /auth/me/claude-plugins/updates": () => ({ cli: true, checkedAt: "x", updates: [] }),
    "GET /auth/me/codex-plugins/updates": () => ({ cli: false, checkedAt: "x", updates: [] }),
    "GET /auth/me/mcp-plugins/updates": () => ({ servers: [] }),
    "GET /auth/me/llm-sources/updates": () => ({ sources: [] }),
  };
  const core = {
    async request(method, path) {
      const key = `${method} ${path.split("?")[0]}`;
      calls.push(key);
      const r = routes[key];
      return r ? { status: 200, body: r() } : { status: 404, body: { error: { code: "NOT_FOUND", message: "x" } } };
    },
  };
  return { calls, api: X.createExtensionsApi(core), legacyApi: X.createLegacyApi(core) };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
async function mount(el) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  await flush();
  return { host, root, render: async (e) => { await act(async () => { root.render(e); }); await flush(); }, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }); await flush(); };
const screenEl = (r, extra = {}) => React.createElement(X.ExtensionsScreen, { api: r.api, legacyApi: r.legacyApi, initialHeight: 520, ...extra });
const legacyCount = (host) => host.querySelector(".ext-legacy .lib-count")?.textContent;

test("opening on Catalog reads only the catalog; a list is read when its view is first shown; nothing runs a health check", opts, async () => {
  const r = recorder();
  const m = await mount(screenEl(r));
  assert.ok(r.calls.includes(`GET ${P}/installed`));
  assert.deepEqual(r.calls.filter((c) => c.includes("/auth/me/") && !c.includes(P)), [], "no legacy list or status call on open");
  await click(m.host.querySelector("#ext-view-mcp-plugins"));
  assert.ok(r.calls.includes("GET /auth/me/mcp-plugins"));
  assert.ok(!r.calls.includes("GET /auth/me/plugins") && !r.calls.includes("GET /auth/me/llm-sources"), "only the shown list is read");
  await click(m.host.querySelector("#ext-view-catalog"));
  await click(m.host.querySelector("#ext-view-mcp-plugins"));
  assert.equal(r.calls.filter((c) => c === "GET /auth/me/mcp-plugins").length, 1, "a second visit does not read again");
  assert.deepEqual(r.calls.filter((c) => /check/.test(c)), [], "a health check starts a program: it waits for the button");
  await m.unmount();
});

test("a second deep-link request on a mounted screen switches the view", opts, async () => {
  const r = recorder();
  const m = await mount(screenEl(r, { request: null }));
  assert.ok(!m.host.querySelector(".ext-legacy"));
  await m.render(screenEl(r, { request: { id: "mcp-plugins", n: 1 } }));
  assert.ok(m.host.querySelector('[role="list"][aria-label="MCP servers"]'));
  assert.equal(m.host.querySelector("#ext-view-mcp-plugins").getAttribute("aria-selected"), "true");
  await m.render(screenEl(r, { request: { id: "llm-sources", n: 2 } }));
  assert.ok(m.host.querySelector('[role="list"][aria-label="Skill kits"]'));
  assert.equal(m.host.querySelector("#ext-view-mcp-plugins").getAttribute("aria-selected"), "false");
  await m.render(screenEl(r, { request: { id: "extensions:add", n: 3 } }));
  assert.equal(m.host.querySelector("#ext-tab-install").getAttribute("aria-selected"), "true");
  await m.unmount();
});

test("StrictMode (mount, unmount, mount) and a plain remount give live models, not disposed ones", opts, async () => {
  const r = recorder();
  const m = await mount(React.createElement(React.StrictMode, null, screenEl(r, { request: { id: "plugins", n: 1 } })));
  assert.equal(legacyCount(m.host), "2", "the list loaded into the surviving model");
  await click(m.host.querySelector("#ext-view-llm-sources"));
  assert.ok(m.host.querySelector('[role="list"][aria-label="Skill kits"]'), "the other views work too");
  assert.ok(m.host.querySelector(".ext-tabs"));
  await m.unmount();
  const again = await mount(screenEl(r, { request: { id: "plugins", n: 1 } }));
  assert.equal(legacyCount(again.host), "2", "a second mount reads again into a fresh model");
  await again.unmount();
});
