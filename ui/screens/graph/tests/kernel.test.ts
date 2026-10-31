import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeGraph } from "../decode.ts";
import { WasmKernel, computeRanks, decodeKernelOutput, encodeKernelInput } from "../kernel.ts";
import { LAYOUT_MIN_WEIGHT, edgeWeight } from "../weights.ts";
import { synthKitGraph } from "../bench/synth.ts";
import { loadWasmBytes } from "./wasm-helper.ts";
import { verify } from "../../../../scripts/vendor-graph-layout-wasm.mjs";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8");

test("the vendored wasm matches its committed manifest (sha256, size, commit)", () => {
  assert.deepEqual(verify(), []);
});

/** Degree rules of the Rust kernel (Topology::build), computed independently from the decoded edges. */
function expectedDegrees(model: ReturnType<typeof decodeGraph>) {
  const nbr: Set<number>[] = Array.from({ length: model.n }, () => new Set());
  const inDeg = new Array(model.n).fill(0);
  for (let e = 0; e < model.m; e++) {
    const w = edgeWeight(model.edgeKinds[model.edgeKind[e]], model.conf[e]);
    if (w < LAYOUT_MIN_WEIGHT) continue;
    const a = model.from[e], b = model.to[e];
    if (a === b) continue;
    inDeg[b]++;
    nbr[a].add(b);
    nbr[b].add(a);
  }
  return { degree: nbr.map((s) => s.size), inDeg };
}

for (const name of ["sample", "merge-code", "memory"]) {
  test(`kernel conformance on schema fixture ${name}: exact degrees, finite positions, determinism`, async () => {
    const kernel = await WasmKernel.create(await loadWasmBytes());
    const model = decodeGraph(fixture(name));
    const input = encodeKernelInput(model);
    const bytes = kernel.run(input);
    const out = decodeKernelOutput(bytes, model.n);
    const exp = expectedDegrees(model);
    assert.deepEqual(Array.from(out.degree), exp.degree, "degree is exact");
    assert.deepEqual(Array.from(out.inDegree), exp.inDeg, "in-degree is exact");
    assert.equal(out.nonFinite, 0);
    for (const v of out.pos) assert.ok(Number.isFinite(v));
    const comms = new Set(out.community);
    assert.equal(comms.size, out.communityCount, "community count matches the ids used");
    assert.ok([...comms].every((c) => c < out.communityCount));
    for (const r of out.radius) assert.ok(r >= 5 - 1e-9 && r <= 26 + 1e-9, "radius inside the tier range");
    assert.deepEqual(Array.from(kernel.run(input)), Array.from(bytes), "same input, same bytes");
  });
}

test("kernel on a 600-node synthetic graph: finds the planted clusters", async () => {
  const kernel = await WasmKernel.create(await loadWasmBytes());
  const model = decodeGraph(synthKitGraph({ nodes: 600, clusterSize: 60 }));
  const out = decodeKernelOutput(kernel.run(encodeKernelInput(model)), model.n);
  assert.ok(out.communityCount >= 6 && out.communityCount <= 60, `communities ${out.communityCount}`);
  // Nodes of one planted cluster mostly share a community.
  const counts = new Map<number, number>();
  for (let i = 0; i < 60; i++) counts.set(out.community[i], (counts.get(out.community[i]) ?? 0) + 1);
  assert.ok(Math.max(...counts.values()) >= 30);
});

test("kernel input errors are reported, not trapped", async () => {
  const kernel = await WasmKernel.create(await loadWasmBytes());
  const model = decodeGraph(fixture("sample"));
  const input = encodeKernelInput(model);
  assert.throws(() => kernel.run(input.slice(0, 5)), /rejected/);
  assert.throws(() => kernel.run(input.slice(0, input.length - 3)), /rejected/);
  const bad = input.slice();
  bad[9] = 3; bad[10] = 0x7a; bad[11] = 0x7a; bad[12] = 0x7a; // kind name "zzz": unknown
  assert.throws(() => kernel.run(bad), /rejected/);
  // the instance still works afterwards
  assert.ok(kernel.run(input).length > 12);
});

test("decodeKernelOutput validates length and node count; non-finite coordinates are reset and counted", async () => {
  const kernel = await WasmKernel.create(await loadWasmBytes());
  const model = decodeGraph(fixture("sample"));
  const bytes = kernel.run(encodeKernelInput(model));
  assert.throws(() => decodeKernelOutput(bytes.slice(0, 20), model.n), /wrong length|truncated/);
  assert.throws(() => decodeKernelOutput(bytes, model.n + 1), /expected/);
  assert.throws(() => decodeKernelOutput(bytes.slice(0, 5), model.n), /truncated/);
  const poisoned = bytes.slice();
  new DataView(poisoned.buffer).setFloat64(12, NaN, true);
  const out = decodeKernelOutput(poisoned, model.n);
  assert.equal(out.nonFinite, 1);
  assert.equal(out.pos[0], 0);
});

test("computeRanks: 0 for the most important node, per-community ranks restart", () => {
  const radius = Float32Array.from([5, 20, 10, 8]);
  const degree = Uint32Array.from([1, 5, 2, 2]);
  const community = Uint32Array.from([0, 0, 1, 1]);
  const { rank, communityRank } = computeRanks(radius, degree, community);
  assert.equal(rank[1], 0);
  assert.equal(rank[0], 1);
  assert.equal(communityRank[1], 0);
  assert.equal(communityRank[0], 1);
  assert.equal(communityRank[2], 0);
  assert.equal(communityRank[3], 1);
  assert.equal(computeRanks(Float32Array.of(3), Uint32Array.of(0), Uint32Array.of(0)).communityRank[0], 0, "a singleton community is always shown");
});

test("a missing export is refused at load", async () => {
  // smallest valid module without the kernel exports
  const empty = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  await assert.rejects(() => WasmKernel.create(empty), /lacks export/);
});
