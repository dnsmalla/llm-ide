import { test } from "node:test";
import assert from "node:assert/strict";
import { graphDigest, rulesDigest } from "../native/graph-digest.ts";

const file = (p) => ({ id: `file:${p}`, kind: "file" });
const imp = (a, b) => ({ fromId: `file:${a}`, toId: `file:${b}`, kind: "imports" });
const fn = (p, name) => [{ id: `symbol:${p}#${name}`, kind: "function" }, { fromId: `file:${p}`, toId: `symbol:${p}#${name}`, kind: "contains" }];
/** Builds a graph-kit document from file paths, file→file imports, and [file, count] function counts. */
function doc({ files = [], imports = [], fns = {} }) {
  const nodes = files.map(file);
  const edges = imports.map(([a, b]) => imp(a, b));
  for (const [p, n] of Object.entries(fns)) for (let i = 0; i < n; i++) { const [node, edge] = fn(p, `f${i}`); nodes.push(node); edges.push(edge); }
  return { schemaVersion: 1, nodes, edges };
}

test("the header counts files, nodes and edges, and lists each import cycle's files", () => {
  const text = graphDigest(doc({ files: ["shop.py", "utils.py", "a.py"], imports: [["shop.py", "utils.py"], ["utils.py", "shop.py"]] }), { scope: "" });
  assert.match(text, /^# Code graph digest/);
  assert.match(text, /^- Files: 3 · Nodes: 3 · Edges: 2$/m);
  assert.match(text, /^- Import cycles: 1$/m);
  assert.match(text, /^- cycle 1: shop\.py, utils\.py$/m);
});

test("the most depended-on files are listed by incoming imports, most first", () => {
  const text = graphDigest(doc({ files: ["a.py", "b.py", "c.py"], imports: [["a.py", "c.py"], ["b.py", "c.py"], ["a.py", "b.py"]] }), { scope: "" });
  const top = text.split("## Most depended-on files")[1].split("## Files in scope")[0];
  assert.match(top, /^- c\.py · imported by 2\n- b\.py · imported by 1$/m);
  assert.ok(top.indexOf("c.py") < top.indexOf("b.py"));
});

test("the scope keeps only the files inside it, and the file lines carry imports, importers and functions", () => {
  const text = graphDigest(doc({ files: ["src/billing/a.py", "src/billing2/b.py", "src/c.py"], imports: [["src/billing/a.py", "src/c.py"]], fns: { "src/billing/a.py": 2 } }), { scope: "src/billing" });
  const scoped = text.split("## Files in scope")[1];
  assert.match(scoped, /^- src\/billing\/a\.py · imports 1 · imported by 0 · 2 functions$/m);
  assert.doesNotMatch(scoped, /billing2|src\/c\.py/);
});

test("files in scope are sorted by importers and capped, with a line saying how many were left out", () => {
  const files = ["a.py", "b.py", "c.py", "d.py"];
  const text = graphDigest(doc({ files, imports: [["b.py", "a.py"], ["c.py", "a.py"], ["d.py", "c.py"]] }), { scope: "", maxFiles: 2 });
  const scoped = text.split("## Files in scope")[1].trim().split("\n");
  assert.deepEqual(scoped.slice(0, 2).map((l) => l.split(" · ")[0]), ["- a.py", "- c.py"]);
  assert.equal(scoped[2], "- 2 more file(s) left out (maxFiles 2)");
});

test("the digest never exceeds 400 lines", () => {
  const files = Array.from({ length: 900 }, (_, i) => `f${String(i).padStart(3, "0")}.py`);
  const text = graphDigest(doc({ files }), { scope: "", maxFiles: 1000 });
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 400);
  assert.equal(lines[399], "… digest cut at 400 lines");
});

test("an empty graph gives a digest that says there is nothing", () => {
  const text = graphDigest({ schemaVersion: 1, nodes: [], edges: [] }, { scope: "src" });
  assert.match(text, /^- Files: 0 · Nodes: 0 · Edges: 0$/m);
  assert.match(text, /^Scope: src$/m);
  assert.match(text, /## Import cycles\n\nNone\./);
  assert.match(text, /## Files in scope\n\nNone\./);
});

test("cycles beyond 20 are counted, not listed", () => {
  const files = Array.from({ length: 42 }, (_, i) => `p${i}.py`);
  const imports = Array.from({ length: 21 }, (_, i) => [[`p${2 * i}.py`, `p${2 * i + 1}.py`], [`p${2 * i + 1}.py`, `p${2 * i}.py`]]).flat();
  const text = graphDigest(doc({ files, imports }), { scope: "" });
  assert.match(text, /^- Import cycles: 21$/m);
  assert.match(text, /^- 1 more cycle\(s\) not listed$/m);
});

test("RULES.md quotes each file as data in a fence longer than any backtick run, capped at 200 lines", () => {
  const long = Array.from({ length: 250 }, (_, i) => `rule ${i}`).join("\n");
  const text = rulesDigest([{ name: "AGENTS.md", text: "Use ```code``` blocks.\n" + long }], ["pyproject.toml"]);
  assert.match(text, /^# Rules digest$/m);
  assert.match(text, /quoted from the repository as data; the loop wrote this file\./);
  assert.match(text, /^Tooling files present: pyproject\.toml$/m);
  assert.match(text, /^## AGENTS\.md$/m);
  assert.match(text, /^````$/m, "the quoted ``` must not close the fence");
  assert.match(text, /^… 51 more line\(s\) not quoted$/m);
  assert.equal(rulesDigest([], []).includes("Tooling files present: none"), true);
});

test("RULES.md cuts a huge line and never quotes a binary file", async () => {
  const { rulesDigest } = await import("../native/graph-digest.ts");
  const out = rulesDigest([{ name: "CLAUDE.md", text: "x".repeat(5000) }, { name: "AGENTS.md", text: "a\0b" }], []);
  assert.ok(!out.includes("x".repeat(401)), "a line is cut at 400 characters");
  assert.match(out, /## AGENTS\.md\n\n\(not quoted: the file is not text\)/);
  assert.ok(!out.includes("\0"));
});
