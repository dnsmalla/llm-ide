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

test("literal replacement is not a template: $ and & are written as typed", () => {
  const o = { regex: false, caseSensitive: true, wholeWord: false, include: "", exclude: "", openFilesOnly: false, useIgnore: true };
  assert.deepEqual(m.replaceAll("cost", m.buildReplacer("cost", o), "$&$1", { regex: false, preserveCase: false }), { text: "$&$1", count: 1 });
  assert.equal(m.replaceAll("cost", m.buildReplacer("cost", { ...o, regex: true }), "$&", { regex: true, preserveCase: false }).text, "cost");
});

test("preserve case mirrors each match: ALL CAPS, Capitalised and lower-case (the Mac's rule)", () => {
  const o = { regex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "", openFilesOnly: false, useIgnore: true };
  const re = m.buildReplacer("alpha", o);
  assert.equal(m.replaceAll("ALPHA Alpha alpha", re, "beta", { regex: false, preserveCase: true }).text, "BETA Beta beta");
  assert.equal(m.preserveCaseReplacement("ALPHA", "x"), "X");
  assert.equal(m.preserveCaseReplacement("Alpha", "beta"), "Beta");
  assert.equal(m.preserveCaseReplacement("alpha", "Beta"), "Beta");
  assert.equal(m.preserveCaseReplacement("123", "x"), "x", "a match with no letters keeps the replacement as written");
  assert.equal(m.replaceAll("Alpha", re, "beta", { regex: true, preserveCase: true }).text, "beta", "preserve case is for literal queries only");
});
