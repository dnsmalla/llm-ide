import { test } from "node:test";
import assert from "node:assert/strict";
import { quickSwitchRows } from "../menu-model.ts";

const e = (name, root) => ({ name, root, status: "ok", reason: null, openIndex: 0 });

test("Quick Switch leaves the open project out, keeps each row's index in the full list, and filters by text", () => {
  const recent = [e("Alpha", "/p/alpha"), e("Beta", "/p/beta"), e("Gamma", "/p/gamma")];
  assert.deepEqual(quickSwitchRows(recent, "/p/beta", "").map((r) => [r.entry.name, r.index]), [["Alpha", 0], ["Gamma", 2]]);
  assert.deepEqual(quickSwitchRows(recent, null, "gam").map((r) => r.entry.name), ["Gamma"]);
  assert.deepEqual(quickSwitchRows(recent, "/p/beta", "beta"), []);
});
