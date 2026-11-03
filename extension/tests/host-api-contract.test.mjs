import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "../routes/bus/schema-validate.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "schema", "host-api", "v1");
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const envelope = json("envelope.schema.json");
const check = (value) => validate(envelope, value, { defs: envelope.$defs });

test("host-api envelope: valid request/response/event/error frames pass", () => {
  for (const f of ["request", "response", "event", "error"]) {
    assert.deepEqual(check(json(`fixtures/valid/${f}.json`)), [], f);
  }
});

test("host-api envelope: missing version, bad id and unknown fields fail", () => {
  assert.ok(check(json("fixtures/invalid/missing-api-version.json")).length > 0);
  assert.ok(check(json("fixtures/invalid/bad-request-id.json")).length > 0);
  assert.ok(check(json("fixtures/invalid/unknown-field.json")).length > 0);
});
