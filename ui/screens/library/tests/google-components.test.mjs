process.env.TZ = "UTC";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle, react, server } from "./write-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(resolve(HERE, "../../../../schema/http/fixtures/google", `${n}.json`), "utf8")).response;

let L;
let h;
let html;
before(async () => {
  L = await loadBundle("library-google", "google-entry.ts");
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});

const mkEnv = (over = {}) => {
  const host = new L.FakeHost();
  return { core: { call: async () => ({ status: 200, body: {} }) }, write: new L.FakeWriteHost(host), storage: null, openExternal: async () => {}, pickFolder: null, now: () => 0, ...over };
};
const count = (s, re) => (s.match(re) ?? []).length;
const account = (i = 0) => L.decodeAccounts(fixture(["get-kb-google-accounts-200", "get-kb-google-accounts-200-with-options", "get-kb-google-accounts-200-reconnect-needed"][i])).accounts[0];

test("pane: labelled region, setup guide with every step and copyable read-only scopes, honest unverified notes", () => {
  const out = html(h(L.GooglePane, { env: mkEnv() }));
  assert.match(out, /role="region" aria-label="Google connection"/);
  assert.match(out, /Not set up/);
  assert.match(out, /aria-label="Google setup guide"/);
  assert.match(out, /aria-label="Advanced Google connection"/);
  assert.ok(!/aria-label="Advanced Google connection"[^>]*open=""/.test(out) && !/<details class="lib-pane-section" aria-label="Advanced Google connection" open/.test(out), "the OAuth section is collapsed by default");
  for (const step of ["Create a Google Cloud project", "Turn on the APIs you want", "Set up the consent screen", "Add the scopes", "Create the OAuth client", "Paste them below and connect"]) assert.match(out, new RegExp(step));
  assert.match(out, /Desktop app/);
  assert.match(out, /External/);
  assert.match(out, /Test users/);
  assert.match(out, /needs no redirect address registered/);
  assert.match(out, /7 days[\s\S]*?unverified/);
  for (const s of ["gmail.readonly", "calendar.events.readonly", "calendar.calendarlist.readonly", "drive.metadata.readonly", "drive.readonly"]) {
    assert.match(out, new RegExp(`<code class="lib-code">https://www\\.googleapis\\.com/auth/${s.replace(/\./g, "\\.")}</code>`), s);
  }
  assert.ok(count(out, /aria-label="Copy scope /g) >= 7, "every scope string has a copy button");
  assert.ok(!/gmail\.(modify|compose|send)|auth\/drive"|drive\.file/.test(out), "no write scope is ever shown");
  assert.match(out, /not how you sign in to LLM-IDE and it is not a model provider/);
  assert.match(out, /source\/gmail/);
  assert.match(out, /untrusted: true/);
  assert.match(out, /Settings \(Workspace\)/);
  assert.match(out, /never overwrites a note/);
});

test("pane: the client secret is a write-only password field with no value; Connect is disabled until valid; products and Drive-content toggles explained", () => {
  const out = html(h(L.GooglePane, { env: mkEnv() }));
  assert.match(out, /<input type="password" autoComplete="off" spellCheck="false"/);
  assert.ok(!/<input[^>]*type="password"[^>]*value="[^"]/.test(out), "a secret input never has a value attribute");
  assert.match(out, /sent once to the core&#x27;s vault, never shown again/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Connect<\/button>/);
  for (const label of ["OAuth client ID", "Gmail \\(read mail; saved as notes\\)", "Google Calendar", "Google Drive \\(names, types and dates", "Also index file contents \\(off by default\\)"]) assert.match(out, new RegExp(label), label);
  const content = out.match(/<input type="checkbox"[^>]*> Also index file contents/)[0];
  assert.match(content, /disabled=""/, "contents cannot be ticked without Drive");
  assert.match(out, /drive\.readonly, which can read every file in your Drive/);
  assert.match(out, /Turning it on later means connecting again/);
});

test("connect card: a valid form enables Connect; waiting shows the browser step and Cancel; the state value is never rendered", () => {
  const form = { ...L.EMPTY_FORM, clientId: "123456789012-abcdefghijklmnop.apps.googleusercontent.com", clientSecret: "GOCSPX-hidden-secret-value" };
  const base = { form, setForm() {}, busy: false, phase: "idle", onConnect() {}, onCancel() {}, reconnectEmail: null, onClearReconnect() {} };
  const ready = html(h(L.ConnectCard, base));
  assert.ok(!/<button[^>]*disabled=""[^>]*>Connect<\/button>/.test(ready));
  // A controlled password input necessarily holds what the user is typing; the pane clears it the moment Connect is pressed
  // (asserted with the fake core in google.test.ts), and it is type=password so it is masked.
  assert.match(ready, /<input type="password"/);
  const waiting = html(h(L.ConnectCard, { ...base, busy: true, phase: "waiting" }));
  assert.match(waiting, /Finish signing in to Google in your browser/);
  assert.match(waiting, /up to 5 minutes/);
  assert.match(waiting, />Cancel<\/button>/);
  assert.match(waiting, /role="status" aria-live="polite"/);
  assert.ok(!/EXAMPLE_STATE|state=/.test(waiting));
  assert.match(html(h(L.ConnectPhaseText, { phase: "declined" })), /Nothing was changed/);
  assert.match(html(h(L.ConnectPhaseText, { phase: "timeout" })), /not finished in time/);
  const re = html(h(L.ConnectCard, { ...base, form: { ...L.EMPTY_FORM, accountId: "0123456789ab" }, reconnectEmail: "me@example.com" }));
  assert.match(re, /Reconnecting <strong>me@example\.com<\/strong>/);
  assert.match(re, />Reconnect<\/button>/);
  assert.ok(!/<button[^>]*disabled=""[^>]*>Reconnect<\/button>/.test(re), "a reconnect may leave the client fields empty");
});

test("outcome: account address, granted scopes, products ON/OFF and a plain-language scope mismatch", () => {
  const outcome = { accountId: "0123456789ab", email: "me@example.com", grantedScopes: ["email", "openid"], driveContent: false, products: [{ product: "gmail", requested: true, on: true }, { product: "gcal", requested: true, on: false }, { product: "gdrive", requested: false, on: false }], notes: ["Scope mismatch: Google Calendar was not allowed on Google's consent screen, so it is OFF."] };
  const out = html(h(L.OutcomeView, { outcome }));
  assert.match(out, /Account: <strong>me@example\.com<\/strong>/);
  assert.match(out, /Gmail: <strong>ON<\/strong>/);
  assert.match(out, /Google Calendar: <strong>OFF<\/strong> \(not allowed on Google&#x27;s consent screen\)/);
  assert.match(out, /Scope mismatch/);
  assert.match(out, /Access Google granted \(2\)/);
});

test("account card: address as text, products ON/OFF, health, actions, options, disconnect; strings from Google are escaped", () => {
  const a = account(0);
  const out = html(h(L.AccountCard, { env: mkEnv(), account: a, onChanged() {}, onReconnect() {}, onDisconnect() {} }));
  assert.match(out, /aria-label="Google account me@example\.com"/);
  assert.match(out, /Gmail: <strong>ON<\/strong>/);
  assert.match(out, /Google Drive: <strong>OFF<\/strong> \(not allowed; reconnect with it ticked\)/);
  assert.match(out, /Fetch new mail<\/button>/);
  assert.equal(count(out, />Sync now<\/button>/g), 1, "Calendar only (Drive is off)");
  assert.match(out, /Healthy/);
  assert.match(out, /Last run /);
  assert.match(out, />Disconnect…<\/button>/);
  assert.match(out, /Reconnect or add access/);
  assert.match(out, /Access Google granted \(5\)/);
  // Hostile text from Google is escaped; no element or attribute can come out of it.
  const hostile = { ...a, email: '<img src=x onerror=alert(1)>@evil.example', scopes: ['"><script>alert(1)</script>'] };
  const bad = html(h(L.AccountCard, { env: mkEnv(), account: hostile, onChanged() {}, onReconnect() {}, onDisconnect() {} }));
  assert.ok(!/<img|<script/.test(bad), "no tag from Google survives");
  assert.match(bad, /&lt;img src=x onerror=alert\(1\)&gt;@evil\.example/);
  assert.ok(!/<a[ >]/.test(bad), "no link element is ever produced from Google text");
});

test("account card: reconnect needed is stated in plain words and blocks sync", () => {
  const a = account(2);
  const out = html(h(L.AccountCard, { env: mkEnv(), account: a, onChanged() {}, onReconnect() {}, onDisconnect() {} }));
  assert.match(out, /Reconnect needed/);
  assert.match(out, /no longer accepts this account&#x27;s saved sign-in/);
  assert.match(out, /about 7 days \(unverified\)/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Sync now<\/button>/);
  assert.match(out, />Reconnect<\/button>/);
});

test("account card with drive: names/dates only vs contents; options panel entry points", () => {
  const a = account(1);
  assert.deepEqual(a.products, ["gmail", "gdrive"]);
  const out = html(h(L.AccountCard, { env: mkEnv(), account: a, onChanged() {}, onReconnect() {}, onDisconnect() {} }));
  assert.match(out, /Google Drive: <strong>ON<\/strong> \(names, types and dates only\)/);
  assert.match(out, /Google Calendar: <strong>OFF<\/strong>/);
  assert.equal(count(out, />Options<\/button>/g), 2);
});

test("options editors: labelled controls, validation text, calendar and drive explanations", () => {
  const g = html(h(L.GmailOptionsEditor, { initial: { labels: ["INBOX"], windowDays: 30, includePromotions: false, includeSocial: false }, busy: false, onSave() {} }));
  assert.match(g, /role="group" aria-label="Gmail options"/);
  assert.match(g, /Spam, Trash and Drafts are never read/);
  assert.match(g, /Include the Promotions tab/);
  const gBad = html(h(L.GmailOptionsEditor, { initial: { labels: [], windowDays: 0, includePromotions: false, includeSocial: false }, busy: false, onSave() {} }));
  assert.match(gBad, /Choose at least one label/);
  assert.match(gBad, /Use 1 to 365 days/);
  assert.match(gBad, /<button[^>]*disabled=""[^>]*>Save Gmail options<\/button>/);
  const c = html(h(L.CalendarOptionsEditor, { initial: { calendarIds: ["primary"], daysBack: 30, daysAhead: 90 }, busy: false, calendars: [{ id: "primary", summary: "<b>Me</b>", primary: true, accessRole: "owner" }], onLoadCalendars() {}, onSave() {} }));
  assert.match(c, /&lt;b&gt;Me&lt;\/b&gt; \(main\)/);
  assert.ok(!c.includes("<b>Me"));
  assert.match(c, /Reload my calendars/);
  const d = html(h(L.DriveOptionsEditor, { initial: { folderIds: ["folderTick1"], includeSharedDrives: false }, busy: false, contentGranted: false, load: async () => [], onSave() {} }));
  assert.match(d, /Browse my folders/);
  assert.match(d, /Include shared drives \(off by default\)/);
  assert.match(d, /file contents were not allowed|only names, types and dates are indexed/);
  assert.match(d, /Ticked \(1\)/);
});

test("drive folder list is windowed: 50,000 folders mount only the visible rows, with set size for assistive tech", () => {
  const folders = Array.from({ length: 50_000 }, (_, i) => ({ id: `folder${String(i).padStart(6, "0")}`, name: `Folder ${i}` }));
  const out = html(h(L.FolderList, { folders, ticked: new Set(["folder000003"]), onToggle() {}, onOpen() {} }));
  const rows = count(out, /aria-posinset="/g);
  assert.ok(rows > 0 && rows < 40, `only a window of rows mounts, got ${rows}`);
  assert.match(out, /aria-setsize="50000"/);
  assert.match(out, /aria-posinset="1"/);
  assert.match(out, /aria-label="Open folder Folder 0"/);
  assert.match(out, /role="group" aria-label="Folders"/);
  assert.ok(out.length < 60_000, "markup size stays bounded");
  assert.match(out, /padding-bottom:\d{7,}px/, "the rest of the scroll height is spacer, not rows");
});

test("disconnect dialog: typed confirm, explains revoke, purge and the Google permissions page", () => {
  const a = account(0);
  const out = html(h(L.DisconnectDialog, { account: a, busy: false, error: null, onConfirm() {}, onClose() {}, openExternal: async () => {} }));
  assert.match(out, /role="alertdialog"/);
  assert.match(out, /Type me@example\.com to confirm/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Disconnect<\/button>/, "disabled until the address is typed");
  assert.match(out, /revoke the saved sign-in/);
  assert.match(out, /removes the Calendar and Drive search entries/);
  assert.match(out, /Gmail notes already in your notes folder stay/);
  assert.match(out, /myaccount\.google\.com\/permissions/);
  assert.match(out, /data-autofocus="true"/);
  assert.match(L.disconnectMessage({ ok: true, revoked: false, purgedSources: 12 }, "me@example.com"), /could not be reached to revoke.*myaccount\.google\.com\/permissions/);
  assert.match(L.disconnectMessage({ ok: true, revoked: true, purgedSources: 0 }, "me@example.com"), /asked to revoke/);
});

test("connections list: Google sits next to Email; the email pane no longer offers the legacy Google sign-in", () => {
  const list = L.sourceConnections(mkEnv());
  assert.deepEqual(list.map((x) => x.label), ["Email", "Google", "Slack", "Box", "Repositories", "Connectors"]);
  assert.equal(new Set(list.map((x) => x.id)).size, 6);
  assert.ok(list.find((x) => x.id === "src-google"));
  assert.equal(L.formatWhen("not a date"), null);
  assert.equal(L.formatWhen(null), null);
  assert.match(L.formatWhen("2025-11-01T00:00:00.000Z"), /2025/);
});

// ---- easy setup ------------------------------------------------------------------------------

test("pane: Easy setup comes first with three cards, Advanced (OAuth) is collapsed after it", () => {
  const out = html(h(L.GooglePane, { env: mkEnv(), gmailCard: h("section", { "aria-label": "Easy setup: Gmail" }, "gmail slot") }));
  const easy = out.indexOf('aria-label="Easy setup"');
  const adv = out.indexOf('aria-label="Advanced Google connection"');
  assert.ok(easy > 0 && adv > easy, "easy before advanced");
  assert.match(out, /Easy setup: Gmail/);
  assert.match(out, /aria-label="Easy setup: Google Calendar"/);
  assert.match(out, /aria-label="Easy setup: Google Drive"/);
  assert.match(out, /Advanced: connect with your own Google Cloud client/);
  // The OAuth client fields live inside the Advanced section only.
  assert.ok(out.indexOf("OAuth client ID") > adv);
  assert.ok(out.indexOf("Secret address in iCal format (sent once") < adv);
});

test("gmail easy card: address and write-only app password, workspace caveat, forward-only, no hardcoded unverified link", () => {
  const out = html(L.sourceConnections(mkEnv())[1].render());
  assert.match(out, /aria-label="Easy setup: Gmail"/);
  for (const t of ["2-Step Verification", "App passwords", "administrators turn app passwords off", "forward-only", "stored write-only"]) assert.match(out, new RegExp(t), t);
  assert.match(out, /<label[^>]*><span>Gmail address<\/span>/);
  assert.match(out, /<input id="secret-email\.imapPassword" type="password" autoComplete="off" spellCheck="false"/);
  assert.ok(!/value="[^"]/.test(out.slice(out.indexOf("secret-email.imapPassword"), out.indexOf("secret-email.imapPassword") + 200)));
  assert.match(out, /<ol aria-label="Gmail with an app password: steps">/);
  assert.ok(!/apppasswords/.test(out), "the app-password page URL is not hardcoded");
  assert.match(out, /<button[^>]*disabled=""[^>]*>Fetch new mail<\/button>/);
});

test("calendar easy card: guide, write-only secret address field, read-only and anyone-with-the-URL warning, unavailable on 404", async () => {
  const fake = new L.FakeIcal();
  const out = html(h(L.IcalCard, { api: fake }));
  assert.match(out, /Settings for my calendars/);
  assert.match(out, /Integrate calendar/);
  assert.match(out, /Secret address in iCal format/);
  assert.match(out, /Anyone who has the address can read the whole calendar/);
  assert.match(out, /Read-only/);
  assert.match(out, /<input type="password" autoComplete="off" spellCheck="false"/);
  assert.ok(!/<input[^>]*type="password"[^>]*value="[^"]/.test(out));
  assert.match(out, /<button[^>]*disabled=""[^>]*>Connect<\/button>/);
});

test("drive easy card: Drive for desktop guide, no OAuth, honest link-file caveat, picker needs the desktop app", () => {
  const none = html(h(L.DriveCard, { env: mkEnv() }));
  assert.match(none, /aria-label="Easy setup: Google Drive"/);
  assert.match(none, /No Google sign-in is involved/);
  assert.match(none, /small link files/);
  assert.match(none, /unverified/);
  assert.match(none, /only possible inside the desktop app/);
  const withPick = html(h(L.DriveCard, { env: mkEnv({ pickFolder: async () => null }) }));
  assert.match(withPick, />Choose your Drive folder…<\/button>/);
  assert.match(withPick, /<button[^>]*disabled=""[^>]*>Add and index this folder<\/button>/);
});
