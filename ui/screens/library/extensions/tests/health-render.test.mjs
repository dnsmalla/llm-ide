import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");
const requireFromDesktop = createRequire(join(REPO, "desktop", "package.json"));
let X, h, html;
before(async () => {
  const { build } = requireFromDesktop("esbuild");
  const outfile = join(bundleDir("extensions-health"), "entry.mjs");
  await build({ entryPoints: [join(HERE, "entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts") }, jsx: "automatic", logLevel: "silent" });
  X = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  h = requireFromDesktop("react").createElement;
  html = (el) => requireFromDesktop("react-dom/server").renderToStaticMarkup(el);
});

const base = { kind: "mcp", id: "files", checking: false, onCheck() {}, actions: {}, now: 100_000 };

test("not checked yet: the status line and a Check button, nothing else", () => {
  const out = html(h(X.Health, { ...base, result: undefined }));
  assert.match(out, /role="status"/);
  assert.match(out, /Not checked yet/);
  assert.match(out, />Check</);
});

test("a problem shows its message and its one fix button; the tools list is text", () => {
  const result = { status: "problem", checkedAt: 40_000, tools: [{ name: "list_issues", description: "<img src=x onerror=1>" }],
    problems: [{ code: "X", message: "It <b>failed</b>.", fix: "repair" }, { code: "Y", message: "No program.", fix: "install-program", program: "npx" }] };
  const out = html(h(X.Health, { ...base, result, actions: { repair() {} } }));
  assert.match(out, /Problem/);
  assert.match(out, /Checked 1 minute ago/);
  assert.match(out, /It &lt;b&gt;failed&lt;\/b&gt;\./);
  assert.match(out, />Repair</);
  assert.match(out, /Install npx, then press Check\./);
  assert.equal((out.match(/>Repair</g) ?? []).length, 1);
  assert.match(out, /Tools \(1\)/);
  assert.match(out, /&lt;img src=x onerror=1&gt;/);
  assert.doesNotMatch(out, /<img |<b>/);
});

test("a fix the owner cannot run shows no button; checking disables Check", () => {
  const result = { status: "problem", checkedAt: 1, tools: [], problems: [{ code: "X", message: "Needs consent.", fix: "consent" }] };
  assert.doesNotMatch(html(h(X.Health, { ...base, result })), /Allow…/);
  const out = html(h(X.Health, { ...base, result: undefined, checking: true }));
  assert.match(out, /disabled=""[^>]*>Checking…</);
});
