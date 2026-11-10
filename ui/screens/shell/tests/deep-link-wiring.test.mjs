import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

test("the app registers llmide:// and forwards the URL to the webview", () => {
  const conf = JSON.parse(read("desktop/src-tauri/tauri.conf.json"));
  assert.deepEqual(conf.plugins["deep-link"].desktop.schemes, ["llmide"]);
  const lib = read("desktop/src-tauri/src/lib.rs");
  assert.match(lib, /tauri_plugin_deep_link::init\(\)/);
  assert.match(lib, /on_open_url/);
  assert.match(lib, /"deep-link"/);
});

test("Chrome still hands off through the local server redirect", () => {
  const sw = read("extension/src/background/service-worker.ts");
  assert.match(sw, /\/launch-app\?to=transcript/);
  const server = read("extension/server.mjs");
  assert.match(server, /llmide:\/\/\$\{tab\}/);
});
