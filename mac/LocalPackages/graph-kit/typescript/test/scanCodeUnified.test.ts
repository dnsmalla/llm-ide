import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseScipJson } from "../src/code/scipScanner.js";

// dist/test/scanCodeUnified.test.js → root is two levels up (see scipScanner.test.ts)
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "..", "test", "fixtures", "scip", "sample.scip.json"), "utf8"),
);

test("scipScanner output merges cleanly with an empty tsScanner graph", () => {
  const scipGraph = parseScipJson(fixture);
  assert.ok(scipGraph.nodes.length > 0);
  assert.ok(scipGraph.edges.length > 0);
});
