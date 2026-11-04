// Installable shell: manifest, icons, production-only registration and a worker that never caches the host API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const ROOT = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("the manifest is installable and every icon exists", () => {
  const m = JSON.parse(read("public/manifest.webmanifest"));
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  assert.equal(m.scope, "/");
  assert.ok(m.icons.some((i) => i.sizes === "192x192" && i.type === "image/png"));
  assert.ok(m.icons.some((i) => i.sizes === "512x512" && i.type === "image/png"));
  assert.ok(m.icons.some((i) => i.purpose === "maskable"));
  for (const i of m.icons) assert.ok(existsSync(join(ROOT, "public", i.src.replace(/^\//, ""))), i.src);
});

test("the page declares the manifest and iOS install metadata", () => {
  const html = read("index.html");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /rel="apple-touch-icon"/);
});

test("the worker caches only the shell, only GET, and never the Host API", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /req\.method !== "GET"/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
  assert.match(sw, /url\.pathname\.startsWith\("\/host-api\/"\)/);
  assert.match(sw, /req\.mode === "navigate"/);
  assert.match(sw, /caches\.match\("\/"\)/);
  assert.match(sw, /CACHE = "llmide-shell-v2"/);
  assert.match(sw, /importScripts\("\/sw-prune\.js"\)/);
  assert.match(sw, /pruneOldAssets/);
});

test("service-worker registration is production-only", () => {
  const main = read("src/main.tsx");
  assert.match(main, /import\.meta\.env\.PROD && "serviceWorker" in navigator/);
  assert.match(main, /register\("\/sw\.js"\)/);
});


test("old hashed assets are pruned against the current index, leaving shell entries alone", () => {
  const ctx = { self: {}, URL };
  runInNewContext(read("public/sw-prune.js"), ctx);
  const { assetsInIndex, staleAssetPaths } = ctx.self.LLMIDESwPrune;
  const html = '<script src="/assets/index-new.js"></script><link href="/assets/index-new.css" rel="stylesheet">';
  assert.deepEqual([...assetsInIndex(html)], ["/assets/index-new.js", "/assets/index-new.css"]);
  assert.deepEqual(
    [...staleAssetPaths([
      "https://app.example/assets/index-old.js",
      "https://app.example/assets/index-new.js",
      "https://app.example/icons/icon-192.png",
      "https://app.example/assets/index-old.css",
    ], assetsInIndex(html))],
    ["https://app.example/assets/index-old.js", "https://app.example/assets/index-old.css"],
  );
  assert.deepEqual([...staleAssetPaths([], [])], []);
});
