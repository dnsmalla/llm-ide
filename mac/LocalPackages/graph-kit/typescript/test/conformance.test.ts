import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseDocumentString,
  serializeDocument,
  GraphSchemaError,
  CURRENT_SCHEMA_VERSION,
} from "../src/models.js";

// dist/test/conformance.test.js → repo root is three levels up.
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "..", "..", "schema", "fixtures");

test("decodes the shared sample fixture", () => {
  const doc = parseDocumentString(readFileSync(join(fixtures, "sample.json"), "utf8"));
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.nodes.length, 3);
  assert.equal(doc.edges.length, 2);
  assert.equal(doc.nodes[0]!.kind, "file");
  assert.equal(doc.nodes[0]!.metadata["language"], "typescript");
  assert.ok(doc.edges.some((e) => e.kind === "contains" && e.confidence === "EXTRACTED"));
});

test("round-trip is stable (parse → serialize → parse)", () => {
  const original = parseDocumentString(readFileSync(join(fixtures, "sample.json"), "utf8"));
  const reDecoded = parseDocumentString(serializeDocument(original));
  assert.deepEqual(reDecoded, original);
});

test("decodes + round-trips the memory fixture, omitting positions", () => {
  const doc = parseDocumentString(readFileSync(join(fixtures, "memory.json"), "utf8"));
  assert.equal(doc.nodes.length, 3);
  assert.ok(doc.nodes.every((n) => n.position === undefined));
  const reSerialized = serializeDocument(doc);
  assert.ok(!reSerialized.includes('"position"'), "memory nodes must not emit a position key");
  assert.deepEqual(parseDocumentString(reSerialized), doc);
});

test("rejects an unknown future schema version", () => {
  const future = JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1, nodes: [], edges: [] });
  assert.throws(() => parseDocumentString(future), GraphSchemaError);
});

test("rejects a malformed node kind", () => {
  const bad = JSON.stringify({
    schemaVersion: 1,
    nodes: [{ id: "x", title: "X", kind: "notAKind", metadata: {} }],
    edges: [],
  });
  assert.throws(() => parseDocumentString(bad), GraphSchemaError);
});

test("rejects an edge with an unknown confidence", () => {
  const bad = JSON.stringify({
    schemaVersion: 1,
    nodes: [],
    edges: [{ fromId: "a", toId: "b", kind: "imports", confidence: "MAYBE" }],
  });
  assert.throws(() => parseDocumentString(bad), GraphSchemaError);
});
