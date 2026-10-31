// Host prefs, folder picking and trust confirmation as the shell adapts them for Settings. The host is a fake
// `invoke`; the Rust side has its own tests (desktop/src-tauri/src/prefs.rs, source_pick.rs, confirm.rs).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const require = createRequire(join(REPO, "desktop/package.json"));
let m;
before(async () => {
  const { build } = require("esbuild");
  const outfile = join(bundleDir("host-prefs"), "entry.mjs");
  const entry = join(bundleDir("host-prefs"), "entry-src.ts");
  (await import("node:fs")).writeFileSync(entry, `export * from ${JSON.stringify(join(HERE, "../host-prefs.ts"))};\nexport { createSettingsEnv } from ${JSON.stringify(join(HERE, "../settings-adapter.ts"))};\nexport { seedThemeFromHost, hasStoredTheme, getTheme } from ${JSON.stringify(join(HERE, "../theme.ts"))};\nexport { normalizeCoreStatus } from ${JSON.stringify(join(HERE, "../host.ts"))};\n`);
  await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") } });
  m = await import(`${outfile}?t=${Date.now()}`);
});

const P = { ltaMode: "off", router: false, cap: false, compress: false, learn: false, terminal: true, theme: "dark" };
const view = (stored = P, launch = P) => ({ stored, launch, restartNeeded: JSON.stringify(stored) !== JSON.stringify(launch), persisted: true });

function env(over = {}) {
  const calls = [];
  const state = { stored: { ...P }, launch: { ...P } };
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (over.invoke) { const r = await over.invoke(cmd, args, state); if (r !== undefined) return r; }
    if (cmd === "get_prefs") return view(state.stored, state.launch);
    if (cmd === "set_prefs") { state.stored = { ...state.stored, ...args.patch }; return view(state.stored, state.launch); }
    return null;
  };
  const e = m.createSettingsEnv({
    core: { requestRaw: async () => ({ status: 200, body: null }), login: async () => {}, logout: async () => {} },
    coreStatus: () => over.status ?? { trust: "spawned", core_log_path: "/data/core.log" },
    invoke, hostAvailable: () => over.host !== false, activeProjectRoot: () => null,
    theme: { get: () => "dark", set() {} }, appVersion: () => "1", platform: () => "test", clipboard: () => null,
  });
  return { host: e.host, calls, state };
}

test("the prefs decoder accepts exactly the host's shape and refuses anything else", () => {
  assert.deepEqual(m.decodePrefs(P), P);
  for (const bad of [null, [], "x", { ...P, ltaMode: "always" }, { ...P, theme: "neon" }, { ...P, router: "on" }, { ...P, terminal: undefined }]) assert.equal(m.decodePrefs(bad), null);
  assert.equal(m.decodePrefsView({ stored: P, launch: { ...P, router: "x" } }), null);
  assert.equal(m.decodePrefsView(view()).restartNeeded, false);
});

test("the prefs keys match the Rust schema", () => {
  const rs = readFileSync(join(REPO, "desktop/src-tauri/src/prefs.rs"), "utf8");
  const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const fields = [...rs.match(/pub struct Prefs \{([\s\S]*?)\}/)[1].matchAll(/pub (\w+):/g)].map((x) => camel(x[1]));
  assert.deepEqual(fields.sort(), Object.keys(P).sort());
});

test("without a host nothing host-backed is offered (the placeholders stay honest)", () => {
  const { host } = env({ host: false });
  for (const k of ["getLtaMode", "setLtaMode", "launchLtaMode", "getRoutePrefs", "setRoutePrefs", "getExtraPrefs", "pickFolder", "confirmTrust"]) assert.equal(host[k], undefined, k);
});

test("archiving mode and router/cap round-trip through get_prefs/set_prefs with a typed patch", async () => {
  const { host, calls, state } = env();
  assert.equal(await host.getLtaMode(), "off");
  await host.setLtaMode("shadow");
  assert.deepEqual(calls.at(-1), ["set_prefs", { patch: { ltaMode: "shadow" } }]);
  assert.equal(host.launchLtaMode(), "off", "the launch mode stays what this run started with");
  await host.setRoutePrefs({ router: false, cap: true });
  assert.deepEqual(calls.at(-1)[1], { patch: { router: false, cap: false } }, "cap is never sent without the router");
  await host.setRoutePrefs({ router: true, cap: true });
  assert.deepEqual(await host.getRoutePrefs(), { router: true, cap: true });
  await host.setExtraPrefs({ learn: true });
  assert.deepEqual(await host.getExtraPrefs(), { compress: false, learn: true, terminal: true });
  assert.equal(state.stored.learn, true);
});

test("a garbled host answer is an error, not invented values", async () => {
  const { host } = env({ invoke: async (cmd) => (cmd === "get_prefs" ? { stored: { nope: 1 } } : undefined) });
  await assert.rejects(() => host.getLtaMode(), /cannot read/);
});

test("pickFolder: dialog -> opaque token -> single redeem; cancel is null; a relative path is refused", async () => {
  let pick = { token: "t1", name: "repo" };
  const { host, calls } = env({ invoke: async (cmd) => (cmd === "pick_folder" ? pick : cmd === "pick_folder_redeem" ? { path: "/Users/me/repo", name: "repo" } : undefined) });
  assert.equal(await host.pickFolder("Choose a folder to trust"), "/Users/me/repo");
  assert.deepEqual(calls.map((c) => c[0]), ["pick_folder", "pick_folder_redeem"]);
  assert.deepEqual(calls[0][1], { title: "Choose a folder to trust" });
  assert.deepEqual(calls[1][1], { token: "t1" });
  pick = null;
  assert.equal(await host.pickFolder("x"), null);
  const rel = env({ invoke: async (cmd) => (cmd === "pick_folder" ? { token: "t", name: "n" } : cmd === "pick_folder_redeem" ? { path: "../etc" } : undefined) });
  await assert.rejects(() => rel.host.pickFolder("x"), /cannot use/);
});

test("confirmTrust is true only for an exact boolean yes", async () => {
  for (const [answer, want] of [[true, true], [false, false], ["true", false], [1, false], [null, false]]) {
    const { host, calls } = env({ invoke: async (cmd) => (cmd === "trust_confirm" ? answer : undefined) });
    assert.equal(await host.confirmTrust("/p"), want);
    assert.deepEqual(calls[0], ["trust_confirm", { path: "/p" }]);
  }
});

test("diagnostics carry the core log path (never its contents)", async () => {
  const { host } = env();
  assert.equal((await host.diagnostics()).coreLogPath, "/data/core.log");
  assert.equal(m.normalizeCoreStatus({ state: "ready", core_log_path: 5 }).core_log_path, null);
  assert.equal(m.normalizeCoreStatus({ state: "ready" }).core_log_path, null);
});

test("theme: the host's copy only fills in when the webview lost its own", () => {
  const mem = (init = {}) => { const o = { ...init }; return { getItem: (k) => o[k] ?? null, setItem: (k, v) => { o[k] = v; } }; };
  assert.equal(m.seedThemeFromHost("neon", mem()), false);
  assert.equal(m.seedThemeFromHost("light", mem({ "llmide.theme": "midnight" })), false, "a stored choice wins");
  globalThis.document = { documentElement: { dataset: {}, style: {} } };
  assert.equal(m.seedThemeFromHost("light", mem()), true);
  assert.equal(m.getTheme(), "light");
  delete globalThis.document;
});
