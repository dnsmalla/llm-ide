# Unified Input-Source Abstraction (Phase 1) — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorm)
**Component:** macOS app (`mac/`)
**Phase:** 1 of 2 — Phase 2 (add Slack as a source) is a separate spec that builds on this.

## Goal

Replace the smeared, bespoke handling of input sources (meetings, email) with a single uniform `InputSource` abstraction + registry on the Mac client, so source classification, Library display, settings UI, and ingestion all flow through one place. This is a behavior-preserving refactor whose payoff is that adding a new source (Slack, calendar, …) becomes a single registry entry instead of "shotgun surgery" across ~7 files.

## Background — current state (reviewed)

Two live sources, each built bespoke:
- **Meetings** (live capture): `AutoCaptureService` → `CaptionOrchestrator` + `PlatformDetector.allScrapers` → `.md` with `platform: meet/teams/mic`.
- **Email** (fetch): `EmailSourceSheet` → `LlmIdeAPIClient+Email` (test/fetch/seen) → server `agents/email-source.mjs` (IMAP) → `SourceIngestService` → `.md` with `platform: email`.

The "source" concept is spread across three partial registries — `LibraryItem.SourceKind` (`.meeting`/`.mail`), `InputSourceRegistry` (live/planned list), `PlatformDetector.allScrapers` — plus per-source `@Published` config in `AppConfig`, a hardcoded `platform == "email"` classification check (`LibraryItemStore.sourceKind(for:)`), email-specific branches in `SourceIngestService`, and a hand-wired card in `ConnectionsSettingsSection`. Adding a source today requires edits in all of them.

## Decisions (from brainstorming)

- **Sequencing:** unify the abstraction first (this spec); add Slack second (separate spec).
- **Abstraction shape:** ONE uniform `InputSource` protocol for all sources. The live-capture vs fetch difference is modeled with a `SourceMode` + default no-op ingestion for live-capture sources (so meetings conform to the same protocol without awkward empty method bodies at call sites).
- **Scope:** Mac client only. The server (`/kb/email/*` routes, `email_seen`/`email_state` tables) is unchanged; `EmailSource` keeps calling the existing endpoints. Server generalization, if any, happens in Phase 2.
- **Behavior:** no user-visible change — pure refactor.

## Architecture

A single `SourceRegistry` owns one `InputSource` instance per source type. Every source-related concern reads from the registry:
- **Classification:** frontmatter `platform` → `SourceRegistry.source(forPlatform:)`.
- **Library SOURCES display:** iterate `SourceRegistry.all` for sub-groups.
- **Settings:** render one card per registry entry in `ConnectionsSettingsSection`.
- **Ingestion:** `SourceIngestService` loops `SourceRegistry.fetchSources` calling `fetchAndIngest()`.

Adding a source = a new `InputSource`-conforming struct + one line in the registry (+ its config sheet, and for fetch sources its server/API work).

## Components

New directory: `mac/Sources/LlmIdeMac/Sources/`.

### `SourceMode` (enum)
```
enum SourceMode { case liveCapture, fetch }
```

### `InputSource` (protocol)
- Metadata: `var id: String` (stable, e.g. `"meeting"`, `"email"`), `var displayName: String`, `var icon: String` (SF Symbol), `var emptyText: String`, `var platforms: [String]` (frontmatter `platform` values that classify a file to this source), `var mode: SourceMode`.
- State: `var isConfigured: Bool` (fetch sources: has saved config; live-capture: always true).
- Ingestion: `func testConnection() async throws -> Bool`, `func fetchAndIngest() async throws -> Int` (returns count ingested). A protocol extension provides default implementations for `.liveCapture` sources: `testConnection` returns `true`, `fetchAndIngest` returns `0` — so meetings conform without bespoke bodies.
- UI: a config-card descriptor (title/subtitle/status + a closure that presents the source's config sheet) consumed by `ConnectionsSettingsSection`. Live-capture sources may return a non-configurable descriptor (informational card).

### `SourceRegistry`
- `static let all: [InputSource]` — the one declarative list (currently `[MeetingSource(), EmailSource()]`).
- `static func source(forPlatform: String) -> InputSource?` — match a frontmatter `platform` value to its source (replaces `SourceKind(platform:)` and the hardcoded `"email"` check). Unknown/empty → the meeting source (preserving today's default-to-meeting behavior).
- `static func source(id: String) -> InputSource?`.
- `static var fetchSources: [InputSource]` — `all.filter { $0.mode == .fetch }`.

### `MeetingSource: InputSource`
- `id "meeting"`, `displayName "Meetings"`, `icon "waveform.and.mic"`, `emptyText "No meeting files yet"`, `platforms ["meet","teams","mic"]`, `mode .liveCapture`, `isConfigured true`.
- Uses the default no-op ingestion. Live capture remains entirely in `AutoCaptureService`/`CaptionOrchestrator`/`PlatformDetector` (untouched).

### `EmailSource: InputSource`
- `id "email"`, `displayName "Mail"` (Library SOURCES sub-group label — matches the current `SourceKind.mail.title`), `icon "envelope"`, `emptyText "No mail yet"`, `platforms ["email"]`, `mode .fetch`. The Connections-settings card title ("Email") lives in the card descriptor, independent of the Library `displayName`, so each context keeps its current string.
- `isConfigured` ← `config.emailSource?.enabled == true`.
- `fetchAndIngest()` ← the email import currently in `SourceIngestService.importNewEmails()` (moved here; the service becomes the generic driver).
- `testConnection()` ← existing `LlmIdeAPIClient.testEmail`.
- Config card descriptor presents `EmailSourceSheet`.

## Refactors

- **`LibraryItem`:** replace `var sourceKind: SourceKind?` with `var sourceId: String?` (the matched source's `id`). Remove the `SourceKind` nested enum. `LibraryItemStore.sourceKind(for:)` becomes `sourceId(for:)` returning `SourceRegistry.source(forPlatform:)?.id` (default meeting). Item construction for `.meetings` sets `sourceId`.
- **Library SOURCES section** (`LibraryView`): iterate `SourceRegistry.all` (or `.filter` to sources that can appear in SOURCES) instead of `ForEach(SourceKind.allCases)`; read sub-group `displayName`/`icon`/`emptyText` from the `InputSource`. Sub-group membership tests `item.sourceId == source.id`.
- **`SourceIngestService`:** becomes a thin driver — `for source in SourceRegistry.fetchSources { try? await source.fetchAndIngest() }` (preserving the current per-source error isolation + the rescan/`.meetingIndexChanged` notification at the end). Email-specific code moves into `EmailSource`.
- **`ConnectionsSettingsSection`:** render a card per `SourceRegistry.all` entry from its descriptor; remove the hand-wired email-only branch and the `.task` auto-fetch becomes a loop over `fetchSources`.
- **Remove** the old `InputSourceRegistry` (live/planned list) — superseded. "Planned" sources are simply not in `SourceRegistry.all` yet.
- **Remove** the hardcoded `platform == "email"` check.

## Data flow

```
.md file frontmatter `platform` ──► SourceRegistry.source(forPlatform:) ──► InputSource (id, displayName, icon)
                                                                              │
Library SOURCES section iterates SourceRegistry.all ◄──────────────────────┘
Connections settings renders a card per SourceRegistry.all entry
SourceIngestService loops SourceRegistry.fetchSources → source.fetchAndIngest()
```

Meetings: AutoCapture → `.md` (platform) → classified via registry → Library (unchanged behavior).
Email: settings card (from registry) → `EmailSource.fetchAndIngest()` (existing logic) → `.md` → registry classification → Library (unchanged behavior).

## Error handling

Unchanged from today. `SourceIngestService` keeps isolating per-source failures (one source throwing doesn't abort others) and logs them; `EmailSource` retains the forward-only high-water + `markEmailSeen` semantics internally. The protocol's `async throws` surfaces errors exactly where `importNewEmails()` does now.

## Testing

- New `SourceRegistryTests`: `source(forPlatform:)` maps `"email"`→email, `"meet"/"teams"/"mic"`→meeting, unknown/`""`→meeting; `source(id:)` lookup; `fetchSources` contains email and excludes meeting (`.liveCapture`).
- Migrate `LibraryItemSourceKindTests` → `LibraryItemSourceClassificationTests` against the new `sourceId(for:)` API, preserving the same classification cases.
- Local gate: `GIT_CONFIG_GLOBAL=/dev/null swift build` (main target). `swift test` runs on CI / full Xcode (this dev box has no `xctest` runner).

## Behavior preservation

This is a pure refactor — no user-visible change. A regression check is "meetings and email still classify, display, and ingest exactly as before."

## Out of scope

- Adding Slack (Phase 2 — becomes `SlackSource: InputSource` + one registry entry + its config sheet + server work).
- Any server-side change (`/kb/email/*`, DB tables).
- The live-capture engine internals (`CaptionOrchestrator`, scrapers).
- Changing the on-disk `.md` format or `platform` frontmatter values.
