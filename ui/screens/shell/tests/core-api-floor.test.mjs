import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_API_VERSION, coreApiWarning } from "../core-api-floor.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("the app's API floor is the SERVER_API_VERSION the bundled core is built with (drift guard)", () => {
  const server = readFileSync(join(REPO, "extension/server.mjs"), "utf8");
  const m = server.match(/const SERVER_API_VERSION = (\d+);/);
  assert.ok(m, "extension/server.mjs declares SERVER_API_VERSION");
  assert.equal(APP_API_VERSION, Number(m[1]));
});

test("a core older than the app, or one that reports no version, gets a warning; a current or newer one does not", () => {
  assert.match(coreApiWarning(APP_API_VERSION - 1), /reports API 103, but this app expects API 104/);
  assert.equal(coreApiWarning(APP_API_VERSION), null);
  assert.equal(coreApiWarning(APP_API_VERSION + 5), null);
  assert.match(coreApiWarning(undefined), /does not report its API version/);
  assert.match(coreApiWarning("104"), /does not report its API version/);
  assert.match(coreApiWarning(50, 60), /API 50/);
});
