# Push Notifications Sent by the Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the desktop runs, a paired phone (iPhone app) or web app gets a push notification when an approval is waiting, a long task finished or failed, or sync needs attention. The push carries only a fixed kind and a count, never content.

**Architecture:** The desktop is the sender, so there is no relay. The desktop notifier (`desktop/src-tauri/src/notify.rs`) already decides that something is worth telling the user. `notify_user` now also answers `push: true` when it admitted a kind and the main window is not focused. The webview then posts `{ kind, key?, count }` to a new desktop-only core route `POST /host-api/push/send`. The core holds the secrets in the user's vault (the VAPID key it generates, and the APNs `.p8` key the user adds), and the push targets in a new table tied to the paired device. It de-duplicates, coalesces and rate-limits again, then fans the kind out to every paired device that registered a target and was granted the new Host API capability `push`. Web Push is RFC 8291 (aes128gcm) + RFC 8292 (VAPID), written by hand on `node:crypto`. It is sent through `fixedHostFetch` pinned to the one host of the subscription, and that host must be on an allowlist of the real browser push services. APNs uses token auth (ES256 JWT) over `node:http2` to `api.push.apple.com` / `api.sandbox.push.apple.com`. Devices register over Host API v1 with three new commands: `push.config`, `push.register` and `push.unregister`. A web or iPhone device shows the words from its own copy of the notifier's fixed text table: the web worker uses `web/public/sw-push.js`, and iOS uses `Localizable.strings` through APNs `loc-key`.

**Tech Stack:** Node 22 core (`node:crypto` ECDH/HKDF/AES-GCM/ECDSA, `node:http2`, better-sqlite3), Host API v1 contract + generators (`scripts/generate-host-api.mjs` → JS, TS, Swift), Rust (Tauri 2.11.6, serde), React 18 + TypeScript (desktop shell, web app), service worker, SwiftUI + UserNotifications + swift-testing. **No new npm package, crate or Swift package.**

**Spec:** The brief that asked for this plan (the push design restated below), the MASTER-PLAN S3 row "Push notifications (approvals, task done)" (`docs/superpowers/MASTER-PLAN.md`), USER-NEEDS UN-078 (`docs/superpowers/USER-NEEDS.md`; its trigger "after the relay" is replaced, because ADR 0020 `docs/decisions/0020-box-encrypted-sync.md` retired the relay), the desktop notifications plan (`docs/superpowers/plans/2026-11-07-desktop-notifications-tray.md`: the 13-kind table, its generic text and the gate), and the Host API v1 contract (`schema/host-api/v1/README.md`, the `compose` capability as the pattern for adding a capability).

## Global Constraints

- **The desktop is the only sender.** No relay. It sends only while it runs: the events happen there.
- **Payload = fixed kind + count.** A Web Push plaintext is exactly `{"k":"<kind>","n":<1..999>}`. An APNs payload is `{"aps":{"alert":{"title":"LLM-IDE","loc-key":"PUSH_<KIND>[_MANY]","loc-args":["<n or 99+>"]?},"sound":"default"},"k":"<kind>"}`. A push never carries chat text, names, paths, captions, tokens, project, account or device names. Only the 11 webview kinds of `notify.rs` (`Kind::from_webview`) are pushable. `update_ready` and `core_down` never are.
- **The same words everywhere.** Every displayed sentence is a `notify.rs` `Kind::body` string. `extension/tests/push-kinds.test.mjs` parses `notify.rs` and fails if `server/push/kinds.mjs`, `web/public/sw-push.js` or `ios_app/MyApp/Supporting/Localizable.strings` drift from it.
- **Secrets live in the vault only.** These are `push.vapidKey` (JWK), `push.apnsKey` (.p8 PEM), `push.apnsKeyId` and `push.apnsTeamId`, all `INTERNAL_KEYS` in `extension/server/vault.mjs`. They are never logged, never returned by a route or command, never listed, and never client-settable through `/auth/me/secrets`. A route may return the key id and team id (Apple identifiers, not secrets). It never returns the key.
- **Never log an endpoint or a device token.** Both are capability values. Logs and audit rows carry only the kind, the push-service host or the APNs environment, and a status code.
- **Capability `push` = served ∩ granted.** It is served only when `LLMIDE_HOST_API_PUSH=1` (default off, like `read` and `compose`). A device gets it only by pairing while it is served, so re-pairing is how an existing device gets it. A push target is removed with its device (`FOREIGN KEY … ON DELETE CASCADE`): by revoke, idle expiry, the 20-device cap or an identity reset.
- **Rate limits and de-duplication:** each de-dup key at most once (the last 256 keys), at most one push per user per kind per 10 s (`COALESCE_MS = 10_000`, the notifier's value), and at most 30 pushes per device per hour with a burst of 10 (a `TokenBucket` from `routes/host-api/rate.mjs`). `push.register` / `push.unregister` use the per-device `turn` bucket, and `push.config` uses the `read` bucket.
- **Exact-host pinning.**
  - Web Push goes only through `fixedHostFetch(url, init, { hosts: [<that endpoint's hostname>] })`.
  - The hostname must pass `isPushServiceHost`. That allows exactly `fcm.googleapis.com`, `updates.push.services.mozilla.com` and `web.push.apple.com`, plus `<one label>.notify.windows.com`.
  - Every endpoint must be https on port 443 with no userinfo. It is checked when the device registers it and again when a push is sent.
  - APNs goes only to the two fixed hosts, over `http2.connect` with a lookup that refuses private addresses. That is the one reviewed `http2` path, allowlisted in `extension/tests/provider-fetch-pinned-guard.test.mjs`.
- **No new dependency.** RFC 8291/8292 and the APNs JWT are written on `node:crypto`, and the RFC 8291 Appendix A vector is the test. If a dependency ever becomes unavoidable, pin it exactly (`=x.y.z`).
- **API version.** `SERVER_API_VERSION` 117 → **118** in `extension/server.mjs` and `APP_API_VERSION` in `ui/screens/shell/core-api-floor.ts`. If another plan has taken 118 by the time Task 6 runs, use the next free number in every line Task 6 touches. The same rule applies to migration `0065`.
- **Host API v1 contract:** commands 17 → **20**, plus the capability `push`. Fixtures, invalid cases, the security fixture and the README go in Task 4. The generated JS, TS and Swift come only from `node scripts/generate-host-api.mjs`, and `make test-shared-protocol` must pass.
- **The Xcode Push capability and the APNs key are user steps** (section D). The code is built and tested without them: against a fake APNs (an in-process HTTP/2 server) and with the iPhone degrading to "this build cannot receive push notifications".
- Conventional Commits, on `main`, one concern per commit, **not pushed**. Each commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Implementer subagents must not spawn subagents.

### Files this plan avoids (parallel work)

Another agent may be executing `docs/superpowers/plans/2026-11-07-extensions-catalog-p9.md` (plugins / MCP / extensions UI) and `docs/superpowers/plans/2026-11-07-ended-chat-continuation.md` (chat engine). This plan does **not** touch:

- `extension/plugins/**`, `extension/mcp/**`, `extension/llm-sources/**`, `extension/routes/extensions-catalog.mjs`, `extension/routes/extension-routes.mjs`, `extension/routes/workspace-trust.mjs`, `ui/screens/library/extensions/**`
- `extension/llm_agent/**`, `extension/routes/agent-v2*.mjs`, `extension/kb/chat-sessions.mjs`, `extension/core/prompt-framing.mjs`, `ui/screens/chat/**`, `web/src/chat/**`, `ios_app/MyApp/Services/LlmIdeChatStore.swift`
- both plan files themselves

Shared hot spots it does touch, and how to stay out of each other's way:

- **Rebase first:** `extension/server.mjs` (only the version line, the changelog comment and three `ALL_ENDPOINTS` entries), `ui/screens/shell/core-api-floor.ts`, and the version lines in `docs/spec/api-server.md` and `docs/spec/cross-cutting.md`.
- **Regenerate, never hand-merge:** `docs/reference/api/openapi.yaml`, `schema/http/INVENTORY.md` and `extension/src/lib/api-types.ts`.
- **Numbers:** take the next free migration number and the next free API version.

---

## A. The design in one page

| Piece | Where | What it does |
|---|---|---|
| Kind table | `extension/server/push/kinds.mjs`, `web/public/sw-push.js`, `ios_app/MyApp/Supporting/Localizable.strings` | The 11 pushable kinds, the payload builders and the device-side words. All are checked against `notify.rs`. |
| Web Push | `extension/server/push/jwt.mjs`, `extension/server/push/webpush.mjs` | ES256 JWT, RFC 8291 encryption, VAPID header, push-service allowlist, send. |
| APNs | `extension/server/push/apns.mjs` | `.p8` parsing, a provider JWT cached for 50 min, an HTTP/2 POST to `/3/device/<token>`, the status mapping. |
| Store | `extension/kb/migrations/0065_host_api_push.sql`, `extension/kb/push-targets.mjs` | One push target per paired device, removed with the device. |
| Host API | `schema/host-api/v1/commands.json` + fixtures, `extension/routes/host-api/push-target.mjs`, `extension/routes/host-api/gateway.mjs` | `push.config` (VAPID public key, whether APNs is configured, what this device registered), `push.register`, `push.unregister`. |
| Sender | `extension/routes/host-api/push.mjs`, `extension/routes/host-api/http-routes.mjs` | The vault credentials, the gate, the fan-out and four desktop-only routes: `POST /host-api/push/send`, `GET /host-api/push/status`, `PUT` and `DELETE /host-api/push/apns`. |
| Desktop | `desktop/src-tauri/src/notify.rs`, `ui/screens/shell/notify/notify.ts`, `ui/screens/shell/Shell.tsx`, `ui/screens/shell/notify/PushCard.tsx` | `notify_user` → `{ shown, push }`. The webview forwards admitted kinds. A Settings card shows the devices and takes the APNs key. |
| Web app | `web/src/push/controller.ts`, `web/src/screens/PushToggle.tsx`, `web/public/sw.js`, `web/src/App.tsx` | The "Notify me on this device" button subscribes and registers. The worker shows the words and focuses the app on a click. |
| iPhone | `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPush.swift`, `ios_app/MyApp/Services/PushRegistrar.swift`, `MyAppApp.swift`, `ConnectionService.swift`, `project.pbxproj` | Asks for alert permission on a desktop that serves `push`, registers for remote notifications and sends the hex token. |

**CSP and service-worker rules.** There is no CSP change in `web/vite.config.ts`, `web/scripts/serve.mjs`, `deploy/vps/llm-ide.com.nginx` or `web/DEPLOY.md`:

- The browser, not the page, talks to its push service, so `connect-src` needs no push host.
- `default-src 'self'` already covers the same-origin `sw.js` and `sw-push.js`.
- The worker's `fetch` handler still caches only same-origin GET shell assets. The new `push` and `notificationclick` handlers make no network request: they render from the local table or focus/open `./`.
- `web/tests/pwa.test.mjs` pins all of the above (Task 8).

**Pinned-fetch guard.** `provider-fetch-pinned-guard.test.mjs` does not see `http2.connect` today. Task 3 adds two rules (`http2Import`, `http2Connect`) and one reviewed allowlist entry, `server/push/apns.mjs` (n = 1 each). Web Push needs no entry, because it calls `fixedHostFetch` and not a bare fetch.

---

## B. Tasks

### Task 1: One push kind table for every surface (15 min)

**Files:**
- Create: `extension/server/push/kinds.mjs`
- Create: `web/public/sw-push.js`
- Create: `ios_app/MyApp/Supporting/Localizable.strings` (added to the Xcode project in Task 9)
- Test: `extension/tests/push-kinds.test.mjs`

**Interfaces:**
- Consumes: `desktop/src-tauri/src/notify.rs` (read-only: `pub fn wire`, `pub fn body`).
- Produces:
  - `PUSH_KINDS: readonly string[]` (11 kinds)
  - `COUNTED: Set<string>` (`approval_chat`, `approval_job`)
  - `isPushKind(k: unknown): boolean`
  - `webPayload(kind: string, count: number): string`
  - `apnsPayload(kind: string, count: number): string`
  - browser global `self.LLMIDEPush = { ONE, MANY, render(data) → { title, body, tag } | null }`
  - iOS strings `PUSH_<KIND>` and `PUSH_<KIND>_MANY` (with `%@`)

- [ ] **Step 1: Write the failing test** — `extension/tests/push-kinds.test.mjs`:

```js
// The push kind table on every surface (push notifications plan): the core's payload builders, the web worker's text
// table and the iPhone's Localizable.strings must say exactly what desktop/src-tauri/src/notify.rs says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { PUSH_KINDS, COUNTED, isPushKind, webPayload, apnsPayload } from '../server/push/kinds.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm objects come from another realm
const rs = read('desktop/src-tauri/src/notify.rs');
const wire = Object.fromEntries([...rs.slice(rs.indexOf('pub fn wire'), rs.indexOf('pub fn from_webview'))
  .matchAll(/Kind::(\w+) => "([a-z_]+)"/g)].map((m) => [m[1], m[2]]));
const one = {};
const many = {};
for (const m of rs.slice(rs.indexOf('pub fn body'), rs.indexOf('/// The category switch'))
  .matchAll(/Kind::(\w+)( if many)? => (?:format!\()?"([^"]+)"/g)) (m[2] ? many : one)[wire[m[1]]] = m[3];
const HOST_ONLY = ['update_ready', 'core_down'];

test('the push kinds are the notifier webview kinds, never a host-only one', () => {
  assert.equal(Object.keys(one).length, 13, 'notify.rs parsed');
  assert.deepEqual([...PUSH_KINDS].sort(), Object.values(wire).filter((k) => !HOST_ONLY.includes(k)).sort());
  assert.deepEqual([...COUNTED].sort(), Object.keys(many).sort());
  for (const k of HOST_ONLY) assert.equal(isPushKind(k), false, k);
  for (const bad of ['', 'Approval_chat', 'approval_chat ', '__proto__', null, 3]) assert.equal(isPushKind(bad), false, String(bad));
});

test('payloads carry only the kind and a clamped count', () => {
  assert.equal(webPayload('loop_done', 1), '{"k":"loop_done","n":1}');
  assert.equal(webPayload('approval_job', 5000), '{"k":"approval_job","n":999}');
  assert.equal(webPayload('approval_job', 0), '{"k":"approval_job","n":1}');
  assert.equal(webPayload('approval_job', 2.5), '{"k":"approval_job","n":1}');
  assert.deepEqual(JSON.parse(apnsPayload('loop_failed', 1)), { aps: { alert: { title: 'LLM-IDE', 'loc-key': 'PUSH_LOOP_FAILED' }, sound: 'default' }, k: 'loop_failed' });
  assert.deepEqual(JSON.parse(apnsPayload('approval_chat', 150)).aps.alert, { title: 'LLM-IDE', 'loc-key': 'PUSH_APPROVAL_CHAT_MANY', 'loc-args': ['99+'] });
  assert.deepEqual(JSON.parse(apnsPayload('approval_job', 3)).aps.alert['loc-args'], ['3']);
  assert.equal(JSON.parse(apnsPayload('loop_done', 7)).aps.alert['loc-key'], 'PUSH_LOOP_DONE', 'only approvals count');
});

test('the web worker text table is the notify.rs table', () => {
  const sandbox = { self: {} };
  vm.runInNewContext(read('web/public/sw-push.js'), sandbox);
  const P = sandbox.self.LLMIDEPush;
  assert.deepEqual(plain(P.ONE), Object.fromEntries(PUSH_KINDS.map((k) => [k, one[k]])));
  assert.deepEqual(plain(P.MANY), many);
  assert.deepEqual(plain(P.render({ k: 'approval_chat', n: 3 })), { title: 'LLM-IDE', body: '3 tools are waiting for your approval in Chat.', tag: 'approval_chat' });
  assert.equal(P.render({ k: 'approval_job', n: 500 }).body, '99+ jobs are waiting for your approval.');
  assert.equal(P.render({ k: 'loop_done', n: 4 }).body, 'A Loop run passed.');
  assert.equal(P.render({ k: 'approval_chat' }).body, 'A tool is waiting for your approval in Chat.');
  for (const bad of [null, {}, { k: 'update_ready' }, { k: '__proto__' }, { k: 'toString' }, 'loop_done', { k: 1 }]) assert.equal(P.render(bad), null, JSON.stringify(bad));
});

test('the iPhone strings are the notify.rs table', () => {
  const strings = Object.fromEntries([...read('ios_app/MyApp/Supporting/Localizable.strings').matchAll(/^"([A-Z_]+)" = "(.*)";$/gm)].map((m) => [m[1], m[2]]));
  const want = {};
  for (const k of PUSH_KINDS) want[`PUSH_${k.toUpperCase()}`] = one[k];
  for (const [k, v] of Object.entries(many)) want[`PUSH_${k.toUpperCase()}_MANY`] = v.replace('{n}', '%@');
  assert.deepEqual(strings, want);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd extension && node --test tests/push-kinds.test.mjs`
Expected: FAIL with `Cannot find module '…/server/push/kinds.mjs'`.

- [ ] **Step 3: Write the three tables**

`extension/server/push/kinds.mjs`:

```js
// The push kinds (push notifications plan): the desktop notifier's webview kinds (desktop/src-tauri/src/notify.rs
// Kind::from_webview), never update_ready or core_down (host-only facts with no meaning on a phone). A payload names a
// kind and a count only; the device builds the words from its own copy of the notify.rs table (web/public/sw-push.js,
// ios_app/MyApp/Supporting/Localizable.strings). tests/push-kinds.test.mjs keeps all four in step.
export const PUSH_KINDS = Object.freeze([
  'approval_chat', 'approval_job', 'loop_done', 'loop_failed', 'autotask_done', 'autotask_failed',
  'graph_done', 'graph_failed', 'docgen_done', 'docgen_failed', 'sync_attention',
]);
/** Kinds whose text names a count (notify.rs `if many`). */
export const COUNTED = new Set(['approval_chat', 'approval_job']);
export const isPushKind = (k) => typeof k === 'string' && PUSH_KINDS.includes(k);
const clampCount = (n) => (Number.isInteger(n) ? Math.min(Math.max(n, 1), 999) : 1);

/** The Web Push plaintext, encrypted before it leaves this process. */
export const webPayload = (kind, count) => JSON.stringify({ k: kind, n: clampCount(count) });

/** The APNs payload: a localized alert resolved by the app's Localizable.strings, so Apple sees a kind and a count only. */
export function apnsPayload(kind, count) {
  const n = clampCount(count);
  const many = COUNTED.has(kind) && n > 1;
  const alert = { title: 'LLM-IDE', 'loc-key': `PUSH_${kind.toUpperCase()}${many ? '_MANY' : ''}`, ...(many ? { 'loc-args': [n > 99 ? '99+' : String(n)] } : {}) };
  return JSON.stringify({ aps: { alert, sound: 'default' }, k: kind });
}
```

`web/public/sw-push.js`:

```js
// Push text for the web app's worker (push notifications plan): the words of desktop/src-tauri/src/notify.rs
// Kind::body, keyed by kind. A push carries {k, n} only; anything else shows nothing.
// extension/tests/push-kinds.test.mjs checks this table against notify.rs.
self.LLMIDEPush = (() => {
  const ONE = {
    approval_chat: "A tool is waiting for your approval in Chat.",
    approval_job: "A job is waiting for your approval.",
    loop_done: "A Loop run passed.",
    loop_failed: "A Loop run did not pass.",
    autotask_done: "An Auto Task finished.",
    autotask_failed: "An Auto Task did not complete.",
    graph_done: "The code graph is ready.",
    graph_failed: "Code graph generation failed.",
    docgen_done: "A generated document is ready.",
    docgen_failed: "Document generation failed.",
    sync_attention: "Sync needs your attention in Settings.",
  };
  const MANY = {
    approval_chat: "{n} tools are waiting for your approval in Chat.",
    approval_job: "{n} jobs are waiting for your approval.",
  };
  const has = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
  function render(data) {
    if (!data || typeof data !== "object" || !has(ONE, data.k)) return null;
    const n = Number.isInteger(data.n) && data.n > 0 ? data.n : 1;
    const body = n > 1 && has(MANY, data.k) ? MANY[data.k].replace("{n}", n > 99 ? "99+" : String(n)) : ONE[data.k];
    return { title: "LLM-IDE", body, tag: data.k };
  }
  return { ONE, MANY, render };
})();
```

`ios_app/MyApp/Supporting/Localizable.strings`:

```
/* Push notification text (Host API v1 capability push). The desktop sends only a kind and a count; these are the
   words of desktop/src-tauri/src/notify.rs Kind::body. extension/tests/push-kinds.test.mjs keeps them in step. */
"PUSH_APPROVAL_CHAT" = "A tool is waiting for your approval in Chat.";
"PUSH_APPROVAL_JOB" = "A job is waiting for your approval.";
"PUSH_LOOP_DONE" = "A Loop run passed.";
"PUSH_LOOP_FAILED" = "A Loop run did not pass.";
"PUSH_AUTOTASK_DONE" = "An Auto Task finished.";
"PUSH_AUTOTASK_FAILED" = "An Auto Task did not complete.";
"PUSH_GRAPH_DONE" = "The code graph is ready.";
"PUSH_GRAPH_FAILED" = "Code graph generation failed.";
"PUSH_DOCGEN_DONE" = "A generated document is ready.";
"PUSH_DOCGEN_FAILED" = "Document generation failed.";
"PUSH_SYNC_ATTENTION" = "Sync needs your attention in Settings.";
"PUSH_APPROVAL_CHAT_MANY" = "%@ tools are waiting for your approval in Chat.";
"PUSH_APPROVAL_JOB_MANY" = "%@ jobs are waiting for your approval.";
```

- [ ] **Step 4: Run the test and see it pass**

Run: `cd extension && node --test tests/push-kinds.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/server/push/kinds.mjs web/public/sw-push.js ios_app/MyApp/Supporting/Localizable.strings extension/tests/push-kinds.test.mjs
git commit -m "feat(server): one push kind table shared with the web worker and the iPhone strings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Web Push encryption, VAPID and the pinned sender (25 min)

**Files:**
- Create: `extension/server/push/jwt.mjs`
- Create: `extension/server/push/webpush.mjs`
- Create: `schema/host-api/v1/fixtures/security/push.json`
- Modify: `schema/host-api/v1/fixtures/security/README.md` (append one paragraph)
- Test: `extension/tests/push-webpush.test.mjs`

**Interfaces:**
- Consumes: `fixedHostFetch(input, init, { hosts, maxBytes })` from `extension/server/fixed-host-fetch.mjs`; `PUSH_KINDS` (Task 1).
- Produces:
  - `es256Jwt(header: object, claims: object, key: KeyObject): string`
  - `PUSH_SERVICE_HOSTS: readonly string[]`, `isPushServiceHost(h: string): boolean`, `pushEndpoint(raw: unknown): URL | null`
  - `encryptPayload(plaintext: string, { p256dh, auth }, { asPrivate?: Buffer, salt?: Buffer }?): Buffer`
  - `newVapidJwk(): string` (JWK JSON with `d`)
  - `vapidKeyOf(jwkText: string): { privateKey: KeyObject, publicKey: string /* 87-char base64url */ }`
  - `sendWebPush(sub: { endpoint, p256dh, auth }, plaintext: string, { vapid, urgency?: 'normal'|'high', topic?: string, now?: number, fetchImpl? }): Promise<{ ok: true } | { gone: true } | { ok: false, code: string }>`
  - `VAPID_SUBJECT = 'https://llm-ide.com'`, `PUSH_TTL_SECONDS = 3600`

- [ ] **Step 1: Write the security fixture** — `schema/host-api/v1/fixtures/security/push.json`:

```json
{
  "kinds": ["approval_chat", "approval_job", "loop_done", "loop_failed", "autotask_done", "autotask_failed", "graph_done", "graph_failed", "docgen_done", "docgen_failed", "sync_attention"],
  "refusedKinds": ["update_ready", "core_down", "", "Approval_chat", "approval_chat "],
  "endpoints": {
    "allowed": [
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk",
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
      "https://fcm.googleapis.com:443/fcm/send/abc"
    ],
    "refused": [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pw@fcm.googleapis.com/x",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://a.b.notify.windows.com/x",
      "https://notify.windows.com/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "not a url",
      ""
    ]
  },
  "payload": { "fields": ["k", "n"], "maxCount": 999 }
}
```

Append to `schema/host-api/v1/fixtures/security/README.md`:

```markdown

`push.json` pins the `push` capability's bounds: the only kinds a push may name (the desktop notifier's webview kinds, never `update_ready` or `core_down`), the browser push-service endpoints a web subscription may point at (https on 443 to FCM, Mozilla, Apple or one regional `*.notify.windows.com` label, no userinfo), and the two payload fields. The Node tests (`extension/tests/push-webpush.test.mjs`, `extension/tests/host-api-push-gateway.test.mjs`) and the web client tests (`web/tests/push-controller.test.mjs`) read it.
```

- [ ] **Step 2: Write the failing test** — `extension/tests/push-webpush.test.mjs`:

```js
// Web Push sent by the desktop core: RFC 8291 encryption against the RFC's own Appendix A vector, RFC 8292 VAPID,
// the push-service allowlist and the response mapping. No network: fetchImpl stands in for fixedHostFetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { es256Jwt } from '../server/push/jwt.mjs';
import { encryptPayload, pushEndpoint, isPushServiceHost, newVapidJwk, vapidKeyOf, sendWebPush, VAPID_SUBJECT, PUSH_TTL_SECONDS } from '../server/push/webpush.mjs';
import { PUSH_KINDS } from '../server/push/kinds.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEC = JSON.parse(readFileSync(path.join(REPO, 'schema/host-api/v1/fixtures/security/push.json'), 'utf8'));
const b = (s) => Buffer.from(s, 'base64url');
// RFC 8291 Appendix A (https://www.rfc-editor.org/rfc/rfc8291#appendix-A).
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: V.uaPublic, auth: V.authSecret };

/** The receiver side of RFC 8291, for round trips. */
function decrypt(message) {
  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(b(V.uaPrivate));
  const salt = message.subarray(0, 16); const idlen = message[20];
  const asPub = message.subarray(21, 21 + idlen); const ct = message.subarray(21 + idlen);
  const hk = (ikm, s, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
  const ikm = hk(ua.computeSecret(asPub), b(V.authSecret), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32);
  const d = crypto.createDecipheriv('aes-128-gcm', hk(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(out[out.length - 1], 2, 'last-record delimiter');
  return { text: out.subarray(0, -1).toString(), rs: message.readUInt32BE(16) };
}

test('RFC 8291 Appendix A: the same keys and salt give the RFC message byte for byte', () => {
  const out = encryptPayload(V.plaintext, { p256dh: V.uaPublic, auth: V.authSecret }, { asPrivate: b(V.asPrivate), salt: b(V.salt) });
  assert.equal(out.toString('base64url'), V.message);
});

test('a fresh message (random sender key and salt) decrypts with the receiver key, and never repeats', () => {
  const a = encryptPayload('{"k":"loop_done","n":1}', SUB);
  const c = encryptPayload('{"k":"loop_done","n":1}', SUB);
  assert.notEqual(a.toString('hex'), c.toString('hex'));
  assert.deepEqual(decrypt(a), { text: '{"k":"loop_done","n":1}', rs: 4096 });
});

test('bad subscription keys and oversized payloads are refused', () => {
  assert.throws(() => encryptPayload('x', { p256dh: V.authSecret, auth: V.authSecret }), { code: 'PUSH_BAD_KEYS' });
  assert.throws(() => encryptPayload('x', { p256dh: V.uaPublic, auth: 'AAAA' }), { code: 'PUSH_BAD_KEYS' });
  assert.throws(() => encryptPayload('x'.repeat(2000), SUB), { code: 'PUSH_TOO_LARGE' });
});

test('push-service endpoints: exactly the shared fixture', () => {
  for (const e of SEC.endpoints.allowed) assert.ok(pushEndpoint(e), e);
  for (const e of SEC.endpoints.refused) assert.equal(pushEndpoint(e), null, e);
  assert.equal(pushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(1100)}`), null, 'over 1024 characters');
  assert.equal(isPushServiceHost('wns2-par02p.notify.windows.com'), true);
  assert.equal(isPushServiceHost('x.y.notify.windows.com'), false);
  assert.deepEqual(SEC.kinds, [...PUSH_KINDS]);
});

test('ES256 JWT: header, claims and a raw r||s signature that verifies', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const [h, p, s] = es256Jwt({ typ: 'JWT' }, { a: 1 }, privateKey).split('.');
  assert.deepEqual(JSON.parse(b(h)), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(b(p)), { a: 1 });
  assert.equal(b(s).length, 64);
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b(s)));
});

test('VAPID: a push to the endpoint origin, signed with the advertised key, pinned to that one host', async () => {
  const jwkText = newVapidJwk();
  const jwk = JSON.parse(jwkText);
  const vapid = vapidKeyOf(jwkText);
  assert.match(vapid.publicKey, /^[A-Za-z0-9_-]{87}$/);
  const calls = [];
  const fetchImpl = async (url, init, o) => { calls.push({ url, init, o }); return new Response(null, { status: 201 }); };
  const now = 1_800_000_000_000;
  assert.deepEqual(await sendWebPush(SUB, '{"k":"approval_job","n":2}', { vapid, urgency: 'high', topic: 'approval_job', now, fetchImpl }), { ok: true });
  const [c] = calls;
  assert.equal(c.url, SUB.endpoint);
  assert.deepEqual(c.o, { hosts: ['fcm.googleapis.com'], maxBytes: 16 * 1024 });
  assert.equal(c.init.method, 'POST');
  const hd = c.init.headers;
  assert.equal(hd['content-encoding'], 'aes128gcm');
  assert.equal(hd['content-type'], 'application/octet-stream');
  assert.equal(hd.ttl, String(PUSH_TTL_SECONDS));
  assert.equal(hd.urgency, 'high');
  assert.equal(hd.topic, 'approval_job');
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(hd.authorization);
  assert.equal(m[2], vapid.publicKey);
  const [h, p, s] = m[1].split('.');
  assert.deepEqual(JSON.parse(b(p)), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: VAPID_SUBJECT });
  assert.deepEqual(JSON.parse(b(h)), { typ: 'JWT', alg: 'ES256' });
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b(s)));
  assert.equal(decrypt(c.init.body).text, '{"k":"approval_job","n":2}');
});

test('responses: 2xx ok, 404 and 410 gone, other statuses a code, a refused host never fetched', async () => {
  const vapid = vapidKeyOf(newVapidJwk());
  const reply = (status) => async () => new Response(null, { status });
  for (const s of [200, 201, 202]) assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: reply(s) }), { ok: true });
  for (const s of [404, 410]) assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: reply(s) }), { gone: true });
  assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: reply(429) }), { ok: false, code: 'PUSH_HTTP_429' });
  assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: async () => { throw Object.assign(new Error('x'), { code: 'FETCH_REFUSED' }); } }), { ok: false, code: 'FETCH_REFUSED' });
  assert.deepEqual(await sendWebPush(SUB, '{}', { vapid, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { ok: false, code: 'PUSH_UNREACHABLE' });
  let called = false;
  assert.deepEqual(await sendWebPush({ ...SUB, endpoint: 'https://evil.example/x' }, '{}', { vapid, fetchImpl: async () => { called = true; } }), { ok: false, code: 'PUSH_HOST_REFUSED' });
  assert.deepEqual(await sendWebPush({ ...SUB, p256dh: 'AAAA' }, '{}', { vapid, fetchImpl: async () => { called = true; } }), { ok: false, code: 'PUSH_BAD_KEYS' });
  assert.equal(called, false);
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `cd extension && node --test tests/push-webpush.test.mjs`
Expected: FAIL with `Cannot find module '…/server/push/jwt.mjs'`.

- [ ] **Step 4: Write the implementation**

`extension/server/push/jwt.mjs`:

```js
// ES256 compact JWS (ECDSA P-256 + SHA-256, raw r||s signature) for VAPID (RFC 8292) and APNs provider tokens.
import crypto from 'node:crypto';

const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function es256Jwt(header, claims, key) {
  const input = `${part({ ...header, alg: 'ES256' })}.${part(claims)}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
```

`extension/server/push/webpush.mjs`:

```js
// Web Push sent by the desktop core (push notifications plan): RFC 8291 message encryption (aes128gcm, RFC 8188)
// and RFC 8292 VAPID, by hand on node:crypto (no dependency). Each send goes through fixedHostFetch pinned to the ONE
// host of the subscription's endpoint, and that host must be a known browser push service. Never log an endpoint:
// it is a capability URL for that browser.
import crypto from 'node:crypto';
import { fixedHostFetch } from '../fixed-host-fetch.mjs';
import { es256Jwt } from './jwt.mjs';

/** Chrome / Chromium Edge (FCM), Firefox, Safari. */
export const PUSH_SERVICE_HOSTS = Object.freeze(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
// Legacy Edge / Windows WNS: one regional label, e.g. wns2-par02p.notify.windows.com; nothing deeper, nothing else.
const WNS_HOST = /^[a-z0-9-]{1,63}\.notify\.windows\.com$/;
export const isPushServiceHost = (h) => typeof h === 'string' && (PUSH_SERVICE_HOSTS.includes(h) || WNS_HOST.test(h));
export const VAPID_SUBJECT = 'https://llm-ide.com';
export const PUSH_TTL_SECONDS = 3600;
const RECORD_SIZE = 4096;
const MAX_PLAINTEXT = 1024; // our payloads are ~40 bytes; one 4096-byte record allows 3993

/** The endpoint as a URL when it is https on 443 to a push service with no userinfo; else null. */
export function pushEndpoint(raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  return isPushServiceHost(u.hostname) ? u : null;
}

const b64u = (s) => Buffer.from(String(s ?? ''), 'base64url');
const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const refuse = (code, message) => Object.assign(new Error(message), { code });

/** RFC 8291: one aes128gcm record for the subscription's keys. `asPrivate` and `salt` are the Appendix A test seam. */
export function encryptPayload(plaintext, { p256dh, auth }, { asPrivate, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = b64u(p256dh);
  const authSecret = b64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw refuse('PUSH_BAD_KEYS', 'invalid subscription keys');
  const data = Buffer.from(plaintext);
  if (data.length > MAX_PLAINTEXT) throw refuse('PUSH_TOO_LARGE', 'push payload too large');
  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  let shared;
  try { shared = ecdh.computeSecret(uaPublic); } catch { throw refuse('PUSH_BAD_KEYS', 'invalid subscription keys'); }
  const ikm = hkdf(shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so the delimiter is 0x02 (last record) and no padding follows.
  const body = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** A new VAPID key pair as private JWK JSON (it carries x and y, so the public key derives from it). */
export function newVapidJwk() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return JSON.stringify(privateKey.export({ format: 'jwk' }));
}

/** The signing key and the 65-byte uncompressed public key (base64url) the browser subscribes with. */
export function vapidKeyOf(jwkText) {
  const jwk = JSON.parse(jwkText);
  return {
    privateKey: crypto.createPrivateKey({ key: jwk, format: 'jwk' }),
    publicKey: Buffer.concat([Buffer.from([4]), b64u(jwk.x), b64u(jwk.y)]).toString('base64url'),
  };
}

/** One push. `{ gone: true }` means the browser dropped the subscription (404/410): forget it. */
export async function sendWebPush(sub, plaintext, { vapid, urgency = 'normal', topic, now = Date.now(), fetchImpl = fixedHostFetch }) {
  const u = pushEndpoint(sub?.endpoint);
  if (!u) return { ok: false, code: 'PUSH_HOST_REFUSED' };
  let body;
  try { body = encryptPayload(plaintext, sub); } catch (e) { return { ok: false, code: e?.code ?? 'PUSH_BAD_KEYS' }; }
  const jwt = es256Jwt({ typ: 'JWT' }, { aud: u.origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: VAPID_SUBJECT }, vapid.privateKey);
  const headers = {
    'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(PUSH_TTL_SECONDS), urgency,
    authorization: `vapid t=${jwt}, k=${vapid.publicKey}`, ...(topic ? { topic } : {}),
  };
  let res;
  try {
    res = await fetchImpl(u.href, { method: 'POST', headers, body }, { hosts: [u.hostname], maxBytes: 16 * 1024 });
  } catch (e) {
    return { ok: false, code: e?.code === 'FETCH_REFUSED' || e?.code === 'SSRF_BLOCKED' ? e.code : 'PUSH_UNREACHABLE' };
  }
  try { await res.body?.cancel(); } catch { /* already closed */ }
  if (res.status >= 200 && res.status < 300) return { ok: true };
  if (res.status === 404 || res.status === 410) return { gone: true };
  return { ok: false, code: `PUSH_HTTP_${res.status}` };
}
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `cd extension && node --test tests/push-webpush.test.mjs tests/provider-fetch-pinned-guard.test.mjs`
Expected: PASS. The guard stays green because `webpush.mjs` makes no bare fetch.

- [ ] **Step 6: Commit**

```bash
git add extension/server/push/jwt.mjs extension/server/push/webpush.mjs extension/tests/push-webpush.test.mjs schema/host-api/v1/fixtures/security/push.json schema/host-api/v1/fixtures/security/README.md
git commit -m "feat(server): Web Push encryption and VAPID on node:crypto, pinned to the push service host

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: APNs over HTTP/2 against a fake APNs, plus the reviewed http2 path (20 min)

**Files:**
- Create: `extension/server/push/apns.mjs`
- Modify: `extension/tests/provider-fetch-pinned-guard.test.mjs` (two rules, one allowlist entry, one test)
- Test: `extension/tests/push-apns.test.mjs`

**Interfaces:**
- Consumes: `es256Jwt` (Task 2); `systemResolver` from `extension/server/pinned-fetch.mjs`; `ipRefusal` from `extension/server/ip-classifier.mjs`.
- Produces:
  - `APNS_TOPIC = 'dotsoft.llmide.com'`, `APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' }`
  - `APNS_ID_RE = /^[A-Z0-9]{10}$/`, `JWT_MAX_AGE_MS = 3_000_000`
  - `apnsKeyOf(pem: unknown): KeyObject | null`
  - `providerToken({ key, keyId, teamId }, now?: number, { fresh?: boolean }?): string`
  - `sendApns({ token, environment, payload, collapseId, credentials, now?, connect?, timeoutMs? }): Promise<{ ok: true } | { gone: true } | { ok: false, code: string }>`
  - `_resetApnsForTests(): void`

- [ ] **Step 1: Write the failing test** — `extension/tests/push-apns.test.mjs`:

```js
// APNs from the desktop core, against an in-process cleartext HTTP/2 server standing in for Apple (the connect seam).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { sendApns, apnsKeyOf, providerToken, _resetApnsForTests, APNS_TOPIC, APNS_HOSTS, JWT_MAX_AGE_MS } from '../server/push/apns.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const credentials = { key: apnsKeyOf(PEM), keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' };
const TOKEN = 'ab'.repeat(32);
const NOW = 1_800_000_000_000;
const seen = [];
let reply = () => ({ status: 200, body: '' });
const server = http2.createServer();
server.on('stream', (stream, headers) => {
  let body = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => { body += d; });
  stream.on('end', () => {
    seen.push({ headers, body });
    const r = reply(seen.length);
    stream.respond({ ':status': r.status, 'content-type': 'application/json' });
    stream.end(r.body);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const connect = (origin) => { assert.match(origin, /^https:\/\/api(\.sandbox)?\.push\.apple\.com$/); return http2.connect(`http://127.0.0.1:${server.address().port}`); };
after(() => server.close());
beforeEach(() => { seen.length = 0; reply = () => ({ status: 200, body: '' }); _resetApnsForTests(); });
const args = (o = {}) => ({ token: TOKEN, environment: 'sandbox', payload: '{"aps":{}}', collapseId: 'loop_done', credentials, now: NOW, connect, ...o });
const claims = (auth) => JSON.parse(Buffer.from(auth.split(' ')[1].split('.')[1], 'base64url'));

test('a push is one POST to /3/device/<token> with the provider token and the APNs headers', async () => {
  assert.deepEqual(await sendApns(args()), { ok: true });
  const { headers, body } = seen[0];
  assert.equal(headers[':method'], 'POST');
  assert.equal(headers[':path'], `/3/device/${TOKEN}`);
  assert.equal(headers['apns-topic'], APNS_TOPIC);
  assert.equal(headers['apns-push-type'], 'alert');
  assert.equal(headers['apns-priority'], '10');
  assert.equal(headers['apns-collapse-id'], 'loop_done');
  assert.equal(headers['apns-expiration'], String(NOW / 1000 + 3600));
  assert.equal(body, '{"aps":{}}');
  const [h, p, s] = headers.authorization.slice('bearer '.length).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { kid: 'ABCDE12345', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: '9A3YFRQ7SM', iat: NOW / 1000 });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('the provider token is reused for 50 minutes, then minted again', () => {
  const a = providerToken(credentials, NOW);
  assert.equal(providerToken(credentials, NOW + JWT_MAX_AGE_MS - 1), a);
  assert.notEqual(providerToken(credentials, NOW + JWT_MAX_AGE_MS), a);
});

test('410 and dead-token reasons mean gone; other failures carry a code', async () => {
  reply = () => ({ status: 410, body: '{"reason":"Unregistered"}' });
  assert.deepEqual(await sendApns(args()), { gone: true });
  for (const reason of ['BadDeviceToken', 'DeviceTokenNotForTopic']) {
    reply = () => ({ status: 400, body: JSON.stringify({ reason }) });
    assert.deepEqual(await sendApns(args()), { gone: true }, reason);
  }
  reply = () => ({ status: 400, body: '{"reason":"BadTopic"}' });
  assert.deepEqual(await sendApns(args()), { ok: false, code: 'APNS_400_BadTopic' });
  reply = () => ({ status: 500, body: '{"reason":"bad reason with spaces"}' });
  assert.deepEqual(await sendApns(args()), { ok: false, code: 'APNS_500' }, 'an odd reason is never echoed');
});

test('an expired provider token is minted fresh and the push retried once', async () => {
  reply = (n) => (n === 1 ? { status: 403, body: '{"reason":"ExpiredProviderToken"}' } : { status: 200, body: '' });
  assert.deepEqual(await sendApns(args()), { ok: true });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].headers.authorization, seen[1].headers.authorization);
  assert.equal(claims(seen[1].headers.authorization).iss, '9A3YFRQ7SM');
  reply = () => ({ status: 403, body: '{"reason":"InvalidProviderToken"}' });
  assert.deepEqual(await sendApns(args()), { ok: false, code: 'APNS_403_InvalidProviderToken' }, 'only one retry');
});

test('a bad token or environment never connects; an unreachable host is a code', async () => {
  let dialled = false;
  const spy = () => { dialled = true; return connect('https://api.push.apple.com'); };
  for (const o of [{ token: 'AB'.repeat(32) }, { token: 'ab' }, { environment: 'staging' }, { environment: '__proto__' }]) {
    assert.deepEqual(await sendApns(args({ ...o, connect: spy })), { ok: false, code: 'APNS_BAD_TARGET' }, JSON.stringify(o));
  }
  assert.equal(dialled, false);
  const dead = () => http2.connect('http://127.0.0.1:1');
  assert.deepEqual(await sendApns(args({ connect: dead, timeoutMs: 2000 })), { ok: false, code: 'APNS_UNREACHABLE' });
});

test('apnsKeyOf accepts only an EC P-256 PKCS#8 key; the hosts are the two fixed Apple hosts', () => {
  assert.ok(apnsKeyOf(PEM));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  for (const bad of [rsa, p384, 'not a key', '', null, 42]) assert.equal(apnsKeyOf(bad), null);
  assert.deepEqual({ ...APNS_HOSTS }, { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd extension && node --test tests/push-apns.test.mjs`
Expected: FAIL with `Cannot find module '…/server/push/apns.mjs'`.

- [ ] **Step 3: Write the implementation** — `extension/server/push/apns.mjs`:

```js
// APNs from the desktop core (push notifications plan): token-based auth (an ES256 provider JWT from the user's .p8
// key, kid = key id, iss = team id), HTTP/2 POST /3/device/<token> to one of two fixed Apple hosts. The socket dials
// only an address the classifier accepts (as server/pinned-fetch.mjs does for https). The only reviewed http2 path in
// extension/ (tests/provider-fetch-pinned-guard.test.mjs). Never log a device token or the key.
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { es256Jwt } from './jwt.mjs';
import { systemResolver } from '../pinned-fetch.mjs';
import { ipRefusal } from '../ip-classifier.mjs';

export const APNS_TOPIC = 'dotsoft.llmide.com'; // ios_app PRODUCT_BUNDLE_IDENTIFIER
export const APNS_HOSTS = Object.freeze({ production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' });
export const APNS_ID_RE = /^[A-Z0-9]{10}$/;
export const JWT_MAX_AGE_MS = 50 * 60 * 1000; // Apple: no older than 60 min, refreshed no more than every 20 min
const TOKEN_RE = /^[0-9a-f]{64,200}$/;
const GONE = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);
const STALE_JWT = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

/** The .p8 key when it is an EC P-256 PKCS#8 private key, else null. */
export function apnsKeyOf(pem) {
  if (typeof pem !== 'string' || !pem || pem.length > 4096) return null;
  try {
    const k = crypto.createPrivateKey({ key: pem, format: 'pem' });
    return k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? k : null;
  } catch { return null; }
}

const jwtCache = new Map(); // `${teamId}:${keyId}` -> { jwt, at }
export function providerToken({ key, keyId, teamId }, now = Date.now(), { fresh = false } = {}) {
  const id = `${teamId}:${keyId}`;
  const c = jwtCache.get(id);
  if (!fresh && c && now - c.at < JWT_MAX_AGE_MS) return c.jwt;
  const jwt = es256Jwt({ kid: keyId }, { iss: teamId, iat: Math.floor(now / 1000) }, key);
  jwtCache.set(id, { jwt, at: now });
  return jwt;
}
export const _resetApnsForTests = () => jwtCache.clear();

function checkedLookup(hostname, options, cb) {
  const done = typeof options === 'function' ? options : cb;
  const all = typeof options === 'object' && options?.all;
  Promise.resolve(systemResolver(hostname)).then((list) => {
    const addrs = (Array.isArray(list) ? list : [list]).filter(Boolean);
    if (!addrs.length) return done(Object.assign(new Error(`could not resolve ${hostname}`), { code: 'ENOTFOUND' }));
    if (addrs.some((a) => ipRefusal(a.address))) return done(Object.assign(new Error('APNs host resolves to a refused address'), { code: 'SSRF_BLOCKED' }));
    const fam = (a) => a.family || (a.address.includes(':') ? 6 : 4);
    if (all) done(null, addrs.map((a) => ({ address: a.address, family: fam(a) })));
    else done(null, addrs[0].address, fam(addrs[0]));
  }, done);
}

const defaultConnect = (origin) => http2.connect(origin, { lookup: checkedLookup });

function outcome(status, body) {
  if (status === 200) return { ok: true };
  let reason = '';
  try { reason = String(JSON.parse(body)?.reason ?? ''); } catch { /* not JSON */ }
  if (!/^[A-Za-z]{1,40}$/.test(reason)) reason = '';
  if (status === 410 || GONE.has(reason)) return { gone: true };
  return { ok: false, code: `APNS_${status}${reason ? `_${reason}` : ''}`, ...(status === 403 && STALE_JWT.has(reason) ? { staleJwt: true } : {}) };
}

function post(session, { token, payload, jwt, collapseId, expiration, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = session.request({
        ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${jwt}`, 'apns-topic': APNS_TOPIC,
        'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(expiration),
        'apns-collapse-id': collapseId, 'content-type': 'application/json',
      });
    } catch { return done({ ok: false, code: 'APNS_UNREACHABLE' }); }
    req.setTimeout(timeoutMs, () => { req.close(http2.constants.NGHTTP2_CANCEL); done({ ok: false, code: 'APNS_TIMEOUT' }); });
    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (d) => { if (body.length < 4096) body += d; });
    req.on('end', () => done(outcome(status, body)));
    req.on('error', () => done({ ok: false, code: 'APNS_UNREACHABLE' }));
    req.end(payload);
  });
}

/** One push. shortcut: one HTTP/2 connection per push, closed after; pool it if volume ever grows past a few per minute. */
export async function sendApns({ token, environment, payload, collapseId, credentials, now = Date.now(), connect = defaultConnect, timeoutMs = 10_000 }) {
  if (!Object.hasOwn(APNS_HOSTS, environment) || !TOKEN_RE.test(String(token))) return { ok: false, code: 'APNS_BAD_TARGET' };
  const session = connect(`https://${APNS_HOSTS[environment]}`);
  session.on('error', () => { /* reported by the request */ });
  const a = { token, payload, collapseId, expiration: Math.floor(now / 1000) + 3600, timeoutMs };
  try {
    let r = await post(session, { ...a, jwt: providerToken(credentials, now) });
    if (r.staleJwt) r = await post(session, { ...a, jwt: providerToken(credentials, now, { fresh: true }) });
    const { staleJwt, ...rest } = r;
    return rest;
  } finally {
    session.close();
  }
}
```

- [ ] **Step 4: Add the reviewed http2 path to the guard** — in `extension/tests/provider-fetch-pinned-guard.test.mjs`:

  1. In the header comment's list, add the line `//   - a node:http2 import or http2.connect (only APNs, reviewed below),`.
  2. Add to `RULES`:

```js
  http2Import: /['"`](node:)?http2['"`]/g,
  http2Connect: /\bhttp2\.connect\s*\(/g,
```

  3. Add to `ALLOWED`:

```js
  'server/push/apns.mjs': {
    http2Import: { n: 1, why: 'APNs needs HTTP/2: two fixed Apple hosts (APNS_HOSTS), checked lookup, no redirects in the protocol' },
    http2Connect: { n: 1, why: 'the one http2.connect (defaultConnect), only to https://api.push.apple.com or api.sandbox.push.apple.com' },
  },
```

  4. Append a test:

```js
test('APNs dials only the two fixed Apple hosts, and Web Push only through fixedHostFetch', () => {
  const apns = strip(fs.readFileSync(path.join(root, 'server/push/apns.mjs'), 'utf8'));
  assert.match(apns, /APNS_HOSTS = Object\.freeze\(\{ production: 'api\.push\.apple\.com', sandbox: 'api\.sandbox\.push\.apple\.com' \}\)/);
  assert.match(apns, /connect\(`https:\/\/\$\{APNS_HOSTS\[environment\]\}`\)/);
  const wp = strip(fs.readFileSync(path.join(root, 'server/push/webpush.mjs'), 'utf8'));
  assert.match(wp, /fetchImpl = fixedHostFetch/);
  assert.match(wp, /\{ hosts: \[u\.hostname\], maxBytes: 16 \* 1024 \}/);
});
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `cd extension && node --test tests/push-apns.test.mjs tests/provider-fetch-pinned-guard.test.mjs`
Expected: PASS. The guard finds exactly 1 `http2Import` and 1 `http2Connect`, both in `server/push/apns.mjs`.

- [ ] **Step 6: Commit**

```bash
git add extension/server/push/apns.mjs extension/tests/push-apns.test.mjs extension/tests/provider-fetch-pinned-guard.test.mjs
git commit -m "feat(server): APNs token-auth sender over HTTP/2 with a reviewed guard entry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Host API contract: the `push` capability and three commands (20 min)

**Files:**
- Modify: `schema/host-api/v1/commands.json` (capability list in 4 places, 3 commands)
- Modify: `schema/host-api/v1/events.schema.json:199` (capability enum)
- Modify: `schema/host-api/v1/fixtures/events/host.capabilities.json`
- Create: `schema/host-api/v1/fixtures/commands/push.config.request.json`, `push.config.result.json`, `push.register.request.json`, `push.register.result.json`, `push.unregister.request.json`, `push.unregister.result.json`
- Create: `schema/host-api/v1/fixtures/invalid/commands/push.register.endpoint-http.json`, `push.register.bad-kind.json`, `push.register.token-upper.json`
- Modify: `schema/host-api/v1/fixtures/invalid-cases.json`, `schema/host-api/v1/README.md`, `scripts/conformance-host-api.mjs:20`, `extension/tests/host-api-contract.test.mjs`, `extension/tests/host-api-ts-types.test.mjs`
- Regenerate: `extension/routes/host-api/commands.generated.mjs`, `web/src/host-api/types.generated.ts`, `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift`, `HostApiPayloads.swift`, `HostApiSchemas.swift`

**Interfaces:**
- Produces (wire):
  - `push.config {}` → `{ webPushKey: string /* ^[A-Za-z0-9_-]{87}$ */, apns: boolean, registered: 'none'|'webpush'|'apns' }`
  - `push.register { kind: 'webpush'|'apns', endpoint?, p256dh?, auth?, token?, environment?: 'sandbox'|'production' }` → `{ registered: boolean }`
  - `push.unregister {}` → `{ removed: boolean }`
  - All three use capability `push` and are idempotent.
  - Generated names: JS `HOST_API_COMMANDS['push.register']`; TS `HostApiRequest<"push.register">`; Swift `HostApiCommand.pushConfig/.pushRegister/.pushUnregister`, `HostApiPushRegisterRequest(auth:endpoint:environment:kind:p256dh:token:)` (all optional except `kind`), `HostApiPushRegisterResult`, `HostApiPushConfigResult`.

- [ ] **Step 1: Update the counts first (the failing tests)**

  - In `extension/tests/host-api-contract.test.mjs`, change `17 commands` to `20 commands` in both test titles/asserts, and `assert.equal(Object.keys(commands.commands).length, 17)` to `20`.
  - In `extension/tests/host-api-ts-types.test.mjs`, change the expected object to `v: 1, c: 20, e: 7, caps: ['host', 'chat', 'approvals', 'tool_approvals', 'read', 'compose', 'push'], codes: 11, send: { capability: 'chat', idempotent: false }`.
  - In `scripts/conformance-host-api.mjs`, change `const EXPECTED_COMMANDS = 17;` to `20`.

Run: `cd extension && node --test tests/host-api-contract.test.mjs tests/host-api-ts-types.test.mjs`
Expected: FAIL (17 ≠ 20, caps lack `push`).

- [ ] **Step 2: Edit the contract**

In `schema/host-api/v1/commands.json`, replace every `["host", "chat", "approvals", "tool_approvals", "read", "compose"]` (line 4 and the three `enum`s at lines 33, 63 and 89) with `["host", "chat", "approvals", "tool_approvals", "read", "compose", "push"]`. Do the same in `schema/host-api/v1/events.schema.json` line 199. Then add after `"chat.new": { … }` (inside `"commands"`):

```json
    "push.config": {
      "capability": "push",
      "direction": "client_to_host",
      "idempotent": true,
      "v2Tag": null,
      "request": { "type": "object", "additionalProperties": false, "properties": {} },
      "result": {
        "type": "object",
        "additionalProperties": false,
        "required": ["webPushKey", "apns", "registered"],
        "properties": {
          "webPushKey": { "type": "string", "pattern": "^[A-Za-z0-9_-]{87}$" },
          "apns": { "type": "boolean" },
          "registered": { "type": "string", "enum": ["none", "webpush", "apns"] }
        }
      }
    },
    "push.register": {
      "capability": "push",
      "direction": "client_to_host",
      "idempotent": true,
      "v2Tag": null,
      "request": {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind"],
        "properties": {
          "kind": { "type": "string", "enum": ["webpush", "apns"] },
          "endpoint": { "type": "string", "minLength": 12, "maxLength": 1024, "pattern": "^https://[!-~]+$" },
          "p256dh": { "type": "string", "pattern": "^[A-Za-z0-9_-]{87}$" },
          "auth": { "type": "string", "pattern": "^[A-Za-z0-9_-]{22}$" },
          "token": { "type": "string", "pattern": "^[0-9a-f]{64,200}$" },
          "environment": { "type": "string", "enum": ["sandbox", "production"] }
        }
      },
      "result": { "type": "object", "additionalProperties": false, "required": ["registered"], "properties": { "registered": { "type": "boolean" } } }
    },
    "push.unregister": {
      "capability": "push",
      "direction": "client_to_host",
      "idempotent": true,
      "v2Tag": null,
      "request": { "type": "object", "additionalProperties": false, "properties": {} },
      "result": { "type": "object", "additionalProperties": false, "required": ["removed"], "properties": { "removed": { "type": "boolean" } } }
    }
```

Fixtures (one line each):

```
schema/host-api/v1/fixtures/commands/push.config.request.json      {}
schema/host-api/v1/fixtures/commands/push.config.result.json       {"webPushKey":"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8","apns":false,"registered":"none"}
schema/host-api/v1/fixtures/commands/push.register.request.json    {"kind":"webpush","endpoint":"https://fcm.googleapis.com/fcm/send/fixture-endpoint-id","p256dh":"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4","auth":"BTBZMqHH6r4Tts7J_aSIgg"}
schema/host-api/v1/fixtures/commands/push.register.result.json     {"registered":true}
schema/host-api/v1/fixtures/commands/push.unregister.request.json  {}
schema/host-api/v1/fixtures/commands/push.unregister.result.json   {"removed":true}
schema/host-api/v1/fixtures/invalid/commands/push.register.endpoint-http.json  {"kind":"webpush","endpoint":"http://fcm.googleapis.com/fcm/send/x"}
schema/host-api/v1/fixtures/invalid/commands/push.register.bad-kind.json       {"kind":"sms"}
schema/host-api/v1/fixtures/invalid/commands/push.register.token-upper.json    {"kind":"apns","token":"ABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABABAB","environment":"sandbox"}
```

(The two keys are the public RFC 8291 Appendix A test keys: an application-server public key and a user-agent public key. They are test vectors, never real.)

`schema/host-api/v1/fixtures/events/host.capabilities.json`: change the capabilities array to `["host","chat","approvals","tool_approvals","read","compose","push"]`.

In `schema/host-api/v1/fixtures/invalid-cases.json`, under `"commands"`, after the `chat.new.unknown-field.json` row:

```json
    "push.register.endpoint-http.json": { "command": "push.register", "kind": "request", "at": ".endpoint" },
    "push.register.bad-kind.json": { "command": "push.register", "kind": "request", "at": ".kind" },
    "push.register.token-upper.json": { "command": "push.register", "kind": "request", "at": ".token" },
```

(Add a comma to the preceding row if it was the last one.)

`schema/host-api/v1/README.md`:

  - change `All 17 commands are listed below.` to `All 20 commands are listed below.`
  - add three table rows after `usage.get`:

```markdown
| `push.config` | push | yes | — |
| `push.register` | push | yes | — |
| `push.unregister` | push | yes | — |
```

  - add after the `compose` paragraph:

```markdown
`push` lets a paired phone or web app receive push notifications that the desktop sends while it runs: an approval waiting, a Loop run / Auto Task / code graph / Doc Gen document finished or failed, or sync needing attention. `push.config` returns the desktop's VAPID public key (`webPushKey`, the browser subscribes with it), whether an APNs key is configured (`apns`) and what this device registered. `push.register` stores exactly one target per device, either a Web Push subscription (`kind: webpush`, `endpoint`, `p256dh`, `auth`; the endpoint must be https on 443 to a known browser push service, see `fixtures/security/push.json`) or an APNs device token (`kind: apns`, lowercase hex `token`, `environment`). `push.unregister` drops it. A target is removed with its device (revoke, idle expiry, the device cap, an identity reset). A push names one fixed kind and a count, never text: the device shows its own words (the web worker's `sw-push.js`, the iPhone's `Localizable.strings`), the same sentences as the desktop notifier. Served only when the host enables it (desktop: `LLMIDE_HOST_API_PUSH=1`, default off) and only to a device paired while it was served.
```

- [ ] **Step 3: Regenerate and run the gates**

Run:

```bash
node scripts/generate-host-api.mjs
node scripts/conformance-host-api.mjs
make host-api-check
cd extension && node --test tests/host-api-contract.test.mjs tests/host-api-ts-types.test.mjs && cd ..
make test-shared-protocol
```

Expected: the generator rewrites the 5 generated files, conformance prints no `bad(…)` lines, and all tests PASS. `make test-shared-protocol` builds SharedProtocol, and runs its swift-testing suite when Xcode is present.

- [ ] **Step 4: Commit**

```bash
git add schema/host-api/v1 scripts/conformance-host-api.mjs extension/tests/host-api-contract.test.mjs extension/tests/host-api-ts-types.test.mjs extension/routes/host-api/commands.generated.mjs web/src/host-api/types.generated.ts ios_app/SharedProtocol/Sources/SharedProtocol/HostApiCommands.swift ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPayloads.swift ios_app/SharedProtocol/Sources/SharedProtocol/HostApiSchemas.swift
git commit -m "feat(host-api): push capability with push.config, push.register and push.unregister

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Push targets store, vault keys and the gateway commands (25 min)

**Files:**
- Create: `extension/kb/migrations/0065_host_api_push.sql`
- Create: `extension/kb/push-targets.mjs`
- Create: `extension/routes/host-api/push-target.mjs`
- Modify: `extension/kb/host-api-devices.mjs:12` (export `parseScopes`)
- Modify: `extension/server/vault.mjs` (4 keys in `ALLOWED_KEYS` and `INTERNAL_KEYS`)
- Modify: `extension/routes/host-api/gateway.mjs` (capability flag, `deps.push`, 3 cases)
- Modify: `extension/routes/host-api/audit.mjs:14` (`SUCCESS` set)
- Test: `extension/tests/push-targets.test.mjs`, `extension/tests/host-api-push-gateway.test.mjs`

**Interfaces:**
- Consumes: `pushEndpoint` (Task 2); the Task 4 commands.
- Produces:
  - `setPushTarget(userId, deviceId, target, now?)`, `clearPushTarget(userId, deviceId): boolean`, `pushTargetKind(userId, deviceId): 'webpush'|'apns'|null`
  - `listPushTargets(userId): Array<{ deviceId, name, scopes: string[], kind, endpoint, p256dh, auth, token, environment, lastResult, lastAt }>`
  - `notePushResult(userId, deviceId, result: string, now?)`
  - `pushTargetOf(payload): { ok: true, target } | { ok: false, message }`
  - gateway `deps.push = { config(userId, deviceId), register(userId, deviceId, target), unregister(userId, deviceId) }` (Task 6 supplies the real ones through the lazy `./push.mjs`)
  - `hostApiCapabilities(env)` includes `'push'` when `LLMIDE_HOST_API_PUSH === '1'`
  - vault keys `push.vapidKey`, `push.apnsKey`, `push.apnsKeyId`, `push.apnsTeamId`

- [ ] **Step 1: Write the failing store test** — `extension/tests/push-targets.test.mjs`:

```js
// Push targets of paired Host API devices: one per device, upserted, and gone with the device.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_push-targets-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();
after(wipe);

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const dev = await import('../kb/host-api-devices.mjs');
const pt = await import('../kb/push-targets.mjs');
const vault = await import('../server/vault.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `p-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'p' }).id;
const WEB = { kind: 'webpush', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'P'.repeat(87), auth: 'A'.repeat(22) };
const APNS = { kind: 'apns', token: 'ab'.repeat(32), environment: 'sandbox' };

test('one target per device, upserted; listed with the device name and grant', () => {
  const u = user();
  const { deviceId } = dev.issueDeviceToken(u, 'Pixel', 1000, ['host', 'chat', 'push']);
  pt.setPushTarget(u, deviceId, WEB, 2000);
  assert.equal(pt.pushTargetKind(u, deviceId), 'webpush');
  pt.notePushResult(u, deviceId, 'ok', 3000);
  pt.setPushTarget(u, deviceId, APNS, 4000);
  const [row, ...rest] = pt.listPushTargets(u);
  assert.equal(rest.length, 0);
  assert.deepEqual(row, { deviceId, name: 'Pixel', scopes: ['host', 'chat', 'push'], kind: 'apns', endpoint: null, p256dh: null, auth: null, token: APNS.token, environment: 'sandbox', lastResult: null, lastAt: null });
  assert.equal(pt.clearPushTarget(u, deviceId), true);
  assert.equal(pt.clearPushTarget(u, deviceId), false);
  assert.equal(pt.pushTargetKind(u, deviceId), null);
});

test('revoking the device, or an identity reset, removes its target', () => {
  const u = user();
  const a = dev.issueDeviceToken(u, 'a', 1000, ['host', 'push']).deviceId;
  const b = dev.issueDeviceToken(u, 'b', 1000, ['host', 'push']).deviceId;
  pt.setPushTarget(u, a, WEB);
  pt.setPushTarget(u, b, APNS);
  dev.revokeDevice(u, a);
  assert.deepEqual(pt.listPushTargets(u).map((r) => r.deviceId), [b]);
  kb.getDb().prepare('DELETE FROM host_api_devices').run(); // what loadOrCreateHostIdentity does on a reset
  assert.deepEqual(pt.listPushTargets(u), []);
});

test('another user never sees or clears a target; a target needs a real device', () => {
  const u = user();
  const v = user();
  const { deviceId } = dev.issueDeviceToken(u, 'a', 1000, ['host', 'push']);
  pt.setPushTarget(u, deviceId, WEB);
  assert.deepEqual(pt.listPushTargets(v), []);
  assert.equal(pt.clearPushTarget(v, deviceId), false);
  assert.throws(() => pt.setPushTarget(u, 'h1-nope', WEB), /FOREIGN KEY/);
});

test('the push secrets are vault-internal: storable, never client-settable or listed', () => {
  const u = user();
  for (const k of ['push.vapidKey', 'push.apnsKey', 'push.apnsKeyId', 'push.apnsTeamId']) {
    assert.equal(vault.isUserSettableVaultKey(k), false, k);
    vault.setSecret(kb.getDb(), u, k, 'v');
    assert.equal(vault.getSecret(kb.getDb(), u, k), 'v');
    assert.ok(!vault.VAULT_KEYS.includes(k), k);
  }
  assert.deepEqual(vault.listSecretKeys(kb.getDb(), u).filter((r) => r.secret_key.startsWith('push.')), []);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd extension && node --test tests/push-targets.test.mjs`
Expected: FAIL with `Cannot find module '…/kb/push-targets.mjs'`.

- [ ] **Step 3: Write the store, the migration and the vault keys**

`extension/kb/migrations/0065_host_api_push.sql`:

```sql
-- Push targets of paired Host API devices (push notifications plan). One per device; the row goes with its device.
-- The endpoint / token are useless without the vault-held VAPID key / APNs .p8, so they are stored as is.
CREATE TABLE host_api_push (
  user_id     TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('webpush', 'apns')),
  endpoint    TEXT,
  p256dh      TEXT,
  auth        TEXT,
  token       TEXT,
  environment TEXT CHECK (environment IS NULL OR environment IN ('sandbox', 'production')),
  created_at  INTEGER NOT NULL,
  last_result TEXT,
  last_at     INTEGER,
  PRIMARY KEY (user_id, device_id),
  FOREIGN KEY (user_id, device_id) REFERENCES host_api_devices (user_id, device_id) ON DELETE CASCADE
);
```

`extension/kb/host-api-devices.mjs` line 12: change `function parseScopes(text) {` to `export function parseScopes(text) {`.

`extension/kb/push-targets.mjs`:

```js
// Push targets of paired Host API devices (push notifications plan): one Web Push subscription or APNs device token
// per device. A row goes with its device (FOREIGN KEY … ON DELETE CASCADE): revoke, idle expiry, the device cap and an
// identity reset all remove it. Endpoints and tokens are capability values: never logged, never returned by a route.
import { getDb, requireUser } from './db.mjs';
import { parseScopes } from './host-api-devices.mjs';

export function setPushTarget(userId, deviceId, t, now = Date.now()) {
  requireUser(userId);
  getDb().prepare(`INSERT INTO host_api_push (user_id, device_id, kind, endpoint, p256dh, auth, token, environment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET kind = excluded.kind, endpoint = excluded.endpoint, p256dh = excluded.p256dh,
      auth = excluded.auth, token = excluded.token, environment = excluded.environment, created_at = excluded.created_at,
      last_result = NULL, last_at = NULL`)
    .run(userId, String(deviceId), t.kind, t.endpoint ?? null, t.p256dh ?? null, t.auth ?? null, t.token ?? null, t.environment ?? null, now);
}

export function clearPushTarget(userId, deviceId) {
  requireUser(userId);
  return getDb().prepare('DELETE FROM host_api_push WHERE user_id = ? AND device_id = ?').run(userId, String(deviceId)).changes > 0;
}

export function pushTargetKind(userId, deviceId) {
  requireUser(userId);
  return getDb().prepare('SELECT kind FROM host_api_push WHERE user_id = ? AND device_id = ?').get(userId, String(deviceId))?.kind ?? null;
}

export function listPushTargets(userId) {
  requireUser(userId);
  return getDb().prepare(`SELECT p.device_id, d.name, d.scopes, p.kind, p.endpoint, p.p256dh, p.auth, p.token, p.environment, p.last_result, p.last_at
    FROM host_api_push p JOIN host_api_devices d ON d.user_id = p.user_id AND d.device_id = p.device_id
    WHERE p.user_id = ? ORDER BY d.last_seen_at DESC`).all(userId)
    .map((r) => ({ deviceId: r.device_id, name: r.name, scopes: parseScopes(r.scopes), kind: r.kind, endpoint: r.endpoint, p256dh: r.p256dh,
      auth: r.auth, token: r.token, environment: r.environment, lastResult: r.last_result, lastAt: r.last_at }));
}

export function notePushResult(userId, deviceId, result, now = Date.now()) {
  requireUser(userId);
  getDb().prepare('UPDATE host_api_push SET last_result = ?, last_at = ? WHERE user_id = ? AND device_id = ?').run(String(result).slice(0, 80), now, userId, String(deviceId));
}
```

`extension/server/vault.mjs`:

  - In `ALLOWED_KEYS`, after `'sync.boxRefreshToken',`, add:

```js
  // Push notifications sent by the desktop (routes/host-api/push.mjs): the VAPID signing key (private JWK, generated
  // here) and the user's APNs token key (.p8 PEM) with its key id and team id. Server-internal: never client-settable
  // through /kb/vault, never listed, never returned by a route.
  'push.vapidKey',
  'push.apnsKey',
  'push.apnsKeyId',
  'push.apnsTeamId',
```

  - In `INTERNAL_KEYS`, add `'push.vapidKey', 'push.apnsKey', 'push.apnsKeyId', 'push.apnsTeamId'` to the `new Set([...])` list.

Run: `cd extension && node --test tests/push-targets.test.mjs tests/vault.test.mjs tests/migrations.test.mjs`
Expected: PASS.

- [ ] **Step 4: Write the failing gateway test** — `extension/tests/host-api-push-gateway.test.mjs`:

```js
// Host API v1 `push` on the desktop gateway, with injected fakes (no DB, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, hostApiCapabilities } from '../routes/host-api/gateway.mjs';

const SEC = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../schema/host-api/v1/fixtures/security/push.json'), 'utf8'));
const HELLO = { clientName: 't', clientVersion: '1', platform: 'web', apiVersions: [1] };
const req = (id, command, payload = {}) => JSON.stringify({ apiVersion: 1, id, type: 'request', command, payload, ts: 1 });
const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const WEB = { kind: 'webpush', endpoint: 'https://fcm.googleapis.com/fcm/send/secret-endpoint', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };

function harness() {
  const t = { sent: [], audits: [], regs: [], unregs: [], served: true };
  const tokens = new Map();
  let n = 0;
  t.g = createGateway({
    send: (_s, text) => t.sent.push(JSON.parse(text)), close: () => {}, hostName: () => 'Test Computer', log: () => {},
    capabilities: () => ['host', 'chat', 'approvals', ...(t.served ? ['push'] : [])],
    pins: { consumePin: (pin) => (pin === '123456' ? 'u1' : null) },
    devices: {
      issueDeviceToken(userId, _name, _now, scopes) { n += 1; const deviceId = `h1-dev${n}`; const token = `tok-${deviceId}-0123456789`; tokens.set(token, { userId, deviceId, scopes }); return { deviceId, token }; },
      authenticateDeviceToken: (token) => tokens.get(token) ?? null,
      revokeDevice: () => true,
    },
    audit: (event, f) => t.audits.push([event, f]),
    push: {
      config: () => ({ webPushKey: KEY, apns: false, registered: t.regs.length ? 'webpush' : 'none' }),
      register: (u, d, target) => { t.regs.push([u, d, target]); },
      unregister: (u, d) => { t.unregs.push([u, d]); return true; },
    },
  });
  t.last = () => t.sent.at(-1);
  t.pair = async (s) => { t.g.opened(s, '127.0.0.1'); await t.g.receive(s, req('h', 'host.hello', HELLO)); await t.g.receive(s, req('p', 'host.auth.pair', { pin: '123456' })); return t.last().result; };
  return t;
}

test('the push capability is served only with LLMIDE_HOST_API_PUSH=1', () => {
  assert.ok(!hostApiCapabilities({}).includes('push'));
  assert.ok(hostApiCapabilities({ LLMIDE_HOST_API_PUSH: '1' }).includes('push'));
});

test('a device paired while push is served configures, registers and unregisters', async () => {
  const t = harness();
  const s = { n: 1 };
  assert.ok((await t.pair(s)).capabilities.includes('push'));
  await t.g.receive(s, req('c1', 'push.config'));
  assert.deepEqual(t.last().result, { webPushKey: KEY, apns: false, registered: 'none' });
  await t.g.receive(s, req('c2', 'push.register', WEB));
  assert.deepEqual(t.last().result, { registered: true });
  assert.deepEqual(t.regs, [['u1', 'h1-dev1', WEB]]);
  const apns = { kind: 'apns', token: 'ab'.repeat(32), environment: 'production' };
  await t.g.receive(s, req('c3', 'push.register', apns));
  assert.deepEqual(t.regs[1][2], apns);
  await t.g.receive(s, req('c4', 'push.unregister'));
  assert.deepEqual(t.last().result, { removed: true });
  assert.deepEqual(t.audits.map(([e, f]) => [e, f.detail ?? null]), [['pair_ok', null], ['push_register', 'webpush fcm.googleapis.com'], ['push_register', 'apns production'], ['push_unregister', null]]);
  assert.ok(!JSON.stringify(t.audits).includes('secret-endpoint') && !JSON.stringify(t.audits).includes('abab'), 'no endpoint or token in the audit');
});

test('register refuses what the schema lets through but the host does not accept', async () => {
  const t = harness();
  const s = { n: 1 };
  await t.pair(s);
  const bad = [
    ...SEC.endpoints.refused.filter((e) => /^https:\/\/[!-~]+$/.test(e) && e.length >= 12).map((endpoint) => ({ ...WEB, endpoint })),
    { kind: 'webpush', endpoint: WEB.endpoint, auth: WEB.auth },
    { ...WEB, p256dh: `A${WEB.p256dh.slice(1)}` },
    { ...WEB, token: 'ab'.repeat(32) },
    { kind: 'apns', token: 'ab'.repeat(32) },
    { kind: 'apns', token: 'ab'.repeat(32), environment: 'sandbox', endpoint: WEB.endpoint },
  ];
  for (const [i, p] of bad.entries()) {
    await t.g.receive(s, req(`b${i}`, 'push.register', p));
    assert.equal(t.last().error?.code, 'invalid_payload', JSON.stringify(p));
  }
  assert.deepEqual(t.regs, []);
  assert.ok(t.audits.some(([e]) => e === 'push_refused'));
});

test('a device paired before push was served is denied with a re-pair hint; an unserved push is unavailable', async () => {
  const t = harness();
  t.served = false;
  const s = { n: 1 };
  const paired = await t.pair(s);
  t.served = true;
  await t.g.receive(s, req('c', 'push.register', WEB));
  assert.equal(t.last().error.code, 'denied');
  assert.match(t.last().error.message, /pair again/);
  const s2 = { n: 2 };
  t.served = false;
  t.g.opened(s2, '127.0.0.2');
  await t.g.receive(s2, req('h', 'host.hello', HELLO));
  await t.g.receive(s2, req('t', 'host.auth.token', { token: paired.token }));
  await t.g.receive(s2, req('c', 'push.config'));
  assert.equal(t.last().error.code, 'capability_unavailable');
});
```

Run: `cd extension && node --test tests/host-api-push-gateway.test.mjs`
Expected: FAIL. `hostApiCapabilities({ LLMIDE_HOST_API_PUSH: '1' })` lacks `push`, and the commands answer `unknown_command`.

- [ ] **Step 5: Write the validators and the gateway cases**

`extension/routes/host-api/push-target.mjs`:

```js
// Host API v1 `push.register` checks beyond the schema (push notifications plan): exactly one target shape per kind,
// a web endpoint on a known browser push service, real P-256 subscription keys. Pure.
import { pushEndpoint } from '../../server/push/webpush.mjs';

const P256 = /^[A-Za-z0-9_-]{87}$/;
const AUTH = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[0-9a-f]{64,200}$/;
const refuse = (message) => ({ ok: false, message });

export function pushTargetOf(p) {
  if (p?.kind === 'webpush') {
    if (p.token !== undefined || p.environment !== undefined) return refuse('A web push registration carries no APNs token.');
    if (!pushEndpoint(p.endpoint)) return refuse('That push endpoint is not a known browser push service.');
    if (!P256.test(p.p256dh ?? '') || Buffer.from(p.p256dh, 'base64url')[0] !== 4 || !AUTH.test(p.auth ?? '')) return refuse('The subscription keys are not valid.');
    return { ok: true, target: { kind: 'webpush', endpoint: p.endpoint, p256dh: p.p256dh, auth: p.auth } };
  }
  if (p?.kind === 'apns') {
    if (p.endpoint !== undefined || p.p256dh !== undefined || p.auth !== undefined) return refuse('An APNs registration carries only a token and an environment.');
    if (!TOKEN.test(p.token ?? '') || (p.environment !== 'sandbox' && p.environment !== 'production')) return refuse('The device token or environment is not valid.');
    return { ok: true, target: { kind: 'apns', token: p.token, environment: p.environment } };
  }
  return refuse('Unknown push kind.');
}
```

`extension/routes/host-api/audit.mjs` line 14: add `'push_register', 'push_unregister', 'push_apns_set', 'push_apns_removed'` to the `SUCCESS` set (`push_refused` stays a failure by default).

`extension/routes/host-api/gateway.mjs`:

  - Line 1 comment: change `the 17 commands (chat, approvals, the \`read\` slice and \`compose\`)` to `the 20 commands (chat, approvals, the \`read\` slice, \`compose\` and \`push\`)`.
  - Imports: add `import { pushTargetOf } from './push-target.mjs';`.
  - `hostApiCapabilities`: change its last line to

```js
    ...(env.LLMIDE_HOST_API_COMPOSE === '1' ? ['compose'] : []), // default off, as read
    ...(env.LLMIDE_HOST_API_PUSH === '1' ? ['push'] : [])]; // default off: push notifications sent by this desktop
```

  - After `const chatSessions = () => import('../../kb/chat-sessions.mjs');` add `const pushModule = () => import('./push.mjs'); // Task 6; lazy, off the boot path`.
  - In `defaultDeps()`, after `models: …,` add:

```js
    // Push targets and the VAPID key, in process and user-scoped (routes/host-api/push.mjs). Lazy: off the boot path.
    push: {
      config: async (userId, deviceId) => (await pushModule()).pushConfig(userId, deviceId),
      register: async (userId, deviceId, target) => (await pushModule()).registerTarget(userId, deviceId, target),
      unregister: async (userId, deviceId) => (await pushModule()).unregisterTarget(userId, deviceId),
    },
```

  - In `handle()`'s `switch`, before `default:`:

```js
      case 'push.config': {
        if (readRefused(s, entry, id)) return;
        return respond(s, id, command, await deps.push.config(userId, entry.state.deviceId));
      }
      case 'push.register': {
        const deviceId = entry.state.deviceId;
        // Checked before the turn bucket (pure and cheap; the frame bucket still bounds a flood of bad ones).
        const t = pushTargetOf(p);
        if (!t.ok) {
          audit('push_refused', { peer: entry.peer, userId, deviceId, detail: String(p.kind), dedupeKey: `${deviceId}:push` });
          return fail(s, id, 'invalid_payload', t.message);
        }
        const wait = rate.turn(deviceId, deps.now()); // a write: the turn bucket
        if (wait != null) return rateRefused(s, entry, id, wait);
        await deps.push.register(userId, deviceId, t.target);
        // Never the endpoint or the token: the push-service host or the APNs environment only.
        const detail = t.target.kind === 'apns' ? `apns ${t.target.environment}` : `webpush ${new URL(t.target.endpoint).hostname}`;
        audit('push_register', { peer: entry.peer, userId, deviceId, detail, dedupeKey: `${deviceId}:${detail}` });
        return respond(s, id, command, { registered: true });
      }
      case 'push.unregister': {
        const deviceId = entry.state.deviceId;
        const wait = rate.turn(deviceId, deps.now());
        if (wait != null) return rateRefused(s, entry, id, wait);
        const removed = Boolean(await deps.push.unregister(userId, deviceId));
        audit('push_unregister', { peer: entry.peer, userId, deviceId });
        return respond(s, id, command, { removed });
      }
```

`./push.mjs` does not exist until Task 6. Only the default deps import it, lazily, so this task's tests (which inject `push`) never load it.

- [ ] **Step 6: Run the tests and see them pass**

Run: `cd extension && node --test tests/host-api-push-gateway.test.mjs tests/host-api-gateway.test.mjs tests/host-api-compose.test.mjs tests/push-targets.test.mjs tests/host-api-audit-rate.test.mjs tests/host-api-devices.test.mjs && npx eslint routes/host-api kb/push-targets.mjs server/push`
Expected: PASS, and eslint reports 0 problems.

- [ ] **Step 7: Commit**

```bash
git add extension/kb/migrations/0065_host_api_push.sql extension/kb/push-targets.mjs extension/kb/host-api-devices.mjs extension/server/vault.mjs extension/routes/host-api/push-target.mjs extension/routes/host-api/gateway.mjs extension/routes/host-api/audit.mjs extension/tests/push-targets.test.mjs extension/tests/host-api-push-gateway.test.mjs
git commit -m "feat(host-api): serve push.config, push.register and push.unregister behind LLMIDE_HOST_API_PUSH

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The sender, the desktop-only routes and API v118 (25 min)

**Files:**
- Create: `extension/routes/host-api/push.mjs`
- Modify: `extension/routes/host-api/http-routes.mjs` (4 routes, `pushDeps` option)
- Modify: `extension/server.mjs` (`SERVER_API_VERSION`, a v118 changelog line, 3 `ALL_ENDPOINTS` entries)
- Modify: `ui/screens/shell/core-api-floor.ts:5`, `docs/spec/api-server.md`, `docs/spec/cross-cutting.md` (version lines)
- Modify: `schema/http/host-api.schema.json` (4 endpoints)
- Create: `schema/http/fixtures/host-api/post-host-api-push-send-200.json`, `post-host-api-push-send-400-bad-kind.json`, `post-host-api-push-send-403-no-proof.json`, `get-host-api-push-status-200.json`, `get-host-api-push-status-403-no-proof.json`, `put-host-api-push-apns-200.json`, `put-host-api-push-apns-400-bad-key.json`, `put-host-api-push-apns-403-no-proof.json`, `delete-host-api-push-apns-200.json`, `delete-host-api-push-apns-403-no-proof.json`
- Modify: `extension/tests/http-contract-live.test.mjs:121` (the host-api skip regex gains `PUT`)
- Regenerate: `docs/reference/api/openapi.yaml`, `extension/src/lib/api-types.ts`, `schema/http/INVENTORY.md`
- Test: `extension/tests/host-api-push.test.mjs`, `extension/tests/host-api-push-routes.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–5 (`webPayload`, `apnsPayload`, `COUNTED`, `isPushKind`, `sendWebPush`, `newVapidJwk`, `vapidKeyOf`, `sendApns`, `apnsKeyOf`, `APNS_ID_RE`, the store functions, `hostApiCapabilities`, `TokenBucket`).
- Produces:
  - `PUSH_LIMITS = { coalesceMs: 10000, seenMax: 256, deviceBurst: 10, devicePerHour: 30 }`
  - `vapidFor(userId, db?)`, `apnsCredentials(userId, db?)`, `apnsStatus(userId, db?) → { configured, keyId, teamId }`
  - `setApnsCredentials(userId, { key, keyId, teamId }, db?) → { ok: true, keyId } | { ok: false, field: 'key'|'keyId'|'teamId' }`, `clearApnsCredentials(userId, db?)`
  - `pushConfig(userId, deviceId)`, `registerTarget`, `unregisterTarget`, `pushStatus(userId, served)`
  - `createPushGate(limits?) → { admit(userId, kind, key, now), device(deviceId, now) }`, `pushGate`
  - `dispatchPush(userId, { kind, key, count }, { gate, served, now?, send?, db?, log? }) → Promise<{ sent: number }>`
  - HTTP:
    - `POST /host-api/push/send { kind, key?, count? } → { sent }`
    - `GET /host-api/push/status → { served, apns: { configured, keyId, teamId }, devices: [{ deviceId, name, kind, lastResult, lastAt }] }`
    - `PUT /host-api/push/apns { key, keyId, teamId } → { configured, keyId, teamId }`
    - `DELETE /host-api/push/apns → { configured: false, keyId: null, teamId: null }`

- [ ] **Step 1: Write the failing dispatcher test** — `extension/tests/host-api-push.test.mjs`:

```js
// The desktop's push sender: vault credentials, the gate and the fan-out (fake senders; real DB and vault).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-push-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();
after(wipe);

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const dev = await import('../kb/host-api-devices.mjs');
const pt = await import('../kb/push-targets.mjs');
const P = await import('../routes/host-api/push.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `q-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'q' }).id;
const PEM = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const WEB = { kind: 'webpush', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const APNS = { kind: 'apns', token: 'ab'.repeat(32), environment: 'sandbox' };
function fakes(results = {}) {
  const calls = [];
  return {
    calls,
    send: {
      webpush: async (t, plaintext, o) => { calls.push(['webpush', t.deviceId, plaintext, o.urgency, o.topic]); return results.webpush ?? { ok: true }; },
      apns: async (o) => { calls.push(['apns', o.token, o.payload, o.collapseId, o.environment]); return results.apns ?? { ok: true }; },
    },
  };
}

test('the VAPID key is made once, kept in the vault, and only its public half leaves', () => {
  const u = user();
  const a = P.vapidFor(u);
  assert.equal(P.vapidFor(u).publicKey, a.publicKey);
  assert.match(a.publicKey, /^[A-Za-z0-9_-]{87}$/);
  const raw = kb.getDb().prepare("SELECT ciphertext FROM user_secrets WHERE user_id = ? AND secret_key = 'push.vapidKey'").get(u).ciphertext;
  assert.ok(!String(raw).includes('"d"'), 'encrypted at rest');
  const { deviceId } = dev.issueDeviceToken(u, 'w', Date.now(), ['host', 'push']);
  assert.deepEqual(P.pushConfig(u, deviceId), { webPushKey: a.publicKey, apns: false, registered: 'none' });
});

test('APNs credentials: validated, stored, reported without the key, removable', () => {
  const u = user();
  assert.deepEqual(P.setApnsCredentials(u, { key: 'nope', keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' }), { ok: false, field: 'key' });
  assert.deepEqual(P.setApnsCredentials(u, { key: PEM, keyId: 'abc', teamId: '9A3YFRQ7SM' }), { ok: false, field: 'keyId' });
  assert.deepEqual(P.setApnsCredentials(u, { key: PEM, keyId: 'ABCDE12345', teamId: '' }), { ok: false, field: 'teamId' });
  assert.deepEqual(P.apnsStatus(u), { configured: false, keyId: null, teamId: null });
  assert.deepEqual(P.setApnsCredentials(u, { key: PEM, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' }), { ok: true, keyId: 'ABCDE12345' });
  assert.deepEqual(P.apnsStatus(u), { configured: true, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' });
  assert.ok(P.apnsCredentials(u).key);
  P.clearApnsCredentials(u);
  assert.deepEqual(P.apnsStatus(u), { configured: false, keyId: null, teamId: null });
});

test('the gate: each key once, one push per user and kind per 10 s, 10 then 30 an hour per device', () => {
  const g = P.createPushGate();
  const t = 1_000_000;
  assert.equal(g.admit('u', 'approval_job', 'a', t), true);
  assert.equal(g.admit('u', 'approval_job', 'a', t + 60_000), false, 'same key never twice');
  assert.equal(g.admit('u', 'approval_job', 'b', t + 1_000), false, 'a burst is coalesced');
  assert.equal(g.admit('u', 'approval_job', 'c', t + 11_000), true);
  assert.equal(g.admit('v', 'approval_job', 'c', t + 11_000), true, 'users are separate');
  assert.equal(g.admit('u', 'loop_done', null, t + 11_001), true, 'kinds are separate');
  let ok = 0;
  for (let i = 0; i < 12; i += 1) if (g.device('d', t)) ok += 1;
  assert.equal(ok, 10);
  assert.equal(g.device('d', t + 120_000), true, 'one back every 2 minutes');
});

test('fan-out: only granted devices with a target; payloads are the fixed kind and count', async () => {
  const u = user();
  const web = dev.issueDeviceToken(u, 'web', Date.now(), ['host', 'push']).deviceId;
  const phone = dev.issueDeviceToken(u, 'phone', Date.now(), ['host', 'push']).deviceId;
  const old = dev.issueDeviceToken(u, 'old', Date.now(), ['host', 'chat']).deviceId;
  pt.setPushTarget(u, web, WEB);
  pt.setPushTarget(u, phone, APNS);
  pt.setPushTarget(u, old, WEB);
  P.setApnsCredentials(u, { key: PEM, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' });
  const f = fakes();
  const out = await P.dispatchPush(u, { kind: 'approval_job', key: 'j1', count: 3 }, { gate: P.createPushGate(), served: true, send: f.send });
  assert.deepEqual(out, { sent: 2 });
  assert.deepEqual(f.calls.find((c) => c[0] === 'webpush'), ['webpush', web, '{"k":"approval_job","n":3}', 'high', 'approval_job']);
  const a = f.calls.find((c) => c[0] === 'apns');
  assert.deepEqual([a[1], a[3], a[4]], [APNS.token, 'approval_job', 'sandbox']);
  assert.equal(JSON.parse(a[2]).aps.alert['loc-key'], 'PUSH_APPROVAL_JOB_MANY');
  assert.equal(f.calls.length, 2, 'the device without a push grant got nothing');
  assert.deepEqual(pt.listPushTargets(u).filter((r) => r.deviceId !== old).map((r) => r.lastResult), ['ok', 'ok']);
});

test('fan-out: nothing when unserved or for a non-push kind; gone targets removed; no APNs key noted', async () => {
  const u = user();
  const web = dev.issueDeviceToken(u, 'web', Date.now(), ['host', 'push']).deviceId;
  const phone = dev.issueDeviceToken(u, 'phone', Date.now(), ['host', 'push']).deviceId;
  pt.setPushTarget(u, web, WEB);
  pt.setPushTarget(u, phone, APNS);
  const f = fakes({ webpush: { gone: true } });
  assert.deepEqual(await P.dispatchPush(u, { kind: 'loop_done' }, { gate: P.createPushGate(), served: false, send: f.send }), { sent: 0 });
  assert.deepEqual(await P.dispatchPush(u, { kind: 'core_down' }, { gate: P.createPushGate(), served: true, send: f.send }), { sent: 0 });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await P.dispatchPush(u, { kind: 'loop_done' }, { gate: P.createPushGate(), served: true, send: f.send }), { sent: 0 });
  assert.deepEqual(pt.listPushTargets(u).map((r) => [r.deviceId, r.lastResult]), [[phone, 'APNS_NOT_CONFIGURED']]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd extension && node --test tests/host-api-push.test.mjs`
Expected: FAIL with `Cannot find module '…/routes/host-api/push.mjs'`.

- [ ] **Step 3: Write the sender** — `extension/routes/host-api/push.mjs`:

```js
// Push notifications sent by the desktop core (push notifications plan): the VAPID and APNs credentials in the user's
// vault, the de-dup / coalesce / per-device gate (the desktop notifier's rules, enforced again here), and the fan-out of
// one fixed kind to the user's paired devices that registered a target and were granted `push`. Never logs an
// endpoint, a device token or a key.
import { getDb } from '../../kb/db.mjs';
import { getSecret, setSecret } from '../../server/vault.mjs';
import { clearPushTarget, listPushTargets, notePushResult, pushTargetKind, setPushTarget } from '../../kb/push-targets.mjs';
import { newVapidJwk, vapidKeyOf, sendWebPush } from '../../server/push/webpush.mjs';
import { APNS_ID_RE, apnsKeyOf, sendApns } from '../../server/push/apns.mjs';
import { COUNTED, isPushKind, webPayload, apnsPayload } from '../../server/push/kinds.mjs';
import { TokenBucket } from './rate.mjs';

export const PUSH_LIMITS = Object.freeze({ coalesceMs: 10_000, seenMax: 256, deviceBurst: 10, devicePerHour: 30 });
const APNS_KEYS = ['push.apnsKey', 'push.apnsKeyId', 'push.apnsTeamId'];

export function vapidFor(userId, db = getDb()) {
  let text = getSecret(db, userId, 'push.vapidKey');
  if (!text) { text = newVapidJwk(); setSecret(db, userId, 'push.vapidKey', text); }
  return vapidKeyOf(text);
}

export function apnsCredentials(userId, db = getDb()) {
  const key = apnsKeyOf(getSecret(db, userId, 'push.apnsKey'));
  const keyId = getSecret(db, userId, 'push.apnsKeyId');
  const teamId = getSecret(db, userId, 'push.apnsTeamId');
  return key && APNS_ID_RE.test(keyId ?? '') && APNS_ID_RE.test(teamId ?? '') ? { key, keyId, teamId } : null;
}

export function apnsStatus(userId, db = getDb()) {
  const c = apnsCredentials(userId, db);
  return { configured: c !== null, keyId: c?.keyId ?? null, teamId: c?.teamId ?? null };
}

export function setApnsCredentials(userId, { key, keyId, teamId } = {}, db = getDb()) {
  if (!apnsKeyOf(key)) return { ok: false, field: 'key' };
  if (typeof keyId !== 'string' || !APNS_ID_RE.test(keyId)) return { ok: false, field: 'keyId' };
  if (typeof teamId !== 'string' || !APNS_ID_RE.test(teamId)) return { ok: false, field: 'teamId' };
  db.transaction(() => { setSecret(db, userId, APNS_KEYS[0], key); setSecret(db, userId, APNS_KEYS[1], keyId); setSecret(db, userId, APNS_KEYS[2], teamId); })();
  return { ok: true, keyId };
}

export function clearApnsCredentials(userId, db = getDb()) {
  db.transaction(() => { for (const k of APNS_KEYS) setSecret(db, userId, k, null); })();
}

export const pushConfig = (userId, deviceId) => ({ webPushKey: vapidFor(userId).publicKey, apns: apnsCredentials(userId) !== null, registered: pushTargetKind(userId, deviceId) ?? 'none' });
export const registerTarget = (userId, deviceId, target) => setPushTarget(userId, deviceId, target);
export const unregisterTarget = (userId, deviceId) => clearPushTarget(userId, deviceId);

/** The Settings card's view: never an endpoint, a token or a key. */
export function pushStatus(userId, served) {
  return {
    served: Boolean(served), apns: apnsStatus(userId),
    devices: listPushTargets(userId).map(({ deviceId, name, kind, lastResult, lastAt }) => ({ deviceId, name, kind, lastResult, lastAt })),
  };
}

export function createPushGate(limits = PUSH_LIMITS) {
  const seen = [];
  const last = new Map();    // `${userId}\0${kind}` -> ms
  const buckets = new Map(); // deviceId -> TokenBucket (bounded by the paired devices)
  return {
    admit(userId, kind, key, now) {
      if (key) {
        const k = `${userId}\0${kind}\0${key}`;
        if (seen.includes(k)) return false;
        seen.push(k);
        if (seen.length > limits.seenMax) seen.shift();
      }
      const lk = `${userId}\0${kind}`;
      const t = last.get(lk);
      if (t != null && now - t < limits.coalesceMs) return false;
      last.set(lk, now);
      return true;
    },
    device(deviceId, now) {
      let b = buckets.get(deviceId);
      if (!b) { b = new TokenBucket(limits.deviceBurst, limits.devicePerHour / 3600, now); buckets.set(deviceId, b); }
      return b.take(now) == null;
    },
  };
}
export const pushGate = createPushGate();

/** Sends one kind to every paired device of the user with a target and a `push` grant. Never throws. */
export async function dispatchPush(userId, { kind, key = null, count = 1 }, { gate, served, now = Date.now(), send = { webpush: sendWebPush, apns: sendApns }, db = getDb(), log = () => {} }) {
  if (!served || !isPushKind(kind) || !gate.admit(userId, kind, key, now)) return { sent: 0 };
  let sent = 0;
  let vapid = null;
  let apns;
  for (const t of listPushTargets(userId).filter((x) => x.scopes.includes('push'))) {
    if (!gate.device(t.deviceId, now)) { notePushResult(userId, t.deviceId, 'rate_limited', now); continue; }
    let r;
    try {
      if (t.kind === 'webpush') {
        vapid ??= vapidFor(userId, db);
        r = await send.webpush(t, webPayload(kind, count), { vapid, urgency: COUNTED.has(kind) ? 'high' : 'normal', topic: kind, now });
      } else {
        if (apns === undefined) apns = apnsCredentials(userId, db);
        r = apns ? await send.apns({ token: t.token, environment: t.environment, payload: apnsPayload(kind, count), collapseId: kind, credentials: apns, now })
          : { ok: false, code: 'APNS_NOT_CONFIGURED' };
      }
    } catch { r = { ok: false, code: 'PUSH_FAILED' }; }
    if (r.gone) { clearPushTarget(userId, t.deviceId); log(`push ${t.kind} target gone — removed`); continue; }
    notePushResult(userId, t.deviceId, r.ok ? 'ok' : r.code, now);
    if (r.ok) sent += 1; else log(`push ${t.kind} failed (${r.code})`);
  }
  return { sent };
}
```

Run: `cd extension && node --test tests/host-api-push.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 4: Write the failing routes test** — `extension/tests/host-api-push-routes.test.mjs`:

```js
// The desktop-only push routes (routes/host-api/http-routes.mjs): JWT user + bus host proof, then the listener flag.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-push-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();

const KEY_HEX = 'c3'.repeat(32);
const env = { LLMIDE_HOST_APPROVAL_KEY: KEY_HEX, LLMIDE_HOST_API_PUSH: '1' };
const PROOF = crypto.createHmac('sha256', Buffer.from(KEY_HEX, 'hex')).update('bus-host-proof/v1').digest('hex');
const PEM = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleHostApiRoute } = await import('../routes/host-api/http-routes.mjs');
const { createPushGate } = await import('../routes/host-api/push.mjs');

const state = { userId: users.registerUser(kb.getDb(), { email: `pr-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' }).id, enabled: true };
const audited = [];
const audit = () => ({ record: (event, f) => audited.push([event, f.userId, f.detail ?? null]) });
const server = http.createServer((req, res) => {
  req.user = { id: state.userId };
  void handleHostApiRoute(req, res, { hostApi: () => null, enabled: state.enabled, env, audit, pushDeps: { gate: createPushGate() } });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); wipe(); });
async function call(method, p, body, { proof = PROOF } = {}) {
  const r = await fetch(base + p, { method, headers: { ...(proof ? { 'x-llmide-host-nonce': proof } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const ROUTES = [['POST', '/host-api/push/send', { kind: 'loop_done' }], ['GET', '/host-api/push/status'], ['PUT', '/host-api/push/apns', {}], ['DELETE', '/host-api/push/apns']];

test('without the host proof every push route answers 403; with the flag off 404', async () => {
  for (const [m, p, b] of ROUTES) assert.equal((await call(m, p, b, { proof: null })).body.error.code, 'HOST_PROOF_REQUIRED', p);
  state.enabled = false;
  for (const [m, p, b] of ROUTES) assert.equal((await call(m, p, b)).body.error.code, 'HOST_API_DISABLED', p);
  state.enabled = true;
});

test('send validates the kind, key and count, then fans out (nothing registered: sent 0)', async () => {
  for (const b of [{ kind: 'core_down' }, { kind: 'loop_done', key: 'a b' }, { kind: 'loop_done', count: 0 }, { kind: 'loop_done', count: 1000 }]) {
    const r = await call('POST', '/host-api/push/send', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
  }
  assert.deepEqual(await call('POST', '/host-api/push/send', { kind: 'approval_chat', key: 'activity:1', count: 2 }), { status: 200, body: { sent: 0 } });
});

test('the APNs key: refused when invalid, saved, reported without the key, removed; audited without it', async () => {
  const bad = await call('PUT', '/host-api/push/apns', { key: 'x', keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'VALIDATION_FAILED']);
  assert.deepEqual(await call('PUT', '/host-api/push/apns', { key: PEM, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' }), { status: 200, body: { configured: true, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' } });
  const s = await call('GET', '/host-api/push/status');
  assert.deepEqual(s.body, { served: true, apns: { configured: true, keyId: 'ABCDE12345', teamId: '9A3YFRQ7SM' }, devices: [] });
  assert.ok(!JSON.stringify(s.body).includes('PRIVATE KEY'));
  assert.deepEqual(await call('DELETE', '/host-api/push/apns'), { status: 200, body: { configured: false, keyId: null, teamId: null } });
  assert.deepEqual(audited.map(([e]) => e), ['push_apns_set', 'push_apns_removed']);
  assert.ok(!JSON.stringify(audited).includes('PRIVATE KEY'));
});
```

Run: `cd extension && node --test tests/host-api-push-routes.test.mjs`
Expected: FAIL (404 `NOT_FOUND` for the push paths).

- [ ] **Step 5: Add the routes** — `extension/routes/host-api/http-routes.mjs`:

  - Header comment: add four lines to the route list:

```
//   POST   /host-api/push/send     { sent }                   fan one fixed kind out to the user's push devices
//   GET    /host-api/push/status   { served, apns, devices }  devices with a push target (never an endpoint or token)
//   PUT    /host-api/push/apns     { configured, keyId, teamId }  save the APNs .p8 key, key id and team id to the vault
//   DELETE /host-api/push/apns     { configured: false, … }   remove them
```

  - Imports: change `import { send } from '../../server/route-http.mjs';` to `import { send, readJson } from '../../server/route-http.mjs';`, and add:

```js
import { hostApiCapabilities } from './gateway.mjs';
import { isPushKind } from '../../server/push/kinds.mjs';
import { dispatchPush, pushGate, pushStatus, apnsStatus, setApnsCredentials, clearApnsCredentials } from './push.mjs';
```

  - `route()` signature: add `pushDeps = {}` to the destructured options.
  - Before the final `return fail(res, 404, 'NOT_FOUND', …)` in `route()`, add `if (path.startsWith('/host-api/push/')) return pushRoute(req, res, path, userId, { env, audit, pushDeps });`.
  - Append after `route()`:

```js
const PUSH_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const bodyOf = async (req) => { try { return await readJson(req, 16 * 1024); } catch { return null; } };

async function pushRoute(req, res, path, userId, { env, audit, pushDeps }) {
  const served = hostApiCapabilities(env).includes('push');
  if (req.method === 'POST' && path === '/host-api/push/send') {
    const b = await bodyOf(req);
    if (!b || !isPushKind(b.kind)) return fail(res, 400, 'VALIDATION_FAILED', 'Unknown push kind');
    if (b.key != null && !(typeof b.key === 'string' && PUSH_KEY_RE.test(b.key))) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid push key');
    if (b.count != null && !(Number.isInteger(b.count) && b.count >= 1 && b.count <= 999)) return fail(res, 400, 'VALIDATION_FAILED', 'Invalid push count');
    const out = await dispatchPush(userId, { kind: b.kind, key: b.key ?? null, count: b.count ?? 1 },
      { gate: pushGate, served, log: (m) => logger.info('host_api_push', { message: m }), ...pushDeps });
    send(res, 200, { sent: out.sent });
    return true;
  }
  if (req.method === 'GET' && path === '/host-api/push/status') {
    send(res, 200, pushStatus(userId, served));
    return true;
  }
  if (req.method === 'PUT' && path === '/host-api/push/apns') {
    const r = setApnsCredentials(userId, (await bodyOf(req)) ?? {});
    if (!r.ok) return fail(res, 400, 'VALIDATION_FAILED', `Invalid ${r.field}`);
    audit().record('push_apns_set', { peer: req.socket?.remoteAddress, userId, detail: `key ${r.keyId}` });
    send(res, 200, apnsStatus(userId));
    return true;
  }
  if (req.method === 'DELETE' && path === '/host-api/push/apns') {
    clearApnsCredentials(userId);
    audit().record('push_apns_removed', { peer: req.socket?.remoteAddress, userId });
    send(res, 200, apnsStatus(userId));
    return true;
  }
  return fail(res, 404, 'NOT_FOUND', 'No such Host API route');
}
```

Run: `cd extension && node --test tests/host-api-push-routes.test.mjs tests/host-api-routes.test.mjs`
Expected: PASS.

- [ ] **Step 6: API v118 and the HTTP contract**

`extension/server.mjs`:

  - Change `const SERVER_API_VERSION = 117;` to `const SERVER_API_VERSION = 118;`.
  - Add this as the first line of the version comment block (above `//   v117 — …`):

```js
//   v118 — push notifications sent by the desktop, additive (contract schema/http/host-api.schema.json, schema/host-api/v1/README.md `push`): POST /host-api/push/send { kind (one of the notifier's 11 webview kinds), key? (opaque de-dup key, [A-Za-z0-9_.:-]{1,64}), count? (1-999) } → { sent } (fans out to the user's paired devices with a push target and the `push` grant; de-dup per key, one per user and kind per 10 s, 30 per device per hour); GET /host-api/push/status → { served, apns: { configured, keyId, teamId }, devices: [{ deviceId, name, kind, lastResult, lastAt }] } (never an endpoint, token or key); PUT /host-api/push/apns { key (.p8 PEM, EC P-256), keyId, teamId (10 × [A-Z0-9]) } → { configured, keyId, teamId } (400 VALIDATION_FAILED "Invalid <field>"); DELETE /host-api/push/apns → { configured: false, keyId: null, teamId: null }. Same guards as the other /host-api routes: JWT + bus host proof (403 HOST_PROOF_REQUIRED first), then 404 HOST_API_DISABLED without a v1 listener; 'kbWrite' bucket. Pushes go out only when LLMIDE_HOST_API_PUSH=1.
```

  - In `ALL_ENDPOINTS`, after `'/host-api/devices/:id',` add `'/host-api/push/send',`, `'/host-api/push/status'` and `'/host-api/push/apns'` (one per line).

`ui/screens/shell/core-api-floor.ts`: `export const APP_API_VERSION = 118;`.

`docs/spec/api-server.md` and `docs/spec/cross-cutting.md`: change `SERVER_API_VERSION = 117` to `SERVER_API_VERSION = 118` (one line in each).

`schema/http/host-api.schema.json`:

  - In `description`, change `Rows: POST /host-api/pin, GET /host-api/devices, DELETE /host-api/devices/:id.` to `Rows: POST /host-api/pin, GET /host-api/devices, DELETE /host-api/devices/:id, and the push routes POST /host-api/push/send, GET /host-api/push/status, PUT and DELETE /host-api/push/apns (API v118; never an endpoint, device token or key in any answer).`
  - Add to `endpoints`:

```json
    "POST /host-api/push/send": {
      "request": {
        "body": {
          "type": "object",
          "required": ["kind"],
          "properties": {
            "kind": { "type": "string", "description": "one of the desktop notifier's webview kinds (server/push/kinds.mjs PUSH_KINDS)" },
            "key": { "type": "string", "description": "opaque de-dup key, [A-Za-z0-9_.:-]{1,64}, never shown" },
            "count": { "type": "integer", "description": "1-999, how many are waiting (approvals)" }
          }
        }
      },
      "responses": {
        "200": { "type": "object", "properties": { "sent": { "type": "integer", "description": "devices the push service or APNs accepted it for" } } },
        "400": { "$ref": "_common#/$defs/Error" },
        "403": { "$ref": "_common#/$defs/Error" },
        "404": { "$ref": "_common#/$defs/Error" }
      }
    },
    "GET /host-api/push/status": {
      "responses": {
        "200": {
          "type": "object",
          "properties": {
            "served": { "type": "boolean", "description": "LLMIDE_HOST_API_PUSH=1 on this core" },
            "apns": { "$ref": "#/$defs/ApnsStatus" },
            "devices": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "deviceId": { "type": "string" },
                  "name": { "type": "string" },
                  "kind": { "type": "string", "enum": ["webpush", "apns"] },
                  "lastResult": { "type": ["string", "null"], "description": "ok, rate_limited, APNS_NOT_CONFIGURED or an error code; null before the first push" },
                  "lastAt": { "type": ["integer", "null"], "description": "ms since epoch" }
                }
              }
            }
          }
        },
        "403": { "$ref": "_common#/$defs/Error" },
        "404": { "$ref": "_common#/$defs/Error" }
      }
    },
    "PUT /host-api/push/apns": {
      "request": {
        "body": {
          "type": "object",
          "required": ["key", "keyId", "teamId"],
          "properties": {
            "key": { "type": "string", "description": "the .p8 file's PEM text (EC P-256 PKCS#8); stored in the vault, never returned" },
            "keyId": { "type": "string", "description": "10 × [A-Z0-9]" },
            "teamId": { "type": "string", "description": "10 × [A-Z0-9]" }
          }
        }
      },
      "responses": {
        "200": { "$ref": "#/$defs/ApnsStatus" },
        "400": { "$ref": "_common#/$defs/Error" },
        "403": { "$ref": "_common#/$defs/Error" },
        "404": { "$ref": "_common#/$defs/Error" }
      }
    },
    "DELETE /host-api/push/apns": {
      "responses": {
        "200": { "$ref": "#/$defs/ApnsStatus" },
        "403": { "$ref": "_common#/$defs/Error" },
        "404": { "$ref": "_common#/$defs/Error" }
      }
    }
```

  - Add to `$defs`:

```json
    "ApnsStatus": {
      "type": "object",
      "properties": {
        "configured": { "type": "boolean" },
        "keyId": { "type": ["string", "null"] },
        "teamId": { "type": ["string", "null"] }
      }
    }
```

Fixtures in `schema/http/fixtures/host-api/`. All are transcribed from the handler (`tests/host-api-push-routes.test.mjs`). Ids and times are example values.

```json
// post-host-api-push-send-200.json
{ "endpoint": "POST /host-api/push/send", "status": 200, "request": { "body": { "kind": "approval_chat", "key": "activity:12", "count": 2 } }, "response": { "sent": 1 } }
// post-host-api-push-send-400-bad-kind.json
{ "endpoint": "POST /host-api/push/send", "status": 400, "request": { "body": { "kind": "core_down" } }, "response": { "error": { "code": "VALIDATION_FAILED", "message": "Unknown push kind" } } }
// post-host-api-push-send-403-no-proof.json
{ "endpoint": "POST /host-api/push/send", "status": 403, "request": { "body": { "kind": "loop_done" } }, "response": { "error": { "code": "HOST_PROOF_REQUIRED", "message": "This route is for the desktop app only" } } }
// get-host-api-push-status-200.json
{ "endpoint": "GET /host-api/push/status", "status": 200, "response": { "served": true, "apns": { "configured": true, "keyId": "ABCDE12345", "teamId": "9A3YFRQ7SM" }, "devices": [{ "deviceId": "h1-0b0c2e7a-1f3d-4c5e-9a8b-7d6c5b4a3f21", "name": "iPhone", "kind": "apns", "lastResult": "ok", "lastAt": 1793750100000 }] } }
// get-host-api-push-status-403-no-proof.json
{ "endpoint": "GET /host-api/push/status", "status": 403, "response": { "error": { "code": "HOST_PROOF_REQUIRED", "message": "This route is for the desktop app only" } } }
// put-host-api-push-apns-200.json
{ "endpoint": "PUT /host-api/push/apns", "status": 200, "request": { "body": { "key": "-----BEGIN PRIVATE KEY-----\nEXAMPLE\n-----END PRIVATE KEY-----\n", "keyId": "ABCDE12345", "teamId": "9A3YFRQ7SM" } }, "response": { "configured": true, "keyId": "ABCDE12345", "teamId": "9A3YFRQ7SM" } }
// put-host-api-push-apns-400-bad-key.json
{ "endpoint": "PUT /host-api/push/apns", "status": 400, "request": { "body": { "key": "not a key", "keyId": "ABCDE12345", "teamId": "9A3YFRQ7SM" } }, "response": { "error": { "code": "VALIDATION_FAILED", "message": "Invalid key" } } }
// put-host-api-push-apns-403-no-proof.json
{ "endpoint": "PUT /host-api/push/apns", "status": 403, "request": { "body": { "key": "x", "keyId": "ABCDE12345", "teamId": "9A3YFRQ7SM" } }, "response": { "error": { "code": "HOST_PROOF_REQUIRED", "message": "This route is for the desktop app only" } } }
// delete-host-api-push-apns-200.json
{ "endpoint": "DELETE /host-api/push/apns", "status": 200, "response": { "configured": false, "keyId": null, "teamId": null } }
// delete-host-api-push-apns-403-no-proof.json
{ "endpoint": "DELETE /host-api/push/apns", "status": 403, "response": { "error": { "code": "HOST_PROOF_REQUIRED", "message": "This route is for the desktop app only" } } }
```

(Write each object to its own file without the `//` comment line.)

`extension/tests/http-contract-live.test.mjs` line 121: change `/^(GET|POST|DELETE) \/host-api\//` to `/^(GET|POST|PUT|DELETE) \/host-api\//`.

- [ ] **Step 7: Regenerate and run the contract gates**

Run:

```bash
node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && node scripts/http-inventory.mjs
make contract-gates
cd extension && node --test tests/http-contract-live.test.mjs tests/host-api-push.test.mjs tests/host-api-push-routes.test.mjs tests/host-api-routes.test.mjs && cd ..
cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/core-api-floor.test.mjs && cd ..
```

Expected: the generators rewrite `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml` (with `x-api-version: 118`) and `schema/http/INVENTORY.md` (ALL_ENDPOINTS 197 → 200). Everything else PASSES.

- [ ] **Step 8: Commit**

```bash
git add extension/routes/host-api/push.mjs extension/routes/host-api/http-routes.mjs extension/server.mjs ui/screens/shell/core-api-floor.ts docs/spec/api-server.md docs/spec/cross-cutting.md schema/http extension/tests/http-contract-live.test.mjs extension/tests/host-api-push.test.mjs extension/tests/host-api-push-routes.test.mjs extension/src/lib/api-types.ts docs/reference/api/openapi.yaml
git commit -m "feat(server): desktop push sender and its host-only routes (API v118)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Desktop: the notifier hands admitted kinds to the core; Settings takes the APNs key (25 min)

**Files:**
- Modify: `desktop/src-tauri/src/notify.rs` (`Outcome`, `fire`, `fire_host`, `notify_user`, one test)
- Modify: `ui/screens/shell/notify/notify.ts` (`PushSender`, `setPushSender`, `wantsPush`, `notifyUser`)
- Modify: `ui/screens/shell/Shell.tsx:100-112` (install the sender)
- Create: `ui/screens/shell/notify/PushCard.tsx`
- Modify: `ui/screens/shell/notify/register-card.ts` (a second card)
- Test: `ui/screens/shell/tests/notify.test.mjs` (append), `ui/screens/shell/tests/push-card.test.mjs`

**Interfaces:**
- Consumes: `POST /host-api/push/send`, `GET /host-api/push/status`, `PUT` / `DELETE /host-api/push/apns` (Task 6).
- Produces:
  - Rust `pub struct Outcome { pub shown: bool, pub push: bool }`; `notify_user` returns it, serialized `{ "shown": bool, "push": bool }`
  - TS `type PushSender = (kind: NotifyKind, count: number, key?: string) => Promise<unknown>`, `setPushSender(fn: PushSender | null): void`, `wantsPush(out: unknown): boolean`
  - `decodePushStatus(v: unknown): PushStatus | null`, `resultLabel(r: string | null): string`, `PushBody`, default `PushCard`

- [ ] **Step 1: Write the failing Rust test** — append inside `mod tests` in `desktop/src-tauri/src/notify.rs`:

```rust
    #[test]
    fn the_outcome_reaches_the_webview_as_two_flags() {
        let v = serde_json::to_value(Outcome { shown: false, push: true }).unwrap();
        assert_eq!(v, serde_json::json!({ "shown": false, "push": true }));
        assert_eq!(Outcome::default(), Outcome { shown: false, push: false });
    }
```

Run: `cd desktop/src-tauri && cargo test --lib notify`
Expected: FAIL with `cannot find struct Outcome`.

- [ ] **Step 2: Return the outcome** — in `desktop/src-tauri/src/notify.rs`:

  - Header comment, after the Privacy paragraph:

```rust
//! Push: `notify_user` also answers whether the paired phone / web app should get this kind (admitted by the switch,
//! focus and gate rules, and the main window is not focused: the user is away). The webview then asks the core to push
//! the same kind and count (ui/screens/shell/notify/notify.ts); the core never sees text either.
```

  - After `pub fn section_id(…) { … }`:

```rust
/// What `fire` did: shown on this desktop, and whether the paired devices should get a push.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Outcome {
    pub shown: bool,
    pub push: bool,
}
```

  - Replace `fn fire(…) -> Result<bool, String> { … }`, `pub fn fire_host(…) { … }` and `pub fn notify_user(…) -> Result<bool, String> { … }` with:

```rust
/// Shows `kind` unless its switch is off, the user is already looking, or the gate drops it. A notification refused
/// by the OS (no permission, no daemon) is logged and still counts as admitted for the push. No lock is held across a
/// window or notification call.
fn fire(app: &AppHandle, kind: Kind, key: Option<&str>, count: u32) -> Outcome {
    if !enabled(kind, &crate::prefs::stored().notifications) {
        return Outcome::default();
    }
    let focused = main_focused(app);
    let active = *lock(&ACTIVE_SECTION);
    if suppressed(kind, focused, active) {
        return Outcome::default();
    }
    let now = crate::confirm::now_ms();
    if !lock(&GATE).get_or_insert_with(Gate::default).admit(kind, key, now) {
        return Outcome::default();
    }
    let shown = match show(app, kind, count) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("notify: {}: {e}", kind.wire());
            false
        }
    };
    if shown && !focused {
        *lock(&PENDING_ROUTE) = Some((kind.route(), now));
    }
    Outcome { shown, push: !focused }
}

fn show(app: &AppHandle, kind: Kind, count: u32) -> Result<(), String> {
    let n = app.notification();
    let mut state = n.permission_state().map_err(|e| e.to_string())?;
    if state == PermissionState::Prompt || state == PermissionState::PromptWithRationale {
        state = n.request_permission().map_err(|e| e.to_string())?;
    }
    if state != PermissionState::Granted {
        return Err("notification permission not granted".into());
    }
    n.builder().title(TITLE).body(kind.body(count)).show().map_err(|e| e.to_string())
}

/// A host-side fact (update found, backend down). Never pushed: the core has no such kind.
pub fn fire_host(app: &AppHandle, kind: Kind, key: Option<&str>) {
    let _ = fire(app, kind, key, 1);
}

/// The webview names a kind (never text), an optional opaque de-dup key and a count.
#[tauri::command]
pub fn notify_user(app: AppHandle, kind: String, key: Option<String>, count: Option<u32>) -> Result<Outcome, String> {
    let k = Kind::from_webview(&kind).ok_or("unknown notification kind")?;
    if key.as_deref().is_some_and(|x| !valid_key(x)) {
        return Err("invalid notification key".into());
    }
    Ok(fire(&app, k, key.as_deref(), count.unwrap_or(1).min(999)))
}
```

Run: `cd desktop/src-tauri && cargo test --lib notify && cd .. && node scripts/check-capabilities.mjs --product`
Expected: PASS. No new command is added, so the capability check is unchanged.

- [ ] **Step 3: Write the failing webview tests** — append to `ui/screens/shell/tests/notify.test.mjs`:

```js
test("an admitted kind the user is away for is pushed with its count and key; nothing else is", async () => {
  const pushed = [];
  n.setPushSender(async (kind, count, key) => { pushed.push([kind, count, key ?? null]); });
  const invoke = (out) => async () => out;
  await n.notifyUser("approval_chat", { count: 3, key: "a1" }, invoke({ shown: true, push: true }));
  await n.notifyUser("loop_done", {}, invoke({ shown: false, push: true }));
  await n.notifyUser("loop_failed", {}, invoke({ shown: true, push: false }));
  await n.notifyUser("graph_done", {}, invoke(true));
  await n.notifyUser("docgen_done", {}, async () => { throw new Error("no host"); });
  assert.deepEqual(pushed, [["approval_chat", 3, "a1"], ["loop_done", 1, null]]);
  n.setPushSender(async () => { throw new Error("core down"); });
  await n.notifyUser("loop_done", {}, invoke({ shown: true, push: true })); // never throws
  n.setPushSender(null);
  await n.notifyUser("loop_done", {}, invoke({ shown: true, push: true }));
  assert.equal(n.wantsPush({ push: true }), true);
  for (const v of [null, true, { push: "true" }, { shown: true }]) assert.equal(n.wantsPush(v), false);
});
```

Create `ui/screens/shell/tests/push-card.test.mjs`:

```js
// Settings > General > Phone and web push: decoding the status, the per-device line and the APNs key form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "./helpers.mjs";

const c = await load("notify/PushCard.tsx");
const STATUS = { served: true, apns: { configured: false, keyId: null, teamId: null }, devices: [{ deviceId: "h1-a", name: "iPhone", kind: "apns", lastResult: "ok", lastAt: 1 }] };

test("the status decodes strictly and drops malformed devices", () => {
  assert.deepEqual(c.decodePushStatus(STATUS), STATUS);
  assert.equal(c.decodePushStatus({ ...STATUS, served: "yes" }), null);
  assert.equal(c.decodePushStatus(null), null);
  const d = c.decodePushStatus({ ...STATUS, devices: [...STATUS.devices, { deviceId: "x", name: "w", kind: "sms" }, 3] });
  assert.equal(d.devices.length, 1);
});

test("each result reads in plain words, unknown codes as a failure", () => {
  assert.equal(c.resultLabel(null), "Nothing sent yet");
  assert.equal(c.resultLabel("ok"), "Last push accepted by the push service");
  assert.equal(c.resultLabel("rate_limited"), "Held back: too many pushes this hour");
  assert.equal(c.resultLabel("APNS_NOT_CONFIGURED"), "Waiting for the Apple Push key below");
  assert.equal(c.resultLabel("APNS_403_BadCertificate"), "Last push failed");
});

test("the card lists devices, asks for the key when none is saved, and never shows a saved key", () => {
  const noop = () => {};
  const empty = renderToStaticMarkup(React.createElement(c.PushBody, { status: STATUS, error: null, onSave: noop, onRemove: noop }));
  assert.match(empty, /iPhone · iPhone · Last push accepted/);
  assert.match(empty, /Apple Push key \(\.p8\)/);
  assert.match(empty, /Key ID/);
  const saved = renderToStaticMarkup(React.createElement(c.PushBody, { status: { ...STATUS, apns: { configured: true, keyId: "ABCDE12345", teamId: "9A3YFRQ7SM" } }, error: null, onSave: noop, onRemove: noop }));
  assert.match(saved, /ABCDE12345/);
  assert.match(saved, /Remove key/);
  assert.doesNotMatch(saved, /\.p8\)/);
  const off = renderToStaticMarkup(React.createElement(c.PushBody, { status: null, error: null, onSave: noop, onRemove: noop }));
  assert.match(off, /LLMIDE_HOST_API_PUSH=1/);
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/notify.test.mjs ../ui/screens/shell/tests/push-card.test.mjs`
Expected: FAIL (`n.setPushSender is not a function`, and `PushCard.tsx` is missing).

- [ ] **Step 4: Forward admitted kinds** — `ui/screens/shell/notify/notify.ts`:

  - Header comment, append the sentence: `When the host answers \`push: true\` (admitted while the window is not focused), the same kind, count and key go to the core, which pushes them to the paired devices (routes/host-api/push.mjs).`
  - Replace `notifyUser` with:

```ts
/** Asks the core to push a kind to the paired devices; installed by the shell (Shell.tsx), null elsewhere. */
export type PushSender = (kind: NotifyKind, count: number, key?: string) => Promise<unknown>;
let pushSender: PushSender | null = null;
export function setPushSender(fn: PushSender | null): void { pushSender = fn; }

/** The host's `notify_user` answer says the paired devices should hear about it. */
export const wantsPush = (out: unknown): boolean => !!out && typeof out === "object" && (out as { push?: unknown }).push === true;

/** Best effort: no host, a switched-off category, a refused permission, a missing daemon or a core without push is silent. */
export async function notifyUser(kind: NotifyKind, opts: { key?: string; count?: number } = {}, invoke: Invoke = defaultInvoke): Promise<void> {
  let out: unknown;
  try {
    out = await invoke("notify_user", { kind, key: opts.key ?? null, count: opts.count ?? null });
  } catch {
    return; // best effort
  }
  if (!wantsPush(out) || !pushSender) return;
  try {
    await pushSender(kind, Math.min(Math.max(opts.count ?? 1, 1), 999), opts.key);
  } catch {
    // best effort: the core may not serve push, or may be restarting
  }
}
```

`ui/screens/shell/Shell.tsx`:

  - Import: change `import { installNotifyBridge } from "./notify/bridge";` to keep that line, and add `import { setPushSender } from "./notify/notify";` below it.
  - Replace the notifications `useEffect` body's `return installNotifyBridge({ … });` with:

```tsx
    // Admitted kinds also go to the paired phone / web app (the core pushes the kind and count, never text).
    setPushSender((kind, count, key) => core.request("/host-api/push/send", { method: "POST", body: { kind, count, ...(key ? { key } : {}) } }));
    const off = installNotifyBridge({
      // …the existing object literal, unchanged…
    });
    return () => { setPushSender(null); off(); };
```

- [ ] **Step 5: Write the Settings card** — `ui/screens/shell/notify/PushCard.tsx`:

```tsx
// Settings > General > Phone and web push: which paired devices receive pushes, and the Apple Push key the iPhone needs
// (routes GET /host-api/push/status, PUT and DELETE /host-api/push/apns; contract schema/http/host-api.schema.json). The
// key goes to this computer's vault and is never shown again. A Settings card (register-card.ts).
import { useCallback, useEffect, useState } from "react";
import { ApiError, call } from "../../settings/core-api.ts";
import { useEnv } from "../../settings/context.tsx";
import { Button, ErrorText, Field } from "../../settings/ui.tsx";

export interface PushDevice { deviceId: string; name: string; kind: "webpush" | "apns"; lastResult: string | null; lastAt: number | null }
export interface PushStatus { served: boolean; apns: { configured: boolean; keyId: string | null; teamId: string | null }; devices: PushDevice[] }

const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);

export function decodePushStatus(v: unknown): PushStatus | null {
  const o = obj(v);
  const a = obj(o?.apns);
  if (!o || typeof o.served !== "boolean" || !a || typeof a.configured !== "boolean" || !Array.isArray(o.devices)) return null;
  const devices: PushDevice[] = [];
  for (const d of o.devices.slice(0, 20)) {
    const r = obj(d);
    const deviceId = str(r?.deviceId, 64);
    const name = str(r?.name, 120);
    if (!r || !deviceId || name === null || (r.kind !== "webpush" && r.kind !== "apns")) continue;
    devices.push({ deviceId, name, kind: r.kind, lastResult: str(r.lastResult, 80), lastAt: typeof r.lastAt === "number" ? r.lastAt : null });
  }
  return { served: o.served, apns: { configured: a.configured, keyId: str(a.keyId, 10), teamId: str(a.teamId, 10) }, devices };
}

export function resultLabel(r: string | null): string {
  if (r === null) return "Nothing sent yet";
  if (r === "ok") return "Last push accepted by the push service";
  if (r === "rate_limited") return "Held back: too many pushes this hour";
  if (r === "APNS_NOT_CONFIGURED") return "Waiting for the Apple Push key below";
  return "Last push failed";
}

const ID_RE = /^[A-Z0-9]{10}$/;

export function PushBody({ status, error, onSave, onRemove }: { status: PushStatus | null; error: string | null; onSave(v: { key: string; keyId: string; teamId: string }): void; onRemove(): void }) {
  const [key, setKey] = useState("");
  const [keyId, setKeyId] = useState("");
  const [teamId, setTeamId] = useState("");
  if (!status) return <p className="st-hint">Push needs this computer's Host API (Settings → Mobile) on a backend started with LLMIDE_HOST_API_PUSH=1.</p>;
  const ready = key.includes("BEGIN PRIVATE KEY") && ID_RE.test(keyId) && ID_RE.test(teamId);
  return (
    <div className="st-stack">
      <p className="st-hint">While this computer runs, it can tell your paired phone and web app when an approval waits, a long task ends or sync needs you, and only while you are away from this window. A push says only what happened, for example “A Loop run passed.”, never chat text, file names or device names. Turn it on in the web app or the iPhone app after pairing.</p>
      {!status.served ? <p className="st-hint" role="status">This backend does not send pushes. Start it with LLMIDE_HOST_API_PUSH=1, then pair each device again.</p> : null}
      {status.devices.length
        ? <ul className="st-list">{status.devices.map((d) => <li key={d.deviceId}>{d.name} · {d.kind === "apns" ? "iPhone" : "Web app"} · {resultLabel(d.lastResult)}</li>)}</ul>
        : <p className="st-hint">No paired device has turned push on yet.</p>}
      {status.apns.configured ? (
        <div className="st-row">
          <p className="st-hint">Apple Push key {status.apns.keyId} (team {status.apns.teamId}) is saved.</p>
          <Button tone="danger" onClick={onRemove}>Remove key</Button>
        </div>
      ) : (
        <>
          <Field label="Apple Push key (.p8)" hint="From developer.apple.com → Keys, with Apple Push Notifications service enabled. Stored in this computer's vault and never shown again.">
            <input type="file" accept=".p8" aria-label="Apple Push key file" onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void f.text().then(setKey); }} />
          </Field>
          <Field label="Key ID"><input value={keyId} maxLength={10} aria-label="Key ID" onChange={(e) => setKeyId(e.currentTarget.value.trim().toUpperCase())} /></Field>
          <Field label="Team ID"><input value={teamId} maxLength={10} aria-label="Team ID" onChange={(e) => setTeamId(e.currentTarget.value.trim().toUpperCase())} /></Field>
          <Button tone="primary" disabled={!ready} onClick={() => { onSave({ key, keyId, teamId }); setKey(""); }}>Save key</Button>
        </>
      )}
      {error ? <ErrorText text={error} /> : null}
    </div>
  );
}

export default function PushCard() {
  const { client } = useEnv();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // shortcut: no HOST_PROOF_REQUIRED retry (HostApiPairing has one); reopening Settings reloads.
  const reload = useCallback(async () => {
    try { setStatus(decodePushStatus(await call(client, "GET", "/host-api/push/status"))); } catch (e) {
      setStatus(null);
      if (!(e instanceof ApiError && (e.code === "HOST_API_DISABLED" || e.code === "HOST_PROOF_REQUIRED"))) setError("Push status is not available.");
    }
  }, [client]);
  useEffect(() => { void reload(); }, [reload]);
  const save = async (v: { key: string; keyId: string; teamId: string }) => {
    setError(null);
    try { await call(client, "PUT", "/host-api/push/apns", v); } catch (e) {
      setError(e instanceof ApiError && e.code === "VALIDATION_FAILED" ? "That key, Key ID or Team ID is not valid." : "The key was not saved.");
    }
    await reload();
  };
  const remove = async () => {
    setError(null);
    try { await call(client, "DELETE", "/host-api/push/apns"); } catch { setError("The key was not removed."); }
    await reload();
  };
  return <PushBody status={status} error={error} onSave={(v) => void save(v)} onRemove={() => void remove()} />;
}
```

`ui/screens/shell/notify/register-card.ts`, append:

```ts
settingsRegistry.registerCard("general", {
  id: "push",
  title: "Phone and web push",
  order: 11,
  load: () => import("./PushCard.tsx") as unknown as Promise<{ default: SectionComponent }>,
});
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/notify.test.mjs ../ui/screens/shell/tests/push-card.test.mjs && npm test && cd src-tauri && cargo test --lib`
Expected: PASS. The `npm test` run covers the whole desktop UI suite, so Shell.tsx type-strips cleanly.

- [ ] **Step 7: Commit**

```bash
git add desktop/src-tauri/src/notify.rs ui/screens/shell/notify/notify.ts ui/screens/shell/Shell.tsx ui/screens/shell/notify/PushCard.tsx ui/screens/shell/notify/register-card.ts ui/screens/shell/tests/notify.test.mjs ui/screens/shell/tests/push-card.test.mjs
git commit -m "feat(desktop): push admitted notifications to paired devices and take the APNs key in Settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web app: subscribe after pairing, the worker shows the push (20 min)

**Files:**
- Create: `web/src/push/controller.ts`
- Create: `web/src/screens/PushToggle.tsx`
- Modify: `web/src/App.tsx` (the `Chat` component)
- Modify: `web/public/sw.js` (import `sw-push.js`, `push` + `notificationclick` handlers)
- Modify: `web/web.css` (one rule), `web/DEPLOY.md` (one sentence)
- Test: `web/tests/push-controller.test.mjs`, `web/tests/pwa.test.mjs` (append)

**Interfaces:**
- Consumes: `HostLink` (`web/src/host-api/connection.ts`); `push.config`, `push.register`, `push.unregister` (Task 4); `self.LLMIDEPush.render` (Task 1).
- Produces:
  - `type PushState = { kind: "unavailable" | "off" | "on" | "blocked" | "busy"; error: string | null }`
  - `createPushController(link, env?) → { getState, subscribe, refresh, enable, disable }`
  - `browserPushEnv(): PushEnv`, `b64uBytes(s): Uint8Array`, `sameKey(a, b): boolean`
  - `<PushToggle state onEnable onDisable />`

- [ ] **Step 1: Write the failing tests** — `web/tests/push-controller.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPushController, b64uBytes, sameKey } from "../src/push/controller.ts";

const KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const OTHER = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
function fakeLink(results = {}, caps = ["host", "chat", "push"]) {
  const calls = [];
  return { capabilities: new Set(caps), calls,
    send(command, payload) { calls.push({ command, payload }); const r = typeof results[command] === "function" ? results[command]() : results[command]; return { id: `c-${calls.length}`, done: r instanceof Error ? Promise.reject(r) : Promise.resolve(r ?? {}) }; },
    onEvent: () => () => {}, onResync: () => () => {}, onState: () => () => {} };
}
function sub(key = KEY) {
  const s = { endpoint: "https://fcm.googleapis.com/fcm/send/e1", options: { applicationServerKey: b64uBytes(key).buffer }, unsubscribed: false,
    toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/e1", keys: { p256dh: `${OTHER}=`, auth: "BTBZMqHH6r4Tts7J_aSIgg==" } }),
    unsubscribe: async () => { s.unsubscribed = true; return true; } };
  return s;
}
function fakeEnv({ permission = "default", grant = "granted", existing = null } = {}) {
  const e = { perm: permission, current: existing, subscribed: [],
    permission: () => e.perm, requestPermission: async () => { e.perm = grant; return grant; },
    subscription: async () => e.current, subscribe: async (key) => { e.subscribed.push(key); e.current = sub(); return e.current; } };
  return e;
}
const CFG = { webPushKey: KEY, apns: false, registered: "none" };

test("base64url keys decode, and only an equal key matches", () => {
  assert.equal(b64uBytes(KEY).length, 65);
  assert.equal(sameKey(b64uBytes(KEY).buffer, b64uBytes(KEY)), true);
  assert.equal(sameKey(b64uBytes(OTHER).buffer, b64uBytes(KEY)), false);
  assert.equal(sameKey(null, b64uBytes(KEY)), false);
});

test("without the push capability or browser support nothing is offered or sent", async () => {
  const link = fakeLink({}, ["host", "chat"]);
  const c = createPushController(link, fakeEnv());
  await c.refresh(); await c.enable();
  assert.equal(c.getState().kind, "unavailable");
  assert.equal(link.calls.length, 0);
  const c2 = createPushController(fakeLink(), fakeEnv({ permission: "unsupported" }));
  await c2.refresh();
  assert.equal(c2.getState().kind, "unavailable");
});

test("enable asks, subscribes with the desktop key and registers unpadded keys", async () => {
  const link = fakeLink({ "push.config": CFG, "push.register": { registered: true } });
  const env = fakeEnv();
  const c = createPushController(link, env);
  await c.refresh();
  assert.equal(c.getState().kind, "off");
  await c.enable();
  assert.equal(c.getState().kind, "on");
  assert.deepEqual([...env.subscribed[0]], [...b64uBytes(KEY)]);
  assert.deepEqual(link.calls.at(-1), { command: "push.register", payload: { kind: "webpush", endpoint: "https://fcm.googleapis.com/fcm/send/e1", p256dh: OTHER, auth: "BTBZMqHH6r4Tts7J_aSIgg" } });
});

test("a refused permission is blocked; a subscription for an old desktop key is replaced", async () => {
  const c = createPushController(fakeLink({ "push.config": CFG }), fakeEnv({ grant: "denied" }));
  await c.enable();
  assert.equal(c.getState().kind, "blocked");
  const old = sub(OTHER);
  const env = fakeEnv({ existing: old });
  const c2 = createPushController(fakeLink({ "push.config": CFG, "push.register": { registered: true } }), env);
  await c2.enable();
  assert.equal(old.unsubscribed, true);
  assert.equal(env.subscribed.length, 1);
  assert.equal(c2.getState().kind, "on");
});

test("on only when the desktop has this browser's subscription for its key; disable forgets both sides", async () => {
  const env = fakeEnv({ permission: "granted", existing: sub() });
  const link = fakeLink({ "push.config": { ...CFG, registered: "webpush" }, "push.unregister": { removed: true } });
  const c = createPushController(link, env);
  await c.refresh();
  assert.equal(c.getState().kind, "on");
  await c.disable();
  assert.equal(c.getState().kind, "off");
  assert.equal(env.current.unsubscribed, true);
  assert.equal(link.calls.at(-1).command, "push.unregister");
  const failing = createPushController(fakeLink({ "push.config": new Error("The desktop is busy.") }), fakeEnv({ permission: "granted" }));
  await failing.refresh();
  assert.deepEqual(failing.getState(), { kind: "off", error: "The desktop is busy." });
});
```

Append to `web/tests/pwa.test.mjs`:

```js
test("the worker shows a push only from its local text table, and a click only focuses or opens the app", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /importScripts\("sw-push\.js"\)/);
  assert.match(sw, /self\.addEventListener\("push"/);
  assert.match(sw, /self\.LLMIDEPush\.render\(data\)/);
  assert.match(sw, /self\.addEventListener\("notificationclick"/);
  assert.match(sw, /self\.clients\.openWindow\("\.\/"\)/);
  const push = sw.slice(sw.indexOf('addEventListener("push"'), sw.indexOf('addEventListener("fetch"'));
  assert.doesNotMatch(push, /fetch\(|caches\.|importScripts|eval\(/, "no network, cache or code in the push path");
  const csp = read("vite.config.ts");
  assert.doesNotMatch(csp, /fcm\.googleapis|push\.services\.mozilla|notify\.windows|web\.push\.apple/, "the browser talks to its push service, not the page");
});
```

Run: `cd web && node --test --experimental-strip-types tests/push-controller.test.mjs tests/pwa.test.mjs`
Expected: FAIL (`Cannot find module '../src/push/controller.ts'`, and the `sw-push.js` assertion).

- [ ] **Step 2: Write the controller** — `web/src/push/controller.ts`:

```ts
// Web Push on this browser (Host API v1 capability `push`): subscribe with the desktop's VAPID key and register the
// subscription with the desktop, which pushes only a kind and a count while it runs. The worker (public/sw-push.js)
// shows the words. No React here.
import type { HostLink } from "../host-api/connection.ts";

export interface SubLike {
  readonly endpoint: string;
  readonly options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}
export interface PushEnv {
  permission(): NotificationPermission | "unsupported";
  requestPermission(): Promise<NotificationPermission>;
  subscription(): Promise<SubLike | null>;
  subscribe(key: Uint8Array): Promise<SubLike>;
}
export type PushState = { kind: "unavailable" | "off" | "on" | "blocked" | "busy"; error: string | null };

export function b64uBytes(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
export function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}
const unpad = (s: string | undefined) => (s ?? "").replace(/=+$/, "");

/** The real browser; "unsupported" where there is no Push API (e.g. Safari outside a home-screen web app). */
export function browserPushEnv(): PushEnv {
  const ok = typeof Notification !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in globalThis;
  const reg = () => navigator.serviceWorker.ready;
  return {
    permission: () => (ok ? Notification.permission : "unsupported"),
    requestPermission: () => Notification.requestPermission(),
    subscription: async () => (ok ? (await reg()).pushManager.getSubscription() : null),
    subscribe: async (key) => (await reg()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.buffer as ArrayBuffer }),
  };
}

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Push notifications could not be set up.");

export function createPushController(link: HostLink, env: PushEnv = browserPushEnv()) {
  let state: PushState = { kind: "unavailable", error: null };
  const subs = new Set<() => void>();
  const set = (s: PushState) => { state = s; for (const fn of subs) fn(); };
  const served = () => link.capabilities.has("push") && env.permission() !== "unsupported";

  async function refresh(): Promise<void> {
    if (!served()) return set({ kind: "unavailable", error: null });
    if (env.permission() === "denied") return set({ kind: "blocked", error: null });
    try {
      const [cfg, sub] = await Promise.all([link.send("push.config", {}).done, env.subscription()]);
      const on = cfg.registered === "webpush" && !!sub && sameKey(sub.options?.applicationServerKey, b64uBytes(cfg.webPushKey));
      set({ kind: on ? "on" : "off", error: null });
    } catch (e) { set({ kind: "off", error: messageOf(e) }); }
  }

  async function enable(): Promise<void> {
    if (!served()) return;
    set({ kind: "busy", error: null });
    try {
      if ((await env.requestPermission()) !== "granted") return set({ kind: "blocked", error: null });
      const cfg = await link.send("push.config", {}).done;
      const key = b64uBytes(cfg.webPushKey);
      let sub = await env.subscription();
      if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; } // the desktop's key changed
      sub ??= await env.subscribe(key);
      const j = sub.toJSON();
      await link.send("push.register", { kind: "webpush", endpoint: j.endpoint ?? sub.endpoint, p256dh: unpad(j.keys?.p256dh), auth: unpad(j.keys?.auth) }).done;
      set({ kind: "on", error: null });
    } catch (e) { set({ kind: "off", error: messageOf(e) }); }
  }

  async function disable(): Promise<void> {
    set({ kind: "busy", error: null });
    try { await link.send("push.unregister", {}).done; } catch { /* the desktop also forgets it with the device */ }
    try { await (await env.subscription())?.unsubscribe(); } catch { /* already gone */ }
    set({ kind: "off", error: null });
  }

  return { getState: () => state, subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; }, refresh, enable, disable };
}
```

`web/src/screens/PushToggle.tsx`:

```tsx
import type { PushState } from "../push/controller.ts";

/** "Notify me on this device": hidden unless the desktop serves push and this browser can receive it. */
export function PushToggle({ state, onEnable, onDisable }: { state: PushState; onEnable(): void; onDisable(): void }) {
  if (state.kind === "unavailable") return null;
  return (
    <div className="web-push" role="group" aria-label="Notifications">
      {state.kind === "blocked"
        ? <p className="web-hint">Notifications are blocked for this site. Allow them in the browser's site settings, then reload.</p>
        : <button type="button" disabled={state.kind === "busy"} onClick={state.kind === "on" ? onDisable : onEnable}>
            {state.kind === "on" ? "Stop notifications on this device" : "Notify me on this device"}
          </button>}
      {state.error ? <p className="web-hint" role="alert">{state.error}</p> : null}
    </div>
  );
}
```

`web/src/App.tsx`:

  - Imports: add `import { createPushController } from "./push/controller.ts";` and `import { PushToggle } from "./screens/PushToggle.tsx";`.
  - In `Chat`, after the `cs` line, add:

```tsx
  const [push] = useState(() => createPushController(c));
  const ps = useSyncExternalStore(push.subscribe, push.getState, push.getState);
  useEffect(() => { void push.refresh(); return c.onResync(() => void push.refresh()); }, [push, c]);
```

  - Inside `<div className="web-shell">`, as its first child: `<PushToggle state={ps} onEnable={() => void push.enable()} onDisable={() => void push.disable()} />`.

`web/web.css`, append: `.web-push { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 4px 16px; }`

`web/public/sw.js`:

  - After `importScripts("sw-prune.js");` add the line `importScripts("sw-push.js");`.
  - Before `self.addEventListener("fetch", …`:

```js
// A push names a fixed kind and a count; the words come from sw-push.js (the desktop notifier's table). Never fetch here.
self.addEventListener("push", (event) => {
  let data = null;
  try { data = event.data ? event.data.json() : null; } catch { data = null; }
  const n = self.LLMIDEPush.render(data);
  if (!n) return;
  event.waitUntil(self.registration.showNotification(n.title, { body: n.body, tag: n.tag, icon: "./icons/icon-192.png" }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).origin === self.location.origin);
    return open ? open.focus() : self.clients.openWindow("./");
  }));
});
```

`web/DEPLOY.md`, at the end of the "Installable output" paragraph, add: `Push notifications use the same worker plus \`sw-push.js\` (its text table). They need HTTPS or \`localhost\`, a desktop serving the Host API \`push\` capability, and on iPhone Safari a home-screen web app (iOS 16.4+). The CSP needs no push host, because the browser, not the page, talks to its push service.`

- [ ] **Step 3: Run the tests and the build**

Run: `cd web && npm test && npx tsc --noEmit -p . && npm run build`
Expected: PASS. The build copies `public/sw-push.js` into `dist/`.

- [ ] **Step 4: Commit**

```bash
git add web/src/push/controller.ts web/src/screens/PushToggle.tsx web/src/App.tsx web/public/sw.js web/web.css web/DEPLOY.md web/tests/push-controller.test.mjs web/tests/pwa.test.mjs
git commit -m "feat(web): subscribe to desktop push after pairing and show it from the worker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: iPhone: register for remote notifications and send the token (25 min)

**Files:**
- Create: `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPush.swift`
- Test: `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiPushTests.swift`
- Create: `ios_app/MyApp/Services/PushRegistrar.swift`
- Modify: `ios_app/MyApp/MyAppApp.swift`, `ios_app/MyApp/Services/ConnectionService.swift` (two calls)
- Modify: `ios_app/MyApp.xcodeproj/project.pbxproj` (`PushRegistrar.swift` in Sources, `Localizable.strings` in Resources)

**Interfaces:**
- Consumes: the generated `HostApiCommand.pushRegister`, `HostApiPushRegisterRequest`, `HostApiPushRegisterResult` (Task 4); `ConnectionService.host`, `.hostCapabilities`, `.connectionStatus`.
- Produces:
  - `HostApiPush.isOn(capabilities:)`, `.tokenHex(_:)`, `.environment(isDebug:)`, `.registerRequest(token:isDebug:)`
  - `PushRegistrar.shared.hostReady()`
  - `AppDelegate` (the APNs callbacks)

- [ ] **Step 1: Write the failing swift-testing test** — `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiPushTests.swift`:

```swift
import Testing
import Foundation
import SharedProtocol

@Suite("HostApiPush")
struct HostApiPushTests {
    @Test("on only when the host granted push; never optimistic")
    func gate() {
        #expect(HostApiPush.isOn(capabilities: ["host", "chat", "push"]))
        #expect(!HostApiPush.isOn(capabilities: ["host", "chat"]))
        #expect(!HostApiPush.isOn(capabilities: nil))
    }

    @Test("the token is lowercase hex, the environment follows the build, and the payload passes the contract")
    func payload() throws {
        let token = Data((0..<32).map { UInt8(($0 * 37 + 171) & 0xff) })
        let r = HostApiPush.registerRequest(token: token, isDebug: true)
        #expect(r.kind == "apns")
        #expect(r.environment == "sandbox")
        #expect(r.token?.count == 64)
        #expect(r.token == r.token?.lowercased())
        #expect(r.endpoint == nil && r.p256dh == nil && r.auth == nil)
        #expect(HostApiPush.registerRequest(token: token, isDebug: false).environment == "production")
        #expect(HostApiPush.tokenHex(Data([0x00, 0x0f, 0xff])) == "000fff")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(r))
        #expect(HostApiSchemaValidator.validate(HostApiSchemas.request(for: .pushRegister), json, defs: [:]).isEmpty)
    }
}
```

Run: `cd ios_app/SharedProtocol && swift test --filter HostApiPush`
Expected: FAIL with `cannot find 'HostApiPush' in scope`. On a toolchain without XCTest/Testing, use `swift build --build-tests` and expect the same error.

- [ ] **Step 2: Write the pure helpers** — `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPush.swift`:

```swift
import Foundation

/// Host API v1 `push` on the phone: the gate and the `push.register` payload for an APNs device token. Pure, so it is
/// tested without UIKit. The desktop sends only a kind and a count; the words are in the app's Localizable.strings.
public enum HostApiPush {
    /// True only on a connection whose host granted `push`. Not optimistic, unlike `ConnectionService.supports`.
    public static func isOn(capabilities: Set<String>?) -> Bool {
        capabilities?.contains(HostApiCommand.pushRegister.capability) == true
    }

    /// The token as the lowercase hex the desktop accepts (^[0-9a-f]{64,200}$).
    public static func tokenHex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// Debug builds (run from Xcode) get sandbox tokens; TestFlight and App Store builds get production ones.
    public static func environment(isDebug: Bool) -> String { isDebug ? "sandbox" : "production" }

    public static func registerRequest(token: Data, isDebug: Bool) -> HostApiPushRegisterRequest {
        HostApiPushRegisterRequest(environment: environment(isDebug: isDebug), kind: "apns", token: tokenHex(token))
    }
}
```

Run: `make test-shared-protocol`
Expected: PASS.

- [ ] **Step 3: Write the app side** — `ios_app/MyApp/Services/PushRegistrar.swift`:

```swift
import SwiftUI
import UIKit
import UserNotifications
import SharedProtocol

/// Exists only for APNs: iOS hands the device token, or the failure, to the app delegate.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushRegistrar.shared.tokenArrived(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushRegistrar.shared.registrationFailed() }
    }

    /// Show the banner while the app is open too: the desktop already skipped the push when the user was at the desk.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

/// Push notifications from the paired desktop (Host API v1 capability `push`). On a desktop that serves `push` it asks
/// once for alert permission, registers for remote notifications and sends the device token with `push.register`.
/// Without the Push Notifications capability in the Xcode project (plan user step A) iOS refuses the registration
/// and this only records why.
@MainActor
final class PushRegistrar: ObservableObject {
    static let shared = PushRegistrar()

    enum Status: Equatable { case off, on, denied, failed(String) }
    @Published private(set) var status: Status = .off

    weak var connection: ConnectionService?
    private var token: Data?

    #if DEBUG
    static let isDebug = true
    #else
    static let isDebug = false
    #endif

    /// Called when a connection is up and whenever the host's capabilities change.
    func hostReady() {
        guard let c = connection, c.connectionStatus == .connected, HostApiPush.isOn(capabilities: c.hostCapabilities) else { return }
        Task {
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
            guard granted else { status = .denied; return }
            if let token { await register(token) } else { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func tokenArrived(_ t: Data) {
        token = t
        Task { await register(t) }
    }

    func registrationFailed() {
        status = .failed("This build of the app cannot receive push notifications.")
    }

    private func register(_ t: Data) async {
        guard let c = connection, c.connectionStatus == .connected, HostApiPush.isOn(capabilities: c.hostCapabilities) else { return }
        do {
            _ = try await c.host.send(.pushRegister, HostApiPush.registerRequest(token: t, isDebug: Self.isDebug),
                                      as: HostApiPushRegisterResult.self)
            status = .on
        } catch {
            let text = (error as? HostApiRejection)?.message ?? ""
            status = .failed(text.isEmpty ? "The desktop did not accept this phone for push notifications." : String(text.prefix(500)))
        }
    }
}
```

`ios_app/MyApp/MyAppApp.swift`:

  - Add `@UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate` as the first property of `MyAppApp`.
  - In `init()`, after `_connection = StateObject(wrappedValue: connection)`, add `PushRegistrar.shared.connection = connection`.

`ios_app/MyApp/Services/ConnectionService.swift`:

  - In `connect`'s `.ready` branch, after `self.connectionStatus = .connected`, add `PushRegistrar.shared.hostReady()`.
  - In `route(_:)`'s `case .capabilities(let caps):`, after `llmIdeStore?.handle(event)`, add `PushRegistrar.shared.hostReady()`.

- [ ] **Step 4: Add both files to the Xcode project** — in `ios_app/MyApp.xcodeproj/project.pbxproj`:

First check that the new ids are free. Run `grep -c "A1C0FF1CE0000000000000N\|A1C0FF1CE0000000000000L" ios_app/MyApp.xcodeproj/project.pbxproj` and expect `0`. Then:

  1. PBXBuildFile section, after the `PrivacyInfo.xcprivacy in Resources` line (line 14):

```
		A1C0FF1CE0000000000000N2 /* PushRegistrar.swift in Sources */ = {isa = PBXBuildFile; fileRef = A1C0FF1CE0000000000000N1 /* PushRegistrar.swift */; };
		A1C0FF1CE0000000000000L2 /* Localizable.strings in Resources */ = {isa = PBXBuildFile; fileRef = A1C0FF1CE0000000000000L1 /* Localizable.strings */; };
```

  2. PBXFileReference section, after the `PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; …` line (line 55):

```
		A1C0FF1CE0000000000000N1 /* PushRegistrar.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = PushRegistrar.swift; sourceTree = "<group>"; };
		A1C0FF1CE0000000000000L1 /* Localizable.strings */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; path = Localizable.strings; sourceTree = "<group>"; };
```

  3. `/* Supporting */` group children, after `A1C0FF1CE0000000000000P1 /* PrivacyInfo.xcprivacy */,`: `				A1C0FF1CE0000000000000L1 /* Localizable.strings */,`
  4. `/* Services */` group children, after `B71B0441A9A9F3E9BEC3AAB4 /* UsageStore.swift */,`: `				A1C0FF1CE0000000000000N1 /* PushRegistrar.swift */,`
  5. `/* Resources */` build phase files, after `A1C0FF1CE0000000000000P2 /* PrivacyInfo.xcprivacy in Resources */,`: `				A1C0FF1CE0000000000000L2 /* Localizable.strings in Resources */,`
  6. `/* Sources */` build phase files, after `B81B0441A9A9F3E9BEC3AAB4 /* UsageStore.swift in Sources */,`: `				A1C0FF1CE0000000000000N2 /* PushRegistrar.swift in Sources */,`

Run: `cd ios_app && plutil -lint MyApp.xcodeproj/project.pbxproj && xcodebuild -project MyApp.xcodeproj -target MyApp -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO SYMROOT="$TMPDIR/ios-build" build`
Expected: `OK` and `** BUILD SUCCEEDED **`. Then run `ls "$TMPDIR"/ios-build/Debug-iphoneos/MyApp.app/Localizable.strings` and expect the file to exist.

- [ ] **Step 5: Commit**

```bash
git add ios_app/SharedProtocol/Sources/SharedProtocol/HostApiPush.swift ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiPushTests.swift ios_app/MyApp/Services/PushRegistrar.swift ios_app/MyApp/MyAppApp.swift ios_app/MyApp/Services/ConnectionService.swift ios_app/MyApp.xcodeproj/project.pbxproj
git commit -m "feat(ios): register for desktop push notifications over Host API v1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Plan rows, user steps and the final gates (10 min)

**Files:**
- Modify: `docs/superpowers/MASTER-PLAN.md` (S3 row), `docs/superpowers/USER-NEEDS.md` (UN-078)

- [ ] **Step 1: Update the rows**

`docs/superpowers/MASTER-PLAN.md`: replace `- [ ] Push notifications (approvals, task done) (me)` with:

```markdown
- [~] Push notifications (approvals, task done), sent by the desktop with no relay: Host API v1 `push` (`LLMIDE_HOST_API_PUSH=1`), Web Push (RFC 8291/8292 by hand, push-service allowlist) and APNs token auth over HTTP/2; payload = fixed kind + count ([plan](plans/2026-11-07-push-notifications.md)) (me). Open: the Xcode Push capability and the APNs key (plan section D) (you)
```

`docs/superpowers/USER-NEEDS.md`: replace `Trigger: after the relay exists.` in UN-078 with `Built by the desktop as sender, no relay (plan 2026-11-07-push-notifications.md); open: the Xcode Push capability and the APNs key (user steps).`

- [ ] **Step 2: Run the whole regression**

Run: `make contract-gates && make test && cd desktop && npm test && cd .. && cd web && npm test && cd .. && make test-shared-protocol && make regression`
Expected: all PASS. The pre-push gate is not used, because nothing is pushed.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/MASTER-PLAN.md docs/superpowers/USER-NEEDS.md
git commit -m "docs(plan): push notifications row reflects the desktop sender

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand over the user steps in section D.** Do not attempt them. They need the user's Apple account and Xcode GUI.

---

## C. Manual check (after section D)

1. Start the core yourself: `cd extension && LLMIDE_HOST_API_TLS=1 LLMIDE_HOST_API_PUSH=1 npm run server`. Then open the desktop app, which adopts it.
2. Web, Chrome then Firefox:
   1. Pair the web app again (a device paired earlier has no `push` grant).
   2. Click **Notify me on this device** and allow.
   3. Desktop Settings → General → Phone and web push now lists the browser.
   4. Leave the desktop window unfocused and start a Loop run. "A Loop run passed." / "… did not pass." arrives. Clicking it focuses or opens the web app.
3. iPhone (a real device, Debug build from Xcode):
   1. Pair again. Allow notifications when asked.
   2. Desktop Settings lists the iPhone.
   3. Ask a tool-using question from the desktop chat and switch away from the desktop window. "A tool is waiting for your approval in Chat." arrives.
4. Revoke the device in Settings → Mobile. The next push does not reach it, and Settings no longer lists it.
5. With the desktop window focused on Chat, a waiting approval produces no push.

## D. User steps (not timed; the code ships without them)

**USER STEP A — the Xcode Push Notifications capability (needed for any APNs token).**

1. Open `ios_app/MyApp.xcodeproj` in Xcode and select the **MyApp** target.
2. Go to **Signing & Capabilities** and keep **Automatically manage signing** on, with team `9A3YFRQ7SM`.
3. Click **+ Capability** and add **Push Notifications**. Do **not** add Background Modes: alert pushes need none.
4. Xcode now does three things:
   - creates `ios_app/MyApp/MyApp.entitlements` with `aps-environment = development` (an App Store / TestFlight archive is signed with `production`)
   - sets `CODE_SIGN_ENTITLEMENTS = MyApp/MyApp.entitlements` in both build configurations of `project.pbxproj`
   - enables Push on the App ID `dotsoft.llmide.com` in your developer account
5. Build once on a real iPhone to confirm that signing succeeds.
6. Commit the two files: `git add ios_app/MyApp/MyApp.entitlements ios_app/MyApp.xcodeproj/project.pbxproj && git commit -m "chore(ios): enable the Push Notifications capability"`.

Until you do this, the app shows no error: `PushRegistrar.status` becomes `.failed("This build of the app cannot receive push notifications.")`.

**USER STEP B — the APNs token key (.p8).**

1. Go to developer.apple.com → Account → **Certificates, Identifiers & Profiles** → **Keys** → **+**.
2. Name it (e.g. "LLM-IDE push") and tick **Apple Push Notifications service (APNs)**. Under **Configure**, choose the environment **Sandbox & Production**. Then **Continue** → **Register**.
3. **Download** `AuthKey_<KEYID>.p8`. Apple lets you download it only once. Keep it outside the repository, and never commit, paste or upload it anywhere else.
4. Note the **Key ID** (10 characters, shown with the key) and your **Team ID** (Membership details; this project's is `9A3YFRQ7SM`).
5. In the desktop app, go to **Settings → General → Phone and web push**. Choose the `.p8` file, enter the Key ID and Team ID, and click **Save key**. The key goes into this computer's vault. The card then shows only the key id and the team id.

**USER STEP C — run the manual check in section C**, then mark the MASTER-PLAN row `[x]`.

## E. Decisions for the user (secure default first)

**User answer (2026-11-07):** all decisions = the defaults as written (push off unless LLMIDE_HOST_API_PUSH=1). Use the API version and migration numbers in `2026-11-07-day-run.md`.

| # | Question | Default built (secure / least surprising first) | Alternative |
|---|---|---|---|
| D1 | Who sends, and when | The desktop core, only while it runs. No relay. | A hosted relay that queues pushes while the desktop is off (retired by ADR 0020). |
| D2 | Turning push on | Off unless the core runs with `LLMIDE_HOST_API_PUSH=1` (like `read` / `compose`; the app-spawned core does not pass it). A device must pair again to be granted `push`. | Pass the flag through `desktop/src-tauri/src/core_env.rs`, or add a Settings switch, so the app's own core serves push. |
| D3 | Push while the desktop window is focused | No: only an admitted kind while the main window is **not** focused, because the user is away. | Always push every admitted kind to the devices as well. |
| D4 | What a push carries | Only the kind and a count. The device shows its own copy of the notifier's words (`sw-push.js`, iOS `loc-key` + `Localizable.strings`), so Apple, Google and Mozilla see no sentence. | Send the generic sentence as the alert text (simpler on iOS; the push services see the words). |
| D5 | Which kinds | The 11 webview kinds (approvals, Loop / Auto Task / Graph / Doc Gen done or failed, sync attention). `update_ready` and `core_down` stay desktop-only. | Also push "update available". |
| D6 | Limits | Each de-dup key once; one per user and kind per 10 s; 30 per device per hour (burst 10); TTL 1 hour (an older approval is stale). | No hourly cap; TTL 24 hours. |
| D7 | Allowed web push services | FCM, Mozilla, Apple and one-label `*.notify.windows.com`, https on 443 only, checked at register and again at send, each send pinned to that one host. | Any public https host that passes the SSRF classifier. |
| D8 | VAPID `sub` claim | `https://llm-ide.com` (the product site; no personal address goes to push services). | `mailto:` the user's email (push services could contact them; leaks the address). |
| D9 | Where the APNs key lives | Per user, in the vault, entered in desktop Settings and never shown again. | A per-install file or environment variable read at start. |
| D10 | Storing endpoints / tokens | As-is in the device-bound SQLite row (useless without the vault-held VAPID key / `.p8`); never logged or returned. | Vault-encrypt each endpoint and token too. |
| D11 | iPhone permission prompt | Asked automatically on the first connect to a desktop that serves `push` (the desktop switch plus a re-pair is the opt-in). | An explicit "Notifications" switch on the iPhone's Settings screen. |
| D12 | iPhone in the foreground | Show the banner anyway, because the desktop already skipped it if the user was at the desk. | Suppress banners while the app is open. |
| D13 | APNs connection | One HTTP/2 connection per push, closed after (low volume). | A kept-alive connection pool (Apple's advice for volume). |

## F. Self-review

**Spec coverage.**

| Requirement | Where |
|---|---|
| Desktop as sender, no relay | Tasks 6–7 |
| Web Push with VAPID keys generated and kept in the vault | `vapidFor`, Tasks 2 and 6 |
| Service worker subscribes after pairing | Task 8 |
| New command + capability `push`, served ∩ granted, re-pair to get it | Tasks 4–5 |
| RFC 8291 aes128gcm + RFC 8292 VAPID, with the RFC vector | Task 2 |
| APNs token auth, key in the vault, user adds it later, fake APNs in tests | Tasks 3, 6 and 7, user step B |
| iPhone registers and sends its token | Task 9 |
| Same fixed kind table and generic texts | Task 1 + parity test |
| Content-free payloads | Tasks 1–3, constraint |
| Sends only while the desktop runs | D1 |
| Per-device targets revoked with the device | FK cascade, Task 5 |
| Rate limit and de-dup like the notifier | `createPushGate`, Task 6 |
| Secrets only in the vault, never logged or returned | Tasks 5–6 tests |
| No new dependency | `node:crypto` / `node:http2` |
| Pinned fetch: push-service allowlist and exact-host pinning | Task 2 |
| APNs over HTTP/2 with an explicit reviewed guard path | Task 3 |
| SW and CSP rules checked | Task 8 `pwa.test.mjs`, section A |
| API bump checklist: `SERVER_API_VERSION`, `core-api-floor.ts`, spec docs, `schema/http` + fixtures, `schema/host-api/v1` contract + fixtures, inventory, openapi, api-types, SharedProtocol regeneration + `make test-shared-protocol` | Tasks 4 and 6 |
| Xcode capability and APNs key as user steps | Section D |
| Parallel-plan files avoided | Global Constraints |

**Placeholder scan:** every code step has the code. The only deferred work is the two user steps, marked as such.

**Type consistency:**

- `pushTargetOf` → `{ ok, target | message }` is used by the gateway.
- `listPushTargets` rows (`deviceId`, `scopes`, `kind`, `token`, `environment`, …) are used by `dispatchPush` and `pushStatus`.
- `sendWebPush(t, plaintext, { vapid, urgency, topic, now })` and `sendApns({ token, environment, payload, collapseId, credentials, now })` match the dispatcher's calls and the fakes in `host-api-push.test.mjs`.
- `Outcome { shown, push }` matches `wantsPush`.
- `HostApiPushRegisterRequest(environment:kind:token:)` follows the generator's alphabetical, optional-defaulted init.
