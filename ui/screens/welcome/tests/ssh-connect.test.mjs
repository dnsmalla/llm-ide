// Welcome → Connect to SSH server: the card, the recent servers, the connect dialog and the switch step. The views are
// plain functions over props, so a test renders them to markup or walks their element tree and calls a button's
// handler; no DOM library is needed. The stateful wrappers are thin and are covered through these views.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

const h = React.createElement;
let card;
let dialog;
let recent;
let list;
let model;
let welcome;
let form;
before(async () => {
  card = await load("../welcome/SshConnectCard.tsx");
  dialog = await load("../welcome/SshConnectDialog.tsx");
  recent = await load("../welcome/ssh-recent.ts");
  list = await load("../welcome/RecentSshServers.tsx");
  model = await load("../settings/ssh-server-model.ts");
  welcome = await load("../welcome/WelcomeScreen.tsx");
  form = await load("../settings/sections/SshServerForm.tsx");
});

/** Markup as a reader sees it: no React comment separators, apostrophes and quotes unescaped. */
const plain = (html) => html.replace(/<!-- -->/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');

const TRUSTED = { hostKeyType: "ssh-ed25519", fingerprint: "SHA256:AAAA1111bbbbCCCC2222dddd3333eeee4444ffff", trusted: true, changed: false, os: "Linux", arch: "x86_64", freeMb: 20480, installedVersion: null, claude: "missing", glibc: null };
const UNKNOWN = { ...TRUSTED, trusted: false, os: null, arch: null, freeMb: null, claude: null };
const CHANGED = { ...UNKNOWN, changed: true };
const KEY = { host: "server.example.com", port: 22, user: "deploy", keyPath: "/home/me/.ssh/id_ed25519", auth: "key", lastUsed: 1700000000000, passwordSaved: false };
const PASSWORD = { host: "pw.example.com", port: 2222, user: "ops", keyPath: "", auth: "password", lastUsed: 1699000000000, passwordSaved: false };
const status = (link, extra = {}) => ({ link, host: "server.example.com", port: 22, user: "deploy", localUrl: "http://127.0.0.1:3456", version: "1.2.3", claude: "2.0.0", error: null, ...extra });
const SWITCH_SENTENCE = "The app restarts and works on server.example.com. Running Loop or agent work on this computer stops.";
const FORGET_SENTENCE = "Forget deploy@server.example.com? Its saved host key is removed too.";

/** A fake host. Every method throws unless the test states the answer it needs. */
function fakeIo(over = {}) {
  const no = async () => { throw new Error("not used in this test"); };
  return { test: no, confirm: no, connect: no, disconnect: no, status: async () => status("off"), stop: no, uninstall: no, saved: no, installKey: no, recent: async () => [], forget: async () => undefined, ...over };
}

/** Depth-first search of an element tree (arrays, props.children) for the first node the predicate accepts. */
function findNode(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !node.props) return null;
  if (predicate(node)) return node;
  return findNode(node.props.children, predicate);
}
// Matches a `<button>` and the settings kit's `Button` alike: both carry the label as children and an onClick prop.
const findButton = (tree, label) => findNode(tree, (n) => n.props.children === label && typeof n.props.onClick === "function");
const findRole = (tree, role) => findNode(tree, (n) => n.props.role === role);
// SwitchStep is a component element inside the dialog's tree: its buttons exist only once it is called.
const switchStep = (tree) => {
  const node = findNode(tree, (n) => n.type === dialog.SwitchStep);
  assert.ok(node, "the switch step is in the dialog");
  return node.type(node.props);
};

// ---- the card ----------------------------------------------------------------------------------------------------

test("the Welcome card names the SSH server, says what it does, and offers Connect…", () => {
  const html = plain(renderToStaticMarkup(h(card.SshConnectCard, { onConnect() {}, notice: null })));
  assert.match(html, /Connect to SSH server/);
  assert.match(html, /Work on a server you can sign in to with SSH\. The app installs its server part in your home folder there\. No domain, certificate or administrator access is needed\./);
  assert.match(html, />Connect…</);
  assert.doesNotMatch(html, /Set up/, "the old entry's button is gone");
});

test("Connect… calls onConnect; a connect notice shows as a status line", () => {
  let opened = 0;
  findButton(card.SshConnectCard({ onConnect() { opened += 1; }, notice: null }), "Connect…").props.onClick();
  assert.equal(opened, 1);
  assert.match(plain(renderToStaticMarkup(h(card.SshConnectCard, { onConnect() {}, notice: "Connected to server.example.com." }))), /Connected to server\.example\.com\./);
});

// ---- connecting a recent key server without the dialog ------------------------------------------------------------

test("a key server connects straight away: no password is sent and no dialog step is needed", async () => {
  const calls = [];
  const m = new model.SshServerModel(fakeIo({
    test: async () => { calls.push("test"); return TRUSTED; },
    connect: async (target, password) => { calls.push(["connect", target.host, password]); return status("connected"); },
  }));
  assert.equal(await recent.connectRecentServer(m, KEY), "connected");
  assert.deepEqual(calls, ["test", ["connect", "server.example.com", undefined]]);
});

test("a key server whose restart is needed reports switch; the connection is not made twice", async () => {
  let connects = 0;
  const m = new model.SshServerModel(fakeIo({
    test: async () => TRUSTED,
    connect: async () => { connects += 1; return status("restart_required"); },
  }));
  assert.equal(await recent.connectRecentServer(m, KEY), "switch");
  assert.equal(connects, 1);
});

test("a changed or unknown host key opens the dialog at the fingerprint step and connects nothing", async () => {
  let connects = 0;
  const changed = new model.SshServerModel(fakeIo({ test: async () => CHANGED, connect: async () => { connects += 1; return status("connected"); } }));
  assert.equal(await recent.connectRecentServer(changed, KEY), "dialog");
  const unknown = new model.SshServerModel(fakeIo({ test: async () => UNKNOWN, connect: async () => { connects += 1; return status("connected"); } }));
  assert.equal(await recent.connectRecentServer(unknown, KEY), "dialog");
  assert.equal(connects, 0, "nothing connects without a trusted key");
  assert.equal(changed.getState().test?.changed, true, "the fingerprint is kept for the dialog to show");
});

test("a key server that asks for a password opens the dialog; a failed link stays in the row", async () => {
  const asks = new model.SshServerModel(fakeIo({ test: async () => TRUSTED, connect: async () => status("needs_password") }));
  assert.equal(await recent.connectRecentServer(asks, KEY), "dialog");
  const failed = new model.SshServerModel(fakeIo({ test: async () => TRUSTED, connect: async () => status("failed", { error: "Could not reach the server." }) }));
  assert.equal(await recent.connectRecentServer(failed, KEY), "failed");
  assert.equal(recent.recentRowMessage(failed.getState(), recent.recentKey(KEY), recent.recentKey(KEY)).text, "Could not reach the server.");
});

test("a password server never reaches the host from the list: the outcome is the dialog", async () => {
  let calls = 0;
  const m = new model.SshServerModel(fakeIo({ test: async () => { calls += 1; return TRUSTED; }, connect: async () => { calls += 1; return status("connected"); } }));
  assert.equal(await recent.connectRecentServer(m, PASSWORD), "dialog");
  assert.equal(calls, 0);
  assert.equal(m.getState().host, "pw.example.com", "the form is filled for the dialog");
  assert.equal(m.getState().auth, "password");
});

test("the row message: progress while the server answers, the error for this row only", () => {
  const busy = { busy: "connect", error: null, status: null };
  assert.equal(recent.recentRowMessage(busy, "a", "a")?.text, "Connecting…");
  assert.equal(recent.recentRowMessage(busy, "a", "b"), null, "another row shows nothing");
  assert.equal(recent.recentRowMessage({ busy: null, error: "Test the connection first.", status: null }, "a", "a")?.tone, "error");
  assert.equal(recent.recentRowMessage({ busy: null, error: null, status: null }, "a", "a"), null);
});

test("the recent list is hidden when the host has no such command or cannot answer", async () => {
  assert.deepEqual(await recent.loadRecent(fakeIo({ recent: async () => { throw new Error("unknown command"); } })), []);
  assert.deepEqual(await recent.loadRecent(fakeIo({ recent: async () => [KEY] })), [KEY]);
  const html = renderToStaticMarkup(h(list.RecentSshServersView, { servers: [], busy: false, message: null, menuKey: null, forgetKey: null, forgetError: null, onToggleMenu() {}, onAskForget() {}, onCancelForget() {}, onForget() {}, onEdit() {}, onConnect() {} }));
  assert.equal(html, "", "no recent list, no empty heading, no error");
});

// ---- the recent list ----------------------------------------------------------------------------------------------

const LIST_PROPS = (over = {}) => ({ servers: [KEY, PASSWORD], busy: false, message: null, menuKey: null, forgetKey: null, forgetError: null, onToggleMenu() {}, onAskForget() {}, onCancelForget() {}, onForget() {}, onEdit() {}, onConnect() {}, ...over });

test("recent rows read user@host:port with the sign-in method and a Connect button", () => {
  const html = plain(renderToStaticMarkup(h(list.RecentSshServersView, LIST_PROPS())));
  assert.match(html, /deploy@server\.example\.com:22/);
  assert.match(html, /ops@pw\.example\.com:2222/);
  assert.match(html, /Key file/);
  assert.match(html, /Password/);
  assert.equal((html.match(/>Connect</g) ?? []).length, 2);
  assert.doesNotMatch(html, /Forget/, "the menu is closed until asked for");
});

test("while busy, the rows are disabled", () => {
  const html = renderToStaticMarkup(h(list.RecentSshServersView, LIST_PROPS({ busy: true })));
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>Connect</g) ?? []).length, 2);
});

test("the menu offers Edit and Forget; Forget asks first with the exact sentence, then forgets", () => {
  const calls = [];
  const menu = LIST_PROPS({ menuKey: "deploy@server.example.com:22", onEdit: (e) => calls.push(["edit", e.host]), onAskForget: (k) => calls.push(["ask", k]) });
  const html = plain(renderToStaticMarkup(h(list.RecentSshServersView, menu)));
  assert.match(html, />Edit</);
  assert.match(html, />Forget</);
  findButton(list.RecentSshServersView(menu), "Edit").props.onClick();
  findButton(list.RecentSshServersView(menu), "Forget").props.onClick();
  assert.deepEqual(calls, [["edit", "server.example.com"], ["ask", "deploy@server.example.com:22"]]);

  const confirm = LIST_PROPS({ forgetKey: "deploy@server.example.com:22" });
  assert.ok(plain(renderToStaticMarkup(h(list.RecentSshServersView, confirm))).includes(FORGET_SENTENCE), "the exact confirmation");
  let forgotten = null;
  let cancelled = 0;
  const asked = LIST_PROPS({ forgetKey: "deploy@server.example.com:22", onForget: (e) => { forgotten = e; }, onCancelForget: () => { cancelled += 1; } });
  findButton(list.RecentSshServersView(asked), "Cancel").props.onClick();
  assert.equal(cancelled, 1);
  assert.equal(forgotten, null, "Cancel forgets nothing");
  findButton(list.RecentSshServersView(asked), "Forget").props.onClick();
  assert.deepEqual(forgotten, KEY, "Forget passes the row's own entry");
});

test("the row message shows under its row only", () => {
  const html = plain(renderToStaticMarkup(h(list.RecentSshServersView, LIST_PROPS({ message: { key: "ops@pw.example.com:2222", tone: "error", text: "The server refused this login." } }))));
  assert.match(html, /The server refused this login\./);
  assert.equal((html.match(/The server refused this login\./g) ?? []).length, 1);
});

// ---- the dialog --------------------------------------------------------------------------------------------------

function dialogProps(m, over = {}) {
  return {
    m, s: m.getState(), password: "", onPassword() {}, readOnly: false, onEditDetails() {}, passwordOnly: false,
    confirming: false, switching: false, switchError: null, onAskSwitch() {}, onCancelSwitch() {}, onSwitch() {},
    onClose() {}, onConnected() {}, onEscape() {}, cardRef: null, ...over,
  };
}

test("the password dialog for a recent password server: only the password is editable and it is focused", () => {
  const m = new model.SshServerModel(fakeIo());
  m.loadFrom(PASSWORD);
  const html = renderToStaticMarkup(h(dialog.SshConnectDialogView, dialogProps(m, { readOnly: true, passwordOnly: true, password: "" })));
  assert.match(html, /<input[^>]*type="password"[^>]*autofocus|<input[^>]*autofocus[^>]*type="password"/i, "the password field is focused");
  assert.equal((html.match(/<input[^>]*readonly=""[^>]*>/gi) ?? []).length, 3, "host, port and user are read-only");
  assert.match(plain(html), /Edit details/);
  assert.match(plain(html), /Connect to SSH server/);
  assert.match(html, />Cancel</);
});

test("Edit details leaves the read-only mode; a full dialog has no Edit details link", () => {
  const m = new model.SshServerModel(fakeIo());
  m.loadFrom(PASSWORD);
  let edited = 0;
  findButton(dialog.SshConnectDialogView(dialogProps(m, { readOnly: true, passwordOnly: true, onEditDetails() { edited += 1; } })), "Edit details").props.onClick();
  assert.equal(edited, 1);
  const full = renderToStaticMarkup(h(dialog.SshConnectDialogView, dialogProps(m)));
  assert.doesNotMatch(plain(full), /Edit details/);
  assert.doesNotMatch(full, /readonly=""/i);
});

test("Escape closes the dialog; Cancel closes it; both are the same close", () => {
  const m = new model.SshServerModel(fakeIo());
  let closed = 0;
  let escaped = 0;
  const tree = dialog.SshConnectDialogView(dialogProps(m, { onClose() { closed += 1; }, onEscape() { escaped += 1; } }));
  findRole(tree, "dialog").props.onKeyDown({ key: "Escape", stopPropagation() {} });
  assert.equal(escaped, 1, "Escape goes to the wrapper, which decides what it closes");
  findButton(tree, "Cancel").props.onClick();
  assert.equal(closed, 1);
});

test("a restart_required connect shows Switch to this server now; the switch does not run until Switch is pressed", () => {
  const m = new model.SshServerModel(fakeIo());
  m.loadFrom(KEY);
  m.setField("host", "server.example.com");
  const saved = { ...m.getState(), status: status("restart_required") };
  const view = (over) => dialog.SshConnectDialogView({ ...dialogProps(m), s: saved, ...over });
  const shown = plain(renderToStaticMarkup(h(dialog.SshConnectDialogView, { ...dialogProps(m), s: saved })));
  assert.match(shown, /Switch to this server now/);
  assert.doesNotMatch(shown, /The app restarts and works on/, "the confirmation is not open yet");

  let asked = 0;
  let switched = 0;
  findButton(switchStep(view({ onAskSwitch() { asked += 1; }, onSwitch() { switched += 1; } })), "Switch to this server now").props.onClick();
  assert.equal(asked, 1);
  assert.equal(switched, 0, "pressing the first button does not restart the app");

  const confirmOpen = renderToStaticMarkup(h(dialog.SshConnectDialogView, { ...dialogProps(m), s: saved, confirming: true }));
  assert.ok(plain(confirmOpen).includes(SWITCH_SENTENCE), "the exact confirmation text");
  assert.match(confirmOpen, />Switch</);
  assert.match(confirmOpen, />Cancel</);
  findButton(switchStep(view({ confirming: true, onSwitch() { switched += 1; } })), "Switch").props.onClick();
  assert.equal(switched, 1, "Switch is the only thing that restarts");
});

test("the switch step itself: Cancel closes the confirmation and restarts nothing", () => {
  let cancelled = 0;
  let switched = 0;
  const tree = dialog.SwitchStep({ host: "server.example.com", confirming: true, switching: false, switchError: null, onAsk() {}, onCancel() { cancelled += 1; }, onSwitch() { switched += 1; } });
  findButton(tree, "Cancel").props.onClick();
  assert.equal(cancelled, 1);
  assert.equal(switched, 0);
});

test("the dialog's form is the shared SSH form, with the same fields as Settings", () => {
  const m = new model.SshServerModel(fakeIo());
  const html = renderToStaticMarkup(h(dialog.SshConnectDialogView, dialogProps(m)));
  assert.match(html, /Sign in with/);
  assert.doesNotMatch(html, />Test</, "one Connect, no separate Test");
  assert.match(html, />Connect</);
  assert.equal(typeof form.SshServerForm, "function");
});

// ---- the page ------------------------------------------------------------------------------------------------------

test("the Welcome page shows the card and nothing called Set up", () => {
  const actions = { createProject: async () => null, openFolder: async () => undefined, openRecent: async () => undefined, forgetRecent: async () => undefined, closeProject: async () => undefined, goHome() {} };
  const html = plain(renderToStaticMarkup(h(welcome.WelcomeScreen, { project: null, recent: { entries: [], reset: false }, error: null, actions, ssh: { io: fakeIo(), switchToServer: async () => undefined } })));
  assert.match(html, /Connect to SSH server/);
  assert.match(html, />Connect…</);
  assert.doesNotMatch(html, />Set up</);
});

// ---- review round 1 ----------------------------------------------------------------------------------------------

test("a test that cannot run (unreachable host) shows its error in the row, not the dialog", async () => {
  const m = new model.SshServerModel(fakeIo({ test: async () => { throw new Error("Could not reach the server."); } }));
  assert.equal(await recent.connectRecentServer(m, KEY), "failed");
  assert.equal(m.getState().test, null, "no test result is kept");
  assert.equal(recent.recentRowMessage(m.getState(), recent.recentKey(KEY), recent.recentKey(KEY))?.text, "Could not reach the server.");
});

test("a connect that rejects after a trusted test shows its error in the row", async () => {
  const m = new model.SshServerModel(fakeIo({ test: async () => TRUSTED, connect: async () => { throw new Error("The server refused this login."); } }));
  assert.equal(await recent.connectRecentServer(m, KEY), "failed");
  assert.equal(recent.recentRowMessage(m.getState(), recent.recentKey(KEY), recent.recentKey(KEY))?.text, "The server refused this login.");
});

test("Escape closes the switch confirmation first and the dialog otherwise", () => {
  assert.equal(recent.escapeTarget(true), "confirmation");
  assert.equal(recent.escapeTarget(false), "dialog");
  const m = new model.SshServerModel(fakeIo());
  let escaped = 0;
  const tree = dialog.SshConnectDialogView(dialogProps(m, { confirming: true, onEscape() { escaped += 1; } }));
  findRole(tree, "dialog").props.onKeyDown({ key: "Escape", stopPropagation() {} });
  assert.equal(escaped, 1, "Escape on the open confirmation reaches the wrapper, which closes only the confirmation");
});

test("the switch step's two containers are focus targets, so focus survives the button change", () => {
  const base = { host: "server.example.com", switching: false, switchError: null, onAsk() {}, onCancel() {}, onSwitch() {}, askRef: { current: null }, confirmRef: { current: null } };
  const ask = renderToStaticMarkup(h(dialog.SwitchStep, { ...base, confirming: false }));
  assert.match(ask, /tabindex="-1"/, "the ask step container can take focus");
  const confirm = renderToStaticMarkup(h(dialog.SwitchStep, { ...base, confirming: true }));
  assert.match(confirm, /tabindex="-1"[^>]*role="alertdialog"/, "the confirmation container can take focus");
});

test("while the switch is offered, Connect is disabled; otherwise it is not", () => {
  const m = new model.SshServerModel(fakeIo());
  m.loadFrom(KEY);
  const saved = { ...m.getState(), status: status("restart_required") };
  const offered = renderToStaticMarkup(h(dialog.SshConnectDialogView, { ...dialogProps(m), s: saved }));
  assert.match(offered, /<button[^>]*disabled=""[^>]*>Connect</, "Connect is off under the switch");
  // With a trusted host key and no switch offered, Connect is on: only the restart answer turns it off.
  const trusted = { ...m.getState(), test: TRUSTED };
  const plainHtml = renderToStaticMarkup(h(dialog.SshConnectDialogView, { ...dialogProps(m), s: trusted }));
  assert.doesNotMatch(plainHtml, /disabled=""[^>]*>Connect</);
});

test("the password hint is the same in the dialog and in Settings, and says what the checkbox does", () => {
  const m = new model.SshServerModel(fakeIo());
  m.setAuth("password");
  const dialogHtml = plain(renderToStaticMarkup(h(dialog.SshConnectDialogView, dialogProps(m))));
  const formHtml = plain(renderToStaticMarkup(h(form.SshServerForm, { m, s: m.getState(), password: "", onPassword() {} })));
  for (const html of [dialogHtml, formHtml]) {
    assert.match(html, /Used for this connection only\. It is not saved unless you tick the box below\./);
    assert.match(html, /Remember password in Keychain/);
    assert.doesNotMatch(html, /It is never saved|Kept only until you quit/, "the old, inaccurate hints are gone");
  }
  m.setRemember(true);
  const saved = plain(renderToStaticMarkup(h(form.SshServerForm, { m, s: m.getState(), password: "", onPassword() {} })));
  assert.match(saved, /Saved in the Keychain on this computer after a good sign-in\. App files never hold it\./);
  assert.match(saved, /<input[^>]*type="checkbox"[^>]*checked=""|<input[^>]*checked=""[^>]*type="checkbox"/);
});

test("the recent list sits inside the card, under the Connect… button", () => {
  const html = plain(renderToStaticMarkup(h(card.SshConnectCard, { onConnect() {}, notice: null }, h("p", null, "RECENT-LIST-MARK"))));
  assert.match(html, /<section[^>]*wc-ssh-card[^>]*>[\s\S]*Connect…[\s\S]*RECENT-LIST-MARK[\s\S]*<\/section>/);
});

test("the Welcome page has one connect card: the Remote hosts card is gone", () => {
  const actions = { createProject: async () => null, openFolder: async () => undefined, openRecent: async () => undefined, forgetRecent: async () => undefined, closeProject: async () => undefined, goHome() {} };
  const html = plain(renderToStaticMarkup(h(welcome.WelcomeScreen, { project: null, recent: { entries: [], reset: false }, error: null, actions, ssh: { io: fakeIo(), switchToServer: async () => undefined } })));
  assert.doesNotMatch(html, /Remote hosts/);
  assert.equal((html.match(/wc-ssh-card/g) ?? []).length, 1);
});

// ---- one Connect, take over, remembered password --------------------------------------------------------------------

test("the restart asks only when Loop work is running; with nothing running Connect was the answer", () => {
  assert.equal(recent.switchDecision(true), "ask");
  assert.equal(recent.switchDecision(false), "switch");
});

test("the dialog's switch step shows the restart, not a second button, while an automatic switch runs", () => {
  const html = plain(renderToStaticMarkup(h(dialog.SwitchStep, { host: "server.example.com", confirming: false, switching: true, switchError: null, onAsk() {}, onCancel() {}, onSwitch() {} })));
  assert.match(html, /Restarting the app onto server\.example\.com…/);
  assert.doesNotMatch(html, /Switch to this server now/);
  const failed = plain(renderToStaticMarkup(h(dialog.SwitchStep, { host: "server.example.com", confirming: false, switching: false, switchError: "The switch failed.", onAsk() {}, onCancel() {}, onSwitch() {} })));
  assert.match(failed, /Switch to this server now/, "after a failed automatic switch the button is the way back");
  assert.match(failed, /The switch failed\./);
});

test("a password server with a password in the Keychain connects from the list in one click, sending no password", async () => {
  const calls = [];
  const saved = { ...PASSWORD, passwordSaved: true };
  const m = new model.SshServerModel(fakeIo({
    test: async (target, password, options) => { calls.push(["test", password, options]); return TRUSTED; },
    connect: async (target, password, options) => { calls.push(["connect", password, options]); return status("connected"); },
  }));
  assert.equal(await recent.connectRecentServer(m, saved), "connected");
  assert.deepEqual(calls, [["test", undefined, { useSaved: true, remember: true }], ["connect", undefined, { useSaved: true, remember: true }]]);
});

test("a password server without a stored password still opens the dialog for it", async () => {
  const m = new model.SshServerModel(fakeIo());
  assert.equal(await recent.connectRecentServer(m, PASSWORD), "dialog");
});

test("a remembered password the server now refuses opens the dialog, so the user can type the new one", async () => {
  const m = new model.SshServerModel(fakeIo({ test: async () => { throw { code: "SSH_AUTH_FAILED", message: "" }; } }));
  assert.equal(await recent.connectRecentServer(m, { ...PASSWORD, passwordSaved: true }), "dialog");
  assert.equal(m.getState().error, "The server refused this login.");
});

test("a server part left running by an earlier session opens the dialog with the take-over question", async () => {
  const m = new model.SshServerModel(fakeIo({ test: async () => TRUSTED, connect: async () => { throw { code: "SSH_CORE_FOREIGN", message: "" }; } }));
  assert.equal(await recent.connectRecentServer(m, KEY), "dialog");
  assert.equal(m.getState().foreign, "connect");
  const html = plain(renderToStaticMarkup(h(dialog.SshConnectDialogView, dialogProps(m))));
  assert.match(html, /A server part from an earlier session is still running on this account \(another computer, or this one before its app data was reset\)\. Taking over stops it; any work running in it ends\./);
  assert.match(html, />Take over</);
  assert.match(html, />Cancel</);
});

test("the take-over button repeats Connect with the flag", async () => {
  const connects = [];
  const m = new model.SshServerModel(fakeIo({
    test: async () => TRUSTED,
    connect: async (target, password, options) => { connects.push(options); if (connects.length === 1) throw { code: "SSH_CORE_FOREIGN", message: "" }; return status("connected"); },
  }));
  m.loadFrom(KEY);
  await m.connectWithTest();
  const view = dialog.SshConnectDialogView(dialogProps(m));
  const formNode = findNode(view, (n) => n.type?.name === "SshServerForm");
  assert.ok(formNode, "the shared form is in the dialog");
  const rendered = formNode.type(formNode.props);
  // The prompt is its own component: its handlers are props on the element.
  const prompt = findNode(rendered, (n) => typeof n.props.onTakeOver === "function");
  assert.ok(prompt, "Take over is offered");
  await prompt.props.onTakeOver();
  assert.deepEqual(connects.map((o) => o?.takeOver), [undefined, true]);
});

test("the dialog shows the check step, the facts as soon as the probe returns, and then the setup step", () => {
  const m = new model.SshServerModel(fakeIo());
  m.loadFrom(KEY);
  const checking = plain(renderToStaticMarkup(h(form.SshServerForm, { m, s: { ...m.getState(), busy: "test" }, password: "", onPassword() {} })));
  assert.match(checking, /Checking the server…/);
  const installing = plain(renderToStaticMarkup(h(form.SshServerForm, { m, s: { ...m.getState(), busy: "connect", test: TRUSTED }, password: "", onPassword() {} })));
  assert.match(installing, /Linux x86_64/, "the facts box is on screen while the server part is set up");
  assert.match(installing, /Installing the server part, starting it and connecting…/);
  const updating = plain(renderToStaticMarkup(h(form.SshServerForm, { m, s: { ...m.getState(), busy: "connect", test: { ...TRUSTED, installedVersion: "1.0.0" } }, password: "", onPassword() {} })));
  assert.match(updating, /Updating the server part if needed, starting it and connecting…/);
});

test("the recent list marks a login whose password is in the Keychain", () => {
  const html = plain(renderToStaticMarkup(h(list.RecentSshServersView, {
    servers: [{ ...PASSWORD, passwordSaved: true }], busy: false, message: null, menuKey: null, forgetKey: null, forgetError: null,
    onToggleMenu() {}, onAskForget() {}, onCancelForget() {}, onForget() {}, onEdit() {}, onConnect() {},
  })));
  assert.match(html, /Password \(in Keychain\)/);
});
