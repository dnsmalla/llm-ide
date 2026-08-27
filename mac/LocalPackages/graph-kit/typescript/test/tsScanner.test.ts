import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCode } from "../src/code/tsScanner.js";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gk-code-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("extracts files, functions, classes, methods with contains edges", async () => {
  const dir = repo({
    "util.ts": "export function helper() { return 1; }\nexport const arrow = () => 2;\n",
    "service.ts": "export class Service {\n  run() {}\n  stop() {}\n}\n",
  });
  try {
    const g = await scanCode(dir);
    const ids = new Set(g.nodes.map((n) => n.id));
    assert.ok(ids.has("file:util.ts"));
    assert.ok(ids.has("symbol:util.ts#helper"));
    assert.ok(ids.has("symbol:util.ts#arrow"), "arrow-function const becomes a function symbol");
    assert.ok(ids.has("symbol:service.ts#Service"));
    assert.ok(ids.has("symbol:service.ts#Service.run"), "method symbol");
    // file contains its top-level symbol
    assert.ok(g.edges.some((e) => e.fromId === "file:util.ts" && e.toId === "symbol:util.ts#helper" && e.kind === "contains"));
    // class contains its method
    assert.ok(g.edges.some((e) => e.fromId === "symbol:service.ts#Service" && e.toId === "symbol:service.ts#Service.run" && e.kind === "contains"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves relative imports to file→file edges", async () => {
  const dir = repo({
    "a.ts": "import { helper } from './b';\nexport const x = helper();\n",
    "b.ts": "export function helper() { return 1; }\n",
  });
  try {
    const g = await scanCode(dir);
    assert.ok(
      g.edges.some((e) => e.fromId === "file:a.ts" && e.toId === "file:b.ts" && e.kind === "imports" && e.confidence === "EXTRACTED"),
      "relative import './b' resolves to file:b.ts",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("class extends / implements produce inherits / implements edges", async () => {
  const dir = repo({
    "base.ts": "export class Base {}\nexport interface Runnable {}\n",
    "child.ts": "import { Base, Runnable } from './base';\nexport class Child extends Base implements Runnable {}\n",
  });
  try {
    const g = await scanCode(dir);
    assert.ok(
      g.edges.some((e) => e.fromId === "symbol:child.ts#Child" && e.toId === "symbol:base.ts#Base" && e.kind === "inherits"),
      "Child inherits Base",
    );
    assert.ok(
      g.edges.some((e) => e.fromId === "symbol:child.ts#Child" && e.toId === "symbol:base.ts#Runnable" && e.kind === "implements"),
      "Child implements Runnable",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("call expressions produce calls edges between symbols", async () => {
  const dir = repo({
    "svc.ts":
      "export function helper() { return 1; }\n" +
      "export function run() { return helper(); }\n" +
      "export class C {\n  go() { return run(); }\n}\n",
  });
  try {
    const g = await scanCode(dir);
    // run() calls helper() — unique name → INFERRED
    assert.ok(
      g.edges.some((e) => e.fromId === "symbol:svc.ts#run" && e.toId === "symbol:svc.ts#helper" && e.kind === "calls" && e.confidence === "INFERRED"),
      "run → calls → helper",
    );
    // C.go() calls run()
    assert.ok(
      g.edges.some((e) => e.fromId === "symbol:svc.ts#C.go" && e.toId === "symbol:svc.ts#run" && e.kind === "calls"),
      "C.go → calls → run",
    );
    // no call edge to a name with no in-repo symbol
    assert.ok(!g.edges.some((e) => e.kind === "calls" && e.toId.includes("#return")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output is deterministic across runs", async () => {
  const dir = repo({ "a.ts": "export function f(){}\nexport class C { m(){} }\n" });
  try {
    assert.deepEqual(await scanCode(dir), await scanCode(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips the same vendor/build dirs as the text walker (vendor, out, target, Pods)", async () => {
  const dir = repo({
    "real.ts": "export function real() {}\n",
    "vendor/lib.ts": "export function vendored() {}\n",
    "out/gen.ts": "export function generated() {}\n",
    "target/t.ts": "export function compiled() {}\n",
    "Pods/p.ts": "export function pod() {}\n",
    "DerivedData/d.ts": "export function derived() {}\n",
    "__pycache__/c.ts": "export function cached() {}\n",
  });
  try {
    const g = await scanCode(dir);
    const files = g.nodes.filter((n) => n.id.startsWith("file:")).map((n) => n.id);
    assert.deepEqual(files, ["file:real.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
