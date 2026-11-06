# Desktop Archivist for Extension Captures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Tauri desktop host adopts finished Chrome-extension captures from the core it spawned, writes each one as a verified meeting note in the notes folder, feeds the note index, and only then acks `POST /kb/live/:id/ack`, so the core's copy and the extension draft are released.

**Architecture:** The archivist is a background thread in the **Rust host**. It uses the signed-in session the webview already binds (`chat_bind_session`, token in host memory only) and talks only to the nonce-verified core (`CoreHost::verified_url`). Each bounded tick lists `GET /kb/live/unacked`, reads the held copy from a new additive route `GET /kb/live/:id/capture`, and finds or writes the note through the existing `capture_store::finalize` writer and read-back verify. It then posts the index upsert and acks with the server's own `lines` and `hash`. The spawned core gets `LLMIDE_LIVE_ACK=1`, so finalize holds a capture until it is acked.

**Tech Stack:** Rust (Tauri 2.11 host, `ureq` 2.12, `serde`, `serde_json`, all already in `Cargo.lock`), Node 20 core (`extension/`, pure HTTP, `node:test`), JSON contract schemas (`schema/http/`).

**Spec:** [MASTER-PLAN S5 "Desktop archivist for extension captures"](../MASTER-PLAN.md) (line 457). [Desktop live-capture plan section A.2 and section F](2026-11-05-desktop-live-capture.md): the one-copy rule, verify before cleanup, the index feed `POST /kb/index/notes` with the `makeUpsertInput` shape. [Live-then-archive section 3.6 B](2026-10-29-live-then-archive.md) and its 2026-10-29 amendment (the ack echoes the server's own line count and hash). [docs/kits/data-lifecycle.md](../../kits/data-lifecycle.md) rules 1 to 3, R1 and section 4 ("write, verify by reading it back, then delete; idempotent by session id"). [extension/CLAUDE.md "Capture drafts and local storage (live-then-archive T5.2)"](../../../extension/CLAUDE.md), the rows marked *(pending archivist)*. [docs/kits/capture-kit.md](../../kits/capture-kit.md) decision C4.

## Global Constraints

- **One copy:** the note file in the notes folder is the only durable copy. The ack is sent only after `capture_store::finalize` (write plus read-back verify) or `find_archived` (the same bytes already on disk) returned a note.
- **Never ack a capture that failed to write**, failed to verify, or whose held rows do not equal the `lines` the ack must echo.
- **Idempotent:** a crash between the note write and the ack must not make a second note. The next tick finds the earlier note by its deterministic name and exact bytes, and the note's frontmatter carries `id: "<sessionId>"`.
- **Per-user:** every core call carries the bound session's token, and the core scopes `/kb/live/*` by that user. A sign-out or token refresh starts a new generation, and a running tick stops before the next capture.
- **Credentials go only to the core THIS app spawned and nonce-verified** (`CoreHost::verified_url`), never to an adopted or foreign `:3456` server. The token is never written to disk, logged or returned.
- **Bounded work:** at most 5 captures per 20 s tick, 3 attempts per capture per launch, 16 MB per capture response, 3 s per call.
- **Capture text is never logged.** The new module is named `capture_*.rs`, so `desktop/scripts/check-capture-privacy.test.mjs` covers it. Its one `eprintln!` prints counts only.
- **No new dependency** (no change to `Cargo.toml` or any `package.json` dependency list). No new Tauri command (no `build.rs`, `capabilities/` or `lib.rs` `product_handlers!` change).
- **No UI change.** Do not touch `ui/` (another agent is working in `ui/screens/settings/` right now).
- **`SERVER_API_VERSION` 115 → 116** for the additive route. If `main` is already past 115 when you start, take the next free number and keep the history comment in order.
- No summary is generated after archiving: meeting text goes to a model only from Library's Re-summarise (desktop live-capture plan D4).
- Work and commit on `main`, do not push. Conventional Commits, one concern per commit. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## A. Facts checked (what the plan argues from)

1. **The Swift app never acked.** `LiveSessionMirror.swift` (last at `94ae1103^`) polled `GET /kb/live/sessions` and `GET /kb/live/:id?since=`, not `/kb/live/unacked`. `AppShell.swift:169,1221` (`generateNoteForLiveSession`) wrote the note from the mirror's in-memory captions with `platform: "chrome-extension"` and then summarised it in the background. `mac/Sources/APIContractLab/Routes.swift:138,143` lists `GET /kb/live/unacked` and `POST /kb/live/:id/ack` as "no Mac caller". So the ack path (live-then-archive T5.1, Mac half) was never built. This plan builds it for the first time, in the desktop.
2. **`GET /kb/live/unacked` does not carry the transcript** (`agents/live-sessions.mjs` `listUnackedLiveSessions`: ids, title, `startedAt` as ms or ISO, `lines`, `hash`). The streamed `GET /kb/live/:id` returns the streamed buffer, not the authoritative `s.final` list that the ack verifies, and it returns nothing after a restart (the transcript then lives only in `live_crash_rows.transcript`). So the archivist needs a read of the **held** copy. Task 1 adds `GET /kb/live/:id/capture`.
3. **The ack hash is SHA-256 of the server's redacted transcript** (`captureOf` → `transcriptHash`, the lines are `[HH:MM:SS] Speaker: text` with UTC times from `toISOString`). `ackLiveSession` compares `lines` and `hash` with what the server holds (409 `ACK_MISMATCH` otherwise, nothing deleted). The archivist echoes the server's values, and it proves its own write by the read-back verify plus a row count equal to `lines`.
4. **`LLMIDE_LIVE_ACK` does not reach the desktop core.** `core_env.rs` `ALLOWED` passes only `LLMIDE_CLAUDE_PATH` and `LLMIDE_FEATURES` from the host env, and `core_host.rs` `real_launch` does not set it. With the flag off, finalize answers no `ackRequired`, the extension puts the draft in stage `no-ack` and keeps it for good (`capture-store.ts:548,576`). An archivist ack would then release nothing. Task 6 sets the flag on the spawned core.
5. **The extension releases a draft only on `acked` with matching `lines` and `captionHash`** (`capture-store.ts` `reconcileDrafts`, "The only deletion is the verified-`acked` branch"). On `expired` or `unknown` it keeps the draft. So a stuck archivist never loses data: the draft stays in the browser.
6. **The host already has an authenticated loopback client and a bound session.** `chat_archive.rs` `HttpRemote` is loopback-only, never follows redirects and has bounded reads. `chat_cmds.rs` `ChatService::bind` verifies the token with `GET /auth/me`, keeps it in memory and re-resolves `verified_url` at each use.
7. **The note writer and verifier already exist.** `capture_store.rs` `finalize` renders the Mac `MeetingFileStore` format (`render_meeting`), creates the note without overwriting (`create_unique` → `notes_write::create_note`), reads it back (`open_note`), verifies the frontmatter id and the transcript line count (`verify`), and returns an `IndexUpsert` in the `makeUpsertInput` shape. The live screen posts that as `{ notes: [index] }` to `/kb/index/notes` (`ui/screens/live/index.tsx:11`).
8. **No rule says "the core never writes the notes folder"** (searched `docs/explanation`, `docs/kits`, `docs/decisions`, the live-then-archive plan). The equivalent facts are these. `notes_fs.rs:7-11`: the notes root is chosen by the host through a native dialog, stored in the host's app data and re-validated on every call. The core has no notes-root concept. Data-lifecycle rule 1 says the archive is the desktop's on-disk store. So the archivist belongs in the host (decision D1).
9. **Blocker outside this plan: a real extension cannot reach the desktop core yet.** The extension accepts only port 3456 (`extension/src/lib/config.ts:16`, `manifest.json:36` CSP `connect-src`). The desktop spawns its core on 3457 to 3459 (`core_host.rs:37`), never adopts `:3456` in a release build, and sends no credentials to an adopted core. This plan builds and tests the archivist against the desktop's own core. The extension checklist rows stay open until decision D2 is made (Task 7 records this).
10. **Notes root at tick time:** `notes_fs::current_root()` is the open project's `llm-doc`, otherwise the chosen notes folder. This is the same root a native capture's Stop writes to. With no root, the capture waits (no write, no ack).

## B. File structure

| File | Change | Responsibility |
|---|---|---|
| `extension/agents/live-sessions.mjs` | Modify | `rowsOfTranscript`, `liveCaptureOf`: the held copy of a finalized, unacked capture |
| `extension/routes/live.mjs` | Modify | `GET /kb/live/:id/capture` (200 or 404) |
| `extension/tests/live-capture-archivist.test.mjs` | Create | Unit and route tests for the read |
| `schema/http/lifecycle.schema.json` | Modify | Contract for `GET /kb/live/:id/capture` |
| `schema/http/fixtures/lifecycle/get-kb-live-id-capture-200.json`, `-404.json` | Create | Contract fixtures |
| `extension/server.mjs` | Modify | `ALL_ENDPOINTS` entry, `SERVER_API_VERSION` 116 and its history line |
| `extension/tests/http-contract-live.test.mjs` | Modify | Skip rule for the 200 fixture (it needs a seeded capture) |
| `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml`, `schema/http/INVENTORY.md` | Regenerate | Generated contract artefacts |
| `desktop/src-tauri/src/capture_store.rs` | Modify | `candidate_rels`, `note_of`, `find_archived`, `utc_times_to_local` |
| `desktop/src-tauri/src/capture_archivist.rs` | Create | Remote trait, `archive_one`, bounded `Archivist::tick`, HTTP impl, session slot and thread |
| `desktop/src-tauri/src/chat_archive.rs` | Modify | `HttpRemote::call` / `call_capped` become `pub(crate)`, with a per-call response cap |
| `desktop/src-tauri/src/chat_cmds.rs` | Modify | Bind and unbind also bind and unbind the archivist |
| `desktop/src-tauri/src/core_host.rs` | Modify | `SPAWNED_CORE_FLAGS` with `LLMIDE_LIVE_ACK=1` |
| `desktop/src-tauri/src/lib.rs` | Modify | `mod capture_archivist;` |
| `extension/CLAUDE.md`, `docs/explanation/invariants.md`, `docs/kits/capture-kit.md`, `docs/superpowers/MASTER-PLAN.md`, `docs/superpowers/plans/2026-11-05-desktop-live-capture.md` | Modify | State, invariants, the open blocker |

## C. Tasks

### Task 1: Core read of the held capture (`GET /kb/live/:id/capture`) — about 30 min

**Files:**
- Modify: `extension/agents/live-sessions.mjs` (add after `listUnackedLiveSessions`, before `_resetForTests`)
- Modify: `extension/routes/live.mjs` (import line 16-18, new route right after the `/status` route)
- Test: `extension/tests/live-capture-archivist.test.mjs`

**Interfaces:**
- Consumes: `captureOf(s)`, `titleOf(s)`, `durationOf(s)`, `getLiveAck`, `getCrashRow`, `sessions`, `key` (all in `live-sessions.mjs`).
- Produces: `export function rowsOfTranscript(transcript: string): {time, speaker, text}[]` and `export function liveCaptureOf(userId, sessionId): null | { sessionId, title, startedAt: number|null, durationSec: number, language: string, lines: number, hash: string, rows: {time, speaker, text}[] }`. HTTP: `GET /kb/live/:id/capture` → 200 with that object, or 404 `{ error: { code: 'NOT_FOUND', message } }`. `time` is the UTC `HH:MM:SS` of the held transcript.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/live-capture-archivist.test.mjs`:

```js
// GET /kb/live/:id/capture: the held copy of a finalized, unacked extension capture, read by the desktop
// archivist (desktop/src-tauri/src/capture_archivist.rs). Flag on, temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LIVE_ACK = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_live-capture-archivist-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const live = await import('../agents/live-sessions.mjs');
const acks = await import('../kb/live-acks.mjs');
const { handleLiveRoutes } = await import('../routes/live.mjs');
const conn = db.getDb();

const U = users.registerUser(conn, { email: `cap-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'a' }).id;
const V = users.registerUser(conn, { email: `capv-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'b' }).id;
const T0 = Date.now() - 120_000;
const captions = [
  { speaker: 'Ana', text: 'Let us start the budget review.', ts: T0 },
  { speaker: 'Ben', text: 'Agreed: the rollback plan is ready.', ts: T0 + 60_000 },
];
const hms = (ms) => new Date(ms).toISOString().slice(11, 19);
function finalized(id, meta = {}) {
  live.appendCaptions(U, id, captions, 'Standup');
  live.finalizeSession(U, id, meta);
}
async function get(userId, url) {
  const res = { headersSent: false, status: 0, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } };
  const handled = await handleLiveRoutes({ method: 'GET' }, res, { userId, url });
  return { handled, status: res.status, body: res.body };
}

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('rowsOfTranscript reads "[HH:MM:SS] Speaker: text" lines and drops any other line', () => {
  assert.deepEqual(live.rowsOfTranscript('[09:30:01] Ana: Hello.\n[09:30:02] Ben: Ratio: 3:1\nnot a line\n'), [
    { time: '09:30:01', speaker: 'Ana', text: 'Hello.' },
    { time: '09:30:02', speaker: 'Ben', text: 'Ratio: 3:1' },
  ]);
  assert.deepEqual(live.rowsOfTranscript(''), []);
});

test('a finalized capture in memory: its rows, plus the lines and hash the ack must echo', () => {
  finalized('cap-mem', { language: 'ja' });
  const cap = live.liveCaptureOf(U, 'cap-mem');
  const un = live.listUnackedLiveSessions(U).find((s) => s.sessionId === 'cap-mem');
  assert.equal(cap.lines, un.lines);
  assert.equal(cap.hash, un.hash);
  assert.deepEqual(cap.rows, [
    { time: hms(T0), speaker: 'Ana', text: 'Let us start the budget review.' },
    { time: hms(T0 + 60_000), speaker: 'Ben', text: 'Agreed: the rollback plan is ready.' },
  ]);
  assert.equal(cap.title, 'Standup');
  assert.equal(cap.language, 'ja');
  assert.equal(cap.startedAt, T0);
  assert.equal(cap.durationSec, 60);
});

test('after a restart the capture is read from its durable row', () => {
  finalized('cap-db');
  live._resetForTests();
  const cap = live.liveCaptureOf(U, 'cap-db');
  assert.equal(cap.hash, acks.getCrashRow(U, 'cap-db').content_hash);
  assert.equal(cap.lines, 2);
  assert.equal(cap.rows.length, 2);
  assert.equal(cap.startedAt, T0);
});

test("a live, acked, unknown or other user's capture is not served", () => {
  live.appendCaptions(U, 'cap-live', captions, 'Live');
  assert.equal(live.liveCaptureOf(U, 'cap-live'), null);
  finalized('cap-acked');
  const cap = live.liveCaptureOf(U, 'cap-acked');
  live.ackLiveSession(U, 'cap-acked', { noteKey: 'source/meetings/2026/11/x.md', hash: cap.hash, lines: cap.lines });
  assert.equal(live.liveCaptureOf(U, 'cap-acked'), null);
  assert.equal(live.liveCaptureOf(U, 'nope'), null);
  assert.equal(live.liveCaptureOf(V, 'cap-db'), null);
});

test('GET /kb/live/:id/capture answers 200 with the held copy and 404 otherwise', async () => {
  finalized('cap-http');
  const ok = await get(U, '/kb/live/cap-http/capture');
  assert.equal(ok.handled, true);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sessionId, 'cap-http');
  assert.equal(ok.body.rows.length, 2);
  const missing = await get(V, '/kb/live/cap-http/capture');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/live-capture-archivist.test.mjs`
Expected: FAIL with `live.rowsOfTranscript is not a function`.

- [ ] **Step 3: Implement the read**

In `extension/agents/live-sessions.mjs`, add before `// For the test runner — never called from production code.`:

```js
const HELD_LINE = /^\[(\d{2}:\d{2}:\d{2})\] (.+?): (.*)$/;

/**
 * Rows of a held transcript ("[HH:MM:SS] Speaker: text", UTC times, as captureOf builds it). A line that does not
 * parse is dropped, so a caller compares rows.length with the capture's line count and refuses a mismatch.
 * shortcut: a speaker name that itself contains ": " splits early (the text keeps the rest, nothing is lost);
 * store structured rows in live_crash_rows if that ever shows up.
 */
export function rowsOfTranscript(transcript) {
  const out = [];
  for (const line of String(transcript || '').split('\n')) {
    const m = HELD_LINE.exec(line);
    if (m) out.push({ time: m[1], speaker: m[2], text: m[3] });
  }
  return out;
}

/**
 * The held (redacted) copy of a finalized capture nobody has acked yet, for the desktop archivist
 * (GET /kb/live/:id/capture). Null while it is live, once acked or expired, or when unknown to this user.
 * `lines` and `hash` are exactly what the ack must echo.
 */
export function liveCaptureOf(userId, sessionId) {
  if (!userId || !sessionId) throw new Error('userId and sessionId required');
  const s = sessions.get(key(userId, sessionId));
  if (s && !s.finalized) return null;
  if (getLiveAck(userId, sessionId)) return null;
  if (s) {
    const cap = captureOf(s);
    return {
      sessionId, title: titleOf(s), startedAt: s.startedAt, durationSec: durationOf(s), language: s.language || '',
      lines: cap.lines, hash: cap.hash, rows: rowsOfTranscript(cap.transcript),
    };
  }
  const row = getCrashRow(userId, sessionId);
  if (!row) return null;
  const startedAt = Date.parse(row.started_at);
  return {
    sessionId, title: row.title, startedAt: Number.isFinite(startedAt) ? startedAt : null, durationSec: row.duration_sec,
    language: row.language || '', lines: row.lines, hash: row.content_hash, rows: rowsOfTranscript(row.transcript),
  };
}
```

In `extension/routes/live.mjs`, extend the import:

```js
import {
  appendCaptions, getCaptionsSince, listActiveSessions, finalizeSession, liveEvents,
  ackLiveSession, liveSessionStatus, listUnackedLiveSessions, validateCaptureMeta, liveCaptureOf,
} from '../agents/live-sessions.mjs';
```

and add right after the `GET /kb/live/:sessionId/status` block (before `// POST /kb/live/:sessionId/append`):

```js
  // GET /kb/live/:sessionId/capture — the held copy of a finalized, unacked capture, for the desktop archivist
  // (desktop/src-tauri/src/capture_archivist.rs). It writes the note, verifies it, then acks.
  if (req.method === 'GET' && /^\/kb\/live\/[^/]+\/capture$/.test(path)) {
    const sessionId = decodeParam(path.slice('/kb/live/'.length, -'/capture'.length));
    const cap = liveCaptureOf(userId, sessionId);
    if (!cap) {
      sendJSON(res, 404, { error: { code: 'NOT_FOUND', message: 'capture is not finalized, already acked or not known' } });
      return true;
    }
    sendJSON(res, 200, cap);
    return true;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && node --test tests/live-capture-archivist.test.mjs tests/live-ack.test.mjs tests/live-capture-verify.test.mjs`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add extension/agents/live-sessions.mjs extension/routes/live.mjs extension/tests/live-capture-archivist.test.mjs
git commit -m "feat(server): serve the held copy of an unacked live capture to the archivist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Contract for the new route — about 25 min

**Files:**
- Modify: `schema/http/lifecycle.schema.json` (new endpoint right after `GET /kb/live/:id/status`)
- Create: `schema/http/fixtures/lifecycle/get-kb-live-id-capture-200.json`, `schema/http/fixtures/lifecycle/get-kb-live-id-capture-404.json`
- Modify: `extension/server.mjs` (history comment above the `v115` line, `SERVER_API_VERSION`, `ALL_ENDPOINTS` after `'/kb/live/:id/status'`)
- Modify: `extension/tests/http-contract-live.test.mjs` (`SKIP_RULES`, next to the `POST /kb/live/:id/ack` 409 rule)
- Regenerate: `extension/src/lib/api-types.ts`, `docs/reference/api/openapi.yaml`, `schema/http/INVENTORY.md`

**Interfaces:**
- Consumes: the Task 1 response shape.
- Produces: the contract key `GET /kb/live/:id/capture`; the server advertises `/kb/live/:id/capture` in `/health` `ENDPOINTS`; `SERVER_API_VERSION = 116`.

- [ ] **Step 1: Add the schema entry**

Run from the repo root (it inserts the key after the status route and keeps the file's 2-space format):

```bash
node -e '
const fs = require("fs");
const f = "schema/http/lifecycle.schema.json";
const d = JSON.parse(fs.readFileSync(f, "utf8"));
const row = { type: "object", required: ["time", "speaker", "text"], properties: {
  time: { type: "string", description: "UTC HH:MM:SS of the caption, as the held transcript stores it." },
  speaker: { type: "string" }, text: { type: "string" } } };
const capture = {
  request: { params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  responses: {
    "200": { type: "object", required: ["sessionId", "title", "startedAt", "durationSec", "language", "lines", "hash", "rows"], properties: {
      sessionId: { type: "string" },
      title: { type: "string" },
      startedAt: { type: ["number", "null"], description: "Capture start, Unix ms." },
      durationSec: { type: "integer" },
      language: { type: "string", description: "Empty when the client sent none." },
      lines: { type: "integer", description: "Lines the server holds. The ack must echo it." },
      hash: { type: "string", description: "SHA-256 (64 hex) of the redacted transcript the server holds. The ack must echo it." },
      rows: { type: "array", items: row, description: "The held (redacted) transcript, one row per line. The desktop archivist refuses a capture whose row count differs from lines." },
    } },
    "404": { $ref: "_common#/$defs/Error" },
  },
};
const out = {};
for (const [k, v] of Object.entries(d.endpoints)) { out[k] = v; if (k === "GET /kb/live/:id/status") out["GET /kb/live/:id/capture"] = capture; }
if (!out["GET /kb/live/:id/capture"]) throw new Error("status route not found");
d.endpoints = out;
fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
'
git diff --stat schema/http/lifecycle.schema.json
```

Expected: only insertions in that file. If the diff also rewrites unrelated lines (a formatting difference), revert with `git checkout schema/http/lifecycle.schema.json` and paste the same object by hand after the status entry.

- [ ] **Step 2: Add the two fixtures**

`schema/http/fixtures/lifecycle/get-kb-live-id-capture-200.json`:

```json
{
  "endpoint": "GET /kb/live/:id/capture",
  "status": 200,
  "description": "Example data. A finalized capture nobody has acked yet: the desktop archivist writes these rows as a note, verifies it, then acks with the lines and hash shown.",
  "request": {
    "params": {
      "id": "live-session-7"
    }
  },
  "response": {
    "sessionId": "live-session-7",
    "title": "Standup",
    "startedAt": 1798500000000,
    "durationSec": 60,
    "language": "en",
    "lines": 2,
    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "rows": [
      { "time": "08:00:00", "speaker": "Ana", "text": "Let us start the budget review." },
      { "time": "08:01:00", "speaker": "Ben", "text": "Agreed, the rollback plan is ready." }
    ]
  }
}
```

`schema/http/fixtures/lifecycle/get-kb-live-id-capture-404.json`:

```json
{
  "endpoint": "GET /kb/live/:id/capture",
  "status": 404,
  "description": "The capture is still live, already acked, or unknown to this user.",
  "request": {
    "params": {
      "id": "live-session-9"
    }
  },
  "response": {
    "error": {
      "code": "NOT_FOUND",
      "message": "capture is not finalized, already acked or not known"
    }
  }
}
```

- [ ] **Step 3: Advertise the route and bump the API version**

In `extension/server.mjs`, add this line directly above the line that starts with `//   v115 — Box sync store (SP6)`:

```js
//   v116 — additive: GET /kb/live/:id/capture → { sessionId, title, startedAt, durationSec, language, lines, hash, rows: [{ time (UTC HH:MM:SS), speaker, text }] } for a finalized, unacked capture (404 NOT_FOUND while live, once acked, or unknown). Read by the desktop archivist, which writes and verifies the note before POST /kb/live/:id/ack.
```

Change `const SERVER_API_VERSION = 115;` to `const SERVER_API_VERSION = 116;`. In `ALL_ENDPOINTS`, replace

```js
  '/kb/live/:id/status',
```

with

```js
  '/kb/live/:id/status',
  '/kb/live/:id/capture',
```

- [ ] **Step 4: Skip the 200 fixture in the live replay (it needs a seeded capture)**

In `extension/tests/http-contract-live.test.mjs`, add this rule right after the rule whose `why` starts with `'needs a finalized capture seeded through the live append and finalize routes, so the ack can answer 409'`:

```js
  {
    why: 'needs a finalized capture seeded through the live append and finalize routes, so the archivist read can answer 200; covered by tests/live-capture-archivist.test.mjs',
    when: (fx) => fx.status === 200 && fx.endpoint === 'GET /kb/live/:id/capture',
  },
```

- [ ] **Step 5: Regenerate the artefacts and run the gates**

Run:

```bash
node scripts/gen-api-types.mjs && node scripts/gen-openapi.mjs && node scripts/http-inventory.mjs
make contract-gates
cd extension && node --test tests/http-contract-live.test.mjs tests/kb-complete.test.mjs && cd ..
python3 docs/_scripts/check_api_coverage.py
```

Expected: every command exits 0. The live replay reports the 404 fixture as passed and the 200 fixture as skipped with the new reason.

- [ ] **Step 6: Commit**

```bash
git add schema/http/lifecycle.schema.json schema/http/fixtures/lifecycle/get-kb-live-id-capture-200.json schema/http/fixtures/lifecycle/get-kb-live-id-capture-404.json extension/server.mjs extension/tests/http-contract-live.test.mjs extension/src/lib/api-types.ts docs/reference/api/openapi.yaml schema/http/INVENTORY.md
git commit -m "feat(server): contract for GET /kb/live/:id/capture (API v116)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Note store helpers: find an archived note, local times — about 30 min

**Files:**
- Modify: `desktop/src-tauri/src/capture_store.rs` (`create_unique`, `finalize`, new functions after `finalize`, tests at the end of `mod tests`)

**Interfaces:**
- Consumes: `render_meeting`, `final_rel`, `local_hms`, `notes_write::open_note`, `notes_write::OpenedNote` (fields `text`, `hash`, `mtime_ms`).
- Produces: `pub fn find_archived(root: &Path, m: &FinalMeta, rows: &[Row]) -> Option<FinalizedNote>` (the note an earlier run wrote with exactly these bytes, with its `IndexUpsert`) and `pub fn utc_times_to_local(started_at_ms: i64, rows: &mut [Row])` (rewrites each `HH:MM:SS` UTC row time to local time, across midnight). `finalize` keeps its signature and behaviour.

- [ ] **Step 1: Write the failing tests**

In `desktop/src-tauri/src/capture_store.rs`, replace the end of the test module

```rust
assert!(finalize(&root,None,&m,&[]).unwrap_err().starts_with("empty"))}}
```

with

```rust
assert!(finalize(&root,None,&m,&[]).unwrap_err().starts_with("empty"))}
fn ext_meta()->FinalMeta<'static>{FinalMeta{id:"0b6c2d4e-1111-4a2b-9c3d-123456789abc",title:"Sync",started_at_ms:1_762_335_000_000,ended_at_ms:1_762_335_060_000,platform:"chrome-extension",language:"en"}}
#[test]fn archived_note_is_found_again(){let root=scratch("again");let m=ext_meta();let rows=vec![row("09:30:01","Alice","Hello.")];assert!(find_archived(&root,&m,&rows).is_none());let n=finalize(&root,None,&m,&rows).unwrap();let again=find_archived(&root,&m,&rows).unwrap();assert_eq!(again.rel,n.rel);assert_eq!(again.hash,n.hash);assert_eq!(again.lines,1);assert_eq!(again.index.unwrap().note_key,n.rel);let more=vec![row("09:30:01","Alice","Hello."),row("09:30:02","Bob","Hi.")];assert!(find_archived(&root,&m,&more).is_none(),"other content is another note")}
#[test]fn edited_note_is_not_reused(){let root=scratch("edited");let m=ext_meta();let rows=vec![row("09:30:01","Alice","Hello.")];let n=finalize(&root,None,&m,&rows).unwrap();std::fs::write(root.join(&n.rel),"changed").unwrap();assert!(find_archived(&root,&m,&rows).is_none())}
#[test]fn utc_times_become_local(){const DAY:i64=86_400_000;let start=1_762_335_000_000;let mut r=vec![row("09:30:01","A","x")];utc_times_to_local(start,&mut r);assert_eq!(r[0].time,local_hms(start+1_000));
let late=(start/DAY)*DAY+86_390_000;let mut r=vec![row("23:59:55","A","x"),row("00:00:05","B","y")];utc_times_to_local(late,&mut r);assert_eq!(r[0].time,local_hms(late+5_000));assert_eq!(r[1].time,local_hms(late+15_000),"past UTC midnight");
let early=(start/DAY)*DAY+DAY+5_000;let mut r=vec![row("23:59:40","A","x")];utc_times_to_local(early,&mut r);assert_eq!(r[0].time,local_hms(early-25_000),"a caption just before the start, across midnight");
let mut r=vec![row("9:30","A","x")];utc_times_to_local(start,&mut r);assert_eq!(r[0].time,"9:30","an unreadable time is left for verify to refuse")}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd desktop/src-tauri && cargo test --lib capture_store`
Expected: FAIL to compile: `cannot find function find_archived` and `cannot find function utc_times_to_local`.

- [ ] **Step 3: Implement**

Replace the whole `fn create_unique(...)` line with:

```rust
fn candidate_rels(base:&str)->Vec<String>{let stem=base.strip_suffix(".md").expect("md");(1..=9).map(|n|if n==1{base.to_string()}else{format!("{stem}-{n}.md")}).collect()}
fn create_unique(root:&Path,base:&str,text:&str)->Result<notes_write::SavedNote,String>{for rel in candidate_rels(base){match notes_write::create_note(root,&notes_write::CreateReq{rel,text:text.to_string()}){Ok(s)=>return Ok(s),Err(e)if e.starts_with("exists")=>continue,Err(e)=>return Err(e)}}Err("exists: nine notes with this name already exist".into())}
```

Replace the whole `pub fn finalize(...)` line with these lines (the same steps, with the result built by `note_of` so `find_archived` can reuse it), followed by the new functions:

```rust
fn note_of(m:&FinalMeta,rows:&[Row],rel:String,opened:notes_write::OpenedNote)->FinalizedNote{let index=(opened.text.len()<=INDEX_BODY_BYTES).then(||IndexUpsert{note_key:rel.clone(),kind:"meeting",title:m.title.chars().take(500).collect(),date:crate::chat_archive::iso_utc(m.started_at_ms as f64/1000.0).replace('Z',".000Z"),duration_sec:(m.ended_at_ms-m.started_at_ms).max(0)/1000,participants:participants(rows).into_iter().take(200).map(|p|p.chars().take(200).collect()).collect(),body:opened.text.split_once("\n---\n").map(|(_,b)|b.to_string()).unwrap_or_default(),content_hash:opened.hash.clone(),mtime_ms:opened.mtime_ms,meta:IndexMeta{meeting_id:m.id.into(),platform:m.platform.into(),language:m.language.into()}});FinalizedNote{rel,hash:opened.hash,lines:rows.len(),mtime_ms:opened.mtime_ms,index}}
pub fn finalize(root:&Path,partial:Option<&Path>,m:&FinalMeta,rows:&[Row])->Result<FinalizedNote,String>{if rows.is_empty(){return Err("empty: nothing was captured".into())}let root=std::fs::canonicalize(root).map_err(io)?;let root=root.as_path();let text=render_meeting(m,rows);let saved=create_unique(root,&final_rel(m.started_at_ms,m.title,m.id),&text)?;let opened=notes_write::open_note(root,&saved.rel)?;verify(&opened.text,m.id,rows.len())?;if let Some(p)=partial{std::fs::remove_file(p).map_err(io)?;}Ok(note_of(m,rows,saved.rel,opened))}
/// The note an earlier archive run already wrote for exactly this capture (same name family, same bytes), so a crash
/// between the write and the ack never makes a second note. shortcut: an edited note, or one rendered in another time
/// zone, is not recognised and a new `-N` note is written; compare only the transcript section if that shows up.
pub fn find_archived(root:&Path,m:&FinalMeta,rows:&[Row])->Option<FinalizedNote>{if rows.is_empty(){return None}let root=std::fs::canonicalize(root).ok()?;let text=render_meeting(m,rows);for rel in candidate_rels(&final_rel(m.started_at_ms,m.title,m.id)){if let Ok(o)=notes_write::open_note(&root,&rel){if o.text==text{return Some(note_of(m,rows,rel,o))}}}None}
fn hms_secs(t:&str)->Option<i64>{let b=t.as_bytes();if b.len()!=8||!b.iter().enumerate().all(|(i,c)|if i==2||i==5{*c==b':'}else{c.is_ascii_digit()}){return None}let n=|i:usize|t[i..i+2].parse::<i64>().ok();let(h,mi,s)=(n(0)?,n(3)?,n(6)?);(h<24&&mi<60&&s<60).then_some(h*3600+mi*60+s)}
/// The core holds caption times as UTC `HH:MM:SS`; the Mac note format shows local time. The day comes from the capture
/// start, and it moves forward when the times wrap past midnight. A time that does not parse is left as it is (the
/// read-back verify then refuses the note, so it is never acked).
pub fn utc_times_to_local(started_at_ms:i64,rows:&mut [Row]){const DAY:i64=86_400_000;let mut day=started_at_ms.div_euclid(DAY)*DAY;let mut prev:Option<i64>=None;for r in rows.iter_mut(){let Some(secs)=hms_secs(&r.time)else{continue};let mut ms=day+secs*1000;match prev{None=>{if ms<started_at_ms-DAY/2{ms+=DAY;day+=DAY}else if ms>started_at_ms+DAY/2{ms-=DAY;day-=DAY}}Some(p)=>{if ms<p-DAY/2{ms+=DAY;day+=DAY}}}prev=Some(ms);r.time=local_hms(ms)}}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test --lib capture_store && cargo test --lib capture_session`
Expected: PASS. The existing `finalize_verify` test still passes, which shows `finalize` behaviour is unchanged.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/capture_store.rs
git commit -m "feat(desktop): find an already archived meeting note and convert UTC caption times

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: The archivist pass (pure logic over a remote trait) — about 35 min

**Files:**
- Create: `desktop/src-tauri/src/capture_archivist.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (add `mod capture_archivist;` after `mod capture_host;`)

**Interfaces:**
- Consumes: `capture_store::{finalize, find_archived, utc_times_to_local, clean_title, FinalMeta, FinalizedNote, IndexUpsert, Row}` (Task 3), `chat_archive::RemoteError`.
- Produces: `pub struct Unacked { session_id: String, lines: usize }`, `pub struct HeldCapture { session_id, title, started_at: i64, duration_sec: i64, language: String, lines: usize, hash: String, rows: Vec<Row> }` (camelCase serde), `pub trait CaptureRemote { fn unacked(&self) -> Result<Vec<Unacked>, RemoteError>; fn capture(&self, id: &str) -> Result<HeldCapture, RemoteError>; fn index(&self, upsert: &IndexUpsert) -> Result<(), RemoteError>; fn ack(&self, id: &str, note_key: &str, hash: &str, lines: usize) -> Result<(), RemoteError>; }`, `pub enum Outcome { Archived, Reused, Failed }`, `pub struct TickReport { archived, reused, failed, skipped, waiting: usize }`, `pub fn valid_capture_id(&str) -> bool`, `pub fn archive_one(&dyn CaptureRemote, &Path, &str) -> Outcome`, `#[derive(Default)] pub struct Archivist` with `pub fn tick(&mut self, remote: &dyn CaptureRemote, root: &Path, still_bound: &dyn Fn() -> bool) -> Result<TickReport, RemoteError>`, constants `TICK` (20 s), `MAX_PER_TICK` (5), `MAX_ATTEMPTS` (3).

- [ ] **Step 1: Write the module with its tests, the logic stubbed**

Create `desktop/src-tauri/src/capture_archivist.rs` with the full module below, but make `archive_one` body `Outcome::Failed` for this step only, so the tests fail first:

```rust
//! Desktop archivist for Chrome-extension captures (live-then-archive 3.6 B; plan
//! docs/superpowers/plans/2026-11-07-desktop-capture-archivist.md).
//!
//! The extension finalizes a capture on the core (`POST /kb/live/:id/finalize`); with `LLMIDE_LIVE_ACK=1` (set on the
//! core this app spawns) the core holds it until an archivist acks. This module is that archivist, in the host:
//!   1. list the bound user's unacked captures (`GET /kb/live/unacked`),
//!   2. read the held copy (`GET /kb/live/:id/capture`); its rows must equal the line count the ack echoes,
//!   3. find the note an earlier run wrote for exactly this capture, or write it through `capture_store::finalize`
//!      (the same writer and read-back verify as a native capture),
//!   4. feed the derived index (best effort), then ack with the server's own lines and hash.
//! Nothing is acked unless step 3 returned a note that read back. A crash between 3 and 4 is repaired by the next pass
//! finding the same note (`find_archived`). Bounded: MAX_PER_TICK captures per pass, MAX_ATTEMPTS per capture per launch.
//! Capture text is never logged (desktop/scripts/check-capture-privacy.test.mjs covers every capture_*.rs).

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::capture_store::{self, FinalMeta, IndexUpsert, Row};
use crate::chat_archive::RemoteError;

pub const TICK: Duration = Duration::from_secs(20);
pub const MAX_PER_TICK: usize = 5;
pub const MAX_ATTEMPTS: u32 = 3;
/// Frontmatter platform of an extension capture (what the Swift writer used; the core does not hold the meeting app).
const PLATFORM: &str = "chrome-extension";

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unacked {
    pub session_id: String,
    pub lines: usize,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldCapture {
    pub session_id: String,
    pub title: String,
    pub started_at: i64,
    pub duration_sec: i64,
    #[serde(default)]
    pub language: String,
    pub lines: usize,
    pub hash: String,
    /// UTC `HH:MM:SS` times, as the core holds them.
    pub rows: Vec<Row>,
}

/// What the archivist asks of the core (schema/http/lifecycle.schema.json, index.schema.json).
pub trait CaptureRemote {
    fn unacked(&self) -> Result<Vec<Unacked>, RemoteError>;
    fn capture(&self, id: &str) -> Result<HeldCapture, RemoteError>;
    fn index(&self, upsert: &IndexUpsert) -> Result<(), RemoteError>;
    fn ack(&self, id: &str, note_key: &str, hash: &str, lines: usize) -> Result<(), RemoteError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Archived,
    Reused,
    Failed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TickReport {
    pub archived: usize,
    pub reused: usize,
    pub failed: usize,
    pub skipped: usize,
    pub waiting: usize,
}

/// Ids the archivist puts in a URL path: the extension's UUIDs and `legacy-<id>-<hex>` ids.
pub fn valid_capture_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && !id.starts_with('.')
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

/// One capture: write (or find) the verified note, index it, then ack. Never acks without a note that read back.
pub fn archive_one(remote: &dyn CaptureRemote, root: &Path, id: &str) -> Outcome {
    let Ok(cap) = remote.capture(id) else { return Outcome::Failed };
    if cap.session_id != id || cap.lines == 0 || cap.rows.len() != cap.lines {
        return Outcome::Failed;
    }
    let mut rows = cap.rows;
    capture_store::utc_times_to_local(cap.started_at, &mut rows);
    let title = capture_store::clean_title(&cap.title);
    let meta = FinalMeta {
        id,
        title: &title,
        started_at_ms: cap.started_at,
        ended_at_ms: cap.started_at + cap.duration_sec.max(0) * 1000,
        platform: PLATFORM,
        language: &cap.language,
    };
    let (note, reused) = match capture_store::find_archived(root, &meta, &rows) {
        Some(n) => (n, true),
        None => match capture_store::finalize(root, None, &meta, &rows) {
            Ok(n) => (n, false),
            Err(_) => return Outcome::Failed,
        },
    };
    if let Some(ix) = &note.index {
        let _ = remote.index(ix); // derived and rebuildable (Library rebuild): never blocks the ack
    }
    match remote.ack(id, &note.rel, &cap.hash, cap.lines) {
        Ok(()) if reused => Outcome::Reused,
        Ok(()) => Outcome::Archived,
        Err(_) => Outcome::Failed,
    }
}

#[derive(Default)]
pub struct Archivist {
    attempts: HashMap<String, u32>,
}

impl Archivist {
    /// One bounded pass. `still_bound` is re-read before each capture: a sign-out or token refresh stops the pass.
    pub fn tick(&mut self, remote: &dyn CaptureRemote, root: &Path, still_bound: &dyn Fn() -> bool) -> Result<TickReport, RemoteError> {
        let mut r = TickReport::default();
        let mut started = 0;
        for u in remote.unacked()? {
            let tries = self.attempts.get(&u.session_id).copied().unwrap_or(0);
            if u.lines == 0 || !valid_capture_id(&u.session_id) || tries >= MAX_ATTEMPTS {
                r.skipped += 1;
                continue;
            }
            if started >= MAX_PER_TICK || !still_bound() {
                r.waiting += 1;
                continue;
            }
            started += 1;
            match archive_one(remote, root, &u.session_id) {
                Outcome::Archived => {
                    r.archived += 1;
                    self.attempts.remove(&u.session_id);
                }
                Outcome::Reused => {
                    r.reused += 1;
                    self.attempts.remove(&u.session_id);
                }
                Outcome::Failed => {
                    r.failed += 1;
                    *self.attempts.entry(u.session_id).or_insert(0) += 1;
                }
            }
        }
        if self.attempts.len() > 1_000 {
            self.attempts.clear(); // bounded memory; the core holds at most 200 unacked captures per user
        }
        Ok(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub(super) fn scratch(t: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("llmide-arch-{t}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    pub(super) fn md_files(dir: &Path) -> usize {
        let mut n = 0;
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    n += md_files(&p);
                } else if p.extension().is_some_and(|x| x == "md") {
                    n += 1;
                }
            }
        }
        n
    }

    #[derive(Default)]
    struct Fake {
        list: RefCell<Vec<Unacked>>,
        caps: HashMap<String, HeldCapture>,
        fail_acks: Cell<u32>,
        acks: RefCell<Vec<(String, String, String, usize)>>,
        indexed: RefCell<Vec<String>>,
    }

    impl CaptureRemote for Fake {
        fn unacked(&self) -> Result<Vec<Unacked>, RemoteError> {
            Ok(self.list.borrow().clone())
        }
        fn capture(&self, id: &str) -> Result<HeldCapture, RemoteError> {
            self.caps.get(id).cloned().ok_or(RemoteError::Http(404))
        }
        fn index(&self, u: &IndexUpsert) -> Result<(), RemoteError> {
            self.indexed.borrow_mut().push(u.note_key.clone());
            Ok(())
        }
        fn ack(&self, id: &str, key: &str, hash: &str, lines: usize) -> Result<(), RemoteError> {
            if self.fail_acks.get() > 0 {
                self.fail_acks.set(self.fail_acks.get() - 1);
                return Err(RemoteError::Unreachable);
            }
            self.acks.borrow_mut().push((id.into(), key.into(), hash.into(), lines));
            self.list.borrow_mut().retain(|u| u.session_id != id);
            Ok(())
        }
    }

    fn held(id: &str) -> HeldCapture {
        HeldCapture {
            session_id: id.into(),
            title: "Standup".into(),
            started_at: 1_762_335_000_000,
            duration_sec: 60,
            language: "en".into(),
            lines: 2,
            hash: "h".repeat(64),
            rows: vec![
                Row { time: "09:30:01".into(), speaker: "Ana".into(), text: "Hello.".into() },
                Row { time: "09:31:01".into(), speaker: "Ben".into(), text: "Hi.".into() },
            ],
        }
    }

    fn fake(ids: &[&str]) -> Fake {
        let mut f = Fake::default();
        for id in ids {
            f.list.borrow_mut().push(Unacked { session_id: (*id).into(), lines: 2 });
            f.caps.insert((*id).into(), held(id));
        }
        f
    }

    #[test]
    fn writes_and_verifies_the_note_then_acks_with_the_servers_lines_and_hash() {
        let root = scratch("ok");
        let f = fake(&["cap-1"]);
        let r = Archivist::default().tick(&f, &root, &|| true).unwrap();
        assert_eq!(r, TickReport { archived: 1, ..TickReport::default() });
        let acks = f.acks.borrow();
        let (id, rel, hash, lines) = &acks[0];
        assert_eq!(id, "cap-1");
        assert_eq!(hash, &"h".repeat(64));
        assert_eq!(*lines, 2);
        let text = std::fs::read_to_string(root.join(rel)).unwrap();
        assert!(text.contains("\nid: \"cap-1\"\n") && text.contains("\nplatform: \"chrome-extension\"\n"));
        assert!(text.contains("**Ana**: Hello.\n") && text.contains("**Ben**: Hi.\n"));
        assert_eq!(*f.indexed.borrow(), vec![rel.clone()]);
    }

    #[test]
    fn a_crash_between_write_and_ack_never_makes_a_second_note() {
        let root = scratch("crash");
        let f = fake(&["cap-1"]);
        f.fail_acks.set(1);
        assert_eq!(Archivist::default().tick(&f, &root, &|| true).unwrap().failed, 1);
        assert!(f.acks.borrow().is_empty());
        assert_eq!(md_files(&root), 1);
        // A relaunch (a fresh archivist) finds the same note and only acks.
        assert_eq!(Archivist::default().tick(&f, &root, &|| true).unwrap().reused, 1);
        assert_eq!(md_files(&root), 1);
        assert_eq!(f.acks.borrow().len(), 1);
    }

    #[test]
    fn a_failed_write_is_never_acked_and_is_retried_at_most_three_times() {
        let root = scratch("nowrite").join("missing"); // canonicalize fails: the write cannot happen
        let f = fake(&["cap-1"]);
        let mut a = Archivist::default();
        for _ in 0..MAX_ATTEMPTS {
            assert_eq!(a.tick(&f, &root, &|| true).unwrap().failed, 1);
        }
        assert_eq!(a.tick(&f, &root, &|| true).unwrap(), TickReport { skipped: 1, ..TickReport::default() });
        assert!(f.acks.borrow().is_empty());
    }

    #[test]
    fn rows_that_do_not_match_the_ack_line_count_are_refused() {
        let root = scratch("mismatch");
        let mut f = fake(&["cap-1"]);
        f.caps.get_mut("cap-1").unwrap().lines = 3;
        assert_eq!(Archivist::default().tick(&f, &root, &|| true).unwrap().failed, 1);
        assert_eq!(md_files(&root), 0);
        assert!(f.acks.borrow().is_empty());
    }

    #[test]
    fn a_pass_is_bounded_and_stops_when_the_session_goes() {
        let root = scratch("bound");
        let ids: Vec<String> = (0..7).map(|i| format!("cap-{i}")).collect();
        let f = fake(&ids.iter().map(String::as_str).collect::<Vec<_>>());
        let mut a = Archivist::default();
        assert_eq!(a.tick(&f, &root, &|| true).unwrap(), TickReport { archived: MAX_PER_TICK, waiting: 2, ..TickReport::default() });
        assert_eq!(a.tick(&f, &root, &|| false).unwrap(), TickReport { waiting: 2, ..TickReport::default() });
        assert_eq!(a.tick(&f, &root, &|| true).unwrap().archived, 2);
        assert_eq!(md_files(&root), 7);
    }

    #[test]
    fn empty_and_unsafe_ids_are_skipped_without_a_read() {
        let root = scratch("skip");
        let f = Fake::default();
        f.list.borrow_mut().extend([
            Unacked { session_id: "cap-0".into(), lines: 0 },
            Unacked { session_id: "../x".into(), lines: 2 },
            Unacked { session_id: String::new(), lines: 2 },
        ]);
        assert_eq!(Archivist::default().tick(&f, &root, &|| true).unwrap(), TickReport { skipped: 3, ..TickReport::default() });
        assert!(valid_capture_id("0b6c2d4e-1111-4a2b-9c3d-123456789abc") && valid_capture_id("legacy-17300-ab12cd34ef56"));
        assert!(!valid_capture_id("..") && !valid_capture_id("a/b") && !valid_capture_id(&"a".repeat(201)));
    }
}
```

Add `mod capture_archivist;` to `desktop/src-tauri/src/lib.rs` on the line after `mod capture_host;`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd desktop/src-tauri && cargo test --lib capture_archivist`
Expected: FAIL. `writes_and_verifies_…`, `a_crash_between_…` and `a_pass_is_bounded_…` fail on their first `assert_eq!` (`failed: 1` instead of `archived: 1`), because `archive_one` is stubbed.

- [ ] **Step 3: Restore the real `archive_one`**

Replace the stub body with the `archive_one` body shown in step 1 (from `let Ok(cap) = remote.capture(id)` to the final `match`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test --lib capture_archivist && cd .. && node --test scripts/check-capture-privacy.test.mjs`
Expected: PASS. The privacy guard now also scans `capture_archivist.rs`, which has no logging yet.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/capture_archivist.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): archivist pass that writes, verifies, indexes and only then acks extension captures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: The loopback HTTP remote — about 25 min

**Files:**
- Modify: `desktop/src-tauri/src/chat_archive.rs` (`HttpRemote::call`, `read_json`)
- Modify: `desktop/src-tauri/src/capture_archivist.rs` (HTTP impl, HTTP tests)

**Interfaces:**
- Consumes: `HttpRemote::new(base, token)` (loopback-only, no redirects).
- Produces: `pub(crate) fn HttpRemote::call(&self, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<Value, RemoteError>` and `pub(crate) fn HttpRemote::call_capped(&self, method, path, body, timeout, cap: u64) -> Result<Value, RemoteError>`; `impl CaptureRemote for HttpRemote`.

- [ ] **Step 1: Write the failing HTTP tests**

Append inside `mod tests` of `capture_archivist.rs`, before its closing `}`:

```rust
    use crate::chat_archive::HttpRemote;
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    type Seen = Arc<Mutex<Vec<(String, String, Value)>>>;

    /// A loopback server with one canned reply per (method, path); it records every request.
    fn serve(replies: Vec<(&'static str, String, u16, Value)>) -> (String, Seen) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for conn in l.incoming() {
                let Ok(mut conn) = conn else { break };
                let mut r = BufReader::new(conn.try_clone().unwrap());
                let mut line = String::new();
                if r.read_line(&mut line).is_err() {
                    continue;
                }
                let mut p = line.split_whitespace();
                let (method, path) = (p.next().unwrap_or("").to_string(), p.next().unwrap_or("").to_string());
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; len];
                let _ = r.read_exact(&mut body);
                log.lock().unwrap().push((method.clone(), path.clone(), serde_json::from_slice(&body).unwrap_or(Value::Null)));
                let (status, v) = replies
                    .iter()
                    .find(|(m, pth, ..)| *m == method && *pth == path)
                    .map(|(_, _, s, v)| (*s, v.clone()))
                    .unwrap_or((404, json!({"error": {"code": "NOT_FOUND"}})));
                let b = v.to_string();
                let _ = conn.write_all(format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len()).as_bytes());
            }
        });
        (url, seen)
    }

    fn core_replies(ack_status: u16) -> Vec<(&'static str, String, u16, Value)> {
        let hash = "a".repeat(64);
        vec![
            ("GET", "/kb/live/unacked".into(), 200, json!({"sessions": [{"sessionId": "cap-h", "meetingTitle": "Standup", "startedAt": 1, "captionCount": 2, "lines": 2, "hash": hash, "durable": true, "source": "memory"}]})),
            ("GET", "/kb/live/cap-h/capture".into(), 200, json!({"sessionId": "cap-h", "title": "Standup", "startedAt": 1_762_335_000_000i64, "durationSec": 60, "language": "en", "lines": 2, "hash": hash,
                "rows": [{"time": "09:30:01", "speaker": "Ana", "text": "Hello."}, {"time": "09:31:01", "speaker": "Ben", "text": "Hi."}]})),
            ("POST", "/kb/index/notes".into(), 200, json!({"upserted": 1})),
            ("POST", "/kb/live/cap-h/ack".into(), ack_status, json!({"sessionId": "cap-h", "state": "acked", "ackedAt": "2026-11-07T00:00:00.000Z", "idempotent": false})),
        ]
    }

    #[test]
    fn archives_over_loopback_http() {
        let (url, seen) = serve(core_replies(200));
        let remote = HttpRemote::new(&url, "tok").unwrap();
        let root = scratch("http");
        assert_eq!(Archivist::default().tick(&remote, &root, &|| true).unwrap().archived, 1);
        let seen = seen.lock().unwrap();
        let ack = seen.iter().find(|(m, p, _)| m == "POST" && p == "/kb/live/cap-h/ack").unwrap();
        assert_eq!(ack.2["hash"], json!("a".repeat(64)));
        assert_eq!(ack.2["lines"], json!(2));
        let key = ack.2["noteKey"].as_str().unwrap();
        assert!(root.join(key).exists());
        let ix = seen.iter().find(|(m, p, _)| m == "POST" && p == "/kb/index/notes").unwrap();
        assert_eq!(ix.2["notes"][0]["noteKey"], json!(key));
        assert_eq!(ix.2["notes"][0]["kind"], json!("meeting"));
    }

    #[test]
    fn a_refused_ack_keeps_the_note_and_an_auth_error_stops_the_pass() {
        let (url, _) = serve(core_replies(409));
        let root = scratch("http409");
        let r = Archivist::default().tick(&HttpRemote::new(&url, "tok").unwrap(), &root, &|| true).unwrap();
        assert_eq!(r.failed, 1);
        assert_eq!(md_files(&root), 1, "the note stays; the next pass reuses it");
        let (url, _) = serve(vec![("GET", "/kb/live/unacked".into(), 401, json!({"error": {"code": "UNAUTHORIZED"}}))]);
        assert_eq!(Archivist::default().tick(&HttpRemote::new(&url, "tok").unwrap(), &root, &|| true), Err(RemoteError::Unauthorized));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd desktop/src-tauri && cargo test --lib capture_archivist`
Expected: FAIL to compile with `the trait bound HttpRemote: CaptureRemote is not satisfied`.

- [ ] **Step 3: Implement**

In `desktop/src-tauri/src/chat_archive.rs`, replace

```rust
    fn call(&self, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<Value, RemoteError> {
        let url = format!("{}{}", self.base, path);
```

with

```rust
    pub(crate) fn call(&self, method: &str, path: &str, body: Option<&Value>, timeout: Duration) -> Result<Value, RemoteError> {
        self.call_capped(method, path, body, timeout, RESPONSE_MAX)
    }

    /// `call` with its own response cap (a held meeting capture can reach a few MB).
    pub(crate) fn call_capped(&self, method: &str, path: &str, body: Option<&Value>, timeout: Duration, cap: u64) -> Result<Value, RemoteError> {
        let url = format!("{}{}", self.base, path);
```

In the same function, change `Ok(resp) => read_json(resp),` to `Ok(resp) => read_json(resp, cap),` and `let v = read_json(resp).unwrap_or(Value::Null);` to `let v = read_json(resp, cap).unwrap_or(Value::Null);`. Replace

```rust
fn read_json(resp: ureq::Response) -> Result<Value, RemoteError> {
    let mut buf = Vec::new();
    resp.into_reader().take(RESPONSE_MAX).read_to_end(&mut buf).map_err(|_| RemoteError::Unreachable)?;
```

with

```rust
fn read_json(resp: ureq::Response, cap: u64) -> Result<Value, RemoteError> {
    let mut buf = Vec::new();
    resp.into_reader().take(cap).read_to_end(&mut buf).map_err(|_| RemoteError::Unreachable)?;
```

In `desktop/src-tauri/src/capture_archivist.rs`, add after the `use crate::chat_archive::RemoteError;` line:

```rust
use crate::chat_archive::HttpRemote;
use serde_json::json;
```

and add after `impl Archivist { … }`:

```rust
const CALL: Duration = Duration::from_secs(3);
/// A held capture is at most 2,000 lines of at most 2,000 characters (agents/live-sessions.mjs).
const CAPTURE_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct UnackedList {
    sessions: Vec<Unacked>,
}

/// The core's live routes over the host's loopback client (bearer token, no redirects, bounded reads).
/// Ids reach the path only after `valid_capture_id`, so they need no escaping.
impl CaptureRemote for HttpRemote {
    fn unacked(&self) -> Result<Vec<Unacked>, RemoteError> {
        let v = self.call("GET", "/kb/live/unacked", None, CALL)?;
        serde_json::from_value::<UnackedList>(v).map(|l| l.sessions).map_err(|_| RemoteError::Invalid)
    }
    fn capture(&self, id: &str) -> Result<HeldCapture, RemoteError> {
        let v = self.call_capped("GET", &format!("/kb/live/{id}/capture"), None, CALL, CAPTURE_MAX_BYTES)?;
        serde_json::from_value(v).map_err(|_| RemoteError::Invalid)
    }
    fn index(&self, upsert: &IndexUpsert) -> Result<(), RemoteError> {
        self.call("POST", "/kb/index/notes", Some(&json!({ "notes": [upsert] })), CALL).map(|_| ())
    }
    fn ack(&self, id: &str, note_key: &str, hash: &str, lines: usize) -> Result<(), RemoteError> {
        self.call("POST", &format!("/kb/live/{id}/ack"), Some(&json!({ "noteKey": note_key, "hash": hash, "lines": lines })), CALL).map(|_| ())
    }
}
```

In the test module, delete the now-duplicate `use crate::chat_archive::HttpRemote;` and change `use serde_json::{json, Value};` to `use serde_json::Value;` (both now come in through `use super::*`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test --lib capture_archivist && cargo test --lib chat_archive && cargo test --lib chat_cmds`
Expected: PASS, every test (the chat archive keeps its 4 MB cap through `call`).

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/chat_archive.rs desktop/src-tauri/src/capture_archivist.rs
git commit -m "feat(desktop): archivist talks to the verified core over the loopback client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Run it for the signed-in session; spawn the core with `LLMIDE_LIVE_ACK=1` — about 25 min

**Files:**
- Modify: `desktop/src-tauri/src/capture_archivist.rs` (session slot, thread)
- Modify: `desktop/src-tauri/src/chat_cmds.rs` (`ChatService::bind`, `ChatService::unbind`)
- Modify: `desktop/src-tauri/src/core_host.rs` (constant near `SPAWN_PORTS`, `real_launch`, a test in `mod tests`)

**Interfaces:**
- Consumes: `crate::chat_cmds::CoreProvider` (`Arc<dyn Fn() -> Option<String> + Send + Sync>`, resolves `CoreHost::verified_url`), `HttpRemote::new`, `crate::notes_fs::current_root() -> Result<PathBuf, String>`, `Archivist::tick` (Task 4).
- Produces: `pub fn bind(core: CoreProvider, token: &str)`, `pub fn unbind()` (called by `ChatService`); `pub struct Slot` with `new`, `bind`, `unbind`, `generation`, `remote() -> Option<(u64, HttpRemote)>`; `core_host::SPAWNED_CORE_FLAGS`.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` of `capture_archivist.rs`:

```rust
    #[test]
    fn the_slot_binds_rebinds_and_forgets() {
        let s = Slot::new();
        assert!(s.remote().is_none());
        let core: crate::chat_cmds::CoreProvider = Arc::new(|| Some("http://127.0.0.1:1".to_string()));
        s.bind(core.clone(), "tok-1");
        let (g1, _) = s.remote().unwrap();
        s.bind(core, "tok-2");
        let (g2, _) = s.remote().unwrap();
        assert!(g2 > g1, "a refresh starts a new generation, so a running pass stops");
        s.unbind();
        assert!(s.remote().is_none());
        assert!(s.generation() > g2);
        let unverified: crate::chat_cmds::CoreProvider = Arc::new(|| None);
        s.bind(unverified, "tok");
        assert!(s.remote().is_none(), "no verified core, so no credential is sent");
    }
```

Append inside `mod tests` of `core_host.rs`:

```rust
    #[test]
    fn the_spawned_core_holds_extension_captures_for_the_archivist() {
        assert!(SPAWNED_CORE_FLAGS.contains(&("LLMIDE_LIVE_ACK", "1")));
        let host = vec![("LLMIDE_LIVE_ACK".to_string(), "0".to_string())];
        assert!(crate::core_env::scrub(&host, crate::fsutil::Os::Mac).is_empty(), "never taken from the host env");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd desktop/src-tauri && cargo test --lib capture_archivist && cargo test --lib the_spawned_core`
Expected: FAIL to compile with `cannot find struct Slot` and `cannot find value SPAWNED_CORE_FLAGS`.

- [ ] **Step 3: Implement**

In `capture_archivist.rs`, change `use std::time::Duration;` to

```rust
use std::sync::{Mutex, Once};
use std::time::Duration;
```

and add at the end of the file, before `#[cfg(test)]`:

```rust
type Bound = (crate::chat_cmds::CoreProvider, String);

/// The signed-in session the archivist works for. The generation moves on every bind and unbind, so a pass started
/// for one session never writes for the next one. The token lives in memory only.
pub struct Slot {
    inner: Mutex<(u64, Option<Bound>)>,
}

impl Slot {
    pub const fn new() -> Self {
        Self { inner: Mutex::new((0, None)) }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, (u64, Option<Bound>)> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn bind(&self, core: crate::chat_cmds::CoreProvider, token: &str) {
        let mut g = self.lock();
        g.0 += 1;
        g.1 = Some((core, token.to_string()));
    }
    pub fn unbind(&self) {
        let mut g = self.lock();
        g.0 += 1;
        g.1 = None;
    }
    pub fn generation(&self) -> u64 {
        self.lock().0
    }
    /// The remote for the bound session, with the core URL re-resolved now (a restarted core may be on another port);
    /// `None` when signed out or when the core is not the verified one this app spawned.
    pub fn remote(&self) -> Option<(u64, HttpRemote)> {
        let (gen, core, token) = {
            let g = self.lock();
            let (c, t) = g.1.as_ref()?;
            (g.0, c.clone(), t.clone())
        };
        let url = core()?;
        Some((gen, HttpRemote::new(&url, &token).ok()?))
    }
}

static SLOT: Slot = Slot::new();
#[cfg_attr(test, allow(dead_code))]
static STARTED: Once = Once::new();

/// Called by `ChatService::bind` with the session it just verified (`GET /auth/me`). Starts the thread once.
pub fn bind(core: crate::chat_cmds::CoreProvider, token: &str) {
    SLOT.bind(core, token);
    #[cfg(not(test))]
    STARTED.call_once(|| {
        let _ = std::thread::Builder::new().name("llmide-archivist".into()).spawn(run_loop);
    });
}

/// Called by `ChatService::unbind` (sign-out): the token leaves the archivist too.
pub fn unbind() {
    SLOT.unbind();
}

#[cfg_attr(test, allow(dead_code))]
fn run_loop() {
    let mut archivist = Archivist::default();
    loop {
        std::thread::sleep(TICK);
        let Some((gen, remote)) = SLOT.remote() else { continue };
        let Ok(root) = crate::notes_fs::current_root() else { continue }; // no notes folder: captures wait, nothing is acked
        if let Ok(r) = archivist.tick(&remote, &root, &|| SLOT.generation() == gen) {
            if r.archived + r.reused + r.failed > 0 {
                // Counts only: no title, speaker or text ever reaches a log.
                eprintln!("capture archivist: archived {}, reused {}, failed {}, waiting {}", r.archived, r.reused, r.failed, r.waiting);
            }
        }
    }
}
```

In the test module, add `use std::sync::Arc;` if it is not already imported (Task 5 imports `Arc` through `use std::sync::{Arc, Mutex};`).

In `desktop/src-tauri/src/chat_cmds.rs` `ChatService::bind`, directly after the block

```rust
        {
            let mut b = lock(&self.0.bound);
            *b = Some(Bound { user_id: user_id.clone(), token: token.to_string(), core: core.clone(), store: store.clone(), journal_path: journal_path.clone(), shared_with_mac: shared });
        }
```

add

```rust
        // The same verified session archives finished extension captures (capture_archivist.rs).
        crate::capture_archivist::bind(core.clone(), token);
```

and replace

```rust
    pub fn unbind(&self) {
        *lock(&self.0.bound) = None;
    }
```

with

```rust
    pub fn unbind(&self) {
        *lock(&self.0.bound) = None;
        crate::capture_archivist::unbind();
    }
```

In `desktop/src-tauri/src/core_host.rs`, add after the `SPAWN_PORTS` constant:

```rust
/// Fixed env of the core THIS app spawns (never read from the host env). `LLMIDE_LIVE_ACK=1`: a finalized extension
/// capture is held until the desktop archivist (capture_archivist.rs) acks the verified note; without it the extension
/// keeps every draft in `no-ack` and an ack releases nothing. An adopted server keeps its own env.
const SPAWNED_CORE_FLAGS: [(&str, &str); 3] = [("LLMIDE_ENGINE_PREWARM", "0"), ("LLMIDE_BACKUP_INTERVAL_HOURS", "0"), ("LLMIDE_LIVE_ACK", "1")];
```

and in `real_launch` replace

```rust
        .env("LLMIDE_HOST_APPROVAL_KEY", &approval_key)
        .env("LLMIDE_ENGINE_PREWARM", "0")
        .env("LLMIDE_BACKUP_INTERVAL_HOURS", "0");
```

with

```rust
        .env("LLMIDE_HOST_APPROVAL_KEY", &approval_key);
    for (k, v) in SPAWNED_CORE_FLAGS {
        cmd.env(k, v);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd desktop/src-tauri && cargo test --lib capture_archivist && cargo test --lib chat_cmds && cargo test --lib core_host && cargo test --lib core_env && cd ..
npm test
cd .. && node scripts/check-capabilities.mjs --product
```

Expected: PASS. `npm test` includes `check-capture-privacy.test.mjs`: the one `eprintln!` line has no `speaker`, `text`, `value`, `caption` or `row` word. `check-capabilities` is unchanged, because no command was added.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/capture_archivist.rs desktop/src-tauri/src/chat_cmds.rs desktop/src-tauri/src/core_host.rs
git commit -m "feat(desktop): run the capture archivist for the signed-in session and hold captures until acked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Docs: state, invariants and the open reachability blocker — about 20 min

**Files:**
- Modify: `extension/CLAUDE.md:17` (the "Pending the desktop archivist" paragraph)
- Modify: `docs/explanation/invariants.md` (append a section at the end)
- Modify: `docs/kits/capture-kit.md:20-21`
- Modify: `docs/superpowers/MASTER-PLAN.md:457`
- Modify: `docs/superpowers/plans/2026-11-05-desktop-live-capture.md:4350`

**Interfaces:**
- Consumes: the names from Tasks 1 to 6.
- Produces: documentation only.

- [ ] **Step 1: extension/CLAUDE.md**

Replace the sentence that starts `**Pending the desktop archivist:**` and ends `use the "without \`LLMIDE_LIVE_ACK\`" row.` with:

```markdown
**Archivist:** the desktop host (`desktop/src-tauri/src/capture_archivist.rs`) adopts `GET /kb/live/unacked` of the core it spawned (which runs with `LLMIDE_LIVE_ACK=1`), writes and verifies the note, then acks `POST /kb/live/:id/ack`. **Still pending: the extension cannot reach that core.** It accepts only `:3456` (`src/lib/config.ts`, manifest CSP), and the desktop core runs on 3457 to 3459 (plan `docs/superpowers/plans/2026-11-07-desktop-capture-archivist.md`, decision D2). Until D2 is built, the rows marked *(pending archivist)* cannot pass against the desktop; run a server with `LLMIDE_LIVE_ACK` unset and use the "without `LLMIDE_LIVE_ACK`" row.
```

- [ ] **Step 2: docs/explanation/invariants.md**

Append at the end of the file:

```markdown

## Desktop capture archivist (`desktop/src-tauri/src/capture_archivist.rs`)

The host adopts finished extension captures from the core it spawned (`GET /kb/live/unacked`, `GET /kb/live/:id/capture`), writes each one as a meeting note and acks `POST /kb/live/:id/ack`.

### ✅ MUST preserve

- **Ack only a note that read back.** The ack is sent only after `capture_store::finalize` (create without overwrite, read back, frontmatter id and transcript line count verified) or `find_archived` (the same bytes already on disk) returned a note, and only when the held rows equal the `lines` the ack echoes. Tests: `capture_archivist::tests` (`a_failed_write_is_never_acked…`, `rows_that_do_not_match…`).
- **Idempotent by content.** A crash between the write and the ack is repaired by the next pass finding the same note under the same name family (`final_rel` plus `-2` to `-9`), so no second note is written. Test: `a_crash_between_write_and_ack_never_makes_a_second_note`.
- **Credentials only to the verified spawned core,** through the session `ChatService::bind` verified. Every bind and unbind moves the generation, and a pass stops before the next capture when it changes. Test: `the_slot_binds_rebinds_and_forgets`.
- **Bounded:** 5 captures per 20 s pass, 3 attempts per capture per launch, 16 MB per capture response.
- **No capture text in any log** (`desktop/scripts/check-capture-privacy.test.mjs` covers every `capture_*.rs`).
- **The spawned core runs with `LLMIDE_LIVE_ACK=1`** (`core_host::SPAWNED_CORE_FLAGS`), and it is never taken from the host env.

### ❌ DO NOT

- Ack before a verified note exists, or ack with values other than the server's own `lines` and `hash`.
- Let the core write the notes folder: the notes root is the host's (`notes_fs.rs`, chosen by a native dialog and re-validated per call).
- Summarise an archived capture in the background: meeting text goes to a model only from Library's Re-summarise.
```

- [ ] **Step 3: docs/kits/capture-kit.md**

In the "Live routes" row, change `` `:id/ack`, `:id/status`) `` to `` `:id/ack`, `:id/status`, `:id/capture`) ``. In the "Live acknowledge" row, change `kept until the Mac acks when` to `kept until the desktop archivist (\`desktop/src-tauri/src/capture_archivist.rs\`) acks when`, and change `(API v84, v86)` to `(API v84, v86, v116)`.

- [ ] **Step 4: MASTER-PLAN line 457**

Replace the whole line with:

```markdown
- [~] Desktop archivist for extension captures: the desktop host adopts `GET /kb/live/unacked` of its spawned core (`LLMIDE_LIVE_ACK=1`), reads `GET /kb/live/:id/capture`, writes and verifies the note through `capture_store::finalize`, feeds the index and acks (`desktop/src-tauri/src/capture_archivist.rs`, [plan](plans/2026-11-07-desktop-capture-archivist.md)); open: the extension reaches only `:3456` and the desktop core runs on 3457-3459, so a real extension capture does not reach the archivist yet (decision D2 in that plan) (me)
```

- [ ] **Step 5: Desktop live-capture plan, section F**

Replace the bullet that starts `- **Desktop as archivist for extension captures:**` with:

```markdown
- **Desktop as archivist for extension captures:** planned and built in [2026-11-07-desktop-capture-archivist.md](2026-11-07-desktop-capture-archivist.md). The Swift app is gone, so there is no "both apps" rule to decide; the open item is how the extension reaches the desktop core (D2 there).
```

- [ ] **Step 6: Check and commit**

Run: `make docs-check` (it must still exit 0; the new docs cite only paths that exist).

```bash
git add extension/CLAUDE.md docs/explanation/invariants.md docs/kits/capture-kit.md docs/superpowers/MASTER-PLAN.md docs/superpowers/plans/2026-11-05-desktop-live-capture.md
git commit -m "docs: record the desktop capture archivist and the open extension reachability item

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 8: The desktop core on `:3456` so the Chrome extension reaches it (decision D2) — about 30 min

**Why:** the extension only talks to `http://127.0.0.1:3456` (`extension/src/lib/config.ts:16`, `extension/manifest.json`
CSP `connect-src`). The 3457-3459 range existed only to stay clear of the retired Swift app's core on 3456.

**Files:**
- Modify: `desktop/src-tauri/src/core_host.rs` (`SPAWN_PORTS`, the live-port probe, the foreign-core status), its tests
- Modify: `desktop/src-tauri/tauri.conf.json` (`csp` and `devCsp` `connect-src`)
- Modify: `desktop/PACKAGING.md`, `extension/CLAUDE.md` (the capture checklist note), `docs/explanation/invariants.md` if it names the ports

**Requirements (each with a test in `core_host.rs`):**
1. `SPAWN_PORTS` becomes `[3456, 3457, 3458, 3459]`: the desktop spawns its own core on `:3456` first.
2. Before spawning, the existing live-port probe still runs. A server this app did not start that already answers on
   `:3456` is never adopted in a release build and never sent credentials (keep `note_foreign`); the spawn then tries
   3457-3459, and `core_status` reports `foreign_core` plus a new additive `extensionReachable: false`. When the spawned
   core is on `:3456`, `extensionReachable` is `true`.
3. A restart after a crash prefers `:3456` again; a stale socket from the app's own previous core is waited out, not
   reported as foreign (reuse the existing restart wait).
4. CSP `connect-src` in both `csp` and `devCsp`: add `http://127.0.0.1:3456`, keep 3457-3459, and remove the dead
   `ws://127.0.0.1:3006` (the Mac bridge is gone). `npm run check:security` and the CSP test
   (`desktop/scripts/check-csp.test.mjs`) must pass; update its expected list.
5. Check how the extension authenticates to a core (its login flow against `/auth/*` and the JWT it stores) and write in
   `extension/CLAUDE.md` exactly what the user does once to sign the extension in to the desktop's core; if the desktop
   core needs an extra env or CORS entry for the extension's pinned id (`ecojclccfoegmlffpiahbcenmkfhadlk`), add it in
   `core_env.rs` with a test.
6. The Settings screen's server card shows "Chrome extension can connect" / "Chrome extension cannot connect: another
   program uses port 3456" from `extensionReachable` (additive decode in `ui/screens/shell` status model; no new command).

**Gates:** `CARGO_INCREMENTAL=0 cargo test` (whole suite), `cd desktop && npm test && npm run check:security`, and a manual
row in `extension/CLAUDE.md`: with only the desktop running, the extension side panel connects and a capture is archived
as a note (the archivist from Tasks 1-6).

## D. Decisions for the user (secure default first)

| # | Decision | Secure default (what this plan builds) | If the user picks the other option |
|---|---|---|---|
| D1 | Where the archivist runs | **Rust host thread.** It polls the core THIS app spawned and nonce-verified, uses the session the webview already bound (token in memory only), and writes through the existing `capture_store::finalize` writer and verifier | The core writes the notes folder itself. It would need the host-only notes root (chosen by a native dialog, re-validated per call) and a second writer and verifier in Node, and the core cannot prove the user's file read back |
| D2 | How a real extension reaches the desktop core | **Decided by the user 2026-11-07: the desktop core runs on `:3456`** when that port is free (Task 8); a foreign server on `:3456` is still never used or sent credentials, and the desktop then falls back to 3457-3459 and tells the user the extension cannot connect | (b) The extension accepts a user-set `127.0.0.1:3457-3459` — not chosen (wider local-port surface, manifest/CSP change, store review) |
| D3 | `LLMIDE_LIVE_ACK` on the spawned core | **Always `1`, fixed in `core_host`, never from the host env.** A stuck archivist loses nothing: the extension keeps its draft until a verified `acked` | Keep it off until the C4 real-meeting run. The extension then keeps every draft in `no-ack`, and an archivist ack would release nothing |
| D4 | Summary after archiving | **None.** Only Library's Re-summarise sends meeting text to a model | Summarise in the background like the Swift app (text leaves without a click) |
| D5 | Where the note lands | **`notes_fs::current_root()` at pass time** (the open project's `llm-doc`, else the chosen notes folder), the same as a native Stop. With no root the capture waits, unacked | A fixed meetings folder, independent of the open project |
| D6 | Failure visibility | **Counts only on host stderr.** The extension already shows "not confirmed copied" per draft. No new command or UI, and `ui/` is untouched | A `capture_archivist_status` command plus a line on the Live screen (a new capability and a UI task) |
| D7 | Retry budget | **3 attempts per capture per launch, 5 captures per 20 s pass** | Unbounded retries, which can write up to nine `-N` files for a capture whose note never verifies |

## E. Self-review

1. **Spec coverage.**
   - Adopt unacked captures: Tasks 4 and 6.
   - Note in the user's notes folder, verified by read-back: Task 3 (`find_archived`), Task 4 (`finalize`).
   - Ack only after the read-back: Task 4 `archive_one`, tests `a_failed_write…` and `rows_that_do_not_match…`.
   - Idempotent across a crash: Task 3 `find_archived`, Task 4 `a_crash_between…`.
   - Never ack a failed write: Task 4.
   - Per-user scoping: user-scoped core routes (Task 1 test "other user's capture"), plus the session slot generation (Task 6).
   - Bounded per tick: Task 4 `a_pass_is_bounded…`.
   - No new dependency: Global Constraints; only existing crates are used.
   - Runs only while the app runs and only for the signed-in user: Task 6 (thread started on bind, slot cleared on unbind).
   - Capture text never logged: the module name brings the privacy guard over it (Tasks 4 and 6).
   - Reuse of the Rust writer and verifier: Tasks 3 and 4.
   - Index feed with the `makeUpsertInput` shape: `note_of` keeps `finalize`'s `IndexUpsert`, and Task 5 posts `{ notes: [upsert] }`.
   - `LLMIDE_LIVE_ACK` reaching the core: Task 6.
   - The "core never writes the notes folder" question: section A item 8 and D1.
   - Gap stated, not hidden: real-extension reachability (A item 9, D2, Task 7).
2. **Placeholder scan.** No TBD or "add tests" without code. The one conditional step (Task 2 step 1, the schema formatting check) says exactly what to do when the diff is not insert-only. The API version rule says what to do if `main` moved.
3. **Type consistency.**
   - `HeldCapture` (Rust, camelCase) matches the Task 1 response and the Task 2 schema: `sessionId`, `title`, `startedAt`, `durationSec`, `language`, `lines`, `hash`, `rows[{time, speaker, text}]`.
   - `Unacked` reads `sessionId` and `lines` from the existing unacked list.
   - The `ack` body `{noteKey, hash, lines}` matches `routes/live.mjs`.
   - `find_archived`, `utc_times_to_local` and `note_of(m, rows, rel, opened)` are defined in Task 3 and used with those names in Task 4.
   - `CoreProvider` is `crate::chat_cmds::CoreProvider` everywhere.
   - `TickReport` fields are used with the same names in Tasks 4 and 6.
