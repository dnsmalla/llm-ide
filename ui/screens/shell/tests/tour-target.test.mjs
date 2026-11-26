import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTarget } from "../tour-target.ts";

const live = (el) => el.live;

test("searching: takes the first live candidate and skips a zero-size one", () => {
  const hidden = { name: "hidden", live: false };
  const a = { name: "a", live: true };
  const b = { name: "b", live: true };
  assert.equal(pickTarget(null, [hidden, a, b], live), a);
});

test("searching: no live candidate yields null", () => {
  assert.equal(pickTarget(null, [{ live: false }], live), null);
  assert.equal(pickTarget(null, [], live), null);
});

test("locked: a live element stays, even when other candidates exist", () => {
  const a = { live: true };
  assert.equal(pickTarget(a, [{ live: true }], live), a);
});

test("locked: a detached element drops the spotlight and never switches to another match", () => {
  const a = { live: false };
  const b = { live: true };
  assert.equal(pickTarget(a, [b], live), null);
});
