// The agent's issue-comment tool must not double-post when a turn is retried.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.LLMIDE_JWT_SECRET = "a".repeat(48);
process.env.LLMIDE_VAULT_KEY = "b".repeat(48);
process.env.NODE_ENV = "test";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, "_issues-tool-handler-test.db");
process.env.LLMIDE_DB_PATH = DB;

const db = await import("../kb/db.mjs");
const { setSecret } = await import("../server/vault.mjs");
const { _setPinnedFetchForTests } = await import("../server/pinned-fetch.mjs");
const { _resetIssueWriteIdemForTests } = await import("../server/issue-writer.mjs");
const users = await import("../server/users.mjs");
const { indexTicketsJson } = await import("../connectors/issues.mjs");
const { handleIssueComment } = await import("../llm_agent/tools/handlers/issues.mjs");

test("a retried identical issue-comment posts once; a different body or a failed first attempt posts again", async () => {
  _resetIssueWriteIdemForTests();
  db.closeDb();
  for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) fs.rmSync(f, { force: true });
  const u = users.registerUser(db.getDb(), { email: `t-${Date.now()}@example.com`, password: "CorrectHorseBattery", displayName: "t" }).id;
  indexTicketsJson(u, { provider: "github", tickets: [{ url: "https://github.com/o/r/issues/7", title: "Seven", meta: { repo: "o/r", number: 7, state: "open", isPR: false } }] });
  setSecret(db.getDb(), u, "github.token", "ghp_secret_value_123456");
  let posts = 0;
  let status = 201;
  _setPinnedFetchForTests(async () => { posts += 1; return new Response(JSON.stringify({ id: 1, html_url: "https://github.com/o/r/issues/7#c1" }), { status }); });
  try {
    const args = { provider: "github", repo: "o/r", number: 7, body: "stage done" };
    const first = await handleIssueComment(args, { userId: u });
    assert.equal(first.ok, true, JSON.stringify(first));
    const retry = await handleIssueComment(args, { userId: u });
    assert.equal(retry.ok, true);
    assert.equal(retry.deduped, true);
    assert.equal(posts, 1, "the retry did not reach the provider");
    await handleIssueComment({ ...args, body: "next stage" }, { userId: u });
    assert.equal(posts, 2);
    status = 500;
    const failed = await handleIssueComment({ ...args, body: "flaky" }, { userId: u });
    assert.ok(failed.error);
    status = 201;
    assert.equal((await handleIssueComment({ ...args, body: "flaky" }, { userId: u })).ok, true);
    assert.equal(posts, 4, "a failed attempt frees the key");
  } finally { _setPinnedFetchForTests(null); db.closeDb(); for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) fs.rmSync(f, { force: true }); }
});
