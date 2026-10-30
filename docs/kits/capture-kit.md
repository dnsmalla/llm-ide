# capture-kit

Status: **K0 Map**, written 2026-10-31. No code was changed. Citations are paths and `path:line` where a line was read; read on 2026-10-31 at `main` (`de8d51e8`). Counts say how they were taken (`wc -l`, `find`, grep). Section 9 lists where the migration plan's premises do not match the code; section 10 lists what was not verified.

## 1. Purpose

capture-kit gets a **meeting into the system** and turns it into notes: live caption capture (Mac Accessibility API, Chrome extension content scripts), the live caption stream the two share, the finalize and acknowledge handshake, summarization and meeting notes, follow-up questions and entity extraction. It is the **input** side of the meeting loop: what is said becomes a transcript, a note and (through knowledge-kit) a Library entry.

The plan row (kit 8) names: live sessions, `agents/` meeting-agent, summarize, live-sessions, `kb/meetings`, `/generate-notes`, `/generate-questions`, `/extract-entities`; `Features/Live`; `extension/src/content`, Notes, Questions, Transcript views and hooks; key none (always on); contract groups live-loop-misc (live) and notes-generation; depends on core, knowledge, agent. The route is K0 to K2 to K3 with a short K1.

The user rule that governs it is [data-lifecycle](data-lifecycle.md): capture on the Mac or in the extension, **one durable copy, the Mac file**; the server holds a live working copy that is deleted after the Mac acknowledges; the extension stores nothing once the capture has been copied.

## 2. Code on every side

### 2a. Server (Node, `extension/`)

| Piece | Path | Lines (`wc -l`) | Notes |
|---|---|---|---|
| Live caption stream | `agents/live-sessions.mjs` | 680 | In-memory ring buffer per session, periodic flush to `meetings` for crash recovery, per-session caption cap, SSE for the Mac. |
| Live routes | `routes/live.mjs` (`/kb/live`, `/kb/live/unacked`, `:id/append`, `:id/finalize`, `:id/stream`, `:id/ack`, `:id/status`) | 233 | Core, always on (Chat and the extension use it); no feature key. |
| Live acknowledge | `kb/live-acks.mjs` | 162 | `live_crash_rows` kept until the Mac acks when `LLMIDE_LIVE_ACK=1` (API v84, v86). |
| Meeting agent (co-pilot) | `agents/meeting-agent.mjs` (`dispatchAgent` `:177`, `stopAgent` `:311`) | 595 | Attaches to a live session, drafts one question every 1.5 s tick; routes `/kb/agent/dispatch`, `/stop`, `/runs`. Model-facing: agent-kit owns the engine, capture-kit owns the meeting trigger. |
| Summarize | `agents/summarize.mjs` (`summarizeTranscript` `:48`) | 81 | `POST /kb/summarize` (`router.mjs:1123`); the Mac's meeting summary path. |
| Notes, questions, entities | `server/ai-routes.mjs` (`/generate-notes` `:89`, `/generate-questions` `:259`, `/extract-entities` `:330`) | 393 | Extension clients; JSON-prompted model calls via `runClaude`. |
| KB meetings | `kb/meetings.mjs`; `POST /kb/ingest` (`router.mjs:151`); `GET /kb/meeting/:id` | 351 | Table `meetings` (`migrations/0001_initial.sql:5`), transcript rows, entities. |
| Conflict questions | `POST /kb/conflict-questions` (`router.mjs:1456`) | — | Belongs to ReviewConflicts (knowledge-kit). |
| Migration | `0051` (live capture verification), per the API v86 note in `server.mjs:285` | — | `captionHash`, language, startedAt. |

### 2b. Mac app (Swift, `mac/Sources/LlmIdeMac/`)

| Layer | Piece | Path | Lines |
|---|---|---|---|
| Features | Caption orchestration and per-app scrapers | `Features/Live/Services/CaptionScraper.swift` (598; `CaptionOrchestrator` `:59`), `AXCaptionReader.swift` (206), `TeamsCaptionScraper.swift` (106), `ZoomCaptionScraper.swift`, `PlatformDetector.swift`, `CaptionDeltaState.swift` (281) | — |
| Features | Auto capture | `AutoCaptureService.swift` (257), `PermissionsService.swift` | — |
| Features | Live mirror | `LiveSessionMirror.swift` (318): polls the server for the extension's live stream every 5 s and 1.5 s | — |
| Features | Views | `TranscriptView` (413), `PermissionsView` (208), `LiveCaptureGateView`, `MeetingCaptureMatrixView` | — |
| Features | **Total** | `Features/Live/` (14 files, `find` + `cat \| wc -l`) | **2 751** |
| Core | Meeting files and summarization (shared with Library) | `Core/Notes/Services/MeetingFileStore.swift`, `PartialRecovery.swift`, `MeetingSummarizationService.swift`, `MeetingNoteWriter.swift`, `IngestNoteDedup.swift` | — |
| Core | HTTP | `Core/Networking/API/LlmIdeAPIClient+Live.swift` (`listLiveSessions` `:47`, `liveCaptions` `:53`), `+KB.swift` (ingest, `summarize`, extract-entities comment `:67`) | — |
| Contracts | Capture gate | `Core/Contracts/LiveCaptureProviding.swift` (`LiveCaptureGateRequest`, `LiveCaptureRegistry`, `LiveCaptureGate`), `LiveThenArchiveMode.swift` | — |
| Shell | Wiring | `FeatureCatalog.installLiveSeams()`; `AppShell`, `LlmIdeMacApp` own the orchestrator | — |

### 2c. Extension (Chrome)

| Piece | Path | Lines |
|---|---|---|
| Content scripts | `extension/src/content/caption-scraper.ts` (831), `caption-validation.ts` (104), `speaker-detector.ts` (251), `floating-overlay.ts` (147) | 1 333 |
| Capture store and live client | `extension/src/lib/capture-store.ts` (877), `capture-live.ts` (77), `capture-target.ts` (26) | 980 |
| Hooks | `useTranscript` (819), `useLiveSync` (223), `useSession` (116), `useNotes` (102), `useQuestions` (160), `useAgent` (199), `useRemoteSessions` (56), `useRemoteTranscript` (103) | 1 778 |
| Views | `TranscriptView` (201), `QuestionsView` (503), `NotesView` (50), `RecordingControls` (52), `RemoteSessionBanner`, `LegacyTranscriptsPanel` | — |
| Platform and clients | `extension/src/lib/platforms.ts`, `anthropic.ts` (calls `/generate-notes`), `kb.ts` | — |
| Required endpoints | `App.tsx:59-63,75` (`/generate-notes`, `/generate-questions`, `/extract-entities`, `/kb/live/:id/status`) | — |

### 2d. Contract

| Piece | Path |
|---|---|
| Live rows | `schema/http/live-loop-misc.schema.json` (core rows `/kb/live/sessions`, `:id`, `:id/append`, `:id/finalize`, `:id/stream`; the SSE stream has no event schema, per its own description) |
| Notes rows | `schema/http/notes-generation.schema.json` (`/generate-notes`, `/generate-questions`, `/extract-entities` and the docs routes) |
| Phone wire | none for capture; the phone does not record |
| Mac lab | `mac/Sources/APIContractLab` |

### 2e. Feature key

**None.** `Features/Live` is always compiled (CLAUDE.md "always compiled"), no `LLMIDE_FEATURES` key, no server route group. Removability (K2) therefore means only that other kits compile without capture-kit; Live cannot be removed.

### 2f. Tests and gates

| Side | Files (by name) |
|---|---|
| Server | `live-ack`, `live-capture-verify`, `live-sessions-db-cleanup`, `kb-meeting-transcript`, `meeting-agent`, `summarize`, `agent-v2-live`, `http-contract-live` (8 files) |
| Extension | `caption-validation.test.ts`, `capture-store.test.ts`, `capture-target.test.ts` (3 files) |
| Mac | `CaptionDeltaStateTests`, `AutoCaptureTerminationTests`, `LiveCaptureRegistryTests`, `LiveCaptureRobustnessTests`, `LiveThenArchiveSettingModelTests`, `LiveModelCacheLockTests` (6 files) |
| Gates | `scripts/conformance-agent-v2.mjs` (does not cover capture); `mac/Scripts/feature-boundaries.sh`; the extension real-meeting checklist in `extension/CLAUDE.md` (manual) |

## 3. Cross-kit edges

| # | From to | Mechanism | Ok? | Evidence |
|---|---|---|---|---|
| E1 | capture to knowledge | `POST /kb/ingest` of the finished capture; Mac writes the file through `Core/Notes` | C | `CaptionScraper.swift:252`, `router.mjs:151` |
| E2 | capture to agent-kit | `runClaude` in-process (summaries, questions, entities); meeting agent through the engine | ok (server layering) | `server/ai-routes.mjs`, `agents/meeting-agent.mjs` |
| E3 | Library to capture | meeting detail wrapped in `LiveCaptureGate`, recording banner and transcript take over | C | `Core/Contracts/LiveCaptureProviding.swift`; `MeetingDetailView.swift` |
| E4 | capture and docs-kit | `/generate-docx` builds a DOCX from the meeting and uses a second notes JSON prompt that duplicates `/generate-notes` | open | docs-kit map section 4 (retire candidate, decision 12) |
| E5 | work-kit to capture | the planner reads `getMeeting` and the transcript | ok | `agents/planner.mjs:8` |
| E6 | extension to Mac (rule) | the extension copies the capture to the Mac and stores nothing (data-lifecycle R1) | C (live-then-archive) | `extension/src/lib/capture-live.ts` |
| E7 | MobileControl to capture | none: the phone cannot record | — | — |
| E8 | agent-kit to capture | live-session routes serve Chat's meeting-attached chat | C | `routes/feature-routes.mjs:18-19` |

**Cycles:** none found. The ReviewConflicts feature and Library both depend on meetings; capture does not depend on either.

## 4. Delegated vs owned

| Piece | Label | Reason |
|---|---|---|
| Summary text (`summarize.mjs`, `/generate-notes`) | Delegated | Model capability. |
| Question drafting (`/generate-questions`, meeting agent) | Delegated | Model capability; the trigger (when to speak) is owned. |
| Entity extraction (`/extract-entities`) | Delegated, **retire candidate** | knowledge-kit map: entities are dead data on the Mac path. |
| Caption reading (AX, Teams, Zoom, content scripts) | Owned (platform) | Per-app UI scraping; no SDK does this. Content-based validation is an invariant (`caption-validation`). |
| Per-speaker delta state (`CaptionDeltaState`, 800 ms scrape) | Owned | Correctness invariant. |
| Live session buffer, ring cap, flush, finalize, ack (`live-sessions`, `live-acks`) | Owned | Durability and the one-copy rule. |
| Captured-file recovery (`PartialRecovery`, `MeetingFileStore`) | Owned | Data safety. |
| Permission checks (`PermissionsService`, Accessibility) | Owned | OS permission. |
| Meeting detection (`AutoCaptureService`, `MeetingPresenceTracker`) | Owned | Product rule: capture only inside a real meeting. |
| Meeting-agent run control (`stopAgent`, in-flight guard) | Owned | Budget and workflow. |

## 5. State and data (feeds K1a)

[data-lifecycle](data-lifecycle.md) already fixes the target; capture-kit's contribution to K1a is mostly verification:

- **Mac:** the meeting file (raw transcript plus summary frontmatter) under the project's `llm-doc/` and `source/` folders is the durable copy (Core/Notes). Capture drafts are partial files until finalize.
- **Server:** `meetings` row (legacy crash-recovery flush while live; deleted at finalize unless `LLMIDE_LIVE_ACK=1`), `live_crash_rows` until ack, in-memory ring buffer, `meeting_agent` run rows in `agent.db` (metadata).
- **Extension:** `chrome.storage` capture draft until copied (`capture-store.ts`); data-lifecycle R1 lists "confirm that the local draft does not outlive the copy" as an open verification item.
- **Phase status:** live-then-archive meeting phases 5 and 6 wait for the user to record real meetings (MASTER-PLAN `(wait)`).
- **Secrets:** none.

## 6. What K1 would move (proposal)

The plan says K0 to K2 to K3 with a short K1. Proposal:

1. **Server half:** mostly done. `/generate-questions` and `/extract-entities` can move out of `server/ai-routes.mjs` into a `routes/capture.mjs` module (additive, no behaviour change) so the notes routes stop sharing a file with unrelated JSON prompts. Retire `/extract-entities` if question C2 says yes.
2. **Mac half:** the AX caption readers are OS access, so in the Tauri target they become **Rust** (macOS AX, Windows UI Automation, Linux AT-SPI best-effort, ADR 0018 table). The delta state (`CaptionDeltaState`, 281) and meeting-presence tracker are pure logic: port to TypeScript with `CaptionDeltaStateTests`, `AutoCaptureTerminationTests` as the fixtures, run in the Node core or the UI.
3. **Summarization pipeline** (`MeetingSummarizationService`, in `Core/Notes`) is shared with Library: it moves with knowledge-kit K1, not here.
4. **Extension:** content scripts stay TypeScript; `useTranscript` (819) is the largest single piece and has `capture-store.test.ts` as its test.
5. **Do not** change caption invariants (per-speaker state, 800 ms scrape, content-based validation, combined-speaker suffix stripping) in a K1.

## 7. Decisions needed from the user

| # | Question | Options | Recommended |
|---|---|---|---|
| C1 | Live capture on Windows and Linux: ship Mac first, or require parity? | Mac first; parity | Mac first; extension capture covers browser meetings on every OS (ADR 0018 risk table) |
| C2 | Retire `/extract-entities` and the entities table path (knowledge-kit Q5 says dead data on the Mac path)? | retire; keep | retire after knowledge-kit Q5 is answered; keep the route until a full release shows no client |
| C3 | `/generate-docx` has its own notes prompt that duplicates `/generate-notes`: make it call the notes path, or keep both? | merge; keep | merge (docs-kit decision 12 already leans this way) |
| C4 | Turn on `LLMIDE_LIVE_ACK=1` by default (keep a finalized capture until the Mac acks)? | default on; stay off | default on once you have recorded real meetings (it is the live-then-archive Phase 5 gate, MASTER-PLAN `(wait)`) |
| C5 | The relay and extension-without-Mac case: should the extension keep recording and **queue the upload** for the Mac when the desktop is off? | queue; refuse | queue, encrypted (relay design), because it is the one write the plan allows while the desktop is off (ADR 0018 "extension records meetings and uploads") |
| C6 | Meeting-attached chat deletion at meeting end needs a reliable end signal. Which signal is authoritative? | finalize from the capturing client; server idle timeout; both | both: finalize first, idle timeout as backstop (data-lifecycle risk R10) |

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Accessibility API behaviour differs per OS and per meeting app version; scrapers break silently | Keep `MeetingCaptureMatrixView`; per-app fixtures; the manual real-meeting checklist stays |
| R2 | Moving capture logic loses the 800 ms cadence or dedupe rules | Port `CaptionDeltaStateTests` first; no change to invariants |
| R3 | Duplicate transcript copies (Mac file, server flush row, extension draft) | data-lifecycle ack protocol; verify with real meetings (wait) |
| R4 | Long meetings exceed caps (`MAX_CAPTIONS_PER_SESSION`, 2 000-line finalize cap, 413 `CAPTURE_TOO_LARGE`) | Already tested in `live-capture-verify` |
| R5 | A permission regression (Accessibility, Screen) after a Rust port | Tauri capability scoping; explicit grant UX |
| R6 | The extension store listing and origin pin are open (MASTER-PLAN) | Not a K1 concern; track there |

## 9. Drift, gaps and corrections to the plan's premises

1. The plan says contract group "notes-generation" for capture; `/generate-notes`, `/generate-questions` and `/extract-entities` are in `server/ai-routes.mjs`, and the group also holds the docs routes (docs-kit map).
2. The plan puts `meeting-agent` under capture-kit; its engine and tools are agent-kit's, and its routes are `/kb/agent/dispatch|stop|runs`. Keep the run **trigger** here.
3. The live routes have **no feature gate** and serve Chat (meeting-attached chat); capture-kit cannot be removed as a unit.
4. The SSE live stream has no event schema in the repo (live-loop-misc schema description), so the live contract is not fully pinned.
5. The Mac `LiveSessionMirror` polls (5 s and 1.5 s) although an SSE route exists (`/kb/live/:id/stream`); `useRemoteSessions.ts:29` says a sessions stream was attempted and never implemented.

## 10. What I could not verify

- Any run-time behaviour: no capture, no `swift test`, no server tests were run for this map.
- That the extension draft is deleted after the copy (data-lifecycle's open item; not re-checked).
- The exact line count of capture logic inside `MeetingSummarizationService` (shared with Library).
- Windows and Linux capture feasibility (Phase 0 covered the shell, not capture).
