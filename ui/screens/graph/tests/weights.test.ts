import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { EDGE_BASE_WEIGHT, EDGE_KINDS, confidenceMultiplier, edgeWeight } from "../weights.ts";
import { WasmKernel, encodeKernelInput } from "../kernel.ts";
import { decodeGraph } from "../decode.ts";
import { loadWasmBytes } from "./wasm-helper.ts";

const KIT = new URL("../../../../mac/LocalPackages/graph-kit/", import.meta.url);

test("every edge kind in the graph-kit schema has a weight, and no extra kinds", () => {
  const file = new URL("schema/graph.schema.json", KIT);
  if (!existsSync(file)) return; // checkout without the submodule: nothing to compare
  const schema = JSON.parse(readFileSync(file, "utf8"));
  const kinds: string[] = schema.$defs.edgeKind.enum;
  assert.deepEqual([...kinds].sort(), [...EDGE_KINDS].sort());
});

test("weights equal Swift EdgeWeight.swift (single source of truth)", () => {
  const file = new URL("Sources/GraphCore/Layout/EdgeWeight.swift", KIT);
  if (!existsSync(file)) return;
  const src = readFileSync(file, "utf8");
  const found = new Map<string, number>();
  for (const m of src.matchAll(/case \.(\w+):\s*return ([0-9.]+)/g)) found.set(m[1], Number(m[2]));
  // multiplier cases share the "case .x: return n" shape; keep only edge kinds
  for (const k of EDGE_KINDS) assert.equal(found.get(k), EDGE_BASE_WEIGHT[k], `weight of ${k}`);
  assert.equal(found.get("extracted"), confidenceMultiplier(0));
  assert.equal(found.get("inferred"), confidenceMultiplier(1));
  assert.equal(found.get("ambiguous"), confidenceMultiplier(2));
});

test("the vendored kernel accepts every kind in the table", async () => {
  const k = await WasmKernel.create(await loadWasmBytes());
  const edges = EDGE_KINDS.map((kind, i) => ({ fromId: `n${i}`, toId: `n${i + 1}`, kind }));
  const nodes = Array.from({ length: EDGE_KINDS.length + 1 }, (_, i) => ({ id: `n${i}`, title: `n${i}`, kind: "file" }));
  const model = decodeGraph(JSON.stringify({ schemaVersion: 1, nodes, edges }));
  assert.equal(model.edgeKinds.length, EDGE_KINDS.length);
  assert.ok(k.run(encodeKernelInput(model)).length > 12);
});

test("edgeWeight: kind times confidence, unknown kind reads as relatedTo", () => {
  assert.equal(edgeWeight("imports", 0), 0.9);
  assert.equal(edgeWeight("calls", 1), 0.8 * 0.75);
  assert.equal(edgeWeight("nope", 2), 0.24 * 0.45);
});
