process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.ts";
import { FakeWriteHost } from "./fake-write-host.ts";
import { WriteError } from "../write/write-host.ts";
import { callOk, linkState, linkStateText, listSecretKeys, mapFailure, mapThrown, saveSecret, SourceError, sourceErrorText, type SourceErrorCode, type SourcesCore } from "../sources/source-core.ts";
import {
  CONFIG_KEY, DEFAULT_BOX, DEFAULT_EMAIL, DEFAULT_GITHUB, EMPTY_CONFIGS, loadConfigs, sanitizeConfigs, saveConfigs, secretProblem, validateBox, validateEmail, validateGithub, validateSlack, validateSlackChannelId, type KeyValueStorage,
} from "../sources/source-config.ts";
import { decodeEmail, decodeMcpItem, decodeSlack, fetchEmail, fetchMcp, fetchSlack, fetchMessage, IDLE_FETCH, isConnectorId, planEmail, planMcp, planSlack, startEmailFromNow, type FetchProgress } from "../sources/ingest.ts";
import { applyHead, recordFromEntry } from "../notes-model.ts";
import { parseNote } from "../frontmatter.ts";

const never = new AbortController().signal;

class FakeCore implements SourcesCore {
  calls: { method: string; path: string; body: unknown }[] = [];
  routes = new Map<string, (body: unknown) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>>();
  async call(method: "GET" | "POST" | "DELETE", path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    this.calls.push({ method, path, body });
    const r = this.routes.get(`${method} ${path}`);
    if (!r) return { status: 404, body: {} };
    return r(body);
  }
  on(key: string, fn: (b: unknown) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>): void {
    this.routes.set(key, fn);
  }
  to(path: string): { body: unknown }[] {
    return this.calls.filter((c) => c.path === path);
  }
}

test("failure mapping: statuses and server codes become our codes; server messages are never carried", () => {
  const cases: [number, unknown, SourceErrorCode][] = [
    [401, {}, "unauthorized"],
    [403, { error: { code: "FORBIDDEN" } }, "unauthorized"],
    [403, { error: { code: "PATH_NOT_APPROVED", message: "/Users/x/secret" } }, "not_approved"],
    [400, { error: { code: "BOX_NO_SECRET" } }, "no_secret"],
    [400, { error: { code: "VALIDATION_FAILED" } }, "validation"],
    [502, { error: { code: "EMAIL_GOOGLE_AUTH_FAILED" } }, "upstream_auth"],
    [502, { error: { code: "MCP_UNAUTHORIZED" } }, "upstream_auth"],
    [502, { error: { code: "BOX_CONNECT_FAILED", message: "bad secret abc123" } }, "upstream"],
    [504, {}, "timeout"],
    [429, {}, "rate_limited"],
    [404, { error: "feature_disabled" }, "feature_disabled"],
    [500, "garbage", "failed"],
  ];
  for (const [status, body, code] of cases) assert.equal(mapFailure(status, body).code, code, `${status} ${JSON.stringify(body)}`);
  const e = mapFailure(502, { error: { code: "BOX_CONNECT_FAILED", message: "bad secret abc123" } });
  assert.equal(e.serverCode, "BOX_CONNECT_FAILED");
  assert.ok(!e.message.includes("abc123"));
  assert.equal(mapFailure(500, { error: { code: "x".repeat(500) } }).serverCode!.length, 64);
  assert.equal(mapThrown(Object.assign(new Error("x"), { code: "TIMEOUT" })).code, "timeout");
  assert.equal(mapThrown(Object.assign(new Error("x"), { code: "ABORTED" })).code, "cancelled");
  assert.equal(mapThrown(new Error("boom")).code, "unavailable");
  const ac = new AbortController();
  ac.abort();
  assert.equal(mapThrown(new Error("boom"), ac.signal).code, "cancelled");
  assert.equal(mapThrown(Object.assign(new Error("x"), { code: "SESSION_EXPIRED" })).code, "unauthorized");
  for (const c of ["unauthorized", "validation", "no_secret", "not_approved", "upstream_auth", "upstream", "timeout", "rate_limited", "unavailable", "feature_disabled", "cancelled", "failed"] as const) assert.ok(sourceErrorText(c, "Box").length > 15, c);
  assert.match(sourceErrorText("upstream", "Box"), /Box/);
});

test("vault: lists key NAMES only, writes through the whitelist, deletes with an empty value", async () => {
  const core = new FakeCore();
  core.on("GET /auth/me/secrets", () => ({ status: 200, body: { secrets: [{ key: "box.clientSecret", updatedAt: 1 }, { key: "x", value: "LEAK" }, { nokey: 1 }], available: [] } }));
  core.on("POST /auth/me/secrets", () => ({ status: 200, body: { ok: true } }));
  assert.deepEqual([...(await listSecretKeys(core, never))].sort(), ["box.clientSecret", "x"]);
  await saveSecret(core, "slack.botToken", "xoxb-1", never);
  await saveSecret(core, "email.imapPassword", null, never);
  assert.deepEqual(core.to("/auth/me/secrets").slice(1).map((c) => c.body), [{ key: "slack.botToken", value: "xoxb-1" }, { key: "email.imapPassword", value: "" }]);
  await assert.rejects(saveSecret(core, "github.token" as never, "x", never), (e: SourceError) => e.code === "validation");
  assert.equal(core.to("/auth/me/secrets").length, 3, "a non-source key never reaches the core");
  core.on("POST /auth/me/secrets", () => ({ status: 400, body: { error: { code: "VALIDATION_FAILED", message: "Unknown secret key" } } }));
  await assert.rejects(saveSecret(core, "slack.botToken", "x", never), (e: SourceError) => e.code === "validation");
  // callOk: an abort during the request is "cancelled", not "unavailable".
  const ac = new AbortController();
  const slow: SourcesCore = { call: async () => { ac.abort(); throw new Error("aborted"); } };
  await assert.rejects(callOk(slow, "GET", "/x", undefined, ac.signal), (e: SourceError) => e.code === "cancelled");
  assert.equal(linkState(false, new Set(["box.clientSecret"]), ["box.clientSecret"]), "not_configured");
  assert.equal(linkState(true, new Set(), ["box.clientSecret"]), "credentials_needed");
  assert.equal(linkState(true, new Set(["slack.userToken"]), ["slack.userToken", "slack.botToken"]), "linked");
  assert.equal(linkStateText("linked"), "Connected");
});

test("validators: email, slack, box, github, secrets", () => {
  const ok = { ...DEFAULT_EMAIL, user: "me@example.com" };
  assert.deepEqual(validateEmail(ok), {});
  for (const bad of [{ host: "https://imap.x.com" }, { host: "imap.x.com/path" }, { host: "" }, { host: "-bad.com" }, { port: 0 }, { port: 70000 }, { port: 9.5 }, { user: "" }, { user: "a b" }, { user: "a\nb" }, { mailbox: "" }, { lookbackDays: 0 }, { lookbackDays: 91 }, { fromFilter: "x\ny" }, { authMethod: "x" as never }]) {
    assert.ok(Object.keys(validateEmail({ ...ok, ...bad })).length > 0, JSON.stringify(bad));
  }
  assert.equal(validateSlackChannelId("C0123ABCD"), true);
  assert.equal(validateSlackChannelId("#general"), false);
  assert.equal(validateSlackChannelId("c123"), false);
  assert.deepEqual(validateSlack({ channels: [{ id: "C0123ABCD", name: "g" }], lookbackDays: 7 }), {});
  assert.ok(validateSlack({ channels: [], lookbackDays: 7 }).channels);
  assert.ok(validateSlack({ channels: [{ id: "nope", name: "" }], lookbackDays: 7 }).channels);
  assert.deepEqual(validateBox({ ...DEFAULT_BOX, clientId: "abc123XYZ", subjectId: "12345" }), {});
  for (const bad of [{ clientId: "a b" }, { clientId: "x" }, { subjectId: "abc" }, { subjectId: "" }, { folderId: "x/1" }, { folderId: "" }]) assert.ok(Object.keys(validateBox({ ...DEFAULT_BOX, clientId: "abc123XYZ", subjectId: "1", ...bad })).length > 0, JSON.stringify(bad));
  assert.deepEqual(validateGithub({ ...DEFAULT_GITHUB, repo: "acme/web.site" }), {});
  for (const bad of ["acme", "a/b/c", "../x", "a b/c", "https://github.com/a/b"]) assert.ok(validateGithub({ ...DEFAULT_GITHUB, repo: bad }).repo, bad);
  assert.equal(secretProblem("email", "app-password-1234"), null);
  assert.ok(secretProblem("email", ""));
  assert.ok(secretProblem("email", " lead"));
  assert.ok(secretProblem("email", "a\nb"));
  assert.ok(secretProblem("box", "x".repeat(5000)));
  assert.equal(secretProblem("slack", "xoxb-123"), null);
  assert.ok(secretProblem("slack", "hunter2"));
});

test("config store: round trip, hostile or corrupt storage is dropped, blocked storage never throws", () => {
  const mem = new Map<string, string>();
  const storage: KeyValueStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
  const cfg = { ...EMPTY_CONFIGS, email: { ...DEFAULT_EMAIL, user: "me@example.com" }, box: { ...DEFAULT_BOX, clientId: "abc123XYZ", subjectId: "9" } };
  assert.equal(saveConfigs(storage, cfg), true);
  assert.deepEqual(loadConfigs(storage), cfg);
  mem.set(CONFIG_KEY, "{not json");
  assert.deepEqual(loadConfigs(storage), EMPTY_CONFIGS);
  assert.deepEqual(sanitizeConfigs({ email: { host: "javascript:alert(1)", user: "x" }, box: { clientId: "<script>" }, slack: { channels: [{ id: "<b>" }], lookbackDays: 7 }, github: { repo: "../etc/passwd" } }), EMPTY_CONFIGS);
  assert.deepEqual(sanitizeConfigs("x"), EMPTY_CONFIGS);
  const s = sanitizeConfigs({ slack: { channels: [{ id: "C0123ABCD", name: "gen\u0000eral" }, { id: "bad" }, 5], lookbackDays: 3 }, email: { host: "imap.x.com", user: "u@x.com", port: 993, extra: { evil: 1 } } });
  assert.deepEqual(s.slack, { channels: [{ id: "C0123ABCD", name: "general" }], lookbackDays: 3 });
  assert.ok(s.email && !("extra" in s.email));
  const blocked: KeyValueStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.deepEqual(loadConfigs(blocked), EMPTY_CONFIGS);
  assert.equal(saveConfigs(blocked, cfg), false);
  assert.deepEqual(loadConfigs(null), EMPTY_CONFIGS);
  assert.equal(saveConfigs(null, cfg), false);
});

const EMAIL = { ...DEFAULT_EMAIL, user: "me@example.com" };
const msg = (i: number, over: Record<string, unknown> = {}) => ({ uid: i, messageId: `<m${i}@x>`, subject: `Hello ${i}`, from: "A <a@x.com>", date: "2026-10-05T09:30:15Z", text: `body ${i}\r\nline2`, ...over });
const setup = (messages: unknown[], skipped = { oversize: 0, overCap: 0 }) => {
  const fake = new FakeHost();
  const write = new FakeWriteHost(fake);
  const core = new FakeCore();
  core.on("POST /kb/email/fetch", () => ({ status: 200, body: { messages, skipped } }));
  core.on("POST /kb/email/seen", () => ({ status: 200, body: { ok: true } }));
  const progress: FetchProgress[] = [];
  const deps = (signal: AbortSignal = never) => ({ core, write, signal, onProgress: (p: FetchProgress) => progress.push(p), now: () => Date.parse("2026-10-31T00:00:00Z") });
  return { fake, write, core, progress, deps };
};

test("email note plan: raw capture under source/emails/YYYY/MM, classified as Mail, header and body safe", async () => {
  const m = decodeEmail(msg(1, { subject: "Re: Budget: Q4 #1\u202e", text: "<script>alert(1)</script>\r\nhi" }))!;
  const plan = await planEmail(m, 0);
  assert.match(plan.rel, /^source\/emails\/2026\/10\/2026-10-05-093015-re-budget-q4-1-[0-9a-f]{8}\.md$/);
  assert.equal(plan.id, "<m1@x>");
  const p = parseNote(plan.text);
  assert.equal(p.data.platform, "email");
  assert.equal(p.data.message_id, "<m1@x>");
  assert.match(String(p.data.source_hash), /^[0-9a-f]{64}$/);
  assert.equal(p.data.title, "Re: Budget: Q4 #1\u202e");
  assert.ok(p.body.includes("<script>alert(1)</script>\nhi"), "body is kept as text (rendered safely by the viewer), CRLF normalised");
  const rec = applyHead(recordFromEntry({ rel: plan.rel, size: 1, mtimeMs: 0, placeholder: false }), plan.text);
  assert.equal(rec.sourceId, "email");
  assert.equal(rec.title, "Re: Budget: Q4 #1\u202e");
  // The same message always gets the same path (idempotent re-runs); different ids differ.
  assert.equal((await planEmail(m, 99)).rel, plan.rel);
  assert.notEqual((await planEmail({ ...m, messageId: "<other>" }, 0)).rel, plan.rel);
  assert.equal(decodeEmail({ messageId: "" }), null);
  assert.equal(decodeEmail("x"), null);
  // A bad date falls back to now, not to 1970 or a crash.
  assert.match((await planEmail({ ...m, date: "garbage" }, Date.parse("2026-10-31T00:00:00Z"))).rel, /\/2026\/10\/2026-10-31-/);
});

test("email fetch: writes each message, marks exactly those seen and advances the mark", async () => {
  const s = setup([msg(1), msg(2), msg(3)]);
  const out = await fetchEmail(EMAIL, s.deps());
  assert.deepEqual([out.phase, out.fetched, out.written, out.existing, out.failed], ["done", 3, 3, 0, 0]);
  assert.equal(s.fake.files.size, 3);
  const [fetchCall] = s.core.to("/kb/email/fetch");
  assert.deepEqual(Object.keys(fetchCall!.body as object).sort(), ["authMethod", "fromFilter", "host", "lookbackDays", "mailbox", "markRead", "port", "secure", "unreadOnly", "user"], "no password or token on the request");
  const seen = s.core.to("/kb/email/seen")[0]!.body as { messageIds: string[]; lastFetchedAt: string | null };
  assert.deepEqual(seen.messageIds, ["<m1@x>", "<m2@x>", "<m3@x>"]);
  assert.equal(seen.lastFetchedAt, "2026-10-31T00:00:00.000Z");
  assert.deepEqual(s.progress.map((p) => p.phase).filter((p, i, a) => a.indexOf(p) === i), ["fetching", "writing", "marking", "done"]);
  assert.match(fetchMessage(out), /3 new notes saved/);
  // Re-running with the same messages (server forgot): nothing duplicated, everything re-marked.
  const again = await fetchEmail(EMAIL, s.deps());
  assert.deepEqual([again.written, again.existing], [0, 3]);
  assert.equal(s.fake.files.size, 3);
});

test("email fetch: a failed write is not marked seen and the high-water mark is not advanced", async () => {
  const s = setup([msg(1), msg(2), msg(3)]);
  const orig = s.write.create.bind(s.write);
  s.write.create = async (rel, text) => {
    if (text.includes("<m2@x>")) throw new WriteError("permission_denied");
    return orig(rel, text);
  };
  const out = await fetchEmail(EMAIL, s.deps());
  assert.deepEqual([out.written, out.failed], [2, 1]);
  const seen = s.core.to("/kb/email/seen")[0]!.body as { messageIds: string[]; lastFetchedAt: string | null };
  assert.deepEqual(seen.messageIds, ["<m1@x>", "<m3@x>"]);
  assert.equal(seen.lastFetchedAt, null);
  assert.match(fetchMessage(out), /1 could not be saved and will be fetched again/);
});

test("email fetch: cancel stops writing, still records what was written, never advances the mark", async () => {
  const s = setup([msg(1), msg(2), msg(3), msg(4)]);
  const ac = new AbortController();
  const orig = s.write.create.bind(s.write);
  let n = 0;
  s.write.create = async (rel, text) => {
    const r = await orig(rel, text);
    if (++n === 2) ac.abort();
    return r;
  };
  const out = await fetchEmail(EMAIL, s.deps(ac.signal));
  assert.equal(out.phase, "cancelled");
  assert.equal(out.written, 2);
  const seen = s.core.to("/kb/email/seen")[0]!.body as { messageIds: string[]; lastFetchedAt: string | null };
  assert.deepEqual(seen.messageIds, ["<m1@x>", "<m2@x>"]);
  assert.equal(seen.lastFetchedAt, null);
  assert.match(fetchMessage(out), /^Stopped\./);
});

test("email fetch: server errors are mapped and nothing is written or marked", async () => {
  for (const [status, body, code] of [[502, { error: { code: "EMAIL_AUTH_FAILED" } }, "upstream_auth"], [400, { error: { code: "VALIDATION_FAILED" } }, "validation"], [401, {}, "unauthorized"], [504, {}, "timeout"]] as const) {
    const s = setup([]);
    s.core.on("POST /kb/email/fetch", () => ({ status, body }));
    const out = await fetchEmail(EMAIL, s.deps());
    assert.deepEqual([out.phase, out.error], ["error", code]);
    assert.equal(s.core.to("/kb/email/seen").length, 0);
    assert.equal(s.fake.files.size, 0);
  }
  const s = setup([]);
  s.core.on("POST /kb/email/fetch", () => { throw Object.assign(new Error("x"), { code: "NETWORK" }); });
  assert.equal((await fetchEmail(EMAIL, s.deps())).error, "unavailable");
  // Server-side skips and the cap are surfaced.
  const t = setup([msg(1)], { oversize: 2, overCap: 5 });
  const o = await fetchEmail(EMAIL, t.deps());
  assert.deepEqual([o.skipped, o.more], [7, true]);
  // Nothing new: still records the (forward-only) mark.
  const e = setup([]);
  await fetchEmail(EMAIL, e.deps());
  assert.equal((e.core.to("/kb/email/seen")[0]!.body as { lastFetchedAt: string }).lastFetchedAt, "2026-10-31T00:00:00.000Z");
  const c = new FakeCore();
  c.on("POST /kb/email/seen", () => ({ status: 200, body: {} }));
  await startEmailFromNow(c, never, 0);
  assert.deepEqual(c.calls[0]!.body, { messageIds: [], lastFetchedAt: "1970-01-01T00:00:00.000Z" });
});

test("slack: one note per channel batch in transcript form, seen per channel with the last timestamp", async () => {
  const fake = new FakeHost();
  const write = new FakeWriteHost(fake);
  const core = new FakeCore();
  core.on("POST /kb/slack/fetch", (b) => ({ status: 200, body: { messages: (b as { channelId: string }).channelId === "C0000EMPTY" ? [] : [{ ts: "1790000100.000200", channelId: "C0123ABCD", user: "bob", text: "second\nline" }, { ts: "1790000000.000100", channelId: "C0123ABCD", user: "al*ice", text: "first" }, { ts: "bad" }], skipped: { overCap: 0 } } }));
  core.on("POST /kb/slack/seen", () => ({ status: 200, body: { ok: true } }));
  const out = await fetchSlack([{ id: "C0123ABCD", name: "general" }, { id: "C0000EMPTY", name: "quiet" }], 7, { core, write, signal: never, onProgress: () => {}, now: () => 0 });
  assert.deepEqual([out.phase, out.fetched, out.written], ["done", 2, 1]);
  const [rel, file] = [...fake.files.entries()][0]!;
  assert.match(rel, /^source\/slack\/2026\/\d\d\/2026-\d\d-\d\d-general-[0-9a-f]{8}\.md$/);
  const p = parseNote(file.text);
  assert.equal(p.data.platform, "slack");
  assert.equal(p.data.title, "#general");
  assert.match(p.body, /^\[\d\d:\d\d:\d\d\] \*\*alice\*\*: first\n\[\d\d:\d\d:\d\d\] \*\*bob\*\*: second\n  line\n$/);
  const seen = core.to("/kb/slack/seen");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.body, { channelId: "C0123ABCD", messageTs: ["1790000000.000100", "1790000100.000200"], lastTs: "1790000100.000200" });
  assert.equal(decodeSlack({ ts: "123.456", user: "u", text: "t" })?.ts, "123.456");
  assert.equal(decodeSlack({ ts: "../x" }), null);
  const rec = applyHead(recordFromEntry({ rel, size: 1, mtimeMs: 0, placeholder: false }), file.text);
  assert.equal(rec.sourceId, "slack");
  assert.ok((await planSlack({ id: "C0123ABCD", name: "" }, [{ ts: "1.1", user: "", text: "x" }], 0)).text.includes("title: '#C0123ABCD'"));
});

test("mcp connector: tolerant shaping, notes under source/<id>, ids marked seen, unknown ids refused before any request", async () => {
  assert.equal(isConnectorId("miro"), true);
  assert.equal(isConnectorId("../x"), false);
  assert.equal(isConnectorId("Miro"), false);
  const item = decodeMcpItem({ id: "miro:b1:i1", Title: "Sticky", Board: "Roadmap", ItemType: "sticky_note", Date: "2026-10-02T08:00:00Z", Link: "https://miro.com/x", text: "Ship it" })!;
  assert.equal(item.body, "Ship it");
  assert.equal(decodeMcpItem({ Title: "no id" }), null);
  const odd = decodeMcpItem({ ItemId: "z", weird: "value", nested: { a: 1 } })!;
  assert.equal(odd.body, "weird: value");
  const plan = await planMcp("miro", item, 0);
  assert.match(plan.rel, /^source\/miro\/2026\/10\/2026-10-02-sticky-[0-9a-f]{8}\.md$/);
  const p = parseNote(plan.text);
  assert.equal(p.data.source, "miro");
  assert.equal(p.data.platform, undefined, "no platform: it must not be filed as a meeting");
  assert.equal(p.data.board, "Roadmap");
  const fake = new FakeHost();
  const write = new FakeWriteHost(fake);
  const core = new FakeCore();
  core.on("POST /kb/mcp-connector/fetch", () => ({ status: 200, body: { items: [{ id: "a", Title: "A", text: "x" }, { id: "b", Title: "B", text: "y" }], drained: false, skipped: { overCap: 0 }, failures: [{ id: "c" }] } }));
  core.on("POST /kb/mcp-connector/seen", () => ({ status: 200, body: { ok: true, marked: 2 } }));
  const out = await fetchMcp("miro", { core, write, signal: never, onProgress: () => {}, now: () => 0 });
  assert.deepEqual([out.phase, out.written, out.more, out.skipped], ["done", 2, true, 1]);
  assert.deepEqual(core.to("/kb/mcp-connector/seen")[0]!.body, { id: "miro", itemIds: ["a", "b"] });
  const bad = await fetchMcp("../etc", { core, write, signal: never, onProgress: () => {}, now: () => 0 });
  assert.equal(bad.error, "validation");
  assert.equal(core.to("/kb/mcp-connector/fetch").length, 1);
  core.on("POST /kb/mcp-connector/fetch", () => ({ status: 502, body: { error: { code: "MCP_UNAUTHORIZED" } } }));
  assert.equal((await fetchMcp("miro", { core, write, signal: never, onProgress: () => {}, now: () => 0 })).error, "upstream_auth");
  assert.equal(IDLE_FETCH.phase, "idle");
});

import { addRepo, decodeOAuthStart, decodeOAuthStatus, googleStart, indexBox, indexGithubIssues, indexRepo, listCatalog, listRepos, mcpStart, mcpStatus, mcpTest, pollUntil, removeRepo, selectConnector, slackConversations, slackStart, testBox, testEmail, testSlack } from "../sources/source-actions.ts";

test("polling: returns the first non-null, times out, cancels, and never busy-loops", async () => {
  let t = 0;
  const sleeps: number[] = [];
  const base = { intervalMs: 1000, maxMs: 5000, signal: never, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
  let n = 0;
  assert.equal(await pollUntil(async () => (++n === 3 ? "done" : null), base), "done");
  assert.deepEqual(sleeps, [1000, 1000]);
  await assert.rejects(pollUntil(async () => null, { ...base, now: () => t }), (e: SourceError) => e.code === "timeout");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(pollUntil(async () => "x", { ...base, signal: ac.signal }), (e: SourceError) => e.code === "cancelled");
  assert.deepEqual(decodeOAuthStatus({ status: "complete", email: "a@b.c" }), { status: "complete", account: "a@b.c" });
  assert.deepEqual(decodeOAuthStatus({ status: "weird" }), { status: "unknown", account: null });
  assert.throws(() => decodeOAuthStart({}), SourceError);
});

test("actions: shapes sent to the core, defensive decoding, secrets only where documented", async () => {
  const core = new FakeCore();
  const ok = (b: unknown) => () => ({ status: 200, body: b });
  core.on("POST /kb/email/test", ok({ ok: true, mailbox: "INBOX", total: 10, recent: 2 }));
  core.on("POST /kb/slack/test", ok({ ok: true, team: "Acme", user: "bot" }));
  core.on("POST /auth/slack/start", ok({ authUrl: "https://slack.com/oauth", state: "s1" }));
  core.on("POST /auth/google/start", ok({ authUrl: "https://accounts.google.com/x", state: "g1" }));
  core.on("GET /kb/slack/conversations", ok({ channels: [{ id: "C0123ABCD", name: "general" }, { name: "no id" }, 7], complete: false }));
  core.on("POST /kb/box/test", ok({ ok: true, folderName: "Specs", itemCount: 12 }));
  core.on("POST /kb/connect-box", ok({ ok: true, indexed: 40, files: 9, skipped: 1, truncated: true }));
  core.on("GET /auth/me/repos", ok({ repos: [{ path: "/Users/x/proj", label: "Proj" }, { nopath: 1 }] }));
  core.on("POST /auth/me/repos", ok({ ok: true, path: "/Users/x/proj" }));
  core.on("DELETE /auth/me/repos?path=%2FUsers%2Fx%2Fproj", ok({ ok: true }));
  core.on("POST /kb/connect-git", ok({ ok: true, files: 3, chunks: 9, name: "ignored" }));
  core.on("POST /kb/connect-github-issues", ok({ ok: true, indexed: 4 }));
  core.on("GET /auth/me/connectors/catalog", ok({ catalog: [{ id: "miro", name: "Miro", description: "Boards", authKind: "miro-oauth", docsUrl: "https://miro.com", pipelineReady: true, selected: true }, { id: "../x", name: "bad" }, { id: "gdrive", docsUrl: "javascript:alert(1)", selected: false }] }));
  core.on("POST /auth/me/connectors/add", ok({ ok: true }));
  core.on("DELETE /auth/me/connectors/miro", ok({ ok: true }));
  core.on("POST /auth/mcp-connector/start", ok({ authUrl: "https://mcp.miro.com/a", state: "m1" }));
  core.on("GET /auth/mcp-connector/status?id=miro&state=m1", ok({ connected: true, status: "complete" }));
  core.on("POST /kb/mcp-connector/test", ok({ ok: true, server: "miro", tools: ["list_boards", { name: "get_board_items" }, 5] }));
  const E = { ...DEFAULT_EMAIL, user: "me@example.com" };
  assert.deepEqual(await testEmail(core, E, "typed-pass", never), { mailbox: "INBOX", total: 10, recent: 2 });
  await testEmail(core, E, null, never);
  assert.equal((core.to("/kb/email/test")[0]!.body as { password?: string }).password, "typed-pass");
  assert.ok(!("password" in (core.to("/kb/email/test")[1]!.body as object)), "a saved password is never sent from the page");
  assert.deepEqual(await testSlack(core, null, never), { team: "Acme", user: "bot" });
  assert.deepEqual(core.to("/kb/slack/test")[0]!.body, {});
  assert.equal((await slackStart(core, never)).state, "s1");
  assert.equal((await googleStart(core, null, never)).state, "g1");
  await googleStart(core, { clientId: "id", clientSecret: "sec" }, never);
  assert.deepEqual(core.to("/auth/google/start")[1]!.body, { clientId: "id", clientSecret: "sec" });
  assert.deepEqual(await slackConversations(core, never), { channels: [{ id: "C0123ABCD", name: "general" }], complete: false });
  const B = { ...DEFAULT_BOX, clientId: "abc123XYZ", subjectId: "9" };
  assert.deepEqual(await testBox(core, B, never), { folderName: "Specs", itemCount: 12 });
  assert.deepEqual(core.to("/kb/box/test")[0]!.body, { clientId: "abc123XYZ", subjectType: "enterprise", subjectId: "9", folderId: "0" }, "no secret in the request");
  assert.deepEqual(await indexBox(core, B, never), { indexed: 40, files: 9, skipped: 1, truncated: true });
  assert.deepEqual(await listRepos(core, never), [{ path: "/Users/x/proj", label: "Proj" }]);
  assert.equal(await addRepo(core, "/Users/x/proj", null, never), "/Users/x/proj");
  await removeRepo(core, "/Users/x/proj", never);
  assert.deepEqual((await indexRepo(core, "/Users/x/proj", never)).counts, { files: 3, chunks: 9 });
  assert.deepEqual((await indexGithubIssues(core, { repo: "acme/web", state: "open" }, never)).counts, { indexed: 4 });
  const cat = await listCatalog(core, never);
  assert.deepEqual(cat.map((c) => c.id), ["miro", "gdrive"]);
  assert.equal(cat[1]!.docsUrl, null, "a non-https docs link is dropped");
  await selectConnector(core, "miro", true, never);
  await selectConnector(core, "miro", false, never);
  await assert.rejects(selectConnector(core, "../x", true, never), (e: SourceError) => e.code === "validation");
  assert.deepEqual(await mcpStart(core, "miro", never), { authUrl: "https://mcp.miro.com/a", state: "m1", alreadyConnected: false });
  assert.deepEqual(await mcpStatus(core, "miro", "m1", never), { connected: true, status: "complete" });
  assert.deepEqual(await mcpTest(core, "miro", never), { server: "miro", tools: ["list_boards", "get_board_items"] });
});
