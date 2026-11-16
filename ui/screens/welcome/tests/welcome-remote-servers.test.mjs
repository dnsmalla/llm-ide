// Welcome → Remote servers: the recent SSH servers sit in the Connect card with a Connect button each, and Connect opens
// the connect flow prefilled for that server. The views are plain functions; the test walks their element tree.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

const h = React.createElement;
let card;
let list;
let recent;
let model;
before(async () => {
  card = await load("../welcome/SshConnectCard.tsx");
  list = await load("../welcome/RecentSshServers.tsx");
  recent = await load("../welcome/ssh-recent.ts");
  model = await load("../settings/ssh-server-model.ts");
});

const plain = (html) => html.replace(/<!-- -->/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const KEY = { host: "server.example.com", port: 22, user: "deploy", keyPath: "/home/me/.ssh/id_ed25519", auth: "key", lastUsed: 1700000000000 };
const PASSWORD = { host: "pw.example.com", port: 2222, user: "ops", keyPath: "", auth: "password", lastUsed: 1699000000000 };
const TRUSTED = { hostKeyType: "ssh-ed25519", fingerprint: "SHA256:AAAA", trusted: true, changed: false, os: "Linux", arch: "x86_64", freeMb: 20480, installedVersion: null, claude: "missing", glibc: null };

function fakeIo(over = {}) {
  const no = async () => { throw new Error("not used in this test"); };
  return { test: no, confirm: no, connect: no, disconnect: no, status: async () => ({ link: "off" }), stop: no, uninstall: no, saved: no, installKey: no, recent: async () => [], forget: async () => undefined, ...over };
}

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

test("the Connect card lists the recent servers, each with Connect, under the Connect… entry", () => {
  const html = plain(renderToStaticMarkup(h(card.SshConnectCard, { onConnect() {}, notice: null },
    h(list.RecentSshServersView, { servers: [KEY, PASSWORD], busy: false, message: null, menuKey: null, forgetKey: null, forgetError: null, onToggleMenu() {}, onAskForget() {}, onCancelForget() {}, onForget() {}, onEdit() {}, onConnect() {} }))));
  assert.match(html, />Connect…</, "the entry for a new server stays");
  assert.match(html, /Recent SSH servers/);
  assert.match(html, /deploy@server\.example\.com:22/);
  assert.match(html, /ops@pw\.example\.com:2222/);
  assert.equal((html.match(/>Connect<\/button>/g) ?? []).length, 2, "one Connect button per recent server");
});

test("Connect on a password server opens the dialog with the server already filled in", async () => {
  const m = new model.SshServerModel(fakeIo());
  const outcome = await recent.connectRecentServer(m, PASSWORD);
  assert.equal(outcome, "dialog", "the password is asked for in the dialog");
  assert.equal(m.getState().host, "pw.example.com");
  assert.equal(String(m.getState().port), "2222");
  assert.equal(m.getState().user, "ops");
  assert.equal(m.getState().auth, "password");
});

test("Connect on a key server with a trusted key connects with no dialog", async () => {
  const m = new model.SshServerModel(fakeIo({ test: async () => TRUSTED, connect: async () => ({ link: "connected", host: KEY.host, port: 22, user: "deploy", localUrl: "", version: "1", claude: "2", error: null }) }));
  assert.equal(await recent.connectRecentServer(m, KEY), "connected");
  assert.equal(m.getState().host, "server.example.com");
});

test("a row's Connect calls its own entry's handler", () => {
  const picked = [];
  const tree = list.RecentSshServersView({ servers: [KEY, PASSWORD], busy: false, message: null, menuKey: null, forgetKey: null, forgetError: null, onToggleMenu() {}, onAskForget() {}, onCancelForget() {}, onForget() {}, onEdit() {}, onConnect(entry) { picked.push(entry.host); } });
  // Two rows: the first Connect button belongs to KEY, so its handler is called with KEY.
  const first = findButton(tree, "Connect");
  first.props.onClick();
  assert.deepEqual(picked, ["server.example.com"]);
});
