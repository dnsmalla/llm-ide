import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeader, parseNote, parseScalarText } from "../frontmatter.ts";
import { addTags, locateHeader, normalizeTag, readKey, removeKey, removeTags, renderBlock, setKey, yamlScalar } from "../write/frontmatter-edit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(HERE, "../fixtures/frontmatter.json"), "utf8")) as { cases: { name: string; input: string; hasFrontmatter: boolean }[] };

test("fixtures: adding then removing an unrelated key restores every byte", () => {
  for (const c of fixtures.cases) {
    if (!c.hasFrontmatter || !locateHeader(c.input)) continue;
    const added = setKey(c.input, "zz_new", "v");
    assert.notEqual(added, c.input, c.name);
    assert.equal(readKey(added, "zz_new"), "v", c.name);
    assert.equal(removeKey(added, "zz_new"), c.input, c.name);
    // The body and every other key are untouched.
    const before = parseNote(c.input);
    const after = parseNote(added);
    assert.equal(after.body, before.body, c.name);
    assert.deepEqual({ ...after.data, zz_new: undefined }, { ...before.data, zz_new: undefined }, c.name);
  }
});

test("fixtures: removing or setting a missing key of a no-op shape changes nothing else", () => {
  for (const c of fixtures.cases) {
    assert.equal(removeKey(c.input, "no_such_key"), c.input, c.name);
  }
});

test("replaces only the lines of the edited key; unknown keys, comments and order stay byte-identical", () => {
  const src = "---\n# a comment\nid: m1\nx-custom: {a: 1, b: [2]}\nnested:\n  deep: yes\n  more:\n    - z\ntitle: Old\nparticipants:\n- Alice\n- Bob\n\nplatform: meet\nlast: end\n---\n\n## Transcript\n";
  const out = setKey(src, "participants", ["Carol"]);
  assert.equal(out, src.replace("participants:\n- Alice\n- Bob\n", "participants:\n- Carol\n"));
  const t = setKey(src, "title", "New: title");
  assert.equal(t, src.replace("title: Old", "title: 'New: title'"));
  assert.equal(removeKey(src, "nested"), src.replace("nested:\n  deep: yes\n  more:\n    - z\n", ""));
  assert.equal(readKey(src, "x-custom"), null); // unsupported by the reader, still preserved by the editor
  assert.ok(setKey(src, "title", "T2").includes("x-custom: {a: 1, b: [2]}\nnested:\n  deep: yes\n  more:\n    - z\n"));
});

test("new keys are appended inside the header, after the last non-blank line", () => {
  const src = "---\nid: m1\ntitle: T\n\n---\nbody\n";
  assert.equal(setKey(src, "tags", ["a", "b"]), "---\nid: m1\ntitle: T\ntags:\n- a\n- b\n\n---\nbody\n");
  assert.equal(setKey("---\nid: m1\n---\nbody\n", "gist", "Short"), "---\nid: m1\ngist: Short\n---\nbody\n");
});

test("CRLF files stay CRLF: edits use the file's line ending and other lines are untouched", () => {
  const src = "---\r\nid: m1\r\ntitle: T\r\nparticipants:\r\n- A\r\n---\r\n\r\nBody\r\nline2\r\n";
  const out = setKey(src, "title", "Café");
  assert.equal(out, src.replace("title: T", "title: Café"));
  const added = setKey(src, "tags", ["x"]);
  assert.equal(added, "---\r\nid: m1\r\ntitle: T\r\nparticipants:\r\n- A\r\ntags:\r\n- x\r\n---\r\n\r\nBody\r\nline2\r\n");
  assert.ok(!/[^\r]\n/.test(added.replace(/\r\n/g, "")), "no bare LF introduced");
  assert.equal(removeKey(added, "tags"), src);
});

test("a file without frontmatter gets a header only when a key is set", () => {
  assert.equal(removeKey("# Title\n", "tags"), "# Title\n");
  assert.equal(setKey("# Title\n", "tags", ["a"]), "---\ntags:\n- a\n---\n\n# Title\n");
  assert.equal(setKey("# T\r\nx\r\n", "k", "v"), "---\r\nk: v\r\n---\r\n\r\n# T\r\nx\r\n");
  // An unclosed fence is not frontmatter: nothing is spliced into the middle of the text.
  const open = "---\nid: x\nno close\n";
  assert.equal(locateHeader(open), null);
});

test("scalar quoting round-trips through the reader, including hostile values", () => {
  const values = ["a: b", "#x", "- y", "'q'", '"d"', "true", "No", "123", "1e3", "0x1F", "2026-01-01", "2026-01-01T10:00:00Z", "", " lead", "trail ", "tab\there", "line\nbreak", "日本語", "emoji \u{1f600}", "back\\slash", "{x}", "[y]", "key: ", "null", "~", "a #b", "%x", "@y", "&z", "*w", "!t", "|p", ">q", "it's", "a,b", "x\u0000y", "x\u2028y", "---", "- "];
  for (const v of values) {
    const doc = setKey("---\nid: 1\n---\n", "k", v);
    const got = parseHeader(doc.slice(4, doc.indexOf("\n---", 4)));
    assert.equal(got.k, v, JSON.stringify(v));
    assert.equal(got.id, "1");
    assert.equal(parseScalarText(yamlScalar(v)), v, JSON.stringify(v));
  }
  const doc = setKey("---\nid: 1\n---\n", "k", values);
  assert.deepEqual(parseHeader(doc.slice(4, doc.indexOf("\n---", 4))).k, values);
  assert.deepEqual(renderBlock("k", []), ["k: []"]);
  assert.deepEqual(renderBlock("k", null), ["k:"]);
});

test("a malicious key name is refused (no header injection)", () => {
  for (const k of ["a\nb: c", "a b", "", "---", "k:", "-x"]) {
    assert.throws(() => setKey("---\nid: 1\n---\n", k, "v"), RangeError, JSON.stringify(k));
  }
  // A value with a newline cannot break out of its line.
  const out = setKey("---\nid: 1\n---\n", "k", "v\n---\nevil: 1");
  assert.equal(parseNote(out).body, "");
  assert.equal(parseNote(out).data.evil, undefined);
  assert.equal(parseNote(out).data.k, "v\n---\nevil: 1");
});

test("tags: add de-duplicates case-insensitively, keeps order; remove empties the key", () => {
  let t = "---\nid: 1\n---\nbody\n";
  t = addTags(t, ["Alpha", " beta ", "alpha", "#gamma", "bad,tag", "", "x".repeat(200)]);
  assert.deepEqual(readKey(t, "tags"), ["Alpha", "beta", "gamma"]);
  assert.equal(addTags(t, ["ALPHA"]), t, "nothing new: byte-identical");
  t = removeTags(t, ["alpha", "GAMMA"]);
  assert.deepEqual(readKey(t, "tags"), ["beta"]);
  t = removeTags(t, ["beta"]);
  assert.equal(t, "---\nid: 1\n---\nbody\n");
  assert.equal(removeTags(t, ["nope"]), t);
  assert.equal(normalizeTag("  #a  b "), "a b");
  assert.equal(normalizeTag("[x]"), null);
});

test("a single-scalar tags value is upgraded to a list on add", () => {
  const out = addTags("---\ntags: solo\n---\n", ["two"]);
  assert.equal(out, "---\ntags:\n- solo\n- two\n---\n");
});
