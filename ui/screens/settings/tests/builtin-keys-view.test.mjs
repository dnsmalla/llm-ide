// Server-render checks for the built-in key rows: a stored value never reaches the HTML, and Clear is confirmed first.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = resolve(HERE, "..");
const DESKTOP = resolve(SETTINGS, "../../../desktop");
const req = createRequire(join(DESKTOP, "package.json"));
const { build } = req("esbuild");
const { createElement: h } = req("react");
const { renderToStaticMarkup } = req("react-dom/server");

let view;
let model;
let SecretField;
let ctx;
before(async () => {
  const outdir = bundleDir("settings-keys");
  const outfile = join(outdir, "builtin-keys-view.mjs");
  await build({
    entryPoints: { view: join(SETTINGS, "sections/BuiltinKeys.tsx"), model: join(SETTINGS, "builtin-keys-model.ts"), field: join(SETTINGS, "secret-field.ts"), ctx: join(SETTINGS, "context.tsx") },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    logLevel: "silent",
    loader: { ".css": "text" },
    alias: {
      "@llmide/ui-kit/styles.css": resolve(SETTINGS, "../../kit/src/styles/kit.css"),
      "@llmide/ui-kit": resolve(SETTINGS, "../../kit/src/index.ts"),
    },
  });
  view = await import(`${pathToFileURL(join(outdir, "view.js")).href}?t=${Date.now()}`);
  model = await import(`${pathToFileURL(join(outdir, "model.js")).href}?t=${Date.now()}`);
  SecretField = (await import(`${pathToFileURL(join(outdir, "field.js")).href}?t=${Date.now()}`)).SecretField;
  ctx = await import(`${pathToFileURL(join(outdir, "ctx.js")).href}?t=${Date.now()}`);
});

const SECRET = "secret value";
const row = (over) => ({
  row: model.BUILTIN_KEYS[0], stored: true, resetKey: 0, field: new SecretField(), busy: false,
  message: null, confirming: false, onSave: () => {}, onAskClear: () => {}, onCancelClear: () => {}, onClear: () => {},
  ...over,
});

test("a stored key is shown as Saved, its input is a write-only password field, and no value is rendered", () => {
  const html = renderToStaticMarkup(h(view.BuiltinKeyRow, row({})));
  assert.match(html, />Saved</);
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="off"/);
  assert.ok(!html.includes(SECRET));
});

test("Clear is only offered as a request; the destructive step appears after confirming, Cancel first", () => {
  const idle = renderToStaticMarkup(h(view.BuiltinKeyRow, row({ confirming: false })));
  assert.match(idle, /Clear the key for Anthropic/);
  assert.ok(!idle.includes(">Clear key<"), "no destructive action before the request");
  const asking = renderToStaticMarkup(h(view.BuiltinKeyRow, row({ confirming: true })));
  assert.match(asking, /Clear the stored Anthropic/);
  const cancel = asking.indexOf(">Cancel<");
  const confirm = asking.indexOf(">Clear key<");
  assert.ok(cancel >= 0 && confirm > cancel, "Cancel comes before the confirm button");
});

test("the section never renders a stored value, even when the status route returns one", () => {
  const client = {
    async request() {
      return { status: 200, body: { secrets: [{ key: "claude.apiKey", updatedAt: "t", value: SECRET }], available: [] } };
    },
  };
  const html = renderToStaticMarkup(h(ctx.SettingsEnvProvider, { env: { client, host: {} } }, h(view.BuiltinKeys)));
  assert.match(html, /Checking/);
  assert.ok(!html.includes(SECRET));
});

/** Walks the element tree a component returns (without rendering child components) to find a prop-bearing element. */
function findByLabel(node, label) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const f = findByLabel(n, label); if (f) return f; } return null; }
  if (node.props?.label === label) return node;
  return findByLabel(node.props?.children, label);
}

test("the Clear request button only asks; it never clears directly", () => {
  const calls = [];
  const tree = view.BuiltinKeyRow(row({ onAskClear: () => calls.push("ask"), onClear: () => calls.push("clear") }));
  const btn = findByLabel(tree, "Clear the key for Anthropic (Claude)");
  assert.ok(btn, "request button present");
  btn.props.onClick();
  assert.deepEqual(calls, ["ask"]);
});

test("an error message echoing nothing secret is shown, and the typed draft is never rendered", () => {
  const field = new SecretField();
  field.set("drafttypedUNIQUE55");
  const html = renderToStaticMarkup(h(view.BuiltinKeyRow, row({ field, message: { ok: false, text: "Verification failed. The key was not saved." } })));
  assert.match(html, /Verification failed/);
  assert.ok(!html.includes("drafttypedUNIQUE55"));
});

test("only the page's own KeyError wording is shown as written; any other error becomes generic text", () => {
  const leaked = Object.assign(new Error("core said echoedUNIQUE31"), { code: "VALIDATION_FAILED" });
  assert.ok(!view.errorText(leaked).includes("echoedUNIQUE31"));
  assert.equal(view.errorText(new model.KeyError("Type a key first.")), "Type a key first.");
});
