import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fmDateMs, fmInt, fmList, fmString, parseHead, parseNote, splitFrontmatter } from "../frontmatter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
interface Case {
  name: string;
  source?: string;
  input: string;
  hasFrontmatter: boolean;
  data: Record<string, string | string[] | null>;
  body: string;
}
const fixtures = JSON.parse(readFileSync(join(HERE, "../fixtures/frontmatter.json"), "utf8")) as { cases: Case[] };

for (const c of fixtures.cases) {
  test(`conformance: ${c.name}`, () => {
    const p = parseNote(c.input);
    assert.equal(p.hasFrontmatter, c.hasFrontmatter);
    assert.deepEqual({ ...p.data }, c.data);
    assert.equal(p.body, c.body);
  });
}

test("fixtures copied from the Mac tests still match the Swift files byte for byte", () => {
  for (const c of fixtures.cases) {
    if (!c.source || !c.source.endsWith(".md")) continue;
    assert.equal(readFileSync(join(REPO, c.source), "utf8"), c.input, c.source);
  }
});

test("fixtures are append-only: every case has a unique name", () => {
  const names = fixtures.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test("typed accessors", () => {
  const p = parseNote("---\ntitle: T\nn: 42\nneg: -7\nbad: 4x\nd1: '2026-08-01T10:00:00Z'\nd2: 1785578400\nd3: junk\nlist: [a, b]\nsingle: x\nblank:\n---\n");
  assert.equal(fmString(p.data, "title"), "T");
  assert.equal(fmString(p.data, "blank"), null);
  assert.equal(fmString(p.data, "missing"), null);
  assert.equal(fmInt(p.data, "n"), 42);
  assert.equal(fmInt(p.data, "neg"), -7);
  assert.equal(fmInt(p.data, "bad"), null);
  assert.equal(fmDateMs(p.data, "d1"), Date.parse("2026-08-01T10:00:00Z"));
  assert.equal(fmDateMs(p.data, "d2"), 1785578400000);
  assert.equal(fmDateMs(p.data, "d3"), null);
  assert.deepEqual(fmList(p.data, "list"), ["a", "b"]);
  assert.deepEqual(fmList(p.data, "single"), ["x"]);
  assert.deepEqual(fmList(p.data, "missing"), []);
});

test("parseHead reads a header cut mid-line and mid-header", () => {
  const full = "---\nid: m1\ntitle: Budget review\nplatform: meet\nparticipants:\n- Alice\n- Bob\nlanguage: en\n---\nbody";
  const cut = full.slice(0, full.indexOf("- Bob") + 3); // "...- Bo"
  const p = parseHead(cut);
  assert.equal(p.hasFrontmatter, true);
  assert.equal(fmString(p.data, "title"), "Budget review");
  assert.equal(fmString(p.data, "platform"), "meet");
  assert.deepEqual(fmList(p.data, "participants"), ["Alice"]); // the cut item is dropped, never a half value
  assert.equal(p.body, "");
  // a complete small file behaves like parseNote
  assert.equal(parseHead("---\ntitle: x\n---\nhi").body, "hi");
  // no fence: no frontmatter
  assert.equal(parseHead("# just text\nmore").hasFrontmatter, false);
});

test("bounds: huge headers, huge lists and many keys cannot blow up", () => {
  const manyKeys = "---\n" + Array.from({ length: 5000 }, (_, i) => `k${i}: v`).join("\n") + "\n---\nb";
  assert.equal(Object.keys(parseNote(manyKeys).data).length, 500);
  const bigList = "---\nl:\n" + Array.from({ length: 5000 }, (_, i) => `- i${i}`).join("\n") + "\n---\nb";
  assert.equal((parseNote(bigList).data.l as string[]).length, 1000);
  const huge = "---\ntitle: " + "x".repeat(200_000) + "\n---\nb";
  assert.ok((fmString(parseNote(huge).data, "title") ?? "").length <= 64 * 1024);
  const t0 = performance.now();
  parseNote("---\n" + "a: ".repeat(1) + "[".repeat(50_000) + "\n---\n");
  parseNote("---\nk: '" + "'".repeat(50_000) + "\n---\n");
  assert.ok(performance.now() - t0 < 500, "pathological quoting stays fast");
});

test("splitFrontmatter keeps the Mac quirks", () => {
  assert.equal(splitFrontmatter("---\n---\n"), null);
  assert.deepEqual(splitFrontmatter("---\na: 1\n---x\n\nbody"), { header: "a: 1", body: "body" });
  assert.equal(splitFrontmatter("--- \na: 1\n---\n"), null);
});
