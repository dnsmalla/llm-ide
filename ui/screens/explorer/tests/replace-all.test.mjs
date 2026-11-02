// Replace All replaces ONLY the matches the search listed (minus dismissed ones), at their listed positions. Each file
// is re-read fresh; a file whose listed matches no longer read as listed is refused (not written) and reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";
import { makeFs, sha } from "./fakes.mjs";

const m = await load("search/replace.ts");
const model = await load("search/model.ts");

const MODE = { regex: false, preserveCase: false };
const lit = (q) => m.buildReplacer(q, { regex: false, caseSensitive: true, wholeWord: false });
const rx = (q) => m.buildReplacer(q, { regex: true, caseSensitive: true, wholeWord: false });

/**
 * What the search host lists for `re` in `text`: per line (CR before LF dropped), UTF-16 columns, non-empty matches.
 * `bom` says the host scanned a UTF-8 BOM first, so line 1 is one column to the right.
 */
function hostHits(text, re, bom = false) {
  const out = [];
  const parts = text.split("\n");
  parts.forEach((raw, i) => {
    const line = i < parts.length - 1 && raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const lineNo = i + 1;
    for (const mm of line.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g"))) {
      if (mm[0] === "") continue;
      out.push({ line: lineNo, col: mm.index + 1 + (bom && lineNo === 1 ? 1 : 0), matched: mm[0], clipped: false });
    }
  });
  return out;
}

/** A Hit as the host reports it (preview is the line; ms/me are UTF-16 offsets into it). */
function hitOf(preview, ms, me, line, col) {
  return { line, col, preview, ms, me };
}

/** Wraps an in-memory fs so a file read with a UTF-8 BOM comes back as fs.read does: BOM stripped, bom flag set. */
function withBom(fs) {
  const read = fs.read.bind(fs);
  const write = fs.write.bind(fs);
  fs.read = async (p, n) => {
    const r = await read(p, n);
    return r.text?.startsWith("﻿") ? { ...r, text: r.text.slice(1), bom: true } : r;
  };
  fs.write = (p, t, o) => write(p, o.bom ? "﻿" + t : t, o);
  return fs;
}

test("unchanged file: exactly the listed matches are replaced, with a CAS write on the same fresh read", async () => {
  const before = "needle one\nno\nneedle two needle\n";
  const fs = makeFs({ "a.ts": before });
  const targets = [{ path: "a.ts", hits: hostHits(before, lit("needle")) }];
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, targets, "X");
  assert.deepEqual(s, { files: 1, replacements: 3, failed: [], changed: [] });
  assert.equal(fs.files.get("a.ts"), "X one\nno\nX two X\n");
  assert.deepEqual(fs.calls.filter((c) => c[0] === "write"), [["write", "a.ts", sha(before)]]);
});

test("file changed after the search: lines inserted above -> refused, not written, reported by name", async () => {
  const fs = makeFs({ "a.ts": "x needle\n" });
  const targets = [{ path: "a.ts", hits: hostHits("x needle\n", lit("needle")) }];
  fs.files.set("a.ts", "new\nnew2\nx needle\n"); // the match moved to line 3 after the search listed it on line 1
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, targets, "X");
  assert.deepEqual(s, { files: 0, replacements: 0, failed: [], changed: ["a.ts"] });
  assert.equal(fs.files.get("a.ts"), "new\nnew2\nx needle\n", "the file is untouched");
  assert.equal(fs.calls.filter((c) => c[0] === "write").length, 0, "no write was attempted");
});

test("a listed match whose text changed in place is refused (same position, different text)", async () => {
  const fs = makeFs({ "a.ts": "needle\n" });
  const targets = [{ path: "a.ts", hits: hostHits("needle\n", lit("needle")) }];
  fs.files.set("a.ts", "needlX\n");
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, targets, "X");
  assert.deepEqual(s.changed, ["a.ts"]);
  assert.equal(fs.files.get("a.ts"), "needlX\n");
});

test("one refused file does not stop the others: the unchanged file is still replaced", async () => {
  const fs = makeFs({ "a.ts": "needle\n", "b.ts": "needle and needle\n" });
  const targets = [
    { path: "a.ts", hits: hostHits("needle\n", lit("needle")) },
    { path: "b.ts", hits: hostHits("needle and needle\n", lit("needle")) },
  ];
  fs.files.set("a.ts", "moved\nneedle\n");
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, targets, "X");
  assert.deepEqual(s, { files: 1, replacements: 2, failed: [], changed: ["a.ts"] });
  assert.equal(fs.files.get("a.ts"), "moved\nneedle\n");
  assert.equal(fs.files.get("b.ts"), "X and X\n");
});

test("same position, different match: a regex whose text changed at the listed spot is refused", async () => {
  const fs = makeFs({ "a.ts": "hello world\n" });
  const targets = [{ path: "a.ts", hits: hostHits("hello world\n", rx("\\w+")).slice(0, 1) }];
  fs.files.set("a.ts", "goodbye world\n"); // \w+ still matches at column 1, but the word is now another one
  const s = await m.replaceListedInFiles(fs, rx("\\w+"), { regex: true, preserveCase: false }, targets, "X");
  assert.deepEqual(s.changed, ["a.ts"]);
  assert.equal(fs.files.get("a.ts"), "goodbye world\n");
});

test("a match added after the search is never replaced; the listed one still is", async () => {
  const fs = makeFs({ "a.ts": "needle\n" });
  const targets = [{ path: "a.ts", hits: hostHits("needle\n", lit("needle")) }];
  fs.files.set("a.ts", "needle\nneedle\n"); // the listed match is still at line 1, column 1
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, targets, "X");
  assert.deepEqual(s, { files: 1, replacements: 1, failed: [], changed: [] });
  assert.equal(fs.files.get("a.ts"), "X\nneedle\n");
});

test("dismissed matches stay: they are not in the targets, so they are never replaced", async () => {
  const fs = makeFs({ "a.ts": "needle one\nneedle two\n" });
  const files = [{ path: "a.ts", more: false, hits: [hitOf("needle one", 0, 6, 1, 1), hitOf("needle two", 0, 6, 2, 1)] }];
  const dismissed = new Set([model.hitKey("a.ts", 1, 1)]);
  const targets = m.listedTargets(files, dismissed);
  assert.deepEqual(targets, [{ path: "a.ts", hits: [{ line: 2, col: 1, matched: "needle", clipped: false }] }]);
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, targets, "X");
  assert.equal(s.replacements, 1);
  assert.equal(fs.files.get("a.ts"), "needle one\nX two\n");
});

test("a file whose only matches were dismissed is not a target at all", () => {
  const files = [{ path: "a.ts", more: false, hits: [hitOf("needle", 0, 6, 1, 1)] }];
  assert.deepEqual(m.listedTargets(files, new Set([model.hitKey("a.ts", 1, 1)])), []);
});

test("CRLF: each listed match on its line is replaced and the CR LF endings are kept", async () => {
  const before = "a needle\r\nb needle\r\n";
  const fs = makeFs({ "a.ts": before });
  const targets = [{ path: "a.ts", hits: hostHits(before, lit("needle")) }];
  assert.deepEqual(targets[0].hits.map((h) => [h.line, h.col]), [[1, 3], [2, 3]]);
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, targets, "X");
  assert.equal(s.replacements, 2);
  assert.equal(fs.files.get("a.ts"), "a X\r\nb X\r\n");
});

test("UTF-8 BOM: line 1 is shifted by the BOM column and the BOM is kept", async () => {
  const body = "hello world\nhello";
  const fs = withBom(makeFs({ "a.ts": "﻿" + body }));
  const targets = [{ path: "a.ts", hits: hostHits(body, rx("\\w+"), true) }];
  // The host scanned the BOM: hello is at col 2 on line 1, world at col 8, and the next hello at line 2 col 1.
  assert.deepEqual(targets[0].hits.map((h) => [h.line, h.col]), [[1, 2], [1, 8], [2, 1]]);
  const s = await m.replaceListedInFiles(fs, rx("\\w+"), { regex: true, preserveCase: false }, [{ path: "a.ts", hits: targets[0].hits.slice(0, 1) }], "X");
  assert.deepEqual(s, { files: 1, replacements: 1, failed: [], changed: [] });
  assert.equal(fs.files.get("a.ts"), "﻿X world\nhello", "hello on line 1 was replaced, not the letters at column 2");
});

test("emoji and CJK on the same line: host UTF-16 columns select exactly the listed matches", async () => {
  const before = "\u{1F600}日本 needle 日本 needle\n";
  const fs = makeFs({ "a.ts": before });
  const hits = hostHits(before, lit("needle"));
  assert.deepEqual(hits.map((h) => h.col), [6, 16]);
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, [{ path: "a.ts", hits: hits.slice(1) }], "X");
  assert.equal(s.replacements, 1);
  assert.equal(fs.files.get("a.ts"), "\u{1F600}日本 needle 日本 X\n", "the dismissed first match stays");
});

test("emoji and CJK: all listed matches on the line are replaced, with preserve case on", async () => {
  const before = "😀日本 ALPHA 日本 alpha\n";
  const fs = makeFs({ "a.ts": before });
  const re = m.buildReplacer("alpha", { regex: false, caseSensitive: false, wholeWord: false });
  const targets = [{ path: "a.ts", hits: hostHits(before, re) }];
  await m.replaceListedInFiles(fs, re, { regex: false, preserveCase: true }, targets, "beta");
  assert.equal(fs.files.get("a.ts"), "😀日本 BETA 日本 beta\n");
});

test("conflict on write: a file edited between the read and the write is refused by the hash compare, and kept", async () => {
  const fs = makeFs({ "a.ts": "needle\n" });
  const read = fs.read.bind(fs);
  fs.read = async (p, n) => {
    const r = await read(p, n);
    fs.files.set(p, r.text + "typed meanwhile\n"); // a concurrent edit lands after the fresh read
    return r;
  };
  const targets = [{ path: "a.ts", hits: hostHits("needle\n", lit("needle")) }];
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, targets, "X");
  assert.deepEqual(s, { files: 0, replacements: 0, failed: [], changed: ["a.ts"] });
  assert.equal(fs.files.get("a.ts"), "needle\ntyped meanwhile\n", "the concurrent edit is not overwritten");
});

test("a file that cannot be read is reported as failed, and the rest continue", async () => {
  const fs = makeFs({ "a.ts": "needle\n", "b.bin": "BIN:needle" });
  const targets = [
    { path: "b.bin", hits: [{ line: 1, col: 1, matched: "needle", clipped: false }] },
    { path: "a.ts", hits: hostHits("needle\n", lit("needle")) },
  ];
  const s = await m.replaceListedInFiles(fs, lit("needle"), MODE, targets, "X");
  assert.deepEqual(s, { files: 1, replacements: 1, failed: ["b.bin"], changed: [] });
  assert.equal(fs.files.get("a.ts"), "X\n");
});

test("listedMatch: only a match cut by a full-size preview window is clipped, not one that ends a short line", () => {
  assert.deepEqual(m.listedMatch(hitOf("abc needle", 4, 10, 1, 5)), { line: 1, col: 5, matched: "needle", clipped: false });
  assert.deepEqual(m.listedMatch(hitOf("needle one", 0, 6, 1, 1)), { line: 1, col: 1, matched: "needle", clipped: false });
  // A 500-byte window whose end cuts the match (the host's long-line preview).
  const win = "x".repeat(40) + "n".repeat(460);
  assert.equal(m.listedMatch(hitOf(win, 40, 500, 1, 900)).clipped, true);
  // CJK: 3 bytes per char; a window ending on a char boundary just under 500 bytes still counts.
  const cjk = "日".repeat(166); // 498 bytes
  assert.equal(m.listedMatch(hitOf(cjk, 10, 166, 1, 1000)).clipped, true);
});

test("a match that ended a short line is refused when the word grew since the search (not replaced longer)", async () => {
  const fs = makeFs({ "a.ts": "let fooId\n" });
  const re = rx("\\w+Id\\w*");
  const files = [{ path: "a.ts", more: false, hits: [hitOf("let fooId", 4, 9, 1, 5)] }];
  const targets = m.listedTargets(files, new Set());
  fs.files.set("a.ts", "let fooIdentity\n");
  const s = await m.replaceListedInFiles(fs, re, { regex: true, preserveCase: false }, targets, "X");
  assert.deepEqual(s.changed, ["a.ts"]);
  assert.equal(fs.files.get("a.ts"), "let fooIdentity\n");
});

test("several matches per line and on adjacent lines, replacements shorter, longer and with a newline", async () => {
  const before = "ab ab ab\nab\nab\n";
  for (const [repl, want] of [
    ["", "  \n\n\n"],
    ["LONGER", "LONGER LONGER LONGER\nLONGER\nLONGER\n"],
    ["1\n2", "1\n2 1\n2 1\n2\n1\n2\n1\n2\n"],
  ]) {
    const fs = makeFs({ "a.ts": before });
    const s = await m.replaceListedInFiles(fs, lit("ab"), MODE, [{ path: "a.ts", hits: hostHits(before, lit("ab")) }], repl);
    assert.deepEqual(s, { files: 1, replacements: 5, failed: [], changed: [] }, JSON.stringify(repl));
    assert.equal(fs.files.get("a.ts"), want, JSON.stringify(repl));
  }
});

test("per-file Replace all in file: the row's targets leave its dismissed matches out too", () => {
  const files = [
    { path: "a.ts", more: false, hits: [hitOf("needle needle", 0, 6, 1, 1), hitOf("needle needle", 7, 13, 1, 8)] },
    { path: "b.ts", more: false, hits: [hitOf("needle", 0, 6, 1, 1)] },
  ];
  const dismissed = new Set([model.hitKey("a.ts", 1, 8)]);
  // What the file row's button passes (SearchPanel: listedTargets of that one file).
  const t = m.listedTargets(files.filter((f) => f.path === "a.ts"), dismissed);
  assert.deepEqual(t, [{ path: "a.ts", hits: [{ line: 1, col: 1, matched: "needle", clipped: false }] }]);
});

test("clipped preview: the file match may extend past the shown text, and is still replaced whole", async () => {
  const before = "needles\n";
  const fs = makeFs({ "a.ts": before });
  const s = await m.replaceListedInFiles(fs, lit("need"), MODE, [{ path: "a.ts", hits: [{ line: 1, col: 1, matched: "need", clipped: true }] }], "X");
  assert.equal(s.replacements, 1);
  assert.equal(fs.files.get("a.ts"), "Xles\n");
});

test("an invalid listed position (zero, fractional, past the line) is refused, never guessed", () => {
  const re = lit("needle");
  for (const bad of [{ line: 0, col: 1 }, { line: 1, col: 0 }, { line: 1, col: 1.5 }, { line: 3, col: 1 }, { line: 1, col: 50 }]) {
    const r = m.replaceListed("needle\n", re, [{ ...bad, matched: "needle", clipped: false }], "X", MODE, false);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});
