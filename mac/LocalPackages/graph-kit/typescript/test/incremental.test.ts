import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateMemory } from "../src/incremental.js";

function vault(): string {
  return mkdtempSync(join(tmpdir(), "gk-inc-"));
}

test("first run adds all docs; second run is a no-op (idempotent)", async () => {
  const dir = vault();
  try {
    writeFileSync(join(dir, "a.md"), "# Alpha\nbody\n");
    writeFileSync(join(dir, "b.md"), "# Beta\nbody\n");

    const first = await updateMemory(dir);
    assert.equal(first.added.length, 2);
    assert.equal(first.unchanged.length, 0);
    assert.ok(existsSync(join(dir, ".graphkit", "graph.json")));
    assert.ok(existsSync(join(dir, ".graphkit", ".gitignore")), "artifact dir must self-gitignore");

    const graph1 = readFileSync(join(dir, ".graphkit", "graph.json"), "utf8");

    const second = await updateMemory(dir);
    assert.equal(second.added.length, 0);
    assert.equal(second.updated.length, 0);
    assert.equal(second.unchanged.length, 2, "unchanged docs must be reused, not re-added");

    const graph2 = readFileSync(join(dir, ".graphkit", "graph.json"), "utf8");
    assert.equal(graph1, graph2, "idempotent: identical output on a no-op run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only the changed doc is updated; others stay unchanged", async () => {
  const dir = vault();
  try {
    writeFileSync(join(dir, "a.md"), "# Alpha\nbody\n");
    writeFileSync(join(dir, "b.md"), "# Beta\nbody\n");
    await updateMemory(dir);

    writeFileSync(join(dir, "b.md"), "# Beta\nCHANGED body\n");
    const r = await updateMemory(dir);
    assert.equal(r.updated.length, 1, "exactly one doc changed");
    assert.equal(r.unchanged.length, 1, "the other doc is reused from cache");
    assert.ok(r.updated[0]!.endsWith("b.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a removed doc is reported and dropped from the graph", async () => {
  const dir = vault();
  try {
    writeFileSync(join(dir, "a.md"), "# Alpha\nbody\n");
    writeFileSync(join(dir, "b.md"), "# Beta\nbody\n");
    await updateMemory(dir);

    rmSync(join(dir, "b.md"));
    const r = await updateMemory(dir);
    assert.equal(r.removed.length, 1);
    assert.equal(r.unchanged.length, 1);
    const graph = JSON.parse(readFileSync(join(dir, ".graphkit", "graph.json"), "utf8"));
    assert.ok(!graph.nodes.some((n: { title: string }) => n.title === "Beta"), "Beta dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
