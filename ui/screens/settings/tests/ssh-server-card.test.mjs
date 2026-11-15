// The SSH server card: the three server choices, the view's states (fingerprint, changed key, restart, needs password,
// uninstall confirmation) and the trust label. Server-rendered markup and the model only, so no DOM library is needed.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const require = createRequire(join(REPO, "desktop/package.json"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const h = React.createElement;

let m;
before(async () => {
  const { build } = require("esbuild");
  const dir = bundleDir("ssh-server-card");
  const outfile = join(dir, "entry.mjs");
  const entry = join(dir, "entry-src.ts");
  const at = (rel) => JSON.stringify(join(HERE, rel));
  writeFileSync(entry, [
    `export { default as RemoteServerCard, ConnectionState } from ${at("../sections/RemoteServerCard.tsx")};`,
    `export { SshServerView } from ${at("../sections/SshServerView.tsx")};`,
    `export { UninstallConfirm } from ${at("../sections/SshServerParts.tsx")};`,
    `export { SshServerModel, uninstallConfirmed, sshBadgeText } from ${at("../ssh-server-model.ts")};`,
    `export { coreTrustLabel, coreTrustTone } from ${at("../misc-model.ts")};`,
    `export { SettingsEnvProvider } from ${at("../context.tsx")};`,
  ].join("\n"));
  await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") } });
  m = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
});

/** Markup as a reader sees it: no React comment separators, apostrophes and quotes unescaped. */
const plain = (html) => html.replace(/<!-- -->/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');

const TRUSTED = { hostKeyType: "ssh-ed25519", fingerprint: "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff", trusted: true, changed: false, os: "Linux", arch: "x86_64", freeMb: 20480, installedVersion: null, claude: "missing" };
const UNKNOWN = { ...TRUSTED, trusted: false, os: null, arch: null, freeMb: null, claude: null };
const CHANGED = { ...UNKNOWN, changed: true };
const status = (link, extra = {}) => ({ link, host: "server.example.com", port: 22, user: "deploy", localUrl: "http://127.0.0.1:3456", version: "1.2.3", claude: "2.0.0", error: null, ...extra });

/** A fake io whose answers the test chooses; every method is optional so each test states only what it needs. */
function io(over = {}) {
  const no = async () => { throw new Error("not used in this test"); };
  return { test: no, confirm: no, connect: no, disconnect: no, status: async () => status("off"), stop: no, uninstall: no, saved: async () => ({ host: "", port: 22, user: "", keyPath: "", auth: "key" }), installKey: no, ...over };
}

/** A model with the target filled in and the given host answers applied through the public methods. */
async function model(over = {}, steps = async () => {}) {
  const model = new m.SshServerModel(io(over));
  model.setField("host", "server.example.com");
  model.setField("port", "22");
  model.setField("user", "deploy");
  model.setField("keyPath", "/home/deploy/.ssh/id_ed25519");
  await steps(model);
  return model;
}

const VIEW = (model, extra = {}) => h(m.SshServerView, { m: model, s: model.getState(), password: "", onPassword() {}, stopOpen: false, uninstallOpen: false, onStopOpen() {}, onUninstallOpen() {}, onRestart() {}, ...extra });
const PASSWORD = (model, extra = {}) => VIEW(model, { password: "hunter2", ...extra });

test("renders the three server choices", () => {
  const remoteHost = { getRemoteServer: async () => ({}), setRemoteServer: async () => ({}), remoteHubCheck: async () => ({}), remoteHubLogin: async () => ({}) };
  const env = { client: {}, host: remoteHost, serverMode: "ssh" };
  const html = renderToStaticMarkup(h(m.SettingsEnvProvider, { env }, h(m.RemoteServerCard, { chosen: "ssh", onChoose() {} })));
  const text = plain(html);
  for (const label of ["Local desktop", "Remote server", "SSH server"]) assert.match(text, new RegExp(label), label);
  for (const value of ["local", "remote", "ssh"]) assert.match(html, new RegExp(`value="${value}"`), value);
  // React writes `checked` before `value` in server markup, so match either order.
  const radio = (value) => html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>|<input[^>]*checked=""[^>]*value="${value}"[^>]*>`))?.[0] ?? "";
  assert.match(radio("ssh"), /checked/, "the SSH choice is checked");
  assert.doesNotMatch(radio("local"), /checked/, "Local is not checked when SSH is chosen");
});

test("the hub card reads the SSH server, not Local desktop, when the saved mode is ssh", () => {
  const html = plain(renderToStaticMarkup(h(m.ConnectionState, { s: { hubLogin: null, mode: "ssh" }, me: null, applied: "ssh" })));
  assert.match(html, /SSH server/);
  assert.doesNotMatch(html, /Using Local desktop/);
});

test("password field appears only for Password auth and has type=\"password\" and autocomplete=\"off\"", async () => {
  const keyAuth = await model();
  assert.doesNotMatch(renderToStaticMarkup(VIEW(keyAuth)), /type="password"/);
  const passwordAuth = await model();
  passwordAuth.setAuth("password");
  const html = renderToStaticMarkup(VIEW(passwordAuth));
  assert.match(html, /<input[^>]*type="password"[^>]*>/);
  assert.match(html, /<input[^>]*type="password"[^>]*autocomplete="off"|<input[^>]*autocomplete="off"[^>]*type="password"/i);
  assert.match(plain(html), /Kept only until you quit the app\. It is never saved\./);
});

test("Connect is disabled until the fingerprint is confirmed", async () => {
  const untested = await model({ test: async () => UNKNOWN });
  assert.match(renderToStaticMarkup(VIEW(untested)), /<button[^>]*disabled=""[^>]*>Connect</);
  const pending = await model({ test: async () => UNKNOWN }, async (x) => { await x.test(); });
  assert.match(renderToStaticMarkup(VIEW(pending)), /<button[^>]*disabled=""[^>]*>Connect</, "an untrusted key keeps Connect disabled");
  const trusted = await model({ test: async () => TRUSTED }, async (x) => { await x.test(); });
  assert.doesNotMatch(renderToStaticMarkup(VIEW(trusted)), /<button[^>]*disabled=""[^>]*>Connect</);
});

test("the fingerprint prompt and Trust this key show for an untrusted key", async () => {
  const pending = await model({ test: async () => UNKNOWN }, async (x) => { await x.test(); });
  const text = plain(renderToStaticMarkup(VIEW(pending)));
  assert.match(text, /Compare this fingerprint with the server's before you continue\./);
  assert.match(text, /Trust this key/);
  assert.match(text, /SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff/);
});

test("changed key shows the warning", async () => {
  const changed = await model({ test: async () => CHANGED }, async (x) => { await x.test(); });
  assert.match(plain(renderToStaticMarkup(VIEW(changed))), /This server's key is different from the one you trusted before\. Only continue if you know why it changed\./);
});

test("a trusted test shows what was found on the server", async () => {
  const trusted = await model({ test: async () => TRUSTED }, async (x) => { await x.test(); });
  const text = plain(renderToStaticMarkup(VIEW(trusted)));
  assert.match(text, /Linux x86_64/);
  assert.match(text, /20 GB free/);
  assert.match(text, /Server part: not installed yet/);
  assert.match(text, /Claude is not installed on this server\. Sign in to the server and run "claude login" after installing it\./);
});

test("needs_password status shows the password prompt, not an error", async () => {
  const needs = await model({ status: async () => status("needs_password") }, async (x) => { await x.refreshStatus(); });
  needs.setAuth("password");
  const html = renderToStaticMarkup(PASSWORD(needs));
  const text = plain(html);
  assert.match(text, /Enter the password to reconnect to server\.example\.com\./);
  assert.match(html, /<input[^>]*type="password"[^>]*autofocus|<input[^>]*autofocus[^>]*type="password"/i, "the password field is focused");
  assert.equal(needs.getState().error, null);
  assert.doesNotMatch(text, /Could not reach|refused this login/);
});

test("restart_required shows the restart note", async () => {
  const saved = await model({ status: async () => status("restart_required") }, async (x) => { await x.refreshStatus(); });
  const text = plain(renderToStaticMarkup(VIEW(saved)));
  assert.match(text, /Saved\. Restart the app to switch to this server\./);
  assert.match(text, /Restart the app/);
});

test("Use a key from now on appears only for Password auth while connected", async () => {
  const connected = async (auth) => {
    const x = await model({ status: async () => status("connected") }, async (y) => { await y.refreshStatus(); });
    x.setAuth(auth);
    return x;
  };
  const text = (x) => plain(renderToStaticMarkup(PASSWORD(x)));
  const hint = "Creates a key on this computer and adds it to the server so the password is not needed again.";
  assert.match(text(await connected("password")), /Use a key from now on/);
  assert.match(text(await connected("password")), new RegExp(hint.replace(/[.]/g, "\\.")));
  assert.doesNotMatch(text(await connected("key")), /Use a key from now on/);
  const offline = await model();
  offline.setAuth("password");
  assert.doesNotMatch(text(offline), /Use a key from now on/);
});

test("Uninstall asks for the host name and stays disabled until it matches", () => {
  const open = (host, typed) => renderToStaticMarkup(h(m.UninstallConfirm, { host, busy: false, onConfirm() {}, onCancel() {} }));
  const html = open("server.example.com");
  assert.match(plain(html), /This removes the server part from server\.example\.com\. Your data on the server is kept\./);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Uninstall</, "disabled until the host name is typed");
  assert.equal(m.uninstallConfirmed(" SERVER.example.com ", "server.example.com"), true, "trimmed and case-insensitive");
  assert.equal(m.uninstallConfirmed("server", "server.example.com"), false);
  assert.equal(m.uninstallConfirmed("", ""), false, "an empty host never matches");
});

test("trust label: the ssh forward reads as a pinned SSH server, not an adopted core", () => {
  assert.equal(m.coreTrustLabel("ssh-pinned"), "SSH server (host key pinned)");
  assert.equal(m.coreTrustTone("ssh-pinned"), "ok");
  assert.match(m.coreTrustLabel("adopted-unverified"), /Adopted \(unverified\)/);
});

test("toolbar badge texts: connected shows the host, reconnecting says so, other links show nothing", () => {
  assert.equal(m.sshBadgeText("connected", "server.example.com"), "SSH: server.example.com");
  assert.equal(m.sshBadgeText("reconnecting", "server.example.com"), "Reconnecting to server.example.com…");
  assert.equal(m.sshBadgeText("needs_password", "server.example.com"), null);
  assert.equal(m.sshBadgeText("connected", "  "), null);
});
