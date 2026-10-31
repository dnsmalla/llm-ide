import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourcesCore } from "../sources/source-core.ts";
import { GoogleError, googleErrorText } from "../sources/google/google-core.ts";
import { decodeIcalStatus, decodeIcalSync, icalApiFrom, icalCardState, icalPrefix, icalSyncMessage, mapIcalFailure, validateIcalUrl } from "../sources/google/ical-api.ts";
import { appPasswordProblem, classifyDriveFolder, driveCardState, driveFolderLabel, driveFolders, isGoogleAccountHome, normalizeAppPassword, validateGmailAddress } from "../sources/google/easy.ts";
import { FakeIcal } from "./fake-ical.ts";

const never = new AbortController().signal;
const GOOD = "https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics";

test("ical url: the real shape passes and only a short id prefix is derived; the secret part is not in it", () => {
  const r = validateIcalUrl(GOOD);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.kind, "private");
  assert.equal(r.calendarIdPrefix, "me@g…");
  assert.ok(!r.calendarIdPrefix.includes("0123456789"));
  assert.equal(r.url, GOOD);
  const pub = validateIcalUrl("https://calendar.google.com/calendar/ical/en.japanese%23holiday%40group.v.calendar.google.com/public/basic.ics");
  assert.ok(pub.ok && pub.kind === "public");
  assert.ok(validateIcalUrl(`  ${GOOD}  `).ok, "surrounding whitespace is trimmed");
  assert.equal(icalPrefix("ab"), "ab…");
  assert.equal(icalPrefix("abcdefgh"), "abcd…");
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
    ["webcal", GOOD.replace("https:", "webcal:")],
  ];
  for (const [what, u] of bad) {
    const r = validateIcalUrl(u);
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

test("ical routes: the address is sent only in connect, an invalid one never leaves, 404 means core update, codes map to plain words", async () => {
  const core = new FakeCore();
  const api = icalApiFrom(core);
  core.reply = { status: 200, body: { ok: true, calendarIdPrefix: "me@g…" } };
  assert.deepEqual(await api.connect(GOOD, never), { calendarIdPrefix: "me@g…" });
  assert.deepEqual(core.calls[0], { method: "POST", path: "/kb/calendar-ical/connect", body: { url: GOOD } });
  core.reply = { status: 200, body: { connected: true, calendarIdPrefix: "me@g…", lastSyncAt: "2026-10-31T00:00:00Z", events: 5 } };
  const st = await api.status(never);
  assert.deepEqual([st.connected, st.calendarIdPrefix, st.events], [true, "me@g…", 5]);
  core.reply = { status: 200, body: { events: 3, removed: 1, pending: true } };
  assert.equal(icalSyncMessage(await api.sync(never)), "3 events read; removed 1 cancelled; more is left: sync again.");
  await api.disconnect(never);
  for (const c of core.calls.filter((x) => x.path !== "/kb/calendar-ical/connect")) assert.ok(!JSON.stringify(c).includes("private-"), "no later call carries the address");
  const n = core.calls.length;
  await assert.rejects(api.connect("https://evil.example/basic.ics", never), (e: unknown) => e instanceof GoogleError && e.code === "bad_url");
  assert.equal(core.calls.length, n, "an invalid address never reaches the core");
  core.reply = { status: 404, body: {} };
  await assert.rejects(api.status(never), (e: unknown) => e instanceof GoogleError && e.code === "core_update");
  core.reply = { status: 404, body: { error: { code: "NOT_FOUND", message: "no route" } } };
  await assert.rejects(api.sync(never), (e: unknown) => e instanceof GoogleError && e.code === "core_update");
  for (const [status, code, want] of [[400, "ICAL_BAD_URL", "bad_url"], [502, "ICAL_FETCH_FAILED", "upstream"], [502, "ICAL_BAD_FEED", "bad_response"], [409, "ICAL_NOT_CONNECTED", "not_found"], [429, "GOOGLE_RATE_LIMITED", "rate_limited"], [401, "", "unauthorized"], [500, "", "failed"]] as const) {
    assert.equal(mapIcalFailure(status, code ? { error: { code, message: "SECRET-xyz" } } : {}).code, want, `${status} ${code}`);
  }
  assert.ok(!mapIcalFailure(502, { error: { code: "ICAL_FETCH_FAILED", message: "SECRET-xyz" } }).message.includes("xyz"));
  assert.match(googleErrorText("core_update"), /Available after the core update/);
  assert.throws(() => decodeIcalStatus("x"), GoogleError);
  assert.deepEqual(decodeIcalSync({ events: -4, removed: "x", pending: 1 }), { events: 0, removed: 0, pending: false });
});

test("ical card state machine with the fake connector", async () => {
  assert.equal(icalCardState(null, null), "loading");
  assert.equal(icalCardState(null, new GoogleError("core_update")), "unavailable");
  assert.equal(icalCardState(null, new GoogleError("upstream")), "error");
  const f = new FakeIcal();
  assert.equal(icalCardState(await f.status(), null), "not_connected");
  await f.connect(GOOD);
  assert.equal(icalCardState(await f.status(), null), "connected");
  await f.sync();
  assert.equal((await f.status()).events, 12);
  await f.disconnect();
  assert.equal(icalCardState(await f.status(), null), "not_connected");
  f.missing = true;
  await assert.rejects(f.status(), (e: unknown) => e instanceof GoogleError && e.code === "core_update");
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
