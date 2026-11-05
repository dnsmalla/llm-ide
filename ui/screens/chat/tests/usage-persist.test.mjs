import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("usage"); });

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 40000, cacheCreationTokens: 8000 };

test("a file message stores per-reply token usage in the Mac metadata field", () => {
  const msg = c.toFileMessage({ role: "assistant", content: "hi", meta: { mode: "execute", tokenUsage: usage, status: "done" } }, Date.UTC(2026, 0, 2));
  assert.equal(msg.metadata.mode, "execute");
  assert.deepEqual(msg.metadata.tokenUsage, usage);
  assert.equal(msg.status, "done");
  assert.equal(c.toFileMessage({ role: "assistant", content: "x" }, 0).metadata, undefined);
});

test("history rows recover usage and ignore malformed counts", () => {
  const row = (tokenUsage) => c.fromFileMessage({ role: "assistant", content: "x", createdAt: 0, metadata: { tokenUsage } }, 0);
  assert.deepEqual(row(usage).meta?.tokenUsage, usage);
  assert.equal(row({ ...usage, outputTokens: -1 }).meta, null);
  assert.equal(c.fromFileMessage({ role: "assistant", content: "x", createdAt: 0, metadata: { tokenUsage: { inputTokens: 1 } } }, 0).meta, null);

  const messages = c.toMessages([{ seq: 1, role: "assistant", content: "x", meta: { tokenUsage: usage }, createdAt: 0 }]);
  assert.deepEqual(messages[0].usage, usage);
  assert.equal(c.toMessages([{ seq: 1, role: "assistant", content: "x", meta: null, createdAt: 0 }])[0].usage, undefined);
});
