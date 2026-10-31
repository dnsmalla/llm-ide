import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourcesCore } from "../sources/source-core.ts";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "../sources/google/ical-api.ts";
import { appPasswordProblem, classifyDriveFolder, driveCardState, driveFolderLabel, driveFolders, isGoogleAccountHome, normalizeAppPassword, validateGmailAddress } from "../sources/google/easy.ts";
import { FakeIcal } from "./fake-ical.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../../../../schema/http/fixtures/calendar-ical");
const never = new AbortController().signal;
const GOOD = "https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics";

test("ical url: the real shape passes and only a short id prefix is derived; the secret part is not in it", () => {
  const r = A.validateIcalUrl(GOOD);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.kind, "private");
  assert.equal(r.url, GOOD);
  const pub = A.validateIcalUrl("https://calendar.google.com/calendar/ical/en.japanese%23holiday%40group.v.calendar.google.com/public/basic.ics");
  assert.ok(pub.ok && pub.kind === "public");
  assert.ok(A.validateIcalUrl(`  ${GOOD}  `).ok, "surrounding whitespace is trimmed");
  const web = A.validateIcalUrl(GOOD.replace("https:", "webcal:"));
  assert.ok(web.ok && web.url === GOOD, "webcal:// is read as https");
  assert.ok(A.validateIcalUrl(GOOD.replace("private-0123456789abcdef0123456789abcdef", "private")).ok, "the bare private form the core accepts");
});

test("ical url: hostile or malformed addresses are refused with words", () => {
  const bad: [string, string][] = [
    ["empty", ""],
    ["http", GOOD.replace("https:", "http:")],
    ["other host", GOOD.replace("calendar.google.com", "calendar.google.com.evil.example")],
    ["userinfo", GOOD.replace("https://", "https://calendar.google.com@evil.example/#")],
    ["userinfo2", GOOD.replace("https://calendar.google.com", "https://u:p@calendar.google.com")],
    ["port", GOOD.replace("calendar.google.com", "calendar.google.com:8443")],
    ["query", `${GOOD}?x=1`],
    ["fragment", `${GOOD}#x`],
    ["no basic.ics", GOOD.replace("basic.ics", "basic.txt")],
    ["extra segment", GOOD.replace("/basic.ics", "/x/basic.ics")],
    ["not private token", GOOD.replace("private-0123456789abcdef0123456789abcdef", "secret")],
    ["short token", GOOD.replace("private-0123456789abcdef0123456789abcdef", "private-abc")],
    ["token chars", GOOD.replace("0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abc%2e")],
    ["wrong path", GOOD.replace("/calendar/ical/", "/calendar/embed/")],
    ["traversal", GOOD.replace("me%40gmail.com", "..")],
    ["space", GOOD.replace("basic", "ba sic")],
    ["newline", `${GOOD}\nhttps://evil.example`],
    ["backslash", GOOD.replace("/ical/", "\\ical\\")],
    ["unicode", GOOD.replace("calendar", "calend\u0430r")],
    ["too long", `${GOOD}${"a".repeat(700)}`],
    ["javascript", "javascript:alert(1)"],
    ["webcal other host", GOOD.replace("https://calendar.google.com", "webcal://evil.example")],
  ];
  for (const [what, u] of bad) {
    const r = A.validateIcalUrl(u);
    assert.equal(r.ok, false, what);
    if (!r.ok) assert.ok(r.problem.length > 10, what);
  }
});

class FakeCore implements SourcesCore {
  calls: { method: string; path: string; body: unknown }[] = [];
  reply: { status: number; body: unknown } = { status: 200, body: {} };
  async call(method: "GET" | "POST" | "DELETE", path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    this.calls.push({ method, path, body });
    return this.reply;
  }
}

interface Fx {
  endpoint: string;
  status: number;
  request?: { body?: unknown; params?: { id?: string } };
  response: unknown;
}
const fixtures: [string, Fx][] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => [f, JSON.parse(readFileSync(resolve(FIXTURES, f), "utf8")) as Fx]);

test("fixtures: the directory is the one this suite expects (28 recorded answers)", () => {
  assert.equal(fixtures.length, 28);
});

test("fixtures: EVERY recorded answer decodes with its typed decoder; every error maps to wording and none carries the server message", () => {
  const seen = new Set<string>();
  for (const [name, f] of fixtures) {
    if (f.status >= 400) {
      const e = A.mapIcalFailure(f.status, f.response);
      const code = (f.response as { error: { code: string; message: string } }).error.code;
      seen.add(code);
      assert.equal(e.serverCode, code, name);
      assert.notEqual(e.code, "failed", `${name}: a known code is not generic`);
      assert.notEqual(e.code, "core_update", `${name}: a coded 404 is not a missing route`);
      const line = A.icalErrorLine(e);
      assert.ok(line.length > 20 && !line.includes((f.response as { error: { message: string } }).error.message), name);
      continue;
    }
    switch (f.endpoint) {
      case "GET /kb/calendar-ical/sources": {
        const feeds = A.decodeFeeds(f.response);
        assert.equal(feeds.length, (f.response as { sources: unknown[] }).sources.length, name);
        for (const x of feeds) assert.match(x.sourceId, /^[0-9a-f]{12}$/);
        break;
      }
      case "POST /kb/calendar-ical/sources": {
        const a = A.decodeAdded(f.response);
        assert.deepEqual(Object.keys(a).sort(), ["calendarIdPrefix", "host", "name", "sourceId"], "only the label comes back");
        assert.ok(!JSON.stringify(a).includes("private-"), name);
        break;
      }
      case "POST /kb/calendar-ical/sync":
        assert.ok(["ok", "unchanged", "not_modified"].includes(A.decodeSync(f.response).status), name);
        assert.ok(A.syncMessage(A.decodeSync(f.response)).length > 20, name);
        break;
      case "POST /kb/calendar-ical/options": {
        const o = A.decodeOptionsReply(f.response);
        assert.ok(o.daysBack <= 365 && o.daysAhead <= 730, name);
        break;
      }
      case "DELETE /kb/calendar-ical/sources/:id":
        assert.equal(A.decodeDeleted(f.response).purgedSources, 14, name);
        break;
      default:
        assert.fail(`unhandled endpoint ${f.endpoint} in ${name}`);
    }
  }
  // Every server error code the spec lists (other than INTERNAL, which no fixture can provoke) was seen and mapped.
  for (const c of ["VALIDATION_FAILED", "ICAL_URL_INVALID", "ICAL_HOST_NOT_ALLOWED", "ICAL_NOT_FOUND", "ICAL_DUPLICATE", "ICAL_TOO_MANY_SOURCES", "ICAL_SYNC_RUNNING", "ICAL_FEED_REVOKED", "ICAL_RATE_LIMITED", "ICAL_FETCH_FAILED", "ICAL_TOO_LARGE", "ICAL_PARSE_FAILED"]) assert.ok(seen.has(c), `fixture for ${c}`);
  assert.equal(A.mapIcalFailure(500, { error: { code: "INTERNAL", message: "x" } }).code, "internal");
  // Fixture requests are valid for the client's own checks except the ones that deliberately probe the server.
  const add = fixtures.find(([n]) => n === "post-kb-calendar-ical-sources-200.json")![1];
  const body = add.request!.body as { name: string; url: string };
  assert.ok(A.validateIcalUrl(body.url).ok);
});

test("error mapper: 404 on the whole route means the core update, text never includes server words, wording per code", () => {
  assert.equal(A.mapIcalFailure(404, {}).code, "core_update");
  assert.equal(A.mapIcalFailure(404, { error: { code: "NOT_FOUND", message: "no route" } }).code, "core_update");
  assert.equal(A.mapIcalFailure(404, { error: { code: "ICAL_NOT_FOUND", message: "x" } }).code, "not_found");
  assert.match(A.icalErrorText("core_update"), /Available after the core update/);
  assert.match(A.icalErrorText("host_not_allowed"), /Only calendar\.google\.com is accepted unless the core's operator allows more/);
  assert.match(A.icalErrorText("revoked"), /Google no longer accepts this address: reset it in Calendar settings and add the new one/);
  assert.match(A.icalErrorText("revoked"), /already indexed is kept/);
  for (const [status, want] of [[401, "unauthorized"], [429, "rate_limited"], [504, "timeout"], [400, "validation"], [503, "fetch_failed"], [500, "failed"]] as const) assert.equal(A.mapIcalFailure(status, { error: { code: "WHAT", message: "SECRET-xyz" } }).code, want, String(status));
  const all: A.IcalErrorCode[] = ["validation", "url_invalid", "host_not_allowed", "not_found", "duplicate", "too_many", "sync_running", "revoked", "rate_limited", "fetch_failed", "too_large", "parse_failed", "core_update", "internal", "unauthorized", "timeout", "unavailable", "bad_response", "cancelled", "failed"];
  const texts = new Set(all.map((c) => A.icalErrorText(c)));
  assert.equal(texts.size, all.length, "every code has its own words");
  assert.equal(A.mapIcalThrown({ code: "TIMEOUT" }).code, "timeout");
  assert.equal(A.mapIcalThrown(new Error("boom https://calendar.google.com/calendar/ical/x/private-AAAAAAAAAAAAAAAAAAAA/basic.ics")).code, "unavailable");
  assert.equal(A.lastErrorText("ICAL_FEED_REVOKED"), A.icalErrorText("revoked"));
  assert.match(A.lastErrorText("<script>")!, /Sync again/);
});

test("warning codes map to plain text; unknown codes get a generic line, never the raw code", () => {
  for (const c of ["oversized_property", "malformed_line", "nested_vcalendar", "tz_unknown", "floating", "recurrence_range_ignored", "rrule_subdaily", "rrule_unsupported", "rrule_invalid"]) assert.ok(A.warningText(c).length > 20 && !A.warningText(c).includes("_"), c);
  assert.ok(!A.warningText("<img onerror=x>").includes("<img"));
});

test("sync message: counts, not_modified, unchanged and the truncated notice", () => {
  const base = { sourceId: "0123456789ab", status: "ok" as const, events: 6, instances: 12, cancelled: 3, removed: 1, truncated: false, warnings: [] };
  assert.equal(A.syncMessage(base), "6 events read, 12 occurrences indexed in the core, 3 cancelled, 1 removed.");
  assert.match(A.syncMessage({ ...base, status: "not_modified" }), /has not changed/);
  assert.match(A.syncMessage({ ...base, status: "unchanged" }), /identical/);
  assert.match(A.syncMessage({ ...base, truncated: true }), /only part of it was indexed and nothing was removed/);
});

test("routes: the address is sent only in add; invalid input never leaves; options and ids are checked; secrets never in later calls", async () => {
  const core = new FakeCore();
  const api = A.icalApiFrom(core);
  core.reply = { status: 200, body: { sourceId: "0123456789ab", name: "Team", nameOnly: true, calendarIdPrefix: "me@gmai", host: "calendar.google.com" } };
  const added = await api.add("  Team ‮ ", `  ${GOOD} `, never);
  assert.deepEqual(core.calls[0], { method: "POST", path: "/kb/calendar-ical/sources", body: { name: "Team", url: GOOD } });
  assert.equal(added.sourceId, "0123456789ab");
  core.reply = { status: 200, body: { sources: [] } };
  assert.deepEqual(await api.list(never), []);
  core.reply = { status: 200, body: { sourceId: "0123456789ab", status: "ok", events: 1, instances: 2, cancelled: 0, removed: 0, truncated: true, warnings: ["tz_unknown"] } };
  assert.equal((await api.sync("0123456789ab", never)).truncated, true);
  core.reply = { status: 200, body: { ok: true, options: { daysBack: 5, daysAhead: 7 } } };
  assert.deepEqual(await api.setOptions("0123456789ab", { daysBack: 5, daysAhead: 7 }, never), { daysBack: 5, daysAhead: 7 });
  core.reply = { status: 200, body: { ok: true, purgedSources: 3 } };
  assert.deepEqual(await api.remove("0123456789ab", never), { purgedSources: 3 });
  assert.deepEqual(core.calls.map((c) => `${c.method} ${c.path}`), ["POST /kb/calendar-ical/sources", "GET /kb/calendar-ical/sources", "POST /kb/calendar-ical/sync", "POST /kb/calendar-ical/options", "DELETE /kb/calendar-ical/sources/0123456789ab"]);
  assert.deepEqual(core.calls[3]!.body, { sourceId: "0123456789ab", options: { daysBack: 5, daysAhead: 7 } });
  for (const c of core.calls.slice(1)) assert.ok(!JSON.stringify(c).includes("private-"), "no later call carries the address");
  const n = core.calls.length;
  await assert.rejects(api.add("x", "https://evil.example/basic.ics", never), (e: unknown) => e instanceof A.IcalError && e.code === "validation");
  await assert.rejects(api.add("   ", GOOD, never), (e: unknown) => e instanceof A.IcalError && e.code === "validation");
  await assert.rejects(api.sync("../x", never), (e: unknown) => e instanceof A.IcalError && e.code === "bad_response");
  await assert.rejects(api.remove("x/../y", never), (e: unknown) => e instanceof A.IcalError);
  await assert.rejects(api.setOptions("0123456789ab", { daysBack: 9999, daysAhead: 1 }, never), (e: unknown) => e instanceof A.IcalError && e.code === "validation");
  assert.equal(core.calls.length, n, "nothing invalid reaches the core");
  core.reply = { status: 404, body: {} };
  await assert.rejects(api.list(never), (e: unknown) => e instanceof A.IcalError && e.code === "core_update");
});

test("name and window validation", () => {
  assert.deepEqual(A.validateFeedName("  a\u0000b ‮ c​ "), { ok: true, name: "ab c" });
  assert.equal(A.validateFeedName("‮​ ").ok, false);
  assert.equal(A.validateFeedName("x".repeat(101)).ok, false);
  assert.equal(A.validateFeedName("x".repeat(100)).ok, true);
  assert.deepEqual(A.validateOptions("0", "730"), { ok: true, options: { daysBack: 0, daysAhead: 730 } });
  for (const [b, a] of [["366", "1"], ["1", "731"], ["-1", "1"], ["1.5", "1"], ["", "1"], ["1e2", "1"], ["abc", "1"], ["1", "99999"]]) assert.equal(A.validateOptions(b!, a!).ok, false, `${b}/${a}`);
});

test("hostile answers: bidi/control names are cleaned, huge lists cut, bad rows dropped, unknown status is error, options clamped", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ sourceId: i === 0 ? "zz" : (i + 0x1000).toString(16).padStart(12, "0").slice(-12), name: `n‮${i}\u0000`, calendarIdPrefix: "a b\n", host: "h".repeat(999), status: "weird", lastRunAt: 5, lastError: { x: 1 }, options: { daysBack: 1e9, daysAhead: -5 } }));
  const feeds = A.decodeFeeds({ sources: rows });
  assert.ok(feeds.length <= 100 && feeds.length >= 90);
  const f = feeds[0]!;
  assert.equal(f.name.includes("‮"), false);
  assert.equal(f.name.includes("\u0000"), false);
  assert.equal(f.status, "error");
  assert.equal(f.host.length, 253);
  assert.equal(f.calendarIdPrefix, "ab");
  assert.deepEqual(f.options, { daysBack: 365, daysAhead: 0 });
  assert.equal(f.lastRunAt, null);
  assert.equal(f.lastError, null);
  assert.equal(A.decodeFeeds({ sources: [{ sourceId: "0123456789ab", name: "‮" }] })[0]!.name, "(unnamed)");
  for (const bad of [null, "x", [], { sources: "x" }, { sources: {} }]) assert.throws(() => A.decodeFeeds(bad), A.IcalError);
  assert.throws(() => A.decodeAdded({ sourceId: "0123456789ab", name: "n", nameOnly: false }), A.IcalError);
  assert.throws(() => A.decodeSync({ sourceId: "0123456789ab", status: "weird" }), A.IcalError);
  const s = A.decodeSync({ sourceId: "0123456789ab", status: "ok", events: -4, instances: "x", cancelled: 1e30, removed: 2.9, truncated: 1, warnings: ["a", "a", 5, "b".repeat(100), ...Array.from({ length: 100 }, (_, i) => `w${i}`)] });
  assert.deepEqual([s.events, s.instances, s.cancelled, s.removed, s.truncated], [0, 0, 1e9, 2, false]);
  assert.ok(s.warnings.length <= 20 && s.warnings.every((w) => w.length <= 40));
  assert.throws(() => A.decodeDeleted({ ok: false }), A.IcalError);
});

test("the fake connector: cap of 10, duplicates, 404 is the core update, sync results and errors flip the status", async () => {
  const f = new FakeIcal();
  assert.deepEqual(await f.list(), []);
  for (let i = 0; i < A.MAX_FEEDS; i++) await f.add(`c${i}`, `${GOOD}#${i}`);
  await assert.rejects(f.add("one more", `${GOOD}#x`), (e: unknown) => e instanceof A.IcalError && e.code === "too_many");
  const id = (await f.list())[0]!.sourceId;
  f.syncs.push(new A.IcalError("revoked", "ICAL_FEED_REVOKED"));
  await assert.rejects(f.sync(id), (e: unknown) => e instanceof A.IcalError && e.code === "revoked");
  assert.equal((await f.list())[0]!.status, "revoked");
  await f.sync(id);
  assert.equal((await f.list())[0]!.status, "idle");
  await f.remove(id);
  assert.equal((await f.list()).length, A.MAX_FEEDS - 1);
  f.missing = true;
  await assert.rejects(f.list(), (e: unknown) => e instanceof A.IcalError && e.code === "core_update");
});

test("gmail easy card checks: address, app password shape, account page host", () => {
  assert.equal(validateGmailAddress("me@gmail.com"), null);
  assert.equal(validateGmailAddress("me@googlemail.com"), null);
  assert.ok(validateGmailAddress(""));
  assert.ok(validateGmailAddress("not an address"));
  assert.match(validateGmailAddress("me@company.example")!, /work or school address/);
  assert.equal(appPasswordProblem(""), null);
  assert.equal(appPasswordProblem("abcd efgh ijkl mnop"), null);
  assert.ok(appPasswordProblem("short"));
  assert.ok(appPasswordProblem("abcd efgh ijkl mno1"));
  assert.equal(normalizeAppPassword(" abcd efgh\tijkl\nmnop "), "abcdefghijklmnop");
  assert.equal(isGoogleAccountHome("https://myaccount.google.com/"), true);
  for (const u of ["http://myaccount.google.com/", "https://myaccount.google.com.evil.example/", "https://evil.example/", "https://u@myaccount.google.com/", "https://myaccount.google.com:444/", "javascript:1", "not a url"]) assert.equal(isGoogleAccountHome(u), false, u);
});

test("drive folder: Drive for desktop paths are recognised, broad or odd ones refused, others need confirmation", () => {
  const mac = "/Users/me/Library/CloudStorage/GoogleDrive-me@gmail.com/My Drive";
  assert.equal(classifyDriveFolder(mac), "drive_for_desktop");
  assert.equal(classifyDriveFolder(`${mac}/`), "drive_for_desktop");
  assert.equal(classifyDriveFolder("/Users/me/Library/CloudStorage/GoogleDrive-me@gmail.com"), "drive_for_desktop");
  assert.equal(classifyDriveFolder("/Users/me/Google Drive/Projects"), "drive_for_desktop");
  assert.equal(classifyDriveFolder("/Users/me/Documents/stuff"), "other");
  for (const bad of ["", "relative/path", "/Users/me", "/Users/me/", "/Users", "/home/me", "C:\\", "/a/../etc", "../x"]) assert.equal(classifyDriveFolder(bad), "refused", bad);
  assert.equal(driveFolderLabel(mac), "Google Drive (me@gmail.com) / My Drive");
  assert.equal(driveFolderLabel("/Users/me/Documents/stuff"), "stuff");
  assert.equal(driveCardState(null, false, false), "no_picker");
  assert.equal(driveCardState(null, true, false), "no_folder");
  assert.equal(driveCardState({ path: "/Users/me" }, true, false), "refused");
  assert.equal(driveCardState({ path: "/Users/me/Documents/stuff" }, true, false), "needs_confirm");
  assert.equal(driveCardState({ path: "/Users/me/Documents/stuff" }, true, true), "ready");
  assert.equal(driveCardState({ path: mac }, true, false), "ready");
  assert.deepEqual(driveFolders([{ path: mac }, { path: "/Users/me/code/app" }]).map((r) => r.path), [mac]);
});
