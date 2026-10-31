import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_PROVIDERS, checkClaudeModels, checkProviderCli, claudeStatusLabel, cliStatusLabel, decodeCliResult, decodeModelCount } from "../builtin-providers.ts";
import { fakeClient } from "./helpers.ts";

test("the built-in rows are the Mac's: Claude subscription, Codex, Gemini, DeepSeek key-only", () => {
  assert.deepEqual(BUILTIN_PROVIDERS.map((p) => [p.id, p.cli]), [
    ["anthropic", "claude"],
    ["openai", "codex"],
    ["google", "gemini"],
    ["deepseek", null],
  ]);
  for (const p of BUILTIN_PROVIDERS) assert.ok(p.hint.length > 20, p.id);
});

test("CLI answers: only a boolean ok and a cleaned detail are trusted", () => {
  assert.deepEqual(decodeCliResult({ ok: true, detail: "claude CLI found" }), { ok: true, detail: "claude CLI found" });
  assert.deepEqual(decodeCliResult({ ok: false, detail: "codex CLI not installed" }), { ok: false, detail: "codex CLI not installed" });
  assert.deepEqual(decodeCliResult({ ok: true }), { ok: true, detail: "" });
  assert.deepEqual(decodeCliResult({ ok: true, detail: "a\u0000b\u202e" }), { ok: true, detail: "a b" });
  assert.equal(decodeCliResult({ detail: "x" }), null);
  assert.equal(decodeCliResult(null), null);
  assert.equal(decodeCliResult({ ok: true, detail: "x".repeat(500) })?.detail.length, 240);
});

test("model counts read entries or models; labels describe the state", () => {
  assert.deepEqual(decodeModelCount({ entries: [{ id: "a" }, { id: "b" }] }), { count: 2, detail: "" });
  assert.deepEqual(decodeModelCount({ models: ["a"], detail: "no key" }), { count: 1, detail: "no key" });
  assert.deepEqual(decodeModelCount({}), { count: 0, detail: "" });
  assert.equal(claudeStatusLabel(null, null), "Checking...");
  assert.equal(claudeStatusLabel({ ok: false, detail: "x" }, null), "CLI not found");
  assert.equal(claudeStatusLabel({ ok: true, detail: "" }, { count: 4, detail: "" }), "Signed in · 4 models");
  assert.equal(claudeStatusLabel({ ok: true, detail: "" }, { count: 0, detail: "" }), "CLI found");
  assert.equal(cliStatusLabel(null), "Checking...");
  assert.equal(cliStatusLabel({ ok: true, detail: "" }), "CLI found");
  assert.equal(cliStatusLabel({ ok: false, detail: "" }), "CLI not found");
});

test("the checks call the core routes with no key in the body", async () => {
  const calls: unknown[] = [];
  const client = fakeClient({
    "POST /kb/providers/verify": (body) => {
      calls.push(body);
      return { status: 200, body: { ok: true, detail: "claude CLI found" } };
    },
    "POST /kb/providers/models": (body) => {
      calls.push(body);
      return { status: 200, body: { entries: [{ id: "claude-x" }], models: ["claude-x"] } };
    },
  });
  assert.deepEqual(await checkProviderCli(client, "anthropic"), { ok: true, detail: "claude CLI found" });
  assert.deepEqual(await checkClaudeModels(client), { count: 1, detail: "" });
  assert.deepEqual(calls, [{ provider: "anthropic", mode: "cli" }, { provider: "anthropic" }]);
});

test("an unreadable answer is an error, not a silent success", async () => {
  const client = fakeClient({ "POST /kb/providers/verify": () => ({ status: 200, body: { detail: "x" } }) });
  await assert.rejects(() => checkProviderCli(client, "openai"), /cannot read/);
});
