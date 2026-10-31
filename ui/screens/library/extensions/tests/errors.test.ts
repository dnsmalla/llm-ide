import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtApiError, KNOWN_CODES, errorText, extErrorText, isRetryable, toExtApiError } from "../errors.ts";
import { allFixtureNames, fx } from "./helpers.ts";

test("every known code has its own sentence, never the server's words", () => {
  const seen = new Set<string>();
  for (const code of KNOWN_CODES) {
    const t = extErrorText(new ExtApiError(409, code));
    assert.ok(t.length > 10, code);
    assert.ok(!t.includes(`Request failed (${code})`), `${code} fell through to the generic text`);
    assert.ok(!t.includes("server text"));
    seen.add(t);
  }
  assert.ok(seen.size >= KNOWN_CODES.length - 2, "sentences should be distinct");
});

test("every code in the fixtures is known (or owned by Settings)", () => {
  const codes = new Set<string>();
  for (const name of allFixtureNames()) {
    const f = fx(name);
    if (f.status < 400) continue;
    codes.add(toExtApiError({ status: f.status, body: f.response }).code);
  }
  const settingsOwned = new Set(["AUTH_REQUIRED", "INVALID_SOURCE", "SOURCE_EXCEEDS_CEILING", "INVALID_PATH", "TOO_MANY_SOURCES"]);
  for (const c of codes) assert.ok((KNOWN_CODES as readonly string[]).includes(c) || settingsOwned.has(c), `unmapped code ${c}`);
});

test("SOURCE_NOT_ALLOWED points to Settings > Extension sources", () => {
  assert.match(extErrorText(new ExtApiError(403, "SOURCE_NOT_ALLOWED")), /Settings under Extension sources/);
});

test("VERIFY_UNAVAILABLE says nothing changed and is retryable; UPDATE_CHANGED asks for a new review", () => {
  const v = new ExtApiError(503, "VERIFY_UNAVAILABLE", { retryable: true });
  assert.match(extErrorText(v), /Nothing was changed/);
  assert.equal(isRetryable(v), true);
  assert.match(extErrorText(new ExtApiError(409, "UPDATE_CHANGED")), /Review it again/);
  assert.equal(isRetryable(new ExtApiError(409, "UPDATE_CHANGED")), false);
  assert.match(extErrorText(new ExtApiError(422, "COMMIT_NOT_IN_REPO")), /default branch/);
});

test("rate limits are recognised by status, whatever the code", () => {
  const e = new ExtApiError(429, "WHATEVER");
  assert.match(extErrorText(e), /Too many requests/);
  assert.equal(isRetryable(e), true);
});

test("an unknown code shows only the cleaned code; status-only answers are mapped by status", () => {
  const e = toExtApiError({ status: 500, body: { error: { code: "WEIRD‮_THING", message: "<script>alert(1)</script>" } } });
  assert.equal(e.code, "WEIRD_THING");
  assert.equal(extErrorText(e), "Request failed (WEIRD_THING).");
  assert.equal(toExtApiError({ status: 502, body: "<html>" }).code, "HTTP_502");
  assert.match(extErrorText(new ExtApiError(401, "HTTP_401")), /Sign in again/);
  assert.equal(errorText(new Error("x")), "Something went wrong.");
});

test("details are kept for the model but never shown", () => {
  const e = toExtApiError({ status: 409, body: { error: { code: "CONSENT_REQUIRED", message: "m", details: { kinds: ["hook"] } } } });
  assert.deepEqual(e.details, { kinds: ["hook"] });
  assert.ok(!extErrorText(e).includes("hook"));
});
