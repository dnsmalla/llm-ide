// kb.findTicket / kb.setTicketState: the hosted issue writes' allowlist lookup and the board row after a close.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
process.env.LLMIDE_JWT_SECRET = "a".repeat(48); process.env.LLMIDE_VAULT_KEY = "b".repeat(48); process.env.NODE_ENV = "test";
const HERE = path.dirname(fileURLToPath(import.meta.url)); const DB = path.join(HERE, "_kb-ticket-lookup-test.db"); process.env.LLMIDE_DB_PATH = DB;
const db = await import("../kb/db.mjs"); const users = await import("../server/users.mjs"); const { indexTicketsJson } = await import("../connectors/issues.mjs");
const GH = "https://github.com";
function reset() { db.closeDb(); for (const f of [DB, `${DB}-shm`, `${DB}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } db.getDb(); }
const user = (tag) => users.registerUser(db.getDb(), { email: `${tag}-${Date.now()}@example.com`, password: "CorrectHorseBattery", displayName: tag }).id;
function seed(u) { indexTicketsJson(u, { provider: "github", tickets: [
  { url: "https://github.com/o/r/issues/7", title: "Seven", meta: { repo: "o/r", number: 7, state: "open", isPR: false } },
  { url: "https://github.com/o/r/pull/8", title: "Eight", meta: { repo: "o/r", number: 8, state: "open", isPR: true } },
  { url: "https://github.com.evil.example/o/far/issues/1", title: "Look-alike", meta: { repo: "o/far", number: 1, state: "open" } },
] }); }
test("findTicket matches provider, repo, number and the stored URL's origin, per user", () => {
  reset(); const u = user("look"); const other = user("other"); seed(u);
  assert.deepEqual(db.findTicket(u, { provider: "github", repo: "o/r", number: 7, origin: GH }), { isPR: false });
  assert.deepEqual(db.findTicket(u, { provider: "github", repo: "o/r", number: 8, origin: GH }), { isPR: true });
  assert.ok(db.findTicket(u, { provider: "github", repo: "o/r", number: null, origin: GH }));
  assert.equal(db.findTicket(u, { provider: "github", repo: "o/r", number: 9, origin: GH }), null);
  assert.equal(db.findTicket(u, { provider: "gitlab", repo: "o/r", number: 7, origin: "https://gitlab.com" }), null);
  assert.equal(db.findTicket(u, { provider: "github", repo: "o/far", number: null, origin: GH }), null);
  assert.equal(db.findTicket(other, { provider: "github", repo: "o/r", number: 7, origin: GH }), null);
});
test("setTicketState changes only the matching row of that user", () => {
  reset(); const u = user("state"); const other = user("state2"); seed(u);
  assert.equal(db.setTicketState(other, { provider: "github", repo: "o/r", number: 7, state: "closed" }), 0);
  assert.equal(db.setTicketState(u, { provider: "github", repo: "o/r", number: 7, state: "closed" }), 1);
  assert.equal(db.listTicketSources(u, { provider: "github", repo: "o/r", state: "closed" }).total, 1);
  assert.equal(db.listTicketSources(u, { provider: "github", repo: "o/r", state: "open" }).total, 1);
});
