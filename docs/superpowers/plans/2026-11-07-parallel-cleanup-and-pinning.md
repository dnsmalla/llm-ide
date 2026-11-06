# Parallel cleanup, fetch pinning and master-plan re-baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dead web relay client, put every remaining unpinned outbound `fetch` in `extension/` behind the pinned fetch with a per-call host allowlist, no redirects and a size cap, and re-baseline MASTER-PLAN and USER-NEEDS so no open row is measured against the retired Swift Mac app.

**Architecture:** Three independent parts. Part 1 moves the four byte helpers the offline sync code still uses (`web/src/relay/wire.ts`) into `web/src/sync/wire.ts` and deletes the relay client and its tests. Part 2 adds one small wrapper, `extension/server/fixed-host-fetch.mjs`, on top of the existing `makePinnedFetch()` (DNS pinned per socket, every address classified). It adds an exact host list, refuses any 3xx so a credential never reaches another host, and caps the response bytes. The Jev call and the nine literal-host call sites then route through it, and the reviewed allowlist in `extension/tests/provider-fetch-pinned-guard.test.mjs` loses every `bareFetch` row. Part 3 edits named rows in two docs and reruns their generators.

**Tech Stack:** Node 20+ ESM with `node:test`, WHATWG `fetch`/`Response`/`TransformStream` (built into Node), TypeScript run by `node --experimental-strip-types` (web tests), `tsc --noEmit` for the web typecheck.

**Spec:** this plan's request (2026-11-07, recorded in the Global Constraints below); [MASTER-PLAN S9 "Provider and connector fetch pinning"](../MASTER-PLAN.md); [status audit section (e)](2026-10-31-status-audit.md) (call sites and risk per row); [next-steps item A4](2026-11-07-next-steps.md) (re-baseline); [ADR 0020](../../decisions/0020-box-encrypted-sync.md) "What is kept, parked" (relay format stays, relay code goes).

## Global Constraints

- **Runs in parallel with another agent** that implements `plans/2026-11-07-hosted-issue-writes.md` and then `plans/2026-11-07-desktop-capture-archivist.md`. A third agent polishes `ui/screens/settings/**`.
- **Do not touch** (create, modify or delete) any of these files. They are the union of both parallel plans' Files sections plus the settings screens:
  - `extension/server.mjs`, `extension/kb/sources.mjs`, `extension/kb/db.mjs`, `extension/routes/issue-writes.mjs`, `extension/routes/issue-schedule.mjs`, `extension/routes/feature-routes.mjs`, `extension/routes/router.mjs`, `extension/routes/live.mjs`, `extension/agents/live-sessions.mjs`
  - `extension/server/pinned-fetch.mjs` (it is read-only in this plan: import it, never edit it), `extension/server/vault.mjs`, `extension/server/route-http.mjs`, `extension/core/host-approval.mjs`, `extension/core/utils.mjs`, `extension/connectors/issues.mjs`
  - `extension/src/lib/api-types.ts`, `extension/src/lib/config.ts`, `extension/manifest.json`, `extension/CLAUDE.md`
  - `extension/tests/kb-ticket-lookup.test.mjs`, `extension/tests/issue-writes.test.mjs`, `extension/tests/feature-routes.test.mjs`, `extension/tests/rate-limit-profile-query.test.mjs`, `extension/tests/live-capture-archivist.test.mjs`, `extension/tests/http-contract-live.test.mjs`
  - `schema/http/kb-sources.schema.json`, `schema/http/lifecycle.schema.json`, `schema/http/fixtures/kb-sources/post-kb-issues-*.json`, `schema/http/fixtures/lifecycle/get-kb-live-id-capture-200.json`, `schema/http/fixtures/lifecycle/get-kb-live-id-capture-404.json`, `schema/http/INVENTORY.md`, `docs/reference/api/openapi.yaml`, `scripts/http-inventory.mjs`
  - `ui/screens/shell/core-api-floor.ts`, `ui/screens/issues/IssuesScreen.tsx`, `ui/screens/issues/tests/screen-wiring.test.ts`, `ui/screens/settings/**`
  - `desktop/src-tauri/src/capture_store.rs`, `desktop/src-tauri/src/capture_archivist.rs`, `desktop/src-tauri/src/chat_archive.rs`, `desktop/src-tauri/src/chat_cmds.rs`, `desktop/src-tauri/src/core_host.rs`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/tauri.conf.json`, `desktop/PACKAGING.md`
  - `docs/spec/api-server.md`, `docs/spec/cross-cutting.md`, `docs/explanation/invariants.md`, `docs/kits/capture-kit.md`, `docs/superpowers/plans/2026-11-05-desktop-live-capture.md`, `docs/superpowers/plans/2026-11-07-hosted-issue-writes.md`, `docs/superpowers/plans/2026-11-07-desktop-capture-archivist.md`
- **One shared file: `docs/superpowers/MASTER-PLAN.md`.** Both parallel plans edit one row each in it: S5 "Desktop archivist for extension captures" and S6 "Hosted issue write actions". Part 3 may edit only the rows it names below, never those two rows. Start each Part 3 MASTER-PLAN task only when `git status --porcelain docs/superpowers/MASTER-PLAN.md` prints nothing. If it prints a line, the other agent has uncommitted edits there: do the other tasks first and come back. Re-read the file right before editing. Use exact-string Edits (never a whole-file rewrite). Run `--fix`, then commit that file in the same step. Line numbers in this plan are a guide only, because the other agent's edits shift them. Match by the quoted text.
- **No HTTP contract change:** `SERVER_API_VERSION` stays as it is (the parallel plans take 116 and 117). No new or changed route, schema, fixture or generated api-types/openapi file.
- **Pinning rule for every converted call:** the call goes through `fixedHostFetch(url, init, { hosts, maxBytes })` from `extension/server/fixed-host-fetch.mjs`. `hosts` is the exact lowercase hostname list for that call. Nothing in a request (user input, API JSON) adds a host. Any 3xx is refused (`FETCH_REFUSED`), so a token in the request never reaches a `Location` host. The body is capped at `maxBytes`. Private addresses stay refused (the pinned fetch default: no `allowPrivate`).
- **Test seam:** `makePinnedFetch()` honours a test's swapped `globalThis.fetch` only when `NODE_ENV === 'test'` **and** `server/pinned-fetch.mjs` was loaded before the swap. So every test file that swaps `globalThis.fetch` around a converted call must set `process.env.NODE_ENV = 'test'` and statically `import '../server/pinned-fetch.mjs';`. Tests never touch the network.
- **Error text never carries a key:** keep each call site's existing `redactWithKey` / `redactSecrets` handling. The wrapper's own messages name only the status or the byte cap, never a URL.
- Module boundaries (ESLint allow-table, zero violations): the new file lives in `server/` (L2) and imports only `./pinned-fetch.mjs`. Callers in `providers/`, `connectors/`, `agents/` may import L2.
- `schema/relay/v1/` and `scripts/relay-reference.mjs` stay. `scripts/sync-vectors.mjs` builds the sync vectors on `relay-reference.mjs` and reads `schema/relay/v1/vectors/v1.json`; `extension/tests/helpers/sync-reference.mjs` imports `relay-reference.mjs`; `web/tests/sync-envelope.test.mjs` runs every relay v1 negative against the web sync envelope; `make relay-check` is part of `contract-gates`.
- Commit on `main`, one concern per commit, Conventional Commits, each message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push. No subagent spawns its own subagents.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `web/src/sync/wire.ts` | Create (moved from `web/src/relay/wire.ts`, trimmed) | Canonical encoding, padding, base64url for the sync envelope |
| `web/src/sync/{envelope,enroll,device,box-store}.ts` | Modify (import line) | Import `./wire.ts` |
| `web/src/relay/crypto.ts`, `web/src/relay/socket.ts` | Delete | The retired relay client |
| `web/tests/relay-crypto.test.mjs`, `web/tests/relay-socket.test.mjs` | Delete | Their tests (the socket one flaked on 80 ms timers) |
| `web/tests/sync-wire.test.mjs` | Create | The wire checks that `relay-crypto.test.mjs` held, plus refusals |
| `web/tests/sync-envelope.test.mjs`, `web/tests/sync-enroll.test.mjs` | Modify (import line) | Import from `../src/sync/wire.ts` |
| `docs/decisions/0020-box-encrypted-sync.md` | Modify (one sentence) | Says where the kept byte helpers now live |
| `extension/server/fixed-host-fetch.mjs` | Create | `fixedHostFetch`, `capBody`: host list, no redirects, size cap over `makePinnedFetch()` |
| `extension/tests/fixed-host-fetch.test.mjs` | Create | Unit tests with the fake transport |
| `extension/providers/runtime.mjs` | Modify (2 calls) | Anthropic Messages, buffered and streaming |
| `extension/providers/web-client.mjs` | Modify (2 calls) | Anthropic web tools, SerpAPI |
| `extension/connectors/google-oauth.mjs`, `slack-oauth.mjs`, `slack-source.mjs` | Modify (4 calls) | Google token/userinfo, Slack token, Slack Web API |
| `extension/agents/slack.mjs`, `extension/agents/github-pr.mjs` | Modify (2 calls; PR POST moved into exported `createDraftPr`) | Slack webhook, GitHub PR |
| `extension/providers/jev.mjs` | Modify (1 call) | Jev decision call, host = the configured base URL's host |
| `extension/llm_agent/tools/handlers/{web-search,fetch-url}.mjs` | Modify (1 line each) | Embedded self-tests set `NODE_ENV=test` |
| `extension/tests/provider-fetch-pinned-guard.test.mjs` | Modify | Allowlist loses every `bareFetch` row; new fixed-host assertion |
| Existing tests (listed per task) | Modify (preamble + one new test each) | Behaviour through a fake fetch |
| `docs/superpowers/plans/2026-10-31-status-audit.md` | Modify (section (e)) | Rows 1-3, 5-10 closed; row 14 points to decision D2 |
| `docs/superpowers/MASTER-PLAN.md` | Modify (named rows only) | Re-baseline; S9 pinning row |
| `docs/superpowers/USER-NEEDS.md` | Modify (named items only) | Re-baseline |

Facts this plan argues from (checked 2026-11-07 at `d47810b6`):

- `web/src/sync/{envelope,enroll,device,box-store}.ts` import only `b64u, concat, decodeEnc, enc, pad, unb64u, unpad, utf8` from `../relay/wire.ts`. `web/tests/sync-envelope.test.mjs` imports `unb64u, MAX_FRAME`; `web/tests/sync-enroll.test.mjs` imports `unb64u`. `Purpose`, `Header`, `Envelope`, `KEY_MESSAGE_CAP`, `context`, `headerFields`, `headerOf` are used only by `relay/crypto.ts` and `relay/socket.ts` (`envelope.ts` has its own private `context`/`headerFields`/`headerOf`). Nothing outside `web/tests/relay-*.test.mjs` imports `relay/crypto.ts` or `relay/socket.ts`.
- `web/README.md`, `web/DEPLOY.md`, `web/MANUAL-CHECK.md`, `web/index.html` and `web/package.json` do not mention the relay. **There is no dead relay CSP entry.** `wss:` in `web/vite.config.ts` `CSP` (and `DEPLOY.md`, the nginx vhost) is for Host API hosts the user enters (`web/src/host-api/url.ts`), and `https://llm-ide.com` is the own sync server. Both stay, and `web/tests/scaffold.test.mjs` pins them.
- The unpinned calls are exactly the `bareFetch` rows of `ALLOWED` in `extension/tests/provider-fetch-pinned-guard.test.mjs`: `providers/runtime.mjs` (2), `providers/web-client.mjs` (2), `providers/jev.mjs` (1), `connectors/google-oauth.mjs` (2), `connectors/slack-oauth.mjs` (1), `connectors/slack-source.mjs` (1), `agents/slack.mjs` (1), `agents/github-pr.mjs` (1). None of these files is on the do-not-touch list.
- The existing "manual redirect, cross-origin token drop, size cap" logic lives privately in `connectors/box.mjs` `boxFetch` and `server/tracker-fetch.mjs`. Neither takes a per-call host list for an arbitrary fixed host, so the new wrapper is the shared form for fixed hosts.
- `scripts/parity-inventory.mjs`, `scripts/extract-settings-groups.mjs`, `mac/` and `.github/workflows/mac-release.yml` no longer exist.

---

## Part 1: retire the web relay client

### Task 1: Move the sync wire helpers into `web/src/sync/` and delete the relay client (~30 min)

**Files:**
- Create: `web/src/sync/wire.ts` (via `git mv web/src/relay/wire.ts web/src/sync/wire.ts`, then trimmed)
- Create: `web/tests/sync-wire.test.mjs`
- Modify: `web/src/sync/envelope.ts:4`, `web/src/sync/enroll.ts:4`, `web/src/sync/device.ts:4`, `web/src/sync/box-store.ts:7`
- Modify: `web/tests/sync-envelope.test.mjs:9`, `web/tests/sync-enroll.test.mjs:10`
- Modify: `docs/decisions/0020-box-encrypted-sync.md:126-127`
- Delete: `web/src/relay/crypto.ts`, `web/src/relay/socket.ts`, `web/tests/relay-crypto.test.mjs`, `web/tests/relay-socket.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `web/src/sync/wire.ts` exporting `MAX_FRAME: number`, `utf8(s: string): Uint8Array`, `concat(...parts: Uint8Array[]): Uint8Array`, `enc(fields: ReadonlyArray<number | string | Uint8Array>): Uint8Array`, `decodeEnc(b: Uint8Array, count: number): Uint8Array[]`, `pad(b: Uint8Array): Uint8Array`, `unpad(b: Uint8Array): Uint8Array`, `b64u(b: Uint8Array): string`, `unb64u(s: string): Uint8Array`. Byte behaviour is identical to the old `relay/wire.ts`.

- [ ] **Step 1: Write the failing test** `web/tests/sync-wire.test.mjs`

```js
// The sync wire primitives (web/src/sync/wire.ts) against the relay v1 vectors that sync v1 builds on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enc, decodeEnc, pad, unpad, b64u, unb64u, MAX_FRAME } from '../src/sync/wire.ts';

const V = JSON.parse(readFileSync(new URL('../../schema/relay/v1/vectors/v1.json', import.meta.url), 'utf8'));
const hex = (u) => Buffer.from(u).toString('hex');

test('canonical encoding and padding match the relay v1 vectors', () => {
  assert.equal(hex(enc(V.canonical.fields)), V.canonical.hex);
  const frame = new TextEncoder().encode(V.envelope.frame);
  const padded = pad(frame);
  assert.equal(padded.length, V.padding.bucket);
  assert.deepEqual(unpad(padded), frame);
});

test('decodeEnc inverts enc and refuses a wrong count or a truncated buffer', () => {
  const b = enc(['a', 7, new Uint8Array([1, 2])]);
  assert.equal(decodeEnc(b, 3).length, 3);
  assert.throws(() => decodeEnc(b, 2), /bad_encoding/);
  assert.throws(() => decodeEnc(b.subarray(0, b.length - 1), 3), /bad_encoding/);
});

test('padding refuses an oversized frame, a non-bucket length and non-zero filler', () => {
  assert.throws(() => pad(new Uint8Array(MAX_FRAME + 1)), /frame_too_large/);
  assert.throws(() => unpad(new Uint8Array(1000)), /bad_padding/);
  const p = pad(new Uint8Array([1]));
  p[p.length - 1] = 9;
  assert.throws(() => unpad(p), /bad_padding/);
});

test('base64url round-trips and refuses the standard alphabet', () => {
  const b = new Uint8Array([0, 251, 255, 62, 63]);
  assert.deepEqual(unb64u(b64u(b)), b);
  assert.doesNotMatch(b64u(b), /[+/=]/);
  assert.throws(() => unb64u('a+b/'), /bad_base64/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/web && node --test --experimental-strip-types tests/sync-wire.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/sync/wire.ts`.

- [ ] **Step 3: Move the file and keep only what sync uses**

Run: `cd /Users/dinsmallade/llm-ide && git mv web/src/relay/wire.ts web/src/sync/wire.ts`

Then replace the whole content of `web/src/sync/wire.ts` with:

```ts
// Byte primitives of the relay v1 envelope format (schema/relay/v1) that sync v1 builds on (schema/sync/v1):
// canonical encoding, padding buckets, base64url. Pure, DOM-free. Moved from web/src/relay/ when the relay
// client was removed (ADR 0020); the bytes are unchanged and checked against the relay v1 vectors.
const BUCKETS = [1024, 4096, 16384, 65536, 262144, 1048576] as const;
export const MAX_FRAME = 1048576 - 4;
const te = new TextEncoder();

export const utf8 = (s: string): Uint8Array => te.encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function enc(fields: ReadonlyArray<number | string | Uint8Array>): Uint8Array {
  return concat(...fields.flatMap((f) => {
    let v: Uint8Array;
    if (typeof f === "number") {
      if (!Number.isSafeInteger(f) || f < 0) throw new Error("bad_integer");
      v = new Uint8Array(8); new DataView(v.buffer).setBigUint64(0, BigInt(f));
    } else v = typeof f === "string" ? utf8(f) : f;
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, v.length);
    return [len, v];
  }));
}

export function decodeEnc(b: Uint8Array, count: number): Uint8Array[] {
  const out: Uint8Array[] = []; const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); let off = 0;
  while (off < b.length) {
    if (off + 4 > b.length) throw new Error("bad_encoding");
    const n = dv.getUint32(off); off += 4;
    if (off + n > b.length) throw new Error("bad_encoding");
    out.push(b.subarray(off, off + n)); off += n;
  }
  if (out.length !== count) throw new Error("bad_encoding");
  return out;
}

export function pad(b: Uint8Array): Uint8Array {
  if (b.length > MAX_FRAME) throw new Error("frame_too_large");
  const out = new Uint8Array(BUCKETS.find((s) => s >= b.length + 4)!);
  new DataView(out.buffer).setUint32(0, b.length); out.set(b, 4);
  return out;
}

export function unpad(b: Uint8Array): Uint8Array {
  if (!(BUCKETS as readonly number[]).includes(b.length)) throw new Error("bad_padding");
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
  if (n > b.length - 4) throw new Error("bad_padding");
  for (let i = 4 + n; i < b.length; i++) if (b[i] !== 0) throw new Error("bad_padding");
  return b.subarray(4, 4 + n);
}

export function b64u(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad_base64");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
```

- [ ] **Step 4: Point the sync code and its tests at the new path**

In each of `web/src/sync/envelope.ts`, `web/src/sync/enroll.ts`, `web/src/sync/device.ts`, `web/src/sync/box-store.ts`, replace `from "../relay/wire.ts";` with `from "./wire.ts";` (one occurrence per file; the imported names stay the same).

In `web/tests/sync-envelope.test.mjs` replace `import { unb64u, MAX_FRAME } from '../src/relay/wire.ts';` with `import { unb64u, MAX_FRAME } from '../src/sync/wire.ts';`.

In `web/tests/sync-enroll.test.mjs` replace `import { unb64u } from '../src/relay/wire.ts';` with `import { unb64u } from '../src/sync/wire.ts';`.

- [ ] **Step 5: Delete the relay client and its tests**

Run:
```bash
cd /Users/dinsmallade/llm-ide
git rm web/src/relay/crypto.ts web/src/relay/socket.ts web/tests/relay-crypto.test.mjs web/tests/relay-socket.test.mjs
test ! -e web/src/relay && echo "relay dir gone"
```
Expected: `relay dir gone`.

- [ ] **Step 6: ADR 0020 says where the kept helpers live**

In `docs/decisions/0020-box-encrypted-sync.md`, replace:
```
the relay v1 byte format sync builds on: `schema/relay/v1` and `scripts/relay-reference.mjs` (plus the web
copy under `web/src/relay/`). The VPS units are retired with the one-time note in `deploy/vps/README.md`.
```
with:
```
the relay v1 byte format sync builds on: `schema/relay/v1` and `scripts/relay-reference.mjs` (plus its byte
helpers in `web/src/sync/wire.ts`; the web relay client was removed 2026-11-07). The VPS units are retired with the one-time note in `deploy/vps/README.md`.
```

- [ ] **Step 7: Run the web tests, the typecheck and the reference checks**

Run:
```bash
cd /Users/dinsmallade/llm-ide/web && npm test 2>&1 | tail -8 && npx tsc --noEmit -p . && echo TSC-OK
cd /Users/dinsmallade/llm-ide && make relay-check && node scripts/sync-vectors.mjs && echo VECTORS-OK
grep -rn "src/relay\|relay/wire\|relay/crypto\|relay/socket\|createRelaySocket" web/src web/tests web/scripts web/README.md web/DEPLOY.md || echo "no relay client references"
```
Expected: web tests `fail 0` (sync-wire, sync-envelope and sync-enroll among them), `TSC-OK`, relay-check passes, `VECTORS-OK`, `no relay client references`.

- [ ] **Step 8: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add web/src/sync web/tests/sync-wire.test.mjs web/tests/sync-envelope.test.mjs web/tests/sync-enroll.test.mjs docs/decisions/0020-box-encrypted-sync.md
git commit -m "refactor(web): retire the relay client, keep the sync wire helpers

The relay was retired by ADR 0020 and removed from core and desktop in
3891a2d5. web/src/relay/crypto.ts and socket.ts had no caller left but
their tests (the socket test flaked on 80 ms timers). The sync envelope
still uses the relay v1 byte helpers, so wire.ts moves to web/src/sync/
with only those exports and its own vector test. schema/relay/v1 and
scripts/relay-reference.mjs stay: sync vectors and checks build on them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part 2: close the fetch-pinning gaps

### Task 2: The fixed-host fetch wrapper (~25 min)

**Files:**
- Create: `extension/server/fixed-host-fetch.mjs`
- Test: `extension/tests/fixed-host-fetch.test.mjs`

**Interfaces:**
- Consumes: `makePinnedFetch()` and `_setPinnedFetchForTests(fn)` from `extension/server/pinned-fetch.mjs` (unchanged).
- Produces: `fixedHostFetch(input: string | URL, init?: RequestInit, o: { hosts: string[], maxBytes?: number }): Promise<Response>`. It throws `Error` with `code: 'FETCH_REFUSED'` for a host outside `hosts`, a non-https URL, a URL with userinfo, a port other than 443, an empty `hosts`, or any 3xx answer (message `fixed-host fetch refused: redirect <status> not followed`). Reading more than `maxBytes` (default `DEFAULT_MAX_BYTES` = 1 MiB) of the body fails with `FETCH_REFUSED` (message `... response larger than <n> bytes`). It always sends `redirect: 'manual'` to the pinned fetch and passes the normalised `url.href`. Also exports `capBody(res, maxBytes)` and `DEFAULT_MAX_BYTES`.

- [ ] **Step 1: Write the failing test** `extension/tests/fixed-host-fetch.test.mjs`

```js
// server/fixed-host-fetch.mjs: exact host list, no redirects, response size cap, over the pinned fetch.
// The transport is faked with _setPinnedFetchForTests; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { fixedHostFetch, capBody } = await import('../server/fixed-host-fetch.mjs');
const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');

const HOSTS = { hosts: ['api.example.com'] };
function fake(respond) {
  const calls = [];
  _setPinnedFetchForTests(async (url, init) => { calls.push({ url, init }); return respond(url, init); });
  return calls;
}
const why = (e) => `${e?.message} ${e?.cause?.message ?? ''}`;

test('refuses another host, plain http, userinfo, an odd port, a bad URL and an empty list, before any request', async () => {
  const calls = fake(() => new Response('{}'));
  try {
    for (const url of ['https://evil.example/x', 'http://api.example.com/x', 'https://u:p@api.example.com/x',
      'https://api.example.com:8443/x', 'https://api.example.com.evil.example/x', 'not a url']) {
      await assert.rejects(fixedHostFetch(url, {}, HOSTS), (e) => e.code === 'FETCH_REFUSED', url);
    }
    await assert.rejects(fixedHostFetch('https://api.example.com/x', {}, { hosts: [] }), (e) => e.code === 'FETCH_REFUSED');
    assert.equal(calls.length, 0);
  } finally { _setPinnedFetchForTests(null); }
});

test('passes the request through with redirect manual and the normalised URL', async () => {
  const calls = fake(() => new Response('{"ok":true}', { status: 200, headers: { 'x-a': '1' } }));
  try {
    const res = await fixedHostFetch('https://API.example.com/v1?q=1',
      { method: 'POST', headers: { Authorization: 'Bearer t' }, body: 'b', redirect: 'follow' }, HOSTS);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-a'), '1');
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(calls[0].url, 'https://api.example.com/v1?q=1');
    assert.equal(calls[0].init.redirect, 'manual', 'a caller cannot turn redirects back on');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
  } finally { _setPinnedFetchForTests(null); }
});

test('a redirect is never followed, so the credential never reaches the Location host', async () => {
  const calls = fake(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
  try {
    await assert.rejects(fixedHostFetch('https://api.example.com/x', { headers: { Authorization: 'Bearer t' } }, HOSTS),
      (e) => e.code === 'FETCH_REFUSED' && /redirect 302 not followed/.test(e.message));
    assert.equal(calls.length, 1);
  } finally { _setPinnedFetchForTests(null); }
});

test('a body over the cap fails while reading; one at the cap reads in full', async () => {
  fake(() => new Response('x'.repeat(10)));
  try {
    const big = await fixedHostFetch('https://api.example.com/x', {}, { ...HOSTS, maxBytes: 4 });
    await assert.rejects(big.text(), (e) => /larger than 4 bytes/.test(why(e)));
    const ok = await fixedHostFetch('https://api.example.com/x', {}, { ...HOSTS, maxBytes: 10 });
    assert.equal(await ok.text(), 'x'.repeat(10));
  } finally { _setPinnedFetchForTests(null); }
});

test('a test double that is not a Response passes through untouched', () => {
  const plain = { ok: true, status: 200, json: async () => ({}) };
  assert.equal(capBody(plain, 1), plain);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/fixed-host-fetch.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/fixed-host-fetch.mjs`.

- [ ] **Step 3: Write the wrapper** `extension/server/fixed-host-fetch.mjs`

```js
// Pinned fetch for a call whose host is fixed: by code (api.anthropic.com, slack.com, ...) or by the operator
// (JEV_AI_BASE_URL). On top of server/pinned-fetch.mjs (DNS resolved once by the socket, every address
// classified, only the checked address dialled, private targets refused) it adds, per call:
//   - an exact host list: https only, port 443, no userinfo, hostname in `hosts`;
//   - no redirects: the 3xx comes back (redirect 'manual') and is refused here, so a key or token in the
//     request never reaches a Location host (the cross-origin token drop in its strictest form);
//   - a response size cap: reading past `maxBytes` fails with FETCH_REFUSED.
// makePinnedFetch() is called per request so its NODE_ENV=test seam sees a test's fake transport.
import { makePinnedFetch } from './pinned-fetch.mjs';

export const DEFAULT_MAX_BYTES = 1024 * 1024;

function refuse(msg) {
  return Object.assign(new Error(`fixed-host fetch refused: ${msg}`), { code: 'FETCH_REFUSED' });
}

/** The parsed URL when it is https on 443 to a listed host and carries no userinfo, else null. */
function allowedUrl(input, hosts) {
  let u;
  try { u = new URL(String(input)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  return hosts.includes(u.hostname.toLowerCase()) ? u : null;
}

/** Wraps a Response so that reading more than `maxBytes` of its body fails. */
export function capBody(res, maxBytes) {
  // shortcut: test doubles are plain objects ({ ok, json }); the real pinned fetch always returns a Response.
  if (!(res instanceof Response) || !res.body) return res;
  let seen = 0;
  const body = res.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > maxBytes) ctl.error(refuse(`response larger than ${maxBytes} bytes`));
      else ctl.enqueue(chunk);
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * @param {string | URL} input
 * @param {RequestInit} [init]
 * @param {{ hosts: string[], maxBytes?: number }} o  lowercase hostnames this one call may reach
 * @returns {Promise<Response>}
 */
export async function fixedHostFetch(input, init = {}, { hosts, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Array.isArray(hosts) || hosts.length === 0) throw refuse('no host allowlist');
  const url = allowedUrl(input, hosts);
  if (!url) throw refuse('host not allowed');
  const res = await makePinnedFetch()(url.href, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw refuse(`redirect ${res.status} not followed`);
  }
  return capBody(res, maxBytes);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/fixed-host-fetch.test.mjs tests/provider-fetch-pinned-guard.test.mjs && npx eslint server/fixed-host-fetch.mjs`
Expected: PASS (5 + the guard's tests), eslint prints nothing. The guard still passes because the new file has no bare `fetch(`.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/server/fixed-host-fetch.mjs extension/tests/fixed-host-fetch.test.mjs
git commit -m "feat(server): fixed-host fetch over the pinned fetch

Exact host list, any 3xx refused so a credential never reaches another
host, and a response byte cap. The shared form for the literal-host and
operator-host calls the status audit (e) lists as unpinned.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Anthropic and SerpAPI calls (`runtime.mjs`, `web-client.mjs`) (~35 min)

**Files:**
- Modify: `extension/providers/runtime.mjs` (import after line 13; constants after line 67; calls at ~429 and ~713)
- Modify: `extension/providers/web-client.mjs` (import after line 16; constant after line 32; calls at ~53 and ~196)
- Modify: `extension/llm_agent/tools/handlers/web-search.mjs:69`, `extension/llm_agent/tools/handlers/fetch-url.mjs:60`
- Test: `extension/tests/provider-fetch-pinned-guard.test.mjs` (ALLOWED), `extension/tests/agents-runtime.test.mjs` (append), `extension/tests/web-client.test.mjs` (append)
- Test preamble only: `extension/tests/agents-runtime-backoff.test.mjs`, `anthropic-stream-usage.test.mjs`, `agents-runtime.test.mjs`, `custom-provider-dispatch.test.mjs`, `runtime-provider-routing.test.mjs`, `tier-routing.test.mjs`, `usage-metering.test.mjs`

**Interfaces:**
- Consumes: `fixedHostFetch(input, init, { hosts, maxBytes })` from Task 2.
- Produces: no new exports. `runClaude`, `runClaudeStream`, `searchWebViaAnthropic`, `fetchUrlViaAnthropic` and `searchWeb` keep their signatures. A 3xx from `api.anthropic.com` or `serpapi.com` now rejects with `fixed-host fetch refused: redirect <status> not followed`. On a user-scoped key it propagates as before; on the operator key `runClaude` falls back to the CLI as it does for any thrown fetch error.

- [ ] **Step 1: Make the guard fail: drop the two allowlist rows**

In `extension/tests/provider-fetch-pinned-guard.test.mjs`, delete these two lines from `ALLOWED`:
```js
  'providers/runtime.mjs': { bareFetch: { n: 2, why: 'api.anthropic.com, a fixed code-owned host (no user-supplied URL)' } },
  'providers/web-client.mjs': { bareFetch: { n: 2, why: 'api.anthropic.com (fixed) and serpapi.com (fixed, optional search fallback). The direct page fetch uses the pinned fetch' } },
```

- [ ] **Step 2: Write the behaviour tests**

Prepare each of these seven test files: `agents-runtime-backoff`, `anthropic-stream-usage`, `agents-runtime`, `custom-provider-dispatch`, `runtime-provider-routing`, `tier-routing` and `usage-metering` (all `extension/tests/<name>.test.mjs`). Directly after the `node:assert` import line, add:
```js
// Load the pinned fetch before any test swaps globalThis.fetch: its NODE_ENV=test seam honours a swap
// only when the module saw the original fetch first.
import '../server/pinned-fetch.mjs';
```
In `agents-runtime-backoff.test.mjs` and `anthropic-stream-usage.test.mjs` (they do not set it yet), also add this line right after that import:
```js
process.env.NODE_ENV = 'test';
```

Append to `extension/tests/agents-runtime.test.mjs`:
```js
test('a user-scoped key: a redirect from api.anthropic.com is refused on both paths and the CLI never runs', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `runtime-redirect-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'r',
  });
  vault.setSecret(db.getDb(), u.id, 'claude.apiKey', 'sk-user-scoped-xyz');
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), redirect: init.redirect });
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
  };
  const execSpy = mock.method(childProcess, 'execFile', () => {
    throw new Error('execFile MUST NOT be called when user-scoped key fails');
  });
  const { runClaude, runClaudeStream } = await import('../providers/runtime.mjs');
  try {
    await assert.rejects(() => runClaude('hello', { userId: u.id }), /redirect 302 not followed/);
    await assert.rejects(() => runClaudeStream('hello', { userId: u.id, onChunk: () => {} }), /redirect 302 not followed/);
    assert.ok(seen.length >= 2);
    for (const s of seen) assert.deepEqual(s, { url: 'https://api.anthropic.com/v1/messages', redirect: 'manual' });
    assert.equal(execSpy.mock.callCount(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    execSpy.mock.restore();
  }
});
```

Append to `extension/tests/web-client.test.mjs`:
```js
test('Anthropic web tools and SerpAPI reach only their fixed host and refuse a redirect', async () => {
  const seen = [];
  const restore = mockFetch(async (url, init) => {
    seen.push({ host: new URL(String(url)).hostname, redirect: init.redirect });
    return new Response(null, { status: 301, headers: { location: 'https://evil.example/' } });
  });
  try {
    await assert.rejects(() => searchWebViaAnthropic('q', { apiKey: 'sk-ant-test' }), /redirect 301 not followed/);
    await assert.rejects(() => fetchUrlViaAnthropic('https://example.com/', { apiKey: 'sk-ant-test' }), /redirect 301 not followed/);
    await assert.rejects(() => searchWeb('q', { apiKey: 'serp-key' }), /redirect 301 not followed/);
    assert.deepEqual(seen, [
      { host: 'api.anthropic.com', redirect: 'manual' },
      { host: 'api.anthropic.com', redirect: 'manual' },
      { host: 'serpapi.com', redirect: 'manual' },
    ]);
  } finally { restore(); }
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/provider-fetch-pinned-guard.test.mjs tests/agents-runtime.test.mjs tests/web-client.test.mjs`
Expected: FAIL. The guard reports `providers/runtime.mjs: 2x bareFetch. Use makePinnedFetch()`. The two new tests fail on the error message, because the old code reads the 302 as a non-ok HTTP status and does not throw `redirect 302 not followed`.

- [ ] **Step 4: Route `runtime.mjs` through the wrapper**

After the line `import { recordUsage, flagQuota, resolveModel as resolveUsageModel, recordRateLimits, noteUnmeteredModelCall } from '../kb/usage.mjs';` add:
```js
import { fixedHostFetch } from '../server/fixed-host-fetch.mjs';
```
After the line `const ANTHROPIC_VERSION = process.env.LLMIDE_ANTHROPIC_VERSION || '2023-06-01';` add:
```js
// Pinned, no redirects (the key rides in x-api-key), capped: a long buffered reply or a whole SSE stream fits.
const ANTHROPIC_HOSTS = ['api.anthropic.com'];
const ANTHROPIC_MAX_BYTES = 32 * 1024 * 1024;
```
Buffered call: replace `        const response = await fetch('https://api.anthropic.com/v1/messages', {` with `        const response = await fixedHostFetch('https://api.anthropic.com/v1/messages', {`. Then replace the call's closing lines
```js
            : AbortSignal.timeout(SOCKET_HANG_BREAKER_MS)
        });
```
with
```js
            : AbortSignal.timeout(SOCKET_HANG_BREAKER_MS)
        }, { hosts: ANTHROPIC_HOSTS, maxBytes: ANTHROPIC_MAX_BYTES });
```
Streaming call: replace `      response = await fetch('https://api.anthropic.com/v1/messages', {` with `      response = await fixedHostFetch('https://api.anthropic.com/v1/messages', {`. Then replace
```js
        signal: signal || AbortSignal.timeout(SOCKET_HANG_BREAKER_MS),
      });
```
with
```js
        signal: signal || AbortSignal.timeout(SOCKET_HANG_BREAKER_MS),
      }, { hosts: ANTHROPIC_HOSTS, maxBytes: ANTHROPIC_MAX_BYTES });
```

- [ ] **Step 5: Route `web-client.mjs` through the wrapper**

After `import { makePinnedFetch } from '../server/pinned-fetch.mjs';` add:
```js
import { fixedHostFetch } from '../server/fixed-host-fetch.mjs';
```
After `const ANTHROPIC_VERSION = process.env.LLMIDE_ANTHROPIC_VERSION || '2023-06-01';` add:
```js
const WEB_TOOL_MAX_BYTES = 8 * 1024 * 1024; // one Messages reply with web tool results
const SERPAPI_MAX_BYTES = 2 * 1024 * 1024;
```
In `runAnthropicWebTool`, replace `    const res = await fetch('https://api.anthropic.com/v1/messages', {` with `    const res = await fixedHostFetch('https://api.anthropic.com/v1/messages', {`. Then replace
```js
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
```
with
```js
      signal: signal || AbortSignal.timeout(timeoutMs),
    }, { hosts: ['api.anthropic.com'], maxBytes: WEB_TOOL_MAX_BYTES });
```
In `searchWeb`, replace `    const res = await fetch(url.toString(), { signal: controller.signal });` with:
```js
    const res = await fixedHostFetch(url.toString(), { signal: controller.signal }, { hosts: ['serpapi.com'], maxBytes: SERPAPI_MAX_BYTES });
```

- [ ] **Step 6: Keep the embedded self-tests off the network**

In both `extension/llm_agent/tools/handlers/web-search.mjs` and `extension/llm_agent/tools/handlers/fetch-url.mjs`, replace
```js
export async function runTests() {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
```
with
```js
export async function runTests() {
  process.env.NODE_ENV = 'test'; // the pinned fetch honours the swapped globalThis.fetch below only in test mode
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run:
```bash
cd /Users/dinsmallade/llm-ide/extension
node --test tests/provider-fetch-pinned-guard.test.mjs tests/agents-runtime.test.mjs tests/web-client.test.mjs \
  tests/agents-runtime-backoff.test.mjs tests/anthropic-stream-usage.test.mjs tests/custom-provider-dispatch.test.mjs \
  tests/runtime-provider-routing.test.mjs tests/tier-routing.test.mjs tests/usage-metering.test.mjs tests/jev-decisions.test.mjs
d=$(mktemp -d) && LLMIDE_DATA_DIR="$d" node llm_agent/tools/handlers/web-search.mjs && LLMIDE_DATA_DIR="$d" node llm_agent/tools/handlers/fetch-url.mjs; rm -rf "$d"
npx eslint providers/runtime.mjs providers/web-client.mjs llm_agent/tools/handlers/web-search.mjs llm_agent/tools/handlers/fetch-url.mjs
```
Expected: all `node --test` files PASS. Each self-test line starts with `✓`. eslint prints nothing.

- [ ] **Step 8: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/providers/runtime.mjs extension/providers/web-client.mjs extension/llm_agent/tools/handlers/web-search.mjs extension/llm_agent/tools/handlers/fetch-url.mjs extension/tests/provider-fetch-pinned-guard.test.mjs extension/tests/agents-runtime.test.mjs extension/tests/web-client.test.mjs extension/tests/agents-runtime-backoff.test.mjs extension/tests/anthropic-stream-usage.test.mjs extension/tests/custom-provider-dispatch.test.mjs extension/tests/runtime-provider-routing.test.mjs extension/tests/tier-routing.test.mjs extension/tests/usage-metering.test.mjs
git commit -m "fix(providers): pin the Anthropic and SerpAPI calls

runClaude, runClaudeStream, the Anthropic web tools and the SerpAPI
fallback now go through fixedHostFetch: pinned DNS, one host each, any
redirect refused, response capped. Status audit (e) rows 1 to 3.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Google OAuth, Slack OAuth and the Slack Web API (~25 min)

**Files:**
- Modify: `extension/connectors/google-oauth.mjs` (header comment lines 1-2, import, `tokenPost`, `fetchEmailAddress`)
- Modify: `extension/connectors/slack-oauth.mjs` (import at the top, `exchangeCode`)
- Modify: `extension/connectors/slack-source.mjs` (header lines 10-11, import, `slackCall`)
- Test: `extension/tests/provider-fetch-pinned-guard.test.mjs` (ALLOWED), `extension/tests/google-oauth.test.mjs`, `extension/tests/slack-oauth.test.mjs`, `extension/tests/slack-source.test.mjs` (append each)
- Test preamble only: `extension/tests/slack-ratelimit.test.mjs`, `extension/tests/email-slack-redaction.test.mjs`

**Interfaces:**
- Consumes: `fixedHostFetch` from Task 2.
- Produces: no new exports. `exchangeCode`, `refreshAccessToken` and `fetchEmailAddress` (Google), `exchangeCode` (Slack), and `testConnection`, `fetchChannelHistory` and `listUserConversations` (Slack source) keep their signatures. A 3xx rejects with `fixed-host fetch refused: redirect <status> not followed`.

- [ ] **Step 1: Make the guard fail: drop three allowlist rows**

In `extension/tests/provider-fetch-pinned-guard.test.mjs`, delete from `ALLOWED`:
```js
  'connectors/google-oauth.mjs': { bareFetch: { n: 2, why: 'Google OAuth token and userinfo endpoints (fixed hosts)' } },
  'connectors/slack-oauth.mjs': { bareFetch: { n: 1, why: 'Slack OAuth token endpoint (fixed host)' } },
  'connectors/slack-source.mjs': { bareFetch: { n: 1, why: 'slack.com Web API (fixed host)' } },
```

- [ ] **Step 2: Write the behaviour tests**

In each of `google-oauth.test.mjs`, `slack-oauth.test.mjs`, `slack-source.test.mjs`, `slack-ratelimit.test.mjs` and `email-slack-redaction.test.mjs` (under `extension/tests/`), add directly after the `node:assert` import line:
```js
// Load the pinned fetch before any test swaps global.fetch: its NODE_ENV=test seam honours a swap
// only when the module saw the original fetch first.
import '../server/pinned-fetch.mjs';
```
In the first four of those files (they do not set it yet), also add right after that import:
```js
process.env.NODE_ENV = 'test';
```

In `extension/tests/google-oauth.test.mjs`, add `fetchEmailAddress` to the existing import from `'../connectors/google-oauth.mjs'`, then append:
```js
test('Google token and userinfo calls reach only their fixed hosts and refuse a redirect', async () => {
  const orig = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), redirect: init.redirect });
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  };
  try {
    await assert.rejects(() => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', verifier: 'v', redirectUri: 'r' }), /redirect 302 not followed/);
    await assert.rejects(() => fetchEmailAddress('AT'), /redirect 302 not followed/);
    assert.deepEqual(seen, [
      { url: 'https://oauth2.googleapis.com/token', redirect: 'manual' },
      { url: 'https://openidconnect.googleapis.com/v1/userinfo', redirect: 'manual' },
    ]);
  } finally { global.fetch = orig; }
});
```

Append to `extension/tests/slack-oauth.test.mjs`:
```js
test('exchangeCode reaches only slack.com and refuses a redirect', async () => {
  const orig = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), redirect: init.redirect });
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  };
  try {
    await assert.rejects(() => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' }), /redirect 302 not followed/);
    assert.deepEqual(seen, [{ url: 'https://slack.com/api/oauth.v2.access', redirect: 'manual' }]);
  } finally { global.fetch = orig; }
});
```

In `extension/tests/slack-source.test.mjs`, add `testConnection` to the existing import from `'../connectors/slack-source.mjs'`, then append:
```js
test('the Slack Web API call reaches only slack.com and refuses a redirect with the token', async () => {
  const orig = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ host: new URL(String(url)).hostname, redirect: init.redirect });
    return new Response(null, { status: 307, headers: { location: 'https://evil.example/' } });
  };
  try {
    await assert.rejects(() => testConnection({ token: 'xoxp-1' }), /redirect 307 not followed/);
    assert.deepEqual(seen, [{ host: 'slack.com', redirect: 'manual' }]);
  } finally { global.fetch = orig; }
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/provider-fetch-pinned-guard.test.mjs tests/google-oauth.test.mjs tests/slack-oauth.test.mjs tests/slack-source.test.mjs`
Expected: FAIL. The guard reports `connectors/google-oauth.mjs: 2x bareFetch`, and the three new tests fail on the error message.

- [ ] **Step 4: Route the three connectors through the wrapper**

`extension/connectors/google-oauth.mjs`: replace the first two lines
```js
// Google OAuth2 (PKCE) for Gmail IMAP via XOAUTH2. Bring-your-own Desktop
// client. Network is global fetch to fixed Google hosts (no SSRF surface).
```
with
```js
// Google OAuth2 (PKCE) for Gmail IMAP via XOAUTH2. Bring-your-own Desktop
// client. Network goes through the pinned fixed-host fetch (one Google host per call, no redirects, capped).
```
After `import crypto from 'node:crypto';` add:
```js
import { fixedHostFetch } from '../server/fixed-host-fetch.mjs';

const OAUTH_MAX_BYTES = 64 * 1024;
```
In `tokenPost`, replace `  const res = await fetch(TOKEN_ENDPOINT, {` with `  const res = await fixedHostFetch(TOKEN_ENDPOINT, {` and its closing
```js
    body: new URLSearchParams(params).toString(),
  });
```
with
```js
    body: new URLSearchParams(params).toString(),
  }, { hosts: ['oauth2.googleapis.com'], maxBytes: OAUTH_MAX_BYTES });
```
In `fetchEmailAddress`, replace `  const res = await fetch(USERINFO, { headers: { Authorization: \`Bearer ${accessToken}\` } });` with:
```js
  const res = await fixedHostFetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } },
    { hosts: ['openidconnect.googleapis.com'], maxBytes: OAUTH_MAX_BYTES });
```

`extension/connectors/slack-oauth.mjs`: before `const AUTHORIZE_ENDPOINT = 'https://slack.com/oauth/v2/authorize';` add:
```js
import { fixedHostFetch } from '../server/fixed-host-fetch.mjs';

```
In `exchangeCode`, replace `  const res = await fetch(TOKEN_ENDPOINT, {` with `  const res = await fixedHostFetch(TOKEN_ENDPOINT, {`. Then replace
```js
      code, redirect_uri: redirectUri,
    }).toString(),
  });
```
with
```js
      code, redirect_uri: redirectUri,
    }).toString(),
  }, { hosts: ['slack.com'], maxBytes: 64 * 1024 });
```

`extension/connectors/slack-source.mjs`: replace
```js
// Host is fixed (https://slack.com/api/*), so unlike the IMAP connector there
// is no DNS resolution / SSRF surface.

const API = 'https://slack.com/api';
```
with
```js
// Host is fixed (https://slack.com/api/*) and every call goes through the pinned
// fixed-host fetch: DNS pinned, slack.com only, no redirects (the token rides in
// Authorization), replies capped at SLACK_MAX_BYTES.
import { fixedHostFetch } from '../server/fixed-host-fetch.mjs';

const API = 'https://slack.com/api';
const SLACK_MAX_BYTES = 8 * 1024 * 1024; // one conversations.history page of 200 messages with blocks
```
In `slackCall`, replace
```js
    const res = await fetch(`${API}/${method}?${qs}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
```
with
```js
    const res = await fixedHostFetch(`${API}/${method}?${qs}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal,
    }, { hosts: ['slack.com'], maxBytes: SLACK_MAX_BYTES });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
cd /Users/dinsmallade/llm-ide/extension
node --test tests/provider-fetch-pinned-guard.test.mjs tests/google-oauth.test.mjs tests/slack-oauth.test.mjs tests/slack-source.test.mjs tests/slack-ratelimit.test.mjs tests/email-slack-redaction.test.mjs tests/slack-oauth-routes.test.mjs tests/slack-oauth-routes-unconfigured.test.mjs tests/kb-router-slack.test.mjs
npx eslint connectors/google-oauth.mjs connectors/slack-oauth.mjs connectors/slack-source.mjs
```
Expected: PASS for every file; eslint prints nothing.

- [ ] **Step 6: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/connectors/google-oauth.mjs extension/connectors/slack-oauth.mjs extension/connectors/slack-source.mjs extension/tests/provider-fetch-pinned-guard.test.mjs extension/tests/google-oauth.test.mjs extension/tests/slack-oauth.test.mjs extension/tests/slack-source.test.mjs extension/tests/slack-ratelimit.test.mjs extension/tests/email-slack-redaction.test.mjs
git commit -m "fix(connectors): pin the Google and Slack OAuth and Slack API calls

Token, userinfo and Slack Web API requests go through fixedHostFetch:
one host per call, redirects refused so the token stays on its host,
replies capped. Status audit (e) rows 5 to 7.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Slack webhook and the GitHub PR call (~25 min)

**Files:**
- Modify: `extension/agents/slack.mjs` (import after line 7, `postWebhook`)
- Modify: `extension/agents/github-pr.mjs` (import after line 17, new exported `createDraftPr` before `openPullRequest`, the PR block inside `openPullRequest` at ~249-272)
- Test: `extension/tests/provider-fetch-pinned-guard.test.mjs` (ALLOWED), `extension/tests/slack.test.mjs`, `extension/tests/github-pr-validate.test.mjs` (append each)

**Interfaces:**
- Consumes: `fixedHostFetch` from Task 2; `assertSafeGhRepo(ghRepo)` (sync, existing in `github-pr.mjs`).
- Produces: `export async function createDraftPr({ ghRepo, ghToken, title, head, base, body }): Promise<object>`. It returns GitHub's parsed PR JSON. It throws `Invalid GitHub repo...` for a bad `ghRepo`, `GitHub PR API <status>: <redacted text>` for a non-2xx answer, and `FETCH_REFUSED` for a 3xx. `openPullRequest` keeps its signature and its return shape `{ branch, base, pr: { url, number, state, draft } }`. `notifySlack` keeps its signature.

- [ ] **Step 1: Make the guard fail: drop two allowlist rows**

In `extension/tests/provider-fetch-pinned-guard.test.mjs`, delete from `ALLOWED`:
```js
  'agents/slack.mjs': { bareFetch: { n: 1, why: 'Slack incoming webhook the user configured; not a model-provider path' } },
  'agents/github-pr.mjs': { bareFetch: { n: 1, why: 'api.github.com (fixed host)' } },
```

- [ ] **Step 2: Write the behaviour tests**

In `extension/tests/slack.test.mjs` and `extension/tests/github-pr-validate.test.mjs`, add directly after the `node:assert` import line:
```js
// Load the pinned fetch before any test swaps globalThis.fetch: its NODE_ENV=test seam honours a swap
// only when the module saw the original fetch first.
import '../server/pinned-fetch.mjs';
process.env.NODE_ENV = 'test';
```

Append to `extension/tests/slack.test.mjs`:
```js
test('notifySlack posts only to hooks.slack.com and refuses a redirect from it', async () => {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([String(url), init.redirect]);
    return seen.length === 1
      ? new Response('ok', { status: 200 })
      : new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  };
  try {
    const base = { webhookUrl: 'https://hooks.slack.com/services/T0/B0/X0', kind: 'custom' };
    assert.deepEqual(await notifySlack({ ...base, payload: { text: 'one' }, dedupeKey: 'pin:1' }), { ok: true, status: 200 });
    await assert.rejects(() => notifySlack({ ...base, payload: { text: 'two' }, dedupeKey: 'pin:2' }), /redirect 302 not followed/);
    assert.deepEqual(seen, [[base.webhookUrl, 'manual'], [base.webhookUrl, 'manual']]);
  } finally { globalThis.fetch = orig; }
});
```

In `extension/tests/github-pr-validate.test.mjs`, change `import { openPullRequest, assertSafeGhRepo, assertSafeBaseBranch } from '../agents/github-pr.mjs';` to `import { openPullRequest, assertSafeGhRepo, assertSafeBaseBranch, createDraftPr } from '../agents/github-pr.mjs';`, then append:
```js
test('createDraftPr posts a draft to api.github.com only and refuses a redirect', async () => {
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return seen.length === 1
      ? new Response(JSON.stringify({ html_url: 'https://github.com/o/r/pull/1', number: 1, state: 'open', draft: true }), { status: 201 })
      : new Response(null, { status: 301, headers: { location: 'https://evil.example/' } });
  };
  const args = { ghRepo: 'o/r', ghToken: 'ghp_test', title: 't', head: 'h', base: 'main', body: 'b' };
  try {
    const pr = await createDraftPr(args);
    assert.equal(pr.number, 1);
    assert.equal(seen[0].url, 'https://api.github.com/repos/o/r/pulls');
    assert.equal(seen[0].init.redirect, 'manual');
    assert.equal(JSON.parse(seen[0].init.body).draft, true);
    await assert.rejects(() => createDraftPr(args), /redirect 301 not followed/);
    await assert.rejects(() => createDraftPr({ ...args, ghRepo: '../evil' }), /Invalid GitHub repo/);
    assert.equal(seen.length, 2, 'a bad repo never reaches the network');
  } finally { globalThis.fetch = origFetch; }
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/provider-fetch-pinned-guard.test.mjs tests/slack.test.mjs tests/github-pr-validate.test.mjs`
Expected: FAIL. The guard reports `agents/slack.mjs: 1x bareFetch`. The Slack test fails on the message. The GitHub test fails with `createDraftPr is not a function` (SyntaxError: the module does not provide an export named `createDraftPr`).

- [ ] **Step 4: Route the webhook through the wrapper**

In `extension/agents/slack.mjs`, after `import { scanForSecrets } from '../guardrails/scan.mjs';` add:
```js
import { fixedHostFetch } from '../server/fixed-host-fetch.mjs';
```
In `postWebhook`, replace
```js
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
```
with
```js
  // isWebhookUrl above is the user-facing message; the fixed-host fetch enforces the same host at the socket.
  const r = await fixedHostFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }, { hosts: ['hooks.slack.com'], maxBytes: 64 * 1024 });
```

- [ ] **Step 5: Move the PR POST into `createDraftPr`**

In `extension/agents/github-pr.mjs`, after `import { redactSecrets } from '../core/redact-secrets.mjs';` add:
```js
import { fixedHostFetch } from '../server/fixed-host-fetch.mjs';
```
Directly above the line `export async function openPullRequest({`, add:
```js
/**
 * Opens a draft PR over the GitHub REST API: api.github.com only, no redirects (the token rides in
 * Authorization), reply capped at 1 MiB. Always a draft so the user reviews before merging.
 */
export async function createDraftPr({ ghRepo, ghToken, title, head, base, body }) {
  assertSafeGhRepo(ghRepo);
  const r = await fixedHostFetch(`https://api.github.com/repos/${ghRepo}/pulls`, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': `Bearer ${ghToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'llm-ide-extension',
    },
    body: JSON.stringify({ title, head, base, body, draft: true }),
    signal: AbortSignal.timeout(15_000),
  }, { hosts: ['api.github.com'], maxBytes: 1024 * 1024 });
  if (!r.ok) {
    // Redact before surfacing — GitHub 401/403 bodies can echo token fragments.
    const text = redactSecrets((await r.text())).slice(0, 400);
    throw new Error(`GitHub PR API ${r.status}: ${text}`);
  }
  return r.json();
}

```
Inside `openPullRequest`, replace the block that starts `  const r = await fetch(\`https://api.github.com/repos/${ghRepo}/pulls\`, {` and ends `  const pr = await r.json();` (24 lines, from the `fetch` call through the `if (!r.ok) { ... }` block) with:
```js
  const pr = await createDraftPr({
    ghRepo, ghToken, title: `auto: ${safeSummary80 || safeTask}`, head: branch, base, body: prBody,
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
cd /Users/dinsmallade/llm-ide/extension
node --test tests/provider-fetch-pinned-guard.test.mjs tests/slack.test.mjs tests/github-pr-validate.test.mjs tests/github-pr-secrets.test.mjs
npx eslint agents/slack.mjs agents/github-pr.mjs
```
Expected: PASS; eslint prints nothing.

- [ ] **Step 7: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/agents/slack.mjs extension/agents/github-pr.mjs extension/tests/provider-fetch-pinned-guard.test.mjs extension/tests/slack.test.mjs extension/tests/github-pr-validate.test.mjs
git commit -m "fix(agents): pin the Slack webhook and GitHub PR calls

The webhook POST and the draft-PR POST go through fixedHostFetch
(hooks.slack.com, api.github.com; redirects refused, replies capped).
The PR request moves into an exported createDraftPr so it is testable
without a git push. Status audit (e) rows 8 and 9.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: The Jev decision call, the final guard assertion and the audit record (~30 min)

**Files:**
- Modify: `extension/providers/jev.mjs` (import after line 22, the `fetch` in `jevDecide` at ~227)
- Test: `extension/tests/provider-fetch-pinned-guard.test.mjs` (ALLOWED + one new test), `extension/tests/jev-decisions.test.mjs` (line ~89, append)
- Modify: `docs/superpowers/plans/2026-10-31-status-audit.md` (section (e) table rows 1-3, 5-10, 14 and the Findings paragraph)

**Interfaces:**
- Consumes: `fixedHostFetch` from Task 2; `jevBaseUrl()` from `providers/providers.mjs`. It stays unchanged and still refuses a non-https, localhost, private-literal or query-carrying `JEV_AI_BASE_URL`.
- Produces: no new exports. `jevDecide` keeps its signature and its error mapping. A 3xx or a pinned-DNS refusal surfaces as `transient: true, reason: 'jev_network'`, with the key redacted from the message.

- [ ] **Step 1: Make the tests fail**

In `extension/tests/provider-fetch-pinned-guard.test.mjs`, delete from `ALLOWED`:
```js
  'providers/jev.mjs': { bareFetch: { n: 1, why: 'the operator-configured Jev decision API (JEV_AI_BASE_URL), not a user connection' } },
```
and append this test at the end of the file:
```js
test('every fixed-host caller goes through fixedHostFetch, and no bare fetch is allowlisted any more', () => {
  const want = {
    'providers/runtime.mjs': 2, 'providers/web-client.mjs': 2, 'providers/jev.mjs': 1,
    'connectors/google-oauth.mjs': 2, 'connectors/slack-oauth.mjs': 1, 'connectors/slack-source.mjs': 1,
    'agents/slack.mjs': 1, 'agents/github-pr.mjs': 1,
  };
  for (const [f, n] of Object.entries(want)) {
    const src = strip(fs.readFileSync(path.join(root, f), 'utf8'));
    assert.equal((src.match(/\bfixedHostFetch\(/g) || []).length, n, f);
    assert.equal(ALLOWED[f], undefined, `${f} must not be allowlisted`);
  }
  assert.deepEqual(Object.entries(ALLOWED).filter(([, rules]) => rules.bareFetch).map(([f]) => f), []);
});
```

In `extension/tests/jev-decisions.test.mjs`, change the assertion `    assert.equal(seen.init.redirect, 'error');` (in the test `jevDecide: POSTs /v1/systemone with Bearer auth, redirect:error and the validated body; meters usage`) to:
```js
    assert.equal(seen.init.redirect, 'manual', 'the fixed-host fetch sees the 3xx and refuses it itself');
```
and append:
```js
test('jevDecide: a redirect from Jev is refused (key never replayed) and maps to jev_network', async () => {
  const seen = [];
  const restore = withFetch(async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization });
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  });
  try {
    await assert.rejects(() => jevDecide({ apiKey: 'jev-secret-key', state: 's', questions: QUESTIONS }),
      (e) => e.transient === true && e.reason === 'jev_network' && /redirect 302 not followed/.test(e.message)
        && !e.message.includes('jev-secret-key'));
    assert.deepEqual(seen, [{ url: 'https://jev-ai.pro/api/v1/systemone', auth: 'Bearer jev-secret-key' }]);
  } finally { restore(); }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/dinsmallade/llm-ide/extension && node --test tests/provider-fetch-pinned-guard.test.mjs tests/jev-decisions.test.mjs`
Expected: FAIL. The guard reports `providers/jev.mjs: 1x bareFetch`, and the new guard test fails on `providers/jev.mjs` (count 0, want 1). The Jev test fails because `redirect` is still `'error'`, and the redirect test fails because the fake 302 is read as an HTTP status error.

- [ ] **Step 3: Route `jevDecide` through the wrapper**

In `extension/providers/jev.mjs`, after `import { jevBaseUrl } from './providers.mjs';` add:
```js
import { fixedHostFetch } from '../server/fixed-host-fetch.mjs';

// One decision reply (answers for at most the asked questions plus usage); far below this in practice.
const MAX_JEV_REPLY_BYTES = 4 * 1024 * 1024;
```
In `jevDecide`, replace
```js
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: payload,
      // The key rides in Authorization — never follow a 3xx with it.
      redirect: 'error',
      signal: combined,
    });
```
with
```js
    // Pinned to the configured base URL's host (DNS rebinding closed at the socket, private targets refused);
    // the key rides in Authorization, so any 3xx is refused rather than followed.
    res = await fixedHostFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: payload,
      signal: combined,
    }, { hosts: [new URL(url).hostname.toLowerCase()], maxBytes: MAX_JEV_REPLY_BYTES });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd /Users/dinsmallade/llm-ide/extension
node --test tests/provider-fetch-pinned-guard.test.mjs tests/jev-decisions.test.mjs tests/fixed-host-fetch.test.mjs
npx eslint providers/jev.mjs tests/provider-fetch-pinned-guard.test.mjs
npm test 2>&1 | tail -6
```
Expected: the three files PASS. eslint prints nothing. The full suite ends with `fail 0`. If a failure is `listen EPERM` under the agent sandbox, rerun that file outside it. That error is the sandbox, not this change.

- [ ] **Step 5: Record it in the status audit**

In `docs/superpowers/plans/2026-10-31-status-audit.md` section (e), change the first cell of table rows 1, 2, 3, 5, 6, 7, 8, 9 and 10. Their current first cells are `| 1 |`, `| 2 |`, `| 3 |`, `| 5 |`, `| 6 |`, `| 7 |`, `| 8 |`, `| 9 |` and `| 10 |`. Each becomes `| N (**closed 2026-11-07**, `server/fixed-host-fetch.mjs`: pinned DNS, one host, redirects refused, size cap) |`, keeping N. Replace the row-14 cell `Not coverable by the pinned fetch; governed by tool permissions and the extension catalog consent model, which is where the review should look` with `Not coverable by the pinned fetch; governed by tool permissions, workspace trust and the extension catalog consent model, which is where the review should look. Decision D2 in plans/2026-11-07-parallel-cleanup-and-pinning.md (2026-11-07)`. After the paragraph that begins `Findings for the independent review:`, add this new paragraph:

```
Update 2026-11-07: every row above except 12 to 15 now goes through the pinned fetch (rows 1 to 3, 5 to 10 through `server/fixed-host-fetch.mjs`), and `extension/tests/provider-fetch-pinned-guard.test.mjs` allowlists no bare `fetch(` at all, which is the lint rule finding (2) asked for. Row 12 keeps its own equivalent guard, row 13 is a supply-chain item, row 14 is subprocess egress (decision D2, not code), row 15 is the browser.
```

- [ ] **Step 6: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add extension/providers/jev.mjs extension/tests/provider-fetch-pinned-guard.test.mjs extension/tests/jev-decisions.test.mjs docs/superpowers/plans/2026-10-31-status-audit.md
git commit -m "fix(providers): pin the Jev decision call; no bare fetch left

jevDecide now dials the JEV_AI_BASE_URL host through fixedHostFetch,
so DNS rebinding is closed at the socket as for every provider. The
guard test allowlists no bare fetch any more and asserts each fixed-host
caller. Status audit (e) updated; subprocess egress stays a decision.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part 3: master-plan re-baseline (next-steps A4)

Each edit below is an exact-string replacement. "Find" quotes text that occurs once in the file today (checked with `grep -cF`). How to read the tables: each cell is the raw text, without the cell's outer backticks. `\|` stands for a literal `|`. Backticks inside a cell are literal characters of the text. "(delete)" means replace with nothing. Retired rows become `- [-]`, which `plan-status.mjs` does not count. Before Tasks 7 and 8: `git status --porcelain docs/superpowers/MASTER-PLAN.md` must print nothing (Global Constraints). Never edit the S5 row starting `Desktop archivist for extension captures` or the S6 row starting `Hosted issue write actions`.

### Task 7: MASTER-PLAN S2 (Tauri) rows that measure against the Mac (~30 min)

**Files:**
- Modify: `docs/superpowers/MASTER-PLAN.md` (S2 rows quoted below; the dashboard by `--fix`)

**Interfaces:**
- Consumes: nothing.
- Produces: MASTER-PLAN S2 with no open row measured against the Mac app; dashboard and owner lists regenerated.

- [ ] **Step 1: Confirm the check is green before editing and the file is clean**

Run: `cd /Users/dinsmallade/llm-ide && git status --porcelain docs/superpowers/MASTER-PLAN.md && node scripts/plan-status.mjs --check && echo CLEAN-AND-GREEN`
Expected: no status line, then `CLEAN-AND-GREEN`. If a status line prints, stop and do this task later.

- [ ] **Step 2: Apply the S2 edits**

| # | Find (current text) | Replace with |
|---|---|---|
| 1 | `- [ ] Phase 0 open: Accessibility grant to measure caption read cadence; optional Swift cold-start comparison (you)` | `- [ ] Phase 0 open: Accessibility grant to measure caption read cadence in the desktop app (you)` |
| 2 | `- [ ] ui-kit parity bar: pixel-tolerance fixtures against the Mac render (decision U4; needs a headless browser and a Mac fixture render, not built; today DOM/ARIA, token, contrast and alias-drift tests plus 5 reviewed screenshots) (me)` | `- [-] ui-kit parity bar against the Mac render (retired 2026-11-07: the Mac app is gone, so there is no reference render; the bar is the DOM/ARIA, token, contrast and alias-drift tests plus reviewed screenshots) (me)` |
| 3 | `- [~] Settings mirrors the Mac's one App page, checked by you 2026-11-04` | `- [~] Settings is one App page (the layout taken from the retired Mac app), checked by you 2026-11-04` |
| 4 | `(drift-checked by `scripts/extract-settings-groups.mjs` + `ui/screens/settings/tests/groups.test.ts`)` | `(pinned by `ui/screens/settings/tests/groups.test.ts`; the Swift extractor was removed with the Mac app)` |
| 5 | `- [~] Phase 3 mirror-the-Mac shell chrome built, not GUI-verified` | `- [~] Phase 3 shell chrome (top toolbar, taken from the retired Mac app) built, not GUI-verified` |
| 6 | `order, labels and account rows are drift-checked against the Swift source (`ui/screens/shell/tests/toolbar.test.mjs`)` | `order, labels and account rows are pinned by `ui/screens/shell/tests/toolbar.test.mjs`` |
| 7 | `so it coexists with the Swift app` | `separate from the retired Swift app's data` |
| 8 | `- [ ] Parity checklist all rows verified against the Mac app, including Home/toolbar navigation (report "Navigation parity") (you)` | `- [ ] Desktop acceptance run: every section of the Tauri app passes the RUN-ON-MAC.md first-run checklist in a real window, including Home/toolbar navigation (replaces the parity check against the retired Mac app) (you)` |
| 9 | `the Tauri app does not host `:3006` (the Swift app keeps the phone until the relay)` | `the phone reaches the desktop through Host API v1 and the sync tiers (ADR 0020); `:3006` retired with the Swift app` |
| 10 | `- [~] Phase 5 Mac-parity round, 2026-11-01 to 11-02` | `- [~] Phase 5 desktop feature round (ported from the retired Mac app), 2026-11-01 to 11-02` |
| 11 | `routines/storage and 3D stay Mac-local` | `routines/storage and 3D are not built on the desktop` |
| 12 | `(Implement is Mac-only until the desktop has a worktree host command); some Mac-local editing still absent` | `(Implement waits for a desktop worktree host command); some task editing still absent` |
| 13 | `- [~] Mac-vs-desktop parity audit, 2026-11-02` | `- [-] Mac-vs-desktop parity audit, 2026-11-02 (retired 2026-11-07: the Mac app it compared against is gone; open work lives in the gap worklist and Phase 5 round rows)` |
| 14 | `- [~] Mechanical parity inventory` | `- [-] Mechanical parity inventory (retired 2026-11-07: `scripts/parity-inventory.mjs` and the Swift views it read were removed; the triaged worklist in the next rows is what remains)` |
| 15 | `- [~] Chat inventory triaged and verified` | `- [~] Chat desktop gap list (from the inventory triage against the retired Mac app), triaged and verified` |
| 16 | `- [~] Inventory triage DONE for all ten areas` | `- [~] Desktop gap worklist for all ten areas (inventory triage against the retired Mac app, done)` |
| 17 | `- [ ] Parity gaps still open after the audit (each needs Rust, a core route, or a product decision):` | `- [ ] Desktop gaps still open after the audit (each needs Rust, a core route, or a product decision):` |
| 18 | `, run records the Mac cannot read back (`stages` vs `attempts`); named prompt templates are now built; Settings/Shell: Code Graph file-watch debouncing and the truncation upload banner remain Mac-only (the timer-based auto-update is built) (me)` | `; named prompt templates are now built; Settings/Shell: Code Graph file-watch debouncing and the truncation upload banner are not built (the timer-based auto-update is built) (me)` |
| 19 | `- [ ] Phase 6: one release with both apps, then Swift app to maintenance (wait)` | `- [-] Phase 6: one release with both apps, then Swift app to maintenance (retired 2026-11-07: the Swift app was removed 2026-11-06; the first desktop release is tracked in S10) (wait)` |

Do not change the other S2 rows: they name the Mac only as the origin of a feature, not as the bar it is measured against.

- [ ] **Step 3: Regenerate and check**

Run:
```bash
cd /Users/dinsmallade/llm-ide
node scripts/plan-status.mjs --fix && node scripts/plan-status.mjs --check && echo PLAN-OK
grep -nE "^\s*- \[( |~)\].*(verified against the Mac|mirror-the-Mac|Mac-parity round|against the Mac render|Swift source|Phase 6: one release)" docs/superpowers/MASTER-PLAN.md || echo "no open Mac-measured S2 rows"
git diff --stat docs/superpowers/MASTER-PLAN.md
```
Expected: `PLAN-OK`, `no open Mac-measured S2 rows`, and a diff of only this file.

- [ ] **Step 4: Commit** (in the same sitting as Step 3)

```bash
cd /Users/dinsmallade/llm-ide
git add docs/superpowers/MASTER-PLAN.md
git commit -m "docs(plan): re-baseline the Tauri rows off the retired Mac app

Rows that measured the desktop against the Swift app are retired or
reworded to what the desktop itself must do (next-steps A4, part 1).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: MASTER-PLAN S3 to S10 rows, dashboard state cells and the S9 pinning row (~25 min)

**Files:**
- Modify: `docs/superpowers/MASTER-PLAN.md` (rows quoted below, the dashboard State cells; numbers by `--fix`)

**Interfaces:**
- Consumes: Task 6 is committed (the S9 row cites `server/fixed-host-fetch.mjs`), and Task 1 is committed (the relay row cites it).
- Produces: MASTER-PLAN with no open row measured against the Mac app; the S9 pinning row reflects Part 2.

- [ ] **Step 1: Confirm the file is clean and green**

Run: `cd /Users/dinsmallade/llm-ide && git status --porcelain docs/superpowers/MASTER-PLAN.md && node scripts/plan-status.mjs --check && echo CLEAN-AND-GREEN`
Expected: no status line, then `CLEAN-AND-GREEN`. If a status line prints, stop and come back later.

- [ ] **Step 2: Apply the edits**

| # | Find (current text) | Replace with |
|---|---|---|
| 1 | `\| Native chat/explorer/auto-task client works through the Mac; the web client is now an installable PWA; push notifications do not exist \|` | `\| Native iPhone client on Host API v1 (desktop) with chat, approvals and History, plus the offline sync tier (SP4); the web client is an installable PWA; push notifications do not exist \|` |
| 2 | `public account service deployed (sub-project 1, sign-in pages) with desktop sign-in broken (review Critical) and sign-up open early (S9); device linking, relay and launch gates not built \|` | `offline sync tier (SP3); the account service, device linking and relay were retired by ADR 0020 and removed (`3891a2d5`, web client 2026-11-07) \|` |
| 3 | `macOS app builds with every Mac section except Live as a screen` | `macOS app builds with every section except Live as a screen` |
| 4 | `- [ ] Phone sees archived chats and notes only through the Mac; verify after live-then-archive Y2 run (you)` | `- [ ] Phone sees archived chats and notes through the desktop: Host API v1 History on the same network and the sync snapshots offline (SP4); verify on a real iPhone after a desktop capture is archived (you)` |
| 5 | `- [~] Command bus S2: the Swift security fixes are done and tested` | `- [~] Command bus S2: the security fixes were done and tested in the retired Swift app; the desktop host must keep the same rules` |
| 6 | `Mac screens, scheduled` | `scheduled` |
| 7 | `next: iOS v1 screens, Mac host parity, Library read` | `next: iOS v1 screens, Library read` |
| 8 | `; v2 (Mac) unchanged` | `` (empty: delete the text) |
| 9 | `- [~] "Mac app not running" state for the side panel: described in USER-CHECKLIST B7; not verified in a run (you)` | `- [~] "Core not running" state for the side panel (the desktop app is closed): described in USER-CHECKLIST B7; not verified in a run against the desktop core (you)` |
| 10 | `- [ ] Two Macs on one account can flap note-index keys: detected, not prevented (ROADMAP Loose ends) (me)` | `- [-] Two Macs on one account can flap note-index keys (retired 2026-11-07: no accounts after ADR 0020 and no Mac app; each desktop indexes its own notes folder) (me)` |
| 11 | `a real-app check of the Mac screen and cards` | `a real-window check of the desktop Extensions screen and cards` |
| 12 | `- [~] Provider and connector fetch pinning: pinned for providers, adapter MCP, extension install, tracker hosts, Box content downloads (host allowlist, manual redirects, token dropped cross-origin, size caps) and MCP connector OAuth discovery/token calls; **not** pinned: Jev connection check, 7 literal-host calls, subprocess egress (`plans/2026-10-31-status-audit.md` (e)); independent review welcome (ROADMAP X7) (me)` | `- [~] Provider and connector fetch pinning: pinned for providers, adapter MCP, extension install, tracker hosts, Box content downloads (host allowlist, manual redirects, token dropped cross-origin, size caps) and MCP connector OAuth discovery/token calls; since 2026-11-07 also the Jev decision call and every literal-host call (Anthropic, SerpAPI, Google OAuth, Slack OAuth/API/webhook, GitHub PR) through `server/fixed-host-fetch.mjs` (one host per call, redirects refused, size caps), and the guard test allowlists no bare `fetch(`; **not** pinned: subprocess egress (CLI children, `git`, `npm`, MCP stdio servers; outside the fetch layer, decision D2 of `plans/2026-11-07-parallel-cleanup-and-pinning.md`) (`plans/2026-10-31-status-audit.md` (e)); independent review welcome (ROADMAP X7) (me)` |
| 13 | `- [~] Relay: E2E design revised to the independent review` | `- [-] Relay (retired 2026-11-06 by ADR 0020; code removed in `3891a2d5`, the web client 2026-11-07): E2E design revised to the independent review` |
| 14 | `- [~] Mac Sparkle `CFBundleVersion` limitation:` | `- [-] Mac Sparkle `CFBundleVersion` limitation (retired 2026-11-07: Sparkle and `mac/Scripts/build-number.sh` left with the Swift app; the desktop updater is in the signed-updates rows):` |
| 15 | `- [~] Mac auto-update feed in release builds:` | `- [-] Mac auto-update feed in release builds (retired 2026-11-07: `mac-release.yml` was removed with the Swift app; desktop updates use the Tauri updater key, UN-115):` |

In row 2 the leading text of the cell (`Host API web client (pairing, chat, approvals, read views), installable PWA, public site with the app at /app; `) stays as it is. In row 8, replace with nothing.

- [ ] **Step 3: Regenerate and check**

Run:
```bash
cd /Users/dinsmallade/llm-ide
node scripts/plan-status.mjs --fix && node scripts/plan-status.mjs --check && echo PLAN-OK
grep -nE "^\s*- \[( |~)\].*(only through the Mac|Two Macs|Mac app not running|Mac screen and cards|Sparkle|mac-release|v2 \(Mac\)|Mac host parity)" docs/superpowers/MASTER-PLAN.md || echo "no open Mac-measured rows"
git diff --stat docs/superpowers/MASTER-PLAN.md
```
Expected: `PLAN-OK`, `no open Mac-measured rows`, a diff of only this file.

- [ ] **Step 4: Commit** (in the same sitting as Step 3)

```bash
cd /Users/dinsmallade/llm-ide
git add docs/superpowers/MASTER-PLAN.md
git commit -m "docs(plan): re-baseline phone, web, release rows; fetch pinning row

Retire or reword the remaining rows that depended on the Swift app or
the relay, refresh the mobile and web state cells, and record the
2026-11-07 fetch pinning in S9 (next-steps A4, part 2).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: USER-NEEDS items that only made sense with the Mac app (~15 min)

**Files:**
- Modify: `docs/superpowers/USER-NEEDS.md` (items quoted below; the Open count line by `--fix`)

**Interfaces:**
- Consumes: nothing.
- Produces: USER-NEEDS with no open item that needs the Mac app.

- [ ] **Step 1: Confirm the check is green and the file is clean**

Run: `cd /Users/dinsmallade/llm-ide && git status --porcelain docs/superpowers/USER-NEEDS.md && node scripts/user-needs.mjs --check && echo CLEAN-AND-GREEN`
Expected: no status line, then `CLEAN-AND-GREEN`.

- [ ] **Step 2: Apply the edits**

| # | Item | Find (current text) | Replace with |
|---|---|---|---|
| 1 | UN-010 | ` Optional: a Swift cold-start comparison.` | `` (delete) |
| 2 | UN-019 | `\|node --test\|swift-test'` | `\|node --test'` |
| 3 | UN-019 | ` Do not kill the backend while the Swift app is in use.` | ` Do not kill the core while the desktop app is in use.` |
| 4 | UN-033 | `interim Swift fixes (several shipped); ` | `` (delete) |
| 5 | UN-035 | `; approve the one Swift addition for the Live capture helper` | `` (delete) |
| 6 | UN-035 | `Recommended: yes to all three. If you wait: Live capture and 3D graph work cannot be scheduled.` | `Recommended: yes to both. If you wait: the 3D graph and the Windows/Linux order cannot be scheduled.` |
| 7 | (section B note) | `Desktop Live capture plan 2026-11-05 assumes no Swift helper; approving it changes only that plan's Task 5.` plus the blank line after it | `` (delete both lines) |
| 8 | UN-036 | `desktop chat store (same file format, use the Mac app's `sessions/` in place with a lock file on macOS); confirm the Swift feature freeze and its exceptions; ` | `desktop chat store (same file format, in the desktop's own data dir); ` |
| 9 | UN-036 | `If you wait: the freeze stays "inferred" and the chat store is undecided.` | `If you wait: the chat store is undecided.` |
| 10 | UN-044 | `(Mac: `~/Library/Application Support/llm-ide/system/`; desktop: `~/Library/Application Support/llm-ide-desktop/core/`)` | `(`~/Library/Application Support/llm-ide-desktop/core/` on macOS)` |
| 11 | UN-047 | `(recommended: Mac only)` | `(recommended: desktop only)` |
| 12 | UN-070 | `Trigger: the macOS Tauri app reaches parity and daily use.` | `Trigger: the macOS Tauri app reaches daily use.` |
| 13 | UN-071 | `The seven existing `MAC_*` secrets (shared with `mac-release.yml`) are reused: nothing new if they are set.` | `The seven existing `MAC_*` GitHub secrets are reused: nothing new if they are set.` |

Leave ticked (`[x]`) items alone: they are history, and the retired ones already say "retired 2026-11-06".

- [ ] **Step 3: Regenerate and check**

Run:
```bash
cd /Users/dinsmallade/llm-ide
node scripts/user-needs.mjs --fix && node scripts/user-needs.mjs --check && echo NEEDS-OK
grep -nE "^- \[ \].*(Swift|Mac app|mac-release)" docs/superpowers/USER-NEEDS.md || echo "no open Mac-app items"
grep -nE "Swift|mac-release|Mac only" docs/superpowers/USER-NEEDS.md | grep -v "retired 2026-11-06" | grep -v "^\S*:- \[x\]"
make docs-check 2>&1 | tail -3
```
Expected: `NEEDS-OK`, `no open Mac-app items`. The third grep prints only lines inside ticked items, or nothing. `make docs-check` passes. If `pytest` is missing, run `node scripts/user-needs.mjs --check` and `node scripts/plan-status.mjs --check` instead.

- [ ] **Step 4: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add docs/superpowers/USER-NEEDS.md
git commit -m "docs(plan): re-baseline user needs off the retired Mac app

Open items no longer ask for Swift checks, Mac paths or the Mac release
workflow (next-steps A4, part 3).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

1. **Spec coverage.**
   - Part 1:
     - Task 1 covers every relay-client reference: `web/src`, `web/tests`, `web/README.md`, `web/DEPLOY.md` (none there) and ADR 0020.
     - What sync imports is moved, not deleted, and keeps its own test.
     - `schema/relay/v1` and `scripts/relay-reference.mjs` stay. The plan names their users and runs `make relay-check` and `scripts/sync-vectors.mjs`.
     - The CSP has no dead relay entry: `wss:` and `llm-ide.com` are Host API and sync. The facts section says so, and no CSP edit is planned.
   - Part 2:
     - Tasks 2 to 6 cover the Jev check and all nine literal-host call sites (the seven audit rows 1-3, 5-7, 9 plus the row-8 webhook). Each has a fake-fetch test and none touches a file of the parallel plans.
     - Subprocess egress is decision D2, not code.
   - Part 3:
     - Tasks 7 and 8 list each MASTER-PLAN row by its current text, with the new text, and Task 9 does the same for USER-NEEDS.
     - Both generators run with `--fix`.
     - The two rows of the parallel plans are excluded.
   - Not covered on purpose: the "How the surfaces connect" and "Dependencies and critical path" prose sections. They are not checkbox rows, and next-steps A4 names rows.
2. **Placeholder scan.** Every code step shows its code. Every doc step quotes the find and replace text.
3. **Type and name consistency.**
   - `fixedHostFetch(input, init, { hosts, maxBytes })`, `capBody` and the code `FETCH_REFUSED` are the same in Tasks 2 to 6.
   - The refusal text is `redirect <status> not followed` in every test.
   - `createDraftPr({ ghRepo, ghToken, title, head, base, body })` is the same in the test and the code.
   - The guard counts in Task 6 match the conversions in Tasks 3 to 6: runtime 2, web-client 2, jev 1, google 2, slack-oauth 1, slack-source 1, agents/slack 1, github-pr 1.
4. **Residual risks, stated plainly.**
   - The 32 MiB Anthropic cap also bounds one streamed reply. It is far above a 64k-token stream, but a cap hit mid-stream surfaces as a stream error.
   - The embedded handler self-tests (`node llm_agent/tools/handlers/*.mjs`) are not part of `npm test`. Task 3 runs them by hand.

## Decisions for the user (secure default first)

| # | Question | Secure default (what this plan does) | Alternative |
|---|---|---|---|
| D1 | Redirects on fixed-host calls | Refuse every 3xx. None of these APIs redirects in normal use, and a refused hop can never carry the token anywhere. | Follow same-host GET hops (at most 3), as `tracker-fetch` does for GitHub renames. Add it only if a real call turns out to need it. |
| D2 | Subprocess egress (the `claude` CLI and Agent SDK children, `git`, `gh`, `npm`, MCP stdio servers) | Not pinned, and documented as outside the fetch layer. It stays governed by tool permissions, workspace trust and the extension consent model (status audit (e) row 14). | (a) An opt-in `HTTPS_PROXY`/`NO_PROXY` passthrough in `minimalCliEnv` so an operator can force children through an egress proxy (core-only change, later plan). (b) An OS sandbox per child, which is the same blocker as `ENGINE_NOT_SANDBOXED` (larger, later). |
| D3 | A Jev base URL on a private network | Keep refusing it (`jevBaseUrl` already refuses private and localhost names, and the pinned fetch now also refuses private resolutions). | Allow it with both switches the providers use (`allowPrivate` + `LLMIDE_ALLOW_PRIVATE_PROVIDERS`). |
| D4 | The web relay WebCrypto client | Delete it. Git history keeps it, and the web sync envelope test still runs every relay v1 negative. | Keep `relay/crypto.ts` as a second reference implementation. That means keeping its test and its maintenance. |
| D5 | Rows that compared the desktop with the Mac | Retire the comparison rows (`[-]`, one line why). Reword the rows that still carry desktop work to what the desktop must do (for example, the parity checklist becomes a desktop acceptance run). | Retire every parity-derived row outright, including the gap worklists. That drops 397 triaged gaps from the plan. |
