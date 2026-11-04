// Production static server: SPA fallback, hashed-asset caching, CSP and the no-traversal rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createWebServer } = await import("../scripts/serve.mjs");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "llmide-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>LLM-IDE</title>");
  writeFileSync(join(dir, "assets", "app-123.js"), "console.log('app')");
  return dir;
}

async function start(dir) {
  const s = createWebServer({ distDir: dir });
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const address = s.address();
  return { server: s, base: `http://127.0.0.1:${address.port}` };
}

test("serves the SPA, falls back to index.html, and caches hashed assets", async () => {
  const dir = fixture();
  const { server, base } = await start(dir);
  try {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /LLM-IDE/);
    assert.match(root.headers.get("content-security-policy") ?? "", /default-src 'self'/);

    const asset = await fetch(`${base}/assets/app-123.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "console.log('app')");
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

    const unknown = await fetch(`${base}/chat/deep/link`);
    assert.equal(unknown.status, 200);
    assert.match(await unknown.text(), /LLM-IDE/);
    const missingAsset = await fetch(`${base}/assets/missing-xyz.js`);
    assert.equal(missingAsset.status, 404);
    const missingFile = await fetch(`${base}/favicon.ico`);
    assert.equal(missingFile.status, 404);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses traversal and non-read methods", async () => {
  const dir = fixture();
  const { server, base } = await start(dir);
  try {
    const traversal = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
    assert.ok([400, 404].includes(traversal.status), String(traversal.status));
    const post = await fetch(`${base}/`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
