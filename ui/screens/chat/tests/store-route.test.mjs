import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, fakeCore } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("store-route"); });

test("parseLimit: presets, k/m suffixes, no-cap words, garbage", () => {
  assert.equal(c.parseLimit("50000"), 50000);
  assert.equal(c.parseLimit("50,000"), 50000);
  assert.equal(c.parseLimit("200k"), 200000);
  assert.equal(c.parseLimit("1.5m"), 1500000);
  for (const none of ["", "none", "OFF", "no limit", "0"]) assert.equal(c.parseLimit(none), null);
  for (const bad of ["abc", "-5", "1.5", "1e9", "0.0001k", "99999999999999999m"]) assert.equal(c.parseLimit(bad), undefined, bad);
});

test("cap thresholds match the Mac: ok under 80 percent, warn from 80, reached at the limit", () => {
  assert.equal(c.capLevel(10, null), "none");
  assert.equal(c.capLevel(79, 100), "ok");
  assert.equal(c.capLevel(80, 100), "warn");
  assert.equal(c.capLevel(100, 100), "reached");
  assert.equal(c.meterText(12300, 200000), "12.3k / 200k");
  assert.equal(c.meterText(500, null, 90000), "500 (+90k cached reads)");
  assert.equal(c.raisedLimit(50000, 50000), 100000);
  assert.equal(c.raisedLimit(200000, 10), 300000);
});

test("mode picker rules: only Auto follows the server, a new chat starts on Auto", () => {
  assert.equal(c.pickerMode("auto", "plan"), "plan");
  assert.equal(c.pickerMode("execute", "plan"), null);
  assert.equal(c.pickerMode("auto", "mystery"), null);
  assert.equal(c.pickerModeAfterSessionChange(), "auto");
  assert.deepEqual(c.MODES.map((m) => m.id), ["auto", "ask", "plan", "assist_plan", "review", "document", "execute"]);
});

test("Bypass needs one confirmation per app run", () => {
  assert.equal(c.needsBypassConfirm("bypass", false), true);
  assert.equal(c.needsBypassConfirm("bypass", true), false);
  assert.equal(c.needsBypassConfirm("ask", false), false);
});

test("plain-chat note: catalog model in a tool mode with tools off or unlisted; never for Claude", () => {
  const groups = [{ id: "g", label: "G", catalog: true, models: [{ provider: "custom:cat-groq", model: "tooly", label: "tooly", toolsSupported: true }, { provider: "custom:cat-groq", model: "plain", label: "plain", toolsSupported: false }] }];
  assert.equal(c.plainChatReason("custom:cat-groq", "tooly", "execute", groups, false), "toolsOff");
  assert.equal(c.plainChatReason("custom:cat-groq", "tooly", "execute", groups, true), null);
  assert.equal(c.plainChatReason("custom:cat-groq", "plain", "plan", groups, true), "modelLacksTools");
  assert.equal(c.plainChatReason("custom:cat-groq", "plain", "ask", groups, true), null);
  assert.equal(c.plainChatReason("anthropic", "claude", "execute", groups, false), null);
});

test("loadModelGroups: Claude list + enabled keyed catalog connections with tool flags", async () => {
  const core = fakeCore({ json: {
    "POST /kb/providers/models": { models: ["m1"], entries: [{ id: "m1", displayName: "Model One" }] },
    "GET /kb/providers/catalog": { settings: { toolsEnabled: true }, providers: [{ id: "groq", name: "Groq", connections: [
      { id: "cat-groq", provider: "custom:cat-groq", name: "Groq", enabled: true, hasKey: true }, { id: "cat-off", provider: "custom:cat-off", name: "Off", enabled: false, hasKey: true }] }] },
    "POST /kb/providers/catalog/models": { models: [{ id: "llama", toolsSupported: true }, { id: "tiny", toolsSupported: false }] },
  } });
  const r = await c.loadModelGroups(core);
  assert.equal(r.toolsEnabled, true);
  assert.deepEqual(r.groups.map((g) => g.id), ["anthropic", "cat-groq"]);
  assert.equal(r.groups[0].models[0].label, "Model One");
  assert.deepEqual(r.groups[1].models.map((m) => [m.model, m.toolsSupported]), [["llama", true], ["tiny", false]]);
});

test("loadModelGroups survives a failing model list (note, not an exception)", async () => {
  const core = fakeCore({ json: {} });
  const r = await c.loadModelGroups(core);
  assert.equal(r.groups[0].models.length, 0);
  assert.match(r.groups[0].note, /unavailable/);
});

test("route wrappers hit the contract routes", async () => {
  const core = fakeCore({ json: { "GET /agent/v2/session/route": { enabled: true }, "PUT /agent/v2/session/route": { enabled: true, tokenLimit: 5 }, "POST /agent/v2/cancel": { cancelled: true } } });
  await c.getRoute(core, "chat 1");
  await c.putRoute(core, "chat 1", { tokenLimit: 5 });
  assert.equal(await c.cancelTurn(core, "chat 1"), true);
  assert.equal(core.calls[0].path, "/agent/v2/session/route?chatSessionId=chat%201");
  assert.deepEqual(core.calls[1].body, { chatSessionId: "chat 1", tokenLimit: 5 });
});

// HttpChatStore against a fake of the real routes
function fakeServer(total) {
  const rows = Array.from({ length: total }, (_, i) => ({ seq: i + 1, role: i % 2 ? "assistant" : "user", content: `m${i + 1}`, meta: null, createdAt: 1 }));
  return fakeCore({ json: {
    "GET /kb/chat/sessions/s1": (_b, path) => { const q = new URL(path, "http://x").searchParams; const lim = Math.min(Number(q.get("limit")), 2000); const older = q.has("beforeSeq") ? rows.filter((r) => r.seq < Number(q.get("beforeSeq"))) : rows; const page = older.slice(Math.max(0, older.length - lim)); return { session: { id: "s1", messages: page, hasMore: older.length > page.length } }; },
    "GET /kb/chat/sessions": (_b, path) => ({ sessions: Array.from({ length: Math.min(Number(new URL(path, "http://x").searchParams.get("limit")), 200) }, (_, i) => ({ id: `x${i}`, title: "t", updatedAt: 1 })) }),
    "PATCH /kb/chat/sessions/s1": { ok: true },
    "DELETE /kb/chat/sessions/s1": { ok: true },
    "POST /kb/chat/sessions/s1/messages": { seq: total + 1 },
  } });
}

test("HttpChatStore pages older messages with beforeSeq", async () => {
  const core = fakeServer(450);
  const store = new c.HttpChatStore(core);
  const p1 = await store.loadMessages("s1", { limit: 100 });
  assert.equal(p1.messages[0].seq, 351);
  assert.equal(p1.hasMore, true);
  const p2 = await store.loadMessages("s1", { limit: 100, beforeSeq: 351 });
  assert.deepEqual([p2.messages[0].seq, p2.messages.at(-1).seq], [251, 350]);
  const p3 = await store.loadMessages("s1", { limit: 100, beforeSeq: 251 });
  assert.equal(p3.messages[0].seq, 151);
  const p5 = await store.loadMessages("s1", { limit: 100, beforeSeq: 51 });
  assert.equal(p5.messages.length, 50);
  assert.equal(p5.hasMore, false);
});

test("HttpChatStore: never asks for more than the server caps, list pages by offset, rename/delete use PATCH/DELETE", async () => {
  const core = fakeServer(10);
  const store = new c.HttpChatStore(core);
  await store.loadMessages("s1", { limit: 5000 });
  assert.ok(core.calls.at(-1).path.endsWith("limit=2000"));
  assert.equal((await store.listSessions({ limit: 500, offset: 200 })).length, 200);
  assert.ok(core.calls.at(-1).path.includes("limit=200&offset=200"));
  await store.renameSession("s1", "New");
  await store.deleteSession("s1");
  assert.deepEqual(core.calls.slice(-2).map((x) => x.method), ["PATCH", "DELETE"]);
});

test("toMessages drops system rows and maps history to sealed text", () => {
  const out = c.toMessages([{ seq: 1, role: "system", content: "s" }, { seq: 2, role: "user", content: "u" }, { seq: 3, role: "assistant", content: "a" }]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(out[1].parts[0].sealed, ["a"]);
});

test("describeError maps statuses to retryable", () => {
  assert.equal(c.describeError(new c.CoreHttpError(409, "TURN_IN_PROGRESS", "x")).retryable, true);
  assert.equal(c.describeError(new c.CoreHttpError(402, "SESSION_TOKEN_LIMIT", "x")).retryable, false);
  assert.equal(c.describeError(new TypeError("fetch failed")).code, "CORE_UNREACHABLE");
});
