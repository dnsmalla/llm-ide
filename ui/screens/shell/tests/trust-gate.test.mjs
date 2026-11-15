import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const { createTrustGate } = await load("trust-gate.ts");
const { UntrustedCoreNotice } = await load("Panels.tsx");

const st = (o = {}) => ({ url: "http://127.0.0.1:4000", state: "ready", trust: "adopted_unverified", mode: "local", restarts: 0, pid: 7, ...o });

test("spawned core is trusted; adopted/pending need an explicit confirmation bound to this instance", () => {
  let s = st({ trust: "spawned" });
  const g = createTrustGate({ getStatus: () => s, isHost: () => true });
  assert.equal(g.allowed(), true);
  s = st({ trust: "adopted_unverified" });
  assert.deepEqual(g.view(), { allowed: false, needsConfirm: true, url: "http://127.0.0.1:4000" });
  g.confirm();
  assert.equal(g.allowed(), true);
  s = st({ restarts: 1 }); // a restarted/different instance asks again
  assert.equal(g.allowed(), false);
  s = st({ trust: "pending" });
  assert.equal(g.allowed(), false);
  s = st({ state: "starting" });
  assert.equal(g.view().needsConfirm, false);
  assert.equal(g.allowed(), false);
});

test("dev mode (no host) allows credentials", () => {
  const g = createTrustGate({ getStatus: () => null, isHost: () => false });
  assert.equal(g.allowed(), true);
});

test("the confirmation modal names the URL and the risk", () => {
  const html = renderToStaticMarkup(React.createElement(UntrustedCoreNotice, { url: "http://127.0.0.1:4000", onConfirm() {} }));
  assert.match(html, /127\.0\.0\.1:4000/);
  assert.match(html, /password/);
  assert.match(html, /alertdialog/);
});

test("a pinned remote core is trusted without asking again", () => {
  const s = st({ url: "http://127.0.0.1:3459/tok", state: "remote", trust: "remote_pinned", mode: "remote", pid: null });
  const g = createTrustGate({ getStatus: () => s, isHost: () => true });
  assert.equal(g.allowed(), true);
  assert.deepEqual(g.view(), { allowed: true, needsConfirm: false, url: "http://127.0.0.1:3459/tok" });
});

const sshSt = (o = {}) => ({ url: "http://127.0.0.1:3456", state: "ssh", trust: "ssh_forward", mode: "ssh", link: "connected", restarts: 0, pid: null, ...o });

test("ssh mode: a connected or reconnecting forward may carry credentials, with no confirm prompt", () => {
  let s = sshSt();
  const g = createTrustGate({ getStatus: () => s, isHost: () => true });
  assert.deepEqual(g.view(), { allowed: true, needsConfirm: false, url: "http://127.0.0.1:3456" });
  s = sshSt({ link: "reconnecting" });
  assert.equal(g.allowed(), true);
});

test("ssh mode: any other link, state, trust or an empty url is refused and never asks to confirm", () => {
  const cases = [{ link: "connecting" }, { link: "needs_password" }, { link: "failed" }, { link: "stopped" }, { link: null }, { state: "stopped" }, { trust: "spawned" }, { url: "" }];
  for (const over of cases) {
    const s = sshSt(over);
    const g = createTrustGate({ getStatus: () => s, isHost: () => true });
    const label = JSON.stringify(over);
    assert.equal(g.allowed(), false, label);
    assert.equal(g.view().needsConfirm, false, label);
    g.confirm();
    assert.equal(g.allowed(), false, label);
  }
});
