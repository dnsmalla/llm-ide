# Host API v1 — one contract for Mac, desktop, iOS and web

**Date:** 2026-11-03 · **Status:** proposed, awaiting review · **Owner:** dnsmalla

## Problem

The iOS app currently speaks the Mac app's `MobileProtocol` WebSocket. The
desktop app has a separate loopback HTTP core. A web client would be a third
consumer. If each client learns a different host's private JSON, every host
change can break a different client and the three surfaces drift apart.

The phone must not become a client of the Mac UI's JSON, and it must not become
a client of desktop core internals. Mac and desktop are **hosts** of the same
product; iOS and web are **clients** of a host contract.

## Goal

Define one versioned Host API that:

- the Mac app implements through its Mobile Control layer,
- the desktop app implements beside its local core,
- iOS uses with a fallback to today's Mac protocol while older Macs exist,
- web uses over the same transport,
- keeps the product local-first: no cloud account and no relay.

## Non-goals

- Cloud relay, hosted accounts or remote multi-tenant access.
- Remote desktop, arbitrary shell access, or phone-side code editing beyond
  today's product scope.
- Exposing desktop core routes directly to clients.
- Changing product features as part of the transport migration.
- Replacing the Mac app's UI or the desktop core's storage.

## Decisions

| Question | Decision |
|---|---|
| Transport | One WebSocket with JSON frames, TLS/WSS outside loopback |
| Request correlation | Client-generated `id`; responses carry `replyTo` |
| State model | Snapshot + revision + pushed events; reconnect resyncs from a snapshot |
| Compatibility | Host serves v2 (existing iOS) and v1; new iOS uses v1 and falls back to v2 on an old Mac |
| Host discovery | Bonjour with TXT records; QR carries URL, protocol version and certificate fingerprint |
| Listeners | v2 stays on its existing `ws://3006–3015` range; v1 TLS uses `wss://3016` by default (next free port if busy) |
| Auth | Pairing PIN → per-device token; token in Keychain/browser storage; revocable and scoped |
| Schema | JSON Schema is the source of truth; Swift and TypeScript types are generated |
| Command naming | `<domain>.<verb>` with 2–3 segments (`chat.send`, `host.auth.pair`, `chat.history.clear`) |
| Capability gating | Host advertises capabilities; clients hide unsupported commands |
| Large payloads | Bounded frames, paginated lists, capped file reads |

## Architecture

```
Mac app ── MobileControl adapter ─┐
                                  ├── Host API v1 ── iOS
Desktop app ── core adapter ──────┤                 └── web
                                  └── Host API v2 (legacy compatibility)
```

The gateway is a transport adapter, not a second source of truth. It maps
commands to the host's existing services:

- Mac: the current Mobile Control manager and feature stores.
- Desktop: the core's HTTP API and local services.

A gateway must not read UI state or scrape rendered views.

## Wire envelope

Every frame:

```json
{
  "apiVersion": 1,
  "id": "c-01J...",
  "replyTo": "c-01J...",
  "type": "request | response | event | error",
  "command": "chat.send",
  "payload": {},
  "ts": 1760000000000,
  "rev": 42
}
```

Rules:

- `id` is unique per client connection and used for correlation.
- Requests may be retried only when the command declares `idempotent: true`;
  otherwise the client generates a new `id` after a timeout.
- `rev` is a per-host monotonic counter for events and snapshots.
- A client that sees an event `rev` greater than its snapshot `rev + 1`
  resubscribes and takes a fresh snapshot instead of guessing.
- Unknown optional payload fields are ignored.
- Unknown commands are refused with `unknown_command`; unsupported capabilities
  with `capability_unavailable`.
- Frames are UTF-8 JSON, max 1 MiB. Lists default to 100 items, max 500.

## Handshake

1. Client opens WSS and sends `host.hello` with client name, app version,
   platform and the highest API version it speaks.
2. Host replies with:

```json
{
  "hostName": "Dinsh's MacBook",
  "hostKind": "mac | desktop",
  "apiVersions": [1, 2],
  "apiVersion": 1,
  "protocolVersion": 3,
  "capabilities": ["chat", "explorer", "files"],
  "certificateFingerprint": "sha256:...",
  "requiresAuth": true
}
```

3. Client sends `auth.pair` (PIN) on first use or `auth.token` afterwards.
4. Host replies with the device token, granted capabilities and a `rev`.
5. Client requests the snapshots it needs for the visible screens.

Pairing failure returns `auth_failed` with `retryable: false` for a bad PIN and
`retryable: true` for throttling. Tokens are revoked independently of the
pairing PIN.

## Compatibility with MobileProtocol v2

The v2 frames remain the Mac's existing contract. The transition is:

- Host API v1 is a new envelope and command surface, not a mutation of v2.
- The Mac gateway serves **both**: v2 for the current iOS app and v1 for new
  clients, until the shipped iOS minimum no longer needs v2.
- A new iOS client first attempts `host.hello`. If the host does not answer
  with a v1 handshake, it uses the existing v2 transport adapter.
- New iOS features that need v1 commands are unavailable on a v2-only Mac and
  are hidden by capability gating; nothing pretends to work.
- A v1 host must keep the v2 behaviour of every message it still advertises.

This preserves the current Mac app while allowing desktop and web to start on
v1 without waiting for every Mac to update.

## Command surface

The initial surface is the current iOS feature set plus the host handshake.
Commands are added only with a schema and a capability.

### Host and auth

`host.hello`, `host.auth.pair`, `host.auth.token`, `host.auth.revoke`,
`host.snapshot`, `host.ping`.

### Chat and approvals

`chat.snapshot`, `chat.send`, `chat.cancel`, `chat.history.clear`,
`approvals.answer`, `toolApprovals.answer`.

### Explorer

`explorer.sessions`, `explorer.load`, `explorer.new`, `explorer.rename`,
`explorer.delete`, `explorer.send`, `explorer.cancel`,
`explorer.searchFiles`, `explorer.searchSkills`.

### Auto Tasks

`autotasks.snapshot`, `autotasks.run`, `autotasks.stop`, `autotasks.toggle`,
`autotasks.history`, `autotasks.logs`, `autotasks.setup`,
`autotasks.config.set` (host-capability gated; desktop-only by decision).

### Loop

`loop.snapshot`, `loop.start`, `loop.startStage`, `loop.stop`, `loop.history`.

### Projects, files and source control

`projects.list`, `projects.switch`, `files.list`, `files.read`,
`scm.status`, `scm.diff`.

### Issues

`issues.list`, `issues.get`, `issues.comment`.

### Self-Heal

`selfheal.snapshot`, `selfheal.get`, `selfheal.diff`, `selfheal.action`.

### Generation and docs

`generation.options`, `generation.run`, `llmdoc.list`, `llmdoc.read`.

### Status, usage and activity

`status.get`, `usage.get`, `activity.list`, `activity.markSeen`.

Deferred until a client needs them: issue create/close, files write, SCM write,
Loop editing, Auto Task template editing and custom tasks.

## Events

Events are named `<domain>.<what>` and carry `rev`:

- `chat.delta`, `chat.done`, `chat.error`
- `approval.request`, `approval.cleared`
- `toolApproval.request`
- `autotasks.state`, `autotasks.log`
- `loop.state`
- `scm.state`, `issues.state`, `activity.state`, `usage.state`
- `host.capabilities`

A capability change (a Mac Phone Access switch or a desktop setting) pushes
`host.capabilities`; the client hides or closes screens that are no longer
served.

## Errors

```json
{ "error": { "code": "capability_unavailable", "message": "...", "retryable": false } }
```

Stable codes include `auth_failed`, `capability_unavailable`,
`unknown_command`, `invalid_payload`, `not_found`, `busy`, `denied`,
`desktop_only`, `rate_limited`, `host_unreachable`, `internal`.

`message` is human-readable and bounded to 500 characters. Error messages never
contain tokens or file contents.

## Ports and listeners

The Mac's existing plaintext Mobile Control listener is not changed: v2 remains
on its current `ws://3006` to `ws://3015` fallback range, so the shipped iOS app
keeps working.

Host API v1 has a separate TLS listener, default **`wss://3016`**, falling back
to the next free port when busy. Both listeners run at once. Discovery, the QR
and the manual-entry screen advertise the exact v1 port; the default is never
assumed.

The desktop gateway uses the same v1 listener rule. A loopback development
build may bind plaintext `ws://127.0.0.1:<port>` when the explicit development
flag is set.

## Security

- TLS/WSS is required for non-loopback clients. The host certificate fingerprint
  is carried in the pairing QR and pinned by the client.
- Localhost development may use plaintext only when an explicit development
  environment flag is set; production builds refuse it.
- Pairing PIN is one-use and rotates after a successful pair.
- Tokens are stored hashed on the host and in Keychain on iOS.
- Tokens are scoped to granted capabilities and revocable per device.
- Pairing attempts are rate-limited with a lockout; auth failures are audit-logged.
- The gateway never proxies arbitrary URLs and never exposes core internals.
- Web clients send an `Origin`; the host applies an allowlist and refuses
  unknown origins. No wildcard CORS.
- No frame may carry a credential after pairing except `host.auth.token`.

## Schema and generated types

Source of truth: `schema/host-api/v1/*.schema.json`.

- Frame envelope, errors, commands and events each have a schema.
- `scripts/generate-host-api.mjs` generates Swift and TypeScript models plus a
  command table.
- `schema/host-api/v1/fixtures/` holds valid and invalid frames.
- A conformance runner validates fixtures against both the Mac and desktop
  adapters.
- `SharedProtocol` remains for the v2 path until v2 is retired; duplicated
  hand-written v1 types are not allowed.

The existing `schema/http/` fixtures remain the desktop core's contract; the
host gateway maps them and does not import core route modules into clients.

## Data flow examples

### Pair a phone

1. Mac shows QR: `wss://192.168.1.20:3016`, API 1, fingerprint, one-use PIN.
2. Phone pins the certificate and sends `host.hello`.
3. Phone sends `host.auth.pair` with the PIN.
4. Host returns a token and capabilities; phone stores both.
5. Phone requests `chat.snapshot`, `status.get`, `autotasks.snapshot` and
   `loop.snapshot` for the landing tab.

### Reconnect after iOS suspends

1. Phone reopens the socket with `host.hello` and `host.auth.token`.
2. Host returns the current `rev` and capabilities.
3. Phone discards stale feature state and requests snapshots for visible screens.
4. Event delivery resumes; no historical replay is required.

### Approval

1. Host pushes `approval.request` with the question and options.
2. Phone sends `approvals.answer` with the request id and chosen option.
3. Host pushes `approval.cleared` to every connected client.

## Delivery phases

1. **Contract freeze:** this spec, JSON Schemas, fixtures and command table.
2. **Mac v1 adapter:** handshake, auth, snapshots and chat; serve v2 unchanged.
3. **Desktop v1 adapter:** the same surface for every capability the desktop
   supports; unsupported features are not advertised.
4. **iOS transport:** introduce `HostConnection`; v1 adapter plus the existing v2
   fallback; move screens behind it without changing behaviour.
5. **Web client:** v1 over WSS with URL/pairing-token entry; no Bonjour assumption.
6. **Security hardening:** TLS certificate pinning, token scopes, origin
   allowlist, rate limits and audit logging.
7. **Retirement:** remove v2 only after the minimum supported iOS build speaks v1.

Each phase ends with the conformance suite, a build, and a manual pairing check
against a real host.

## Testing

- Schema validation for every fixture.
- Cross-host conformance: the same fixture suite against Mac and desktop stubs.
- Auth: correct PIN, wrong PIN, revoked token, expired token, lockout.
- Reconnect: snapshot resync after a missed-event gap.
- Capability changes: a disabled feature disappears without a dead screen.
- Payload limits: oversized frame, oversized list, truncated file read.
- TLS: certificate mismatch refused; plaintext refused outside loopback.
- Compatibility: a v2-only Mac still works with the new iOS fallback adapter.
- Desktop/Mac parity: every command advertised by both returns the same shape.

## Risks

- Dual v1/v2 support increases the Mac gateway surface until v2 retires.
- Self-signed local TLS can be painful on iOS and browsers; fingerprint pinning
  and QR bootstrap are required, not optional.
- Desktop feature parity is not automatic; unsupported capabilities must be
  honest rather than stubbed.
- Schema generation can drift if fixtures and generators are not gated in CI.
- Moving iOS behind a transport abstraction touches every store; it must be done
  slice by slice, not as one rewrite.
