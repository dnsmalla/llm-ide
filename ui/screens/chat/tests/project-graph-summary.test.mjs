import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../shell/tests/helpers.mjs";

const { summarizeGraph } = await load("../chat/project-graph-summary.ts");

test("graph summary counts files/edges and names a few main files", () => {
  const out = summarizeGraph({ files: [{ path: "src/a.ts" }, { path: "src/b.ts" }], calls: [{}, {}, {}] });
  assert.match(out, /2 files\/nodes, 3 edges/);
  assert.match(out, /src\/a\.ts, src\/b\.ts/);
  const kinds = summarizeGraph({ files: [{ path: "a.ts", kind: "file" }, { path: "b.ts", kind: "file" }, { path: "c.ts", kind: "test" }] });
  assert.match(kinds, /Kinds: file 2, test 1/);
});

test("graph summary is null for empty or hostile input", () => {
  assert.equal(summarizeGraph(null), null);
  assert.equal(summarizeGraph([]), null);
  assert.equal(summarizeGraph({}), null);
  assert.equal(summarizeGraph({ files: [{}], calls: [] }), "Project graph: 1 files/nodes, 0 edges.");
});
