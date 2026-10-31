import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeGraph, GraphDecodeError, cleanText, relativePath } from "../decode.ts";
import { DEFAULT_CAPS } from "../model.ts";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8");

test("graph-kit schema fixtures decode (canonical GraphDocument)", () => {
  for (const name of ["sample", "merge-code", "memory"]) {
    const doc = JSON.parse(fixture(name));
    const m = decodeGraph(fixture(name));
    assert.equal(m.format, "graph-document-1");
    assert.equal(m.n, new Set(doc.nodes.map((n: { id: string }) => n.id)).size, name);
    assert.ok(m.m <= doc.edges.length);
    assert.equal(m.from.length, m.m);
    for (let e = 0; e < m.m; e++) assert.ok(m.from[e] < m.n && m.to[e] < m.n && m.from[e] !== m.to[e]);
  }
  const s = decodeGraph(fixture("sample"));
  assert.deepEqual(s.titles, ["app.ts", "start", "db.ts"]);
  assert.equal(s.paths[0], "src/app.ts");
  assert.equal(s.paths[1], null);
  assert.deepEqual(s.edgeKinds.sort(), ["contains", "imports"]);
});

const kit = JSON.stringify({
  version: "1.1",
  files: [
    { path: "src/a.ts", name: "a.ts", language: "typescript", loc: 10, role: "entry", imports: ["src/b.ts", "react"], usedBy: [] },
    { path: "src/b.ts", imports: [], usedBy: ["src/a.ts", "src/c.ts"] },
    { path: "src/c.ts" },
  ],
  calls: [
    { from: "src/a.ts", to: "src/b.ts", symbol: "x" },
    { from: "src/a.ts", to: "src/b.ts", symbol: "y" },
    { from: "src/c.ts", to: "src/new.ts", symbol: "z" },
  ],
});

test("graph-kit 1.1: files, import edges deduped, module specifiers ignored, parallel calls collapse, call endpoints add nodes", () => {
  const m = decodeGraph(kit);
  assert.equal(m.format, "graph-kit-1.1");
  assert.deepEqual(m.ids, ["src/a.ts", "src/b.ts", "src/c.ts", "src/new.ts"]);
  assert.equal(m.titles[1], "b.ts");
  assert.deepEqual({ ...m.meta[0] }, { language: "typescript", role: "entry", loc: "10" });
  const edges = [...Array(m.m).keys()].map((e) => `${m.ids[m.from[e]]}>${m.ids[m.to[e]]}:${m.edgeKinds[m.edgeKind[e]]}`).sort();
  assert.deepEqual(edges, ["src/a.ts>src/b.ts:calls", "src/a.ts>src/b.ts:imports", "src/c.ts>src/b.ts:imports", "src/c.ts>src/new.ts:calls"]);
});

test("not a graph: clear errors, never a crash", () => {
  for (const [text, re] of [
    ["{", /not valid JSON/], ["[]", /must be a JSON object/], ["null", /must be a JSON object/], ["{}", /neither files\[\]/],
    ['{"schemaVersion":9,"nodes":[],"edges":[]}', /newer than this app/], ['{"nodes":[]}', /nodes\[\] and edges\[\]/],
  ] as const) {
    assert.throws(() => decodeGraph(text), (e) => e instanceof GraphDecodeError && re.test(e.message), text);
  }
});

test("hostile content: bad entries skipped and counted, unknown kinds mapped, strings cleaned and capped", () => {
  const huge = "x".repeat(10_000);
  const text = JSON.stringify({
    schemaVersion: 1,
    nodes: [
      { id: "a", title: "A\u202e<script>alert(1)</script>\u0000", kind: "weirdKind", metadata: { path: "../../etc/passwd", ["__proto__"]: "x", n: 5, nested: { x: 1 } } },
      { id: "b", title: huge, kind: "file", metadata: { path: "/abs/path.ts" } },
      { id: "a", title: "dup", kind: "file" },
      { id: 7 }, null, "str", { id: "" },
      { id: "c", title: "ok", kind: "file", metadata: { path: "src\\win\\c.ts" } },
    ],
    edges: [
      { fromId: "a", toId: "b", kind: "madeUpEdge", confidence: "WHATEVER" },
      { fromId: "a", toId: "missing", kind: "calls" },
      { fromId: "a", toId: "a", kind: "calls" },
      { fromId: 1, toId: 2 }, 5, null,
      { fromId: "b", toId: "c", kind: "calls", confidence: "AMBIGUOUS" },
    ],
  });
  const m = decodeGraph(text);
  assert.deepEqual(m.ids, ["a", "b", "c"]);
  assert.equal(m.nodeKinds[m.kindOf[0]], "other");
  assert.equal(m.titles[0], "A<script>alert(1)</script>", "bidi override and NUL stripped, text kept as text");
  assert.equal(m.titles[1].length, DEFAULT_CAPS.maxLabel);
  assert.equal(m.paths[0], null, "path with .. rejected");
  assert.equal(m.paths[1], null, "absolute path rejected");
  assert.equal(m.paths[2], "src/win/c.ts");
  assert.deepEqual(Object.keys(m.meta[0] ?? {}), ["path", "n"], "proto key and nested values dropped, text kept as metadata");
  assert.equal(m.m, 2);
  assert.equal(m.edgeKinds[m.edgeKind[0]], "relatedTo");
  assert.equal(m.conf[0], 0, "unknown confidence reads as EXTRACTED");
  assert.equal(m.conf[1], 2);
  const joined = m.notices.join("|");
  assert.match(joined, /malformed node entries/);
  assert.match(joined, /missing nodes/);
  assert.match(joined, /repeated node ids/);
  assert.match(joined, /unknown kind/);
});

test("caps: node and edge limits stop loading with a notice", () => {
  const nodes = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, title: `n${i}`, kind: "file" }));
  const edges = Array.from({ length: 49 }, (_, i) => ({ fromId: `n${i}`, toId: `n${i + 1}`, kind: "calls" }));
  const m = decodeGraph(JSON.stringify({ schemaVersion: 1, nodes, edges }), { ...DEFAULT_CAPS, maxNodes: 10, maxEdges: 5 });
  assert.equal(m.n, 10);
  assert.equal(m.m, 5);
  assert.ok(m.notices.some((n) => /first 10 nodes/.test(n)));
  assert.ok(m.notices.some((n) => /first 5 edges/.test(n)));
});

test("a cyclic graph and a 2-node self-referencing import decode without looping", () => {
  const m = decodeGraph(JSON.stringify({ files: [{ path: "a", imports: ["b", "a"], usedBy: ["b"] }, { path: "b", imports: ["a"], usedBy: [] }] }));
  assert.equal(m.n, 2);
  assert.ok(m.m >= 2);
});

test("cleanText and relativePath", () => {
  assert.equal(cleanText(42, 10), "");
  assert.equal(cleanText("a\nb\tc", 10), "abc");
  assert.equal(cleanText("abcdef", 3), "abc");
  assert.equal(relativePath("a/./b//c", 50), "a/b/c");
  for (const bad of ["", "/a", "../a", "a/../b", "C:/x", "a\u0000b", "x".repeat(100)]) assert.equal(relativePath(bad, 50), null, JSON.stringify(bad));
  assert.equal(relativePath(5, 50), null);
});

test("a 20k-node hostile file decodes within a generous time budget", () => {
  const files = Array.from({ length: 20_000 }, (_, i) => ({ path: `p/${i}.ts`, imports: [`p/${(i * 7) % 20000}.ts`, "nope", 5, null] }));
  const t = performance.now();
  const m = decodeGraph(JSON.stringify({ files, calls: [{ from: 1 }, { from: "p/1.ts", to: "p/2.ts" }] }));
  assert.equal(m.n, 20_000);
  assert.ok(performance.now() - t < 5000);
});
