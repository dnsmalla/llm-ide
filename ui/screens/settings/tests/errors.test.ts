import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, toApiError } from "../core-api.ts";
import { KNOWN_ERROR_CODES, describeError, messageForCode } from "../errors.ts";
import { fixture } from "./helpers.ts";

const MUST_MAP = [
  "COMMIT_NOT_IN_REPO", "VERIFY_UNAVAILABLE", "UPDATE_CHANGED", "INVALID_SOURCE", "SOURCE_EXCEEDS_CEILING", "TOO_MANY_SOURCES",
  "BUSY", "busy", "SOURCE_NOT_ALLOWED", "CATALOG_DISABLED", "VALIDATION_FAILED", "PREVIEW_EXPIRED", "PREVIEW_INVALID", "preview_stale",
  "disk_space", "AGENT_STORE_UNAVAILABLE", "LIMIT", "PROVIDER_BLOCKED", "INVALID_PATH", "AUTH_REQUIRED", "RATE_LIMITED", "UNREACHABLE",
];

test("every code the plan names has its own sentence (not the generic fallback)", () => {
  const generic = messageForCode("SOMETHING_ELSE", 400);
  for (const code of MUST_MAP) {
    assert.ok(KNOWN_ERROR_CODES.includes(code), `${code} unmapped`);
    assert.notEqual(messageForCode(code, 400), generic, code);
    assert.match(messageForCode(code, 400), /\w/);
  }
});

test("sentences never contain the server's message, only our own words", () => {
  const e = toApiError({ status: 400, body: { error: { code: "VALIDATION_FAILED", message: "SECRET sk-abcdefgh12345 leaked in message" } } });
  assert.equal(e.code, "VALIDATION_FAILED");
  assert.ok(!e.message.includes("sk-"));
  assert.ok(!describeError(e).includes("sk-"));
});

test("unknown codes fall back by HTTP status; non-API errors never leak their text", () => {
  assert.match(messageForCode("WHAT", 401), /signed out/i);
  assert.match(messageForCode("WHAT", 404), /no longer exists/i);
  assert.match(messageForCode("WHAT", 429), /too many/i);
  assert.match(messageForCode("WHAT", 503), /backend hit an error/i);
  assert.equal(describeError(new Error("password=hunter2")), "Something went wrong. Try again.");
});

test("allowlist sentences name the typed entry", () => {
  assert.match(describeError(new ApiError(400, "INVALID_SOURCE"), { entry: "not a repo" }), /"not a repo" is not a valid source/);
  assert.match(describeError(new ApiError(403, "SOURCE_EXCEEDS_CEILING"), { entry: "*/*" }), /"\*\/\*" is wider than the operator allows/);
  assert.match(describeError(new ApiError(400, "INVALID_SOURCE")), /^That entry is not a valid source/);
});

test("fixture error envelopes decode to their code", () => {
  for (const rel of [
    "extensions/put-auth-me-extensions-allowlist-400.json",
    "extensions/put-auth-me-extensions-allowlist-403.json",
    "provider-catalog/post-kb-providers-catalog-connect-409-limit.json",
    "agent-history/post-kb-agent-history-compact-409-busy.json",
    "agent-history/post-kb-agent-history-clear-409-preview-stale.json",
    "health-auth/post-auth-login-401.json",
  ]) {
    const f = fixture(rel);
    const e = toApiError({ status: f.status, body: f.response });
    assert.ok(KNOWN_ERROR_CODES.includes(e.code), `${rel}: ${e.code}`);
  }
});

test("plain-string and shapeless error bodies become status-only errors", () => {
  assert.equal(toApiError({ status: 500, body: "oops" }).code, "HTTP_500");
  assert.equal(toApiError({ status: 400, body: { error: "BAD" } }).code, "BAD");
});

import { call } from "../core-api.ts";

const failing = (code: string, status = 0) => ({
  request: async () => {
    const e = new Error("secret text sk-abcdefgh12345") as Error & { code: string; status: number };
    e.name = "CoreError";
    e.code = code;
    e.status = status;
    throw e;
  },
});

test("a shell CoreError keeps its own code instead of becoming UNREACHABLE", async () => {
  for (const [code, status] of [["UNTRUSTED_CORE", 0], ["NO_SESSION", 401], ["SESSION_EXPIRED", 401], ["UNSAFE_URL", 0], ["TIMEOUT", 0], ["BAD_RESPONSE", 502], ["BAD_REQUEST", 0]] as const) {
    const e = (await call(failing(code, status), "GET", "/x").catch((x: unknown) => x)) as ApiError;
    assert.ok(e instanceof ApiError, code);
    assert.equal(e.code, code);
    assert.ok(!describeError(e).includes("sk-"));
  }
  const net = (await call(failing("NETWORK"), "GET", "/x").catch((x: unknown) => x)) as ApiError;
  assert.equal(net.code, "UNREACHABLE");
  const unknown = (await call({ request: async () => { throw new Error("boom"); } }, "GET", "/x").catch((x: unknown) => x)) as ApiError;
  assert.equal(unknown.code, "UNREACHABLE");
});

test("the shell codes have their own plain sentences", () => {
  assert.match(messageForCode("TIMEOUT"), /timed out|did not answer/i);
  assert.match(messageForCode("UNTRUSTED_CORE"), /not verified/i);
  assert.match(messageForCode("NO_SESSION"), /sign in/i);
  assert.match(messageForCode("SESSION_EXPIRED"), /sign in/i);
  assert.match(messageForCode("UNSAFE_URL"), /not on this computer/i);
  assert.match(messageForCode("BAD_RESPONSE"), /could not read|cannot read/i);
  const all = new Set(["TIMEOUT", "UNTRUSTED_CORE", "NO_SESSION", "SESSION_EXPIRED", "UNSAFE_URL", "BAD_RESPONSE", "UNREACHABLE"].map((c) => messageForCode(c)));
  assert.equal(all.size, 7);
});

test("an abort is ABORTED even when the shell reports another code", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const e = (await call(failing("NETWORK"), "GET", "/x", undefined, ctl.signal).catch((x: unknown) => x)) as ApiError;
  assert.equal(e.code, "ABORTED");
  const e2 = (await call(failing("ABORTED"), "GET", "/x").catch((x: unknown) => x)) as ApiError;
  assert.equal(e2.code, "ABORTED");
});
