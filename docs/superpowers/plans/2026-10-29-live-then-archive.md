# Live-then-archive: one stored copy, live in the server DB, archived to the Mac app

Status: plan; **Phase 0 executed 2026-10-29** (section 11 has the evidence; later phases not started). Branch: `main` (no feature branches, no push). Date: 2026-10-29.
Research basis: read-only pass at `cbd562a0`. Inputs: [data-lifecycle](../../kits/data-lifecycle.md) (the decided rules 1a and 1b), [agent-kit](../../kits/agent-kit.md) and [knowledge-kit](../../kits/knowledge-kit.md) (K0 maps and the "User decisions 2026-10-29" sections), [invariants](../../explanation/invariants.md), `CLAUDE.md`, and the shape of [2026-10-28-agent-store](2026-10-28-agent-store.md). Every `path:line` below was re-read in this pass unless the row says **(from K0, not re-read)**. Items marked **(confirm T0)** must be checked in Phase 0 before code depends on them. Nothing was run and no real `data.db` or Mac store was opened.

## 0. Decisions

### 0.1 Fixed by the user (2026-10-29)

1. **One stored copy** of each kind of data, readable by the Mac app and, through the Mac app (as today), the phone.
2. **Live then archive.** While live, working data is in the server DB. A **meeting-attached chat is deleted when its meeting ends** (no archive). A **normal chat** is archived to the Mac chat store at **app quit**: write, read back to verify, then delete the server rows, the `agent_sessions` mapping, `session_memory` and the SDK transcript. A **next-start recovery sweep** archives a crash-left live session **before deleting anything**. A **user chat delete removes it everywhere**.
3. **Meetings:** the Mac file is the only durable copy. No server `meetings` row survives once the Mac file is final.
4. **Index:** a rebuildable server search index is allowed. It holds no unique data, and a job rebuilds it from the Mac files only.
5. **Extension:** stores nothing. It captures, copies into the Mac app, and calls the Mac app **live** for every read (search, conflict questions, stats, its own chat). Verifying that the API exists is an explicit early task (section 3.7, T0.1).
6. **Metadata** (`agent.db`, `usage_ledger`, personas, tool permissions, connector seen-sets) is **assumed** to stay on the server (lifecycle R7, not yet confirmed).

### 0.1a Answered by the user (2026-10-29, after the plan was written)

- **Q1 = option B (+D):** the Mac JSON file stays the live and final transcript for a Mac chat; at quit the app verifies it and clears the server working state (SDK transcript, `agent_sessions` mapping, `session_memory`); extension chats are live in server rows and archived to the Mac with the fenced protocol.
- **Q3:** a meeting-attached chat has a new `meetingId` field and is deleted when the meeting file is verified, **no undo, no grace period**.
- **Q4:** redact **when building the index**; Mac files stay raw; chats are redacted only while live in the DB.
- **Q5:** **never wipe** the Mac chat store on sign-out; files are tagged with their owner (`ownerUserId`) so another user never sees them (this also answers the multi-user part of Q6).
- **Q18 (accepted the recommendation, 2026-10-29):** **remove** the extension's local chat buffer (`chatMessages`, 200 msgs); when the server is unreachable the extension shows "Mac app not running" and stores nothing. Capture drafts remain only until the Mac acks.
- Still open: Q2 (continue an ended chat, default replay), Q6 beyond the owner filter, Q7-Q17, Q19-Q22 (defaults in section 8 apply until answered).

### 0.2 Defaults pending user confirmation (NOT decided, marked DEFAULT-ASSUMPTION everywhere they bite)

- **R2b, DEFAULT-ASSUMPTION:** an ended normal chat can be **continued** by replaying archived history into a fresh SDK session. Read-only is the alternative and the cheaper build.
- **R4, DEFAULT-ASSUMPTION:** redaction in the **live phase only**; the archive is raw. Section 3.9 shows this default conflicts with the index (R3) and proposes a narrow correction.
- **Mac chat live store, RECOMMENDATION (needs a user yes):** option B in section 1, not the literal "live rows in the DB" for Mac chat.

### 0.3 Non-goals

Moving metadata off the server; per-user Mac folders (flagged as a question); plans and graph/memory artifacts (lifecycle R6, out of scope); Tauri/relay readers; changing the stream protocol or the prompt (nothing here touches token cost per turn).

## 0.4 What the research changed about the framing (read this first)

| # | Finding | Evidence |
|---|---|---|
| F1 | **There is no "Mac app API" the extension can call.** The Mac app listens on exactly one network port for outsiders: WebSocket `:3006` for the iPhone. The extension's only counterpart is the **local Node server** (`127.0.0.1:3456`) that the Mac app spawns and owns. "Call the Mac app live" therefore means "call the Mac-managed local server, which serves from the server DB and its index". The server cannot read the Mac's chat files or meeting files by itself (no Node parser for them exists). | `mac/Sources/LlmIdeMac/Features/MobileControl/Services/MobileControlManager.swift:17,420`, `Core/Networking/BackendManager.swift:211-222,234`, `extension/src/lib/kb.ts:37,90-98,120,128` |
| F2 | **The extension-to-Mac meeting copy path exists** (the K0 maps said they could not find it). The extension pushes captions to `POST /kb/live/:id/append` and `/finalize`; the server keeps them in an in-memory ring buffer; the Mac `LiveSessionMirror` polls it and, on `finalized`, posts `.liveSessionFinalized` so the Mac writes the note. | `extension/src/sidepanel/hooks/useLiveSync.ts:155-156,210-211`, `extension/routes/live.mjs:36-60`, `Features/Live/Services/LiveSessionMirror.swift:264-305` |
| F3 | **A finalized extension session lives only in server RAM until the Mac picks it up.** `finalizeSession` deletes the crash-recovery `meetings` row at once (`live-sessions.mjs:249`), and idle sessions are evicted after `SESSION_TTL_MS` = 30 min (`:44,83-91`). If the Mac is not polling, that capture is lost. This is a **live data-loss window today**, independent of this plan; the ack protocol (3.6) closes it. | `extension/agents/live-sessions.mjs:43-44,83-91,231,249,299` |
| F4 | **The server `meetings` table is also the search index.** FTS rows are produced by triggers on `meetings` and `entities` (`trg_meetings_ai/ad` in `0001_initial.sql:46-55`, `trg_meetings_au` in `0014`), and `search()` hydrates meeting hits from `meetings` (`kb/db.mjs:229-244,378-390`). Deleting `meetings` rows (the decided rule) deletes search with it. The rebuildable index therefore needs **its own table**, not a smaller `meetings`. | as cited |
| F5 | **Quit hooks are synchronous and the backend dies at the same moment.** `AppTerminationHooks.runAll()` runs on the main actor and the doc comment says an async hook "would never finish"; `applicationShouldTerminate` today is a synchronous confirm-drafts check; `BackendManager` kills the spawned child on `willTerminate`. An archive that must call the server needs `applicationShouldTerminate` to return `.terminateLater` and reply after the work, with a time cap. | `Core/Platform/AppTerminationHooks.swift:9-37`, `Core/Platform/AppDelegate.swift:98-101,171-176`, `BackendManager.swift:211-222,234-246` |
| F6 | **"Meeting-attached chat" does not exist as a kind.** `ChatScope` has `explorer, conflicts, visual, docGen, quick` and `ChatSession` has no meeting field. It has to be defined (Q3). | `Core/Contracts/ChatScope.swift:12-18`, `Features/Chat/Models/ChatSession.swift:17-60` |
| F7 | **User delete is "file first, server best-effort".** `deleteSession` removes the Mac file, then awaits `forgetSessionMemory` and `deleteAgentV2Session`, whose failures are swallowed ("a failure just leaves a stale mapping"). That is not "delete everywhere" and leaves SDK transcripts and facts orphaned. | `Features/Chat/Session/ChatEngine+Session.swift:707-745`, `extension/routes/agent-v2.mjs:751-770` |
| F8 | **The server chat tables have one real user: the extension.** One rolling `surface='extension', mode='transcript'` session. The Mac never calls them. | `extension/kb/chat-sessions.mjs:1-4`, `extension/src/lib/unified-chat.ts:103-128`, `extension/routes/chat.mjs:21-125` |
| F9 | **A tombstone pattern already exists** for cross-store purges that must survive a failure: `pending_agent_purges` (migration `0049`) replayed at boot by `kb/agent-jobs.mjs:43-57`. Reuse it for delete-everywhere. | `extension/kb/migrations/0049_pending_agent_purges.sql`, `extension/kb/db.mjs:955,1049` |
| F10 | **Sign-out wipes the only copy.** `resetForSignOut` does `ChatSessionStore.clear()`. | `Features/Chat/Services/ChatEngineRegistry.swift:459-462` |
| F11 | **Nothing feeds `/kb/generate-plan` a real meeting.** No Mac caller; the extension pins the route but its own comment says it never sends a real transcript. So the planner's `getMeeting` dependency is cheap to re-point. | `mac/Sources/APIContractLab/Routes.swift:200`, `extension/src/sidepanel/App.tsx:183`, `extension/agents/planner.mjs:8,136-141` |
| F12 | **(Phase 0)** The planned `note_index` update/delete triggers (3.8) delete their FTS row with `DELETE FROM search WHERE meeting_id = ...`; `meeting_id` is UNINDEXED in FTS5, so that is a full scan. Measured: a 20 KB upsert-as-update costs p50 55 ms / p95 79 ms at 50k rows against a 20 ms budget (insert is 0.6 / 15 ms). Migration `0037` already solved this for `sources` with a rowid mapping table. | `extension/scripts/bench-note-index.mjs`; `0037_search_source_rowid.sql` |
| F13 | **(Phase 0)** A meeting note without `platform` frontmatter does not decode (`MeetingFrontmatter.platform` is required), so `FolderIndexer.upsert` (called under `try?`) silently never indexes it: it is invisible to Library and would be invisible to the reconcile feed. | `Core/Notes/Models/MeetingFrontmatter.swift`, `FolderIndexer.swift`; test `LtaOldFormatFixtureTests` |
| F14 | **(Phase 0)** N-1 hole: a session file with the new keys (`meetingId`, `ownerUserId`, `origin`, `archive`) decodes on an old Mac but the keys are **dropped when that Mac re-saves** the file. An old Mac that touches a chat strips its owner and meeting tags. | `LtaOldFormatFixtureTests.unknownKeysAreDroppedOnResave` |
| F15 | **(Phase 0)** The extension's chat still has a local store: `chrome.storage.local` key `chatMessages` (200 messages) used whenever the server session cannot be created. "Extension stores nothing" (0.1 rule 5) is not true today for chat either; only the meeting transcripts were in the plan. | `extension/src/sidepanel/hooks/useChat.ts:22-23,40-82` |
| F16 | **(Phase 0)** CORS allows **every** `chrome-extension://*` origin, not one extension id (CLAUDE.md says `<id>`); auth is still a JWT on every non-public route. | `extension/server.mjs:522-541` |
| F17 | **(Phase 0)** `deleteSdkTranscripts` already scans the operator's ambient `~/.claude` as well as the per-user home, so risk R9/DL5 ("subscription turns cannot be deleted") is **wrong**: they are deletable per session id. | `extension/llm_agent/sdk/transcripts.mjs:26-40` |
| F18 | **(Phase 0)** The extension-captured note is written by AppShell from the **Mac mirror's in-memory captions** (human-only, growing utterances merged in place), not from the server buffer. The ack's `lines` must be compared with the mirrored count, not the server's `captionCount`; a Mac that joined late holds a partial transcript while the server buffer is complete. A failed write sets `recoveryError` and the mirror never retries (deduped per session), while the server already deleted its crash row at finalize (F3). | `Shell/AppShell.swift:169,1197-1290`, `LiveSessionMirror.swift:264-306` |
| F19 | **(Phase 0)** Extension-captured notes never reach the server index today: `generateNoteForLiveSession` does not call `ingestMeeting`. DL15 is a behaviour gain, not a regression risk, and `/kb/stats.meetings` (a `COUNT(*)` on `meetings`) reads 0 after Phase 6 unless re-pointed (T3.1). | `AppShell.swift:1197-1290`, `kb/meetings.mjs:295-298` |
| F20 | **(Phase 0)** `plans.meeting_id` is `REFERENCES meetings(id) ON DELETE SET NULL` (`0001_initial.sql:123`, `foreign_keys=ON`). Deleting legacy meeting rows (5.1) silently detaches plans from their meeting; the plan and its FTS row survive (pinned by test). | `tests/lta-legacy-fixtures.test.mjs` |

---

## 1. Architecture decision

### 1.1 The question

The user wants one copy that is "live in the DB, archived to the Mac at app quit". Today a **Mac chat** is live in a Mac JSON file (`ChatEngine+Session.swift:79-81`), debounced, 500 messages, and the server DB holds only working state for it. Which store is live for a Mac chat?

### 1.2 Options for the Mac chat

| Option | Live transcript | At quit | Pros | Cons and risks |
|---|---|---|---|---|
| **A. Literal** | Server `chat_messages` rows; the Mac engine writes through to the server on every message; no Mac file while live | Mac reads rows, writes `sessions/<uuid>.json`, verifies, server deletes rows | Matches the user's words exactly; the live copy survives Mac-side file corruption and the sign-out wipe; a phone or extension could read live sessions without the Mac engine (R5 option c) | Largest Swift change: `ChatEngine+Session` (804 lines), `ChatEngineRegistry` (463), `ChatSessionStore` (206), the phone host; persistence on the hot path of every message (needs coalescing, a version precondition for "two writers, one set of rows"); the DB becomes the **only** copy for hours or days (a long-running app), so DB loss or an unnoticed rollback loses chats; 500 vs 2 000 message cap mismatch; redaction on live rows changes reload fidelity; the registry's "disk is the hand-off" rule is rewritten |
| **B. Recommended: Mac file stays the live and final transcript; the DB holds only what the server needs** | Mac `sessions/<uuid>.json`, unchanged | Verify the file loads and matches the engine, then purge the **server working state** (SDK transcript, `agent_sessions` mapping, `session_memory`) | One transcript copy at every moment (the strongest reading of rule 1). Smallest change: no transcript write path to the server, no hot-path cost, no new Swift store. The DB never holds a transcript for a Mac chat, so DB loss cannot lose one. Delete-everywhere and the sweep are the only new Mac work | Not literally "live in the DB": for Mac chat the transcript is never in the DB. "Archive" degenerates to "verify the Mac file, then purge working state". The phone and extension see a live Mac chat only through the Mac engine (R5 option a or b), as today. Continuing an ended chat starts a fresh SDK session (R2b) |
| C. Mirror | Mac file live, server rows mirror it | Delete the mirror | Phone could read rows | A **second copy while live**; rejected by rule 1 |
| **D. Hybrid by client (part of the recommendation)** | For clients that have no file of their own (the **extension chat**, F8): server rows are the live copy and the **Mac archives them at quit** (the literal protocol). For the Mac chat: option B | Extension chat: archive then delete rows. Mac chat: purge working state | Honours the literal rule exactly where a server-side live copy already exists (the one real consumer of `chat_sessions`); no change to the Mac engine | Two paths, but each is the existing store of its client; one Mac archive format |

**Recommendation: B for Mac chat plus D for the extension chat.** Rule 1 is "one stored copy"; B keeps that true at every instant, A makes it true only after quit and puts the only copy in a DB for the longest window. The user's words say "live in DB"; B reads "live" as "working state the server needs while the session runs" and gives the user a one-line reason (Q1). If the user insists on A, section 6.1 lists the delta (Phase A', about 3 L tasks) and the rest of this plan (protocol, sweep, extension, index) is unchanged.

### 1.3 The architecture in eight lines

1. Meeting: Mac file is the only durable copy; no server meeting row after it is final.
2. Mac native capture: partial file is the live copy; no server row at all; the finalized note is fed to the index.
3. Extension capture: server RAM ring buffer (plus a crash-recovery row) is the live copy until the **Mac acks** a verified file; the extension keeps a draft only until it sees that ack.
4. Index: new `note_index` table plus FTS (kind `meeting`), derived and redacted, fed by a Mac-driven reconcile job; drop-and-rebuild from files is the proof it holds no unique data.
5. Mac chat: the Mac file is the live and final transcript; at app quit (async `.terminateLater`, time-capped) verify the file, then purge server working state; next-start sweep repeats it.
6. Extension chat: server rows are live; the Mac archives them at quit through a fenced begin/commit protocol into `sessions/<uuid>.json`; sweep adopts crash-left sessions first.
7. Meeting-attached chat: deleted (file and server working state) after the meeting file is verified; a Mac `meetingId` field defines the kind (Q3).
8. Delete everywhere: tombstone in the server DB, retried at start, plus a reverse sweep that purges server working state whose Mac chat no longer exists; kill-switch preference defaults off for the first release.

---

## 2. Inventory (verified file:line)

### 2.1 Server stores touched

| Store | Created by | Writers | Readers | Fate under this plan |
|---|---|---|---|---|
| `meetings` + `entities` + FTS rows (`search`) | `0001_initial.sql:46-65`, `0014` | `kb/meetings.mjs:29-118` (`ingestMeeting`), only caller of note for Mac captures `Features/Live/Services/CaptionScraper.swift:354` via `LlmIdeAPIClient+KB.swift:75`; live-session crash row `extension/agents/live-sessions.mjs:299` | `kb/db.mjs:229-244,370-470` (`search`), `kb/meetings.mjs:130-190` (`getMeeting`, `getMeetingTranscript`, `listMeetings`), `agents/planner.mjs:8,137-139`, `routes/router.mjs:356-365`, `kb/os-state.mjs:155`, `kb/exporter.mjs:37-39`, user cascade `kb/db.mjs:966` | Stop writing after Phase 6; legacy rows migrated then deleted; readers moved to `note_index` in Phase 3 |
| `chat_sessions`, `chat_messages` | `0023_unified_chat_sessions.sql` | `kb/chat-sessions.mjs:33-158`; routes `routes/chat.mjs:21-125`; extension `src/lib/unified-chat.ts:35-128` | extension only (F8) | Stay as the live store of the extension chat; rows deleted at archive commit |
| `agent_sessions` (C3) | `0029` | `kb/agent-sessions.mjs:40,66,88,102` | v2 engine | Purged at quit/sweep/delete |
| `session_memory` (C4) | earlier migration, keyed by chat UUID without FK | `kb/session-memory.mjs:87,182` | v2 engine (`resolveChatSessionId` `:23`) | Purged with the session |
| SDK transcript jsonl (C2) | `<dataDir>/agent-sdk/<userId>` or operator `~/.claude` | `llm_agent/sdk/transcripts.mjs` **(from K0, not re-read)**; deleted by `deleteSdkTranscripts` in `routes/agent-v2.mjs:751-770` | SDK resume | Purged with the session. Subscription (ambient) turns write into the operator's `~/.claude`; `deleteSdkTranscripts` scans that root too (per file, by session id), so they are deletable (resolved in T0.2, F17) |
| Live caption ring buffer | memory only, `agents/live-sessions.mjs:43-44` (2 000 captions, 30 min TTL) | `routes/live.mjs:36-60` | Mac mirror, extension remote views | Kept; deletion moves from "at finalize" to "at ack" |
| `pending_agent_purges` | `0049` | `kb/db.mjs:955` | `kb/agent-jobs.mjs:43-57` | Pattern reused (3.5) |

Latest migration is `0049`; the new one is **`0050`**. `SERVER_API_VERSION = 83` (`extension/server.mjs:288`); this plan bumps it to **84** (additive routes, Phase 1) and to **85** (removals, Phase 6). `MIN_SERVER_API_VERSION = 20` (`extension/src/sidepanel/App.tsx:84`) is not touched by additive work; verify whether Phase 6 route removals need it raised (confirm T0).

### 2.2 Mac stores touched

| Store | Where | Notes |
|---|---|---|
| Chat sessions | `~/Library/Application Support/llm-ide/sessions/<uuid>.json` (`ChatSessionStore.swift:4-9,49-50`); `ChatSession` has `scope`, `engine`, `projectId`, no meeting or origin field (`ChatSession.swift:17-60`); list/load/save/delete `ChatSessionStore.swift:70-147`; cap 500 (`ChatEngine+Session.swift:79`) | One directory, **not per user** (agent-kit 5.3 item 3, from K0) |
| Meeting files | `<project>/source/meetings/YYYY/MM/*.md` via `MeetingFileStore`, partial files via `PartialRecovery`; finalize at `CaptionScraper.swift:311-333` | The durable copy |
| Note index (Mac) | `system/index.sqlite`, `hidden` tombstone (`LibraryView.swift:1827-1835`, from K0) | Not rebuildable bit: `hidden` |
| Quit flush | `ChatEngineRegistry.flushAll()` registered at `Shell/LlmIdeMacApp.swift:199` | Synchronous; stays |
| Sign-out wipe | `ChatEngineRegistry.swift:459-462` | Changed in 3.4 |

### 2.3 Extension stores and read paths

| Item | Where | Under this plan |
|---|---|---|
| Saved meetings (cap 50) and per-recording draft | `chrome.storage.local` keys `transcripts`, `transcriptDraft:<id>` (`extension/src/lib/storage.ts:6-12,47-104`, written by `useTranscript.ts:6-7,215`; from K0 for line numbers, key names re-seen at `storage.ts:28-45`) | Only the draft remains, deleted at Mac ack (3.6); history view reads the index live |
| Chat | `/chat` (`useChat.ts:145`), `/kb/chat/sessions*` (`unified-chat.ts`) | Stays as live server rows; no extension-side store; archived at Mac quit |
| Search, conflict questions, stats | `kb.ts:89-98` (`/kb/search`), `:114-125` (`/kb/conflict-questions`), `:128-133` (`/kb/stats`) | Same calls; data behind them changes (3.7) |
| Pinned endpoints | `App.tsx:57-75` `REQUIRED_ENDPOINTS` includes `/chat`, `/kb/ingest`, `/kb/search`, `/kb/chat/sessions` | `/kb/ingest` removal in Phase 6 must edit this list |
| Other extension routes | `/generate-questions`, `/kb/agent/*` (persona, runs, dispatch), `/launch-app` (`server.mjs:683`) | Unchanged; personas stay (R7) |

### 2.4 Contracts and gates that constrain the work

`extension/server.mjs`: `ALL_ENDPOINTS` (the `/kb/live/*` rows at `:385-389`, chat rows at `:409-411`), write classification via `kbWrite` (`:443-445` pattern), schemas under `schema/http/*.schema.json`, `schema/http/swift-decode-allowlist.json`, `mac/Sources/APIContractLab/Routes.swift`. Gates: `make contract-gates`, `make regression` (`Makefile:107`), `make test`, `make test-mac`, `make chat-gates` (`:188`), `mac/Scripts/feature-boundaries.sh`. Test DB isolation: `NODE_TEST_CONTEXT` temp DB (memory: test-db-isolation). Mac tests: always `LLMIDE_KEYCHAIN_BACKEND=memory`.

---

## 3. Design

### 3.1 Data homes and end events (the table every phase refers to)

| Kind | Live home | End event | Durable home | At end the server deletes |
|---|---|---|---|---|
| Meeting, Mac capture | Mac partial file (`PartialRecovery`) | file finalized and verified | `source/meetings/…md` | nothing (no row ever written after Phase 6) |
| Meeting, extension capture | server RAM ring buffer + crash row; extension draft | Mac **ack** of a verified file | `source/meetings/…md` | ring buffer, crash row |
| Meeting notes/summary | note frontmatter and headings | n/a | same file | nothing |
| Normal Mac chat | Mac file | app quit (or sweep) | same Mac file | `agent_sessions` row, SDK jsonl, `session_memory` |
| Extension chat | server `chat_*` rows | app quit (or sweep) | Mac `sessions/<uuid>.json` (scope `.quick`, `origin: "extension"`, DEFAULT choice, Q9) | the `chat_*` rows |
| Meeting-attached chat | Mac file (as any Mac chat, tagged with `meetingId`) | meeting file verified | **none** | `agent_sessions`, jsonl, `session_memory` (the Mac file is deleted by the Mac) |
| Index (`note_index`, FTS) | server | n/a | derived; rebuilt from Mac files | rows of a deleted or hidden note, on reconcile |
| Metadata | server | n/a | server | n/a (R7 assumption) |

### 3.2 Chat protocol, Mac chat (option B): verify then purge working state

State is derived, not stored: a session is "ended" when no engine holds it. No new ledger table.

Quit sequence (`applicationShouldTerminate` returns `.terminateLater`, after the existing drafts confirmation):

1. `ChatEngineRegistry.flushAll()` (existing, synchronous). Collect the set `S` of chat UUIDs with a server mapping or facts: `GET /kb/agent/working-state` (new, 4.1) returns `[{chatSessionId, sdkSession, factCount, updatedAt}]` for the user.
2. For each `id` in `S` (bounded concurrency 4, whole sequence capped at 6 s): `ChatSessionStore.load(id:)`. Verify: decodes, `messages.count == min(engineCount, 500)` when an engine is known, else count > 0 and `lastUsedAt` not older than the server's `updatedAt`. If verification fails, **skip the purge for that id** and log; the working state stays (harmless).
3. `POST /agent/v2/sessions/purge {chatSessionIds:[…], verified:true}` (new batch route, reuses `deleteAgentSession`, `deleteSdkTranscripts`, `deleteSessionMemory` from `routes/agent-v2.mjs:751-770`). Idempotent: unknown ids succeed.
4. `NSApp.reply(toApplicationShouldTerminate: true)`. On the time cap the reply is sent anyway and the next-start sweep finishes the job. A forced quit, crash or power loss skips all of this; the sweep covers it.

Sweep at start (after the backend is healthy, off the launch critical path, within 10 s): same steps 1 to 3 for every `id` in `S` whose chat is not held by an engine. **Orphan rule:** server working state whose Mac file does not exist is purged only after a 7-day grace (a user delete whose tombstone was lost would explain it); before that it is reported in the Storage hub. (It is not a transcript, so the grace is a courtesy, not a loss window.)

Cost, stated for the user: after quit the SDK session is gone. Continuing an ended chat is `fresh` plus `history` (`AgentV2Transport.swift:276-282`, from K0): it loses the prompt cache and session-memory continuity for that chat. That is R2b DEFAULT-ASSUMPTION (a); under (b) the chat opens read-only and "continue" starts a new chat.

### 3.3 Chat protocol, extension chat (option D): fenced archive

The live copy is `chat_sessions` + `chat_messages`. The Mac archives into `sessions/<uuid>.json` using the **server session UUID as the file name** (`crypto.randomUUID`, `kb/chat-sessions.mjs:37`), so the archive is idempotent by id.

DDL, migration `0050` (additive; `ALTER TABLE` only, defaults keep old rows valid):

```sql
ALTER TABLE chat_sessions ADD COLUMN lifecycle     TEXT NOT NULL DEFAULT 'live';  -- live | archiving
ALTER TABLE chat_sessions ADD COLUMN fence         INTEGER NOT NULL DEFAULT 0;    -- bumped by begin; appends carry it
ALTER TABLE chat_sessions ADD COLUMN archive_since TEXT;                          -- when archiving began (stale-fence break)
```

Routes (all `kbWrite`, section 4.1):

1. `POST /kb/chat/sessions/:id/archive/begin` → sets `lifecycle='archiving'`, `fence=fence+1`, returns `{fence, count, hash, session, messages[]}`. `hash` = SHA-256 over the ordered `(role, content)` pairs, newline-delimited with length prefixes (no ambiguity). Messages are returned in full (no 500 cap: see Q8). Re-calling `begin` while `archiving` returns a fresh snapshot with a new fence (idempotent).
2. Mac writes the file atomically (temp then rename, as the existing store does), `ChatSession{scope:.quick, origin:"extension", archive:{hash,count}}`.
3. Mac reloads it through `ChatSessionStore.load`, recomputes `(count, hash)` over the decoded messages, compares with step 1.
4. `POST …/archive/commit {fence, hash}` → in **one transaction**: if `fence` and the current message hash still equal, delete `chat_messages` and the `chat_sessions` row, return `{deleted:true}`. Mismatch (an append raced in) returns 409 `ARCHIVE_STALE`; the Mac re-runs from step 1 (the file is overwritten, same name).
5. Appends during `archiving` are accepted with the current fence and change the hash (so commit 409s) rather than rejected, because losing the extension's last message is worse than one more loop. A fence older than 10 minutes is broken on the next `begin` (an abandoned archive cannot wedge a session).

The extension sees `lifecycle='archived'` as "session not found" and starts a new rolling session (`ensureTranscriptSessionId`, `unified-chat.ts:103-126`). It keeps nothing.

### 3.4 Crash points, recovery, and the other required cases

| # | Crash or event | State left | Recovery | Data lost? |
|---|---|---|---|---|
| C1 | Mac chat: app killed before quit hook | Mac file complete up to the debounce (≤ 1 s, `ChatEngine+Session.swift:81`); server working state present | Start sweep purges working state | Up to the last debounced second, as today |
| C2 | Quit: after verify, before purge call | file ok, working state present | sweep purges | None |
| C3 | Quit: purge partly done (jsonl deleted, mapping left) | partial working state | purge is idempotent per piece; sweep repeats | None (working state only) |
| C4 | Quit hits the 6 s cap | verified or unverified files, working state present | sweep | None |
| C5 | Extension chat: crash after `begin`, before file write | rows intact, `lifecycle='archiving'` | start sweep lists sessions in `archiving`/`live` with no file → `begin` again | None |
| C6 | after file write, before commit | rows **and** file | sweep: file exists and hash equals server hash → `commit`; hash differs → treat file as stale, re-`begin`, overwrite | None |
| C7 | after commit, before Mac records success | file only | nothing to do | None |
| C8 | Server DB lost while a live extension chat exists | live rows gone | none | **The extension chat since the last archive** (R3 data-loss window; see section 6) |
| C9 | Mac file write fails (disk full) | rows intact | verify fails, commit never sent, sweep retries, banner in the Activity feed | None while rows stay |
| C10 | User deletes a chat | Mac file gone, server work not yet | tombstone (3.5) retried at every start | None (intent is deletion) |
| C11 | Two Mac windows / two engines on one id | one registry holds one engine per session (`ChatEngineRegistry`, agent-kit 5.5, from K0) | extension archive is Mac-wide and single-flight (an `actor ChatArchiveService`); a second `begin` just supersedes the fence | None |
| C12 | Sign-out mid-session | Mac store wiped today (F10), live rows remain | Sign-out becomes: run the archive/purge sequence for the signing-out user first (cap 6 s), then wipe; rows left behind are adopted by that user's next sign-in sweep. **Q5** decides keep vs wipe | Today: all Mac chats on sign-out; after: none if the archive ran |
| C13 | Phone mid-session | Phone chat turns run on the Mac's off-screen engine pool (`ExplorerMobileEngineResolver`, from K0) and write the Mac file | Same as Mac chat; app quit ends the phone turn too | None beyond C1 |
| C14 | A session that never ends (app open for days) | Mac chat: transcript already single-copy on Mac. Extension chat: rows are the only copy | Idle archive: any extension chat idle for 30 min is archived while the app runs (same protocol); makes the DB-only window ≤ 30 min of idleness plus active time | None |
| C15 | Backup/restore | Mac store and project folders are the only durable copies; `data.db` restore resurrects **old** working state | After a restore the start sweep purges working state for ended chats and the index reconcile (3.8) repairs drift; restoring `data.db` can resurrect an already archived extension chat (duplicate): the sweep drops a server session whose `archive.hash` file exists on the Mac | None; a restore can show a duplicate once |
| C16 | Multi-user (user B signs in on the same Mac) | Mac dir is not per user, server rows are | Archived and tombstone entries carry `userId`; the sweep acts only for the signed-in user's rows. Mac files get an `ownerUserId` (optional, decode-tolerant) written at archive; chat list filters by it when present. **Q6** | A's chats stay on disk; they are hidden from B |

Never delete before verify, and never delete the only copy: the sweep's rule table is "archive first if the server has the only copy; purge only what is a derivative".

### 3.5 Delete everywhere (user delete)

1. Mac deletes the chat file (existing `ChatSessionStore.delete`).
2. Mac writes a **tombstone** `POST /kb/session-purges {chatSessionId}` into `pending_session_purges` (new, 0050; mirrors `pending_agent_purges`, column `deleted_chat_id`, not `user_id`, same reason as `0049`'s header). Server replays it at boot and on a 10-minute timer: deletes `agent_sessions`, SDK jsonl, `session_memory`, `chat_*` rows with that id, any `note_index` entry (chats are not indexed today; guard for future), then removes the tombstone.
3. If the tombstone POST itself fails, the Mac stores it in a tiny local `pending-deletes.json` (a **tombstone, not data**) and retries at the next start. This replaces the best-effort calls at `ChatEngine+Session.swift:735-744`.
4. Reverse sweep (Phase 4): server working state whose Mac file does not exist and that has no tombstone is flagged, then purged after the 7-day grace (3.2).

```sql
CREATE TABLE IF NOT EXISTS pending_session_purges (
  deleted_chat_id TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT 'user_delete',  -- user_delete | meeting_end
  attempts        INTEGER NOT NULL DEFAULT 0,
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (deleted_chat_id, owner_user_id)
);
```

Account delete: `deleteUserCascade` (`kb/db.mjs:946-1044`) must delete the new tables' rows for the user; `tests/user-delete-cascade.test.mjs` enumerates `user_id` tables and will fail until `note_index` is added (`pending_session_purges` uses `owner_user_id` and is excluded on purpose, like `0049`).

### 3.6 Meeting flow

**A. Mac native capture** (today `CaptionScraper.swift:295-360`)

1. Partial file is the live copy. At stop: `MeetingFileStore.finalize(...)` (`:311`), then `PartialRecovery.cleanup` (`:320`) **only after verify** (new): the finalized file reads back, frontmatter parses, transcript line count equals the in-memory rows. Today cleanup runs unconditionally after finalize; verify-first is a small ordering change.
2. Post `.meetingFinalized` (new, `Core/Platform/NotificationNames`) with `{noteKey, projectId, fileURL}`. Library's feeder (3.8) upserts the index row. **Remove `api.ingestMeeting` (`:354`)**: under the pref `lta.mode == on` it is not called; `entities: []` (`:304`) disappears with it.
3. The `ingest` failure path (`lastIngestStatus`, `:354-360`) loses its meaning; the UI status moves to "indexed" (best-effort, never blocks the note).

**B. Extension capture**

1. Extension: `useLiveSync` pushes captions (existing). The draft (`transcriptDraft:<id>`) stays as a crash buffer.
2. Stop: `POST /kb/live/:id/finalize` (existing). Server: **no longer deletes the crash row or the buffer at finalize**; it marks the session `finalized` and keeps it until acked (changes `live-sessions.mjs:231-249`).
3. Mac: `LiveSessionMirror` sees `finalized`, posts `.liveSessionFinalized` (existing, `:264-305`); the receiver is `Shell/AppShell.swift:169`, which runs `generateNoteForLiveSession` (`:1197-1290`): it writes the file from the **mirror's in-memory captions**, calls `PartialRecovery.cleanup` unconditionally and sets `recoveryError` on failure (resolved in T0.2, F18). New: after the file is written and verified, the Mac calls `POST /kb/live/:id/ack {noteKey, hash, lines}`.
4. Server on ack: delete the buffer and the crash `meetings` row, keep a 24 h ack tombstone `{id, ackedAt}` in memory + a row in a small `live_acks` table (survives restart; no content).
5. Extension: after `finalize`, polls `GET /kb/live/:id/status` → `{state: live|finalized|acked|unknown}`; deletes its draft only on `acked`. On `unknown` (server restarted, tombstone gone) it keeps the draft and shows "not confirmed copied" instead of discarding (extension data-loss rule).
6. Unacked sessions: eviction by TTL no longer deletes a finalized-but-unacked session (F3). The Mac at start calls `GET /kb/live/unacked` and writes files for any session found (adoption), then acks. The crash row is the only thing that survives a server restart, which is why it must not be dropped at finalize.

**C. What happens to legacy server rows**: section 5.

**D. Who reads what after the change**

| Reader | Today | After (Phase 3 on) |
|---|---|---|
| Agent `search_kb` | `ctx.kb.search` over FTS, meeting hits hydrated from `meetings` (`kb/db.mjs:229-244`, `search-kb.mjs:27` from K0) | same call; meeting hits hydrate from `note_index` (`kind='meeting'` preserved, so default search behaviour for Mac meetings is unchanged; the token bench must still pass, Q10) |
| Planner `generatePlan` | `getMeeting` + `getMeetingTranscript` (`planner.mjs:137-139`) | request may carry `transcript`; else `note_index.body_text`; "meeting not found" only when neither exists. No shipping caller (F11) |
| `/kb/conflict-questions` history | `kb.search` kinds decision/blocker/action (`router.mjs:1428-1432`, from K0) from `entities`, empty today | unchanged (still empty); entities retired (Q7) |
| `GET /kb/meeting/:id`, `/kb/search` list path | `meetings` | `note_index` (title, date, duration, projectId; `transcript` field only via `body_text`, capped) |
| `/kb/os/state` meeting count | `os-state.mjs:155` | `COUNT(*)` of `note_index kind='meeting'` |
| Exporters | `kb/exporter.mjs:37-39`, `ProjectExporter` second `.md` | retired (Q7) |
| Phone | files via the Mac (`LlmDocBrowser`) | unchanged |
| Extension History / search | `chrome.storage.local transcripts`; `/kb/search` | live `GET /kb/search?kind=meeting` (index) and live Mac-written file list; no local store |

### 3.7 The extension read path: API list, auth, offline

**Verified API (F1).** The extension's server is `serverUrl` (`getServerUrl`, `src/lib/config.ts`), default `127.0.0.1:3456`, auth by `authFetch` (JWT, token held by the extension's existing login), CORS strict allowlist `chrome-extension://<id>` plus localhost (invariants). Endpoints it calls today that read stored data:

| Need | Call | File |
|---|---|---|
| Search | `GET /kb/search` | `src/lib/kb.ts:89-98` |
| Conflict questions | `POST /kb/conflict-questions` | `kb.ts:114-125` |
| Stats | `GET /kb/stats` | `kb.ts:128-133` |
| Own chat | `POST /chat`, `/kb/chat/sessions*` | `useChat.ts:145`, `unified-chat.ts` |
| Live sessions | `GET /kb/live/sessions`, `/:id/stream` | `useRemoteSessions.ts:12`, `useRemoteTranscript.ts:30` |
| Agent history | `/kb/agent/runs`, `/kb/agent/feedback/stats` | `useAgent.ts:87`, `AgentStatsBadge.tsx:26` |

**It is enough only if the data behind those calls exists.** After the change, search and stats are served from `note_index` (derived from Mac files); chat from live rows (3.3). The gap is "when the Mac is not running": the server is a child of the Mac app (`BackendManager.swift:211-246`), so the extension gets connection refused.

**Offline behaviour (specified, not assumed):**
- Reads fail closed with one banner "Open LLM-IDE to search your notes"; the extension never falls back to a local copy (it has none).
- Capture while the server is unreachable: the draft stays in `chrome.storage.local` (crash buffer), `useLiveSync` already retries with backoff (`RETRY_BASE_MS`, `useLiveSync.ts:8-9`) and reports `error` after 3 failures; on reconnect it re-pushes the whole draft (idempotent by `sessionId`+`seq`). The draft is deleted only on `acked`.
- **Open the app:** the service worker already calls `GET /launch-app?to=transcript` on the **server** (`service-worker.ts:18-19`, `server.mjs:683`), which needs the server up. A custom URL scheme for the Mac app (`DeepLinkRouter` exists in Shell) could launch it when the server is down; whether `llmide://` is registered in `Info.plist` and CORS/Chrome allows it is **not verified** (confirm T0, Q11).
- A Mac app closed with an **adopted/dev server still running** is the one case where reads work with the Mac closed; archive-at-quit then never happens, so the sweep (next Mac start) owns it. Documented, not special-cased.

**T0.1 verification (2026-10-29, read-only).** Every route in the first table exists in `extension/server.mjs` `ALL_ENDPOINTS` and is served by the file shown. All sit behind the same chain: `setCORS` (`server.mjs:522-553`) then `OPTIONS` answered 200 (`:589`) then `authenticate` (`server/auth.mjs:64-82`, bearer JWT, revocation checks) then per-(profile, user) rate limit then `handleKB` (`/kb*`, `/agent/v2*`). Public (no JWT): `/`, `/health`, `/auth/*` entry points and `/launch-app` (`auth.mjs:30-42`).

| Route | Served at | Auth / limit | Extension caller | Status |
|---|---|---|---|---|
| `GET /kb/search` | `routes/router.mjs:274` (`kb.search`, kinds allowlist `:279-285`, limit cap 100) | JWT | `src/lib/kb.ts:89-98` | exists |
| `POST /kb/conflict-questions` | `routes/router.mjs:1417` (`runClaude`, profile `llm`, `server.mjs:471`) | JWT | `kb.ts:114-125` | exists; **calls the model, not stored data** (history input is empty today, see 3.6 D) |
| `GET /kb/stats` | `routes/router.mjs:440` -> `kb/meetings.mjs:271-318` (`computeStats`: counts of `meetings`, `entities`, `sources`, `plans`, `plan_tasks`, `review_items`, outcomes; 2 s TTL cache) | JWT | `kb.ts:128-133` (returns `null` on any failure) | exists; `meetings`/`entities` come from the legacy tables (F19) |
| `POST /chat` | `server/ai-routes.mjs:348`, profile `llmFast` | JWT | `useChat.ts:145` | exists |
| `/kb/chat/sessions*` | `routes/chat.mjs:21-125` | JWT | `src/lib/unified-chat.ts` | exists |
| `GET /kb/live/sessions`, `/:id`, `/:id/stream`, `POST /:id/append`, `/:id/finalize` | `routes/live.mjs:33-173` (`liveAppend` rate profile) | JWT | `useRemoteSessions.ts:12`, `useRemoteTranscript.ts:30`, `useLiveSync.ts` | exists |
| `GET /kb/agent/runs`, `/kb/agent/feedback/stats` | `routes/agent.mjs:103,324` | JWT | `useAgent.ts:87`, `AgentStatsBadge.tsx:26` | exists |
| `GET /launch-app` | `server.mjs:683-757` (302 to `llmide://<tab>?session=`) | **public** | `src/background/service-worker.ts:18-19` | exists; needs the server up |

CORS, exactly: an `Origin` is echoed (never `*`) with `Allow-Credentials: true` when it starts with `chrome-extension://` (**any extension id**, F16), `http(s)://localhost:`, `127.0.0.1:`, `[::1]:`, or is in `LLMIDE_CORS_ORIGINS` (`server.mjs:530-541`). Otherwise no ACAO header, so the browser blocks the response. Methods GET/POST/PUT/PATCH/DELETE/OPTIONS; headers `Content-Type, Authorization, X-Request-ID`. The Chrome extension origin therefore passes CORS and is limited only by the JWT. The server also needs the extension to be signed in as a user: tenancy is per `user_id`, so the Mac and the extension must use the same server account for the extension to see the Mac's notes and for the Mac to archive the extension's chat (Q17).

On `ECONNREFUSED` the extension has three behaviours, none of which read stored data:
- `authFetch` (`src/lib/config.ts:318-343`) rethrows the fetch error and counts a failure; after 5 consecutive failures a 10 s circuit breaker (`:295-300`) answers synthetic 503s without touching the network.
- Health: `App.tsx:236-285` polls `GET /` with a timeout; a failure sets `serverOnline=false`, which renders "Can't reach the local server. Make sure `node server.mjs` is running." with Copy-command and Retry (`App.tsx:520-545`). The text is wrong for a Mac-managed server and is the banner the offline spec in 3.7 replaces.
- Reads: `searchKB` throws, `getKBStats` swallows to `null`, `useChat` shows the error text and falls back to `chrome.storage.local` `chatMessages` (F15).

`llmide://`: registered as `CFBundleURLSchemes` `llmide` and `meetnotes` in the `Info.plist` that `mac/Scripts/build.sh:241-252` writes, so **only a built `.app` registers it** (a raw `swift build` binary has no plist). Handled by `.onOpenURL` -> `DeepLinkRouter.handle` (`Shell/LlmIdeMacApp.swift:521`, `Shell/DeepLinkRouter.swift:44-47`, tabs allowlisted `:96-98`). The extension does not navigate to it directly: the service worker comment (`service-worker.ts:7-14`) says MV3 blocks it and uses the server's 302, which needs the server up, so **today there is no way to launch the app from the extension when the server is down**. Whether `chrome.tabs.create({url: 'llmide://...'})` works from the service worker is unverified without a browser (Q11).

### 3.8 The rebuildable index

**Table** (migration `0050`):

```sql
CREATE TABLE IF NOT EXISTS note_index (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  project_id   TEXT NOT NULL DEFAULT '',
  note_key     TEXT NOT NULL,           -- stable: relative path under the project root, forward slashes
  kind         TEXT NOT NULL,           -- 'meeting' now; others only via a later flag (token bench)
  title        TEXT NOT NULL,
  date         TEXT NOT NULL,           -- note start, ISO
  duration_sec INTEGER NOT NULL DEFAULT 0,
  participants TEXT NOT NULL DEFAULT '[]',
  body_text    TEXT NOT NULL DEFAULT '',-- derived, REDACTED, capped (Q4, Q12)
  content_hash TEXT NOT NULL,           -- SHA-256 of the Mac file bytes
  mtime_ms     INTEGER NOT NULL,
  meta         TEXT NOT NULL DEFAULT '{}',
  indexed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, project_id, note_key)
);
CREATE INDEX idx_note_index_user_date ON note_index(user_id, date DESC);
-- FTS rides the existing `search` table so ranking and kinds are unchanged:
CREATE TRIGGER trg_note_index_ai AFTER INSERT ON note_index BEGIN
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES ('n:' || NEW.id, NULL, NEW.kind, NEW.title, NEW.body_text);
END;
CREATE TRIGGER trg_note_index_au AFTER UPDATE ON note_index BEGIN
  DELETE FROM search WHERE meeting_id = 'n:' || OLD.id;
  INSERT INTO search (meeting_id, entity_id, kind, title, body)
  VALUES ('n:' || NEW.id, NULL, NEW.kind, NEW.title, NEW.body_text);
END;
CREATE TRIGGER trg_note_index_ad AFTER DELETE ON note_index BEGIN
  DELETE FROM search WHERE meeting_id = 'n:' || OLD.id;
END;
```

**Phase 0 correction (F12):** the update and delete triggers above scan the FTS table (UNINDEXED `meeting_id`). T1.1 must use the `0037` pattern: a `search_note_rowid(note_id PRIMARY KEY, search_rowid)` mapping filled by the insert trigger (`last_insert_rowid()`) and `DELETE FROM search WHERE rowid = (SELECT search_rowid ...)` in the update/delete triggers. The SQL above is the shape, not the final text.

The `'n:'` prefix keeps legacy `meetings` ids and index ids from colliding during the shadow phase. No field exists that is not recomputable from the file: `note_key`, `title`, `date`, `duration`, `participants`, `meta.projectId` come from the frontmatter, `body_text` from the redacted body, `content_hash`/`mtime` from the file. **`hidden` is not stored**: the Mac does not feed hidden notes, which removes the non-rebuildable `hidden` bit from the index (knowledge-kit 5.1).

**Feed: a Mac-driven reconcile, recommended over a Node file scan.**

| Option | For | Against |
|---|---|---|
| **A. Mac push + manifest reconcile (recommended)** | Reuses the Swift parser that already exists (`MeetingFrontmatter`, `FolderIndexer`, `MeetingIndex`, about 690 lines); no TCC or sync-placeholder risk (the server never touches the user folder); matches how notes are already written | Needs the Mac running to rebuild; the rebuild job is Swift |
| B. Node scans registered roots (knowledge-kit K1 option A) | Rebuild without the Mac UI; precedent `kb/project-roots.mjs` | Needs a Node port of the frontmatter reader (knowledge task 2, 1.5 tasks); reads iCloud/Dropbox folders (Q11 of knowledge-kit) |

Both satisfy "rebuild reads only Mac files". A first (smaller, safer), B only if a headless rebuild is wanted (Phase 7).

**Routes** (4.1): `POST /kb/index/notes` (batch upsert ≤ 100, 4 MB), `POST /kb/index/reconcile`, `DELETE /kb/index/notes/:key`, `GET /kb/index/status`.

**Rebuild job (Mac, `NoteIndexReconciler` in Library):**
1. Enumerate `MeetingIndex` items for the active project (skipping hidden).
2. `POST /kb/index/reconcile {projectId, manifest:[{noteKey, contentHash}], prune:false}` → `{missing[], stale[], extra[]}`.
3. Upsert `missing ∪ stale` in batches; if `extra` and the user ran "Rebuild", `prune:true` deletes them.
4. "Rebuild from scratch" = `DELETE` all rows for `(user, project)` then step 1 to 3; this is also the **proof test** (drop table content, rebuild, compare search results and counts to before: equal ⇒ no unique data).

**Drift detection.** Reconcile with `prune:false` runs at app start (after sweep), every 6 hours while running, and after any Library delete/hide/rename; it only reports (`extra`, `stale`, `missing` counts) into the Storage hub's "sources" group (`/kb/storage`, agent-store plan 3.1) and an Activity entry when drift > 0 persists across two runs. Server-side invariant check (`quick`): `COUNT(search rows kind=meeting) == COUNT(note_index)`, run by `kb/agent-jobs.mjs`'s boot job.

**Latency budgets** (baselines from knowledge-kit section 8, 10 000-row synthetic corpus; real corpora differ; T0.3 re-measures):

| Call | Baseline | Budget |
|---|---|---|
| `search` p95 on 10 k rows | 22.8 to 27.5 ms (knowledge-kit); **T0.3: 30 to 42 ms** on a denser corpus; **50 k rows: 182 to 260 ms** | 50 ms at 10 k (met); **at 50 k the budget is missed by about 4x: state a row ceiling or add a per-project filter before FTS (Q16)** |
| Single note upsert (server side) | T0.3 proxy on `meetings`, 20 KB: insert p50 0.6 / p95 15 ms; update p50 55 / p95 79 ms (full FTS scan, F12) | p95 20 ms (needs the rowid-mapped triggers) |
| Reconcile compare, 5 000 notes | T0.3 proxy (SQL scan + map compare): p95 2.4 to 3.3 ms; manifest 306 KiB | server under 300 ms (met with a wide margin; prune deletes not measured) |
| Full rebuild, 5 000 notes of 20 KB | T0.3 proxy: 7.8 s server-side (batches of 100); Node file scan of 5 000 x 20 KB (95 MiB) 0.32 s warm; Swift `FolderIndexer` cold scan 8.3 s (debug build) and 0.16 s unchanged re-scan | under 60 s (met; the Swift parse dominates, so measure release in T2.1) |
| Note finalize to searchable | today: after `ingestMeeting` POST | under 2 s, off the finalize path, best-effort |
| Mac quit sequence | **needs T4.1** (it cannot be timed without the async quit hook) | whole `.terminateLater` window under 6 s, default reply on cap; note `BackendManager.terminateSpawnedBackend` already blocks the main thread up to 5 s at `willTerminate` |

### 3.9 Redaction (R4) and the index

R4 DEFAULT-ASSUMPTION (a): redact in the live phase only; the archive is raw. That default is fine for chat (replay only happens while rows are in the DB). **It is wrong for the index:** `search_kb` and the planner replay `note_index.body_text` into later model calls, which is exactly why `kb/meetings.mjs:26-30` redacts. So: **redaction is applied when building `body_text`** (`redactSecretsForStorage`, `core/redact-secrets.mjs`), deterministic, so the index stays rebuildable; the Mac files stay raw. This does not contradict the user's R4 default (it is a derived-copy rule, not an archive rule) but it must be stated to the user (Q4).

### 3.10 Module-boundary rules for the Mac

All 16 features are sealed (`CLAUDE.md`); `mac/Scripts/feature-boundaries.sh` fails on any new edge. Seams:

| New thing | Where | Why |
|---|---|---|
| `ChatArchiveService` (actor: quit sequence, sweep, extension archive, tombstone retry) | `Features/Chat/Services/` | Chat owns sessions |
| Async quit hook | `Core/Platform/AppTerminationHooks` gains `registerAsync(label, timeout)`; `AppDelegate.applicationShouldTerminate` runs them under `.terminateLater` | Core leaf; Chat is named only by Shell's registration (`LlmIdeMacApp.swift:199` pattern) |
| `.meetingFinalized` notification | `Core/Platform/NotificationNames` | Live posts, Library and Chat observe; no feature→feature edge |
| `NoteIndexReconciler` | `Features/Library/Services/` | Library owns the notes; conforms to a new `Core/Contracts/NoteIndexFeeding` only if another feature needs to trigger it (not needed now) |
| API methods | `Core/Networking/API/LlmIdeAPIClient+Index.swift`, `+SessionPurge.swift` | Client suffix, stateless |
| `ChatSession.meetingId`, `.origin`, `.ownerUserId`, `.archive` | `Features/Chat/Models/ChatSession.swift`, all optional with `decodeIfPresent`; `storeVersion` stays 2 | Old files decode unchanged; old Macs ignore the new keys (N-1) |
| Meeting-end cleanup of the chat | Chat observes `.meetingFinalized` and deletes sessions tagged with that meeting | Live never names Chat |

Excludable features: `Features/Live` and Library are always compiled; the Mobile and AutoTask paths do not touch this. Run `make build-mac-min` and `build-mac-lite` in each Mac phase.

### 3.11 What stays and what the sign-out does

Chat server working state and live extension rows are per user; the Mac store is per install (F10, Q5). Recommended sign-out sequence (needs the user's yes): archive/purge for the signing-out user (3.2 and 3.3, cap 6 s), then wipe the Mac store **only if the archive of everything succeeded**; otherwise leave the files and show "chats kept". Option "never wipe on sign-out" is the lower-risk default and is the recommendation (the Mac store is now the only copy).

---

## 4. API surface, contracts and versions

### 4.1 Routes

Additive in Phase 1 (`SERVER_API_VERSION` 84). Each gets an `ALL_ENDPOINTS` row, a `kbWrite`/read classification, a schema under `schema/http/`, a decode allowlist entry, a Swift `Routes.swift` row, and a fixture.

| Route | Use | Body / reply |
|---|---|---|
| `GET /kb/agent/working-state` | sweep input | `{sessions:[{chatSessionId, sdkSession, factCount, updatedAt}]}` |
| `POST /agent/v2/sessions/purge` | batch purge of working state | `{chatSessionIds[], verified}` → `{purged:n}`; 400 if `verified !== true` |
| `POST /kb/chat/sessions/:id/archive/begin` | extension archive | 3.3 |
| `POST /kb/chat/sessions/:id/archive/commit` | extension archive | 3.3; 409 `ARCHIVE_STALE` |
| `POST /kb/session-purges` | delete-everywhere tombstone | `{chatSessionId, reason}` |
| `POST /kb/live/:id/ack` | meeting copy ack | `{noteKey, hash, lines}` |
| `GET /kb/live/:id/status` | extension draft release | `{state}` |
| `GET /kb/live/unacked` | Mac adoption at start | `{sessions:[…]}` |
| `POST /kb/index/notes`, `POST /kb/index/reconcile`, `DELETE /kb/index/notes/:key`, `GET /kb/index/status` | index | 3.8 |

Phase 6 (version 85, removals): `POST /kb/ingest` stops writing `meetings` (kept as a compatible route that writes `note_index` for an old Mac, see 5.1); `/kb/meeting/:id` and `/kb/entity/:id` and `/kb/delete` have no live Mac UI caller (knowledge P8, from K0). Removing a route pinned in `REQUIRED_ENDPOINTS` requires editing `App.tsx:57-75` in the same change and checking `MIN_SERVER_API_VERSION` (`App.tsx:84,278-281`).

### 4.2 SSE and events

No new SSE. `emitOsEvent` for `index` drift (optional) rides the existing `/kb/os/stream`; do not add a channel.

### 4.3 Schemas and bridges

New `schema/http/lifecycle.schema.json` (archive, purge, ack, status, working-state) and an `index.schema.json`. Mobile: the bridge allowlist (`SystemBridge.swift`, agent-store plan 1.4) needs a row only if the Storage hub shows index drift.

---

## 5. Migration of existing data

All migrations run **only under the preference/flag, in dry-run first**, and write a report. Kill switch: Mac preference `lta.mode` = `off` (default, first release) | `shadow` | `on`; server env `LLMIDE_NOTE_INDEX_READS=legacy|index` (default `legacy`) and `LLMIDE_LTA_PURGE=0|1` (default `0`).

### 5.1 Old `meetings` / `entities` rows (the duplicates)

Dry-run report first: for each server meeting row, find the Mac file by `id` in frontmatter (and `note_key` path mapping built by the reconcile manifest). Classes:

1. **Matched**: a Mac file exists; compare normalized transcript hashes after applying `redactSecretsForStorage` to the file text (the row is redacted, the file is raw). Match ⇒ eligible to delete.
2. **Unmatched** (row exists, no Mac file; for example a capture whose file was removed): **export first** to `source/meetings/imported/YYYY/MM/<id>.md` (verified read-back), then eligible. Never delete an unmatched row without the export.
3. **Mismatch** (file exists, text differs beyond redaction): keep both, report, ask.

Safety rails before the first delete: `VACUUM INTO kb/backups/data-pre-lta-<ts>.db` (a time-boxed rollback copy, deleted by a job after 30 days; **a deliberate temporary exception to "one copy" that needs the user's yes, Q13**); the delete runs in batches of 100 in one transaction each; `entities` rows follow via `ON DELETE CASCADE` (`0001_initial.sql:21`); FTS rows follow via `trg_meetings_ad`. `outcomes` does not reference `meetings`; `entities` cascades and **`plans.meeting_id` is set to NULL** (`0001_initial.sql:123`, F20, pinned by `lta-legacy-fixtures.test.mjs`); no later migration adds another reference.

N-1: an **old Mac** keeps POSTing `/kb/ingest`. The server keeps accepting it; once `LLMIDE_LTA_PURGE=1` the route writes `note_index` (redacted body, `note_key = 'legacy:' + id`) instead of `meetings`, so an old Mac does not recreate duplicates. A **new Mac against an old server** gets 404 on `/kb/index/*` and keeps its legacy `ingestMeeting` call (the pattern `AgentV2Selection.swift:222-228` already uses, from K0), because `lta.mode` falls back to `off` for that server.

### 5.2 Old `chat_sessions` / `chat_messages` rows (the extension's)

One-time job at the first Mac start with `lta.mode == on`: run the 3.3 protocol for every session found, in any state. Rows are then gone. Old extension builds that still call `/kb/chat/sessions` keep working (live rows start again).

### 5.3 Mac JSON chats and their server working state

Nothing is imported (the files are the store). The first sweep purges working state for every session whose Mac file verifies. Sessions with working state and no Mac file are reported, then purged after the 7-day grace.

### 5.4 Rollback

- `lta.mode = off`: all Mac code paths return to today's (legacy `ingestMeeting`, no quit archive); server routes stay (additive).
- `LLMIDE_NOTE_INDEX_READS=legacy`: reads return to `meetings` as long as the legacy rows exist (they exist until Phase 6).
- After Phase 6 deletes: restore from `data-pre-lta-<ts>.db` (operator script `scripts/lta-restore-meetings.mjs`, idempotent, tested in T6.4) or rebuild from files. The Mac files are never touched by any migration, so the worst case is a rebuild.

---

## 6. Phases and tasks

Gates for every task: `make test` (extension, with `NODE_TEST_CONTEXT`), `make contract-gates` when a route or schema changes, `make test-mac` (memory keychain) when Swift changes, `make chat-gates` for lifted chat logic, `mac/Scripts/feature-boundaries.sh`, `make build-mac-min` and `build-mac-lite` for Mac phases, markdownlint on changed docs. `make regression` before any push (the push is out of scope). Sizes: S about 0.5 day, M about 1 to 2 days, L about 3 days or more. Each phase is independently shippable and leaves the default (`lta.mode=off`) behaviour unchanged unless stated.

### Phase 0: verify and baseline (no behaviour change)

**T0.1 Verify the extension's Mac-side API (S). DONE (table in 3.7).** Confirm every route in 3.7 exists, its auth and CORS behaviour, and what the extension does on `ECONNREFUSED` (`kb.ts`, `useChat.ts`, `App.tsx:261`). Confirm `llmide://` registration and whether Chrome can launch it (Q11). Output: a table appended to this plan's section 3.7, no new file.
**T0.2 Close the "not traced" items (S). DONE (section 11).** The AppShell receiver of `.liveSessionFinalized` and what writes the file for extension captures; `plans`/`outcomes` FKs to `meetings`; where a "meeting-attached chat" would be opened (none exists, F6); whether subscription turns write SDK transcripts outside the data dir (R9); `deleteSdkTranscripts` coverage; `/kb/stats` data source.
**T0.3 Baselines (S). DONE except quit timing, which needs T4.1 (section 11).** Measure the 3.8 budget table on a seeded temp DB (10 k and 50 k notes) and a 5 000-note Mac corpus; quit sequence timing with 30 sessions.
**T0.4 Old-format fixtures (M). DONE (section 11).** Real captured: a Mac `sessions/*.json` (with and without `engine`, `projectId`), a meeting `.md` with and without `platform`, a `data.db` with `meetings`+`entities`+FTS and `chat_sessions`. Needed by every migration test (K1a rule). `ChatSessionV1Fixtures.swift` is a seed (from K0).

Exit: all "confirm T0" items resolved or turned into questions (done: section 11 and Q16 to Q21); baselines recorded in section 11. **Findings that change later phases:** F12 (T1.1 triggers must be rowid-mapped), F13 (T2.1 needs a decision on platform-less notes, Q19), F14 (N-1 rule for the new session keys, T4.2), F18 (T5.1 ack compares with the mirror's count and Mac write failure must be retried), F19/F20 (T3.1 stats re-point, T6.3 plan detach), 50k-row search (Q16).

### Phase 1: server foundations (additive, nothing wired)

**T1.1 Migration `0050` (M).** `note_index` + triggers (3.8), `chat_sessions` columns (3.3), `pending_session_purges` (3.5), `live_acks`. Tests: schema golden, idempotent re-run, trigger parity (insert/update/delete leave `search` consistent), `user-delete-cascade` enumerator updated, FTS rows removed on delete.
**T1.2 Index module and routes (M).** `kb/note-index.mjs` (upsert, reconcile, delete, status; per-user, `userId` first), routes in a new `routes/index-routes.mjs` registered in the always-on group (not `feature-routes.mjs`; the always-on question is knowledge-kit Q10). Redaction at build of `body_text`. Tests: upsert idempotence, reconcile classes, project scoping, secret redaction, cap, per-user isolation.
**T1.3 Lifecycle routes (M).** working-state, batch purge, archive begin/commit, tombstones, live ack/status/unacked; `live-sessions.mjs` keeps finalized-unacked sessions (TTL never deletes them while a crash row exists); tests for each crash row in 3.4 at the server (C5, C6 hash mismatch, fence stale, double commit idempotent).
**T1.4 Contract wiring (S).** `ALL_ENDPOINTS`, classification, schemas, fixtures, Swift `Routes.swift` rows, `SERVER_API_VERSION` 84.

Exit: `make test`, `make contract-gates` green; old Mac and old extension run unchanged against it.

### Phase 2: shadow / dual-run (flag `lta.mode=shadow`)

**T2.1 Mac `NoteIndexReconciler` (M).** Feeds `note_index` after each finalize and on the reconcile schedule (3.8), alongside the legacy `ingestMeeting`. Swift tests: reconcile against an in-process fake client; hidden notes skipped.
**T2.2 Parity compare job (M).** A server job `compareNoteIndexShadow` (same shape as `compareLedgerShadow`, agent-store 0.1): for a query set (titles, random terms, CJK 2-char) run `search` over legacy rows and over `note_index`; metrics `topKOverlap`, `countDelta`; exposed in the Storage hub. Tests with a synthetic corpus.
**T2.3 Rebuild proof test (S).** Drop-and-rebuild equals before (node, with a Swift-fed fixture JSON).
**Exit gate:** on the user's real corpus, 7 days of shadow, `topK(10)` overlap at least 99 % on the query set, `countDelta == 0` for meetings, drift reports clean for 3 consecutive reconciles, search p95 within budget.

### Phase 3: read-path switch

**T3.1 Server reads (M).** `search()` hydrates meeting kinds from `note_index` when `LLMIDE_NOTE_INDEX_READS=index`; `getMeeting`/`listMeetings`/os-state count/planner fallback (3.6 D). Default `legacy`; flip per user via an env flag. Tests: both modes on the same fixture return equal results; planner with body-supplied transcript.
**T3.2 Extension reads (M).** History/search views read the index (`GET /kb/search?kind=meeting`); offline banner; `storage.ts` stops writing `transcripts` (reads of existing local entries remain read-only until Phase 5). Extension tests; manual capture checklist in `extension/CLAUDE.md`.
**T3.3 Token bench guard (S).** `make` bench: `search_kb` result shape unchanged; default-kind behaviour unchanged (kind stays `meeting`, no new default hits for notes).
Exit: shadow metrics still green with reads on `index` for 7 days.

### Phase 4: quit archive, sweep, delete-everywhere, extension-chat archive

**T4.1 Async quit (M).** `AppTerminationHooks.registerAsync`, `.terminateLater` with timeout and the existing drafts dialog preserved. Tests: fake hooks (success, timeout, throw), drafts confirm still first. This is Core/Platform and the highest-risk quit change.
**T4.2 `ChatArchiveService` (L).** Quit purge (3.2), sweep, extension archive client (3.3), idle archive, single-flight actor, `ChatSession` optional fields. Swift tests for **every** row of the crash table (inject a failure at each step with a fake client and a temp store); `chat-contract-lab` assertions for lifted pure logic (hash, state decisions) as `public` types.
**T4.3 Delete everywhere (M).** `deleteSession` writes the tombstone (3.5), local `pending-deletes.json`, start retry, reverse sweep with grace. Tests: server down during delete, restart replays; double delete; delete during archive.
**T4.4 Sign-out and multi-user (M).** 3.11 and C16 (`ownerUserId`, filter). Tests: sign-out with server down keeps files; user B does not see user A's chats.
**T4.5 Phone path (S).** Confirm the Mac engine pool ends turns at quit (C13); no new phone protocol. `make test-shared-protocol` unchanged.
Exit gate: crash-injection suite green; a manual 20-chat quit/relaunch run leaves zero working state and every chat openable; `lta.mode=on` opt-in only.

### Phase 5: meetings (ack protocol), meeting-attached chat, extension storage

**T5.1 Ack protocol, server and Mac (M).** 3.6 B. `LiveSessionMirror`/note writer acks after verify; unacked adoption at start. Tests: C-series for meetings (Mac down, server restart between finalize and mirror, TTL).
**T5.2 Extension draft release (M).** `useLiveSync`/`useTranscript` keep the draft until `acked`; remove the `transcripts` history writer; read-only legacy import of existing local transcripts into the Mac (a one-time "copy to Mac" for the user's 50 saved meetings, then local delete, verified by ack). Extension tests.
**T5.3 Meeting-attached chat (M, blocked on Q3).** `ChatSession.meetingId`, creation point, deletion on `.meetingFinalized` after verify, deferred deletion for unfinished meetings (24 h after the meeting file is finalized), tests.
Exit: no meeting capture path (Mac, extension, extension offline, server restart) loses a transcript in the test matrix.

### Phase 6: delete-path switch (destructive; own gate)

**T6.1 Stop the Mac duplicate (S).** With `lta.mode=on`, `CaptionScraper` does not call `ingestMeeting`; verify-before-`PartialRecovery.cleanup` (3.6 A).
**T6.2 `/kb/ingest` compatibility (S).** Old Mac writes `note_index` (5.1).
**T6.3 Legacy migration job (L).** 5.1 and 5.2 with dry-run, backup, batches, report, `LLMIDE_LTA_PURGE=1`.
**T6.4 Rollback script and drill (M).** `scripts/lta-restore-meetings.mjs`; drill on a copy.
**T6.5 Retire exporters and entities (M, Q7).** `ProjectExporter`'s second `.md`, `LegacyExporter`, `kb/exporter.mjs`, `entities` writer/kinds; `SERVER_API_VERSION` 85; `REQUIRED_ENDPOINTS`/`MIN_SERVER_API_VERSION` edits; docs (`docs/reference/api`, `invariants.md`) updated.
Exit: after one full release with Phase 5, shadow compare still at parity, the dry-run report shows zero mismatch class, the user approves the deletion.

### Phase 7: optional

Node-driven scan (3.8 option B), `lta.mode` default flips to `on`, retirement of the kill-switches after two clean releases.

### Sizing

| Phase | Tasks | Estimate |
|---|---|---|
| 0 | 4 (1 M, 3 S) | 2 to 3 days |
| 1 | 4 (3 M, 1 S) | 4 to 5 days |
| 2 | 3 (2 M, 1 S) | 3 days, plus 7 days of shadow wall-clock |
| 3 | 3 (2 M, 1 S) | 3 days, plus 7 days |
| 4 | 5 (1 L, 3 M, 1 S) | 8 to 10 days |
| 5 | 3 (3 M) | 5 to 6 days |
| 6 | 5 (1 L, 2 M, 2 S) | 6 to 7 days |
| Total | 27 tasks | about 6 to 7 engineer-weeks, plus about 3 weeks of soak time |

Agent token estimate, at the plan's 0.4 to 0.7 M per task: about 11 to 19 M. If the user chooses option A for Mac chat: add Phase A' (6.1 below), about 3 L tasks, 6 to 9 days.

### 6.1 Delta if the user chooses literal option A for Mac chat

`ChatSessionRemote` write-through client (coalesced, off the stream path, returns under 20 ms, never before first token); `ChatEngine+Session` stops writing the file while live; registry flush semantics become "flush rows"; version precondition on writes ("two writers, one set of rows"); the 500 vs 2 000 cap is decided (Q8); the quit step becomes the 3.3 protocol for every chat; phone and Explorer session lists read rows through the Mac until archive. Time to first token must not regress by more than 5 % on the committed bench medians (agent-kit section 8). Not recommended; listed so the trade-off is not hidden.

---

## 7. Risks and what could lose data

| # | Risk or data-loss window | Mitigation |
|---|---|---|
| DL1 | **Extension chat is single-copy in the server DB while live** (C8): DB loss or restore from an old backup loses the live session | Idle archive after 30 min; archive at quit; document it; the extension chat is the lowest-value chat (one rolling session). Shorter idle interval is cheap |
| DL2 | **Finalized extension meeting only in server RAM until the Mac acks** (F3, exists today) | Ack protocol (T5.1); finalized-unacked never TTL-evicted; crash row retained; Mac adoption at start; extension keeps draft until `acked` |
| DL3 | **Meeting-attached chat deleted at meeting end** is irreversible, and "meeting end" can fire by accident | Delete only after the meeting file verified; no deletion if the meeting is unfinished; optional 24 h grace (Q3, deviates from "no archive") |
| DL4 | Quit archive skipped by crash, kill, power loss, OS shutdown time limit | Everything on the quit path is a derivative or already on disk (option B); the extension chat rows are not deleted before verified commit; sweep at next start |
| DL5 | Purge of the SDK transcript removes the ability to resume with cache; **subscription turns** write into the operator's `~/.claude`, which `deleteSdkTranscripts` also scans (F17) | Documented cost (R2b); coverage resolved in T0.2 (F17); legacy `claude -p` turns outside the agent-v2 mapping are not keyed to a chat id and are not purged |
| DL6 | Index drift becomes a second copy of note text | Reconcile + drop-and-rebuild proof test + counts invariant; body is derived and redacted; `hidden` never indexed |
| DL7 | Old duplicate migration deletes the only copy (unmatched rows) | Export-before-delete, dry-run, backup (`VACUUM INTO`), batched, rollback drill (T6.4) |
| DL8 | Sign-out wipe (F10) destroys finished chats | Archive-then-wipe or never wipe (Q5); recommended never wipe |
| DL9 | Multi-user on one Mac store | `ownerUserId` on archive; sweep acts per user; Q6 |
| DL10 | Async quit adds a hang or loses the confirm-drafts dialog | `.terminateLater` with a hard cap and timeout test; drafts dialog first; hooks register through the existing Core seam |
| DL11 | Quit-time purge races the backend child's own kill at `willTerminate` | Reply to terminate only after the sequence; `BackendManager` still sees `willTerminate` afterwards (`:211-222`) |
| DL12 | Message cap mismatch (500 vs 2 000, 64 KB per message) silently truncates the extension archive | Archive carries all messages (Q8); Mac file size warning; `persistedMessageCap` applies to the Mac engine only |
| DL13 | Backup/restore: only Mac folders are durable; `data.db` no longer a recovery source for transcripts | Documented in `docs/how-to` backup page (Phase 6 doc task); sweep and reconcile heal a restored DB |
| DL14 | Extension needs the Mac running for reads | Specified offline behaviour (3.7); no local fallback by decision |
| DL15 | Searching more than before: extension-captured meetings become searchable | Default search behaviour test (T3.3); a pref `lta.indexExtensionMeetings` default on is a Q10 follow-up |
| DL16 | `pending_session_purges` replays a purge for a chat that was re-created with the same id | UUIDs are random; `requested_at` compared with `updated_at` before delete |

Rows the **plan cannot** protect: a user who deletes the project folder or the Mac store has no server copy by design (that is the principle).

---

## 8. Questions the user must answer (each with options and a recommendation)

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | For a **Mac chat**, is the transcript live in the Mac file (option B) or live rows in the DB (option A)? | A literal; B Mac file live, DB holds working state only; D (B plus live rows for the extension chat) | **B + D.** Keeps one copy at every instant, smallest change, no hot-path cost; A adds about 6 to 9 days and a single-copy-in-DB window of days |
| Q2 | Can an ended normal chat be **continued** (R2b)? | (a) replay history into a fresh SDK session; (b) read-only, continue = new chat | (a), the already-existing `fresh`+`history`; (b) if you want the cheaper build |
| Q3 | What is a **meeting-attached chat**, and does a mistaken meeting end need an undo? | New `meetingId` on a normal chat; a new scope `meeting`; no such thing yet. Undo: none (decided) or 24 h grace | `meetingId` field (no enum fan-out); no grace unless you want one, because you decided no archive |
| Q4 | **Redaction** (R4) | (a) live only; (b) also at archive; (c) never | (a) for chat; **redact when building the index** (3.9) because the index is replayed to models. Needs your yes |
| Q5 | **Sign-out** with the Mac store being the only copy | archive-then-wipe; never wipe; per-user folders | never wipe (and show "chats kept") |
| Q6 | **Multi-user** on one Mac | single user assumed; `ownerUserId` filter; per-user folders | `ownerUserId` filter now, folders later |
| Q7 | Retire `entities`, the `action/decision/blocker` kinds, `ProjectExporter`'s second `.md`, `LegacyExporter`, `kb/exporter.mjs`? | retire; keep | retire in Phase 6 (empty or duplicate today, knowledge Q5/Q8) |
| Q8 | **Message cap** for the extension archive | keep all; cap at 500 (Mac) ; cap at 2 000 (server) | keep all, warn above 2 000 |
| Q9 | How is an archived extension chat shown in the Mac? | scope `.quick` with `origin: "extension"`; new `ChatScope.extension` | `.quick` + `origin` (an enum case fans into `ChatScope+Shell` and the mobile lists) |
| Q10 | Are meeting notes searchable by the agent by default, including extension-captured ones? | as today (Mac meetings yes) plus extension meetings; behind a flag; off | keep today's behaviour for Mac meetings; extension meetings on behind `lta.indexExtensionMeetings`, then bench |
| Q11 | Extension "open the app" when the server is down | custom URL scheme `llmide://`; show text only | try the scheme if registered (T0.1), else text |
| Q12 | Index body: full text or title + excerpt? | full redacted text capped at 200 KB; title + 2 KB excerpt | full capped text (search quality); excerpt if you worry about a "copy of the transcript in the DB" |
| Q13 | Allow the **time-boxed** `data-pre-lta` backup (30 days) as a deliberate exception to one copy? | yes; no (rollback = rebuild from files only, no restore of unmatched rows) | yes, 30 days, deleted by a job |
| Q14 | Metadata stays on the server (R7) | confirm; move some | confirm |
| Q15 | Plans (R6) | out of scope; files single copy; server rows stay | out of scope for this plan |
| Q16 | **(T0.3)** Search latency at 50 k notes is 182 to 260 ms against a 50 ms budget (10 k: 30 to 42 ms). Is a ceiling acceptable? | state a supported ceiling (10 k to 20 k notes per user); filter by project before FTS; accept | state the ceiling in docs and add a project pre-filter only if a real corpus is near it (a 5 000-note Mac corpus is far below) |
| Q17 | **(T0.1)** Must the Mac and the extension be signed in as the **same server account**? Archive, index and search are per `user_id`. | same account required (document, detect and show a banner); allow different | required; detect a mismatch (extension `/auth/me` vs the Mac's user) and show it |
| Q18 | **(T0.1/F15)** The extension still keeps a local chat copy (`chatMessages`, 200 msgs) when the server is unreachable. Keep as a crash buffer, or remove to honour "stores nothing"? | keep as buffer until the server accepts it, then delete; remove (chat fails closed offline) | remove with Phase 5 (rule 5), and show the offline banner |
| Q19 | **(T0.2/F13)** Notes without `platform` frontmatter are invisible to Library and to the index. | tolerant decode (default platform) as its own small Mac task before Phase 2; leave and report the count in the Storage hub | tolerant decode first; it is a product change, so it is not done in Phase 0 |
| Q20 | **(T0.2)** A meeting-attached chat has no place to live: `ChatEngineRegistry` holds one displayed engine per `ChatScope` and `ChatPanelRequest` carries no session id, and Library's meeting detail embeds no chat today. | new scope `.meeting` (enum fan-out into `ChatScope+Shell` and mobile lists); `.quick`/`.explorer` session tagged `meetingId`, opened with `switchDisplayedSession` and a `ChatPanelRequest.meetingId` | a `ChatPanelRequest.meetingId` plus a keyed engine in the registry (Q3 stays the field; this decides the seam) |
| Q21 | **(T0.2)** Does macOS give `.terminateLater` enough time at logout/shutdown? Unverified (no Apple docs tool in this session). | measure in T4.1 on logout, restart and Cmd-Q; accept that logout may cut the 6 s cap | measure in T4.1; the sweep is the guarantee either way |
| Q22 | **(T0.1/F16)** Pin the extension origin to one id? CORS allows every `chrome-extension://*`. | pin via `LLMIDE_CORS_ORIGINS` and drop the prefix rule; leave (JWT is the gate) | leave for this plan (separate security task), now that the extension reads all notes |

---

## 9. What I could not verify

Resolved in Phase 0 and removed from this list: the AppShell receiver and file writer (F18), the `plans`/`outcomes` FKs (F20), SDK transcript coverage (F17), the `/kb/stats` source (F19), the `llmide://` registration, and the `AppDelegate`/`AppTerminationHooks` structure (section 11).

Still open after Phase 0:
- Nothing in Phase 0 opened a real `data.db`, Mac store or token bench; the numbers are synthetic and from one machine (section 11). `search` at 10 k rows is denser than the knowledge-kit corpus, so compare only the ratio.
- That Chrome lets the extension open `llmide://` directly from the service worker (Q11), and whether a prompt appears. Needs a browser.
- That macOS gives `.terminateLater` a 6 s window at logout/restart (Q21). Quit timing with 30 sessions needs the async hook (T4.1).
- Whether the Mac and extension are signed in as the same account in practice (Q17).
- That every `.liveSessionFinalized` consumer tolerates a later ack call: only AppShell consumes it (`grep`: one `onReceive`), so this is likely true, but the ack call is new and untested.
- Swift timing was a debug build; a release number is needed in T2.1.
- Line numbers for the extension's `storage.ts` writers are still from K0.

## 10. Notes for the implementer

- Test isolation: `NODE_TEST_CONTEXT` (never write the live `data.db`); Mac tests with `LLMIDE_KEYCHAIN_BACKEND=memory`; pipe `swift test` output to a file; pre-warm before a push (the pre-push hook builds and tests).
- Never add a feature→feature edge or an `#elseif` in an always-compiled layer; use the seams in 3.10.
- Every state-mutating server helper takes `userId` first; the tombstone and `live_acks` tables use `owner_user_id`/no user column on purpose (3.5).
- Order within each phase: server, then Mac, then extension, because old clients must keep working (N-1) and every route is additive until Phase 6.
- Commit on `main`, no branches, Conventional Commits, one concern per commit, do not push.

## 11. Phase 0 evidence (2026-10-29)

**Commits:** bench `5848da7c`, server fixtures `a7982977`, Mac fixtures `f6f3ab98`, plan edits in the commit that adds this section.

**Machine:** Apple M3 Pro, 11 cores, 18 GiB, macOS 26.6.2 (Darwin 25.6.0 arm64), Node 22.23.1, 25 GiB free on the data volume. Synthetic data only, throwaway DB under the temp dir, real data never opened.

**T0.2 resolutions**
- `.liveSessionFinalized`: posted by `LiveSessionMirror` (`:306`), received at `Shell/AppShell.swift:169`, written by `generateNoteForLiveSession` (`:1197-1290`): `MeetingFileStore.createPartial` (platform `chrome-extension`) then `appendCaption` per mirrored caption, `finalize`, `PartialRecovery.cleanup` (unconditional), `indexer.fullScan`, then the summary. No `ingestMeeting`. See F18, F19.
- FKs: only `entities.meeting_id` (CASCADE) and `plans.meeting_id` (SET NULL) reference `meetings` (migrations grep). F20.
- Meeting-attached chat seam: none exists. `ChatScope` (`Core/Contracts/ChatScope.swift:12-18`) has no meeting case, `ChatPanelRequest` (`Core/Contracts/ChatPanelProviding.swift:11-22`) has no id, `ChatEngineRegistry.engine(for:)` (`:133`) returns one displayed engine per scope, and only Review, Explorer, Visual and DocGen embed `ChatPanelView`. A `meetingId` can go on `ChatSession` (decode-tolerant) and `ChatPanelRequest`, opened from `Features/Library/Views/MeetingDetailView.swift`. Q20.
- SDK transcripts: `agent-v2` routes to `deleteSdkTranscripts` (`routes/agent-v2.mjs:751-770`), which scans the per-user home (`config.agentSdkDir/<userId>`, default next to the DB) and the ambient `CLAUDE_CONFIG_DIR`/`~/.claude`, per file by session id. F17.
- `/kb/stats`: `kb.stats` -> `computeStats` (`kb/meetings.mjs:295-318`), counts from `meetings`, `entities`, `sources`, `plans`, `plan_tasks`, `review_items` and outcomes. F19.
- Quit structure confirmed: `applicationShouldTerminate` is a synchronous drafts confirm (`AppDelegate.swift:98-101`); `applicationWillTerminate` runs `IncidentStore.flushPendingSave()` then `AppTerminationHooks.runAll()` (`:171-176`); the only registered hook is Chat's `flushAll` (`LlmIdeMacApp.swift:199`); `BackendManager` observes `willTerminate` and runs `terminateSpawnedBackend()`, which SIGTERMs the child and **blocks the main thread up to 5 s** before SIGKILL (`BackendManager.swift:207-246`).

**T0.3 numbers** (`node extension/scripts/bench-note-index.mjs`; 2 KB transcripts, `meetings` as proxy for the unbuilt `note_index`; 5 queries, 20 runs each, `kind=meeting`, limit 20; times in ms)

| | 10 000 rows | 50 000 rows |
|---|---|---|
| seed (s) / DB size | 2.5 s / 128 MiB | 12.2 s / 634 MiB |
| search "budget review" p50 / p95 | 29.7 / 30.0 | 208 / 260 |
| "rollback" | 29.5 / 32.0 | 179 / 190 |
| "ab" (2 chars, LIKE path) | 34.0 / 34.5 | 177 / 182 |
| "予算" (CJK, 2 chars) | 37.2 / 38.2 | 204 / 213 |
| "設計 見積" | 41.3 / 41.7 | 222 / 232 |
| search without `kind` | 22.2 / 23.4 | 125 / 209 |
| empty query (list newest 100) | 0.1 / 0.3 | 0.1 / 0.2 |
| hydrate `getMeeting` by id | < 0.1 | < 0.1 |
| reconcile compare, 5 000 notes | 1.8 / 3.3 | 1.8 / 2.4 |

Other: 20 KB upsert insert p50 0.6 / p95 15.2; update p50 55.4 / p95 79.1 (at about 60 k rows, F12); rebuild 5 000 x 20 KB in batches of 100: 7.8 s; Node scan of 5 000 files / 95 MiB: 0.32 s warm (corpus write 1.3 s); Swift debug `FolderIndexer.fullScan` of 5 000 x 20 KB: cold 8.3 s, unchanged re-scan 0.16 s (`LTA_BENCH_NOTES=5000 swift test --filter LtaOldFormatFixtureTests`). Quit sequence with 30 sessions: **needs T4.1** (no async hook exists; timing the synchronous flush alone would say nothing about the new path). Search scales roughly linearly with rows (5x rows, 6x latency), so the 50 ms budget holds only up to about 10 k to 12 k notes (Q16).

**T0.4 fixtures**
- `extension/tests/fixtures/lta/build-legacy-db.mjs` (`seedLegacyDb(userId)`): built through the real migrations and helpers (`ingestMeeting`, `savePlan`, `createChatSession`/`appendChatMessage`, agent session mapping, session memory): 3 meetings (English with entities, Japanese, one with a redacted secret), a plan linked to a meeting, an extension chat with 2 messages, a Mac chat id with an `agent_sessions` row and a memory fact. Tests: `extension/tests/lta-legacy-fixtures.test.mjs` (3 pass).
- `mac/Tests/LlmIdeMacTests/Fixtures/lta/`: `session-v2-engine-project.json`, `session-v2-no-engine-no-project.json` (written by `AppJSON.encoder`), `meeting-with-platform.md`, `meeting-without-platform.md` (written by `FrontmatterCoder`, then the `platform` line removed). Tests: `LtaOldFormatFixtureTests` (8 pass), regenerate with `LLMIDE_REGEN_LTA_FIXTURES=1`. They pin: both session shapes decode; unknown keys are dropped on re-save (F14); a note without `platform` fails to decode and `fullScan` skips it (F13).
- A real-DB-derived fixture was deliberately not made (the real data must not be opened); the K1a rule "real captured" is met by encoder-generated files, so a captured sample from the user's machine remains a nice-to-have before T6.3.

