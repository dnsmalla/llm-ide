// The URL-first card renders the primary flow and keeps the SSH/deploy controls behind an explicit
// Advanced disclosure (hidden by default). Server-rendered so no DOM library is needed.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const require = createRequire(join(REPO, "desktop/package.json"));
let m;
before(async () => {
  const { build } = require("esbuild");
  const outfile = join(bundleDir("remote-card"), "entry.mjs");
  const entry = join(bundleDir("remote-card"), "entry-src.ts");
  (await import("node:fs")).writeFileSync(entry, `export { default as RemoteServerCard } from ${JSON.stringify(join(HERE, "../sections/RemoteServerCard.tsx"))};\nexport { SettingsEnvProvider } from ${JSON.stringify(join(HERE, "../context.tsx"))};\n`);
  await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") } });
  m = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
});

const config = { mode: "local", host: "", port: 22, user: "", keyPath: "", label: "", hubUrl: "", tlsPin: "" };

test("the primary URL/email/password flow is visible and Advanced SSH is hidden by default", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const host = {
    getRemoteServer: async () => config,
    setRemoteServer: async (c) => c,
    testRemoteSsh: async () => { throw new Error("not used"); },
    remoteHubCheck: async (hubUrl) => ({ hubUrl, webPki: true, pin: "", status: "ok", apiVersion: 130, hub: true, dbOk: true }),
    remoteHubLogin: async (hubUrl) => ({ hubUrl, user: { id: "u", email: "a@example.com", displayName: null, role: "admin" }, role: "admin", projects: [], webPki: true, pin: "" }),
    remoteSessionClear: async () => {},
    signOut: async () => {},
    restartApp: async () => {},
    copyText: async () => {},
  };
  const client = { requestRaw: async () => ({ status: 200, body: null }), login: async () => {}, logout: async () => {} };
  const env = { client, host, serverMode: "local" };
  const html = renderToStaticMarkup(React.createElement(m.SettingsEnvProvider, { env }, React.createElement(m.RemoteServerCard)));
  for (const text of ["Server URL", "Email", "Password", "Connect", "Test connection", "Local desktop", "Remote server"]) {
    assert.match(html, new RegExp(text), text);
  }
  assert.match(html, /aria-expanded="false"/, "Advanced starts closed");
  for (const hidden of ["Private key path", "Test SSH", "Deploy the hub", "SSH user", 'id="remote-advanced-panel"']) {
    assert.doesNotMatch(html, new RegExp(hidden), `${hidden} must be behind the closed Advanced section`);
  }
  assert.doesNotMatch(html, /type="password"[^>]*value="[^"]+"/, "the password input is never pre-filled");
});
