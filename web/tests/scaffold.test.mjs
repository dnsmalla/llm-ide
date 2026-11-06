import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REMOTE_CONNECT = ["https://g.api.mega.co.nz", "https://*.userstorage.mega.co.nz", "https://api.box.com", "https://upload.box.com", "https://*.boxcloud.com", "https://gitlab.com", "https://dl.boxcloud.com", "https://public.boxcloud.com", "https://llm-ide.com"];
// Direct reads (SP7): exactly the hosts the sources clients may call (web/src/sources/http.ts ALLOWED_HOSTS).
const SOURCE_CONNECT = ["https://gitlab.com", "https://api.box.com", "https://dl.boxcloud.com", "https://public.boxcloud.com"];

test("the CSP allows no inline or remote script; remote connects go only to MEGA's API and transfer hosts and the own sync server", async () => {
  const { CSP, WEB_PORT } = await import("../vite.config.ts");
  const { CSP: SERVED } = await import("../scripts/serve.mjs");
  const { ALLOWED_HOSTS } = await import("../src/sources/http.ts");
  assert.equal(WEB_PORT, 5180);
  assert.equal(SERVED, CSP, "the static server sends the same policy as the built page");
  assert.match(CSP, /script-src 'self';/);
  assert.doesNotMatch(CSP, /unsafe-eval|wasm-unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.match(CSP, /object-src 'none'/);
  const dirs = Object.fromEntries(CSP.split("; ").map((d) => { const [k, ...v] = d.split(" "); return [k, v]; }));
  const remote = REMOTE_CONNECT;
  for (const [k, v] of Object.entries(dirs)) {
    for (const src of v) if (/^https?:/.test(src) || src.includes("*.")) assert.ok(k === "connect-src" && remote.includes(src), `${k} ${src}`);
  }
  assert.deepEqual(dirs["connect-src"].filter((s) => s.startsWith("https:")), remote);
  assert.deepEqual(ALLOWED_HOSTS.map((h) => `https://${h}`), SOURCE_CONNECT, "code allow-list and CSP agree");
  for (const ws of CSP.match(/ws:\/\/[^ ;]+/g)) assert.match(ws, /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\*$/);
  const nginx = readFileSync(join(WEB, "../deploy/vps/llm-ide.com.nginx"), "utf8");
  assert.ok(nginx.includes(`connect-src ${dirs["connect-src"].join(" ")};`), "the VPS vhost sends the same connect-src");
  assert.match(nginx, /location ~ \^\/\(app\/\)\?\(oauth\|box\)-callback\\\.html\$ \{\s*access_log off;/, "neither sign-in callback's code reaches the access log");
  const caddy = readFileSync(join(WEB, "DEPLOY.md"), "utf8");
  assert.ok(caddy.includes(`connect-src 'self' wss: ${REMOTE_CONNECT.join(" ")};`), "the Caddy example lists the same remote hosts");
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
