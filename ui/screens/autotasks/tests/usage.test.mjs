import { test } from "node:test";
import assert from "node:assert/strict";
import * as u from "../native/usage.ts";

const row = (model, priority, extra = {}) => ({ provider: "anthropic", model, label: model, priority, enabled: true, limit_value: 0, unit: "runs", window_kind: "daily", threshold_pct: 90, custom: false, ...extra });

test("a paused chain stops the run with the server's reason; no model is sent", () => {
  const d = u.runDecision({ provider: "anthropic", model: null, status: "paused", reason: "All anthropic models have hit their limit.", engaged: true });
  assert.equal(d.proceed, false);
  assert.equal(d.notice, "All anthropic models have hit their limit.");
});

test("an engaged chain sends the resolved model; an inert chain sends none", () => {
  assert.deepEqual(u.runDecision({ provider: "anthropic", model: "m2", status: "degraded", engaged: true }), { proceed: true, model: "m2" });
  assert.deepEqual(u.runDecision({ provider: "anthropic", model: "m1", status: "ok", engaged: false }), { proceed: true });
  assert.deepEqual(u.runDecision({ provider: "anthropic", model: null, status: "unconfigured", engaged: false }), { proceed: true });
});

test("moving a chain row renumbers priorities and ignores out-of-range moves", () => {
  const rows = [row("a", 0), row("b", 1), row("c", 2)];
  assert.deepEqual(u.moveRow(rows, 1, -1).map((r) => [r.model, r.priority]), [["b", 0], ["a", 1], ["c", 2]]);
  assert.equal(u.moveRow(rows, 0, -1), rows);
  assert.equal(u.moveRow(rows, 2, 1), rows);
});

test("the limits body sends the server's fields, clamped, one provider at a time", () => {
  const body = u.limitsBody("anthropic", [row("a", 5, { limit_value: 12.7, threshold_pct: 0, unit: "tokens", window_kind: "monthly", enabled: false })]);
  assert.deepEqual(body, { chains: { anthropic: [{ model: "a", priority: 0, enabled: false, limit_value: 12, unit: "tokens", window_kind: "monthly", threshold_pct: 1 }] } });
  assert.equal(u.meterText(3, 0, "runs"), "3 runs (no cap)");
  assert.equal(u.meterText(3, 10, "runs"), "3 / 10 runs");
});

test("the runner's resolve answer is the only source of the model it sends", () => {
  // A paused answer must never reach the agent; an engaged answer sends exactly the resolved model.
  assert.equal(u.runDecision({ provider: "anthropic", model: "x", status: "paused", engaged: true }).model, undefined);
  assert.equal(u.runDecision({ provider: "anthropic", model: "x", status: "ok", engaged: true }).model, "x");
});
