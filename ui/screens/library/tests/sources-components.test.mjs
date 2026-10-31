process.env.TZ = "UTC";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadBundle, react, server } from "./write-helpers.mjs";

let L;
let h;
let html;
before(async () => {
  L = await loadBundle("library-sources", "sources-entry.ts");
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});

const mkEnv = () => {
  const host = new L.FakeHost();
  return { core: { call: async () => ({ status: 200, body: {} }) }, write: new L.FakeWriteHost(host), storage: null, openExternal: async () => {}, pickFolder: null, now: () => 0 };
};
const count = (s, re) => (s.match(re) ?? []).length;

test("connection entries: five panes with stable ids, and the nav shows them under Connections", async () => {
  const env = mkEnv();
  const list = L.sourceConnections(env);
  assert.deepEqual(list.map((x) => x.label), ["Email", "Slack", "Box", "Repositories", "Connectors"]);
  assert.equal(new Set(list.map((x) => x.id)).size, 5);
  assert.ok(list.every((x) => typeof x.render === "function"));
  const host = new L.FakeHost();
  host.add("source/meetings/2026/10/a.md", L.meetingText(1));
  const store = new L.LibraryStore({ host });
  await store.init();
  await L.settle(store);
  const out = html(h(L.LibraryScreen, { store, host, connections: list }));
  assert.match(out, /<h3 class="lib-nav-group">[\s\S]*?Connections<\/h3>/);
  for (const label of ["Email", "Slack", "Box", "Repositories", "Connectors"]) assert.match(out, new RegExp(`<span class="lib-nav-label">${label}</span>`));
  const none = html(h(L.LibraryScreen, { store, host }));
  assert.ok(!none.includes("Connections</h3>"));
});

test("email pane: labelled region and fields, secret input is write-only, both auth routes explained", () => {
  const out = html(h(L.EmailPane, { env: mkEnv() }));
  assert.match(out, /role="region" aria-label="Email source"/);
  for (const label of ["IMAP server", "Port", "User name", "Mailbox", "Days to look back on each fetch"]) assert.match(out, new RegExp(`<span>${label}</span>`), label);
  assert.match(out, /<input id="secret-email\.imapPassword" type="password" autoComplete="off" spellCheck="false"/);
  assert.ok(!/<input[^>]*type="password"[^>]*value="[^"]/.test(out), "a secret input never has a value attribute");
  assert.match(out, /Your normal account password does not work/);
  assert.match(out, /forward-only/);
  assert.match(out, /saved as note files in your notes folder/);
  assert.match(out, /<legend>Sign in with<\/legend>/);
  assert.match(out, /Not set up/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Fetch new mail<\/button>/, "cannot fetch before settings are saved");
  assert.match(out, /<button[^>]*disabled=""[^>]*>Save<\/button>/, "cannot save an empty secret");
  assert.ok(!out.includes("Disconnect…"), "nothing to disconnect before setup");
  assert.match(out, /imap\.gmail\.com/);
});

test("email pane (google): sign-in route text, bring-your-own-client disclosure, secret field is a password input", () => {
  const stored = { getItem: () => JSON.stringify({ email: { host: "imap.gmail.com", port: 993, secure: true, user: "me@example.com", mailbox: "INBOX", authMethod: "google", lookbackDays: 7 } }), setItem() {} };
  const out = html(h(L.EmailPane, { env: { ...mkEnv(), storage: stored } }));
  assert.match(out, /testing mode/);
  assert.match(out, /<summary>Use my own Google client<\/summary>/);
  assert.match(out, /Client secret \(sent once to the core&#x27;s vault, never shown again\)[\s\S]*?<input type="password" autoComplete="off" spellCheck="false"/);
  assert.match(out, />Sign in with Google<\/button>/);
  assert.match(out, /Disconnect…/);
  assert.match(out, /<button[^>]*>Fetch new mail<\/button>/);
  assert.ok(!/<button[^>]*disabled=""[^>]*>Fetch new mail/.test(out), "saved and valid settings can fetch");
});

test("slack, box, repos, connectors panes: regions, honest patterns, disabled-until-valid actions", () => {
  const env = mkEnv();
  const slack = html(h(L.SlackPane, { env }));
  assert.match(slack, /aria-label="Slack source"/);
  assert.match(slack, />Connect Slack<\/button>/);
  assert.match(slack, /xoxb-/);
  assert.match(slack, /No channels chosen\./);
  assert.match(slack, /<button[^>]*disabled=""[^>]*>Fetch new messages<\/button>/);
  assert.match(slack, /<input id="secret-slack\.botToken" type="password"/);
  const box = html(h(L.BoxPane, { env }));
  assert.match(box, /aria-label="Box source"/);
  assert.match(box, /No note files are created/);
  assert.match(box, /Stopping here stops waiting/);
  assert.match(box, /<input id="secret-box\.clientSecret" type="password"/);
  assert.match(box, /<legend>The app acts for<\/legend>/);
  assert.match(box, /<button[^>]*disabled=""[^>]*>Index folder now<\/button>/);
  const repos = html(h(L.ReposPane, { env }));
  assert.match(repos, /aria-label="Repositories source"/);
  assert.match(repos, /only possible inside the desktop app/);
  assert.match(repos, /GitHub token saved in Settings/);
  const withPick = html(h(L.ReposPane, { env: { ...env, pickFolder: async () => null } }));
  assert.match(withPick, />Add a repository…<\/button>/);
  const cats = html(h(L.ConnectorsPane, { env }));
  assert.match(cats, /aria-label="Connector catalog"/);
  assert.match(cats, /does not give it access to anything/);
  assert.match(cats, /does not sign you out, delete credentials, or stop fetching/);
});

test("secret field: saved state shows a badge and no value; replace wording; problems are announced", () => {
  const env = mkEnv();
  const saved = html(h(L.SecretField, { env, label: "App password", secretKey: "email.imapPassword", kind: "email", saved: true, onSaved() {} }));
  assert.match(saved, /Saved in vault/);
  assert.match(saved, /placeholder="Saved\. Type to replace\."/);
  assert.match(saved, />Replace<\/button>/);
  assert.ok(!/value="[^"]/.test(saved));
  const fresh = html(h(L.SecretField, { env, label: "App password", secretKey: "email.imapPassword", kind: "email", saved: false, onSaved() {}, onTest: async () => "ok" }));
  assert.match(fresh, />Save<\/button>/);
  assert.match(fresh, /Test without saving/);
  assert.match(fresh, /<label for="secret-email\.imapPassword">/);
});

test("confirm dialog: names the consequence, cancel is the default focus", () => {
  const out = html(h(L.ConfirmDialog, { title: "Disconnect Box?", message: "Content already indexed stays in the search index.", confirmLabel: "Disconnect", onConfirm() {}, onClose() {}, busy: false }));
  assert.match(out, /role="alertdialog"/);
  assert.match(out, /data-autofocus="true"[^>]*>Cancel/);
  assert.match(out, /already indexed stays/);
});

test("created hook: notes created by a fetch reach the list store without a rescan", async () => {
  const host = new L.FakeHost();
  const write = new L.FakeWriteHost(host);
  const store = new L.LibraryStore({ host });
  await store.init();
  await L.settle(store);
  const listed = host.calls.list;
  const wrapped = L.withCreatedHook(write, (saved, text) => store.noteWritten(saved, text));
  await wrapped.create("source/emails/2026/10/a.md", "---\ntitle: Hi\nplatform: email\n---\nbody\n");
  assert.equal(store.getSnapshot().records.length, 1);
  assert.equal(store.getSnapshot().records[0].sourceId, "email");
  assert.equal(host.calls.list, listed);
  await assert.rejects(wrapped.create("source/emails/2026/10/a.md", "x"));
  assert.equal(store.getSnapshot().records.length, 1, "a refused create changes nothing");
});
