import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const h = React.createElement;
const host = await load("host.ts");
const { deriveStatusView, deriveHints } = await load("status-view.ts");
const { describeCoreErrorFor, coreNotReadyReason } = await load("core-explain.ts");
const { CoreDownPanel, HintNote } = await load("Panels.tsx");
const { statusEqual } = await load("status-store.ts");

const st = (o = {}) => host.normalizeCoreStatus({ url: "http://127.0.0.1:3457", state: "ready", trust: "spawned", ...o });
const view = (o = {}) => deriveStatusView({ status: st(o), pollError: null, everReady: false });
const FOREIGN = { port: 3456, detected: true, pid: 4242, command: "node" };

test("normalizeCoreStatus: new fields are additive, validated and bounded", () => {
  const s = st();
  assert.deepEqual([s.foreign_core, s.error_code, s.ports_tried], [null, null, []]);
  assert.equal(st({ foreign_core: { port: 3456, detected: true, pid: -3 } }).foreign_core.pid, null);
  assert.equal(st({ foreign_core: { port: 99999, detected: true } }).foreign_core, null);
  assert.equal(st({ foreign_core: { port: 3456, detected: false } }).foreign_core, null);
  assert.deepEqual(st({ ports_tried: [3457, "x", 3458.5, 70000, 3459] }).ports_tried, [3457, 3459]);
  assert.equal(st({ ports_tried: Array.from({ length: 50 }, () => 3457) }).ports_tried.length, 8);
});

test("a foreign core while our own is ready: info text with the pid, a copyable kill command, level stays ok", () => {
  const v = view({ foreign_core: FOREIGN });
  assert.equal(v.level, "ok");
  assert.equal(v.down, false);
  assert.equal(v.hints.length, 1);
  const hint = v.hints[0];
  assert.equal(hint.id, "foreign_core");
  assert.match(hint.text, /Another LLM-IDE server is running on port 3456 \(pid 4242, node\)\. It is not used by this app\. You can leave it or stop it with: kill 4242/);
  assert.equal(hint.command, "kill 4242");
});

test("foreign core without a pid offers an lsof command instead of a kill", () => {
  const hint = view({ foreign_core: { port: 3456, detected: true } }).hints[0];
  assert.equal(hint.command, "lsof -nP -iTCP:3456 -sTCP:LISTEN");
  assert.doesNotMatch(hint.text, /kill/);
});

test("hostile command names are not printed", () => {
  const hint = view({ foreign_core: { port: 3456, detected: true, pid: 5, command: "node; rm -rf /‮" } }).hints[0];
  assert.doesNotMatch(hint.text, /rm -rf|‮/);
  assert.match(hint.text, /\(pid 5\)/);
});

test("ports_busy failure: explains, lists the range, offers an lsof command", () => {
  const v = view({ state: "failed", error: "could not start the core", error_code: "ports_busy", ports_tried: [3457, 3458, 3459] });
  assert.equal(v.level, "error");
  assert.equal(v.down, true);
  const hint = v.hints.find((x) => x.id === "ports_busy");
  assert.match(hint.text, /Ports 3457-3459 are busy: free one of them or restart/);
  assert.equal(hint.command, "lsof -nP -iTCP:3457-3459 -sTCP:LISTEN");
  assert.equal(view({ state: "ready", error_code: "ports_busy" }).hints.length, 0, "only while failed");
});

test("existing states keep their wording and carry no hints", () => {
  assert.equal(view({ state: "starting" }).label, "Starting core…");
  assert.match(view({ state: "restarting", restart_in_ms: 1000 }).label, /Restarting core/);
  assert.equal(view({ state: "failed", fatal: true }).label, "Core crashed repeatedly");
  assert.deepEqual(deriveHints(null), []);
  assert.deepEqual(deriveStatusView({ status: null, pollError: "x", everReady: false }).hints, []);
  // an ADOPTED core is the one in use: no "not used" claim
  assert.deepEqual(view({ adopted: true, trust: "adopted_unverified", foreign_core: FOREIGN }).hints, []);
});

test("describeCoreErrorFor decorates NETWORK errors by status, leaves others alone", () => {
  const net = Object.assign(new Error("Cannot reach the core."), { code: "NETWORK" });
  const other = Object.assign(new Error("Nope."), { code: "BAD_RESPONSE" });
  assert.equal(describeCoreErrorFor(net, st({ state: "failed" })), "The core is not ready (status: failed). See the status bar.");
  assert.equal(describeCoreErrorFor(net, st({ state: "starting" })), "The core is not ready (status: starting). See the status bar.");
  assert.equal(describeCoreErrorFor(net, st({ trust: "adopted_unverified" })), "The core is not ready (status: adopted_unverified). See the status bar.");
  assert.equal(describeCoreErrorFor(net, st({ trust: "pending" })), "The core is not ready (status: pending). See the status bar.");
  assert.equal(describeCoreErrorFor(net, null), "The core is not ready (status: unknown). See the status bar.");
  assert.equal(describeCoreErrorFor(net, st()), "Cannot reach the core.", "ready + spawned: the real network error stands");
  assert.equal(describeCoreErrorFor(other, st({ state: "failed" })), "Nope.");
  assert.equal(describeCoreErrorFor("weird", null, "Fallback."), "Fallback.");
  assert.equal(coreNotReadyReason(st()), null);
});

test("messages never carry secrets, urls or paths", () => {
  const s = st({ state: "failed", error_code: "ports_busy", ports_tried: [3457], core_log_path: "/Users/x/Library/core.log", foreign_core: FOREIGN });
  const all = JSON.stringify(deriveStatusView({ status: s, pollError: null, everReady: false }).hints) + describeCoreErrorFor(Object.assign(new Error("x"), { code: "NETWORK" }), s);
  assert.doesNotMatch(all, /\/Users|core\.log|http:|Bearer|token/i);
});

test("server render: hint note has role=note, the text, a code block and a labelled copy button", () => {
  const hint = view({ foreign_core: FOREIGN }).hints[0];
  const out = renderToStaticMarkup(h(HintNote, { hint }));
  assert.match(out, /role="note"/);
  assert.match(out, /Another LLM-IDE server is running on port 3456/);
  assert.match(out, /<code>kill 4242<\/code>/);
  assert.match(out, /aria-label="Copy command: kill 4242"/);
  assert.doesNotMatch(out, /Stop it<|>Kill</, "no button that kills");
});

test("server render: core-down panel shows ports_busy guidance inside the alert", () => {
  const v = view({ state: "failed", error: "could not start the core", error_code: "ports_busy", ports_tried: [3457, 3458, 3459] });
  const out = renderToStaticMarkup(h(CoreDownPanel, { view: v, onRetry() {} }));
  assert.match(out, /role="alert"/);
  assert.match(out, /Ports 3457-3459 are busy/);
  assert.match(out, /<code>lsof -nP -iTCP:3457-3459 -sTCP:LISTEN<\/code>/);
});

test("statusEqual treats an unchanged foreign_core as equal (no re-render each poll)", () => {
  assert.equal(statusEqual(st({ foreign_core: FOREIGN }), st({ foreign_core: FOREIGN })), true);
  assert.equal(statusEqual(st({ foreign_core: FOREIGN }), st({ foreign_core: { ...FOREIGN, pid: 9 } })), false);
});
