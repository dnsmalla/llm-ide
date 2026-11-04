# Host API v1 Web Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser web app, served from this computer, pairs with the desktop host over Host API v1 and uses its served surface: pairing (host URL and PIN), chat (send, chunked reply, cancel, history), approvals (AskUserQuestion answers, plus tool approvals when the host grants `tool_approvals`), capability gating, a token kept in browser storage, and reconnect with snapshot resync.

**Architecture:** A new top-level `web/` package, a sibling of `desktop/`. It has its own Vite and React, consumes `@llmide/ui-kit` and two chat pieces from `ui/screens/chat` from source through the same aliases the desktop uses, and has no Tauri, Monaco or graph dependencies. The protocol layer is framework-free and DOM-free TypeScript under `web/src/host-api/` and `web/src/chat/`, so `node --test` drives it directly and an end-to-end test runs it against the real core. It is made of the connection, the URL policy, the token store, the chat reducer and the chat controller. The payload types are generated from `schema/host-api/v1/` by `scripts/generate-host-api.mjs`, which gains a TypeScript output beside its Node and Swift outputs. For now the page is served on `http://127.0.0.1:5180` (Vite dev or `vite preview` of the built bundle) and connects to the desktop's loopback development listener `ws://127.0.0.1:3016+/host-api/v1`, whose `LLMIDE_HOST_API_WEB_ORIGINS` lists that origin (Plan 3 decision 6). Moving to `https://<domain>` with WSS later is a build variable plus host configuration, not a code change.

**Tech Stack:** TypeScript 5.9 (erasable syntax only, so `node --experimental-strip-types` runs the sources), React 19.3 and Vite 7.3 with the exact versions the desktop already pins, the browser and Node 22 global `WebSocket`, `node:test`, and esbuild for server-rendered component tests. One small Rust change in the Tauri host passes the origin list in debug builds.

**Spec:** [`docs/superpowers/specs/2026-11-03-host-api-design.md`](../specs/2026-11-03-host-api-design.md), delivery phase 5: "Web client: v1 over WSS with URL/pairing-token entry; no Bonjour assumption." Contract: Plan 1 and `schema/host-api/v1/`. Host: Plan 3 [`2026-11-04-host-api-desktop-adapter.md`](2026-11-04-host-api-desktop-adapter.md) (in progress), whose decision 6 is the localhost web origin. Mac host: Plan 2 [`2026-11-04-host-api-mac-adapter.md`](2026-11-04-host-api-mac-adapter.md). Its listener refuses every `Origin` today; Plan 6 adds the Mac allowlist and WSS.

## Global Constraints

- Values quoted from the spec:
  - "Frames are UTF-8 JSON, max 1 MiB. Lists default to 100 items, max 500."
  - "`message` is human-readable and bounded to 500 characters. Error messages never contain tokens or file contents."
- Envelope, quoted from the spec: "`id` is unique per client connection and used for correlation." "Requests may be retried only when the command declares `idempotent: true`; otherwise the client generates a new `id` after a timeout." The id must match `^[A-Za-z0-9_-]{1,64}$` (`envelope.schema.json`), so ids are `c-<uuid>`.
- Resync, quoted from the spec: "A client that sees an event `rev` greater than its snapshot `rev + 1` resubscribes and takes a fresh snapshot instead of guessing." On reconnect the client "discards stale feature state and requests snapshots for visible screens. Event delivery resumes; no historical replay is required."
- Auth, quoted from the spec:
  - "Pairing PIN → per-device token; token in Keychain/browser storage; revocable and scoped."
  - "No frame may carry a credential after pairing except `host.auth.token` and the token in `host.auth.revoke` (self-revoke)."
  - "Pairing failure returns `auth_failed` with `retryable: false` for a bad PIN and `retryable: true` for throttling."
- Transport, quoted from the spec:
  - "TLS/WSS is required for non-loopback clients."
  - "Localhost development may use plaintext only when an explicit development environment flag is set; production builds refuse it."
  - "Web clients send an `Origin`; the host applies an allowlist and refuses unknown origins. No wildcard CORS."
  - "Discovery, the QR and the manual-entry screen advertise the exact v1 port; the default is never assumed." The web app has no discovery: the user types the URL, and the desktop Settings card shows the port.
- Capability gating, quoted from the spec: "Host advertises capabilities; clients hide unsupported commands." "A capability change … pushes `host.capabilities`; the client hides or closes screens that are no longer served." The v1 capabilities are `host`, `chat`, `approvals` and `tool_approvals`.
- Payload caps from `commands.json`: `chat.send.text` is 1 to 100,000 characters, `chat.snapshot.limit` is 1 to 500, `chat.delta.text` is at most 100,000, and `toolApprovals.answer.decision` is `allow_once` or `deny`. v1 has no decline command for questions.
- UI rules from `ui/kit/README.md` and `ui/screens/README.md`:
  - No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function`.
  - No remote images, fonts or scripts. Model and host text is rendered as React text only.
  - Colours come from `--tok-*` tokens; every control has a name, a focus ring and a keyboard path.
  - Logic lives in plain `.ts` modules tested with `node --test`; components are tested with server rendering.
- Spec phase 5 says "Each phase ends with the conformance suite, a build, and a manual pairing check against a real host." **The manual check is deferred to the product stage (user decision 2026-11-04) and is not a gate here.** The automated end-to-end test (Task 8) takes its place.
- Repo rules:
  - No new third-party package in the repo: the web package pins the same exact versions the desktop already locks.
  - Conventional Commits, one concern per commit, on `main`, never pushed by the executor.
  - Stage only your own files (other agents commit concurrently) and retry on `.git/index.lock`.
  - Every commit message ends with the attribution line the session gives.

## Decisions this plan makes (revisit if wrong)

1. **The web app is a new top-level `web/` package, not a folder under `ui/screens/`.**
   - `ui/screens/*` are desktop screens. Their README says they "talk to the Node core over HTTP/SSE", and that is the core-internal surface the spec forbids clients to use ("does not import core route modules into clients"). The web client speaks only Host API v1.
   - The web app is also a separate deployment target: today a local static bundle, later a VPS. It must not pull the desktop's Tauri, Monaco, xterm or sigma dependencies.
   - It still reuses the shared look. It uses `@llmide/ui-kit` and, from `ui/screens/chat`, the `Markdown` renderer, the `Composer` and the `QuestionCard`, all through the desktop's aliases. So it looks like the Mac and desktop chat without copying code.
2. **Scope is the iPhone companion's v1 surface (pairing, chat and approvals), not the whole Mac app.**
   - Host API v1 serves only `host`, `chat`, `approvals` and `tool_approvals`.
   - The "mirror the Mac" and "Library is the hub" screens (Library, Explorer, Auto Tasks) arrive in the web app when the Host API grows their commands (`llmdoc.*`, `explorer.*`, …), each behind its capability.
   - The web app never calls the core's HTTP routes.
3. **TypeScript types are generated, and the client has no schema validator.**
   - `scripts/generate-host-api.mjs` writes `web/src/host-api/types.generated.ts`: per-command request and result types, event payload types, and the command, event, capability and error-code tables. The existing `--check` (already run by `make host-api-check`) guards drift.
   - The host validates every frame it sends (Plan 3 `frame.mjs` `finish`). The client checks only the fields it reads (type, length) and renders text through React. A malformed field is then a display glitch, never an injection.
   - A third copy of the JSON Schema validator is not worth its code today.
4. **One fixed page origin, `http://127.0.0.1:5180`, for both `vite` (dev) and `vite preview` (the built bundle).**
   - It is not 5173: that port is the desktop's own Vite.
   - The user lists the origin in `LLMIDE_HOST_API_WEB_ORIGINS`.
   - The Tauri host forwards that variable to the core only in a debug build, and only together with `LLMIDE_HOST_API_DEV=1` (Task 7). This is the same explicit `.env(...)` rule Plan 3 uses for the dev flag; `core_env.rs` `ALLOWED` is not widened.
5. **Token and PIN handling:**
   - The token lives in `localStorage` under `llmide.hostApi.v1.token:<host URL>`, one token per host.
   - Where storage is missing or throws (a private window), the token is kept in memory and the page must pair again after a reload.
   - The PIN is never stored. It goes into exactly one `host.auth.pair` frame.
   - **Forget this host** sends `host.auth.revoke` with the stored token and then deletes the token.
   - XSS is the risk of a bearer token in browser storage. The mitigations are a strict CSP in the built page, no raw HTML anywhere, no third-party scripts, and per-device revoke in desktop Settings.
6. **URL policy:**
   - `ws://` is allowed only to `127.0.0.1`, `localhost` or `[::1]`; `wss://` is allowed to any host.
   - The path must be `/host-api/v1`, with no user, query or fragment.
   - A page served over `https:` must use `wss://`, because browsers block mixed content anyway.
   - **Moving to a domain later is configuration:**
     - Build with `VITE_HOST_API_URL=wss://<host>:<port>/host-api/v1`, which pre-fills the pairing screen.
     - Serve `web/dist` over HTTPS at the domain.
     - Add `https://<domain>` to the host's origin allowlist. Phase 6 widens the core's loopback-only filter and adds WSS and pinning.
7. **Reconnect:**
   - Backoff is `min(30 s, 0.5 s × 2^attempt)`. It applies only once a token exists; a never-paired page shows the failure instead of retrying.
   - Every successful `ready` triggers a `chat.snapshot`, and so does every event `rev` gap. Resync is single-flight.
   - The host cancels a session's turns when it closes (Plan 3 `closed(session)`), so a reply in flight when the socket drops is marked "interrupted", not resumed.
   - `rev` is one counter per host, so another device's events also show up as a gap. The resync that follows is cheap and idempotent, which is the spec's "instead of guessing".
8. **Approvals:**
   - **Questions:** "Decline to answer" on a question sends `chat.cancel`, because v1 has no decline command and stopping the reply is the honest equivalent. The card says so.
   - **Tool approvals:** they show **Allow once** and **Deny** only, and only while `tool_approvals` is granted. The contract has no "always allow".
9. **Messages over 100,000 characters are refused in the client.** That is the `chat.send` cap; the reused `Composer` allows 120,000.
10. **The rendered history is bounded.** The client keeps at most 500 messages, the `chat.snapshot` maximum, and a snapshot asks for 200. It renders the newest 50, with a **Show older** button that adds 50 at a time. That stays bounded without pulling in the desktop's virtual list, which is typed to the desktop chat state.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/generate-host-api.mjs` (modify) | Add the TypeScript output `web/src/host-api/types.generated.ts` |
| `extension/tests/host-api-ts-types.test.mjs` (create) | The TS output loads under strip-types, has 12 commands and 7 events, and type-checks |
| `web/package.json`, `web/package-lock.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/.gitignore`, `web/src/env.d.ts`, `web/src/main.tsx` (create) | The package: Vite on 127.0.0.1:5180, kit and screens aliases, a build-only CSP |
| `web/src/host-api/connection.ts` (create) | `HostConnection`: socket, correlation, timeouts, hello and auth, events, rev gap, reconnect |
| `web/src/host-api/url.ts`, `web/src/host-api/storage.ts` (create) | Host URL policy; per-host token store and last URL |
| `web/src/chat/store.ts`, `web/src/chat/controller.ts` (create) | Pure chat reducer; controller binding a `HostLink` to it |
| `web/src/App.tsx`, `web/src/screens/PairingScreen.tsx`, `web/src/screens/WebChat.tsx`, `web/src/screens/ToolApprovalCard.tsx`, `web/src/web.css` (create) | Screens |
| `web/tests/*.test.mjs`, `web/tests/ui-entry.ts`, `web/tests/helpers.mjs` (create) | Unit and server-render tests |
| `web/tests/e2e/host-api-e2e.test.mjs` (create) | Real core, bench-fake engine, dev listener and origin allowlist, driving the connection and the controller |
| `ui/screens/shell/tests/e2e/core-server.mjs` (modify) | `startCore({ env })`: extra env for the spawned core (additive) |
| `desktop/src-tauri/src/core_host.rs` (modify) | Forward `LLMIDE_HOST_API_WEB_ORIGINS` in debug builds with the dev flag |
| `web/README.md` (create), `Makefile`, `.github/workflows/desktop-ci.yml`, `schema/host-api/v1/README.md`, `CLAUDE.md`, `docs/superpowers/MASTER-PLAN.md` (modify) | Docs, gates and plan status |

## Parallel map

| Wave | Tasks (parallel-safe within a wave) | Waits for |
|---|---|---|
| A | **1** (TS types), **2** (package scaffold), **7** (Rust origin pass-through) | Task 7 also waits for Plan 3 Task 8's `core_host.rs` change |
| B | **3** (connection), **4** (URL and token store), **5** (chat store and controller) | 1 and 2 |
| C | **6** (screens), **8** (end-to-end) | Task 6 waits for 3, 4 and 5. Task 8 waits for 3, 5 and Plan 3 Tasks 7 and 8 (listener, PIN route) |
| D | **9** (docs and gates) | all |

The tasks within a wave touch disjoint files. Task 5 codes against the `HostLink` interface that Task 3 defines below and fakes it in its tests, so it does not wait for Task 3's code.

---

### Task 1: Generated TypeScript types for the web client

**Parallel-safe:** yes (wave A).

**Files:**
- Modify: `scripts/generate-host-api.mjs`
- Generated: `web/src/host-api/types.generated.ts`
- Test: `extension/tests/host-api-ts-types.test.mjs`

**Interfaces:**
- Produces `web/src/host-api/types.generated.ts`, which uses only erasable TypeScript, so `node --experimental-strip-types` can import it:
  - `HOST_API_VERSION` (`1`) and `HOST_API_LIMITS` (`as const`)
  - `HOST_API_CAPABILITIES` and `type HostApiCapability`
  - `HOST_API_ERROR_CODES`, `type HostApiErrorCode` and `type HostApiErrorBody`
  - `HOST_API_COMMANDS` (`{capability, idempotent}` per command, `as const`) and `type HostApiCommandName`
  - `interface HostApiCommandMap` (`{request, result}` per command), `type HostApiRequest<C>` and `type HostApiResult<C>`
  - `HOST_API_EVENT_NAMES`, `type HostApiEventName` and `interface HostApiEventMap`

- [ ] **Step 1: Write the failing test**

`extension/tests/host-api-ts-types.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'web/src/host-api/types.generated.ts');

test('the TS output exists and loads under strip-types with the full surface', () => {
  assert.ok(existsSync(OUT), 'run node scripts/generate-host-api.mjs');
  const code = `const m = await import(${JSON.stringify(pathToFileURL(OUT).href)});
    console.log(JSON.stringify({ v: m.HOST_API_VERSION, c: Object.keys(m.HOST_API_COMMANDS).length, e: m.HOST_API_EVENT_NAMES.length,
      caps: m.HOST_API_CAPABILITIES, codes: m.HOST_API_ERROR_CODES.length, send: m.HOST_API_COMMANDS['chat.send'] }));`;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), {
    v: 1, c: 12, e: 7, caps: ['host', 'chat', 'approvals', 'tool_approvals'], codes: 11, send: { capability: 'chat', idempotent: false },
  });
});

test('the generated types accept contract payloads and reject unknown fields', (t) => {
  const tsc = join(ROOT, 'desktop/node_modules/.bin/tsc');
  if (!existsSync(tsc)) return t.skip('desktop/node_modules missing (cd desktop && npm ci)');
  const dir = mkdtempSync(join(tmpdir(), 'host-api-ts-'));
  const check = join(dir, 'check.ts');
  writeFileSync(check, `import type { HostApiRequest, HostApiResult, HostApiEventMap } from ${JSON.stringify(OUT)};
const send: HostApiRequest<"chat.send"> = { text: "hi", attachments: [{ name: "a.txt", text: "b" }] };
const hello: HostApiResult<"host.hello"> = { hostName: "h", hostKind: "desktop", apiVersion: 1, apiVersions: [1], capabilities: ["chat"], protocolVersion: 1, requiresAuth: true };
const answers: HostApiRequest<"approvals.answer"> = { requestId: "r", commandId: "c", answers: { "Pick?": "Yes" } };
const done: HostApiEventMap["chat.done"] = { requestId: "c-1", stopReason: "end_turn" };
// @ts-expect-error closed payloads: unknown fields are refused
const bad: HostApiRequest<"chat.cancel"> = { surprise: 1 };
// @ts-expect-error decision is allow_once | deny only
const always: HostApiRequest<"toolApprovals.answer"> = { requestId: "r", commandId: "c", decision: "always" };
void send; void hello; void answers; void done; void bad; void always;
`);
  const r = spawnSync(tsc, ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--allowImportingTsExtensions', check], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test tests/host-api-ts-types.test.mjs`
Expected: FAIL, `run node scripts/generate-host-api.mjs`.

- [ ] **Step 3: Implement**

In `scripts/generate-host-api.mjs`, after `schemaTable` is built (it already holds the parsed `envelope` and `events`), add the TypeScript mapping and output:

```js
// TypeScript for the web client (web/): the same schemas as types only. The host validates every frame it sends;
// the client checks just the fields it reads. A shape this mapping does not know fails generation loudly.
const TS_REFS = { "#/$defs/ErrorCode": "HostApiErrorCode" };
function tsType(schema) {
  if (schema.$ref) {
    if (!TS_REFS[schema.$ref]) throw new Error(`host-api: no TypeScript type for $ref ${schema.$ref}`);
    return TS_REFS[schema.$ref];
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  switch (schema.type) {
    case "string": return "string";
    case "integer": return "number";
    case "boolean": return "boolean";
    case "array": return `Array<${tsType(schema.items)}>`;
    case "object": {
      const keys = Object.keys(schema.properties || {}).sort();
      if (!keys.length) {
        const ap = schema.additionalProperties;
        if (ap === false) return "Record<string, never>";
        if (ap && typeof ap === "object") return `Record<string, ${ap.type === "object" && !ap.properties ? "Record<string, unknown>" : tsType(ap)}>`;
        return "Record<string, unknown>";
      }
      const required = new Set(schema.required || []);
      return `{ ${keys.map((k) => {
        if (!/^[A-Za-z_$][\w$]*$/.test(k)) throw new Error(`host-api: ${k} is not a TypeScript identifier`);
        return `${k}${required.has(k) ? "" : "?"}: ${tsType(schema.properties[k])}`;
      }).join("; ")} }`;
    }
    default:
      throw new Error(`host-api: no TypeScript type for ${JSON.stringify(schema)}`);
  }
}

const tsEvents = schemaTable.events.oneOf
  .map((v) => [v.properties.command.const, v.properties.payload])
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const ts = `${header}
// Types for the web client. Types only: the host validates every frame it sends.
export const HOST_API_VERSION = ${registry.version};
export const HOST_API_LIMITS = ${JSON.stringify(registry.limits)} as const;
export const HOST_API_CAPABILITIES = ${JSON.stringify(registry.capabilities)} as const;
export type HostApiCapability = (typeof HOST_API_CAPABILITIES)[number];
export const HOST_API_ERROR_CODES = ${JSON.stringify(schemaTable.envelope.$defs.ErrorCode.enum)} as const;
export type HostApiErrorCode = (typeof HOST_API_ERROR_CODES)[number];
export type HostApiErrorBody = ${tsType(schemaTable.envelope.$defs.Error)};
export const HOST_API_COMMANDS = {
${names.map((n) => `  ${JSON.stringify(n)}: { capability: ${JSON.stringify(registry.commands[n].capability)}, idempotent: ${registry.commands[n].idempotent} },`).join("\n")}
} as const;
export type HostApiCommandName = keyof typeof HOST_API_COMMANDS;
export interface HostApiCommandMap {
${names.map((n) => `  ${JSON.stringify(n)}: { request: ${tsType(registry.commands[n].request)}; result: ${tsType(registry.commands[n].result)} };`).join("\n")}
}
export type HostApiRequest<C extends HostApiCommandName> = HostApiCommandMap[C]["request"];
export type HostApiResult<C extends HostApiCommandName> = HostApiCommandMap[C]["result"];
export const HOST_API_EVENT_NAMES = ${JSON.stringify(tsEvents.map(([e]) => e))} as const;
export type HostApiEventName = (typeof HOST_API_EVENT_NAMES)[number];
export interface HostApiEventMap {
${tsEvents.map(([e, p]) => `  ${JSON.stringify(e)}: ${tsType(p)};`).join("\n")}
}
`;
```

Add `["web/src/host-api/types.generated.ts", ts]` to `outputs`. Then add the web client as a third consumer in the header comment. Header for TypeScript: `header` is a `//` comment, which is valid TypeScript, so reuse it. Run `node scripts/generate-host-api.mjs`.

- [ ] **Step 4: Run the tests and the drift gate**

Run: `cd extension && node --test tests/host-api-ts-types.test.mjs tests/host-api-contract.test.mjs && cd .. && node scripts/generate-host-api.mjs --check && make host-api-check`
Expected: all pass, and `conformance-host-api: ok (12 commands, 7 events)`. The Swift and Node outputs are byte-identical to before (`git diff --stat` shows only the generator and the new file).

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-host-api.mjs web/src/host-api/types.generated.ts extension/tests/host-api-ts-types.test.mjs
git commit -m "feat(host-api): generate TypeScript types for the web client"
```

---

### Task 2: The `web/` package scaffold

**Parallel-safe:** yes (wave A). It does not touch `web/src/host-api/types.generated.ts`, which is Task 1's file.

**Files:**
- Create: `web/package.json`, `web/package-lock.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/.gitignore`, `web/src/env.d.ts`, `web/src/main.tsx`
- Test: `web/tests/scaffold.test.mjs`

**Interfaces:**
- Produces:
  - `npm run dev` / `npm run preview` serve on `http://127.0.0.1:5180` (`strictPort`).
  - `npm test` runs `node --test --experimental-strip-types tests/*.test.mjs`.
  - `npm run test:e2e` runs `tests/e2e/*.test.mjs`.
  - `npm run build` runs `tsc --noEmit -p . && vite build`.
  - `vite.config.ts` exports `WEB_PORT = 5180` and `CSP`.
  - Aliases: `@llmide/ui-kit`, `@llmide/ui-kit/styles.css` and `@llmide/screens/*`, the same as `desktop/vite.config.ts`.
  - Defines: `__APP_VERSION__`. `import.meta.env.VITE_HOST_API_URL` is optional.

- [ ] **Step 1: Write the package files**

`web/package.json`, using the exact versions `desktop/package.json` already pins (no new package enters the repo):

```json
{
  "name": "llmide-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "LLM-IDE web client: Host API v1 over WebSocket (pairing, chat, approvals)",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit -p . && vite build",
    "preview": "vite preview",
    "test": "node --test --experimental-strip-types tests/*.test.mjs",
    "test:e2e": "node --test --experimental-strip-types tests/e2e/*.test.mjs"
  },
  "dependencies": {
    "react": "19.3.1",
    "react-dom": "19.3.1"
  },
  "devDependencies": {
    "@types/node": "22.20.5",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "5.2.0",
    "esbuild": "0.28.2",
    "typescript": "5.9.3",
    "vite": "7.3.7"
  }
}
```

`web/vite.config.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

// One fixed origin for dev and preview: the host's LLMIDE_HOST_API_WEB_ORIGINS must list http://127.0.0.1:5180.
// Not 5173: that is the desktop's own Vite.
export const WEB_PORT = 5180;
// connect-src: plaintext ws only to loopback (the dev listener); wss to any host the user enters (phase 6 hosts).
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:* wss:", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
].join("; ");

// Vite's dev server injects an inline React-refresh preamble, so the CSP meta goes into the built page only.
const cspMeta = (): Plugin => ({
  name: "llmide-web-csp",
  apply: "build",
  transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), cspMeta()],
  resolve: {
    alias: [
      { find: /^@llmide\/ui-kit\/styles\.css$/, replacement: here("../ui/kit/src/styles/kit.css") },
      { find: /^@llmide\/ui-kit$/, replacement: here("../ui/kit/src/index.ts") },
      { find: /^@llmide\/screens\/(.*)$/, replacement: here("../ui/screens/") + "$1" },
    ],
    dedupe: ["react", "react-dom"],
  },
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: { port: WEB_PORT, strictPort: true, host: "127.0.0.1", fs: { allow: [".."] } },
  preview: { port: WEB_PORT, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022" },
});
```

`web/tsconfig.json`: copy `desktop/tsconfig.json`, then make these changes:
- In `paths`, keep only `@llmide/ui-kit`, `@llmide/screens/*`, `react`, `react/jsx-runtime` and `react/jsx-dev-runtime`, pointing at `./node_modules/@types/react…`.
- Set `"include": ["src", "vite.config.ts"]`. The imported `ui/screens/chat` files are type-checked transitively. Do not include all of `ui/screens`, because the desktop-only screens need Tauri types.
- Set `"types": ["vite/client", "node"]`.

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>LLM-IDE Web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/env.d.ts`:

```ts
/// <reference types="vite/client" />
declare const __APP_VERSION__: string;
interface ImportMetaEnv { readonly VITE_HOST_API_URL?: string }
```

`web/src/main.tsx` (placeholder; Task 6 replaces the body with `<App />`):

```tsx
import "@llmide/ui-kit/styles.css";
import { createRoot } from "react-dom/client";
import { applyTheme } from "@llmide/ui-kit";

applyTheme(globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
createRoot(document.getElementById("root")!).render(<main className="web-app"><h1>LLM-IDE Web</h1></main>);
```

`web/.gitignore`: `node_modules/` and `dist/`.

Then run `cd web && npm install`. It needs the npm registry; run it unsandboxed if the proxy refuses. This writes `package-lock.json`. Check that `npm ls react` shows a single `react@19.3.1`.

- [ ] **Step 2: Write the scaffold test**

`web/tests/scaffold.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the built page's CSP allows no inline or remote script and no plaintext ws beyond loopback", async () => {
  const { CSP, WEB_PORT } = await import("../vite.config.ts");
  assert.equal(WEB_PORT, 5180);
  assert.match(CSP, /script-src 'self';/);
  assert.doesNotMatch(CSP, /unsafe-eval|script-src[^;]*unsafe-inline|\*\.|https?:\/\/(?!127)/);
  assert.match(CSP, /object-src 'none'/);
  for (const ws of CSP.match(/ws:\/\/[^ ;]+/g)) assert.match(ws, /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\*$/);
});

test("the package pins exact versions only", () => {
  const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8"));
  for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(v, /^\d+\.\d+\.\d+$/, name);
});

test("no source uses raw HTML or dynamic code", () => {
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(join(WEB, "src"))) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
  }
});
```

If the strip-types import of `vite.config.ts` fails on Vite's own import graph, move `WEB_PORT` and `CSP` into `web/csp.ts`, import them from both `vite.config.ts` and the test, and keep the assertions.

- [ ] **Step 3: Run the tests and a build**

Run: `cd web && npm test && npm run build && grep -c 'Content-Security-Policy' dist/index.html`
Expected: 3 tests pass, the build succeeds, and the count is `1`.

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/package-lock.json web/tsconfig.json web/vite.config.ts web/index.html web/.gitignore web/src/env.d.ts web/src/main.tsx web/tests/scaffold.test.mjs
git commit -m "feat(web): add the web client package on 127.0.0.1:5180"
```

---

### Task 3: The Host API connection

**Parallel-safe:** yes (wave B, after 1 and 2).

**Files:**
- Create: `web/src/host-api/connection.ts`
- Test: `web/tests/connection.test.mjs`

**Interfaces:**
- Consumes the generated tables and types (Task 1).
- Produces:

```ts
export type ConnectionState =
  | { kind: "idle" } | { kind: "connecting" } | { kind: "needsPin" } | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number; inMs: number }
  | { kind: "failed"; code: HostApiErrorCode; message: string };
export class HostApiError extends Error { code; retryable; retryAfterMs }
export type HostEvent = /* {command, payload, rev, replyTo} discriminated by command */;
export interface TokenStore { get(): string | null; set(token: string | null): void }
export interface HostLink {            // what the chat controller needs (Task 5 fakes it)
  readonly capabilities: ReadonlySet<HostApiCapability>;
  send<C extends HostApiCommandName>(command: C, payload: HostApiRequest<C>): { id: string; done: Promise<HostApiResult<C>> };
  onEvent(fn: (e: HostEvent) => void): () => void;
  onResync(fn: () => void): () => void;
  onState(fn: (s: ConnectionState) => void): () => void;
}
export class HostConnection implements HostLink {
  constructor(o: HostConnectionOptions);   // url, clientName, clientVersion, tokens, createSocket?, timeoutMs?, backoffMs?, setTimer?, clearTimer?
  readonly state: ConnectionState; readonly hello: HostApiResult<"host.hello"> | null;
  connect(pin?: string): Promise<"ready" | "needsPin">;   // rejects HostApiError
  pair(pin: string): Promise<void>;
  close(): void;
  forget(): Promise<boolean>;              // true when the host confirmed the revoke
}
export const ORIGIN_HINT: string;
export const defaultBackoff: (attempt: number) => number;
```

**Required behaviour:**
- `connect` opens the socket and sends `host.hello` with `platform: "web"` and `apiVersions: [1]`.
  - A host without v1 gives `failed`, `internal`, "This host does not speak Host API v1."
  - `requiresAuth: false` goes straight to `ready`.
- With a stored token it sends `host.auth.token`.
  - A non-retryable `auth_failed` deletes the token and moves to `needsPin`.
  - A retryable error closes the socket, and the backoff retries.
- With no token it moves to `needsPin`. If `connect(pin)` was given a PIN, it then calls `pair(pin)`.
- A pairing error leaves the state at `needsPin` and rejects the `connect` promise with the host's error.
- The PIN is held only until its single `host.auth.pair` frame is sent.
- `send` refuses locally, without sending a frame:
  - `host_unreachable` when not `ready`;
  - `capability_unavailable` when the command's capability is not granted;
  - `invalid_payload` for a frame over 1 MiB.
- Correlation is by `replyTo`. An `error` frame rejects with `HostApiError(code, message ≤ 500, retryable, retryAfterMs)`; an unknown code becomes `internal`.
- Timeout (default 15 s):
  - An idempotent command is resent once with the same frame.
  - Otherwise, and after that one resend, it rejects with `host_unreachable`.
  - A non-idempotent command is never resent.
- Inbound frames are dropped when:
  - they are not strings, or longer than the frame cap;
  - they are not JSON, or not `apiVersion: 1`;
  - they are events with an unknown name, a non-object payload or no integer `rev`.
- `rev`:
  - The client tracks the maximum `rev` of every frame.
  - An event whose `rev` is more than `last + 1` fires `onResync` after it is delivered.
  - `rev` resets with each new socket, and every `ready` fires `onResync`.
- `host.capabilities` replaces the granted set (known names only) before listeners see the event.
- An unexpected close rejects every pending request with `host_unreachable`. Then:
  - with a token, the state is `reconnecting` and the client reopens after `backoffMs(attempt)`; the attempt count resets on `ready`;
  - without a token, the state is `idle` if the host had asked for a PIN, otherwise `failed` with `ORIGIN_HINT`;
  - `close()` stops everything and sets `idle`.

- [ ] **Step 1: Write the failing test**

`web/tests/connection.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { HostConnection, HostApiError, ORIGIN_HINT } from "../src/host-api/connection.ts";

const CAPS = ["host", "chat", "approvals"];
const RESULTS = {
  "host.hello": { hostName: "Desk", hostKind: "desktop", apiVersion: 1, apiVersions: [1], capabilities: CAPS, protocolVersion: 1, requiresAuth: true },
  "host.auth.token": { capabilities: CAPS },
  "host.auth.pair": { token: "t".repeat(43), capabilities: CAPS },
  "host.auth.revoke": { revoked: true },
  "chat.snapshot": { messages: [] },
  "chat.send": { accepted: true },
};

function harness({ token = null, script = {} } = {}) {
  let stored = token, rev = 0;
  const sockets = [], timers = [], sent = [];
  const tokens = { get: () => stored, set: (t) => { stored = t; } };
  const reply = (s, obj) => queueMicrotask(() => s.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) }));
  const host = (s, f) => {
    const handler = script[f.command];
    const out = handler ? handler(f) : { result: RESULTS[f.command] };
    if (out === null) return; // swallow: lets a test time out
    if (out.error) reply(s, { apiVersion: 1, id: `h-${++rev}`, replyTo: f.id, type: "error", error: out.error, ts: 1, rev });
    else reply(s, { apiVersion: 1, id: `h-${++rev}`, replyTo: f.id, type: "response", command: f.command, result: out.result, ts: 1, rev });
  };
  const createSocket = () => {
    const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send(text) { const f = JSON.parse(text); sent.push(f); host(s, f); },
      close() { s.readyState = 3; queueMicrotask(() => s.onclose?.()); } };
    sockets.push(s);
    queueMicrotask(() => { s.readyState = 1; s.onopen?.(); });
    return s;
  };
  const conn = new HostConnection({
    url: "ws://127.0.0.1:3016/host-api/v1", clientName: "LLM-IDE Web", clientVersion: "0.1.0", tokens, createSocket,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    backoffMs: (n) => n * 1000,
  });
  const runTimers = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
  const event = (s, command, payload, r, replyTo) => reply(s, { apiVersion: 1, id: `h-e${r}`, type: "event", command, payload, ts: 1, rev: r, ...(replyTo ? { replyTo } : {}) });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { conn, sockets, sent, timers, runTimers, event, reply, tick, token: () => stored };
}

test("hello then token auth reaches ready, fires one resync, and sends a well-formed hello", async () => {
  const h = harness({ token: "k".repeat(40) });
  let resyncs = 0; h.conn.onResync(() => resyncs++);
  assert.equal(await h.conn.connect(), "ready");
  const hello = h.sent[0];
  assert.deepEqual({ ...hello, id: undefined, ts: undefined }, { apiVersion: 1, id: undefined, type: "request", command: "host.hello", ts: undefined,
    payload: { clientName: "LLM-IDE Web", clientVersion: "0.1.0", platform: "web", apiVersions: [1] } });
  assert.match(hello.id, /^c-[0-9a-f-]{36}$/);
  assert.deepEqual(h.sent.map((f) => f.command), ["host.hello", "host.auth.token"]);
  assert.equal(resyncs, 1);
  assert.deepEqual([...h.conn.capabilities], CAPS);
});

test("no token: needsPin, then the PIN pairs once and the token is stored", async () => {
  const h = harness();
  assert.equal(await h.conn.connect(), "needsPin");
  await h.conn.pair("123456");
  assert.equal(h.conn.state.kind, "ready");
  assert.equal(h.token(), "t".repeat(43));
  assert.equal(h.sent.filter((f) => JSON.stringify(f).includes("123456")).length, 1, "the PIN travels in exactly one frame");
});

test("a wrong PIN rejects with auth_failed and stays at needsPin", async () => {
  const h = harness({ script: { "host.auth.pair": () => ({ error: { code: "auth_failed", message: "Wrong PIN.", retryable: false } }) } });
  await assert.rejects(h.conn.connect("000000"), (e) => e instanceof HostApiError && e.code === "auth_failed" && !e.retryable);
  assert.equal(h.conn.state.kind, "needsPin");
  assert.equal(h.token(), null);
});

test("a revoked token is deleted and the page asks for a PIN", async () => {
  const h = harness({ token: "k".repeat(40), script: { "host.auth.token": () => ({ error: { code: "auth_failed", message: "Revoked.", retryable: false } }) } });
  assert.equal(await h.conn.connect(), "needsPin");
  assert.equal(h.token(), null);
});

test("a host without v1 fails clearly", async () => {
  const h = harness({ script: { "host.hello": () => ({ result: { ...RESULTS["host.hello"], apiVersions: [2] } }) } });
  await assert.rejects(h.conn.connect(), (e) => e.code === "internal" && /does not speak Host API v1/.test(e.message));
  assert.equal(h.conn.state.kind, "failed");
});

test("send is gated locally by state and capability, without a frame", async () => {
  const h = harness({ token: "k".repeat(40) });
  await assert.rejects(h.conn.send("chat.snapshot", {}).done, (e) => e.code === "host_unreachable");
  await h.conn.connect();
  const before = h.sent.length;
  await assert.rejects(h.conn.send("toolApprovals.answer", { requestId: "r", commandId: "c", decision: "deny" }).done, (e) => e.code === "capability_unavailable");
  assert.equal(h.sent.length, before);
});

test("timeouts resend an idempotent command once and never a non-idempotent one", async () => {
  const h = harness({ token: "k".repeat(40), script: { "chat.snapshot": () => null, "chat.send": () => null } });
  await h.conn.connect();
  const snap = h.conn.send("chat.snapshot", { limit: 10 });
  const send = h.conn.send("chat.send", { text: "hi" });
  h.runTimers(); // first timeout: snapshot resent, send rejected
  await assert.rejects(send.done, (e) => e.code === "host_unreachable");
  assert.equal(h.sent.filter((f) => f.id === snap.id).length, 2);
  assert.equal(h.sent.filter((f) => f.id === send.id).length, 1);
  h.runTimers();
  await assert.rejects(snap.done, (e) => e.code === "host_unreachable");
});

test("events are delivered, a rev gap triggers resync, host.capabilities updates the set first", async () => {
  const h = harness({ token: "k".repeat(40) });
  await h.conn.connect();
  let resyncs = 0; h.conn.onResync(() => resyncs++);
  const seen = [];
  h.conn.onEvent((e) => seen.push([e.command, e.rev, [...h.conn.capabilities].includes("tool_approvals")]));
  const s = h.sockets[0];
  h.event(s, "chat.delta", { text: "a" }, 3, "c-1");
  h.event(s, "host.capabilities", { capabilities: [...CAPS, "tool_approvals", "bogus"] }, 4);
  await h.tick();
  assert.equal(resyncs, 0, "contiguous revs do not resync");
  h.event(s, "chat.delta", { text: "b" }, 9, "c-1");
  h.event(s, "nope.event", {}, 10);
  h.reply(s, "not json");
  await h.tick();
  assert.deepEqual(seen, [["chat.delta", 3, false], ["host.capabilities", 4, true], ["chat.delta", 9, true]]);
  assert.equal(resyncs, 1);
  assert.deepEqual([...h.conn.capabilities].sort(), [...CAPS, "tool_approvals"].sort());
});

test("an unexpected close rejects pending work, backs off, re-auths with the token and resyncs", async () => {
  const h = harness({ token: "k".repeat(40), script: { "chat.snapshot": () => null } });
  await h.conn.connect();
  let resyncs = 0; h.conn.onResync(() => resyncs++);
  const pending = h.conn.send("chat.snapshot", {});
  h.sockets[0].close();
  await assert.rejects(pending.done, (e) => e.code === "host_unreachable");
  assert.deepEqual(h.conn.state, { kind: "reconnecting", attempt: 1, inMs: 1000 });
  h.runTimers(); // the backoff timer reopens
  await h.tick(); await h.tick();
  assert.equal(h.conn.state.kind, "ready");
  assert.equal(h.sockets.length, 2);
  assert.equal(resyncs, 1);
});

test("a never-paired page that cannot connect shows the origin hint and does not retry", async () => {
  const h = harness();
  const p = h.conn.connect();
  h.sockets[0].onopen = null; // the handshake is refused before open (wrong URL, host down, origin not allowed)
  h.sockets[0].close();
  await assert.rejects(p, (e) => e.code === "host_unreachable");
  assert.deepEqual(h.conn.state, { kind: "failed", code: "host_unreachable", message: ORIGIN_HINT });
  assert.equal(h.timers.filter((t) => t.live).length, 0);
});

test("forget revokes with the stored token, deletes it and closes", async () => {
  const h = harness({ token: "k".repeat(40) });
  await h.conn.connect();
  assert.equal(await h.conn.forget(), true);
  assert.deepEqual(h.sent.at(-1).payload, { token: "k".repeat(40) });
  assert.equal(h.token(), null);
  assert.equal(h.conn.state.kind, "idle");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && node --test --experimental-strip-types tests/connection.test.mjs`
Expected: FAIL, `Cannot find module '../src/host-api/connection.ts'`.

- [ ] **Step 3: Implement**

`web/src/host-api/connection.ts`:

```ts
// Host API v1 client connection: one WebSocket, request/response correlation by client id, hello then token or PIN
// auth, pushed events with rev-gap resync, reconnect with backoff. Framework- and DOM-free: Node tests and the e2e
// drive it with the global WebSocket. Never logs frames (they can carry the token or the PIN).
import {
  HOST_API_CAPABILITIES, HOST_API_COMMANDS, HOST_API_ERROR_CODES, HOST_API_EVENT_NAMES, HOST_API_LIMITS, HOST_API_VERSION,
  type HostApiCapability, type HostApiCommandName, type HostApiErrorCode, type HostApiEventMap, type HostApiEventName,
  type HostApiRequest, type HostApiResult,
} from "./types.generated.ts";

export type ConnectionState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "needsPin" }
  | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number; inMs: number }
  | { kind: "failed"; code: HostApiErrorCode; message: string };

export class HostApiError extends Error {
  readonly code: HostApiErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(code: HostApiErrorCode, message: string, retryable = false, retryAfterMs: number | null = null) {
    super(message);
    this.name = "HostApiError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export type HostEvent = {
  [E in HostApiEventName]: { command: E; payload: HostApiEventMap[E]; rev: number; replyTo: string | null };
}[HostApiEventName];

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface TokenStore { get(): string | null; set(token: string | null): void }

export interface HostConnectionOptions {
  url: string;
  clientName: string;
  clientVersion: string;
  tokens: TokenStore;
  createSocket?: (url: string) => SocketLike;
  timeoutMs?: number;
  backoffMs?: (attempt: number) => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface HostLink {
  readonly capabilities: ReadonlySet<HostApiCapability>;
  send<C extends HostApiCommandName>(command: C, payload: HostApiRequest<C>): { id: string; done: Promise<HostApiResult<C>> };
  onEvent(fn: (e: HostEvent) => void): () => void;
  onResync(fn: () => void): () => void;
  onState(fn: (s: ConnectionState) => void): () => void;
}

export const ORIGIN_HINT =
  "Cannot reach the host. Check the address, that the desktop app runs with the Host API enabled, " +
  "and that this page's origin is listed in LLMIDE_HOST_API_WEB_ORIGINS.";
export const defaultBackoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt);

const EVENTS = new Set<string>(HOST_API_EVENT_NAMES);
const CAPS = new Set<string>(HOST_API_CAPABILITIES);
const CODES = new Set<string>(HOST_API_ERROR_CODES);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unreachable = (m: string) => new HostApiError("host_unreachable", m, true);
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

interface Pending { frame: string; idempotent: boolean; retried: boolean; timer: unknown; resolve: (r: never) => void; reject: (e: HostApiError) => void }
type Settle = { resolve: (r: "ready" | "needsPin") => void; reject: (e: HostApiError) => void };

export class HostConnection implements HostLink {
  #o: Required<HostConnectionOptions>;
  #socket: SocketLike | null = null;
  #state: ConnectionState = { kind: "idle" };
  #caps = new Set<HostApiCapability>();
  #pending = new Map<string, Pending>();
  #onEvent = new Set<(e: HostEvent) => void>();
  #onResync = new Set<() => void>();
  #onState = new Set<(s: ConnectionState) => void>();
  #rev = -1;
  #attempt = 0;
  #retryTimer: unknown = null;
  #wanted = false;
  #pin: string | null = null;
  #settle: Settle | null = null;
  #hello: HostApiResult<"host.hello"> | null = null;

  constructor(o: HostConnectionOptions) {
    this.#o = {
      timeoutMs: 15_000,
      backoffMs: defaultBackoff,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      ...o,
    } as Required<HostConnectionOptions>;
  }

  get state(): ConnectionState { return this.#state; }
  get capabilities(): ReadonlySet<HostApiCapability> { return this.#caps; }
  get hello(): HostApiResult<"host.hello"> | null { return this.#hello; }

  onEvent(fn: (e: HostEvent) => void) { this.#onEvent.add(fn); return () => { this.#onEvent.delete(fn); }; }
  onResync(fn: () => void) { this.#onResync.add(fn); return () => { this.#onResync.delete(fn); }; }
  onState(fn: (s: ConnectionState) => void) { this.#onState.add(fn); return () => { this.#onState.delete(fn); }; }

  connect(pin?: string): Promise<"ready" | "needsPin"> {
    this.#wanted = true;
    this.#pin = pin ?? null;
    const p = new Promise<"ready" | "needsPin">((resolve, reject) => { this.#settle = { resolve, reject }; });
    this.#open();
    return p;
  }

  async pair(pin: string): Promise<void> {
    if (this.#state.kind !== "needsPin") throw new HostApiError("denied", "Pairing needs a connected host that asked for a PIN.");
    const r = await this.#request("host.auth.pair", { pin }).done;
    this.#o.tokens.set(r.token);
    this.#caps = this.#known(r.capabilities);
    this.#ready();
  }

  send<C extends HostApiCommandName>(command: C, payload: HostApiRequest<C>): { id: string; done: Promise<HostApiResult<C>> } {
    if (this.#state.kind !== "ready") return { id: "", done: Promise.reject(unreachable("Not connected to the host.")) };
    if (!this.#caps.has(HOST_API_COMMANDS[command].capability)) {
      return { id: "", done: Promise.reject(new HostApiError("capability_unavailable", "This host does not serve that feature.")) };
    }
    return this.#request(command, payload);
  }

  close(): void {
    this.#wanted = false;
    this.#clearRetry();
    const s = this.#socket;
    this.#socket = null;
    this.#rejectAll("The connection was closed.");
    s?.close(1000);
    this.#setState({ kind: "idle" });
  }

  async forget(): Promise<boolean> {
    const token = this.#o.tokens.get();
    let revoked = false;
    if (token && this.#state.kind === "ready") {
      try { revoked = (await this.#request("host.auth.revoke", { token }).done).revoked; } catch { /* host gone: revoke it in desktop Settings */ }
    }
    this.#o.tokens.set(null);
    this.close();
    return revoked;
  }

  #open() {
    this.#clearRetry();
    this.#rev = -1;
    this.#setState({ kind: "connecting" });
    let s: SocketLike;
    try { s = this.#o.createSocket(this.#o.url); } catch { this.#lost(false); return; }
    this.#socket = s;
    let opened = false;
    s.onopen = () => { opened = true; void this.#handshake(); };
    s.onmessage = (e) => this.#receive(e.data);
    s.onclose = () => { if (this.#socket === s) this.#lost(opened); };
    s.onerror = () => {}; // a close always follows
  }

  async #handshake() {
    try {
      const hello = await this.#request("host.hello", {
        clientName: this.#o.clientName, clientVersion: this.#o.clientVersion, platform: "web", apiVersions: [HOST_API_VERSION],
      }).done;
      if (hello.apiVersion !== HOST_API_VERSION || !hello.apiVersions.includes(HOST_API_VERSION)) {
        return this.#fail(new HostApiError("internal", "This host does not speak Host API v1."));
      }
      this.#hello = hello;
      this.#caps = this.#known(hello.capabilities);
      if (!hello.requiresAuth) return this.#ready();
      const token = this.#o.tokens.get();
      if (token) {
        try {
          this.#caps = this.#known((await this.#request("host.auth.token", { token }).done).capabilities);
          return this.#ready();
        } catch (e) {
          if (!(e instanceof HostApiError) || e.code !== "auth_failed" || e.retryable) throw e;
          this.#o.tokens.set(null); // revoked or expired: pair again
        }
      }
      const pin = this.#pin;
      this.#pin = null;
      this.#setState({ kind: "needsPin" });
      if (!pin) return this.#resolve("needsPin");
      try { await this.pair(pin); } catch (e) { this.#reject(e instanceof HostApiError ? e : new HostApiError("internal", "Pairing failed.")); }
    } catch (e) {
      const err = e instanceof HostApiError ? e : new HostApiError("internal", "The host answered with something this page cannot read.");
      if (err.code === "host_unreachable") return; // #lost owns this path
      if (err.retryable && this.#o.tokens.get()) { this.#socket?.close(); return; } // throttled: back off and retry
      this.#fail(err);
    }
  }

  #ready() {
    this.#attempt = 0;
    this.#setState({ kind: "ready" });
    this.#resolve("ready");
    for (const fn of this.#onResync) fn();
  }

  #fail(err: HostApiError) {
    this.#wanted = false;
    const s = this.#socket;
    this.#socket = null;
    this.#rejectAll(err.message);
    s?.close(1000);
    this.#setState({ kind: "failed", code: err.code, message: err.message });
    this.#reject(err);
  }

  #lost(opened: boolean) {
    const askedPin = this.#state.kind === "needsPin";
    this.#socket = null;
    this.#rejectAll("The connection to the host closed.");
    this.#reject(unreachable(opened ? "The connection to the host closed." : ORIGIN_HINT));
    if (!this.#wanted) return this.#setState({ kind: "idle" });
    if (!this.#o.tokens.get()) {
      this.#wanted = false; // never paired: nothing to resume
      return this.#setState(askedPin ? { kind: "idle" } : { kind: "failed", code: "host_unreachable", message: ORIGIN_HINT });
    }
    this.#attempt += 1;
    const inMs = this.#o.backoffMs(this.#attempt);
    this.#setState({ kind: "reconnecting", attempt: this.#attempt, inMs });
    this.#retryTimer = this.#o.setTimer(() => { this.#retryTimer = null; this.#open(); }, inMs);
  }

  #request<C extends HostApiCommandName>(command: C, payload: HostApiRequest<C>): { id: string; done: Promise<HostApiResult<C>> } {
    const id = `c-${crypto.randomUUID()}`;
    const frame = JSON.stringify({ apiVersion: HOST_API_VERSION, id, type: "request", command, payload, ts: Date.now() });
    const done = new Promise<HostApiResult<C>>((resolve, reject) => {
      const s = this.#socket;
      if (!s || s.readyState !== 1) return reject(unreachable("Not connected to the host."));
      if (utf8Bytes(frame) > HOST_API_LIMITS.maxFrameBytes) return reject(new HostApiError("invalid_payload", "The message is larger than 1 MiB."));
      const p: Pending = { frame, idempotent: HOST_API_COMMANDS[command].idempotent, retried: false, timer: null, resolve: resolve as (r: never) => void, reject };
      this.#pending.set(id, p);
      this.#arm(id, p);
      s.send(frame);
    });
    return { id, done };
  }

  #arm(id: string, p: Pending) {
    p.timer = this.#o.setTimer(() => {
      if (p.idempotent && !p.retried && this.#socket?.readyState === 1) {
        p.retried = true;
        this.#socket.send(p.frame);
        return this.#arm(id, p);
      }
      this.#pending.delete(id);
      p.reject(unreachable("The host did not answer in time."));
    }, this.#o.timeoutMs);
  }

  #receive(data: unknown) {
    if (typeof data !== "string" || data.length > HOST_API_LIMITS.maxFrameBytes) return;
    let f: unknown;
    try { f = JSON.parse(data); } catch { return; }
    if (!isObj(f) || f.apiVersion !== HOST_API_VERSION) return;
    const rev = Number.isInteger(f.rev) && (f.rev as number) >= 0 ? (f.rev as number) : null;
    const replyTo = typeof f.replyTo === "string" ? f.replyTo : null;
    if (f.type === "response" || f.type === "error") {
      if (rev !== null) this.#rev = Math.max(this.#rev, rev);
      const p = replyTo ? this.#pending.get(replyTo) : undefined;
      if (!p || !replyTo) return;
      this.#pending.delete(replyTo);
      this.#o.clearTimer(p.timer);
      if (f.type === "response") {
        return isObj(f.result) ? p.resolve(f.result as never) : p.reject(new HostApiError("internal", "The host sent an unreadable reply."));
      }
      const e = isObj(f.error) ? f.error : {};
      const d = isObj(e.details) ? e.details : {};
      return p.reject(new HostApiError(
        CODES.has(e.code as string) ? (e.code as HostApiErrorCode) : "internal",
        typeof e.message === "string" && e.message ? e.message.slice(0, 500) : "The host refused the request.",
        e.retryable === true,
        Number.isInteger(d.retryAfterMs) ? (d.retryAfterMs as number) : null,
      ));
    }
    if (f.type !== "event" || typeof f.command !== "string" || !EVENTS.has(f.command) || !isObj(f.payload) || rev === null) return;
    const gap = this.#rev >= 0 && rev > this.#rev + 1;
    this.#rev = Math.max(this.#rev, rev);
    if (f.command === "host.capabilities" && Array.isArray(f.payload.capabilities)) this.#caps = this.#known(f.payload.capabilities);
    const ev = { command: f.command, payload: f.payload, rev, replyTo } as HostEvent;
    for (const fn of this.#onEvent) fn(ev);
    if (gap) for (const fn of this.#onResync) fn();
  }

  #known(list: readonly unknown[]): Set<HostApiCapability> {
    return new Set(list.filter((c): c is HostApiCapability => typeof c === "string" && CAPS.has(c)));
  }

  #rejectAll(message: string) {
    for (const p of this.#pending.values()) { this.#o.clearTimer(p.timer); p.reject(unreachable(message)); }
    this.#pending.clear();
  }

  #resolve(r: "ready" | "needsPin") { const s = this.#settle; this.#settle = null; s?.resolve(r); }
  #reject(e: HostApiError) { const s = this.#settle; this.#settle = null; s?.reject(e); }
  #clearRetry() { if (this.#retryTimer !== null) { this.#o.clearTimer(this.#retryTimer); this.#retryTimer = null; } }
  #setState(s: ConnectionState) { this.#state = s; for (const fn of this.#onState) fn(s); }
}
```

`crypto.randomUUID()` exists in Node 22 and in browsers on a secure context. `http://127.0.0.1` counts as one, and so does HTTPS later. Swallow the unhandled-rejection edge: `send` returns `Promise.reject(...)` only for callers that await it. If a test reports an unhandled rejection, attach `.catch(() => {})` to a copy before returning.

- [ ] **Step 4: Run the tests and the type-check**

Run: `cd web && node --test --experimental-strip-types tests/connection.test.mjs && npx tsc --noEmit -p .`
Expected: 11 tests pass and 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/host-api/connection.ts web/tests/connection.test.mjs
git commit -m "feat(web): connect to a Host API v1 host with pairing, resync and reconnect"
```

---

### Task 4: Host URL policy and the token store

**Parallel-safe:** yes (wave B, after 2). The files are disjoint from Tasks 3 and 5.

**Files:**
- Create: `web/src/host-api/url.ts`, `web/src/host-api/storage.ts`
- Test: `web/tests/url-storage.test.mjs`

**Interfaces:**
- `url.ts`:
  - `DEFAULT_HOST_URL = "ws://127.0.0.1:3016/host-api/v1"`.
  - `initialHostUrl(env?: string | undefined, last?: string | null): string`. The order is last-used URL, then `VITE_HOST_API_URL`, then the default; each is checked with `checkHostUrl`.
  - `checkHostUrl(raw: string, pageProtocol?: string): {ok: true, url} | {ok: false, reason}`. `pageProtocol` defaults to `globalThis.location?.protocol`.
- `storage.ts`:
  - `interface KeyValue { getItem; setItem; removeItem }`
  - `browserStorage(): KeyValue | null`
  - `tokenStoreFor(url, storage = browserStorage()): TokenStore`, which implements `TokenStore` from Task 3 structurally (no import needed)
  - `lastHostUrl(storage = browserStorage()): {get(): string | null, set(url): void}`

- [ ] **Step 1: Write the failing test**

`web/tests/url-storage.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHostUrl, initialHostUrl, DEFAULT_HOST_URL } from "../src/host-api/url.ts";
import { tokenStoreFor, lastHostUrl } from "../src/host-api/storage.ts";

test("loopback ws and any wss are accepted and normalised", () => {
  assert.deepEqual(checkHostUrl(" ws://127.0.0.1:3016/host-api/v1 ", "http:"), { ok: true, url: "ws://127.0.0.1:3016/host-api/v1" });
  for (const u of ["ws://localhost:3017/host-api/v1", "ws://[::1]:3016/host-api/v1", "wss://desk.example:3016/host-api/v1"]) {
    assert.equal(checkHostUrl(u, "http:").ok, true, u);
  }
});

test("everything else is refused with a reason", () => {
  const bad = {
    "ws://192.168.1.20:3016/host-api/v1": /wss:\/\//,
    "http://127.0.0.1:3016/host-api/v1": /ws:\/\/ or wss:\/\//,
    "ws://127.0.0.1:3016/other": /\/host-api\/v1/,
    "ws://u:p@127.0.0.1:3016/host-api/v1": /user, query or fragment/,
    "ws://127.0.0.1:3016/host-api/v1?t=1": /user, query or fragment/,
    "not a url": /ws:\/\/ or wss:\/\//,
  };
  for (const [u, re] of Object.entries(bad)) {
    const r = checkHostUrl(u, "http:");
    assert.equal(r.ok, false, u);
    assert.match(r.reason, re, u);
  }
  assert.match(checkHostUrl("ws://127.0.0.1:3016/host-api/v1", "https:").reason, /served over https/);
});

test("the initial URL prefers the last one, then the build variable, then the default", () => {
  assert.equal(initialHostUrl(undefined, null), DEFAULT_HOST_URL);
  assert.equal(initialHostUrl("wss://h.example:3016/host-api/v1", null), "wss://h.example:3016/host-api/v1");
  assert.equal(initialHostUrl("wss://h.example:3016/host-api/v1", "ws://127.0.0.1:3017/host-api/v1"), "ws://127.0.0.1:3017/host-api/v1");
  assert.equal(initialHostUrl("garbage", "also garbage"), DEFAULT_HOST_URL);
});

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };

test("tokens are per host URL and bounded", () => {
  const s = memory();
  const a = tokenStoreFor("ws://127.0.0.1:3016/host-api/v1", s);
  const b = tokenStoreFor("ws://127.0.0.1:3017/host-api/v1", s);
  a.set("a".repeat(40));
  assert.equal(a.get(), "a".repeat(40));
  assert.equal(b.get(), null);
  s.setItem("llmide.hostApi.v1.token:ws://127.0.0.1:3017/host-api/v1", "short");
  assert.equal(b.get(), null, "a malformed stored value is ignored");
  a.set(null);
  assert.equal(s.m.size, 1);
});

test("a throwing or missing storage keeps the token in memory for this page", () => {
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  for (const st of [throwing, null]) {
    const t = tokenStoreFor("ws://127.0.0.1:3016/host-api/v1", st);
    t.set("m".repeat(40));
    assert.equal(t.get(), "m".repeat(40));
    t.set(null);
    assert.equal(t.get(), null);
  }
  const last = lastHostUrl(memory());
  last.set("ws://127.0.0.1:3016/host-api/v1");
  assert.equal(last.get(), "ws://127.0.0.1:3016/host-api/v1");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && node --test --experimental-strip-types tests/url-storage.test.mjs`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement**

`web/src/host-api/url.ts`:

```ts
// The host address the user enters. Spec: TLS/WSS for non-loopback clients; plaintext only to this computer.
export const DEFAULT_HOST_URL = "ws://127.0.0.1:3016/host-api/v1";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function checkHostUrl(raw: string, pageProtocol: string | undefined = globalThis.location?.protocol): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: "Enter a ws:// or wss:// address." }; }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return { ok: false, reason: "The address must start with ws:// or wss://." };
  if (u.username || u.password || u.search || u.hash) return { ok: false, reason: "The address must not carry a user, query or fragment." };
  if (u.pathname !== "/host-api/v1") return { ok: false, reason: "The address must end in /host-api/v1." };
  if (u.protocol === "ws:" && !LOOPBACK.has(u.hostname)) {
    return { ok: false, reason: "Plain ws:// is allowed only to this computer (127.0.0.1 or localhost). Use wss:// for another host." };
  }
  if (u.protocol === "ws:" && pageProtocol === "https:") return { ok: false, reason: "This page is served over https, so the host must use wss://." };
  return { ok: true, url: `${u.protocol}//${u.host}${u.pathname}` };
}

export function initialHostUrl(env: string | undefined, last: string | null): string {
  for (const c of [last, env]) {
    if (!c) continue;
    const r = checkHostUrl(c);
    if (r.ok) return r.url;
  }
  return DEFAULT_HOST_URL;
}
```

`web/src/host-api/storage.ts`:

```ts
// Browser storage for the device token (spec: "token in Keychain/browser storage") and the last host URL.
// Every access is guarded: a private window or blocked site data falls back to memory for this page only.
export interface KeyValue { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export function browserStorage(): KeyValue | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const TOKEN_PREFIX = "llmide.hostApi.v1.token:";
const LAST_URL = "llmide.hostApi.v1.lastUrl";
const validToken = (v: unknown): v is string => typeof v === "string" && v.length >= 16 && v.length <= 512;

export function tokenStoreFor(url: string, storage: KeyValue | null = browserStorage()) {
  const key = TOKEN_PREFIX + url;
  let memory: string | null = null;
  return {
    get(): string | null {
      try { const v = storage?.getItem(key); if (validToken(v)) return v; } catch { /* fall back to memory */ }
      return memory;
    },
    set(token: string | null): void {
      memory = token;
      try { if (token) storage?.setItem(key, token); else storage?.removeItem(key); } catch { /* memory keeps it */ }
    },
  };
}

export function lastHostUrl(storage: KeyValue | null = browserStorage()) {
  return {
    get(): string | null { try { return storage?.getItem(LAST_URL) ?? null; } catch { return null; } },
    set(url: string): void { try { storage?.setItem(LAST_URL, url); } catch { /* not remembered */ } },
  };
}
```

- [ ] **Step 4: Run the tests and the type-check**

Run: `cd web && node --test --experimental-strip-types tests/url-storage.test.mjs && npx tsc --noEmit -p .`
Expected: 5 tests pass and 0 errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/host-api/url.ts web/src/host-api/storage.ts web/tests/url-storage.test.mjs
git commit -m "feat(web): check host addresses and keep the device token per host"
```

---

### Task 5: Chat reducer and controller

**Parallel-safe:** yes (wave B, after 1 and 2). It uses Task 3's `HostLink` and `HostEvent` types. If Task 3 has not landed yet, copy the two type declarations from Task 3's Interfaces into the import site temporarily and switch to the real import before committing. The tests use a fake link.

**Files:**
- Create: `web/src/chat/store.ts`, `web/src/chat/controller.ts`
- Test: `web/tests/chat-store.test.mjs`, `web/tests/chat-controller.test.mjs`

**Interfaces:**
- `store.ts` produces:
  - `MAX_MESSAGES = 500` and `MAX_REPLY_CHARS = 1_000_000`
  - `WebMessage {key, role, text, status: "done"|"streaming"|"error"|"cancelled"|"interrupted", error}`
  - `WebApproval` (a `question` or a `tool`, each with `submitting` and `error`)
  - `ChatState {messages, turn: string | null, approvals, notice, loaded, seq}`
  - `ChatAction`, `initialChatState` and `reduce(state, action)`
- `controller.ts` produces:
  - `MAX_SEND_CHARS = 100_000`
  - `createChatController(link: HostLink, {historyLimit = 200} = {})`, which returns:
    - `getState`, `subscribe(fn)` and `resync()` (single-flight `chat.snapshot`)
    - `send(text)`, `cancel()` and `clearHistory()`
    - `answerQuestion(requestId, answers)`, `declineQuestion(requestId)` (sends `chat.cancel`) and `answerTool(requestId, decision)`
    - `dispose()`

**Required behaviour (reducer):**
- `snapshot`:
  - The snapshot's messages replace the list, keeping the newest 500, each clamped to 100,000 characters.
  - While a turn runs, the turn's user line is re-appended when the snapshot does not end with it (the host stores the reply only when the turn ends), and then the live assistant message, so a resync never loses a streaming reply.
- `sent` appends the user line and an empty `streaming` assistant line, and sets `turn`.
- `chat.delta` with `replyTo === turn` appends to the live assistant line, capped at 1,000,000 characters.
- `chat.done` with `requestId === turn` sets `done`, or `cancelled` when `stopReason === "cancelled"`, and clears the turn's approvals.
- `chat.error` with `replyTo === turn` sets `error` with the message.
- `sendFailed` ends the turn with `error`.
- `connectionLost` ends a running turn as `interrupted` ("The connection closed; the host stopped this reply.") and clears all approvals.
- `approval.request` and `toolApproval.request` are kept only for the running turn's `commandId` and deduplicated by `requestId`. `approval.cleared` and `approvalCleared` remove by `requestId`.
- `capabilities` drops the question approvals without `approvals` and the tool approvals without `tool_approvals`.
- `cleared` empties messages and approvals.

**Required behaviour (controller):**
- `send`:
  - It trims the text and refuses an empty message or one sent while a turn runs.
  - A message over 100,000 characters gets the notice "Keep a message under 100,000 characters." and is not sent.
  - It dispatches `sent` synchronously right after `link.send` returns the id, before any event can arrive.
  - A rejected `done`, or `accepted: false`, gives `sendFailed`.
- Event and resync wiring:
  - `link.onEvent` dispatches each event. On `host.capabilities` it also dispatches `capabilities` from `link.capabilities`.
  - `link.onResync` calls `resync()`, which also re-dispatches `capabilities`.
  - `link.onState` dispatches `connectionLost` on `reconnecting`, `idle` and `failed`.
- `clearHistory` dispatches `cleared` only on `{cleared: true}`. A host refusal (such as `denied`) becomes the notice text.
- The answer functions mark the card `submitting`, remove it on success, and set its `error` on failure.

- [ ] **Step 1: Write the failing tests**

`web/tests/chat-store.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, initialChatState as S0 } from "../src/chat/store.ts";

const ev = (command, payload, replyTo = null, rev = 1) => ({ type: "event", event: { command, payload, rev, replyTo } });
const run = (...actions) => actions.reduce(reduce, S0);
const Q = [{ question: "Pick?", multiSelect: false, options: [{ label: "Yes" }] }];

test("a turn streams into one assistant line and ends done", () => {
  const s = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("chat.delta", { text: "Hel" }, "c-1"), ev("chat.delta", { text: "lo" }, "c-1"), ev("chat.done", { requestId: "c-1" }, "c-1"));
  assert.deepEqual(s.messages.map((m) => [m.role, m.text, m.status]), [["user", "hi", "done"], ["assistant", "Hello", "done"]]);
  assert.equal(s.turn, null);
});

test("deltas for another command are ignored; cancel and error end the turn", () => {
  const base = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("chat.delta", { text: "x" }, "c-other"));
  assert.equal(base.messages.at(-1).text, "");
  assert.equal(reduce(base, ev("chat.done", { requestId: "c-1", stopReason: "cancelled" }, "c-1")).messages.at(-1).status, "cancelled");
  const err = reduce(base, ev("chat.error", { message: "boom", retryable: true }, "c-1"));
  assert.deepEqual([err.messages.at(-1).status, err.messages.at(-1).error, err.turn], ["error", "boom", null]);
});

test("a snapshot during a turn keeps the live reply and the asked line", () => {
  const live = run({ type: "sent", commandId: "c-1", text: "q2" }, ev("chat.delta", { text: "part" }, "c-1"));
  const s = reduce(live, { type: "snapshot", messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }] });
  assert.deepEqual(s.messages.map((m) => [m.text, m.status]), [["q1", "done"], ["a1", "done"], ["q2", "done"], ["part", "streaming"]]);
  const again = reduce(live, { type: "snapshot", messages: [{ role: "user", content: "q2" }] });
  assert.deepEqual(again.messages.map((m) => m.text), ["q2", "part"], "no duplicate user line");
  assert.equal(new Set(s.messages.map((m) => m.key)).size, s.messages.length, "keys stay unique");
});

test("snapshots are capped at 500 and clamp content", () => {
  const msgs = Array.from({ length: 600 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i === 599 ? "x".repeat(200_000) : `m${i}` }));
  const s = reduce(S0, { type: "snapshot", messages: msgs });
  assert.equal(s.messages.length, 500);
  assert.equal(s.messages.at(-1).text.length, 100_000);
  assert.equal(s.loaded, true);
});

test("approvals belong to the running turn, dedupe, clear, and follow capabilities", () => {
  let s = run({ type: "sent", commandId: "c-1", text: "hi" },
    ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: Q }, "c-1"),
    ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: Q }, "c-1"),
    ev("approval.request", { requestId: "r-9", commandId: "c-other", questions: Q }),
    ev("toolApproval.request", { requestId: "r-2", commandId: "c-1", toolName: "Edit", summary: "edit a.txt", truncated: false }, "c-1"));
  assert.deepEqual(s.approvals.map((a) => [a.kind, a.requestId]), [["question", "r-1"], ["tool", "r-2"]]);
  s = reduce(s, { type: "capabilities", capabilities: new Set(["host", "chat", "approvals"]) });
  assert.deepEqual(s.approvals.map((a) => a.requestId), ["r-1"]);
  s = reduce(s, ev("approval.cleared", { requestId: "r-1", commandId: "c-1", reason: "answer" }));
  assert.equal(s.approvals.length, 0);
});

test("a lost connection interrupts the reply and drops every approval", () => {
  const s = run({ type: "sent", commandId: "c-1", text: "hi" }, ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: Q }, "c-1"), { type: "connectionLost" });
  assert.equal(s.messages.at(-1).status, "interrupted");
  assert.match(s.messages.at(-1).error, /connection closed/);
  assert.deepEqual([s.turn, s.approvals.length], [null, 0]);
});
```

`web/tests/chat-controller.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatController, MAX_SEND_CHARS } from "../src/chat/controller.ts";

function fakeLink(results = {}) {
  const ls = { event: new Set(), resync: new Set(), state: new Set() };
  const calls = [];
  let n = 0;
  return {
    capabilities: new Set(["host", "chat", "approvals"]),
    calls,
    send(command, payload) {
      const id = `c-${++n}`;
      calls.push({ id, command, payload });
      const r = results[command];
      return { id, done: r instanceof Error ? Promise.reject(r) : Promise.resolve(typeof r === "function" ? r(payload) : r ?? {}) };
    },
    onEvent: (fn) => (ls.event.add(fn), () => ls.event.delete(fn)),
    onResync: (fn) => (ls.resync.add(fn), () => ls.resync.delete(fn)),
    onState: (fn) => (ls.state.add(fn), () => ls.state.delete(fn)),
    emit: (e) => ls.event.forEach((fn) => fn(e)),
    resync: () => ls.resync.forEach((fn) => fn()),
    state: (s) => ls.state.forEach((fn) => fn(s)),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("send dispatches the turn under the command id and the events land on it", async () => {
  const link = fakeLink({ "chat.send": { accepted: true, requestId: "c-1" } });
  const chat = createChatController(link);
  await chat.send("  hi  ");
  assert.deepEqual(link.calls[0], { id: "c-1", command: "chat.send", payload: { text: "hi" } });
  link.emit({ command: "chat.delta", payload: { text: "yo" }, rev: 1, replyTo: "c-1" });
  link.emit({ command: "chat.done", payload: { requestId: "c-1" }, rev: 2, replyTo: "c-1" });
  assert.deepEqual(chat.getState().messages.map((m) => m.text), ["hi", "yo"]);
  assert.equal(chat.getState().turn, null);
});

test("an oversized message is refused before it is sent; a second send during a turn is ignored", async () => {
  const link = fakeLink({ "chat.send": { accepted: true } });
  const chat = createChatController(link);
  await chat.send("x".repeat(MAX_SEND_CHARS + 1));
  assert.equal(link.calls.length, 0);
  assert.match(chat.getState().notice, /under 100,000/);
  await chat.send("a");
  await chat.send("b");
  assert.equal(link.calls.length, 1);
});

test("resync is single-flight and fires on the link's resync", async () => {
  let release;
  const link = fakeLink({ "chat.snapshot": () => new Promise((r) => { release = () => r({ messages: [{ role: "user", content: "old" }] }); }) });
  const chat = createChatController(link);
  link.resync(); link.resync();
  assert.equal(link.calls.filter((c) => c.command === "chat.snapshot").length, 1);
  assert.deepEqual(link.calls[0].payload, { limit: 200 });
  release(); await tick();
  assert.deepEqual(chat.getState().messages.map((m) => m.text), ["old"]);
});

test("a connection drop interrupts; a refused clear shows the host's message", async () => {
  const denied = Object.assign(new Error("This host does not allow clearing chat history from a paired device."), { code: "denied" });
  const link = fakeLink({ "chat.send": { accepted: true }, "chat.history.clear": denied });
  const chat = createChatController(link);
  await chat.send("hi");
  link.state({ kind: "reconnecting", attempt: 1, inMs: 1000 });
  assert.equal(chat.getState().messages.at(-1).status, "interrupted");
  await chat.clearHistory();
  assert.match(chat.getState().notice, /does not allow clearing/);
});

test("answers go out with the card's command id; decline cancels the turn", async () => {
  const link = fakeLink({ "chat.send": { accepted: true }, "approvals.answer": { accepted: true }, "chat.cancel": { cancelled: true } });
  const chat = createChatController(link);
  await chat.send("hi");
  link.emit({ command: "approval.request", payload: { requestId: "r-1", commandId: "c-1", questions: [{ question: "Pick?", multiSelect: false, options: [{ label: "Yes" }] }] }, rev: 1, replyTo: "c-1" });
  await chat.answerQuestion("r-1", { "Pick?": "Yes" });
  assert.deepEqual(link.calls.at(-1), { id: "c-2", command: "approvals.answer", payload: { requestId: "r-1", commandId: "c-1", answers: { "Pick?": "Yes" } } });
  assert.equal(chat.getState().approvals.length, 0);
  link.emit({ command: "approval.request", payload: { requestId: "r-2", commandId: "c-1", questions: [{ question: "Again?", multiSelect: false, options: [{ label: "No" }] }] }, rev: 2, replyTo: "c-1" });
  await chat.declineQuestion("r-2");
  assert.equal(link.calls.at(-1).command, "chat.cancel");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && node --test --experimental-strip-types tests/chat-store.test.mjs tests/chat-controller.test.mjs`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement**

`web/src/chat/store.ts`:

```ts
// The web chat as a pure reducer over Host API v1 events. Host text is data: clamped here, rendered as text by React.
import type { HostApiCapability, HostApiEventMap } from "../host-api/types.generated.ts";
import type { HostEvent } from "../host-api/connection.ts";

export const MAX_MESSAGES = 500;
export const MAX_REPLY_CHARS = 1_000_000;
const MAX_CONTENT = 100_000;

export type MessageStatus = "done" | "streaming" | "error" | "cancelled" | "interrupted";
export interface WebMessage { key: string; role: "user" | "assistant"; text: string; status: MessageStatus; error: string | null }
type Questions = HostApiEventMap["approval.request"]["questions"];
interface CardState { requestId: string; commandId: string; submitting: boolean; error: string | null }
export type WebApproval =
  | (CardState & { kind: "question"; questions: Questions })
  | (CardState & { kind: "tool"; toolName: string; summary: string | null; filePath: string | null; truncated: boolean });
export interface ChatState {
  messages: readonly WebMessage[];
  turn: string | null;
  approvals: readonly WebApproval[];
  notice: string | null;
  loaded: boolean;
  seq: number;
}

export type ChatAction =
  | { type: "snapshot"; messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> }
  | { type: "sent"; commandId: string; text: string }
  | { type: "sendFailed"; commandId: string; message: string }
  | { type: "event"; event: HostEvent }
  | { type: "connectionLost" }
  | { type: "capabilities"; capabilities: ReadonlySet<HostApiCapability> }
  | { type: "approvalSubmitting"; requestId: string }
  | { type: "approvalFailed"; requestId: string; message: string }
  | { type: "approvalCleared"; requestId: string }
  | { type: "cleared" }
  | { type: "notice"; text: string | null };

export const initialChatState: ChatState = { messages: [], turn: null, approvals: [], notice: null, loaded: false, seq: 0 };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const cap = (m: WebMessage[]) => (m.length > MAX_MESSAGES ? m.slice(-MAX_MESSAGES) : m);
const lastIndex = <T>(a: readonly T[], p: (x: T) => boolean) => { for (let i = a.length - 1; i >= 0; i--) if (p(a[i])) return i; return -1; };
const isLive = (m: WebMessage) => m.role === "assistant" && m.status === "streaming";

function patchLive(s: ChatState, fn: (m: WebMessage) => WebMessage): ChatState {
  const i = lastIndex(s.messages, isLive);
  if (i < 0) return s;
  const messages = s.messages.slice();
  messages[i] = fn(messages[i]);
  return { ...s, messages };
}

function endTurn(s: ChatState, status: MessageStatus, error: string | null): ChatState {
  const turn = s.turn;
  return { ...patchLive(s, (m) => ({ ...m, status, error })), turn: null, approvals: s.approvals.filter((a) => a.commandId !== turn) };
}

const patchCard = (s: ChatState, requestId: string, patch: Partial<CardState>): ChatState =>
  ({ ...s, approvals: s.approvals.map((a) => (a.requestId === requestId ? { ...a, ...patch } : a)) });

export function reduce(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "snapshot": {
      let seq = s.seq;
      const msgs: WebMessage[] = a.messages.slice(-MAX_MESSAGES).map((m) => ({
        key: `m-${++seq}`, role: m.role === "user" ? "user" : "assistant", text: str(m.content, MAX_CONTENT), status: "done", error: null,
      }));
      if (s.turn) {
        const live = s.messages[lastIndex(s.messages, isLive)];
        const asked = s.messages[lastIndex(s.messages, (m) => m.role === "user")];
        // The host stores the user line when the turn starts and the reply only when it ends.
        if (asked && msgs.at(-1)?.text !== asked.text) msgs.push({ ...asked, key: `m-${++seq}` });
        if (live) msgs.push({ ...live, key: `m-${++seq}` });
      }
      return { ...s, seq, messages: cap(msgs), loaded: true };
    }
    case "sent": {
      const seq = s.seq + 2;
      return {
        ...s, seq, turn: a.commandId, notice: null,
        messages: cap([...s.messages,
          { key: `m-${seq - 1}`, role: "user", text: a.text, status: "done", error: null },
          { key: `m-${seq}`, role: "assistant", text: "", status: "streaming", error: null }]),
      };
    }
    case "sendFailed": return a.commandId === s.turn ? endTurn(s, "error", a.message) : s;
    case "connectionLost":
      return { ...(s.turn ? endTurn(s, "interrupted", "The connection closed; the host stopped this reply.") : s), approvals: [] };
    case "event": return onEvent(s, a.event);
    case "capabilities":
      return { ...s, approvals: s.approvals.filter((x) => a.capabilities.has(x.kind === "tool" ? "tool_approvals" : "approvals")) };
    case "approvalSubmitting": return patchCard(s, a.requestId, { submitting: true, error: null });
    case "approvalFailed": return patchCard(s, a.requestId, { submitting: false, error: a.message });
    case "approvalCleared": return { ...s, approvals: s.approvals.filter((x) => x.requestId !== a.requestId) };
    case "cleared": return { ...s, messages: [], approvals: [] };
    case "notice": return { ...s, notice: a.text };
  }
}

function onEvent(s: ChatState, e: HostEvent): ChatState {
  switch (e.command) {
    case "chat.delta":
      return e.replyTo !== null && e.replyTo === s.turn
        ? patchLive(s, (m) => ({ ...m, text: (m.text + str(e.payload.text, MAX_CONTENT)).slice(0, MAX_REPLY_CHARS) }))
        : s;
    case "chat.done":
      return e.payload.requestId === s.turn ? endTurn(s, e.payload.stopReason === "cancelled" ? "cancelled" : "done", null) : s;
    case "chat.error":
      return e.replyTo !== null && e.replyTo === s.turn ? endTurn(s, "error", str(e.payload.message, 2000) || "The reply failed.") : s;
    case "approval.request": {
      const p = e.payload;
      if (p.commandId !== s.turn || !Array.isArray(p.questions) || s.approvals.some((x) => x.requestId === p.requestId)) return s;
      return { ...s, approvals: [...s.approvals, { kind: "question", requestId: p.requestId, commandId: p.commandId, questions: p.questions, submitting: false, error: null }] };
    }
    case "toolApproval.request": {
      const p = e.payload;
      if (p.commandId !== s.turn || s.approvals.some((x) => x.requestId === p.requestId)) return s;
      return { ...s, approvals: [...s.approvals, {
        kind: "tool", requestId: p.requestId, commandId: p.commandId, toolName: str(p.toolName, 200) || "tool",
        summary: typeof p.summary === "string" ? p.summary.slice(0, 2000) : null,
        filePath: typeof p.filePath === "string" ? p.filePath.slice(0, 1000) : null,
        truncated: p.truncated === true, submitting: false, error: null,
      }] };
    }
    case "approval.cleared": return { ...s, approvals: s.approvals.filter((x) => x.requestId !== e.payload.requestId) };
    case "host.capabilities": return s; // the controller dispatches "capabilities" from the connection's parsed set
  }
}
```

Check `toolApproval.request`'s `filePath` bound in `events.schema.json` and use it instead of 1000 if it differs.

`web/src/chat/controller.ts`:

```ts
// Binds a HostLink (the connection, or a fake in tests) to the chat reducer. No React here.
import type { HostLink } from "../host-api/connection.ts";
import { initialChatState, reduce, type ChatAction, type ChatState } from "./store.ts";

export const MAX_SEND_CHARS = 100_000; // chat.send.text maxLength
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");

export function createChatController(link: HostLink, { historyLimit = 200 }: { historyLimit?: number } = {}) {
  let state: ChatState = initialChatState;
  const subs = new Set<() => void>();
  const dispatch = (a: ChatAction) => { state = reduce(state, a); for (const fn of subs) fn(); };
  let resyncing: Promise<void> | null = null;

  const resync = (): Promise<void> => (resyncing ??= (async () => {
    try {
      const r = await link.send("chat.snapshot", { limit: historyLimit }).done;
      dispatch({ type: "snapshot", messages: r.messages });
      dispatch({ type: "capabilities", capabilities: link.capabilities });
    } catch (e) {
      dispatch({ type: "notice", text: messageOf(e) });
    } finally {
      resyncing = null;
    }
  })());

  const answer = async (requestId: string, go: (commandId: string) => Promise<unknown>) => {
    const card = state.approvals.find((x) => x.requestId === requestId);
    if (!card || card.submitting) return;
    dispatch({ type: "approvalSubmitting", requestId });
    try { await go(card.commandId); dispatch({ type: "approvalCleared", requestId }); }
    catch (e) { dispatch({ type: "approvalFailed", requestId, message: messageOf(e) }); }
  };

  const offs = [
    link.onEvent((event) => {
      dispatch({ type: "event", event });
      if (event.command === "host.capabilities") dispatch({ type: "capabilities", capabilities: link.capabilities });
    }),
    link.onResync(() => { void resync(); }),
    link.onState((s) => { if (s.kind === "reconnecting" || s.kind === "idle" || s.kind === "failed") dispatch({ type: "connectionLost" }); }),
  ];

  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    resync,
    async send(text: string) {
      const t = text.trim();
      if (!t || state.turn) return;
      if (t.length > MAX_SEND_CHARS) return dispatch({ type: "notice", text: "Keep a message under 100,000 characters." });
      const { id, done } = link.send("chat.send", { text: t });
      dispatch({ type: "sent", commandId: id, text: t });
      try {
        const r = await done;
        if (!r.accepted) dispatch({ type: "sendFailed", commandId: id, message: "The host did not accept the message." });
      } catch (e) {
        dispatch({ type: "sendFailed", commandId: id, message: messageOf(e) });
      }
    },
    async cancel() {
      if (!state.turn) return;
      try { await link.send("chat.cancel", {}).done; } catch (e) { dispatch({ type: "notice", text: messageOf(e) }); }
    },
    async clearHistory() {
      if (state.turn) return;
      try { if ((await link.send("chat.history.clear", {}).done).cleared) dispatch({ type: "cleared" }); }
      catch (e) { dispatch({ type: "notice", text: messageOf(e) }); }
    },
    answerQuestion: (requestId: string, answers: Record<string, string>) =>
      answer(requestId, (commandId) => link.send("approvals.answer", { requestId, commandId, answers }).done),
    // v1 has no decline: stopping the reply is the honest equivalent (the host clears the question).
    declineQuestion: (requestId: string) => answer(requestId, () => link.send("chat.cancel", {}).done),
    answerTool: (requestId: string, decision: "allow_once" | "deny") =>
      answer(requestId, (commandId) => link.send("toolApprovals.answer", { requestId, commandId, decision }).done),
    dispose() { for (const off of offs) off(); subs.clear(); },
  };
}

export type ChatController = ReturnType<typeof createChatController>;
```

- [ ] **Step 4: Run the tests and the type-check**

Run: `cd web && node --test --experimental-strip-types tests/chat-store.test.mjs tests/chat-controller.test.mjs && npx tsc --noEmit -p .`
Expected: 11 tests pass and 0 errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/chat/store.ts web/src/chat/controller.ts web/tests/chat-store.test.mjs web/tests/chat-controller.test.mjs
git commit -m "feat(web): reduce Host API chat events into a bounded chat state"
```

---

### Task 6: Pairing, chat and approval screens

**Parallel-safe:** with Task 8 (wave C, after 3, 4 and 5).

**Files:**
- Create: `web/src/App.tsx`, `web/src/screens/PairingScreen.tsx`, `web/src/screens/WebChat.tsx`, `web/src/screens/ToolApprovalCard.tsx`, `web/src/web.css`
- Modify: `web/src/main.tsx` (render `<App />`)
- Test: `web/tests/helpers.mjs`, `web/tests/ui-entry.ts`, `web/tests/screens.test.mjs`

**Interfaces:**
- Consumes:
  - `HostConnection`, `checkHostUrl`, `initialHostUrl`, `tokenStoreFor`, `lastHostUrl` and `createChatController`
  - From the kit: `StatusBanner`, `Chip` and `applyTheme`
  - From `@llmide/screens/chat`: `MarkdownView.tsx` (`Markdown`), `Composer.tsx` (`Composer`) and `approvals/QuestionCard.tsx` (`QuestionCard`), plus their CSS (`chat.css`, `approvals/approvals.css`)
- Produces, all presentational and driven by props so server rendering can test them:
  - `PairingScreen({initialUrl, busy, error, revokedNotice, onSubmit(url, pin)})`
  - `WebChat({hostName, connection: ConnectionState, capabilities, state: ChatState, onSend, onStop, onClear, onForget, onAnswer, onDecline, onTool})`
  - `ToolApprovalCard({approval, onDecide})`
  - `App` owns the connection and controller and uses `useSyncExternalStore(controller.subscribe, controller.getState)`.

**Required behaviour:**
- **`PairingScreen`:**
  - A form with a labelled **Host address** input (`type="url"`) and a **Pairing PIN** input (`inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength={6}`, `pattern="[0-9]{6}"`).
  - It checks the address with `checkHostUrl` and the PIN with `/^[0-9]{6}$/`, and shows each problem in a `StatusBanner` (`error`).
  - A help line: "Show the PIN in the desktop app: Settings → Host API pairing. This page (`{location.origin}`) must be listed in `LLMIDE_HOST_API_WEB_ORIGINS`."
  - The PIN lives in component state only and is cleared after submit.
- **`App`:**
  - On load it uses `lastHostUrl().get()`. If that URL has a stored token, it connects without a PIN; otherwise it shows `PairingScreen`.
  - `onSubmit(url, pin)`:
    - It creates `HostConnection({url, clientName: "LLM-IDE Web", clientVersion: __APP_VERSION__, tokens: tokenStoreFor(url)})` and a controller, then awaits `connect(pin)`.
    - On `"ready"` it saves `lastHostUrl` and shows `WebChat`.
    - On a rejection it closes that connection and shows the error. An `auth_failed` error reads "Wrong or expired PIN. Show a new one in the desktop app's Settings."
  - When a stored-token connect resolves `"needsPin"` (revoked or expired), it shows `PairingScreen` with `revokedNotice`: "This browser's pairing was revoked or expired. Enter a new PIN."
  - `onForget` calls `connection.forget()` and returns to `PairingScreen`. If the revoke was not confirmed, it adds the notice "Revoke this browser in the desktop app's Settings as well."
  - It disposes the controller and closes the connection on unmount.
- **`WebChat`:**
  - **Header:** the host name, then a `Chip` with the connection state ("Connected", "Reconnecting in N s", "Offline"), then **Clear history** (hidden while a turn runs), then **Forget this host**.
  - **Banners:** `state.notice` as an `info` `StatusBanner`, and a `failed` connection as `error`.
  - **Message list:** the newest 50 messages, with a **Show older** button that adds 50 (decision 10).
    - User text is plain text.
    - Assistant text goes through `Markdown` with `onOpenLink={(href) => window.open(href, "_blank", "noopener,noreferrer")}`, and only when `href` starts with `https://` or `http://`.
    - Status lines: `streaming` shows "…", `cancelled` "Stopped.", `error` and `interrupted` show `m.error`.
  - **Approvals**, above the composer:
    - Each question goes through `QuestionCard`, mapped as `{requestId, kind: "AskUserQuestion", questions}`, with `ui={{phase: a.submitting ? "submitting" : "idle", error: a.error, shown: "", confirmingRule: false}}`.
    - Its `onDecline` is `onDecline(requestId)`. Add a one-line note under the card: "Declining stops the reply."
    - Tool approvals go through `ToolApprovalCard`, rendered only while `capabilities.has("tool_approvals")`.
  - **Composer:** `Composer` with `busy={state.turn !== null}`, `aborting={false}`, `queue={[]}`, `history` set to the past user texts, `onStop`, `onDropQueued={() => {}}`, no `onAttach` and no `extras`. Pass `disabledReason` while not `ready` ("Not connected"), or when `chat` is not granted ("This host does not serve chat"; capability gating, so no dead screen).
- **`ToolApprovalCard`:** a `role="group"` labelled "The assistant wants to use a tool". It shows `toolName`, then `filePath` if any, then `summary` in `<pre>` as text, then "(shortened)" when `truncated`. The buttons are **Allow once** and **Deny**, both disabled while `submitting`. `error` goes in a `StatusBanner`. There is no "always allow".
- **`web.css`:** layout only (a column, a max width of 860 px, 16 px side gutters, phone-width safe), using `--tok-*` variables only.

- [ ] **Step 1: Write the failing server-render tests**

`web/tests/helpers.mjs` bundles the screens with esbuild into `web/node_modules/.cache/ui-tests/`. It lives there so that `react` resolves to the web package's own copy:

```js
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REPO = resolve(WEB, "..");
const require = createRequire(join(WEB, "package.json"));
export const h = require("react").createElement;
export const html = require("react-dom/server").renderToStaticMarkup;

export async function loadUi() {
  const dir = join(WEB, "node_modules/.cache/ui-tests");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, `ui-${process.pid}.mjs`);
  await build({
    entryPoints: [join(HERE, "ui-entry.ts")], outfile, bundle: true, format: "esm", platform: "node", packages: "external",
    jsx: "automatic", logLevel: "silent", loader: { ".css": "empty" },
    alias: { "@llmide/ui-kit": join(REPO, "ui/kit/src/index.ts"), "@llmide/screens": join(REPO, "ui/screens") },
    define: { __APP_VERSION__: '"test"' },
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}
```

`web/tests/ui-entry.ts`:

```ts
export { PairingScreen } from "../src/screens/PairingScreen.tsx";
export { WebChat } from "../src/screens/WebChat.tsx";
export { ToolApprovalCard } from "../src/screens/ToolApprovalCard.tsx";
export { reduce, initialChatState } from "../src/chat/store.ts";
```

`web/tests/screens.test.mjs`:

```js
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadUi, h, html } from "./helpers.mjs";

let UI;
before(async () => { UI = await loadUi(); });
const noop = () => {};
const caps = (...c) => new Set(["host", ...c]);
const chatProps = (state, extra = {}) => ({ hostName: "Desk", connection: { kind: "ready" }, capabilities: caps("chat", "approvals"), state,
  onSend: noop, onStop: noop, onClear: noop, onForget: noop, onAnswer: noop, onDecline: noop, onTool: noop, ...extra });
const ev = (command, payload, replyTo = "c-1") => ({ type: "event", event: { command, payload, rev: 1, replyTo } });

test("pairing: labelled address and PIN inputs, the origin hint, no stored PIN", () => {
  const out = html(h(UI.PairingScreen, { initialUrl: "ws://127.0.0.1:3016/host-api/v1", busy: false, error: null, revokedNotice: null, onSubmit: noop }));
  assert.match(out, /<label[^>]*>[^<]*Host address/);
  assert.match(out, /inputMode="numeric"|inputmode="numeric"/);
  assert.match(out, /autoComplete="one-time-code"|autocomplete="one-time-code"/);
  assert.match(out, /LLMIDE_HOST_API_WEB_ORIGINS/);
  assert.match(out, /value="ws:\/\/127\.0\.0\.1:3016\/host-api\/v1"/);
});

test("chat renders host text as text, never as markup", () => {
  const s = [{ type: "sent", commandId: "c-1", text: "<b>hi</b>" }, ev("chat.delta", { text: "<img src=x onerror=alert(1)>" }), ev("chat.done", { requestId: "c-1" })]
    .reduce(UI.reduce, UI.initialChatState);
  const out = html(h(UI.WebChat, chatProps(s)));
  assert.doesNotMatch(out, /<img|<b>hi/);
  assert.match(out, /&lt;b&gt;hi&lt;\/b&gt;/);
});

test("tool approvals appear only with the capability, with Allow once and Deny and no always-allow", () => {
  const s = [{ type: "sent", commandId: "c-1", text: "hi" },
    ev("toolApproval.request", { requestId: "r-1", commandId: "c-1", toolName: "Edit", summary: "edit a.txt", truncated: true })].reduce(UI.reduce, UI.initialChatState);
  assert.doesNotMatch(html(h(UI.WebChat, chatProps(s))), /Allow once/);
  const out = html(h(UI.WebChat, chatProps(s, { capabilities: caps("chat", "approvals", "tool_approvals") })));
  assert.match(out, /Allow once/);
  assert.match(out, /Deny/);
  assert.match(out, /shortened/);
  assert.doesNotMatch(out, /[Aa]lways/);
});

test("a question renders through the shared QuestionCard with the decline note", () => {
  const s = [{ type: "sent", commandId: "c-1", text: "hi" },
    ev("approval.request", { requestId: "r-1", commandId: "c-1", questions: [{ question: "Pick one?", multiSelect: false, options: [{ label: "Yes" }] }] })]
    .reduce(UI.reduce, UI.initialChatState);
  const out = html(h(UI.WebChat, chatProps(s)));
  assert.match(out, /Pick one\?/);
  assert.match(out, /Declining stops the reply/);
});

test("no chat capability: the composer is disabled with a reason, not a dead screen", () => {
  const out = html(h(UI.WebChat, chatProps(UI.initialChatState, { capabilities: caps() })));
  assert.match(out, /does not serve chat/);
});

test("the list renders at most 50 messages and offers older ones", () => {
  const s = UI.reduce(UI.initialChatState, { type: "snapshot", messages: Array.from({ length: 120 }, (_, i) => ({ role: "user", content: `line-${i}` })) });
  const out = html(h(UI.WebChat, chatProps(s)));
  assert.equal((out.match(/line-\d+/g) ?? []).length, 50);
  assert.match(out, /Show older/);
  assert.doesNotMatch(out, /line-69\b/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd web && node --test --experimental-strip-types tests/screens.test.mjs`
Expected: FAIL, the esbuild bundle cannot resolve `../src/screens/PairingScreen.tsx`.

- [ ] **Step 3: Implement the screens and `App`**

Write the four components per the required behaviour above.
- Keep logic in the reducer and controller; components only render props and call callbacks.
- Import the chat pieces by alias: `@llmide/screens/chat/MarkdownView.tsx`, `@llmide/screens/chat/Composer.tsx`, `@llmide/screens/chat/approvals/QuestionCard.tsx`, `@llmide/screens/chat/chat.css` and `@llmide/screens/chat/approvals/approvals.css`.
- Check each one's real prop names (`MarkdownProps`, `ComposerProps`, `QuestionCardProps`, `CardUi`) in the source before wiring.
- If `QuestionCard`'s `PendingApproval` type needs fields the v1 payload lacks, build the object with exactly the required fields and `kind: "AskUserQuestion"`. Never widen the chat screen's types from here.
- If importing `Composer.tsx` pulls in a module that needs Tauri, render the plain `<textarea>` composer locally instead (Enter sends, Shift+Enter adds a newline, plus a Stop button) and note that in the report. Do not edit `ui/screens/chat` from this task.

`web/src/main.tsx` becomes:

```tsx
import "@llmide/ui-kit/styles.css";
import "./web.css";
import { createRoot } from "react-dom/client";
import { applyTheme } from "@llmide/ui-kit";
import { App } from "./App.tsx";

applyTheme(globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark");
createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 4: Run the tests, the type-check and a build**

Run: `cd web && npm test && npx tsc --noEmit -p . && npm run build`
Expected: every web test passes (scaffold, connection, URL and storage, store, controller and screens), with 0 type errors and a successful build.

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx web/src/screens web/src/web.css web/src/main.tsx web/tests/helpers.mjs web/tests/ui-entry.ts web/tests/screens.test.mjs
git commit -m "feat(web): pair, chat and answer approvals in the web client"
```

---

### Task 7: The desktop forwards the web origins in debug builds

**Parallel-safe:** yes (wave A), once Plan 3 Task 8 has landed its `LLMIDE_HOST_API_DEV` pass-through in `core_host.rs`. It touches only Rust.

**Files:**
- Modify: `desktop/src-tauri/src/core_host.rs`

**Interfaces:**
- Produces `pub(crate) fn host_api_web_origins_env(debug: bool, dev: Option<&str>, origins: Option<&str>) -> Option<String>`.
- The spawn site calls `cmd.env("LLMIDE_HOST_API_WEB_ORIGINS", v)` only when it returns `Some`.
- The value is passed verbatim. The core keeps only loopback entries (Plan 3 Task 7, `config.hostApiWebOrigins`), so this function does not re-validate origins.

- [ ] **Step 1: Write the failing cargo test**

In the `#[cfg(test)]` module of `core_host.rs`, next to the existing `default_adopt` tests:

```rust
#[test]
fn host_api_web_origins_pass_only_in_debug_with_the_dev_flag() {
    let o = Some("http://127.0.0.1:5180");
    assert_eq!(host_api_web_origins_env(true, Some("1"), o), Some("http://127.0.0.1:5180".to_string()));
    assert_eq!(host_api_web_origins_env(false, Some("1"), o), None, "release builds never forward it");
    assert_eq!(host_api_web_origins_env(true, None, o), None, "only together with LLMIDE_HOST_API_DEV=1");
    assert_eq!(host_api_web_origins_env(true, Some("0"), o), None);
    assert_eq!(host_api_web_origins_env(true, Some("1"), Some("   ")), None);
    assert_eq!(host_api_web_origins_env(true, Some("1"), Some(&"x".repeat(1025))), None, "bounded");
    assert_eq!(host_api_web_origins_env(true, Some("1"), None), None);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && cargo test host_api_web_origins`
Expected: FAIL, ``cannot find function `host_api_web_origins_env` ``.

- [ ] **Step 3: Implement**

Add the following near `default_adopt` (about line 107):

```rust
/// The browser origins the core's Host API dev listener may accept (Host API Plan 5). Debug builds only, and only
/// together with the dev flag; the core itself keeps only loopback origins. Explicit `.env`, never `ALLOWED`.
pub(crate) fn host_api_web_origins_env(debug: bool, dev: Option<&str>, origins: Option<&str>) -> Option<String> {
    if !debug || dev != Some("1") {
        return None;
    }
    let v = origins?.trim();
    if v.is_empty() || v.len() > 1024 {
        return None;
    }
    Some(v.to_string())
}
```

At the spawn site, directly after Plan 3's `LLMIDE_HOST_API_DEV` block:

```rust
if let Some(origins) = host_api_web_origins_env(
    cfg!(debug_assertions),
    std::env::var("LLMIDE_HOST_API_DEV").ok().as_deref(),
    std::env::var("LLMIDE_HOST_API_WEB_ORIGINS").ok().as_deref(),
) {
    cmd.env("LLMIDE_HOST_API_WEB_ORIGINS", origins);
}
```

If `the_core_command_runs_with_a_cleared_environment_and_explicit_db` (about line 1815) asserts the exact env set of the spawned command, keep it green. The new variable is absent unless both host variables are set, so the existing assertion should hold unchanged.

- [ ] **Step 4: Run the Rust tests**

Run: `cd desktop/src-tauri && cargo test host_api && cargo test --lib 2>&1 | tail -5`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/core_host.rs
git commit -m "feat(desktop): forward the Host API web origins to the core in debug builds"
```

---

### Task 8: End-to-end test against the real core

**Parallel-safe:** with Task 6 (wave C), after Tasks 3 and 5 and Plan 3 Tasks 7 and 8: the listener, `config.hostApiWebOrigins` and `POST /host-api/pin`.

**Files:**
- Modify: `ui/screens/shell/tests/e2e/core-server.mjs` (an additive `env` option)
- Create: `web/tests/e2e/host-api-e2e.test.mjs`

**Interfaces:**
- `startCore({ bootTimeoutMs, register, env = {} })` applies `env` after its own defaults. Existing callers are unchanged. If Plan 3 already added an equivalent option, reuse it and skip this edit.
- Consumes:
  - `POST /host-api/pin`, which needs a JWT and the bus host proof `x-llmide-host-nonce` (computed with `busHostProof` from `extension/core/host-approval.mjs` over the test's own `LLMIDE_HOST_APPROVAL_KEY`) and returns `{pin, expiresAt, port}`
  - `HostConnection` and `createChatController`

- [ ] **Step 1: Add the `env` option**

In `core-server.mjs`, change the signature to `startCore({ bootTimeoutMs = 40_000, register = true, env: extraEnv = {} } = {})`. After the existing `Object.assign(env, {...})`, add `Object.assign(env, extraEnv);`. Run the shell e2e suite once to show nothing changed: `cd desktop && node --test --experimental-strip-types ../ui/screens/shell/tests/e2e/*.test.mjs` (unsandboxed: it binds ports).

- [ ] **Step 2: Write the end-to-end test**

`web/tests/e2e/host-api-e2e.test.mjs`:

```js
// Real core (bench-fake engine, no model), Host API dev listener, this page's origin allowlisted: the web client's
// protocol layer pairs, runs a chat turn, reads history, reconnects with its stored token and forgets the host.
// Binds local ports: run unsandboxed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { startCore } from "../../../ui/screens/shell/tests/e2e/core-server.mjs";
import { busHostProof, BUS_PROOF_HEADER } from "../../../extension/core/host-approval.mjs";
import { HostConnection } from "../../src/host-api/connection.ts";
import { createChatController } from "../../src/chat/controller.ts";

const ORIGIN = "http://127.0.0.1:5180";
const KEY = randomBytes(32).toString("hex");
const skip = typeof WebSocket !== "function" ? "no global WebSocket in this Node" : process.env.LLMIDE_E2E === "0" ? "LLMIDE_E2E=0" : false;
let core, accessToken;

before(async () => {
  if (skip) return;
  core = await startCore({ env: {
    LLMIDE_HOST_API_DEV: "1",
    LLMIDE_HOST_API_WEB_ORIGINS: `${ORIGIN},https://evil.example`,
    LLMIDE_HOST_APPROVAL_KEY: KEY,
  } });
  const r = await fetch(`${core.base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: core.email, password: core.password }) });
  assert.equal(r.status, 200);
  accessToken = (await r.json()).accessToken;
});
after(() => core?.stop());

async function mintPin() {
  const r = await fetch(`${core.base}/host-api/pin`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", [BUS_PROOF_HEADER]: busHostProof({ LLMIDE_HOST_APPROVAL_KEY: KEY }) },
    body: "{}",
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}

const upgradeStatus = (port, origin) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: "/host-api/v1", headers: {
    Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    ...(origin ? { Origin: origin } : {}),
  } });
  req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
  req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
  req.on("error", reject);
  req.end();
});

const memoryTokens = () => { let t = null; return { get: () => t, set: (v) => { t = v; } }; };
// A browser sends its Origin itself; Node's WebSocket (undici) takes it through the non-standard `headers` init.
const asBrowser = (url) => new WebSocket(url, { headers: { origin: ORIGIN } });
const client = (url, tokens) => new HostConnection({ url, clientName: "LLM-IDE Web e2e", clientVersion: "0.0.0", tokens, createSocket: asBrowser });
async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); }
}

test("the listener accepts the allowlisted web origin and a native client, and refuses the rest", { skip }, async () => {
  const { port } = await mintPin();
  assert.equal(await upgradeStatus(port, ORIGIN), 101);
  assert.equal(await upgradeStatus(port, null), 101, "native clients send no Origin");
  assert.equal(await upgradeStatus(port, "http://127.0.0.1:5181"), 403, "an unlisted port");
  assert.equal(await upgradeStatus(port, "https://evil.example"), 403, "a listed non-loopback origin is dropped by the core");
});

test("pair, run a chat turn, read history, reconnect with the token, forget the host", { skip }, async () => {
  const { pin, port } = await mintPin();
  const url = `ws://127.0.0.1:${port}/host-api/v1`;
  const tokens = memoryTokens();
  const conn = client(url, tokens);
  assert.equal(await conn.connect(pin), "ready");
  assert.equal(conn.hello.hostKind, "desktop");
  assert.deepEqual(conn.hello.apiVersions, [1]);
  assert.ok(conn.capabilities.has("chat"));
  const token = tokens.get();
  assert.ok(token && token.length >= 16);

  await assert.rejects(client(url, memoryTokens()).connect(pin), (e) => e.code === "auth_failed" && e.retryable === false, "the PIN is one-use");

  const chat = createChatController(conn);
  await chat.resync();
  await chat.send("hi");
  await waitFor(() => chat.getState().turn === null);
  const reply = chat.getState().messages.at(-1);
  assert.deepEqual([reply.role, reply.status], ["assistant", "done"], JSON.stringify(reply));
  assert.match(reply.text, /^(ok )+/, "the bench-fake canned reply");

  await chat.resync();
  assert.deepEqual(chat.getState().messages.slice(-2).map((m) => [m.role, m.status]), [["user", "done"], ["assistant", "done"]]);
  chat.dispose();
  conn.close();

  const again = client(url, tokens);
  assert.equal(await again.connect(), "ready", "the stored token re-authenticates");
  assert.equal(await again.forget(), true);
  assert.equal(tokens.get(), null);

  const stale = client(url, { get: () => token, set() {} });
  assert.equal(await stale.connect(), "needsPin", "a revoked token is refused");
  stale.close();
});
```

If the allowlist case shows that undici ignored `headers` (for example, `asBrowser` connections still succeed after the allowlist is emptied), replace `createSocket: asBrowser` with the default socket and keep the raw-upgrade test as the origin evidence. Note this in the report. Read `config.hostApiWebOrigins` in Plan 3's code: if it drops non-loopback entries silently instead of logging them, the 403 still holds.

- [ ] **Step 3: Run it**

Run (unsandboxed): `cd web && npm run test:e2e`
Expected: 2 tests pass, in about 10 s cold.

- [ ] **Step 4: Commit**

```bash
git add ui/screens/shell/tests/e2e/core-server.mjs web/tests/e2e/host-api-e2e.test.mjs
git commit -m "test(web): pair and chat with the real core over the Host API dev listener"
```

---

### Task 9: Docs, gates and plan status

**Parallel-safe:** no (wave D, after every task).

**Files:**
- Create: `web/README.md`
- Modify: `Makefile` (`test-desktop-node`), `.github/workflows/desktop-ci.yml`, `schema/host-api/v1/README.md`, `CLAUDE.md` (Project Structure), `docs/superpowers/MASTER-PLAN.md`

- [ ] **Step 1: `web/README.md`**

Sections, short:
1. **What it is.** The Host API v1 web client: pairing, chat and approvals. It never calls the core's HTTP routes.
2. **Run it locally:**

   ```bash
   # 1. the desktop (debug build) with the dev listener and this page's origin allowed
   LLMIDE_HOST_API_DEV=1 LLMIDE_HOST_API_WEB_ORIGINS=http://127.0.0.1:5180 npm --prefix desktop run tauri dev
   # 2. the web app (dev server), or the built bundle on the same origin
   cd web && npm ci && npm run dev          # or: npm run build && npm run preview
   # 3. desktop Settings > Host API pairing > Show pairing PIN, then open http://127.0.0.1:5180
   #    and enter ws://127.0.0.1:<port shown>/host-api/v1 and the PIN
   ```

3. **Moving to your domain** (phase 6, configuration only):
   - Build with `VITE_HOST_API_URL=wss://<host>:<port>/host-api/v1`.
   - Serve `web/dist` over HTTPS, with the same CSP sent as a header.
   - Add `https://<domain>` to the host's origin allowlist once phase 6 widens it beyond loopback and serves WSS.
4. **Security notes:**
   - The token lives in `localStorage` per host; **Forget this host** revokes it. The PIN is never stored.
   - The CSP is in the built page. There is no raw HTML, and plaintext `ws://` is allowed only to loopback.
5. **Tests:** `npm test` (unit and server render) and `npm run test:e2e` (real core, unsandboxed).

- [ ] **Step 2: Gates**

- `Makefile`, inside `test-desktop-node`, after the ui-kit block:

  ```make
  	@if [ -d web/node_modules ]; then \
  	  cd web && npm test --silent && npx tsc --noEmit -p .; \
  	else echo "test-desktop: web/node_modules missing (cd web && npm ci); skipping web checks"; fi
  ```

- `.github/workflows/desktop-ci.yml`: add "Install web dependencies" (`working-directory: web`, `npm ci`) next to the ui-kit install. Add "web tests and type-check" (`npm test`, `npx tsc --noEmit -p .`). Add `npm run test:e2e` in the same step and under the same `runner.os != 'Windows'` / `LLMIDE_E2E` condition the desktop end-to-end tests use.

- [ ] **Step 3: Contract and repo docs**

- `schema/host-api/v1/README.md`: "The web client is `web/` (`web/src/host-api/connection.ts`), and its types are generated into `web/src/host-api/types.generated.ts` by `scripts/generate-host-api.mjs`."
- `CLAUDE.md`, Project Structure tree: add `├── web/  # Host API v1 web client (Vite + React, ui-kit; pairing, chat, approvals) — see web/README.md` after `desktop/`'s position, or after `mac/` if `desktop/` is not listed. If `CLAUDE.md` has uncommitted changes from someone else, skip this edit and say so in the report: interactive staging is not available, and their hunk must not be committed.
- `docs/superpowers/MASTER-PLAN.md`, S6: split the open "Host API Plans …" item.
  - Plan 5 becomes `[x]` (or `[~]` while Plan 3 is still `[~]`), citing this plan file and its commits, with "manual browser pairing check deferred to the product stage".
  - Keep the remaining plans as `[ ]`.
  - Then run `node scripts/plan-status.mjs --fix && node scripts/plan-status.mjs --check`.

- [ ] **Step 4: Full gate**

Run:
- `node scripts/generate-host-api.mjs --check && make host-api-check`
- `make test-desktop-node`
- `cd web && npm run build && npm run test:e2e` (unsandboxed)
- `LLMIDE_KEYCHAIN_BACKEND=memory make regression` (unsandboxed)

Expected: all pass.

- [ ] **Step 5: Commit**

Use separate commits:
- `docs(web): explain running the web client locally and on a domain later` (`web/README.md`, `schema/host-api/v1/README.md`, `CLAUDE.md`)
- `ci(web): run the web client tests in the desktop gates` (`Makefile`, `.github/workflows/desktop-ci.yml`)
- `docs(plan): record the Host API web client` (`docs/superpowers/MASTER-PLAN.md`)

---

## Limits

- **Desktop host only, loopback only, plaintext.**
  - The Mac listener refuses every `Origin` until Plan 6 adds its allowlist, so a browser cannot reach a Mac host yet.
  - WSS, certificate pinning and a non-loopback origin are phase 6. A browser on another machine cannot pair until then.
- **Later risks for the domain step (phase 6):**
  - A browser must trust the host's certificate before `wss://` works, and self-signed local TLS is the spec's own named risk.
  - Chromium's Private Network Access rules may restrict an `https://<domain>` page from opening a socket to a LAN or loopback host. Check this when the VPS exists.
- **The served surface is v1's:**
  - one host-side phone chat (no chat list, no sessions, no attachments UI);
  - no tool-step or progress display, because v1 has no progress event and the reply arrives as chunked `chat.delta` at turn end;
  - history is the newest 500 messages.
- A question cannot be declined without stopping the reply (no v1 command).
- A bearer token in `localStorage` is readable by any script on the origin. The CSP and the no-raw-HTML rule are the defence; per-device revoke is the recovery.
- A rev gap is detected per host counter, so other devices' traffic causes extra (cheap) resyncs.
- The manual browser pairing check is deferred to the product stage (user decision). The Task 8 end-to-end test covers the protocol path without a browser. A browser-driven test needs a headless browser, which is not a light dependency.

## Workflow

Subagent-driven, one fresh implementer per task, each task reviewed before the next wave.
- Run the waves of the Parallel map concurrently: A (1, 2, 7), then B (3, 4, 5), then C (6, 8), then D (9).
- Tasks 3, 4 and 8 handle the token, the PIN and origins. Review them on Sonnet or a stronger model.
- Task 6 renders model text. Its review checks the untrusted-output rules.
- Commit on `main`, stage only the task's files, and do not push.

## Commands

```bash
node scripts/generate-host-api.mjs && node scripts/generate-host-api.mjs --check && make host-api-check
cd extension && node --test tests/host-api-ts-types.test.mjs
cd web && npm ci && npm test && npx tsc --noEmit -p . && npm run build
cd web && npm run test:e2e                          # unsandboxed: real core, local ports
cd desktop/src-tauri && cargo test host_api
make test-desktop-node
LLMIDE_KEYCHAIN_BACKEND=memory make regression      # unsandboxed
```

## Self-review

**Spec coverage, phase 5 ("v1 over WSS with URL/pairing-token entry; no Bonjour assumption"):**
- The URL and PIN entry is Task 6 with Task 4's policy. There is no Bonjour: the user types the URL.
- WSS: `wss://` is accepted for any host (Task 4) and allowed by the CSP (Task 2). Plaintext is loopback-only, under the spec's development rule. The WSS host side is phase 6.
- Origin: a browser sends one, and the desktop allowlists `http://127.0.0.1:5180` (Plan 3 decision 6, forwarded by Task 7). Task 8 proves both refusals: an unlisted port and a non-loopback origin.
- Token in browser storage, revocable (Tasks 3 and 4). The PIN is sent in exactly one frame and never stored (Task 3 test).
- Snapshot plus `rev` resync, and reconnect with no replay (Tasks 3 and 5). Capability gating: local refusal, hidden tool approvals and a disabled composer without `chat` (Tasks 3, 5 and 6).
- "Swift and TypeScript types are generated" is met by Task 1. There are no hand-written duplicate types; the client guards are field checks, not types.

**Deferred on purpose (Limits):** the Mac host for web, TLS and pinning, non-loopback origins, browser-driven tests, and the manual check.

**Placeholders, each naming its source to read before writing:**
- The exact prop names of the reused chat components (Task 6) come from `MarkdownProps`, `ComposerProps`, `QuestionCardProps` and `CardUi`.
- The `filePath` bound comes from `events.schema.json` (Task 5).
- The `core_host.rs` spawn-site location depends on Plan 3 Task 8's change (Task 7).
- `config.hostApiWebOrigins`'s logging comes from Plan 3 Task 7 (Task 8).

**Type consistency:**
- Task 1's generated names are consumed by Tasks 3 and 5.
- `HostLink`, `HostEvent`, `TokenStore` and `ConnectionState` (Task 3) are consumed by Tasks 4 (structurally), 5, 6 and 8.
- `ChatState`, `reduce` and `createChatController` (Task 5) are consumed by Tasks 6 and 8.
- `startCore({ env })` (Task 8) is additive for the existing shell end-to-end callers.
