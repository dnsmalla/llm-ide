# Source Connectors (config-driven sources) — Design

**Date:** 2026-07-31
**Status:** Draft (awaiting implementation plan)
**Component:** macOS app (`mac/`), one new server endpoint (`extension/`)
**Builds on:** [`2026-06-23-input-source-abstraction-design.md`](2026-06-23-input-source-abstraction-design.md), [`2026-07-05-email-inbox-generation-pipeline-design.md`](2026-07-05-email-inbox-generation-pipeline-design.md)
**Supersedes the fetch path of:** [`2026-06-23-slack-source-design.md`](2026-06-23-slack-source-design.md) (the meeting-transcript `.docx` path is replaced by the folder pipeline)

> **Name:** The feature is called **Source Connectors**. Each source (Email, Slack, …) is a *Source Connector*. New code types use the `SourceConnector*` prefix. (This renames the older `InputSource` concept; `MeetingSource` conforms too.)

## Goal

Two things at once:

1. **The concrete ask** — bring Slack to parity with Email: fetched Slack messages are saved as raw files into a `SlackInbox/` folder, then turned into per-message notes (with extracted to-dos) via the same generation pipeline email uses; the auto-task and the Connections "Fetch again" card drive it.
2. **The extensibility ask** — make sources plug-in-style ("like Claude Desktop connectors") so adding a future source is mostly a config file, not edits across many files.

We achieve both by introducing a small **Source Connector** engine: each source becomes a **manifest** (describing metadata, UI, base path, folder names, note type, endpoints, noise rules) plus a **thin adapter** (the only source-specific code, owning the wire-shape mechanics). Email and Slack become the engine's first two instances.

A second motivation, from lived experience: *"last time there were no folders in sources or notes."* Today the source inbox and notes folders are created lazily (only when the first file is written), so right after connecting a source they don't exist yet — which breaks anything that expects them. This design makes folder creation **eager, at connect time**.

## Background — current state (reviewed)

Email and Slack are both already `InputSource`-conforming structs in `SourceRegistry.all`, but their fetch paths are completely different:

- **Email** (the reference two-phase pattern): `EmailSource.fetchAndIngest` → `api.fetchEmails` → save raw `.txt` to `EmailInbox/` via `InboxStore` → `api.markEmailSeen` (high-water advances only on full drain) → `InboxGenerationPipeline.run` over the whole folder (dedup by SHA-256 of raw bytes) → per item `api.classifyEmail` (`/kb/email/classify`) → `EmailNoteWriter.writeNote`/`writeSkipped` via `NoteService` (`.email` type). Bulk senders skip the LLM.
- **Slack** (the laggard): `SlackSource.fetchAndIngest` → per-channel `api.fetchSlack` → immediately writes ONE meeting-style transcript note per channel-window via `MeetingFileStore` + `MeetingSummarizationService` (a `.docx`, not via `NoteService`). **No raw folder, no generation pipeline, no content-hash dedup, no classify, no to-dos.**

Key existing pieces the engine reuses:
- `InboxStore` (`Services/NotesFolder/InboxStore.swift`) — generic raw writer, but currently hardcoded to `From:/Subject:/Date:` headers.
- `InboxGenerationPipeline` (`Services/NotesFolder/InboxGenerationPipeline.swift`) — generic scan/dedup/generate loop, but parses `From:/Subject:/Date:` specifically.
- `SourceIngestService` (`Services/SourceIngestService.swift`) — the driver; already source-agnostic (`importSource(id:)` → `fetchAndIngest` → conditional `FolderIndexer.fullScan` + `.meetingIndexChanged`).
- `SourceRegistry.fetchSources` — the list the auto-task loops.
- Server: `/kb/slack/{test,fetch,seen}` exist; **`/kb/slack/classify` does not** (must be added).

Server-side high-water / seen-ledger for both email and slack is per-user, per-source, forward-only, and **stays unchanged** — the engine does not touch it.

## Decisions (from brainstorming)

- **Name:** the feature and types are **Source Connector** (`SourceConnector`, `SourceConnectorManifest`, `SourceConnectorAdapter`).
- **Granularity:** one raw file + one note **per Slack message** (mirrors email per-message). Accepted trade-off: thread context is not carried into the note body.
- **Issue scope:** classify + extract to-dos into note frontmatter (`/kb/slack/classify`); **no automatic tracker issue creation** (a later phase, same as email today).
- **Extensibility level:** **Level 2 — config-driven Source Connectors** (manifest + thin adapter), not pure code (L1) and not external MCP processes (L3).
- **Migrate Email too:** the engine needs two real instances to be valid; Email becomes the first connector and its existing tests are the behavior-preservation gate.
- **Meeting stays a code connector:** live capture is event-driven (`AutoCaptureService`), no fetch phase. It conforms to `SourceConnector` for uniform display but has no adapter/fetch.
- **Base path:** **one configurable base path per project** under which all Source Connectors store data. Each manifest still names its own folders (`SlackInbox`, `notes/slack`). One setting, not per-connector.
- **Folders created eagerly:** connecting (enabling) a Source Connector immediately creates its source inbox folder and its notes folder. Not lazy.
- **Server scope guardrail:** endpoints stay **per-source**; the manifest only names which to call. The only new endpoint is `/kb/slack/classify`. A generic server-side connector runtime is deferred.

## Architecture

```
Source Connector manifest (JSON per source)    ← describes the source; no logic
   id, displayName, icon, platforms, mode
   inboxFolder, noteType                       ← folder NAMES (base path is a setting)
   endpoints: { test, fetch, seen, classify }  ← server paths only
   adapter: "<Swift adapter type name>"
   configFields: [ UI form fields ]
   rawHeaders: { header → item-field mapping }
   noiseFilter: { minLength, skipEmojiOnly, ... }
   ▼
SourceConnector  (ONE Swift impl, configured from a manifest)
   ▼
SourceConnectorAdapter (per source, ~30 lines)  ← owns wire-shape mechanics only
   fetch(ctx) → batch of field-dicts; markSeen(...); classifyRequest(item)
   ▼
SourceIngestService  (unchanged driver — now runs any Source Connector)
   ▼
InboxStore + InboxGenerationPipeline + NoteWriter  (shared, header/type-agnostic)
```

**Base path + folder layout.** A per-project setting `sourceConnectorRoot` (default: the project data root) is the single base. All connector data lives under it:

```
<sourceConnectorRoot>/
├── SlackInbox/YYYY/MM/<stamp>-<channel>-<ts>.txt   ← raw (inboxFolder from manifest)
├── EmailInbox/YYYY/MM/...
└── notes/
    ├── slack/YYYY/MM/...md                          ← noteType from manifest
    └── email/YYYY/MM/...
```

**Connect lifecycle (new).** Enabling/saving a Source Connector in settings (and, idempotently, on app launch for already-enabled connectors) calls `SourceConnector.ensureSetup(at: sourceConnectorRoot)`, which:

1. `mkdir -p` the source inbox folder (`<root>/<inboxFolder>/`).
2. `mkdir -p` the notes folder (`<root>/notes/<noteType>/`).
3. (Optionally) calls the manifest's `test` endpoint to validate auth before marking the connector "Connected".

This guarantees the folders exist from the moment a connector is connected — fixing the "no folders in sources/notes" regression. Folder creation is idempotent and cheap, so it's safe to repeat on every launch.

**Ingestion flow for a fetch Source Connector** (Slack shown; Email identical shape):

```
SourceIngestService.importSource(id)
  └─ SourceConnector.fetchAndIngest(ctx)
       PHASE 1 — FETCH (adapter owns the loop; server owns high-water)
         adapter.fetch(ctx):
           for channelId in config.channels:                  # Slack-specific loop
             api.fetchSlack(channelId, lookbackDays) → [SlackMessage]   POST /kb/slack/fetch
             yields field-dicts: {channelId, user, ts, text}
           (engine, not adapter, applies the manifest rawHeaders mapping
            to build the raw-file headers, and uses `text` as the body)
         for each channel: adapter.markSeen(channelId, tsList,
                             drained ? max(ts) : nil)          POST /kb/slack/seen
       PHASE 2 — GENERATE (one pass over the whole <inboxFolder>/; source-agnostic)
         knownHashes = SourceConnectorNoteWriter.existingSourceHashes(noteType)
         InboxGenerationPipeline.run(<inboxFolder>, knownHashes) { item ->
           if noiseFilter.matches(item): writer.writeSkipped(category:"noise")
           else:
             api.classifySlack(adapter.classifyRequest(item))         POST /kb/slack/classify
             routeDecision → writer.writeNote(...) | writer.writeSkipped(...)
         }
       return .imported(n, moreAvailable: Σ overCap, oversize: 0)
     needsRescan → FolderIndexer.fullScan() (bg) + post .meetingIndexChanged
```

## Manifest schema

Bundled defaults live under `mac/Sources/LlmIdeMac/Resources/source_connectors/*.json` (user-overridable later). Example — `slack.json`:

```json
{
  "id": "slack",
  "displayName": "Slack",
  "icon": "number",
  "emptyText": "No Slack messages yet",
  "platforms": ["slack"],
  "mode": "fetch",
  "inboxFolder": "SlackInbox",
  "noteType": "slack",
  "endpoints": { "test":"/kb/slack/test", "fetch":"/kb/slack/fetch",
                 "seen":"/kb/slack/seen", "classify":"/kb/slack/classify" },
  "adapter": "SlackConnectorAdapter",
  "configFields": [
    { "key":"channels", "label":"Channels", "type":"stringList", "required":true },
    { "key":"lookbackDays", "label":"Lookback (days)", "type":"int", "default":7 },
    { "key":"enabled", "type":"toggle" }
  ],
  "rawHeaders": { "Channel":"$channelId", "User":"$user", "Ts":"$ts", "Date":"$date" },
  "noiseFilter": { "minLength":2, "skipEmojiOnly":true }
}
```

The `adapter` field names the Swift type that owns the source-specific mechanics. We deliberately do **not** express fetch/seen/classify request bodies in JSON — wire shapes genuinely differ (email: single fetch with host/port/mailbox; slack: channel loop; classify bodies differ), and a JSON DSL for them would be a fiddly templating engine. The manifest handles everything *declarative*; the adapter handles the ~30 lines of *mechanics*.

Field types for `configFields`: `string | stringList | int | bool(toggle) | secret | select`. The settings UI renders one generic card per Source Connector from these fields, replacing today's hand-written `EmailSourceSheet`/`SlackSourceSheet` content.

## The thin SourceConnectorAdapter

```swift
protocol SourceConnectorAdapter {
    /// Turn the configured source into a batch of fetched items. Owns any
    /// source-specific looping (e.g. Slack's per-channel). Each item is a
    /// field-value dict (e.g. {channelId, user, ts, text}) — the ENGINE, not
    /// the adapter, applies the manifest's `rawHeaders` mapping to build raw
    /// headers and uses the item's `text` as the body.
    func fetch(_ ctx: SourceContext) async throws -> SourceConnectorFetchBatch

    /// Mark items seen + advance high-water when `drained`. Delegated to the
    /// adapter because the request shape (per-channel vs single) differs.
    func markSeen(_ ctx: SourceContext, batch: SourceConnectorFetchBatch, drained: Bool) async throws

    /// Build the classify request body from a raw item, reading item.headers
    /// (e.g. item.headers["Channel"]). Field mapping differs per source:
    /// email→subject/from/date/body, slack→channel/user/ts/text.
    func classifyRequest(from item: RawInboxItem) -> ClassifyRequest
}
```

`SourceConnectorFetchBatch` carries the fetched items (field dicts + text), the per-source `drained` flag, and any `overCap`/failure accounting the adapter accumulated during its loop. The engine consumes it to (a) write raw files via `InboxStore` using `rawHeaders`, (b) call `markSeen`, (c) feed the generation pass.

`EmailConnectorAdapter` and `SlackConnectorAdapter` are the two implementations. Everything else — raw storage, dedup, the generation loop, note writing, drain/`overCap` accounting — is shared in the engine.

## NoteType → string-backed

Today `NoteType` is a fixed enum (`meeting | email | document`), so every new source forces edits to the enum + `NoteService.getDirForType` + the scan loop (`NoteService.swift:329`). Under the engine, note type becomes a **plain string** and `NoteService` writes/reads `notes/<type>/` directly — a new connector's note type needs zero `NoteService` changes. Existing `.meeting`/`.email`/`.document` notes on disk are unaffected (same strings → same dirs).

## Components

**New (Mac):**
- `Sources/LlmIdeMac/SourceConnectors/SourceConnectorManifest.swift` — Codable manifest + loader (reads bundled `Resources/source_connectors/*.json`).
- `Sources/LlmIdeMac/SourceConnectors/SourceConnector.swift` — the single instance impl that runs a manifest via its adapter; owns `ensureSetup(at:)` (eager folder creation) + `fetchAndIngest`.
- `Sources/LlmIdeMac/SourceConnectors/SourceConnectorAdapter.swift` — the protocol + shared `SourceConnectorFetchBatch` / `ClassifyRequest` / `SourceConnectorNoteWriter` (frontmatter + `existingSourceHashes(noteType:)`; generalizes `EmailNoteWriter`).
- `Sources/LlmIdeMac/SourceConnectors/EmailConnectorAdapter.swift`, `SlackConnectorAdapter.swift`.
- `Resources/source_connectors/email.json`, `slack.json`.

**Changed (Mac):**
- `Services/NotesFolder/InboxStore.swift` — `write(headers:[String:String], body:String, slug:String)` (header-agnostic; `Date:` still required by the pipeline).
- `Services/NotesFolder/InboxGenerationPipeline.swift` — `RawInboxItem` gains `headers:[String:String]` (replaces hardcoded `from`/`subject`); `parse()` reads all `Key: Value` lines, still requires a parseable `Date:`.
- `Services/NoteService.swift` — `NoteType` → string-backed; `getDirForType`/scan loop use the raw string.
- `Services/API/LlmIdeAPIClient+Slack.swift` — add `SlackClassification` + `classifySlack(...)`; reuse a shared `NoteTodo` type.
- `Services/API/LlmIdeAPIClient+Email.swift` — `EmailTodo` extracted/aliased to shared `NoteTodo`.
- `Models/Config.swift` / project env — add the `sourceConnectorRoot` per-project setting (default: project data root).
- `Views/Settings/ConnectionsSettingsSection.swift` — generic Source Connector cards rendered from `configFields`; on enable, call `ensureSetup` (creates folders + optional `test` call). Existing per-source sheets become thin shells or are removed.
- `Sources/SourceRegistry.swift` → `SourceConnectorRegistry` — loads connectors from manifests instead of a hardcoded array.

**Removed (Mac):**
- `Sources/SlackSource.swift` old `ingest`/`makeNote`/`MeetingFileStore` path (replaced by `SlackConnectorAdapter` + engine). `MeetingSource.swift` stays (live capture).

**Server (`extension/`):**
- New `POST /kb/slack/classify` in `kb/router.mjs` (twin of `/kb/email/classify`; reuse the classify prompt shape, check `agents/slack-source.mjs` for reuse). Per invariants: add to `ENDPOINTS` (`server.mjs`), bump `SERVER_API_VERSION`, add to `REQUIRED_ENDPOINTS` (`src/sidepanel/App.tsx`).

**Untouched:** `SavedSlackSource`/`SavedEmailSource` config persistence, the per-channel high-water/seen-ledger, `AutoCodeUpdateService.runSourceUpdate` (already loops `fetchSources`), `AutoCaptureService`.

## Build order (each step independently shippable + testable)

1. **Shared primitives** — header-agnostic `InboxStore` + `InboxGenerationPipeline`; string-backed `NoteType`.
2. **Engine core** — manifest + loader + `SourceConnector` + `SourceConnectorAdapter` + `SourceConnectorNoteWriter` + `sourceConnectorRoot` setting + `ensureSetup` (eager folder creation) + generic config UI.
3. **Migrate Email** as the first Source Connector (`email.json` + `EmailConnectorAdapter`). **Gate:** email's existing tests pass through the engine unchanged; connecting Email creates `EmailInbox/` + `notes/email/` immediately.
4. **Add Slack** — `/kb/slack/classify` endpoint + `slack.json` + `SlackConnectorAdapter`; delete the old Slack meeting-transcript path; connecting Slack creates `SlackInbox/` + `notes/slack/` immediately.
5. *(Deferred — separate spec)* Migrate Meeting to a `liveCapture` manifest; generic server-side connector runtime.

## Edge cases

- **The "no folders" regression (fixed)** — `ensureSetup` creates both folders at connect time and idempotently on launch, so the source inbox and notes dirs always exist for any enabled connector.
- **Base path changed** — if the user moves `sourceConnectorRoot`, `ensureSetup` creates folders at the new location on next launch; existing raw/notes files are *not* moved automatically (a one-off migration helper can be offered, but is out of scope here).
- **Existing Slack `.docx` notes** — left on disk as-is; they still carry `platform: slack` and display in the Library SOURCES group. Only *new* fetches use the engine. Forward-only migration.
- **Dedup** — raw files embed `Channel:`/`Ts:` (or `From:`/`Subject:`) headers, so identical body text across channels/messages cannot collide; re-fetching the same item is idempotent (hash match → skipped).
- **Noise** — trivial Slack messages (`"ok"`, emoji-only) write a `category:"noise"` skip stub **without** an LLM classify call (analogous to email's `isBulkSender`). Rules come from the manifest's `noiseFilter`.
- **Partial failure** — one bad Slack channel is skipped, others continue (today's Slack failure isolation preserved); surfaced as `.failure(msg, imported: partial)`.
- **High-water** — unchanged, server-side, per-channel; advances only on full drain. The adapter passes the `drained` flag through.
- **Bad manifest / missing adapter / unreachable endpoint** → connector disabled with a clear error; `ensureSetup` still creates folders so the UI can show the connector as configured-but-failing without a missing-folder side effect.
- **Live capture** — Meeting is not in `fetchSources`, so the engine never tries to fetch it; `AutoCaptureService` is untouched.

## Testing

- `InboxGenerationPipeline` tests generalized to the header dict; **existing email tests must still pass** (parity gate).
- `FakeConnectorAdapter` drives the engine end-to-end with a mocked API: fetch → raw → classify → note, plus dedup-on-rerun (second run imports nothing) and noise-skip (no classify call).
- `SourceConnector.ensureSetup` test: connecting a connector creates both folders; calling again is idempotent; changing `sourceConnectorRoot` creates folders at the new path.
- `SlackConnectorAdapter` tests: per-channel loop, failure isolation (`continue` on one bad channel), high-water `drained` flag — via injectable `fetch`/`markSeen` seams (preserve today's testable shape from `SlackSource.ingest`).
- `EmailConnectorAdapter` parity: existing email source tests run through the engine unchanged.
- Manifest loader tests: valid manifest, unknown adapter, missing required field.
- Server: new `/kb/slack/classify` test mirroring `/kb/email/classify`.
- Note (repo reality): SourceKit Swift "errors" can be stale — verify with `swift build`, not the editor.

## Scope guardrails / explicitly deferred

- No automatic tracker issue creation from to-dos (email doesn't do this yet either).
- No generic server-side connector runtime — server endpoints stay per-source; the manifest only names them.
- No external/MCP connectors (Level 3).
- No automatic migration of files when `sourceConnectorRoot` changes.
- Meeting migration to a manifest is cosmetic and deferred.
