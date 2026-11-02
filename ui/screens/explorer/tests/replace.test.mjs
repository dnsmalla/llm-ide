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

test("replaceAll skip: a skipped match stays and is not counted, keyed by 1-based line and UTF-16 column", () => {
  const re = /a\d/g;
  assert.deepEqual(m.replaceAll("a1 a2 a3\na4", re, "X", { regex: true, preserveCase: false }, (l, c) => l === 1 && c === 4), { text: "X a2 X\nX", count: 3 });
  assert.deepEqual(m.replaceAll("a1 a2 a3\na4", re, "X", { regex: true, preserveCase: false }, (l, c) => l === 2 && c === 1), { text: "X X X\na4", count: 3 });
  assert.deepEqual(m.replaceAll("a1 a2", re, "X", { regex: true, preserveCase: false }, () => true), { text: "a1 a2", count: 0 });
});

test("positionWalker: lines split on LF, columns in UTF-16 (an emoji counts two)", () => {
  const at = m.positionWalker("ab\r\n\u{1F600} x\ny");
  assert.deepEqual(at(0), { line: 1, col: 1 });
  assert.deepEqual(at(4), { line: 2, col: 1 }, "after the CRLF");
  assert.deepEqual(at(7), { line: 2, col: 4 }, "x is after the emoji (2 units) and a space");
  assert.deepEqual(at(9), { line: 3, col: 1 });
});

test("replaceOneAt: replaces only the match at line and column, and returns null when it is no longer there", () => {
  const re = m.buildReplacer("needle", { regex: false, caseSensitive: true, wholeWord: false });
  const mode = { regex: false, preserveCase: false };
  const text = "x needle y needle\nneedle";
  assert.equal(m.replaceOneAt(text, re, 1, 12, "X", mode), "x needle y X\nneedle");
  assert.equal(m.replaceOneAt(text, re, 2, 1, "X", mode), "x needle y needle\nX");
  assert.equal(m.replaceOneAt(text, re, 1, 3, "X", mode), "x X y needle\nneedle", "the first match is at column 3");
  assert.equal(m.replaceOneAt(text, re, 1, 1, "X", mode), null, "no match starts at column 1");
  assert.equal(m.replaceOneAt(text, re, 9, 1, "X", mode), null, "no such line");
  assert.equal(m.replaceOneAt(text, re, 0, 1, "X", mode), null);
  assert.equal(m.replaceOneAt(text, re, 1, 1.5, "X", mode), null);
});

test("replaceOneAt: CRLF and an emoji before the match, and regex groups in the replacement", () => {
  const re = m.buildReplacer("needle", { regex: false, caseSensitive: true, wholeWord: false });
  assert.equal(m.replaceOneAt("ab\r\ncd needle", re, 2, 4, "X", { regex: false, preserveCase: false }), "ab\r\ncd X");
  assert.equal(m.replaceOneAt("\u{1F600} needle", re, 1, 4, "X", { regex: false, preserveCase: false }), "\u{1F600} X");
  const rx = m.buildReplacer("(alpha)", { regex: true, caseSensitive: false, wholeWord: false });
  assert.equal(m.replaceOneAt("Alpha alpha", rx, 1, 1, "$1-x", { regex: true, preserveCase: false }), "Alpha-x alpha");
  assert.equal(m.replaceOneAt("Alpha alpha", rx, 1, 7, "beta", { regex: true, preserveCase: false }), "Alpha beta");
});

test("replaceOneAt: a literal replacement keeps $ and honours preserve case", () => {
  const re = m.buildReplacer("alpha", { regex: false, caseSensitive: false, wholeWord: false });
  assert.equal(m.replaceOneAt("ALPHA x", re, 1, 1, "beta", { regex: false, preserveCase: true }), "BETA x");
  assert.equal(m.replaceOneAt("cost alpha", re, 1, 6, "$&", { regex: false, preserveCase: false }), "cost $&");
});

test("review: matching is per line, as the host lists matches (a pattern never eats the newline)", () => {
  const rx = (q) => m.buildReplacer(q, { regex: true, caseSensitive: true, wholeWord: false });
  const mode = { regex: true, preserveCase: false };
  // The host matched "x" on line 1 (per line); a whole-text match would also take the LF and join the lines.
  assert.equal(m.replaceOneAt("x\nz", rx("x\\s*"), 1, 1, "y", mode), "y\nz");
  assert.equal(m.replaceOneAt("x\r\nz", rx("x\\s*"), 1, 1, "y", mode), "y\r\nz", "the CR of a CRLF is not part of the line");
  assert.deepEqual(m.replaceAll("x\nz", rx("x\\s*"), "y", mode), { text: "y\nz", count: 1 });
  assert.deepEqual(m.replaceAll("a\nb", rx("a\\s*b"), "Q", mode), { text: "a\nb", count: 0 }, "the search never listed a cross-line match");
  // `$` and `^` anchor at each line, as the host's per-line scan does.
  assert.equal(m.replaceOneAt("ab\ncd", rx("\\w+$"), 1, 1, "Q", mode), "Q\ncd");
  assert.deepEqual(m.replaceAll("ab\ncd\r\nef", rx("^\\w"), "Q", mode), { text: "Qb\nQd\r\nQf", count: 3 });
  // Empty matches are never listed, so never replaced.
  assert.deepEqual(m.replaceAll("ab", rx("x*"), "Q", mode), { text: "ab", count: 0 });
  // A trailing newline and a lone CR are kept byte for byte.
  assert.deepEqual(m.replaceAll("a\r\n\na\r", rx("a"), "b", mode), { text: "b\r\n\nb\r", count: 2 });
});

test("review: skip keys and per-match replace use the host's columns with emoji, CJK and tabs before the match", () => {
  const re = m.buildReplacer("needle", { regex: false, caseSensitive: true, wholeWord: false });
  const mode = { regex: false, preserveCase: false };
  const text = "\u{1F600}日本\tneedle needle\n";
  // Host: 😀 = 2 UTF-16 units, 日本 = 2, tab = 1, so the first needle is at col 6 and the second at col 13.
  assert.equal(m.replaceOneAt(text, re, 1, 6, "X", mode), "\u{1F600}日本\tX needle\n");
  assert.equal(m.replaceOneAt(text, re, 1, 13, "X", mode), "\u{1F600}日本\tneedle X\n");
  assert.deepEqual(m.replaceAll(text, re, "X", mode, (l, c) => l === 1 && c === 6), { text: "\u{1F600}日本\tneedle X\n", count: 1 });
});

test("review: a UTF-8 BOM shifts the host's line-1 columns by one; the shift lands the replace on the shown match", () => {
  const re = m.buildReplacer("\\w+", { regex: true, caseSensitive: true, wholeWord: false });
  const mode = { regex: true, preserveCase: false };
  // fs.read strips the BOM: "hello world". The host scanned "﻿hello world" and reported hello at col 2.
  const text = "hello world\nhello";
  assert.equal(m.bomShift(1, 2, true), 1);
  assert.equal(m.replaceOneAt(text, re, 1, m.bomShift(1, 2, true), "X", mode), "X world\nhello");
  assert.equal(m.replaceOneAt(text, re, 1, 2, "X", mode), "hX world\nhello", "unshifted, the wrong span is replaced");
  assert.equal(m.bomShift(2, 1, true), 1, "only line 1 carries the BOM");
  assert.equal(m.bomShift(1, 2, false), 2);
  assert.equal(m.bomShift(1, 1, true, true), 2, "text column to host column for the dismissed keys");
});
