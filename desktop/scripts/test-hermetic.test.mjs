// Guard: test files run as parallel processes, so none may write to a fixed shared path. Bundles go through
// bundleDir() (unique per process); scratch dirs through mkdtemp. Fails on a fixed cache path, a build()
// without bundleDir, or a write whose target is not derived from a per-process directory.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = "desktop/scripts/test-hermetic.test.mjs";

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const files = [
  ...readdirSync(join(REPO, "ui/screens")).flatMap((s) => {
    const d = join(REPO, "ui/screens", s, "tests");
    try { return walk(d); } catch { return []; }
  }),
  ...readdirSync(join(REPO, "desktop/scripts")).filter((n) => /\.test\.mjs$/.test(n)).map((n) => join(REPO, "desktop/scripts", n)),
].filter((f) => /\.(mjs|ts|tsx)$/.test(f) && relative(REPO, f) !== SELF);

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("test files and helpers never write to a fixed shared path", () => {
  assert.ok(files.length > 10, "the scan found the test files");
  const bad = [];
  for (const f of files) {
    const src = strip(readFileSync(f, "utf8"));
    const rel = relative(REPO, f);
    if (/node_modules\/\.cache/.test(src)) bad.push(`${rel}: literal node_modules/.cache path (use bundleDir)`);
    if (/\b(?:outfile|outdir)\b/.test(src) && !/bundleDir\(/.test(src)) bad.push(`${rel}: esbuild output without bundleDir()`);
    const writes = [...src.matchAll(/\b(?:writeFileSync|appendFileSync|writeFile|mkdirSync|copyFileSync|cpSync|renameSync)\(\s*([^,)]+)/g)];
    if (writes.length && !/mkdtemp|bundleDir\(/.test(src)) bad.push(`${rel}: writes files but never creates a per-process temp dir`);
    for (const [, target] of writes) {
      // Targets rooted at the repo, desktop, the test's own folder or a string literal are shared fixed paths.
      if (/^\s*(?:["'`]|join\(\s*(?:REPO|DESKTOP|HERE|SHELL|CHAT|EXPLORER|LIBRARY|__dirname)\b|(?:REPO|DESKTOP|HERE)\b)/.test(target)) bad.push(`${rel}: write to fixed path \`${target.trim()}\``);
    }
  }
  assert.deepEqual(bad, []);
});

test("bundleDir is unique per label and per process", async () => {
  const { bundleDir } = await import("./test-outdir.mjs");
  const a = bundleDir("guard-a");
  assert.equal(bundleDir("guard-a"), a);
  assert.notEqual(bundleDir("guard-b"), a);
  assert.ok(a.includes(`p${process.pid}-`));
});
