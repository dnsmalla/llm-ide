process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeHost } from "./fake-host.ts";
import { FakeWriteHost } from "./fake-write-host.ts";
import { WriteError } from "../write/write-host.ts";
import type { SourcesCore } from "../sources/source-core.ts";
import {
  decodeAccounts, decodeCalendars, decodeDisconnect, decodeFolders, decodeGmailFetch, decodeOptionsResult, decodeSeen, decodeStart, decodeStatus, decodeSync, connectFailureCode, googleErrorText, GoogleError, lastErrorText, mapGoogleFailure, mapGoogleThrown,
  googleStart, googleDriveFolders, googleGmailFetch, PRODUCTS, type GoogleErrorCode,
} from "../sources/google/google-core.ts";
import { validateAuthUrl } from "../sources/google/auth-url.ts";
import {
  chosenProducts, describeOutcome, EMPTY_FORM, FLOW_MAX_MS, POLL_FIRST_MS, POLL_MAX_FAILURES, POLL_MAX_MS, reduceConnect, runConnect, setupState, validateConnectForm, type ConnectForm, type ConnectPhase,
} from "../sources/google/connect-flow.ts";
import { applyTombstone, checkNote, gmailMessage, IDLE_GMAIL, MAX_FAILED_SHOWN, NOTE_FILE_RE, runGmailSync, writeThread, type GmailProgress } from "../sources/google/gmail-sync.ts";
import { addPass, cooldownUntil, idleSync, runProductSync, syncMessage, type SyncProgress } from "../sources/google/product-sync.ts";
import { driveContentNote, optionsPayload, parseLabelList, readCalendarOptions, readDriveOptions, readGmailOptions, validateCalendarOptions, validateDriveOptions, validateGmailOptions } from "../sources/google/options.ts";
import { SCOPE_GROUPS } from "../sources/google/guide.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../../../../schema/http/fixtures/google");
interface Fixture {
  endpoint: string;
  status: number;
  request?: { body?: Record<string, unknown>; query?: Record<string, unknown> };
  response: unknown;
}
const fixtures: [string, Fixture][] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => [f, JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as Fixture]);
const fx = (name: string): Fixture => {
  const f = fixtures.find(([n]) => n === `${name}.json`);
  if (!f) throw new Error(`missing fixture ${name}`);
  return f[1];
};

const never = new AbortController().signal;
const ACCT = "0123456789ab";

// ---- fixtures -------------------------------------------------------------------------------------

test("fixtures: the directory is the one this suite expects (40 recorded answers)", () => {
  assert.equal(fixtures.length, 40);
});

test("fixtures: EVERY recorded answer decodes with its typed decoder, and every error maps to a non-generic code with words", () => {
  const seenCodes = new Set<string>();
  for (const [name, f] of fixtures) {
    if (f.status >= 400) {
      const e = mapGoogleFailure(f.status, f.response);
      assert.notEqual(e.code, "failed", `${name}: ${e.serverCode} must have its own wording`);
      assert.ok(e.serverCode, `${name}: carries the server code`);
      seenCodes.add(e.serverCode!);
      const text = googleErrorText(e.code);
      assert.ok(text.length > 20, name);
      const msg = (f.response as { error: { message: string } }).error.message;
      assert.notEqual(text, msg, `${name}: the server's message is not what is shown`);
      continue;
    }
    const r = f.response;
    switch (f.endpoint) {
      case "POST /kb/google/start": {
        const d = decodeStart(r);
        assert.match(d.authUrl, /^https:\/\/accounts\.google\.com\//, name);
        assert.ok(d.scopes.length >= 2 && d.scopes.every((s) => s.scope !== ""), name);
        assert.equal(d.redirectPort, 54321);
        assert.equal(d.expiresInSec, 300);
        // The "legacy-revoked" fixture records legacyMailTokenRevoked:false (the recorded run had no legacy token); only the type is asserted.
        assert.equal(typeof d.legacyMailTokenRevoked, "boolean");
        break;
      }
      case "GET /kb/google/status": {
        const d = decodeStatus(r);
        const want = (r as { status: string }).status;
        assert.equal(d.status, want, name);
        if (d.status === "complete") {
          assert.equal(d.accountId, ACCT);
          assert.deepEqual(d.products, ["gmail", "gcal"]);
          assert.equal(d.missingScopes.length, 0);
        }
        if (d.status === "error") assert.equal(d.message, "Replaced by a newer connect attempt.");
        break;
      }
      case "GET /kb/google/accounts": {
        const d = decodeAccounts(r);
        if (name.includes("legacy")) {
          assert.equal(d.accounts.length, 0);
          assert.equal(d.legacyMailToken, true);
        } else {
          assert.equal(d.accounts.length, 1, name);
          const a = d.accounts[0]!;
          assert.equal(a.accountId, ACCT);
          assert.equal(a.email, "me@example.com");
          for (const p of a.products) assert.ok(a.connectors[p], `${name}: ${p} has a status`);
          if (name.includes("reconnect")) {
            assert.equal(a.status, "reconnect_needed");
            assert.equal(a.connectors.gcal!.status, "reconnect_needed");
            assert.ok(lastErrorText(a.connectors.gcal!.lastError)!.includes("Reconnect"));
          }
          if (name.includes("with-options")) {
            assert.deepEqual(readGmailOptions(a.connectors.gmail!.options).labels.length > 0, true);
            assert.ok(a.connectors.gdrive);
          }
        }
        break;
      }
      case "POST /kb/google/disconnect": {
        const d = decodeDisconnect(r);
        assert.equal(d.ok, true);
        assert.equal(d.revoked, !name.includes("offline"));
        break;
      }
      case "POST /kb/google/options": {
        const d = decodeOptionsResult(r);
        assert.equal(d.ok, true);
        if (name.includes("drive")) {
          assert.deepEqual(readDriveOptions(d.options), { folderIds: ["folderTick1"], includeSharedDrives: true });
          assert.equal(d.contentGranted, false);
        } else {
          // The server dropped the bad label and clamped 9999 to 365; reading it back through ours agrees.
          assert.deepEqual(readGmailOptions(d.options).labels, ["INBOX", "Label_1"]);
          assert.equal(readGmailOptions(d.options).windowDays, 365);
        }
        break;
      }
      case "GET /kb/google/calendars": {
        const d = decodeCalendars(r);
        assert.equal(d.length, 2);
        assert.equal(d[0]!.primary, true);
        break;
      }
      case "GET /kb/google/drive/folders": {
        assert.deepEqual(decodeFolders(r), [{ id: "folderTick1", name: "Project" }]);
        break;
      }
      case "POST /kb/google/gmail/fetch": {
        const d = decodeGmailFetch(r);
        assert.match(d.batchId, /^[0-9a-f]{24}$/);
        if (name.includes("incremental")) {
          assert.equal(d.mode, "history");
          assert.equal(d.tombstones.length, 1);
          assert.equal(d.notes.length, 0);
          assert.match(d.tombstones[0]!.line, /^deleted upstream \d{4}-\d{2}-\d{2}$/);
        } else {
          assert.equal(d.mode, "bootstrap");
          assert.equal(d.notes.length, 2);
          for (const n of d.notes) assert.equal(checkNote(n), "ok", `${name}: ${n.noteFile} passes the safety check`);
        }
        break;
      }
      case "POST /kb/google/gmail/seen": {
        assert.deepEqual(decodeSeen(r), { ok: true, pending: false });
        break;
      }
      case "POST /kb/google/sync": {
        const d = decodeSync(r);
        if (name.includes("drive")) {
          assert.equal(d.product, "gdrive");
          if (d.product === "gdrive") assert.deepEqual([d.stats.files, d.stats.withContent, d.stats.metadataOnly, d.stats.skippedShared, d.stats.contentSkipped], [4, 2, 2, 1, 1]);
        } else {
          assert.equal(d.product, "gcal");
          if (d.product === "gcal") assert.deepEqual([d.events, d.cancelled, d.calendars.length], [3, 1, 1]);
        }
        break;
      }
      default:
        assert.fail(`${name}: no decoder test for ${f.endpoint}`);
    }
  }
  // Every error code appearing in the fixtures was seen and mapped.
  for (const c of ["VALIDATION_FAILED", "GOOGLE_BAD_REQUEST", "GOOGLE_NOT_FOUND", "FORBIDDEN", "GOOGLE_PRODUCT_NOT_GRANTED", "GOOGLE_BATCH_UNKNOWN", "GOOGLE_RECONNECT_NEEDED", "GOOGLE_SYNC_RUNNING"]) assert.ok(seenCodes.has(c), c);
});

test("decoders: malformed answers throw bad_response or drop the bad row instead of trusting it", () => {
  assert.throws(() => decodeStart({}), (e: unknown) => e instanceof GoogleError && e.code === "bad_response");
  assert.throws(() => decodeStart({ authUrl: "x", state: "" }), GoogleError);
  assert.throws(() => decodeStatus("nope"), GoogleError);
  assert.throws(() => decodeStatus({ status: "complete", accountId: "../etc" }), GoogleError);
  assert.equal(decodeStatus({ status: "weird" }).status, "unknown");
  assert.deepEqual(decodeAccounts({ accounts: [{ accountId: "NOT-VALID" }, null, 3], legacyMailToken: "yes" }), { accounts: [], legacyMailToken: false });
  assert.throws(() => decodeGmailFetch({ notes: [] }), GoogleError);
  assert.throws(() => decodeSync({ product: "gmail" }), GoogleError);
  const big = decodeGmailFetch({ batchId: "b", notes: Array.from({ length: 1000 }, (_, i) => ({ noteFile: `gmail-${ACCT}-t${i}.md`, markdown: "x" })), tombstones: [] });
  assert.equal(big.notes.length, 200, "a hostile answer cannot make one batch unbounded");
  const acct = decodeAccounts({ accounts: [{ accountId: ACCT, email: "e".repeat(5000), status: "connected", products: ["gmail", "mail", 4], scopes: Array.from({ length: 100 }, () => "s".repeat(1000)) }] }).accounts[0]!;
  assert.equal(acct.email.length, 320);
  assert.deepEqual(acct.products, ["gmail"]);
  assert.equal(acct.scopes.length, 30);
  assert.equal(acct.scopes[0]!.length, 200);
});

// ---- error mapper ---------------------------------------------------------------------------------

test("error mapper: every code of the routes and of the library under them has its own words; unknown ones fall back by status", () => {
  const table: [string, GoogleErrorCode][] = [
    ["VALIDATION_FAILED", "validation"], ["GOOGLE_BAD_REQUEST", "validation"], ["GOOGLE_NOT_FOUND", "not_found"], ["FORBIDDEN", "forbidden"], ["GOOGLE_PRODUCT_NOT_GRANTED", "not_granted"],
    ["GOOGLE_BATCH_UNKNOWN", "batch_unknown"], ["GOOGLE_RECONNECT_NEEDED", "reconnect_needed"], ["GOOGLE_INVALID_GRANT", "reconnect_needed"], ["GOOGLE_INVALID_CLIENT", "reconnect_needed"],
    ["GOOGLE_SYNC_RUNNING", "sync_running"], ["GOOGLE_BUSY", "busy"], ["GOOGLE_RATE_LIMITED", "rate_limited"], ["GOOGLE_UNAUTHORIZED", "google_auth"], ["GOOGLE_FORBIDDEN", "google_permission"],
    ["GOOGLE_GONE", "google_gone"], ["GOOGLE_HTTP_ERROR", "upstream"], ["GOOGLE_TOKEN_ERROR", "upstream"], ["GOOGLE_FETCH_REFUSED", "refused"], ["GOOGLE_BAD_JSON", "bad_response"],
    ["GOOGLE_SCOPE_MISMATCH", "scope_mismatch"], ["GOOGLE_NO_REFRESH_TOKEN", "no_refresh_token"], ["GOOGLE_BAD_ID_TOKEN", "bad_identity"], ["feature_disabled", "feature_disabled"],
  ];
  const texts = new Set<string>();
  for (const [server, ui] of table) {
    const e = mapGoogleFailure(502, { error: { code: server, message: "SECRET-abc123 from google" } });
    assert.equal(e.code, ui, server);
    assert.equal(e.serverCode, server);
    assert.ok(!e.message.includes("abc123"), "the server's message is never carried");
    texts.add(googleErrorText(ui));
    assert.ok(!googleErrorText(ui).includes("abc123"));
  }
  assert.ok(texts.size >= 18, "distinct wording per code");
  for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [429, "rate_limited"], [408, "timeout"], [504, "timeout"], [400, "validation"], [502, "upstream"], [500, "failed"]] as const) {
    assert.equal(mapGoogleFailure(status, {}).code, code, String(status));
  }
  assert.equal(mapGoogleFailure(500, { error: { code: "x".repeat(300) } }).serverCode!.length, 64);
  assert.equal(mapGoogleFailure(500, { error: { code: "__proto__" } }).code, "failed", "prototype keys are not codes");
  assert.equal(mapGoogleFailure(500, { error: { code: "constructor" } }).code, "failed");
  // Every UI code has non-empty text.
  const all: GoogleErrorCode[] = [...new Set([...table.map(([, u]) => u), "extra_scope_refused", "unsafe_auth_url", "unauthorized", "timeout", "unavailable", "cancelled", "failed"])] as GoogleErrorCode[];
  for (const c of all) assert.ok(googleErrorText(c).length > 10, c);
  // Thrown errors.
  assert.equal(mapGoogleThrown(Object.assign(new Error("x"), { code: "TIMEOUT" })).code, "timeout");
  assert.equal(mapGoogleThrown(Object.assign(new Error("x"), { code: "ABORTED" })).code, "cancelled");
  assert.equal(mapGoogleThrown(Object.assign(new Error("x"), { code: "SESSION_EXPIRED" })).code, "unauthorized");
  assert.equal(mapGoogleThrown(new Error("boom")).code, "unavailable");
  const ac = new AbortController();
  ac.abort();
  assert.equal(mapGoogleThrown(new Error("boom"), ac.signal).code, "cancelled");
});

test("connect failure wording: scope mismatch, extra scope refused, timeout and replaced flows get plain codes; raw text is dropped", () => {
  assert.equal(connectFailureCode("Google granted more access than was requested. The connection was refused and the grant revoked."), "extra_scope_refused");
  assert.equal(connectFailureCode("None of the requested access was granted."), "scope_mismatch");
  assert.equal(connectFailureCode("Google granted no access."), "scope_mismatch");
  assert.equal(connectFailureCode("Google did not return a refresh token. Remove the app under myaccount.google.com/permissions and connect again."), "no_refresh_token");
  assert.equal(connectFailureCode("The identity token nonce does not match"), "bad_identity");
  assert.equal(connectFailureCode("The sign-in timed out. Start again from the app."), "timeout");
  assert.equal(connectFailureCode("Replaced by a newer connect attempt."), "failed");
  assert.equal(lastErrorText(null), null);
  assert.equal(lastErrorText("GOOGLE_RATE_LIMITED"), googleErrorText("rate_limited"));
  assert.match(lastErrorText("some surprising text <b>x</b>")!, /Run it again/);
});

// ---- auth url -------------------------------------------------------------------------------------

const GOOD = "https://accounts.google.com/o/oauth2/v2/auth?client_id=example-client-id.apps.googleusercontent.com&response_type=code&state=EXAMPLE_STATE";
const EXP = { state: "EXAMPLE_STATE", redirectPort: 54321 };

test("auth url: the recorded address passes; the real shape (redirect_uri, PKCE) passes; the normalised URL is returned", () => {
  assert.equal(validateAuthUrl(GOOD, EXP), GOOD);
  const real = `${GOOD}&redirect_uri=${encodeURIComponent("http://127.0.0.1:54321/oauth2/callback")}&code_challenge=abc&code_challenge_method=S256&scope=${encodeURIComponent("openid email https://www.googleapis.com/auth/gmail.readonly")}&access_type=offline&prompt=consent&nonce=n`;
  assert.ok(validateAuthUrl(real, EXP));
  assert.ok(validateAuthUrl(GOOD.replace("/v2/auth", "/auth"), EXP));
  const d = decodeStart(fx("post-kb-google-start-200").response);
  assert.ok(validateAuthUrl(d.authUrl, { state: d.state, redirectPort: d.redirectPort }));
});

test("auth url: hostile addresses never reach the opener", () => {
  const hostile: [string, unknown][] = [
    ["http not https", GOOD.replace("https:", "http:")],
    ["look-alike suffix", GOOD.replace("accounts.google.com", "accounts.google.com.evil.example")],
    ["look-alike prefix", GOOD.replace("accounts.google.com", "evilaccounts.google.com")],
    ["userinfo", GOOD.replace("https://", "https://accounts.google.com@evil.example/#")],
    ["userinfo 2", GOOD.replace("https://accounts.google.com/", "https://user:pw@accounts.google.com/")],
    ["other google host", GOOD.replace("accounts.google.com", "www.google.com")],
    ["myaccount", "https://myaccount.google.com/permissions"],
    ["port", GOOD.replace("accounts.google.com", "accounts.google.com:8443")],
    ["explicit 443", GOOD.replace("accounts.google.com", "accounts.google.com:443")],
    ["upper-case host", GOOD.replace("accounts.google.com", "ACCOUNTS.GOOGLE.COM")],
    ["backslash", GOOD.replace("/o/oauth2", "\\o\\oauth2")],
    ["whitespace", `${GOOD} `],
    ["leading space", ` ${GOOD}`],
    ["newline", GOOD.replace("response_type", "x=1\nresponse_type")],
    ["tab", GOOD.replace("?", "\t?")],
    ["unicode host", GOOD.replace("accounts", "accounts​")],
    ["cyrillic a", GOOD.replace("accounts", "аccounts")],
    ["wrong path", GOOD.replace("/o/oauth2/v2/auth", "/signin/v2/identifier")],
    ["path traversal", GOOD.replace("/o/oauth2/v2/auth", "/o/oauth2/v2/auth/../../../x")],
    ["implicit flow", GOOD.replace("response_type=code", "response_type=token")],
    ["no response type", GOOD.replace("&response_type=code", "")],
    ["missing client", GOOD.replace("client_id=example-client-id.apps.googleusercontent.com&", "")],
    ["bad client chars", GOOD.replace("example-client-id.apps.googleusercontent.com", "x%20y%3Cscript%3E")],
    ["state mismatch", GOOD.replace("EXAMPLE_STATE", "OTHER")],
    ["state missing", GOOD.replace("&state=EXAMPLE_STATE", "")],
    ["duplicate state", `${GOOD}&state=OTHER`],
    ["duplicate client", `${GOOD}&client_id=other.apps.googleusercontent.com`],
    ["fragment", `${GOOD}#x`],
    ["redirect to evil", `${GOOD}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`],
    ["redirect other port", `${GOOD}&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/oauth2/callback")}`],
    ["redirect localhost name", `${GOOD}&redirect_uri=${encodeURIComponent("http://localhost:54321/oauth2/callback")}`],
    ["redirect other path", `${GOOD}&redirect_uri=${encodeURIComponent("http://127.0.0.1:54321/steal")}`],
    ["redirect with query", `${GOOD}&redirect_uri=${encodeURIComponent("http://127.0.0.1:54321/oauth2/callback?x=1")}`],
    ["redirect creds", `${GOOD}&redirect_uri=${encodeURIComponent("http://a@127.0.0.1:54321/oauth2/callback")}`],
    ["plain challenge", `${GOOD}&code_challenge_method=plain`],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<script>1</script>"],
    ["file", "file:///etc/passwd"],
    ["relative", "/o/oauth2/v2/auth?client_id=x&response_type=code&state=EXAMPLE_STATE"],
    ["protocol relative", "//accounts.google.com/o/oauth2/v2/auth"],
    ["empty", ""],
    ["not a string", 42],
    ["null", null],
    ["object", { toString: () => GOOD }],
    ["too long", `${GOOD}&x=${"a".repeat(5000)}`],
  ];
  for (const [what, url] of hostile) assert.equal(validateAuthUrl(url, EXP), null, what);
  assert.equal(validateAuthUrl(GOOD, { state: "", redirectPort: 54321 }), null, "no state to bind to");
});

// ---- connect form and state machine ----------------------------------------------------------------

const GOOD_ID = "123456789012-abcdefghijklmnop.apps.googleusercontent.com";
const form = (patch: Partial<ConnectForm> = {}): ConnectForm => ({ ...EMPTY_FORM, clientId: GOOD_ID, clientSecret: "GOCSPX-example_secret_value", ...patch });

test("connect form: validation, reconnect reuse, products", () => {
  assert.deepEqual(validateConnectForm(form()), {});
  assert.ok(validateConnectForm(form({ clientId: "" })).clientId);
  assert.ok(validateConnectForm(form({ clientId: "short" })).clientId);
  assert.ok(validateConnectForm(form({ clientId: "has space in it.apps.googleusercontent.com" })).clientId);
  assert.ok(validateConnectForm(form({ clientSecret: "" })).clientSecret);
  assert.ok(validateConnectForm(form({ clientSecret: " padded " })).clientSecret);
  assert.ok(validateConnectForm(form({ clientSecret: "line\nbreak" })).clientSecret);
  assert.ok(validateConnectForm(form({ clientSecret: "x".repeat(301) })).clientSecret);
  assert.ok(validateConnectForm(form({ products: { gmail: false, gcal: false, gdrive: false } })).products);
  assert.ok(validateConnectForm(form({ accountId: "nope" })).accountId);
  // Reconnect with the stored client: both blank is fine; one blank is not.
  assert.deepEqual(validateConnectForm({ ...EMPTY_FORM, accountId: ACCT }), {});
  assert.ok(validateConnectForm({ ...EMPTY_FORM, accountId: ACCT, clientId: GOOD_ID }).clientSecret);
  assert.ok(validateConnectForm({ ...EMPTY_FORM }).clientId, "a first connection needs the client");
  assert.deepEqual(chosenProducts(form({ products: { gmail: true, gcal: false, gdrive: true } })), ["gmail", "gdrive"]);
  // The secret never appears in any problem text.
  for (const v of Object.values(validateConnectForm(form({ clientSecret: " GOCSPX-leak " })))) assert.ok(!String(v).includes("leak"));
});

test("setup state: no account, connecting, connected, reconnect needed, legacy only", () => {
  assert.equal(setupState({ accounts: [], legacyMailToken: false, connecting: false }), "no_account");
  assert.equal(setupState({ accounts: [], legacyMailToken: true, connecting: false }), "legacy_only");
  assert.equal(setupState({ accounts: [], legacyMailToken: true, connecting: true }), "connecting");
  assert.equal(setupState({ accounts: [{ status: "connected" }], legacyMailToken: true, connecting: false }), "connected");
  assert.equal(setupState({ accounts: [{ status: "connected" }, { status: "reconnect_needed" }], legacyMailToken: false, connecting: false }), "reconnect_needed");
});

test("connect phases: legal transitions only; busy phases cannot be restarted or reset", () => {
  let p: ConnectPhase = "idle";
  for (const [ev, want] of [["start", "starting"], ["started", "opening"], ["opened", "waiting"], ["complete", "complete"]] as const) {
    p = reduceConnect(p, { type: ev });
    assert.equal(p, want);
  }
  assert.equal(reduceConnect("complete", { type: "start" }), "starting", "a new attempt after a result");
  assert.equal(reduceConnect("waiting", { type: "start" }), "waiting", "no double start");
  assert.equal(reduceConnect("waiting", { type: "reset" }), "waiting");
  assert.equal(reduceConnect("failed", { type: "reset" }), "idle");
  assert.equal(reduceConnect("idle", { type: "complete" }), "idle", "complete needs waiting");
  assert.equal(reduceConnect("opening", { type: "declined" }), "declined");
  assert.equal(reduceConnect("waiting", { type: "declined" }), "waiting");
  assert.equal(reduceConnect("waiting", { type: "timeout" }), "timeout");
  assert.equal(reduceConnect("starting", { type: "timeout" }), "starting");
  for (const busy of ["starting", "opening", "waiting"] as const) {
    assert.equal(reduceConnect(busy, { type: "cancel" }), "cancelled");
    assert.equal(reduceConnect(busy, { type: "failed" }), "failed");
  }
  assert.equal(reduceConnect("done" as ConnectPhase, { type: "cancel" }), "done" as ConnectPhase);
  assert.equal(reduceConnect("complete", { type: "cancel" }), "complete");
});

// ---- connect run (fake core, fake clock) ----------------------------------------------------------

type Reply = { status: number; body: unknown } | (() => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>);
class FakeCore implements SourcesCore {
  calls: { method: string; path: string; body: unknown }[] = [];
  queues = new Map<string, Reply[]>();
  fallback = new Map<string, Reply>();
  async call(method: "GET" | "POST" | "DELETE", path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    this.calls.push({ method, path, body });
    const key = `${method} ${path.split("?")[0]}`;
    const q = this.queues.get(key);
    const r = q && q.length > 0 ? q.shift()! : this.fallback.get(key);
    if (!r) return { status: 404, body: {} };
    return typeof r === "function" ? r() : r;
  }
  queue(key: string, ...r: Reply[]): void {
    this.queues.set(key, [...(this.queues.get(key) ?? []), ...r]);
  }
  always(key: string, r: Reply): void {
    this.fallback.set(key, r);
  }
  to(path: string): { method: string; body: unknown; path: string }[] {
    return this.calls.filter((c) => c.path.split("?")[0] === path);
  }
}
const ok = (response: unknown): Reply => ({ status: 200, body: response });
const err = (status: number, code: string): Reply => ({ status, body: { error: { code, message: "SERVER TEXT secret-xyz" } } });

function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[]; t: number } {
  const c = { t: 1_000_000, sleeps: [] as number[], now: () => c.t, sleep: async (ms: number) => { c.sleeps.push(ms); c.t += ms; } };
  return c;
}

const STATUS_COMPLETE = fx("get-kb-google-status-200").response;
const START_OK = fx("post-kb-google-start-200").response;

test("connect run: start -> open the validated address -> poll with backoff -> account email, scopes, products ON/OFF", async () => {
  const core = new FakeCore();
  core.queue("POST /kb/google/start", ok(START_OK));
  core.queue("GET /kb/google/status", ok({ status: "pending" }), ok({ status: "pending" }), ok({ status: "pending" }), ok({ status: "pending" }), ok({ status: "pending" }), ok(STATUS_COMPLETE));
  const c = clock();
  const opened: string[] = [];
  const phases: ConnectPhase[] = [];
  const r = await runConnect(form({ products: { gmail: true, gcal: true, gdrive: false } }), { core, openAuth: async (u) => (opened.push(u), true), signal: never, onPhase: (p) => phases.push(p), sleep: c.sleep, now: c.now });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.outcome.email, "me@example.com");
  assert.equal(r.outcome.accountId, ACCT);
  assert.deepEqual(r.outcome.products.map((p) => [p.product, p.on]), [["gmail", true], ["gcal", true], ["gdrive", false]]);
  assert.deepEqual(r.outcome.notes, []);
  assert.deepEqual(phases, ["starting", "opening", "waiting", "complete"]);
  assert.equal(opened.length, 1);
  assert.match(opened[0]!, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.deepEqual(c.sleeps, [POLL_FIRST_MS, 1950, 2535, 3296, 4285], "backoff grows by 1.3x");
  assert.ok(c.sleeps.every((s) => s <= POLL_MAX_MS));
  // The status route is polled with the state, URL-encoded; the state appears nowhere in the result.
  assert.ok(core.to("/kb/google/status").every((x) => x.path === "/kb/google/status?state=EXAMPLE_STATE"));
  assert.ok(!JSON.stringify(r).includes("EXAMPLE_STATE"));
});

test("connect run: the client secret goes in the start body only, once, and into nothing else", async () => {
  const core = new FakeCore();
  core.queue("POST /kb/google/start", ok(START_OK));
  core.queue("GET /kb/google/status", ok(STATUS_COMPLETE));
  const SECRET = "GOCSPX-super-secret-value-123";
  const c = clock();
  const phases: string[] = [];
  const r = await runConnect(form({ clientSecret: SECRET }), { core, openAuth: async () => true, signal: never, onPhase: (p) => phases.push(p), sleep: c.sleep, now: c.now });
  const starts = core.to("/kb/google/start");
  assert.equal(starts.length, 1);
  assert.equal((starts[0]!.body as { clientSecret: string }).clientSecret, SECRET);
  assert.deepEqual(Object.keys(starts[0]!.body as object).sort(), ["clientId", "clientSecret", "driveContent", "products"]);
  for (const call of core.calls.filter((x) => x.path !== "/kb/google/start")) assert.ok(!JSON.stringify(call).includes(SECRET), `${call.path} must not carry the secret`);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.ok(!JSON.stringify(phases).includes(SECRET));
});

test("connect run: a reconnect with the stored client sends neither id nor secret; the account id is validated", async () => {
  const core = new FakeCore();
  core.queue("POST /kb/google/start", ok(START_OK));
  core.queue("GET /kb/google/status", ok(STATUS_COMPLETE));
  const c = clock();
  const r = await runConnect({ ...EMPTY_FORM, accountId: ACCT, products: { gmail: true, gcal: true, gdrive: false } }, { core, openAuth: async () => true, signal: never, sleep: c.sleep, now: c.now });
  assert.ok(r.ok);
  assert.deepEqual(core.to("/kb/google/start")[0]!.body, { products: ["gmail", "gcal"], driveContent: false, accountId: ACCT });
  const bad = await runConnect({ ...EMPTY_FORM, accountId: "x" }, { core: new FakeCore(), openAuth: async () => true, signal: never });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.error, "validation");
});

test("connect run: an unsafe address from the core is refused and never opened", async () => {
  for (const url of ["https://accounts.google.com.evil.example/o/oauth2/v2/auth?client_id=abcdefghij&response_type=code&state=EXAMPLE_STATE", "http://accounts.google.com/o/oauth2/v2/auth", "https://evil.example/", "javascript:alert(1)"]) {
    const core = new FakeCore();
    core.queue("POST /kb/google/start", ok({ ...(START_OK as object), authUrl: url }));
    let opened = 0;
    const r = await runConnect(form(), { core, openAuth: async () => (opened++, true), signal: never });
    assert.equal(opened, 0, url);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error, "unsafe_auth_url");
    assert.equal(core.to("/kb/google/status").length, 0, "no polling after a refused address");
  }
});

test("connect run: declining the host's prompt stops cleanly; cancel stops polling; the 5 minute deadline ends the wait", async () => {
  const core = new FakeCore();
  core.queue("POST /kb/google/start", ok(START_OK));
  const declined = await runConnect(form(), { core, openAuth: async () => false, signal: never });
  assert.deepEqual(declined, { ok: false, phase: "declined", error: null, serverCode: null });
  assert.equal(core.to("/kb/google/status").length, 0);

  const core2 = new FakeCore();
  core2.queue("POST /kb/google/start", ok(START_OK));
  core2.always("GET /kb/google/status", ok({ status: "pending" }));
  const ac = new AbortController();
  let polls = 0;
  const c = clock();
  const r = await runConnect(form(), { core: core2, openAuth: async () => true, signal: ac.signal, now: c.now, sleep: async (ms) => { c.t += ms; if (++polls === 3) ac.abort(); } });
  assert.deepEqual(r, { ok: false, phase: "cancelled", error: null, serverCode: null });
  assert.equal(core2.to("/kb/google/status").length, 3);

  const core3 = new FakeCore();
  core3.queue("POST /kb/google/start", ok(START_OK));
  core3.always("GET /kb/google/status", ok({ status: "pending" }));
  const c3 = clock();
  const t = await runConnect(form(), { core: core3, openAuth: async () => true, signal: never, now: c3.now, sleep: c3.sleep });
  assert.equal(t.ok, false);
  assert.equal(t.ok === false && t.phase, "timeout");
  assert.ok(c3.t - 1_000_000 <= FLOW_MAX_MS + 5000 + POLL_MAX_MS, "never waits much past 5 minutes");
  assert.ok(c3.t - 1_000_000 >= FLOW_MAX_MS, "waits the whole window");
});

test("connect run: core errors and flow errors map to plain codes (no server text); transient polling blips are tolerated, a final one is not", async () => {
  const run = async (reply: Reply, statuses: Reply[] = []): ReturnType<typeof runConnect> => {
    const core = new FakeCore();
    core.queue("POST /kb/google/start", reply);
    core.queue("GET /kb/google/status", ...statuses);
    const c = clock();
    return runConnect(form(), { core, openAuth: async () => true, signal: never, sleep: c.sleep, now: c.now });
  };
  const codes: [Reply, string][] = [
    [err(400, "GOOGLE_BAD_REQUEST"), "validation"], [err(404, "GOOGLE_NOT_FOUND"), "not_found"], [err(429, "GOOGLE_BUSY"), "busy"], [err(502, "GOOGLE_HTTP_ERROR"), "upstream"], [{ status: 401, body: {} }, "unauthorized"],
  ];
  for (const [reply, want] of codes) {
    const r = await run(reply);
    assert.equal(r.ok === false && r.error, want);
    assert.ok(!JSON.stringify(r).includes("secret-xyz"));
  }
  const flowErrors: [string, string][] = [
    ["Google granted more access than was requested. The connection was refused and the grant revoked.", "extra_scope_refused"], ["None of the requested access was granted.", "scope_mismatch"],
    ["Google did not return a refresh token. Remove the app under myaccount.google.com/permissions and connect again.", "no_refresh_token"], ["Sign-in cancelled.", "failed"], ["The sign-in timed out. Start again from the app.", "timeout"],
  ];
  for (const [message, want] of flowErrors) {
    const r = await run(ok(START_OK), [ok({ status: "pending" }), ok({ status: "error", message })]);
    assert.equal(r.ok === false && r.error, want, message);
    assert.ok(!JSON.stringify(r).includes("Sign-in cancelled"), "the core's text is not carried");
  }
  const dead = await run(ok(START_OK), [ok({ status: "unknown" })]);
  assert.equal(dead.ok === false && dead.error, "timeout", "an unknown flow is terminal, not polled forever");
  const forbidden = await run(ok(START_OK), [{ status: 403, body: { error: { code: "FORBIDDEN" } } }]);
  assert.equal(forbidden.ok === false && forbidden.error, "forbidden");
  const blips = await run(ok(START_OK), [{ status: 503, body: {} }, { status: 503, body: {} }, ok(STATUS_COMPLETE)]);
  assert.ok(blips.ok, "two blips then success");
  const many = await run(ok(START_OK), Array.from({ length: POLL_MAX_FAILURES }, () => ({ status: 503, body: {} })));
  assert.equal(many.ok === false && many.error, "upstream");
});

test("connect outcome: scope mismatch (unticked product OFF), extra-scope notes, Drive content downgrade, products kept from before", () => {
  const base = { accountId: ACCT, email: "me@example.com", grantedScopes: ["email", "openid"], missingScopes: [] as string[], driveContent: false };
  const a = describeOutcome(["gmail", "gcal"], false, { ...base, products: ["gmail"], missingScopes: ["https://www.googleapis.com/auth/calendar.events.readonly"] });
  assert.deepEqual(a.products.map((p) => [p.product, p.requested, p.on]), [["gmail", true, true], ["gcal", true, false], ["gdrive", false, false]]);
  assert.match(a.notes.join(" "), /Scope mismatch: Google Calendar was not allowed on Google's consent screen, so it is OFF/);
  const b = describeOutcome(["gdrive"], true, { ...base, products: ["gdrive"] });
  assert.match(b.notes.join(" "), /File contents for Drive were not allowed/);
  const c = describeOutcome(["gdrive"], true, { ...base, products: ["gdrive"], driveContent: true });
  assert.deepEqual(c.notes, []);
  const d = describeOutcome(["gmail"], false, { ...base, products: ["gmail", "gcal"] });
  assert.match(d.notes.join(" "), /Google Calendar stays on from an earlier connection/);
  const e = describeOutcome(["gmail", "gcal", "gdrive"], false, { ...base, products: [] });
  assert.match(e.notes[0]!, /Gmail, Google Calendar, Google Drive were not allowed/);
});

// ---- options --------------------------------------------------------------------------------------

test("options: validators mirror the server clamps; payloads are refused when invalid; reads fall back to defaults", () => {
  assert.deepEqual(validateGmailOptions({ labels: ["INBOX"], windowDays: 30, includePromotions: false, includeSocial: false }), {});
  assert.ok(validateGmailOptions({ labels: [], windowDays: 30, includePromotions: false, includeSocial: false }).labels);
  assert.ok(validateGmailOptions({ labels: ["bad label!"], windowDays: 30, includePromotions: false, includeSocial: false }).labels);
  assert.ok(validateGmailOptions({ labels: Array.from({ length: 21 }, (_, i) => `L${i}`), windowDays: 30, includePromotions: false, includeSocial: false }).labels);
  for (const bad of [0, 366, 1.5, Number.NaN, -1]) assert.ok(validateGmailOptions({ labels: ["INBOX"], windowDays: bad, includePromotions: false, includeSocial: false }).windowDays, String(bad));
  assert.deepEqual(validateCalendarOptions({ calendarIds: ["primary"], daysBack: 0, daysAhead: 730 }), {});
  assert.ok(validateCalendarOptions({ calendarIds: [], daysBack: 0, daysAhead: 0 }).calendarIds);
  assert.ok(validateCalendarOptions({ calendarIds: ["primary"], daysBack: 366, daysAhead: 0 }).daysBack);
  assert.ok(validateCalendarOptions({ calendarIds: ["primary"], daysBack: 0, daysAhead: 731 }).daysAhead);
  assert.deepEqual(validateDriveOptions({ folderIds: ["folderTick1"], includeSharedDrives: true }), {});
  assert.ok(validateDriveOptions({ folderIds: ["x"], includeSharedDrives: false }).folderIds);
  assert.ok(validateDriveOptions({ folderIds: ["../../etc/passwd"], includeSharedDrives: false }).folderIds);
  assert.ok(validateDriveOptions({ folderIds: Array.from({ length: 51 }, (_, i) => `folder${i}xx`), includeSharedDrives: false }).folderIds);
  const bad = optionsPayload("gmail", { labels: [], windowDays: 30, includePromotions: false, includeSocial: false });
  assert.equal(bad.ok, false);
  const good = optionsPayload("gdrive", { folderIds: ["folderTick1"], includeSharedDrives: true });
  assert.deepEqual(good, { ok: true, options: { folderIds: ["folderTick1"], includeSharedDrives: true } });
  assert.deepEqual(readGmailOptions({}), { labels: ["INBOX"], windowDays: 30, includePromotions: false, includeSocial: false });
  assert.deepEqual(readGmailOptions({ labels: ["INBOX", "x y!", 4], windowDays: 9999, includeSocial: true }), { labels: ["INBOX"], windowDays: 30, includePromotions: false, includeSocial: true });
  assert.deepEqual(readCalendarOptions({ calendarIds: ["a@b.c", "a@b.c"], daysBack: 5, daysAhead: 800 }), { calendarIds: ["a@b.c"], daysBack: 5, daysAhead: 90 });
  assert.deepEqual(readDriveOptions({ folderIds: ["folderTick1", "bad id", "folderTick1"], includeSharedDrives: "yes" }), { folderIds: ["folderTick1"], includeSharedDrives: false });
  assert.deepEqual(parseLabelList(" INBOX, Label_1\nLabel_1 ,, "), ["INBOX", "Label_1"]);
  assert.equal(parseLabelList(Array.from({ length: 100 }, (_, i) => `L${i}`).join(",")).length, 21, "bounded so a paste cannot grow without limit");
  assert.equal(driveContentNote(0, false), null);
  assert.match(driveContentNote(2, false)!, /only names, types and dates/);
  assert.equal(driveContentNote(2, true), null);
});

test("scopes shown in the guide are exactly the read-only registry (no write scope can be listed)", () => {
  const all = SCOPE_GROUPS.flatMap((g) => g.scopes);
  assert.ok(all.includes("https://www.googleapis.com/auth/gmail.readonly"));
  assert.ok(all.includes("https://www.googleapis.com/auth/drive.metadata.readonly"));
  assert.ok(all.includes("https://www.googleapis.com/auth/drive.readonly"));
  for (const s of all) assert.ok(s === "openid" || s === "email" || /\.readonly$/.test(s), s);
  assert.ok(!all.some((s) => /modify|compose|send|drive\.file|\/auth\/drive$|calendar$/.test(s)));
});

// ---- Gmail: create first, then mark seen ----------------------------------------------------------

const FETCH_OK = fx("post-kb-google-gmail-fetch-200").response as { batchId: string; notes: { noteFile: string; markdown: string }[] };
const SEEN_OK = fx("post-kb-google-gmail-seen-200").response;
const [N1, N2] = FETCH_OK.notes as [{ noteFile: string; markdown: string; threadId: string }, { noteFile: string; markdown: string; threadId: string }];

function mkNote(i: number, extra = ""): { threadId: string; noteFile: string; title: string; markdown: string; messageCount: number; lastAt: string } {
  return {
    threadId: `t${i}`,
    noteFile: `gmail-${"d3978525a50c"}-t${i}.md`,
    title: `Thread ${i}`,
    markdown: `---\nsource: "gmail"\naccount: "me@example.com"\nthreadId: "t${i}"\nsubject: "Thread ${i}"\nuntrusted: true\n---\n\n# Thread ${i}\n\nbody ${i}${extra}\n`,
    messageCount: 1,
    lastAt: "2026-10-31T00:00:00.000Z",
  };
}
const batch = (notes: object[], extra: object = {}, id = "0123456789abcdef01234567"): Reply => ok({ accountId: ACCT, batchId: id, mode: "bootstrap", pending: false, stats: { threads: notes.length, messages: notes.length, skipped: 0, oversize: 0, rebootstrapped: false, truncated: false }, tombstones: [], notes, ...extra });

function setup(): { host: FakeHost; write: FakeWriteHost; core: FakeCore; events: string[] } {
  const host = new FakeHost();
  const write = new FakeWriteHost(host);
  const events: string[] = [];
  const create = write.create.bind(write);
  write.create = async (rel, text) => {
    events.push(`create ${rel}`);
    return create(rel, text);
  };
  const core = new FakeCore();
  const callOrig = core.call.bind(core);
  core.call = async (m, p, b) => {
    if (p.startsWith("/kb/google/gmail/seen")) events.push("seen");
    if (p.startsWith("/kb/google/gmail/fetch")) events.push("fetch");
    return callOrig(m, p, b);
  };
  return { host, write, core, events };
}
const syncDeps = (s: ReturnType<typeof setup>, signal: AbortSignal = never, progress: GmailProgress[] = []) => ({ core: s.core, write: s.write, signal, onProgress: (p: GmailProgress) => progress.push(p) });

test("gmail: notes are created through the write host FIRST, then the batch is marked seen, and the file is under source/gmail", async () => {
  const s = setup();
  s.core.queue("POST /kb/google/gmail/fetch", ok(FETCH_OK));
  s.core.queue("POST /kb/google/gmail/seen", ok(SEEN_OK));
  const p = await runGmailSync(ACCT, syncDeps(s));
  assert.equal(p.phase, "done");
  assert.deepEqual(s.events, ["fetch", `create source/gmail/${N1.noteFile}`, `create source/gmail/${N2.noteFile}`, "seen"]);
  assert.deepEqual([p.written, p.updated, p.unchanged, p.failedCount, p.confirmed, p.unconfirmed], [2, 0, 0, 0, 1, false]);
  assert.deepEqual(s.core.to("/kb/google/gmail/seen")[0]!.body, { accountId: ACCT, batchId: FETCH_OK.batchId });
  assert.equal(s.host.files.get(`source/gmail/${N1.noteFile}`)!.text, N1.markdown);
  assert.match(gmailMessage(p), /2 new notes saved/);
});

test("gmail: a failed create means the batch is NOT marked seen, the failed file is named, the others are kept", async () => {
  const s = setup();
  const failing = `source/gmail/${N2.noteFile}`;
  const create = s.write.create.bind(s.write);
  s.write.create = async (rel, text) => {
    if (rel === failing) throw new WriteError("permission_denied");
    return create(rel, text);
  };
  s.core.queue("POST /kb/google/gmail/fetch", ok(FETCH_OK));
  s.core.queue("POST /kb/google/gmail/seen", ok(SEEN_OK));
  const p = await runGmailSync(ACCT, syncDeps(s));
  assert.equal(s.core.to("/kb/google/gmail/seen").length, 0, "never marked seen after a partial failure");
  assert.deepEqual(p.failed, [N2.noteFile]);
  assert.equal(p.failedCount, 1);
  assert.equal(p.written, 1);
  assert.equal(p.unconfirmed, true);
  assert.equal(p.confirmed, 0);
  assert.equal(p.phase, "done");
  assert.match(gmailMessage(p), /1 could not be saved.*not confirmed.*offered again|1 could not be saved.*not confirmed/);
  // The replay on the next fetch is harmless: the first note exists and is identical, the second is written now.
  s.write.create = create;
  s.core.queue("POST /kb/google/gmail/fetch", ok(FETCH_OK));
  s.core.queue("POST /kb/google/gmail/seen", ok(SEEN_OK));
  const again = await runGmailSync(ACCT, syncDeps(s));
  assert.deepEqual([again.written, again.unchanged, again.failedCount, again.confirmed], [1, 1, 0, 1]);
  assert.equal(s.core.to("/kb/google/gmail/seen").length, 1);
});

test("gmail: failing in every position never marks seen; only the all-success batch does", async () => {
  for (let bad = 0; bad < 3; bad += 1) {
    const s = setup();
    const notes = [mkNote(1), mkNote(2), mkNote(3)];
    const target = `source/gmail/${notes[bad]!.noteFile}`;
    const create = s.write.create.bind(s.write);
    s.write.create = async (rel, text) => {
      if (rel === target) throw new WriteError("io");
      return create(rel, text);
    };
    s.core.queue("POST /kb/google/gmail/fetch", batch(notes));
    const p = await runGmailSync(ACCT, syncDeps(s));
    assert.equal(s.core.to("/kb/google/gmail/seen").length, 0, `position ${bad}`);
    assert.equal(p.written, 2);
    assert.equal(p.failedCount, 1);
  }
});

test("gmail: an existing file is never overwritten: identical -> unchanged, different -> a hash-named sibling, replay -> unchanged", async () => {
  const s = setup();
  const first = mkNote(1);
  s.host.add(`source/gmail/${first.noteFile}`, first.markdown);
  const updated = mkNote(1, "\n\n## me, later\n\nthanks\n");
  const same = mkNote(2);
  s.host.add(`source/gmail/${same.noteFile}`, same.markdown);
  s.core.queue("POST /kb/google/gmail/fetch", batch([updated, same]));
  s.core.queue("POST /kb/google/gmail/seen", ok(SEEN_OK));
  const p = await runGmailSync(ACCT, syncDeps(s));
  assert.deepEqual([p.written, p.updated, p.unchanged, p.failedCount, p.confirmed], [0, 1, 1, 0, 1]);
  assert.equal(s.host.files.get(`source/gmail/${first.noteFile}`)!.text, first.markdown, "the original file is untouched");
  const siblings = [...s.host.files.keys()].filter((k) => /-t1-u[0-9a-f]{8}\.md$/.test(k));
  assert.equal(siblings.length, 1);
  assert.equal(s.host.files.get(siblings[0]!)!.text, updated.markdown);
  assert.equal(s.write.calls.save, 0, "nothing was saved over an existing note");
  // Fetching the same updated thread again creates nothing new.
  s.core.queue("POST /kb/google/gmail/fetch", batch([updated]));
  s.core.queue("POST /kb/google/gmail/seen", ok(SEEN_OK));
  const files = s.host.files.size;
  const again = await runGmailSync(ACCT, syncDeps(s));
  assert.equal(again.updated, 0);
  assert.equal(again.unchanged, 1);
  assert.equal(s.host.files.size, files);
});

test("gmail: hostile notes from the core are refused (path escape, missing provenance, oversize) and block the seen mark", async () => {
  const good = mkNote(1);
  const cases: [string, ReturnType<typeof mkNote>][] = [
    ["traversal", { ...good, noteFile: "../../etc/gmail-d3978525a50c-t1.md" }],
    ["subfolder", { ...good, noteFile: "sub/gmail-d3978525a50c-t1.md" }],
    ["not gmail name", { ...good, noteFile: "evil.md" }],
    ["backslash", { ...good, noteFile: "gmail-d3978525a50c-t\\1.md" }],
    ["wrong extension", { ...good, noteFile: "gmail-d3978525a50c-t1.sh" }],
    ["no untrusted marker", { ...good, markdown: good.markdown.replace("untrusted: true", "untrusted: false") }],
    ["no front matter", { ...good, markdown: "# just text\n" }],
    ["other source", { ...good, markdown: good.markdown.replace('source: "gmail"', 'source: "slack"') }],
    ["oversize", { ...good, markdown: good.markdown + "x".repeat(700_000) }],
  ];
  for (const [what, n] of cases) {
    const s = setup();
    s.core.queue("POST /kb/google/gmail/fetch", batch([n]));
    const p = await runGmailSync(ACCT, syncDeps(s));
    assert.equal(s.host.files.size, 0, `${what}: nothing written`);
    assert.equal(s.core.to("/kb/google/gmail/seen").length, 0, `${what}: not marked seen`);
    assert.equal(p.failedCount, 1, what);
    assert.ok(p.failed[0] === "(invalid note from the core)" || NOTE_FILE_RE.test(p.failed[0]!), `${what}: a hostile name is not echoed: ${p.failed[0]}`);
  }
  assert.equal(checkNote(good), "ok");
});

test("gmail: tombstones append one line with compare-and-swap, are idempotent, skip a missing note, and block seen on failure", async () => {
  const s = setup();
  const n = mkNote(1);
  s.host.add(`source/gmail/${n.noteFile}`, n.markdown);
  const line = "deleted upstream 2026-10-31";
  s.core.queue("POST /kb/google/gmail/fetch", batch([], { tombstones: [{ threadId: "t1", noteFile: n.noteFile, line }, { threadId: "t9", noteFile: "gmail-d3978525a50c-t9.md", line }], mode: "history" }));
  s.core.queue("POST /kb/google/gmail/seen", ok(SEEN_OK));
  const p = await runGmailSync(ACCT, syncDeps(s));
  assert.equal(p.tombstoned, 1);
  assert.equal(p.confirmed, 1);
  assert.ok(s.host.files.get(`source/gmail/${n.noteFile}`)!.text.endsWith(`\n\n${line}\n`));
  assert.equal(s.write.calls.save, 1);
  // Again: the line is already there, nothing is saved, batch is still confirmed.
  s.core.queue("POST /kb/google/gmail/fetch", batch([], { tombstones: [{ threadId: "t1", noteFile: n.noteFile, line }] }));
  s.core.queue("POST /kb/google/gmail/seen", ok(SEEN_OK));
  const again = await runGmailSync(ACCT, syncDeps(s));
  assert.equal(again.tombstoned, 0);
  assert.equal(s.write.calls.save, 1);
  assert.equal(again.confirmed, 1);
  // A conflicting save (the user is editing the note) is a failure: not marked seen.
  const s2 = setup();
  s2.host.add(`source/gmail/${n.noteFile}`, n.markdown);
  s2.write.failSave.set(`source/gmail/${n.noteFile}`, new WriteError("conflict"));
  s2.core.queue("POST /kb/google/gmail/fetch", batch([], { tombstones: [{ threadId: "t1", noteFile: n.noteFile, line }] }));
  const c = await runGmailSync(ACCT, syncDeps(s2));
  assert.equal(c.failedCount, 1);
  assert.equal(s2.core.to("/kb/google/gmail/seen").length, 0);
  // Hostile tombstones are refused.
  assert.equal(await applyTombstone(s.write, { threadId: "x", noteFile: "../x.md", line }), "failed");
  assert.equal(await applyTombstone(s.write, { threadId: "x", noteFile: n.noteFile, line: "deleted upstream\n# injected" }), "failed");
  assert.equal(await applyTombstone(s.write, { threadId: "x", noteFile: n.noteFile, line: "anything else" }), "failed");
});

test("gmail: a big mailbox is fetched in rounds (20,000 threads = 400 batches), Stop works between rounds, and memory holds one batch", async () => {
  const s = setup();
  const BATCH = 50;
  const ROUNDS = 400;
  let n = 0;
  let maxLive = 0;
  s.core.always("POST /kb/google/gmail/fetch", () => {
    const notes = Array.from({ length: BATCH }, () => mkNote(n++));
    return { status: 200, body: { accountId: ACCT, batchId: `b${n}`, mode: "bootstrap", pending: n < BATCH * ROUNDS, stats: { threads: BATCH, messages: BATCH, skipped: 0, oversize: 0, rebootstrapped: false, truncated: false }, tombstones: [], notes } };
  });
  s.core.always("POST /kb/google/gmail/seen", ok(SEEN_OK));
  const progress: GmailProgress[] = [];
  const p = await runGmailSync(ACCT, { ...syncDeps(s, never, progress), maxRounds: 1000 });
  assert.equal(p.phase, "done");
  assert.equal(p.threads, 20_000);
  assert.equal(p.written, 20_000);
  assert.equal(p.confirmed, ROUNDS);
  assert.equal(p.more, false);
  for (const x of progress) maxLive = Math.max(maxLive, x.failed.length);
  assert.equal(maxLive, 0);
  assert.equal(s.core.to("/kb/google/gmail/fetch").length, ROUNDS);

  // Stop between rounds: what was confirmed stays confirmed, no further fetch happens.
  const s2 = setup();
  let k = 0;
  const ac = new AbortController();
  s2.core.always("POST /kb/google/gmail/fetch", () => ({ status: 200, body: { accountId: ACCT, batchId: `b${k}`, mode: "bootstrap", pending: true, stats: { threads: 2, messages: 2, skipped: 0, oversize: 0, rebootstrapped: false, truncated: false }, tombstones: [], notes: [mkNote(k++), mkNote(k++)] } }));
  s2.core.always("POST /kb/google/gmail/seen", () => {
    if (k >= 6) ac.abort();
    return { status: 200, body: { ok: true, pending: true } };
  });
  const stopped = await runGmailSync(ACCT, syncDeps(s2, ac.signal));
  assert.equal(stopped.phase, "cancelled");
  assert.equal(stopped.confirmed, 3);
  assert.equal(stopped.written, 6);
  assert.equal(s2.core.to("/kb/google/gmail/fetch").length, 3);
  assert.equal(stopped.unconfirmed, false, "a stop between rounds leaves nothing unconfirmed");
});

test("gmail: Stop in the middle of a batch leaves it unconfirmed; the failed-name list is bounded", async () => {
  const s = setup();
  const ac = new AbortController();
  const create = s.write.create.bind(s.write);
  let made = 0;
  s.write.create = async (rel, text) => {
    const r = await create(rel, text);
    if (++made === 2) ac.abort();
    return r;
  };
  s.core.queue("POST /kb/google/gmail/fetch", batch([mkNote(1), mkNote(2), mkNote(3), mkNote(4)]));
  const p = await runGmailSync(ACCT, syncDeps(s, ac.signal));
  assert.equal(p.phase, "cancelled");
  assert.equal(p.written, 2);
  assert.equal(p.unconfirmed, true);
  assert.equal(s.core.to("/kb/google/gmail/seen").length, 0);

  const s2 = setup();
  s2.write.create = async () => {
    throw new WriteError("io");
  };
  s2.core.queue("POST /kb/google/gmail/fetch", batch(Array.from({ length: 120 }, (_, i) => mkNote(i))));
  const many = await runGmailSync(ACCT, syncDeps(s2));
  assert.equal(many.failedCount, 120);
  assert.equal(many.failed.length, MAX_FAILED_SHOWN);
});

test("gmail: core errors end the run with a plain code; a failure while recording leaves the batch unconfirmed; rate limit starts a cooldown", async () => {
  const s = setup();
  s.core.queue("POST /kb/google/gmail/fetch", err(409, "GOOGLE_PRODUCT_NOT_GRANTED"));
  const a = await runGmailSync(ACCT, syncDeps(s));
  assert.equal(a.phase, "error");
  assert.equal(a.error, "not_granted");
  assert.equal(a.serverCode, "GOOGLE_PRODUCT_NOT_GRANTED");
  const s2 = setup();
  s2.core.queue("POST /kb/google/gmail/fetch", batch([mkNote(1)]));
  s2.core.queue("POST /kb/google/gmail/seen", err(409, "GOOGLE_BATCH_UNKNOWN"));
  const b = await runGmailSync(ACCT, syncDeps(s2));
  assert.equal(b.phase, "error");
  assert.equal(b.error, "batch_unknown");
  assert.equal(b.unconfirmed, true);
  assert.equal(b.written, 1);
  const s3 = setup();
  s3.core.queue("POST /kb/google/gmail/fetch", err(429, "GOOGLE_RATE_LIMITED"));
  const c = await runGmailSync(ACCT, syncDeps(s3));
  assert.equal(c.error, "rate_limited");
  assert.equal(cooldownUntil(c.error, 1000), 61_000);
  assert.equal(cooldownUntil("not_granted", 1000), 0);
  const s4 = setup();
  s4.core.queue("POST /kb/google/gmail/fetch", err(409, "GOOGLE_RECONNECT_NEEDED"));
  assert.equal((await runGmailSync(ACCT, syncDeps(s4))).error, "reconnect_needed");
  assert.ok(IDLE_GMAIL.phase === "idle");
});

test("gmail: writeThread outcomes", async () => {
  const host = new FakeHost();
  const w = new FakeWriteHost(host);
  const n = mkNote(7);
  assert.equal(await writeThread(w, n), "written");
  assert.equal(await writeThread(w, n), "unchanged");
  assert.equal(await writeThread(w, { ...n, markdown: n.markdown + "more\n" }), "updated");
  assert.equal(await writeThread(w, { ...n, markdown: n.markdown + "more\n" }), "unchanged");
  assert.equal(await writeThread(w, { ...n, noteFile: "bad" }), "failed");
});

// ---- Calendar / Drive sync -----------------------------------------------------------------------

const GCAL = fx("post-kb-google-sync-200").response as { calendars: unknown[] };
const GDRIVE = fx("post-kb-google-sync-200-drive").response as { stats: Record<string, unknown> };

test("sync: capped passes repeat while pending, counters add up, tombstones are shown as removed, Stop and stalls end the run", async () => {
  const core = new FakeCore();
  const seen: SyncProgress[] = [];
  core.queue("POST /kb/google/sync", ok({ ...GCAL, accountId: ACCT, product: "gcal", pending: true, events: 2000, cancelled: 4 }), ok({ ...GCAL, accountId: ACCT, product: "gcal", pending: true, events: 1500, cancelled: 1 }), ok({ ...GCAL, accountId: ACCT, product: "gcal", pending: false, events: 3, cancelled: 0 }));
  const p = await runProductSync(ACCT, "gcal", { core, signal: never, onProgress: (x) => seen.push(x) });
  assert.equal(p.phase, "done");
  assert.deepEqual([p.passes, p.items, p.removed, p.more], [3, 3503, 5, false]);
  assert.match(syncMessage(p), /3,503 events indexed; removed 5 cancelled/);
  assert.deepEqual(core.to("/kb/google/sync")[0]!.body, { accountId: ACCT, product: "gcal" });

  const d = new FakeCore();
  d.queue("POST /kb/google/sync", ok({ ...(GDRIVE as object), pending: true }), ok({ ...(GDRIVE as object), pending: false }));
  const dp = await runProductSync(ACCT, "gdrive", { core: d, signal: never, onProgress: () => {} });
  assert.equal(dp.phase, "done");
  assert.equal(dp.items, 8);
  assert.match(syncMessage(dp), /8 files indexed; 4 with text; 4 by name only; 2 in shared drives skipped \(off\); 2 too large or unsupported to read/);

  // Drive 50,000 files: 50 passes of 1,000.
  const big = new FakeCore();
  let passes = 0;
  big.always("POST /kb/google/sync", () => ({ status: 200, body: { accountId: ACCT, product: "gdrive", pending: ++passes < 50, mode: "bootstrap", stats: { files: 1000, removed: 0, withContent: 0, metadataOnly: 1000, skippedShared: 0, contentSkipped: 0, restarted: false, truncated: false } } }));
  const bp = await runProductSync(ACCT, "gdrive", { core: big, signal: never, onProgress: () => {} });
  assert.deepEqual([bp.phase, bp.passes, bp.items], ["done", 50, 50_000]);

  // Stop between passes.
  const st = new FakeCore();
  const ac = new AbortController();
  st.always("POST /kb/google/sync", () => {
    if (st.calls.length === 2) ac.abort();
    return { status: 200, body: { accountId: ACCT, product: "gcal", pending: true, events: 10, cancelled: 0, calendars: [] } };
  });
  const sp = await runProductSync(ACCT, "gcal", { core: st, signal: ac.signal, onProgress: () => {} });
  assert.equal(sp.phase, "cancelled");
  assert.equal(sp.passes, 1, "the pass in flight when Stop was pressed is not counted (the core may still finish it)");

  // A pending run that changes nothing twice in a row ends (no endless loop), still saying more is left.
  const stall = new FakeCore();
  stall.always("POST /kb/google/sync", ok({ accountId: ACCT, product: "gcal", pending: true, events: 0, cancelled: 0, calendars: [] }));
  const sl = await runProductSync(ACCT, "gcal", { core: stall, signal: never, onProgress: () => {} });
  assert.equal(sl.phase, "done");
  assert.equal(sl.passes, 2);
  assert.equal(sl.more, true);
  assert.match(syncMessage(sl), /more is left: sync again/);
  assert.equal(addPass(idleSync("gdrive"), decodeSync(GDRIVE)).items, 4);
});

test("sync: every error is a plain code; 409 running and reconnect do not retry; rate limit starts a cooldown; resync flags are worded", async () => {
  for (const [reply, want] of [[err(409, "GOOGLE_SYNC_RUNNING"), "sync_running"], [err(409, "GOOGLE_RECONNECT_NEEDED"), "reconnect_needed"], [err(429, "GOOGLE_RATE_LIMITED"), "rate_limited"], [err(502, "GOOGLE_HTTP_ERROR"), "upstream"], [err(400, "VALIDATION_FAILED"), "validation"]] as [Reply, string][]) {
    const core = new FakeCore();
    core.always("POST /kb/google/sync", reply);
    const p = await runProductSync(ACCT, "gcal", { core, signal: never, onProgress: () => {} });
    assert.equal(p.phase, "error");
    assert.equal(p.error, want);
    assert.equal(core.to("/kb/google/sync").length, 1, "an error ends the run: no client-side retry loop");
  }
  const after = new FakeCore();
  after.queue("POST /kb/google/sync", ok({ accountId: ACCT, product: "gcal", pending: true, events: 5, cancelled: 0, calendars: [{ calendarId: "primary", mode: "full", events: 5, cancelled: 0, resynced: true, pending: true }] }), err(429, "GOOGLE_RATE_LIMITED"));
  const p = await runProductSync(ACCT, "gcal", { core: after, signal: never, onProgress: () => {} });
  assert.equal(p.error, "rate_limited");
  assert.equal(p.items, 5, "the counts of passes that finished are kept");
  assert.match(syncMessage(p), /5 events indexed.*re-read from scratch/);
  assert.equal(cooldownUntil(p.error, 0), 60_000);
});

// ---- routes: what is sent --------------------------------------------------------------------------

test("routes: ids are validated before a request, folder parents are restricted, nothing carries a token", async () => {
  const core = new FakeCore();
  core.always("GET /kb/google/drive/folders", ok({ folders: [] }));
  core.always("POST /kb/google/gmail/fetch", batch([]));
  await googleDriveFolders(core, ACCT, null, never);
  await googleDriveFolders(core, ACCT, "folderTick1", never);
  await googleDriveFolders(core, ACCT, "../../x&accountId=evil", never);
  assert.deepEqual(core.calls.map((c) => c.path), [
    `/kb/google/drive/folders?accountId=${ACCT}`,
    `/kb/google/drive/folders?accountId=${ACCT}&parent=folderTick1`,
    `/kb/google/drive/folders?accountId=${ACCT}`,
  ]);
  await assert.rejects(googleGmailFetch(core, "../x", never), (e: unknown) => e instanceof GoogleError && e.code === "validation");
  await assert.rejects(googleDriveFolders(core, "ZZ", null, never), GoogleError);
  assert.equal(core.calls.length, 3, "an invalid id never reaches the core");
  for (const c of core.calls) assert.ok(!/token|secret|authorization/i.test(JSON.stringify(c)));
  // start without a client sends no client fields at all.
  const c2 = new FakeCore();
  c2.always("POST /kb/google/start", ok(START_OK));
  await googleStart(c2, { products: ["gmail"], driveContent: false, accountId: ACCT }, never);
  assert.deepEqual(c2.calls[0]!.body, { products: ["gmail"], driveContent: false, accountId: ACCT });
  assert.equal(PRODUCTS.length, 3);
});
