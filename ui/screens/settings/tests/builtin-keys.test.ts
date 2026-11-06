import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUILTIN_KEYS, KeyError, clearBuiltinKey, keyStateLabel, loadStoredKeyNames, saveBuiltinKey, visibleBuiltinKeys } from "../builtin-keys-model.ts";
import { SecretField } from "../secret-field.ts";
import { describeError } from "../errors.ts";
import { fakeClient, REPO } from "./helpers.ts";

const KEY = "sk-ant-test-123456";

test("the built-in key rows: Anthropic, Jev (API 73+), SerpAPI, with their vault names", () => {
  assert.deepEqual(BUILTIN_KEYS.map((k) => [k.id, k.vaultKey, k.verifyAs, k.minApiVersion ?? null]), [
    ["anthropic", "claude.apiKey", "anthropic", null],
    ["jev", "jev.apiKey", "jev", 73],
    ["serpapi", "serpapi.apiKey", null, null],
  ]);
});

test("every vault name is in the core allowlist", () => {
  const vault = readFileSync(`${REPO}/extension/server/vault.mjs`, "utf8");
  for (const k of BUILTIN_KEYS) assert.ok(vault.includes(`'${k.vaultKey}'`), `${k.vaultKey} missing from the core allowlist`);
});

test("Jev is hidden unless the server reports API 73 or later (unknown version hides it)", () => {
  assert.deepEqual(visibleBuiltinKeys(null).map((k) => k.id), ["anthropic", "serpapi"]);
  assert.deepEqual(visibleBuiltinKeys(72).map((k) => k.id), ["anthropic", "serpapi"]);
  assert.deepEqual(visibleBuiltinKeys(73).map((k) => k.id), ["anthropic", "jev", "serpapi"]);
});

test("the state words: Saved, Not set, and Checking until the names are read", () => {
  assert.equal(keyStateLabel(true), "Saved");
  assert.equal(keyStateLabel(false), "Not set");
  assert.equal(keyStateLabel(null), "Checking...");
});

test("only the names are read from the status route; a stored value never reaches the model", async () => {
  const client = fakeClient({
    "GET /auth/me/secrets": () => ({ status: 200, body: { secrets: [{ key: "claude.apiKey", updatedAt: "t", value: "secret value" }], available: [] } }),
  });
  const names = await loadStoredKeyNames(client);
  assert.deepEqual([...names], ["claude.apiKey"]);
  assert.ok(!JSON.stringify([...names]).includes("secret value"));
});

test("Save & verify: the typed key is verified, saved trimmed, and the draft is cleared", async () => {
  const field = new SecretField();
  field.set(`  ${KEY}  `);
  const client = fakeClient({
    "POST /kb/providers/verify": () => ({ status: 200, body: { ok: true, detail: "Key works" } }),
    "POST /auth/me/secrets": () => ({ status: 200, body: { ok: true } }),
  });
  const message = await saveBuiltinKey(client, BUILTIN_KEYS[0], field);
  assert.equal(message, "Verified and saved.");
  assert.deepEqual(client.calls.map((c) => [c.method, c.path, c.body]), [
    ["POST", "/kb/providers/verify", { provider: "anthropic", mode: "key", apiKey: KEY }],
    ["POST", "/auth/me/secrets", { key: "claude.apiKey", value: KEY }],
  ]);
  assert.equal(field.state.filled, false, "draft cleared after save");
});

test("a refused key is not saved, the core's detail is shown without the key, and the draft is cleared", async () => {
  const field = new SecretField();
  field.set(KEY);
  const client = fakeClient({
    "POST /kb/providers/verify": () => ({ status: 200, body: { ok: false, detail: `401 for ${KEY}` } }),
  });
  await assert.rejects(() => saveBuiltinKey(client, BUILTIN_KEYS[0], field), (e: unknown) => {
    const msg = e instanceof Error ? e.message : "";
    assert.match(msg, /Verification failed\. The key was not saved\./);
    assert.match(msg, /401/);
    assert.ok(!msg.includes(KEY), "the key is never echoed");
    return true;
  });
  assert.equal(client.calls.length, 1, "nothing saved");
  assert.equal(field.state.filled, false);
});

test("a refused key with no key-looking shape is still redacted from the core's detail (exact-value scrub)", async () => {
  const plain = "jevplainkeyUNIQUE42";
  const field = new SecretField();
  field.set(plain);
  const client = fakeClient({ "POST /kb/providers/verify": () => ({ status: 200, body: { ok: false, detail: `bad key ${plain} rejected` } }) });
  const jev = BUILTIN_KEYS.find((k) => k.id === "jev")!;
  await assert.rejects(() => saveBuiltinKey(client, jev, field), (e: unknown) => {
    const msg = e instanceof Error ? e.message : "";
    assert.ok(!msg.includes(plain), "exact typed value never echoed");
    assert.match(msg, /\[redacted\]/);
    return true;
  });
});

test("a core error envelope that echoes the key is never shown: only its code becomes text", async () => {
  const plain = "echoedsecretUNIQUE77";
  const field = new SecretField();
  field.set(plain);
  const client = fakeClient({ "POST /auth/me/secrets": () => ({ status: 400, body: { error: { code: "VALIDATION_FAILED", message: `bad value ${plain}` } } }) });
  const serp = BUILTIN_KEYS.find((k) => k.id === "serpapi")!;
  await assert.rejects(() => saveBuiltinKey(client, serp, field), (e: unknown) => {
    assert.ok(!(e instanceof KeyError));
    const text = describeError(e);
    assert.ok(text.length > 0 && !text.includes(plain));
    return true;
  });
});

test("SerpAPI has no verifier on the core: the key is saved as typed", async () => {
  const field = new SecretField();
  field.set(KEY);
  const client = fakeClient({ "POST /auth/me/secrets": () => ({ status: 200, body: { ok: true } }) });
  const serp = BUILTIN_KEYS.find((k) => k.id === "serpapi")!;
  assert.equal(await saveBuiltinKey(client, serp, field), "Key saved (not verified).");
  assert.deepEqual(client.calls.map((c) => [c.path, c.body]), [["/auth/me/secrets", { key: "serpapi.apiKey", value: KEY }]]);
});

test("an empty draft sends nothing; a failed write still clears the draft", async () => {
  const client = fakeClient({ "POST /auth/me/secrets": () => ({ status: 400, body: { error: { code: "VALIDATION_FAILED" } } }) });
  const empty = new SecretField();
  empty.set("   ");
  await assert.rejects(() => saveBuiltinKey(client, BUILTIN_KEYS[2], empty), /Type a key first/);
  assert.equal(client.calls.length, 0);
  const field = new SecretField();
  field.set(KEY);
  await assert.rejects(() => saveBuiltinKey(client, BUILTIN_KEYS[2], field));
  assert.equal(field.state.filled, false);
});

test("Clear sends a null value to the existing delete path", async () => {
  const client = fakeClient({ "POST /auth/me/secrets": () => ({ status: 200, body: { ok: true } }) });
  await clearBuiltinKey(client, BUILTIN_KEYS[1]);
  assert.deepEqual(client.calls.map((c) => [c.path, c.body]), [["/auth/me/secrets", { key: "jev.apiKey", value: null }]]);
});
