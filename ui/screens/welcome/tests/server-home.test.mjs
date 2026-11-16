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
    closeConfirm: false,
    onAskClose() {},
    onConfirmClose() {},
    onCancelClose() {},
    closeError: null,
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

test("header: 'Connected to <host>' only while the link is up; otherwise 'SSH server <host>'", () => {
  assert.equal(home.headerText("connected", "h"), "Connected to h");
  assert.equal(home.headerText("reconnecting", "h"), "Connected to h");
  for (const link of ["connecting", "needs_password", "failed", "stopped", null]) {
    assert.equal(home.headerText(link, "h"), "SSH server h", String(link));
    assert.doesNotMatch(render({ link }), /Connected to/, String(link));
  }
});

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

// Close server: the button sits next to Stop server, asks first, and the guard runs before the restart. Stop never runs.
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

test("Close server is in the header next to Stop server, and it only asks", () => {
  const tree = home.ServerHomeView(props({}));
  assert.ok(findButton(tree, "Close server"), "the button exists");
  assert.ok(findButton(tree, "Stop server"), "Stop server stays");
  let asked = 0;
  findButton(home.ServerHomeView(props({ onAskClose() { asked += 1; } })), "Close server").props.onClick();
  assert.equal(asked, 1);
  assert.doesNotMatch(render({}), /Close the connection to/, "no question before the button is pressed");
});

test("Close server asks with the exact sentence, Close and Cancel", () => {
  const html = render({ closeConfirm: true });
  assert.match(html, /Close the connection to 192\.168\.100\.32 and return to the Welcome page\? The server keeps running\./);
  const tree = home.ServerHomeView(props({ closeConfirm: true }));
  assert.ok(findButton(tree, "Close"), "Close answers the question");
  assert.ok(findButton(tree, "Cancel"), "Cancel keeps the server");
});

test("Cancel on the Close question calls only its own cancel handler", () => {
  const calls = [];
  const spies = {
    onCancelClose() { calls.push("cancel"); },
    onConfirmClose() { calls.push("confirm"); },
    onConfirmStop() { calls.push("stop"); },
    onDisconnect() { calls.push("disconnect"); },
  };
  findButton(home.ServerHomeView(props({ closeConfirm: true, ...spies })), "Cancel").props.onClick();
  assert.deepEqual(calls, ["cancel"]);
});

test("closeServerConnection: the guard runs first, then the restart; stop is never part of it", async () => {
  const order = [];
  const guard = async (cancelled, action) => {
    order.push("guard");
    return action();
  };
  const restart = async () => { order.push("app_restart"); };
  const done = await home.closeServerConnection(guard, restart);
  assert.equal(done, true);
  assert.deepEqual(order, ["guard", "app_restart"]);
});

test("closeServerConnection: when the user stays in the open project, nothing restarts", async () => {
  const order = [];
  const guard = async (cancelled) => {
    order.push("guard");
    return cancelled;
  };
  const done = await home.closeServerConnection(guard, async () => { order.push("app_restart"); });
  assert.equal(done, false);
  assert.deepEqual(order, ["guard"]);
});

test("WelcomeScreen without a server home (local mode) has no Close server", () => {
  const html = plain(renderToStaticMarkup(h(welcome.WelcomeScreen, {
    project: null,
    recent: { entries: [], reset: false },
    error: null,
    actions: {},
  })));
  assert.doesNotMatch(html, /Close server/);
  assert.doesNotMatch(html, /Stop server/);
});
