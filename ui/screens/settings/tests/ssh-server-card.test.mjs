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
    `export { SshServerModel, uninstallConfirmed, sshBadgeText, SSH_LOCAL_CONFIRM } from ${at("../ssh-server-model.ts")};`,
    `export { REMOTE_TEXT } from ${at("../remote-model.ts")};`,
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

const VIEW = (model, extra = {}) => h(m.SshServerView, { m: model, s: model.getState(), password: "", onPassword() {}, dialog: null, onDialog() {}, onRestart() {}, ...extra });
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

const INSTALLED = { ...TRUSTED, installedVersion: "1.2.3" };
const BUTTONS = (html) => plain(html);

test("Stop server and Uninstall show only for an installed server or a live link", async () => {
  const untested = await model();
  assert.doesNotMatch(BUTTONS(renderToStaticMarkup(VIEW(untested))), /Stop server|Uninstall/);
  const notInstalled = await model({ test: async () => TRUSTED }, async (x) => { await x.test(); });
  const hidden = BUTTONS(renderToStaticMarkup(VIEW(notInstalled)));
  assert.match(hidden, /Server part: not installed yet/);
  assert.doesNotMatch(hidden, /Stop server|Uninstall/, "a trusted but not installed server offers neither");
  const installed = await model({ test: async () => INSTALLED }, async (x) => { await x.test(); });
  assert.match(BUTTONS(renderToStaticMarkup(VIEW(installed))), /Stop server[\s\S]*Uninstall/);
  const live = await model({ status: async () => status("connected") }, async (x) => { await x.refreshStatus(); });
  assert.match(BUTTONS(renderToStaticMarkup(VIEW(live))), /Stop server/);
  const off = await model({ status: async () => status("off") }, async (x) => { await x.refreshStatus(); });
  assert.doesNotMatch(BUTTONS(renderToStaticMarkup(VIEW(off))), /Stop server|Uninstall/, "an off link is not a live link");
});

test("Disconnect shows only while the link is up; otherwise Connect", async () => {
  const up = await model({ status: async () => status("reconnecting") }, async (x) => { await x.refreshStatus(); });
  const upHtml = plain(renderToStaticMarkup(VIEW(up)));
  assert.match(upHtml, /Disconnect/);
  assert.doesNotMatch(renderToStaticMarkup(VIEW(up)), />Connect</);
  const down = await model({ status: async () => status("failed", { error: "x" }) }, async (x) => { await x.refreshStatus(); });
  assert.doesNotMatch(plain(renderToStaticMarkup(VIEW(down))), /Disconnect/);
});

test("a confirmation opened for another host does not show for this one", async () => {
  const current = await model({ test: async () => INSTALLED }, async (x) => { await x.test(); });
  const other = plain(renderToStaticMarkup(VIEW(current, { dialog: { kind: "uninstall", host: "old.example.com" } })));
  assert.doesNotMatch(other, /This removes the server part/);
  const same = plain(renderToStaticMarkup(VIEW(current, { dialog: { kind: "uninstall", host: "server.example.com" } })));
  assert.match(same, /This removes the server part from server\.example\.com\./);
});

test("Use a key from now on explains why it is disabled without a typed password", async () => {
  const connected = await model({ status: async () => status("connected") }, async (x) => { await x.refreshStatus(); });
  connected.setAuth("password");
  const without = plain(renderToStaticMarkup(VIEW(connected)));
  assert.match(without, /Enter the server password above to use this\./);
  assert.match(renderToStaticMarkup(VIEW(connected)), /<button[^>]*disabled=""[^>]*>Use a key from now on</);
  const withPassword = plain(renderToStaticMarkup(PASSWORD(connected)));
  assert.doesNotMatch(withPassword, /Enter the server password above to use this\./);
});

test("the login method is a labelled radio group", async () => {
  const html = renderToStaticMarkup(VIEW(await model()));
  assert.match(html, /role="radiogroup" aria-label="Sign in with"/);
  assert.match(plain(html), /<span class="st-label">Sign in with<\/span>/);
});

test("the SSH to Local switch names the SSH server; the hub text is unchanged", () => {
  assert.match(m.SSH_LOCAL_CONFIRM, /stops using the SSH server/);
  assert.equal(m.REMOTE_TEXT.localConfirm, "Switching to Local desktop stops using the hub and restarts the core on this computer.");
});

// The view is a plain function over the model (no hooks), so its element tree can be walked and a button's handler
// called without a DOM: this is how the forced retries are exercised.
const TREE = (model, extra = {}) => m.SshServerView({ m: model, s: model.getState(), password: "", onPassword() {}, dialog: null, onDialog() {}, onRestart() {}, ...extra });
function findButton(node, label) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !node.props) return null;
  if (node.props.children === label && typeof node.props.onClick === "function") return node;
  return findButton(node.props.children, label);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const FOREIGN_SENTENCE = "Another computer started the server on this account. Stopping it ends that computer's work.";
const FOREIGN = { code: "SSH_CORE_FOREIGN", message: "Another computer started the server on this account." };

test("the test result shows the glibc version when the host reports it, and nothing when it does not", async () => {
  const withGlibc = await model({ test: async () => ({ ...TRUSTED, glibc: "2.31" }) }, async (x) => { await x.test(); });
  assert.match(plain(renderToStaticMarkup(VIEW(withGlibc))), /System libraries: glibc 2\.31/);
  const without = await model({ test: async () => ({ ...TRUSTED, glibc: null }) }, async (x) => { await x.test(); });
  assert.doesNotMatch(plain(renderToStaticMarkup(VIEW(without))), /System libraries/);
});

test("a foreign core: stop shows the warning with Stop it anyway, uninstall with Uninstall anyway", async () => {
  const stopped = await model({ stop: async () => { throw FOREIGN; } }, async (x) => { await x.stopServer(); });
  const stopHtml = plain(renderToStaticMarkup(VIEW(stopped)));
  assert.ok(stopHtml.includes(FOREIGN_SENTENCE), "the warning sentence");
  assert.match(stopHtml, /Stop it anyway/);
  assert.doesNotMatch(stopHtml, /Uninstall anyway/);
  const uninstalled = await model({ uninstall: async () => { throw FOREIGN; } }, async (x) => { await x.uninstall(undefined, "server.example.com"); });
  const uninstallHtml = plain(renderToStaticMarkup(VIEW(uninstalled)));
  assert.ok(uninstallHtml.includes(FOREIGN_SENTENCE), "the same sentence for uninstall");
  assert.match(uninstallHtml, /Uninstall anyway/);
  assert.doesNotMatch(uninstallHtml, /Stop it anyway/);
  assert.doesNotMatch(plain(renderToStaticMarkup(VIEW(await model()))), /anyway/, "no warning without a foreign core");
});

test("Stop it anyway and Uninstall anyway repeat the call with force true; Cancel clears the warning", async () => {
  const calls = [];
  const stopModel = await model({ stop: async (_target, _password, force) => { calls.push(["stop", force]); if (!force) throw FOREIGN; return status("stopped"); } }, async (x) => { await x.stopServer(); });
  findButton(TREE(stopModel), "Stop it anyway").props.onClick();
  await tick();
  assert.deepEqual(calls, [["stop", false], ["stop", true]]);
  assert.equal(stopModel.getState().foreign, null, "a forced stop that succeeds leaves no warning");

  const uninstallModel = await model({ uninstall: async (_password, _host, force) => { calls.push(["uninstall", force]); if (!force) throw FOREIGN; return status("off"); } }, async (x) => { await x.uninstall(undefined, "server.example.com"); });
  findButton(TREE(uninstallModel), "Uninstall anyway").props.onClick();
  await tick();
  assert.deepEqual(calls.slice(2), [["uninstall", false], ["uninstall", true]]);

  const cancelled = await model({ stop: async () => { throw FOREIGN; } }, async (x) => { await x.stopServer(); });
  findButton(TREE(cancelled), "Cancel").props.onClick();
  assert.equal(cancelled.getState().foreign, null);
  assert.equal(calls.length, 4, "Cancel calls nothing");
});
