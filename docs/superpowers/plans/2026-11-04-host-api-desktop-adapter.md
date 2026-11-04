# Host API v1 Desktop Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app serves Host API v1 (the 12 Plan 1 commands and 7 events). It does this from the Node core it already runs, on a loopback-only development listener, with chat turns and approvals going through the core's own Agent v2 engine.

**Architecture:** The gateway lives **inside the Node core** (`extension/`), because the core already runs chat turns in-process, holds user identity and the decision registry, and speaks the v1 schemas through `extension/routes/host-api/commands.generated.mjs`. The Rust host has no WebSocket library and no user token. The core gets a dependency-free RFC 6455 server module, a Node port of the Plan 2 frame codec, session gate, translator and gateway, a hashed per-device token table, and an in-memory pairing PIN. One extracted seam in `extension/routes/agent-v2.mjs` lets a non-HTTP caller run a turn, cancel it and clear a chat; the HTTP path keeps byte-identical behaviour. The Rust host passes the development flag to the core only in a debug build, and desktop Settings gets a card that shows the PIN and lists paired devices.

**Tech Stack:** Node 22 (`node:http`, `node:crypto`, `node:test`), better-sqlite3 migrations, the existing Agent v2 engine and its bench-fake engine, Tauri 2 / Rust for the env pass-through, React for the Settings card.

**Spec:** [`docs/superpowers/specs/2026-11-03-host-api-design.md`](../specs/2026-11-03-host-api-design.md), delivery phase 3: "Desktop v1 adapter: the same surface for every capability the desktop supports; unsupported features are not advertised." Contract: Plan 1 and `schema/host-api/v1/`. Mac reference implementation: Plan 2 [`2026-11-04-host-api-mac-adapter.md`](2026-11-04-host-api-mac-adapter.md) and `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/`.

## Global Constraints

- `apiVersion` is always `1`. A frame is at most 1,048,576 bytes. Lists default to 100 items, maximum 500. Error messages are at most 500 characters (spec "Wire envelope", "Errors").
- Payload objects are closed: unknown fields are rejected with `invalid_payload`. Unknown commands get `unknown_command`; unsupported capabilities get `capability_unavailable`.
- Stable error codes only: `auth_failed`, `capability_unavailable`, `unknown_command`, `invalid_payload`, `not_found`, `busy`, `denied`, `desktop_only`, `rate_limited`, `host_unreachable`, `internal`. Messages never contain tokens or file contents.
- "The desktop gateway uses the same v1 listener rule": v1 default port **3016**, falling back to the next free port (up to 10). "A loopback development build may bind plaintext `ws://127.0.0.1:<port>` when the explicit development flag is set" (spec "Ports and listeners"). **This plan ships only that development listener.** It is plaintext on 127.0.0.1, started only when `LLMIDE_HOST_API_DEV=1` and `NODE_ENV !== 'production'`. The Rust host passes the flag only in a debug build. TLS/WSS, pinning, the Origin allowlist and audit logging are spec phase 6.
- "Pairing PIN is one-use and rotates after a successful pair. Tokens are stored hashed. Pairing attempts are rate-limited with a lockout." "No frame may carry a credential after pairing except `host.auth.token` and the token in `host.auth.revoke`."
- "The gateway never proxies arbitrary URLs and never exposes core internals." "A gateway must not read UI state."
- Same wire behaviour as the Mac host (Plan 2), for cross-host conformance:
  - `host.hello` returns `apiVersions: [1]` and `hostKind: "desktop"`.
  - v2 progress labels have no v1 form; replies are sent as `chat.delta` chunks of at most 100,000 UTF-16 units, then `chat.done`.
  - `host.snapshot` serves the `chat` topic only.
  - A handshake carrying an `Origin` header is refused, except a loopback web-client origin the user listed (decision 6; the Mac listener keeps refusing every `Origin` until it gets the same allowlist).
  - Ids longer than 64 characters are dropped, never truncated.
  - A reused in-flight `chat.send` id gets `busy`.
- Core rules (root `CLAUDE.md`, `extension/CLAUDE.md`):
  - Layering lint at zero: `routes/` may import any Node layer, `kb/` only `core/`.
  - Every state-mutating kb helper takes `userId` first.
  - Append-only migrations.
  - SQLite single writer: one core process only.
  - An HTTP wire change bumps `SERVER_API_VERSION` and `ALL_ENDPOINTS`.
  - The Agent SDK stays lazy-loaded: no engine import on the boot path.
- Desktop rules:
  - A new Tauri command needs `lib.rs` `generate_handler!`, `build.rs` `COMMANDS` and an `allow-*` capability entry (`desktop/scripts/check-capabilities.mjs`).
  - Env reaches the core only through explicit `.env(...)` in `core_host.rs`, never by widening `core_env.rs` `ALLOWED`.
- Conventional Commits, one concern per commit, on `main`, never pushed by the executor (the nightly job pushes). Every commit message ends with the attribution line the session gives.

## Decisions this plan makes (revisit if wrong)

1. **The gateway lives in the Node core, not the Rust host.**
   - In-process, the core can run a turn, answer an approval (`answerDecision`) and read chat history (`getChatSession`) with the right `userId`.
   - The Rust host would need tokio plus tungstenite and a user JWT it does not hold.
   - The WebSocket server is hand-written on `node:http` (about 150 lines and fully tested) to keep the "no framework, minimal dependency" rule.
2. **The phone chat is one dedicated server-side chat per user** (surface `any`, title "Phone chat"), whose id is stored in `host_api_quick_chat`.
   - The desktop has no shared quick chat. Its UI chats live in the host file store, which a gateway must not read.
   - Turns run in mode `auto_read_only` in the extension chat workspace (`extensionChatWorkspace()`), not in a project folder. This is the same read-only posture as the Mac phone chat, which keeps file access off a surface that has no diff view.
   - Showing this chat in the desktop chat list is a follow-up.
3. **Pairing PIN:**
   - Desktop Settings mints a PIN on demand (`POST /host-api/pin`; JWT plus the bus host proof, so only the desktop UI can mint).
   - The PIN is valid for 10 minutes and is one-use; a new one replaces the old.
   - It belongs to the user who minted it, so a paired device acts as that user.
4. **Capabilities:**
   - `host`, `chat` and `approvals` are always served (`agent_chat` is always on).
   - `tool_approvals` is served only when `LLMIDE_HOST_API_TOOL_APPROVALS=1` (default off). This mirrors the Mac's default-OFF Phone Access switch.
   - `chat.history.clear` is refused with `denied` unless `LLMIDE_HOST_API_CHAT_CLEAR=1`. This mirrors the Mac's default-OFF chat-deletion switch.
   - A desktop pref UI for these two flags is a follow-up.
5. **Device ids are host-minted as `h1-<uuid>`**, like the Mac, so a device is recognisable in the Settings list.
6. **The web client runs on localhost for now** (user decision 2026-11-04: a domain and a VPS come later). A browser always sends `Origin`, so the desktop listener cannot simply refuse it as the Mac's does.
   - Instead, an `Origin` is accepted only if it is in `LLMIDE_HOST_API_WEB_ORIGINS`, a comma-separated list of exact origins. Every listed origin must be a loopback origin (`http://localhost:<port>` or `http://127.0.0.1:<port>`); any other entry is ignored and logged at start.
   - The list defaults to empty, which refuses every browser.
   - The production-domain allowlist (`https://<your domain>`) and WSS are phase 6. They arrive with the VPS.

## File Structure

| File | Responsibility |
|---|---|
| `extension/server/ws-server.mjs` (create) | RFC 6455 server side: handshake check and accept, frame read and write, `WsConnection` |
| `scripts/generate-host-api.mjs` (modify) | Also export `HOST_API_ENVELOPE` and `HOST_API_EVENTS` from `commands.generated.mjs` |
| `extension/routes/host-api/frame.mjs` (create) | Node port of the Swift `HostApiFrame`: `parseRequest`, `response`, `event`, `errorFrame`, `clamp` |
| `extension/kb/migrations/0061_host_api_devices.sql` (create) | `host_api_devices`, `host_api_quick_chat` |
| `extension/kb/host-api-devices.mjs` (create) | Hashed device tokens, idle expiry, quick-chat id per user |
| `extension/routes/host-api/pin.mjs` (create) | In-memory PIN per user: mint, consume once |
| `extension/routes/host-api/throttle.mjs` (create) | Per-peer pairing throttle with lockout and a server-wide budget |
| `extension/routes/agent-v2.mjs` (modify) | Extract `startHostTurn`, `cancelChatTurn` and `clearChatSessionState`; the HTTP handlers call the same code |
| `extension/routes/host-api/session.mjs` (create) | Per-connection phase gate and `h1.<session>.<id>` ids (port of Plan 2 Task 5) |
| `extension/routes/host-api/translator.mjs` (create) | Agent v2 engine events to v1 events (delta, done, error, approval, tool approval, cleared) |
| `extension/routes/host-api/gateway.mjs` (create) | Sessions, auth, `rev`, the 12 commands |
| `extension/server/host-api-listener.mjs` (create) | Loopback listener on 3016+ that upgrades only `/host-api/v1` and refuses `Origin` |
| `extension/core/config.mjs`, `extension/server.mjs` (modify) | `config.hostApiDev`; start and stop the listener; three HTTP routes; API 107 |
| `schema/http/host-api.schema.json` + fixtures (create) | Contract for the three routes |
| `desktop/src-tauri/src/core_host.rs` (modify) | Pass `LLMIDE_HOST_API_DEV=1` to the spawned core in a debug build when the host env has it |
| `ui/screens/settings/sections/HostApiPairing.tsx` (create) + registry (modify) | Settings card: PIN, port, paired devices, revoke |
| `extension/tests/host-api-*.test.mjs` (create) | Tests per task |
| `schema/host-api/v1/README.md`, `extension/CLAUDE.md`, `docs/superpowers/MASTER-PLAN.md` (modify) | Docs and plan status |

---

### Task 1: Dependency-free WebSocket server module

**Files:**
- Create: `extension/server/ws-server.mjs`
- Test: `extension/tests/ws-server.test.mjs`

**Interfaces:**
- Produces:
  - `MAX_MESSAGE_BYTES = 1048576`
  - `acceptKey(key: string): string`
  - `handshakeRefusal(req): number | null` (an HTTP status to refuse with, or `null`)
  - `readFrame(buf: Buffer): {fin, opcode, payload: Buffer, size} | null`, which throws `WsError(code)`
  - `encodeFrame(opcode, payload: Buffer): Buffer`
  - `class WsError extends Error { code }`
  - `acceptUpgrade(req, socket, head): WsConnection`
  - `class WsConnection extends EventEmitter` with `send(text)`, `close(code = 1000)`, and events `'message'(text: string)` and `'close'(code)`

- [ ] **Step 1: Write the failing test**

`extension/tests/ws-server.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { acceptKey, handshakeRefusal, readFrame, encodeFrame, WsError, acceptUpgrade, MAX_MESSAGE_BYTES } from '../server/ws-server.mjs';

const mask = (opcode, payload, fin = true) => {
  const key = Buffer.from([1, 2, 3, 4]);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len])
    : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, len >> 8, len & 255]);
  const body = Buffer.from(payload.map((b, i) => b ^ key[i & 3]));
  return Buffer.concat([head, key, body]);
};

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('handshakeRefusal checks upgrade, version and key', () => {
  const ok = { headers: { upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } };
  assert.equal(handshakeRefusal(ok), null);
  assert.equal(handshakeRefusal({ headers: { ...ok.headers, upgrade: 'h2c' } }), 400);
  assert.equal(handshakeRefusal({ headers: { ...ok.headers, 'sec-websocket-version': '8' } }), 426);
  assert.equal(handshakeRefusal({ headers: { ...ok.headers, 'sec-websocket-key': 'short' } }), 400);
});

test('readFrame unmasks, waits for more bytes, and refuses unmasked or oversized frames', () => {
  const f = readFrame(mask(1, Buffer.from('hi')));
  assert.equal(f.opcode, 1); assert.equal(f.payload.toString(), 'hi'); assert.ok(f.fin);
  assert.equal(readFrame(mask(1, Buffer.from('hi')).subarray(0, 3)), null);
  assert.throws(() => readFrame(Buffer.from([0x81, 0x02, 0x68, 0x69])), (e) => e instanceof WsError && e.code === 1002);
  const huge = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0, 0x20, 0, 0, 1, 2, 3, 4]);
  assert.throws(() => readFrame(huge), (e) => e.code === 1009);
  assert.throws(() => readFrame(mask(9, Buffer.alloc(126))), (e) => e.code === 1002, 'control frames are at most 125 bytes');
});

test('encodeFrame writes 7-bit, 16-bit and 64-bit lengths, unmasked', () => {
  assert.deepEqual([...encodeFrame(1, Buffer.from('a'))], [0x81, 1, 0x61]);
  assert.equal(encodeFrame(1, Buffer.alloc(300))[1], 126);
  assert.equal(encodeFrame(1, Buffer.alloc(70_000))[1], 127);
});

test('a real WebSocket client exchanges text, fragmented text, ping and close', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('no global WebSocket client in this Node');
  const server = http.createServer();
  const got = [];
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptUpgrade(req, socket, head);
    conn.on('message', (text) => { got.push(text); conn.send(`echo:${text}`); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  const reply = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send('héllo');
    ws.onmessage = (e) => resolve(e.data);
    ws.onerror = reject;
  });
  assert.equal(reply, 'echo:héllo');
  assert.deepEqual(got, ['héllo']);
  ws.close();
  server.close();
});

test('a connection refuses binary and invalid UTF-8 with the right close codes', async () => {
  const server = http.createServer();
  const codes = [];
  server.on('upgrade', (req, socket, head) => acceptUpgrade(req, socket, head).on('close', (c) => codes.push(c)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  for (const frame of [mask(2, Buffer.from([1])), mask(1, Buffer.from([0xff]))]) {
    await new Promise((resolve) => {
      const req = http.request({ port, host: '127.0.0.1', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('upgrade', (_res, socket) => { socket.write(frame); socket.on('close', resolve); socket.resume(); });
      req.end();
    });
  }
  assert.deepEqual(codes, [1003, 1007]);
  server.close();
  assert.equal(MAX_MESSAGE_BYTES, 1048576);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test tests/ws-server.test.mjs`
Expected: FAIL with `Cannot find module '../server/ws-server.mjs'`.

- [ ] **Step 3: Implement**

`extension/server/ws-server.mjs`:

```js
// Minimal RFC 6455 WebSocket server side (text messages only), dependency-free per the core's
// no-framework rule. Used only by the Host API v1 development listener. Client frames must be masked;
// binary frames, invalid UTF-8, oversize messages and protocol errors close the connection with the
// RFC close code. Messages are capped at MAX_MESSAGE_BYTES (the Host API frame cap).
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE_BYTES = 1048576;

export class WsError extends Error {
  constructor(code) { super(`websocket close ${code}`); this.code = code; }
}

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function handshakeRefusal(req) {
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return 400;
  if (req.headers['sec-websocket-version'] !== '13') return 426;
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return 400;
  return null;
}

export function readFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const rsv = buf[0] & 0x70;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (rsv) throw new WsError(1002);
  if (!masked) throw new WsError(1002);
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_MESSAGE_BYTES)) throw new WsError(1009);
    len = Number(big); off = 10;
  }
  if (len > MAX_MESSAGE_BYTES) throw new WsError(1009);
  if (opcode >= 8 && (len > 125 || !fin)) throw new WsError(1002);
  if (buf.length < off + 4 + len) return null;
  const key = buf.subarray(off, off + 4);
  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ key[i & 3];
  return { fin, opcode, payload, size: off + 4 + len };
}

export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    this.partBytes = 0;
    this.closed = false;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish(1006));
    socket.on('error', () => this.#finish(1006));
  }

  send(text) {
    if (this.closed) return;
    this.socket.write(encodeFrame(1, Buffer.from(String(text), 'utf8')));
  }

  close(code = 1000) {
    if (this.closed) return;
    const body = Buffer.alloc(2); body.writeUInt16BE(code, 0);
    this.socket.write(encodeFrame(8, body));
    this.socket.end();
    this.#finish(code);
  }

  #finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const f = readFrame(this.buffer);
        if (!f) return;
        this.buffer = this.buffer.subarray(f.size);
        this.#onFrame(f);
        if (this.closed) return;
      }
    } catch (err) {
      this.close(err instanceof WsError ? err.code : 1011);
    }
  }

  #onFrame({ fin, opcode, payload }) {
    if (opcode === 9) { this.socket.write(encodeFrame(10, payload)); return; }
    if (opcode === 10) return;
    if (opcode === 8) { this.close(1000); return; }
    if (opcode === 2) throw new WsError(1003);
    if (opcode === 1) {
      if (this.parts.length) throw new WsError(1002);
    } else if (opcode === 0) {
      if (!this.parts.length) throw new WsError(1002);
    } else {
      throw new WsError(1002);
    }
    this.partBytes += payload.length;
    if (this.partBytes > MAX_MESSAGE_BYTES) throw new WsError(1009);
    this.parts.push(payload);
    if (!fin) return;
    const whole = Buffer.concat(this.parts);
    this.parts = []; this.partBytes = 0;
    let text;
    try { text = utf8.decode(whole); } catch { throw new WsError(1007); }
    this.emit('message', text);
  }
}

export function acceptUpgrade(req, socket, head) {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const conn = new WsConnection(socket);
  if (head && head.length) socket.emit('data', head);
  return conn;
}
```

`acceptUpgrade` assumes the caller already ran `handshakeRefusal` (Task 7 does that). The test's real-client case exercises the handshake path.

- [ ] **Step 4: Run the tests and the layering lint**

Run: `cd extension && node --test tests/ws-server.test.mjs && npx eslint server/ws-server.mjs`
Expected: 6 tests pass (the real-client test may skip on a Node without a global `WebSocket`), and ESLint reports 0 problems. The real-client tests bind 127.0.0.1; run unsandboxed if local binding is blocked.

- [ ] **Step 5: Commit**

```bash
git add extension/server/ws-server.mjs extension/tests/ws-server.test.mjs
git commit -m "feat(server): add a minimal RFC 6455 server for the Host API listener"
```

---

### Task 2: Generated envelope and event schemas, and the Node frame codec

**Files:**
- Modify: `scripts/generate-host-api.mjs` (the `js` template)
- Generated: `extension/routes/host-api/commands.generated.mjs`
- Create: `extension/routes/host-api/frame.mjs`
- Test: `extension/tests/host-api-frame.test.mjs`

**Interfaces:**
- Consumes: `validate(schema, value, opts, path)` from `extension/routes/bus/schema-validate.mjs` (own-property lookups; keywords type, enum, const, required, properties, additionalProperties, items, min/maxItems, min/maxLength, pattern, minimum/maximum, oneOf, `$ref` via `opts.defs`).
- Produces:
  - Generated exports `HOST_API_ENVELOPE` and `HOST_API_EVENTS` (the parsed `envelope.schema.json` and `events.schema.json`).
  - `frame.mjs`, matching the Swift `HostApiFrame` in behaviour and message templates:
    - `parseRequest(text: string): {ok: true, id, command, payload} | {ok: false, replyTo: string|null, code, message}`
    - `response(replyTo, command, result, rev): string`, which throws `{code: 'internal'}` on an invalid result
    - `event(command, payload, rev, replyTo?): string`, which throws on an invalid event
    - `errorFrame({replyTo, code, message, retryable, retryAfterMs?, hint?, rev}): string` (never throws)
    - `clamp(s, maxUnits): string`, where units are UTF-16 code units, as in JS `.length`, cut on code-point boundaries

- [ ] **Step 1: Extend the generator**

In `scripts/generate-host-api.mjs`, before the `js` template, read the two schemas. Then add two exports to the `js` template after `HOST_API_SCHEMAS`:

```js
const envelopeSchema = JSON.parse(readFileSync(join(ROOT, "schema/host-api/v1/envelope.schema.json"), "utf8"));
const eventsSchema = JSON.parse(readFileSync(join(ROOT, "schema/host-api/v1/events.schema.json"), "utf8"));
```

```js
export const HOST_API_ENVELOPE = Object.freeze(${JSON.stringify(envelopeSchema)});
export const HOST_API_EVENTS = Object.freeze(${JSON.stringify(eventsSchema)});
```

If Task 1 of Plan 2 already defines `readSchema`, reuse it. Run `node scripts/generate-host-api.mjs && node scripts/generate-host-api.mjs --check`.

- [ ] **Step 2: Write the failing test**

`extension/tests/host-api-frame.test.mjs` reads the same fixtures and expectation map as the Swift tests:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest, response, event, errorFrame, clamp } from '../routes/host-api/frame.mjs';
import { validate } from '../routes/bus/schema-validate.mjs';
import { HOST_API_ENVELOPE } from '../routes/host-api/commands.generated.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../schema/host-api/v1/fixtures');
const read = (p) => readFileSync(join(DIR, p), 'utf8');
const defs = HOST_API_ENVELOPE.$defs;

test('every valid request fixture parses', () => {
  const r = parseRequest(read('valid/request.json'));
  assert.equal(r.ok, true);
  assert.equal(r.command, JSON.parse(read('valid/request.json')).command);
});

test('refusals carry the same codes and message templates as the Mac host', () => {
  assert.equal(parseRequest(' '.repeat(1048577)).code, 'invalid_payload');
  assert.equal(parseRequest('not json').code, 'invalid_payload');
  const unknownField = parseRequest('{"apiVersion":1,"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1,"surprise":true}');
  assert.deepEqual(unknownField, { ok: false, replyTo: 'c-1', code: 'invalid_payload', message: 'The frame does not match the Host API envelope (.surprise).' });
  const unknown = parseRequest('{"apiVersion":1,"id":"c-2","type":"request","command":"files.write","payload":{},"ts":1}');
  assert.equal(unknown.code, 'unknown_command'); assert.equal(unknown.replyTo, 'c-2');
  const bad = parseRequest('{"apiVersion":1,"id":"c-3","type":"request","command":"chat.send","payload":{"text":""},"ts":1}');
  assert.deepEqual(bad, { ok: false, replyTo: 'c-3', code: 'invalid_payload', message: 'The payload does not match chat.send (.text).' });
  const longKey = parseRequest(`{"apiVersion":1,"id":"c-4","type":"request","command":"host.ping","payload":{},"ts":1,"${'k'.repeat(2000)}":1}`);
  assert.ok(longKey.message.length <= 500);
});

test('every invalid command fixture is refused with invalid_payload', () => {
  const cases = JSON.parse(read('invalid-cases.json')).commands;
  for (const [file, c] of Object.entries(cases)) {
    if (c.kind !== 'request') continue;
    const frame = JSON.stringify({ apiVersion: 1, id: 'c-9', type: 'request', command: c.command, payload: JSON.parse(read(`invalid/commands/${file}`)), ts: 1 });
    assert.equal(parseRequest(frame).code, 'invalid_payload', file);
  }
});

test('response, event and error frames validate; bad results and events throw internal', () => {
  const r = JSON.parse(response('c-1', 'host.ping', {}, 3));
  assert.deepEqual(validate(defs.Response, r, { defs }), []);
  assert.equal(r.rev, 3);
  assert.throws(() => response('c-1', 'host.auth.pair', { capabilities: [], token: 'short' }, 0), (e) => e.code === 'internal');
  const e = JSON.parse(event('chat.delta', { text: 'hi' }, 9, 'c-7'));
  assert.deepEqual(validate(defs.Event, e, { defs }), []);
  assert.throws(() => event('chat.delta', { text: 'x'.repeat(100001) }, 1), (err) => err.code === 'internal');
  const long = JSON.parse(errorFrame({ replyTo: 'c-1', code: 'denied', message: 'é'.repeat(900), retryable: false, rev: 1 }));
  assert.deepEqual(validate(defs.ErrorFrame, long, { defs }), []);
  const odd = JSON.parse(errorFrame({ replyTo: null, code: 'nope', message: '', retryable: true, retryAfterMs: 500, rev: 1 }));
  assert.equal(odd.error.code, 'internal'); assert.equal(odd.error.details.retryAfterMs, 500);
});

test('clamp cuts on code-point boundaries within the UTF-16 cap', () => {
  assert.equal(clamp('😀😀😀', 5), '😀😀');
  assert.equal(clamp('abc', 10), 'abc');
});

test('fixture directories are all exercised', () => {
  assert.ok(readdirSync(join(DIR, 'invalid/commands')).length > 0);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd extension && node --test tests/host-api-frame.test.mjs`
Expected: FAIL, `Cannot find module '../routes/host-api/frame.mjs'`.

- [ ] **Step 4: Implement**

`extension/routes/host-api/frame.mjs`. It is a port of `ios_app/SharedProtocol/Sources/SharedProtocol/HostApiFrame.swift`, so read that file and keep the message templates byte-identical:

```js
// Host API v1 frame codec for the desktop host — the Node twin of SharedProtocol's HostApiFrame.swift.
// Same refusal codes and message templates, so the Mac and desktop hosts answer the same frames alike.
// Messages name schema paths (clamped, possibly a frame key), never a value.
import { randomUUID } from 'node:crypto';
import { validate } from '../bus/schema-validate.mjs';
import { HOST_API_COMMANDS, HOST_API_ENVELOPE, HOST_API_EVENTS, HOST_API_LIMITS, HOST_API_SCHEMAS } from './commands.generated.mjs';

const defs = HOST_API_ENVELOPE.$defs;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODES = new Set(['auth_failed', 'capability_unavailable', 'unknown_command', 'invalid_payload', 'not_found', 'busy', 'denied', 'desktop_only', 'rate_limited', 'host_unreachable', 'internal']);

export function clamp(s, maxUnits) {
  if (s.length <= maxUnits) return s;
  let out = '';
  for (const cp of s) {
    if (out.length + cp.length > maxUnits) break;
    out += cp;
  }
  return out;
}

const fail = (replyTo, code, message) => ({ ok: false, replyTo, code, message });
const internal = (message) => Object.assign(new Error(message), { code: 'internal' });

export function parseRequest(text) {
  if (Buffer.byteLength(text, 'utf8') > HOST_API_LIMITS.maxFrameBytes) return fail(null, 'invalid_payload', 'The frame is larger than 1 MiB.');
  let obj;
  try { obj = JSON.parse(text); } catch { obj = null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail(null, 'invalid_payload', 'The frame is not a JSON object.');
  const replyTo = typeof obj.id === 'string' && ID_RE.test(obj.id) ? obj.id : null;
  const env = validate(defs.Request, obj, { defs });
  if (env.length) return fail(replyTo, 'invalid_payload', `The frame does not match the Host API envelope (${clamp(env[0].path, 80)}).`);
  if (!Object.hasOwn(HOST_API_COMMANDS, obj.command)) return fail(replyTo, 'unknown_command', 'This host does not serve that command.');
  const payload = obj.payload ?? {};
  const bad = validate(HOST_API_SCHEMAS[obj.command].request, payload, { defs });
  if (bad.length) return fail(replyTo, 'invalid_payload', `The payload does not match ${obj.command} (${clamp(bad[0].path, 80)}).`);
  if (!replyTo) return fail(null, 'invalid_payload', 'The frame does not match the Host API envelope (.id).');
  return { ok: true, id: replyTo, command: obj.command, payload };
}

function finish(frame, def) {
  const errs = validate(defs[def], frame, { defs });
  if (errs.length) throw internal(`The host built an invalid ${def} frame (${errs[0].path}).`);
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, 'utf8') > HOST_API_LIMITS.maxFrameBytes) throw internal('The host built a frame larger than 1 MiB.');
  return text;
}

export function response(replyTo, command, result, rev, now = Date.now()) {
  const errs = validate(HOST_API_SCHEMAS[command].result, result, { defs });
  if (errs.length) throw internal(`The host built an invalid ${command} result (${errs[0].path}).`);
  return finish({ apiVersion: 1, id: `h-${randomUUID()}`, replyTo, type: 'response', command, result, ts: now, rev }, 'Response');
}

export function event(command, payload, rev, replyTo = null, now = Date.now()) {
  const frame = { apiVersion: 1, id: `h-${randomUUID()}`, type: 'event', command, payload, ts: now, rev };
  if (replyTo) frame.replyTo = replyTo;
  const errs = validate(HOST_API_EVENTS, frame, { defs });
  if (errs.length) throw internal(`The host built an invalid ${command} event (${errs[0].path}).`);
  return finish(frame, 'Event');
}

export function errorFrame({ replyTo, code, message, retryable, retryAfterMs, hint, rev, now = Date.now() }) {
  const error = { code: CODES.has(code) ? code : 'internal', message: clamp(message || 'The host could not handle this request.', 500), retryable: !!retryable };
  const details = {};
  if (retryAfterMs != null) details.retryAfterMs = Math.max(0, Math.trunc(retryAfterMs));
  if (hint) details.hint = clamp(hint, 500);
  if (Object.keys(details).length) error.details = details;
  const frame = { apiVersion: 1, id: `h-${randomUUID()}`, type: 'error', error, ts: now, rev: Math.max(0, rev | 0) };
  if (replyTo && ID_RE.test(replyTo)) frame.replyTo = replyTo;
  return JSON.stringify(frame);
}
```

Check `envelope.schema.json`'s `ErrorFrame`/`Error` `$defs` and match them field for field (Plan 2 Task 3 confirmed no extra fields). `routes/host-api/` is under `routes/`, so importing `routes/bus/` is allowed by the layering lint.

- [ ] **Step 5: Run the tests, the drift gate and the lint**

Run: `cd extension && node --test tests/host-api-frame.test.mjs tests/host-api-contract.test.mjs && cd .. && node scripts/generate-host-api.mjs --check && make host-api-check && cd extension && npx eslint routes/host-api`
Expected: all pass, and `conformance-host-api: ok (12 commands, 7 events)`.

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-host-api.mjs extension/routes/host-api/commands.generated.mjs extension/routes/host-api/frame.mjs extension/tests/host-api-frame.test.mjs
git commit -m "feat(host-api): parse and build v1 frames in the Node core"
```

---

### Task 3: Device tokens, quick-chat id, pairing PIN and throttle

**Files:**
- Create: `extension/kb/migrations/0061_host_api_devices.sql`
- Create: `extension/kb/host-api-devices.mjs`
- Create: `extension/routes/host-api/pin.mjs`, `extension/routes/host-api/throttle.mjs`
- Modify: `extension/kb/db.mjs` (per-user table list for user deletion, near lines 1029–1042)
- Test: `extension/tests/host-api-devices.test.mjs`

**Interfaces:**
- Produces from `kb/host-api-devices.mjs`:
  - `issueDeviceToken(userId, name, now = Date.now()) -> {deviceId, token}`
  - `authenticateDeviceToken(token, now = Date.now()) -> {userId, deviceId} | null`
  - `revokeDevice(userId, deviceId) -> boolean`
  - `listDevices(userId) -> [{deviceId, name, pairedAt, lastSeenAt}]` (no hashes)
  - `getQuickChatId(userId) -> string | null`
  - `setQuickChatId(userId, chatSessionId)`
  - `MAX_DEVICES_PER_USER = 20`
  - `MAX_IDLE_MS = 30 * 24 * 3600 * 1000`
- Produces from `pin.mjs`:
  - `mintPin(userId, now = Date.now()) -> {pin, expiresAt}` (6 digits, 10 minutes, replaces that user's previous PIN)
  - `consumePin(pin, now = Date.now()) -> userId | null` (one use; constant-time compare)
  - `PIN_TTL_MS = 600000`
  - `__resetPinsForTest()`
- Produces from `throttle.mjs`:
  - `class PairingThrottle` with `decision(peer, now) -> {kind: 'allow'} | {kind: 'wait', ms} | {kind: 'lockedOut', ms} | {kind: 'serverThrottled', ms}`, `failure(peer, now)` and `success(peer)`

- [ ] **Step 1: Write the migration**

Open `extension/kb/migrations/0060_ical_sources.sql` first and copy its `user_id` column type and foreign-key/`ON DELETE` pattern exactly. Then `0061_host_api_devices.sql`:

```sql
-- Host API v1 (desktop host): paired devices with hashed tokens, and each user's phone chat.
CREATE TABLE host_api_devices (
  user_id      <same type as 0060's user_id> NOT NULL,
  device_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  paired_at    INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
CREATE TABLE host_api_quick_chat (
  user_id         <same type as 0060's user_id> PRIMARY KEY,
  chat_session_id TEXT NOT NULL
);
```

Replace `<same type…>` with the real type, and add the same foreign-key clause 0060 uses. Add both tables to the per-user deletion list in `kb/db.mjs`.

- [ ] **Step 2: Write the failing test**

`extension/tests/host-api-devices.test.mjs`:

```js
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerUser } = await import('../server/users.mjs');
const dev = await import('../kb/host-api-devices.mjs');
const pins = await import('../routes/host-api/pin.mjs');
const { PairingThrottle } = await import('../routes/host-api/throttle.mjs');

const user = async (n) => (await registerUser({ email: `h1-${n}-${Date.now()}@x.test`, password: 'pw-123456789' })).id;

test('a device token authenticates exactly its device; nothing stores the token', async () => {
  const u = await user('a');
  const { deviceId, token } = dev.issueDeviceToken(u, 'web');
  assert.match(deviceId, /^h1-[0-9a-f-]{36}$/);
  assert.ok(token.length >= 40);
  assert.deepEqual(dev.authenticateDeviceToken(token), { userId: u, deviceId });
  assert.equal(dev.authenticateDeviceToken(token + 'x'), null);
  assert.equal(dev.authenticateDeviceToken(''), null);
  assert.ok(!JSON.stringify(dev.listDevices(u)).includes(token));
});

test('revoke and idle expiry retire a token', async () => {
  const u = await user('b');
  const a = dev.issueDeviceToken(u, 'web', 0);
  assert.equal(dev.authenticateDeviceToken(a.token, dev.MAX_IDLE_MS + 1), null, 'idle too long');
  assert.equal(dev.listDevices(u).length, 0, 'an expired device is forgotten');
  const b = dev.issueDeviceToken(u, 'web');
  assert.equal(dev.revokeDevice(u, b.deviceId), true);
  assert.equal(dev.authenticateDeviceToken(b.token), null);
});

test('a user keeps at most 20 devices, the least recently seen evicted', async () => {
  const u = await user('c');
  const first = dev.issueDeviceToken(u, 'd0', 1);
  for (let i = 1; i <= 20; i++) dev.issueDeviceToken(u, `d${i}`, 1 + i);
  assert.equal(dev.listDevices(u).length, 20);
  assert.equal(dev.authenticateDeviceToken(first.token), null);
});

test('the quick chat id is per user', async () => {
  const u = await user('d');
  assert.equal(dev.getQuickChatId(u), null);
  dev.setQuickChatId(u, 'chat-1');
  assert.equal(dev.getQuickChatId(u), 'chat-1');
});

test('a PIN is six digits, one-use, per user and expires', () => {
  pins.__resetPinsForTest();
  const { pin } = pins.mintPin('u1', 0);
  assert.match(pin, /^[0-9]{6}$/);
  assert.equal(pins.consumePin('000000x', 1), null);
  assert.equal(pins.consumePin(pin, 1), 'u1');
  assert.equal(pins.consumePin(pin, 2), null, 'one use');
  const late = pins.mintPin('u2', 0).pin;
  assert.equal(pins.consumePin(late, pins.PIN_TTL_MS + 1), null, 'expired');
  const old = pins.mintPin('u3', 0).pin;
  pins.mintPin('u3', 1);
  assert.equal(pins.consumePin(old, 2), null, 'a new PIN replaces the old one');
});

test('the throttle locks a peer out after repeated failures and has a server-wide budget', () => {
  const t = new PairingThrottle();
  for (let i = 0; i < 5; i++) { assert.equal(t.decision('p', i * 2000).kind === 'lockedOut', false); t.failure('p', i * 2000); }
  assert.equal(t.decision('p', 10_000).kind, 'lockedOut');
  t.success('q');
  const s = new PairingThrottle();
  for (let i = 0; i < 30; i++) s.failure(`peer-${i}`, 0);
  assert.equal(s.decision('fresh', 1).kind, 'serverThrottled');
});
```

Set `NODE_TEST_CONTEXT` the way the other kb tests do so the temp-DB isolation applies (see `core/config.mjs:131`). Copy the header of an existing kb test such as `tests/ical-store.test.mjs` if one exists. Check `registerUser`'s real signature in `server/users.mjs` and adjust the call.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd extension && node --test tests/host-api-devices.test.mjs`
Expected: FAIL, `Cannot find module '../kb/host-api-devices.mjs'`.

- [ ] **Step 4: Implement**

`extension/kb/host-api-devices.mjs`, following the `kb/ical-store.mjs` patterns (`requireUser`, `getDb().prepare`, scoped by `user_id`):

```js
// Host API v1 paired devices (desktop host). Only SHA-256 hashes of tokens are stored; a token is
// shown once, at pairing. Lookup is by hash (a unique index), so the token itself never touches SQL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './db.mjs';
// import requireUser the way kb/ical-store.mjs does

export const MAX_DEVICES_PER_USER = 20;
export const MAX_IDLE_MS = 30 * 24 * 3600 * 1000;
const hash = (token) => createHash('sha256').update(token).digest('hex');

export function issueDeviceToken(userId, name, now = Date.now()) {
  requireUser(userId);
  const deviceId = `h1-${randomUUID()}`;
  const token = randomBytes(32).toString('base64url');
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT INTO host_api_devices (user_id, device_id, name, token_hash, paired_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, deviceId, String(name || 'Device').slice(0, 120), hash(token), now, now);
    const extra = db.prepare('SELECT device_id FROM host_api_devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?')
      .all(userId, MAX_DEVICES_PER_USER);
    for (const r of extra) db.prepare('DELETE FROM host_api_devices WHERE user_id = ? AND device_id = ?').run(userId, r.device_id);
  })();
  return { deviceId, token };
}

export function authenticateDeviceToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const db = getDb();
  const row = db.prepare('SELECT user_id, device_id, last_seen_at FROM host_api_devices WHERE token_hash = ?').get(hash(token));
  if (!row) return null;
  if (now - row.last_seen_at > MAX_IDLE_MS) {
    db.prepare('DELETE FROM host_api_devices WHERE user_id = ? AND device_id = ?').run(row.user_id, row.device_id);
    return null;
  }
  db.prepare('UPDATE host_api_devices SET last_seen_at = ? WHERE user_id = ? AND device_id = ?').run(now, row.user_id, row.device_id);
  return { userId: row.user_id, deviceId: row.device_id };
}

export function revokeDevice(userId, deviceId) {
  requireUser(userId);
  return getDb().prepare('DELETE FROM host_api_devices WHERE user_id = ? AND device_id = ?').run(userId, deviceId).changes > 0;
}

export function listDevices(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT device_id, name, paired_at, last_seen_at FROM host_api_devices WHERE user_id = ? ORDER BY last_seen_at DESC')
    .all(userId).map((r) => ({ deviceId: r.device_id, name: r.name, pairedAt: r.paired_at, lastSeenAt: r.last_seen_at }));
}

export function getQuickChatId(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT chat_session_id FROM host_api_quick_chat WHERE user_id = ?').get(userId)?.chat_session_id ?? null;
}

export function setQuickChatId(userId, chatSessionId) {
  requireUser(userId);
  getDb().prepare('INSERT INTO host_api_quick_chat (user_id, chat_session_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET chat_session_id = excluded.chat_session_id')
    .run(userId, chatSessionId);
}
```

The test relies on `last_seen_at`-ordered eviction keeping the newest 20, so `OFFSET 20` deletes the 21st and older.

`extension/routes/host-api/pin.mjs`:

```js
// Host API v1 pairing PIN (desktop host): minted by the desktop UI for the signed-in user, one use,
// 10 minutes, one live PIN per user. In memory only: a core restart retires every PIN.
import { randomInt, timingSafeEqual } from 'node:crypto';

export const PIN_TTL_MS = 600_000;
const pins = new Map(); // userId -> { pin, expiresAt }

export function mintPin(userId, now = Date.now()) {
  const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const entry = { pin, expiresAt: now + PIN_TTL_MS };
  pins.set(userId, entry);
  return { ...entry };
}

export function consumePin(pin, now = Date.now()) {
  if (typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin)) return null;
  let match = null;
  for (const [userId, e] of pins) {
    const same = timingSafeEqual(Buffer.from(e.pin), Buffer.from(pin));
    if (same && e.expiresAt >= now) match = userId;
    if (e.expiresAt < now) pins.delete(userId);
  }
  if (match !== null) pins.delete(match);
  return match;
}

export function __resetPinsForTest() { pins.clear(); }
```

`extension/routes/host-api/throttle.mjs` is a port of `mac/Sources/LlmIdeMac/Features/MobileControl/Services/PairingThrottle.swift`. Read it and keep its constants: per-peer escalating waits, lockout after its failure count for 15 minutes, and a server-wide failure budget per window. Expose `decision`, `failure` and `success` as specified above. If the Swift constants differ from the test's assumptions (5 failures to lockout, 30 server-wide), make the test follow the Swift constants and note it in the report. On loopback every peer is `127.0.0.1`, so bad-token failures share the lockout. Unlike the Mac, also consult `decision` before checking a token (the Plan 2 final review's minor).

- [ ] **Step 5: Run the tests and the lint**

Run: `cd extension && node --test tests/host-api-devices.test.mjs && npx eslint kb/host-api-devices.mjs routes/host-api`
Expected: 6 tests pass and 0 lint problems.

- [ ] **Step 6: Commit**

```bash
git add extension/kb/migrations/0061_host_api_devices.sql extension/kb/host-api-devices.mjs extension/kb/db.mjs \
  extension/routes/host-api/pin.mjs extension/routes/host-api/throttle.mjs extension/tests/host-api-devices.test.mjs
git commit -m "feat(host-api): store paired devices hashed and mint one-use pairing PINs"
```

---

### Task 4: Extract the in-process turn seam from Agent v2

**Files:**
- Modify: `extension/routes/agent-v2.mjs`
- Test: `extension/tests/agent-v2-host-turn.test.mjs`

**Interfaces:**
- Produces, all exported from `routes/agent-v2.mjs`:
  - `startHostTurn({userId, chatSessionId, message, files = [], onEvent, deps}) -> Promise<void>`
    - Runs one turn exactly as `POST /agent/v2/stream` would: mode `auto_read_only`, the default provider, workspace `extensionChatWorkspace()`, no Bypass, `surface: 'host-api'` in `agentContext`.
    - Delivers every engine event object (the same objects the SSE writer sends) to `onEvent`.
    - Resolves when the turn ends.
    - Rejects with `Object.assign(new Error(…), {code})`, where `code` is `TURN_IN_PROGRESS`, `SDK_UPDATING`, `PLUGIN_UPDATING`, `SESSION_TOKEN_LIMIT` or `ROUTE_UNAVAILABLE`, for the refusals the route answers with 409, 503 or 402.
  - `cancelChatTurn(userId, chatSessionId) -> boolean`, the same as `handleV2Cancel`'s core.
  - `clearChatSessionState(userId, chatSessionId) -> {cleared: boolean}`, the same sequence as `handleV2SessionDelete`:
    - It runs `deleteAgentSession`, then `deleteSdkTranscripts`, then `deleteSessionMemory`, then `deleteRoute`, and also `clearChatMessages`.
    - It returns `{cleared: false}` while a turn is in flight.

**Required behaviour:**
- `POST /agent/v2/stream`, `/cancel` and `DELETE /agent/v2/session` must stay byte-identical on the wire.
- The extraction moves the `res`-bound parts out of `runV2Stream`, behind a `send(obj)` / `isGone()` pair:
  - SSE headers, `res.write("data: …")`, and `onClientDisconnect`.
  - The HTTP handler passes a `send` that writes SSE and an `isGone` bound to the response. `startHostTurn` passes `send = onEvent` and `isGone = () => false`.
- Every bookkeeping step stays shared and unchanged:
  - the lock (`inFlightChatSessions`, `inFlightAborts`, `inFlightTurns`, synchronous check-and-add);
  - `emitOsEvent('turn-start'/'turn-end')`, `getOrCreateAgentSession`/`bindSdkSession`, `openTurnReplay`, `beginAgentRun`, `recordUsage`, `recordToolEvents`;
  - the refusal checks.

- [ ] **Step 1: Write the failing test**

`extension/tests/agent-v2-host-turn.test.mjs`. Use the existing injectable engine seam: `__setEngineImporterForTest`, or the `deps.runTurn` parameter. Copy the setup of an existing agent-v2 route test (for example `tests/agent-v2-permission-mode.test.mjs`) for DB and user creation.

```js
// header: same env + dynamic imports as tests/agent-v2-permission-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
const v2 = await import('../routes/agent-v2.mjs');

const fakeRun = (events) => async ({ onEvent }) => { for (const e of events) onEvent(e); };

test('startHostTurn delivers the engine events in order and resolves at the end', async () => {
  const userId = await makeUser();
  const got = [];
  await v2.startHostTurn({
    userId, chatSessionId: 'c-host-1', message: 'hi', onEvent: (e) => got.push(e.type),
    deps: { runTurn: fakeRun([{ type: 'init', sessionId: 's-1' }, { type: 'delta', text: 'yo' }, { type: 'result', subtype: 'success', sessionId: 's-1' }]) },
  });
  assert.deepEqual(got.filter((t) => ['init', 'delta', 'result'].includes(t)), ['init', 'delta', 'result']);
});

test('a second host turn on the same chat is refused with TURN_IN_PROGRESS', async () => {
  const userId = await makeUser();
  let release;
  const slow = async ({ onEvent }) => { onEvent({ type: 'init', sessionId: 's' }); await new Promise((r) => { release = r; }); };
  const first = v2.startHostTurn({ userId, chatSessionId: 'c-host-2', message: 'a', onEvent: () => {}, deps: { runTurn: slow } });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(v2.startHostTurn({ userId, chatSessionId: 'c-host-2', message: 'b', onEvent: () => {}, deps: { runTurn: slow } }),
    (e) => e.code === 'TURN_IN_PROGRESS');
  assert.equal(v2.cancelChatTurn(userId, 'c-host-2'), true);
  release(); await first.catch(() => {});
});

test('clearChatSessionState refuses while a turn runs and clears afterwards', async () => {
  const userId = await makeUser();
  let release;
  const slow = async ({ onEvent }) => { onEvent({ type: 'init', sessionId: 's' }); await new Promise((r) => { release = r; }); };
  const run = v2.startHostTurn({ userId, chatSessionId: 'c-host-3', message: 'a', onEvent: () => {}, deps: { runTurn: slow } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(v2.clearChatSessionState(userId, 'c-host-3'), { cleared: false });
  release(); await run;
  assert.deepEqual(v2.clearChatSessionState(userId, 'c-host-3'), { cleared: true });
});
```

`makeUser` is the user helper from the copied test header. If `startHostTurn` needs the chat session to exist first (some helpers require `chatSessionExists`), create it with `createChatSession` in the helper and pass its id.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test tests/agent-v2-host-turn.test.mjs`
Expected: FAIL, `v2.startHostTurn is not a function`.

- [ ] **Step 3: Extract**

Refactor `runV2Stream` (around `agent-v2.mjs:575`) into `runV2Turn(ctx, io)`, where `io = {send, isGone, onStart}`. `onStart` lets the HTTP wrapper write SSE headers only once the turn is accepted, so refusals still answer with their JSON status codes.

- `handleV2Stream` keeps its request parsing and refusal responses. It calls `runV2Turn` with an SSE `io`.
- `startHostTurn` builds the same `ctx` from its arguments and calls `runV2Turn` with `send: onEvent, isGone: () => false`.
- Wherever the route answers a refusal with JSON (`sendTurnInProgress`, `SDK_UPDATING`/`PLUGIN_UPDATING`, `sendRouteRefusal`), `startHostTurn` must throw the coded error instead. Factor each refusal into a small function that returns `{code, status, body}`, and have both callers use it.

Export `cancelChatTurn` (the body of `handleV2Cancel` without the HTTP response) and `clearChatSessionState` (the body of `handleV2SessionDelete` plus `clearChatMessages` from `kb/chat-sessions.mjs`). The HTTP handlers call them.

- [ ] **Step 4: Run the new test and every existing agent-v2 and chat test**

Run: `cd extension && node --test tests/agent-v2-host-turn.test.mjs $(ls tests/agent-v2*.test.mjs tests/chat*.test.mjs) && npm test 2>&1 | tail -15`
Expected: the new tests pass and every existing test passes unchanged, which is the byte-identical evidence for the HTTP path. Also run `cd .. && make contract-gates`; it must pass with no fixture change.

- [ ] **Step 5: Commit**

```bash
git add extension/routes/agent-v2.mjs extension/tests/agent-v2-host-turn.test.mjs
git commit -m "refactor(server): run an Agent v2 turn, cancel and clear without HTTP"
```

---

### Task 5: Session gate, command ids and the engine-event translator

**Files:**
- Create: `extension/routes/host-api/session.mjs`, `extension/routes/host-api/translator.mjs`
- Test: `extension/tests/host-api-session.test.mjs`, `extension/tests/host-api-translator.test.mjs`

**Interfaces:**
- `session.mjs` ports Plan 2 Task 5. Read `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Session.swift` and `HostApiV1CommandIds.swift` and keep every message string identical. It produces:
  - `class HostApiSession` with:
    - `phase`: `{kind: 'awaitingHello'} | {kind: 'awaitingAuth', clientName} | {kind: 'authed', userId, deviceId, clientName}`;
    - `greeted(clientName)`;
    - `authenticated(userId, deviceId)`, which moves only from `awaitingAuth`;
    - `gate(command, served: Set) -> {allow: true} | {allow: false, code, message}`;
    - `deviceId` and `userId` getters.
  - `helloRefusal(apiVersions) -> string | null`.
  - `internalId(session, external)`, `parseId(id) -> {session, external} | null` (canonical only: session ≥ 0 and the id round-trips) and `isV1Id(id)`.
- `translator.mjs`: `translate(ev, {external, cancelledByClient}) -> {events: [{command, payload}], terminal}`, mapping engine events (Task 4 shapes):

| Engine event | v1 events | terminal |
|---|---|---|
| `init`, `mode_set`, `usage`, `tasks`, `tool_result`, `tool_use_start`, `tool_args_delta` | none | no |
| `delta {text}` | none (accumulated; see below) | no |
| `result` | `chat.delta` per ≤ 100,000-unit chunk of the accumulated reply, then `chat.done{requestId: external, stopReason?}` | yes |
| `error {message}` while `cancelledByClient` | `chat.done{requestId, stopReason: 'cancelled'}` | yes |
| `error {message}` | `chat.error{message ≤ 2000, retryable: !!ev.retryable}` | yes |
| `approval_request` kind `AskUserQuestion` | `approval.request{requestId, commandId: external, questions}` (Plan 2 Task 6 filtering and caps: no empty labels or questions, ≤ 10 questions, ≤ 20 options, header ≤ 12) | no |
| `approval_request` kind `ToolApproval` | `toolApproval.request{requestId, commandId, toolName (or 'tool'), summary: argsSummary ≤ 2000, truncated}` | no |
| `approval_resolved {requestId, outcome}` | `approval.cleared{requestId, commandId, reason: outcome ≤ 500}` | no |
| anything else | none | no |

  - Ids that are empty or longer than 64 units mean no event (never truncated).
  - Deltas are accumulated rather than forwarded one per token, to match the Mac's wire behaviour (the reply arrives as chunked `chat.delta` and then `chat.done`) and to keep frames large. The translator therefore keeps state: export `createTranslator({external}) -> {push(ev, {cancelledByClient}) -> {events, terminal}}`.

- [ ] **Step 1: Write the failing tests**

`extension/tests/host-api-session.test.mjs` asserts exactly what `mac/Tests/LlmIdeMacTests/HostApiV1SessionTests.swift` asserts: the phase gate messages, `helloRefusal([2])`, the canonical-id cases (`h1.7.c-1` and `h1.7.c.1` parse; `h1.007.x`, `h1.-1.x`, `h1.+7.x`, `h1.` and `h1.7.` don't) and the no-swap re-authentication. Translate those tests one for one.

`extension/tests/host-api-translator.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator } from '../routes/host-api/translator.mjs';

test('deltas accumulate and the result emits chunked deltas then done', () => {
  const t = createTranslator({ external: 'c-1' });
  assert.deepEqual(t.push({ type: 'init', sessionId: 's' }, {}), { events: [], terminal: false });
  t.push({ type: 'delta', text: 'Hel' }, {});
  t.push({ type: 'delta', text: 'lo' }, {});
  const done = t.push({ type: 'result', subtype: 'success', stopReason: 'end_turn' }, {});
  assert.deepEqual(done.events.map((e) => e.command), ['chat.delta', 'chat.done']);
  assert.equal(done.events[0].payload.text, 'Hello');
  assert.deepEqual(done.events[1].payload, { requestId: 'c-1', stopReason: 'end_turn' });
  assert.equal(done.terminal, true);
});

test('a long reply is split into 100,000-unit deltas', () => {
  const t = createTranslator({ external: 'c-1' });
  t.push({ type: 'delta', text: 'a'.repeat(250_000) }, {});
  const d = t.push({ type: 'result' }, {}).events.filter((e) => e.command === 'chat.delta').map((e) => e.payload.text.length);
  assert.deepEqual(d, [100_000, 100_000, 50_000]);
});

test('errors end the turn; a client cancel ends it as a cancelled done', () => {
  assert.deepEqual(createTranslator({ external: 'c-1' }).push({ type: 'error', message: 'boom', retryable: true }, {}),
    { events: [{ command: 'chat.error', payload: { message: 'boom', retryable: true } }], terminal: true });
  assert.deepEqual(createTranslator({ external: 'c-1' }).push({ type: 'error', message: 'aborted' }, { cancelledByClient: true }).events[0],
    { command: 'chat.done', payload: { requestId: 'c-1', stopReason: 'cancelled' } });
});

test('approvals map with the external command id, are filtered and capped, and never carry a truncated id', () => {
  const t = createTranslator({ external: 'c-1' });
  const ask = t.push({ type: 'approval_request', kind: 'AskUserQuestion', requestId: 'r-1', questions: [
    { question: 'Pick', header: 'A very long header', multiSelect: false, options: [{ label: 'Yes' }, { label: '' }] },
    { question: '', options: [{ label: 'x' }], multiSelect: false },
  ] }, {});
  assert.equal(ask.events[0].command, 'approval.request');
  assert.equal(ask.events[0].payload.commandId, 'c-1');
  assert.equal(ask.events[0].payload.questions.length, 1);
  assert.equal(ask.events[0].payload.questions[0].header, 'A very long ');
  assert.equal(ask.events[0].payload.questions[0].options.length, 1);
  const tool = t.push({ type: 'approval_request', kind: 'ToolApproval', requestId: 'r-2', toolName: '', argsSummary: 'x'.repeat(3000) }, {});
  assert.equal(tool.events[0].payload.toolName, 'tool');
  assert.equal(tool.events[0].payload.summary.length, 2000);
  assert.equal(tool.events[0].payload.truncated, true);
  assert.deepEqual(t.push({ type: 'approval_request', kind: 'ToolApproval', requestId: 'r'.repeat(65), toolName: 'Edit' }, {}).events, []);
  assert.deepEqual(t.push({ type: 'approval_resolved', requestId: 'r-1', outcome: 'answer' }, {}).events[0],
    { command: 'approval.cleared', payload: { requestId: 'r-1', commandId: 'c-1', reason: 'answer' } });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd extension && node --test tests/host-api-session.test.mjs tests/host-api-translator.test.mjs`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement**

Port the Swift session and command-id code line for line into `session.mjs` (use `/^(0|[1-9][0-9]*)$/` for the session segment plus the round-trip check). Write `translator.mjs` per the table, using `clamp` from `frame.mjs` and a 1–64 id check.

- [ ] **Step 4: Run the tests and the lint**

Run: `cd extension && node --test tests/host-api-session.test.mjs tests/host-api-translator.test.mjs && npx eslint routes/host-api`
Expected: all pass and 0 problems.

- [ ] **Step 5: Commit**

```bash
git add extension/routes/host-api/session.mjs extension/routes/host-api/translator.mjs extension/tests/host-api-session.test.mjs extension/tests/host-api-translator.test.mjs
git commit -m "feat(host-api): gate desktop v1 sessions and translate engine events"
```

---

### Task 6: The desktop gateway

**Files:**
- Create: `extension/routes/host-api/gateway.mjs`
- Test: `extension/tests/host-api-gateway.test.mjs`

**Interfaces:**
- Consumes:
  - Task 2: `parseRequest`, `response`, `event`, `errorFrame`, `clamp`
  - Task 3: the device store, `consumePin`, `PairingThrottle`
  - Task 4: `startHostTurn`, `cancelChatTurn`, `clearChatSessionState`
  - Task 5: `HostApiSession`, `helloRefusal`, ids, `createTranslator`
  - `answerDecision` (`llm_agent/sdk/decisions.mjs`), `getChatSession` and `createChatSession` (`kb/chat-sessions.mjs`)
- Produces `createGateway(deps) -> {opened(session, peer), receive(session, text) -> Promise<void>, closed(session), closeAll(), capabilitiesChanged(), disconnectDevice(userId, deviceId), rev}`.
  - `deps` carries `send(session, text)`, `close(session)`, `hostName()`, `capabilities()` and `log(line)`, plus injectable `turn`, `cancel`, `clear`, `decide`, `history`, `quickChat`, `devices`, `pins` and `now` for tests.
  - Default dependencies wire the real modules, so Task 7 calls `createGateway({send, close, hostName, capabilities, log})`.
- Behaviour per command is the Mac gateway's table (Plan 2 Task 7, as amended by its review and final fix wave). Read `mac/Sources/LlmIdeMac/Features/MobileControl/Services/HostApi/HostApiV1Gateway.swift`. The differences:

| Command | Desktop behaviour |
|---|---|
| `host.hello` | `{hostName, hostKind: 'desktop', apiVersion: 1, apiVersions: [1], capabilities, protocolVersion: 1, requiresAuth: true}` |
| `host.auth.pair` | Throttle decision first. `consumePin(pin)` returns a userId or null. On success: `issueDeviceToken(userId, clientName)`, the session is authenticated as `{userId, deviceId}`, reply `{token, capabilities}`. A wrong PIN gives `auth_failed` (not retryable) and a throttle failure. A correct PIN in the wrong phase gives `denied`. |
| `host.auth.token` | Throttle decision first, then `authenticateDeviceToken`. Otherwise as on the Mac. |
| `host.auth.revoke` | Own token only: `authenticateDeviceToken(token)` must equal the session's `{userId, deviceId}`. Then `revokeDevice`, reply `{revoked: true}`, and close every session of that device. |
| `chat.snapshot`, `host.snapshot` (`chat` only) | `getChatSession(userId, quickChatId, {messageLimit: limit})`. Map `messages` to `{role, content}`, keep only user and assistant, clamp content to 100,000, at most 500. No quick chat yet means an empty list. |
| `chat.send` | Refuse `busy` when the id is already owned or a turn is already running for this session. Get or create the quick chat (`createChatSession(userId, {title: 'Phone chat', surface: 'any', mode: 'agent'})`, then `setQuickChatId`). Own `h1.<s>.<id>` and reply `{accepted: true, requestId: id}`. Call `turn({userId, chatSessionId, message: text, files: attachments, onEvent})`. `onEvent` feeds a per-command translator; it also records the live `sdkSessionId` from the `init` event and each open approval `requestId`. Each translated event is sent as a v1 event with `replyTo: id`. A rejected turn sends `chat.error{message, retryable: code === 'SESSION_TOKEN_LIMIT' ? false : true}` and ends ownership. |
| `chat.cancel` | For each owned command: mark it cancelled, then `cancel(userId, quickChatId)`. Reply `{cancelled}`. |
| `chat.history.clear` | `denied` unless `LLMIDE_HOST_API_CHAT_CLEAR=1` (deps flag). `clear(userId, quickChatId)`; `{cleared: false}` from a running turn gives `busy`. |
| `approvals.answer` | The command must be owned and have the `requestId` open, otherwise `not_found`. `decide({requestId, sdkSessionId, userId, action: 'answer', answers})`. `{ok: false}` gives `not_found` (expired or unknown) or `denied` (tenancy). Reply `{accepted: true}`. |
| `toolApprovals.answer` | Served only with `tool_approvals` in capabilities. Same ownership check. `decide({…, action: decision === 'allow_once' ? 'allow' : 'deny'})`. Never `always-allow`. |

  - Capabilities: `['host', 'chat', 'approvals']`, plus `'tool_approvals'` when `LLMIDE_HOST_API_TOOL_APPROVALS=1`.
  - `rev` is one counter per gateway, incremented per event and stamped on every frame.
  - At most 4 sessions; a session that is not authenticated within 10 s is closed.
  - `closed(session)` cancels its in-flight turns and drops later events.
  - `disconnectDevice` is called by Task 8's revoke route.

- [ ] **Step 1: Write the failing test**

`extension/tests/host-api-gateway.test.mjs` drives the gateway with fake dependencies, frames inspected as JSON. Port the scenarios of `mac/Tests/LlmIdeMacTests/HostApiV1GatewayTests.swift`, adapted to the desktop fakes:
- `turn` is a fake that pushes `init`, `delta` and `result` through `onEvent`.
- `decide` records its arguments and returns `{ok: true}`.
- `pins.consumePin` returns `'u1'` for `'123456'`.
- `devices` is an in-memory fake.

The scenarios to port:
1. **pairing:** hello, then pair, then the token is reused on a second session.
2. **wrong PIN:** `auth_failed`, not retryable; commands before auth are refused.
3. **chat.send:** the result has `requestId`; `turn` is called with the quick chat id; the frames are `chat.delta` then `chat.done`; `rev` is monotonic; ownership ends at terminal.
4. **reused id:** gives `busy`.
5. **cancel:** gives a cancelled `chat.done`.
6. **approvals.answer:**
   - It is `not_found` when not owned.
   - When owned, `decide` is called with the `sdkSessionId` from `init` and `action: 'answer'`.
7. **toolApprovals.answer without the capability:** `capability_unavailable`. With the flag, `decide` gets `action: 'allow'` for `allow_once`.
8. **history.clear:**
   - Without the flag it is `denied`.
   - With the flag, `{cleared: true}`.
   - While a turn is running it is `busy`.
9. **snapshot:** `chat` only.
10. **self-revoke:** with another token it is `denied`; with its own token, `{revoked: true}` and every session of that device closes.
11. **closeAll:** cancels every in-flight turn.
12. **hello:** returns `hostKind: 'desktop'` and `apiVersions: [1]`.

Write each as a `test(...)` with exact assertions, as in the Swift file.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test tests/host-api-gateway.test.mjs`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

Write `gateway.mjs` as the structural twin of `HostApiV1Gateway.swift`, with the desktop table above. Keep it main-thread synchronous apart from the awaited `turn`/`history`/`clear` calls. Process one session's frames in order: keep a per-session promise chain, `queue = queue.then(() => handle(text))`, so a slow command never reorders that session's frames (the Plan 2 Task 8 finding). Never log frame content, tokens or PINs: log type and size only.

- [ ] **Step 4: Run the tests and the lint**

Run: `cd extension && node --test tests/host-api-gateway.test.mjs && npx eslint routes/host-api`
Expected: 12 scenarios pass and 0 problems.

- [ ] **Step 5: Commit**

```bash
git add extension/routes/host-api/gateway.mjs extension/tests/host-api-gateway.test.mjs
git commit -m "feat(host-api): serve the v1 commands from the desktop core"
```

---

### Task 7: The development listener, core wiring and a real-server end-to-end test

**Files:**
- Create: `extension/server/host-api-listener.mjs`
- Modify: `extension/core/config.mjs` (`hostApiDev`, `hostApiToolApprovals`, `hostApiChatClear`), `extension/server.mjs` (start after `listen`, stop on shutdown)
- Test: `extension/tests/host-api-listener.test.mjs`, `extension/tests/host-api-e2e.test.mjs`

**Interfaces:**
- Produces `startHostApiListener({gateway, basePort = 3016, candidates = 10, log}) -> Promise<{port, close()}>`.
  - It creates its own `http.createServer` bound to `127.0.0.1`.
  - Non-upgrade requests get 404.
  - `upgrade` is accepted only when all of these hold:
    - the path is exactly `/host-api/v1`;
    - there is no `Origin` header (case-insensitive), or the `Origin` exactly matches one of `config.hostApiWebOrigins` (decision 6: loopback origins only, parsed from `LLMIDE_HOST_API_WEB_ORIGINS`, default empty);
    - the remote address is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`);
    - `handshakeRefusal(req) === null`.
  - Otherwise it writes `HTTP/1.1 <status> …` and destroys the socket.
  - Session ids are monotonic and never reused.
  - `conn.on('message')` calls `gateway.receive`, `on('close')` calls `gateway.closed`, and the gateway's `send`/`close` deps write to the connection.
  - `EADDRINUSE` slides to the next port.
- Config, `config.hostApiDev`: `process.env.LLMIDE_HOST_API_DEV === '1' && process.env.NODE_ENV !== 'production'`. `hostApiToolApprovals` and `hostApiChatClear` read their `=== '1'` flags.
- `config.hostApiWebOrigins` is a frozen array.
  - It is parsed from `LLMIDE_HOST_API_WEB_ORIGINS` (comma-separated, trimmed).
  - It keeps only entries matching `/^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}$/`; every dropped entry is logged by name at start.
  - The listener test adds two cases: an allowlisted `Origin: http://localhost:5173` is accepted, and `Origin: http://localhost:5174` (not listed) gets 403.

- [ ] **Step 1: Write the failing tests**

- **`host-api-listener.test.mjs`:**
  - A fake gateway records `opened`/`receive`/`closed` calls.
  - Start the listener on a random base port.
  - A global `WebSocket` to `/host-api/v1` delivers its frame to `receive`.
  - `/other` is refused.
  - A raw `http.request` upgrade with `Origin: https://evil.example` gets 403 and no `opened` call.
  - Two connections get session ids 1 and 2.
  - `close()` releases the port.
  - Skip when no global `WebSocket`.
- **`host-api-e2e.test.mjs`:**
  - Spawn the real core with the bench-fake engine and `LLMIDE_HOST_API_DEV=1`. Copy `ui/screens/shell/tests/e2e/core-server.mjs` `startCore` (env stripping, temp data dir, registered user, `--bench-fake`), and add `LLMIDE_HOST_API_DEV: '1'`.
  - Mint a PIN through Task 8's route. If Task 8 is not done yet, write this e2e at the end of Task 8 instead, and keep only the listener test here.
  - Then over the listener, assert:
    1. `host.hello` gives `hostKind: 'desktop'`;
    2. `host.auth.pair` gives a token;
    3. `chat.send` "hi" gives `chat.delta` (the bench-fake canned reply) and then `chat.done`;
    4. `chat.snapshot` contains the user and assistant lines;
    5. `host.auth.revoke` gives `{revoked: true}`.

  The test binds local ports; run it unsandboxed.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd extension && node --test tests/host-api-listener.test.mjs`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

Write `host-api-listener.mjs` per the interface. In `server.mjs`, after `server.listen(...)` succeeds:

```js
if (config.hostApiDev) {
  const { createGateway } = await import('./routes/host-api/gateway.mjs');
  const { startHostApiListener } = await import('./server/host-api-listener.mjs');
  const gateway = createGateway({ hostName: () => os.hostname(), log: (l) => logger.info(l) /* send/close wired by the listener */ });
  hostApi = await startHostApiListener({ gateway, log: (l) => logger.info(l) });
  logger.info(`Host API v1 (development, loopback only) on 127.0.0.1:${hostApi.port}`);
}
```

Close it in the existing shutdown path. The dynamic imports keep the gateway, and through it `agent-v2`'s engine path, off the boot path when the flag is unset (the lazy-engine invariant). `agent-v2.mjs` already lazy-loads the SDK, so importing it does not load the engine; confirm this with `tests/lazy-engine.test.mjs`. Let the listener own the gateway's `send`/`close` wiring: `createGateway` accepts them as later-assignable properties, the same pattern as the Mac.

- [ ] **Step 4: Run the tests, the lazy-engine test and the full core suite**

Run: `cd extension && node --test tests/host-api-listener.test.mjs tests/lazy-engine.test.mjs && npm test 2>&1 | tail -15`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/server/host-api-listener.mjs extension/core/config.mjs extension/server.mjs extension/tests/host-api-listener.test.mjs
git commit -m "feat(server): run Host API v1 on a loopback development listener"
```

---

### Task 8: PIN and device routes, desktop wiring, Settings card, docs

**Files:**
- Modify: `extension/server.mjs` (three routes, `SERVER_API_VERSION` 106 to 107, `ALL_ENDPOINTS`)
- Create: `schema/http/host-api.schema.json` + `schema/http/fixtures/host-api/*` (follow `schema/http/SCHEMA.md`; copy the `calendar-ical` group's shape)
- Modify: the generated TS types and OpenAPI overlay via the generators `make contract-gates` names, and `schema/http/INVENTORY.md` (`node scripts/http-inventory.mjs`)
- Modify: `desktop/src-tauri/src/core_host.rs` (the dev env pass-through)
- Create: `ui/screens/settings/sections/HostApiPairing.tsx`; modify the Settings section registry and `scripts/extract-settings-groups.mjs` expectations if a new group is added
- Create: `extension/tests/host-api-routes.test.mjs`; finish `extension/tests/host-api-e2e.test.mjs` (Task 7 step 1)
- Modify: `schema/host-api/v1/README.md`, `extension/CLAUDE.md`, `docs/superpowers/MASTER-PLAN.md`

**Interfaces:**
- Routes. Each needs a JWT and the bus host proof (`verifyBusHostProof(req, env)` from `core/host-approval.mjs`). Without the proof they answer `403 {error: {code: 'HOST_PROOF_REQUIRED'}}`. When `config.hostApiDev` is false they answer `404 {error: {code: 'HOST_API_DISABLED'}}`.
  - `POST /host-api/pin` returns `{pin, expiresAt, port}`, where `port` is the listener's bound port.
  - `GET /host-api/devices` returns `{devices: [{deviceId, name, pairedAt, lastSeenAt}]}`.
  - `DELETE /host-api/devices/:id` returns `{revoked: boolean}` and calls `gateway.disconnectDevice(userId, id)`.
- Rust, in `core_host.rs` where the spawn command is built (about :1112–1160):

```rust
if cfg!(debug_assertions) && std::env::var("LLMIDE_HOST_API_DEV").as_deref() == Ok("1") {
    cmd.env("LLMIDE_HOST_API_DEV", "1");
}
```

  It is explicit `.env`, not widened `ALLOWED`. Add a cargo test that a release-profile helper refuses it if you extract the condition into a function, for example `fn host_api_dev_env(debug: bool, value: Option<&str>) -> bool`.
- Settings card, `HostApiPairing.tsx`:
  - It is visible only when `POST /host-api/pin` does not answer `404 HOST_API_DISABLED`. Probe with `GET /host-api/devices`.
  - **Show pairing PIN** button: shows the PIN, port and expiry countdown. The PIN is held in component state only and never persisted.
  - Paired-devices list with **Revoke** and a native confirmation (`bypass_confirm`-style host confirm if one exists for destructive actions; otherwise the standard in-app confirm the Settings screen uses).
  - It uses the core client from `settings-adapter.ts` with the bus proof header (`ui/screens/shell/bus-proof.ts`).

- [ ] **Step 1: Write the failing route test**

`extension/tests/host-api-routes.test.mjs`, using the route-test helpers (`tests/helpers/kb-http.mjs`) and the bus-proof test pattern (`tests/bus-host-proof.test.mjs`):
- no proof gives 403 `HOST_PROOF_REQUIRED`;
- with the proof but the flag off gives 404 `HOST_API_DISABLED`;
- with the flag, a PIN of six digits;
- `GET` lists a device issued through `issueDeviceToken`;
- `DELETE` revokes it and calls `disconnectDevice`;
- another user's device id gives `{revoked: false}`.

- [ ] **Step 2: Run it to verify it fails, then implement the routes and their contract**

Run: `cd extension && node --test tests/host-api-routes.test.mjs`, which FAILS on 404s from the router. Then implement:
1. The three routes.
2. The `v107` changelog line above `SERVER_API_VERSION`.
3. `ALL_ENDPOINTS`.
4. `schema/http/host-api.schema.json` with fixtures for every status.
5. The inventory and the generated types (`make contract-gates` names each generator to run).

Run `make contract-gates` until it passes.

- [ ] **Step 3: Rust and UI**

Make the `core_host.rs` change (and the cargo test of the extracted condition) and the Settings card with its node tests. Follow the existing settings section tests under `ui/screens/settings/tests/`: render with a fake core, check that "Show pairing PIN" displays six digits, and check that the card is hidden on `HOST_API_DISABLED`.

Run:
- `cd desktop/src-tauri && cargo test host_api_dev`
- `cd desktop && npm test 2>&1 | tail -5 && npm run -s check:security && npx tsc --noEmit -p . && npx vite build`
- `node scripts/check-capabilities.mjs`, if a host command was added (none is expected: the card uses core routes).

- [ ] **Step 4: Finish the end-to-end test**

Complete `extension/tests/host-api-e2e.test.mjs` from Task 7 step 1: the real core, bench-fake, the flag on, the PIN minted over HTTP with the host proof, then the v1 flow. Run it unsandboxed:

`cd extension && node --test tests/host-api-e2e.test.mjs`
Expected: hello (desktop), pair, chat.send giving delta and done, snapshot, revoke.

- [ ] **Step 5: Docs, plan status and the full gate**

- `schema/host-api/v1/README.md`: add "The desktop host adapter is `extension/routes/host-api/` (gateway, frame codec, session gate, translator) with the listener in `extension/server/host-api-listener.mjs` — development loopback only until TLS lands."
- `extension/CLAUDE.md`: a five-line "Host API v1 (desktop)" section covering:
  - the flag (`LLMIDE_HOST_API_DEV=1`, never in production);
  - the listener port and that it serves `/host-api/v1` only;
  - that the gateway uses `startHostTurn`/`cancelChatTurn`/`clearChatSessionState` and never HTTP;
  - the phone chat (`host_api_quick_chat`) and that it runs `auto_read_only` in the extension chat workspace;
  - that frames are processed in order per session.
- `docs/superpowers/MASTER-PLAN.md`, S6: replace the "Host API Plans 3 to 6" item. Plan 3 becomes `[~]`, citing its commits and this plan file, with "manual check from a v1 client against `LLMIDE_HOST_API_DEV=1 npm run tauri dev` pending (you)". Add a `[ ]` item for Plans 4 to 6. Then run `node scripts/plan-status.mjs --fix && node scripts/plan-status.mjs --check`.
- Run `make regression` (unsandboxed, with `LLMIDE_KEYCHAIN_BACKEND=memory`). Expected: it passes.

- [ ] **Step 6: Commit**

Use separate commits:
- `feat(server): add the Host API pairing PIN and device routes` (routes, contract, inventory, API 107)
- `feat(desktop): pass the Host API dev flag and show pairing in Settings` (Rust and UI)
- `docs(plan): record the Host API desktop adapter`

---

## Limits

- Development loopback listener only. There is no TLS, no LAN access and no advertisement, so a real phone cannot use desktop v1 until spec phase 6.
- The phone chat is one server-side chat per user. It runs read-only in the extension chat workspace, not in the open project, and the desktop chat list does not show it yet.
- `tool_approvals` and `chat.history.clear` are switched by environment flags. A desktop preference UI for them is a follow-up.
- `host.snapshot` serves the `chat` topic only. No v1 progress event exists.
- The iOS `HostConnection` (phase 4), the web client (phase 5), and TLS, pinning, the Origin allowlist and audit logging (phase 6) are separate plans.

## Workflow

Subagent-driven, with one fresh implementer per task and each task reviewed before the next.
- Tasks 3, 6, 7 and 8 touch auth, tokens, a network listener and HTTP routes. Review them on Sonnet or a stronger model.
- Task 4 refactors the core's most-used route. Review it on the most capable model, because the byte-identical HTTP behaviour is the risk.
- Commit on `main` and do not push.

## Commands

```bash
node scripts/generate-host-api.mjs && node scripts/generate-host-api.mjs --check
make host-api-check && make contract-gates
cd extension && node --test tests/host-api-*.test.mjs tests/ws-server.test.mjs tests/agent-v2-host-turn.test.mjs
cd extension && npm test
cd desktop && npm test && npm run -s check:security && npx tsc --noEmit -p . && npx vite build
cd desktop/src-tauri && cargo test
LLMIDE_KEYCHAIN_BACKEND=memory make regression     # unsandboxed
```

## Self-review

**Spec coverage, phase 3:**
- Same surface as the Mac: the 12 commands (Task 6) and 7 events (Task 5 translator, plus `host.capabilities` in Task 6).
- Capabilities the desktop doesn't serve are not advertised (`tool_approvals` behind its flag).
- Auth: PIN, per-device token, self-revoke, throttle and hashed tokens (Task 3 and Task 6).
- Listener rule: 3016 with fallback, loopback plaintext only behind the explicit dev flag (Task 7, Task 8 Rust).
- The gateway does not proxy and does not read UI state (Task 4 seam, server-side quick chat).
- Cross-host conformance (spec "Testing"): the same fixtures and `invalid-cases.json` drive both the Swift and Node codecs (Task 2). Message templates and gate strings are ported verbatim (Tasks 2 and 5).
- "Each phase ends with the conformance suite, a build, and a manual pairing check": Task 8 step 5, with the manual check left to the user.

**Deferred on purpose (Limits):** TLS, Origin allowlist and audit log (phase 6); the other snapshot topics.

**Placeholders:**
- Two values must be read from existing files before writing: the `user_id` column type and foreign key copied from migration 0060 (Task 3), and the `PairingThrottle.swift` constants (Task 3). Each names its source file.
- The Task 4 extraction and the Task 6 and 7 scenario tests are given as precise behaviour plus a reference implementation file to port, because they must fit existing code.

**Type consistency:**
- `startHostTurn` / `cancelChatTurn` / `clearChatSessionState` (Task 4) are consumed by Task 6.
- `createTranslator` (Task 5) is consumed by Task 6.
- `createGateway` (Task 6) is consumed by Task 7.
- `disconnectDevice` (Task 6) is called by the Task 8 route.
- The device-store names (Task 3) are used in Tasks 6 and 8.
