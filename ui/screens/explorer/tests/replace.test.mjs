import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const m = await load("search/replace.ts");

test("literal replacement honours case and whole-word options", () => {
  const o = { regex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "" };
  const re = m.buildReplacer("alpha", o);
  assert.deepEqual(m.replaceAll("Alpha alpha ALPHA alphabet", re, "X"), { text: "X X X Xbet", count: 4 });
  assert.equal(m.replaceAll("alpha", m.buildReplacer("alpha", { ...o, caseSensitive: true }), "X").count, 1);
  assert.equal(m.replaceAll("alphabet", m.buildReplacer("alpha", { ...o, wholeWord: true }), "X").count, 0);
});

test("regex replacement supports groups and invalid patterns fail closed", () => {
  const o = { regex: true, caseSensitive: true, wholeWord: false, include: "", exclude: "" };
  assert.equal(m.replaceAll("a1 b2", m.buildReplacer("([a-z])(\\d)", o), "$2$1").text, "1a 2b");
  assert.equal(m.buildReplacer("(", o), null);
});
