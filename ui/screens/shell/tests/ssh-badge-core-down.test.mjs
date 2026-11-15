// The toolbar's SSH badge is silent outside ssh mode, and the core-down panel offers Settings only in ssh mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const h = React.createElement;
const host = await load("host.ts");
const { deriveStatusView } = await load("status-view.ts");
const { CoreDownPanel } = await load("Panels.tsx");
const { SshBadge } = await load("SshBadge.tsx");
const { sshBadgeText } = await load("../settings/ssh-server-model.ts");

const view = (o = {}) => deriveStatusView({ status: host.normalizeCoreStatus({ url: "http://127.0.0.1:3456", state: "ssh", mode: "ssh", trust: "ssh_forward", ...o }), pollError: null, everReady: false });

test("the SSH badge renders nothing outside ssh mode (no status yet)", () => {
  assert.equal(renderToStaticMarkup(h(SshBadge)), "");
});

test("the badge texts: the connected host, and reconnecting to it", () => {
  assert.equal(sshBadgeText("connected", "server.example.com"), "SSH: server.example.com");
  assert.equal(sshBadgeText("reconnecting", "server.example.com"), "Reconnecting to server.example.com…");
});

test("the core-down panel offers Open Settings in ssh mode, and not when no handler is given", () => {
  const down = view({ link: "needs_password" });
  const withSettings = renderToStaticMarkup(h(CoreDownPanel, { view: down, onRetry() {}, onOpenSettings() {} }));
  assert.match(withSettings, />Open Settings</);
  const without = renderToStaticMarkup(h(CoreDownPanel, { view: down, onRetry() {} }));
  assert.doesNotMatch(without, /Open Settings/);
});
