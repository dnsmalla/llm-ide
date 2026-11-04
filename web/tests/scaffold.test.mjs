import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the built page's CSP allows no inline or remote script and no plaintext ws beyond loopback", async () => {
  const { CSP, WEB_PORT } = await import("../vite.config.ts");
  assert.equal(WEB_PORT, 5180);
  assert.match(CSP, /script-src 'self';/);
  assert.doesNotMatch(CSP, /unsafe-eval|script-src[^;]*unsafe-inline|\*\.|https?:\/\/(?!127)/);
  assert.match(CSP, /object-src 'none'/);
  for (const ws of CSP.match(/ws:\/\/[^ ;]+/g)) assert.match(ws, /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\*$/);
});

test("the package pins exact versions only", () => {
  const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8"));
  for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(v, /^\d+\.\d+\.\d+$/, name);
});

test("no source uses raw HTML or dynamic code", () => {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(join(WEB, "src"))) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
  }
});
