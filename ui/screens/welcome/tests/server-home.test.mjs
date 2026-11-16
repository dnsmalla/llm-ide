// SSH server home: the view per link state, the password field, the recent folders, and the Welcome page swap.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

const h = React.createElement;
let home;
let welcome;
before(async () => {
  home = await load("../welcome/ServerHome.tsx");
  welcome = await load("../welcome/WelcomeScreen.tsx");
});

const plain = (html) => html.replace(/<!-- -->/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const HOME = "/home/dev";

function props(over = {}) {
  return {
    link: "connected",
    host: "192.168.100.32",
    identity: "malla.dinesh · LLM-IDE server 0.0.0 · Claude 2.1.321",
    busy: false,
    password: "",
    onPassword() {},
    passwordError: null,
    onConnectPassword() {},
    onDisconnect() {},
    stopConfirm: false,
    onAskStop() {},
    onConfirmStop() {},
    onCancelStop() {},
    foreign: false,
    onStopAnyway() {},
    onDismissForeign() {},
    folder: null,
    onContinue() {},
    onOpenPicker() {},
    recent: [],
    recentNotice: null,
    onOpenRecent() {},
    onRemoveRecent() {},
    statusError: null,
    ...over,
  };
}
const render = (over) => plain(renderToStaticMarkup(h(home.ServerHomeView, props(over))));

test("connected: the header names the host, shows the state and the identity line", () => {
  const html = render({});
  assert.match(html, />Connected to 192\.168\.100\.32</);
  assert.match(html, />SSH server connected</);
  assert.match(html, />malla\.dinesh · LLM-IDE server 0\.0\.0 · Claude 2\.1\.321</);
  assert.match(html, />Open folder…</);
  assert.match(html, />Disconnect</);
  assert.match(html, />Stop server</);
});

test("each link state has its own wording", () => {
  assert.match(render({ link: "connecting" }), />Connecting to the SSH server…</);
  assert.match(render({ link: "reconnecting" }), />Reconnecting to the SSH server…</);
  assert.match(render({ link: "failed", statusError: "The SSH connection could not be opened." }), />SSH server unreachable</);
  assert.match(render({ link: "needs_password" }), />Enter the server password to connect</);
});

test("an empty identity part is left out: no separator is shown for it", () => {
  const html = render({ identity: "malla.dinesh" });
  assert.match(html, />malla\.dinesh</);
  assert.doesNotMatch(html, /·/);
});

test("needs_password: the password field with the Welcome hint, and Connect", () => {
  const html = render({ link: "needs_password" });
  assert.match(html, /type="password"/);
  assert.match(html, /Used only for this connection\. It is never saved\./);
  assert.match(html, />Connect</);
});

test("connected: no password field", () => {
  assert.doesNotMatch(render({ link: "connected" }), /type="password"/);
});

test("recent folders: an empty list says so; rows show the name and path; a missing row is greyed with Remove", () => {
  assert.match(render({}), /No folders opened on this server yet\./);
  const html = render({
    recent: [
      { path: `${HOME}/projects/llm-ide`, name: "llm-ide", missing: false },
      { path: `${HOME}/work/api`, name: "api", missing: true },
    ],
  });
  assert.match(html, /Recent folders on this server/);
  assert.match(html, />llm-ide</);
  assert.match(html, />\/home\/dev\/projects\/llm-ide</);
  assert.match(html, /data-missing="true"/);
  assert.match(html, />Remove</);
  assert.equal((html.match(/>Remove</g) ?? []).length, 1, "only the missing row has Remove");
});

test("a missing row cannot be opened", () => {
  const html = render({ recent: [{ path: `${HOME}/work/api`, name: "api", missing: true }] });
  const row = html.match(/<button[^>]*disabled=""[^>]*>.*?<\/button>/s)?.[0] ?? "";
  assert.match(row, />api</);
});

test("Stop server asks first; the foreign-core prompt keeps its Stop anyway choice", () => {
  assert.match(render({ stopConfirm: true }), /Stop the server part on 192\.168\.100\.32\?/);
  const foreign = render({ foreign: true });
  assert.match(foreign, /Another computer started the server on this account/);
  assert.match(foreign, />Stop it anyway</);
});

test("WelcomeScreen shows the server home in place of the local Welcome content", () => {
  const html = plain(renderToStaticMarkup(h(welcome.WelcomeScreen, {
    project: null,
    recent: { entries: [], reset: false },
    error: null,
    actions: {},
    serverHome: h("p", null, "SERVER HOME MARKER"),
  })));
  assert.match(html, /SERVER HOME MARKER/);
  assert.doesNotMatch(html, /Open existing project/);
  assert.doesNotMatch(html, /Start fresh/);
});
