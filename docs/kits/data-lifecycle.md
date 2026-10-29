# Data lifecycle: one copy, live in the server DB, then archived to the Mac app

Status: **decision recorded 2026-10-29, not yet implemented.** No code was changed. This page applies the user's architecture principle to every kind of data named in the two K0 maps, [knowledge-kit](knowledge-kit.md) and [agent-kit](agent-kit.md). Citations are `path:line`, re-read on 2026-10-29 at `main`; where a citation comes from a K0 map and was not re-read, the row says so. Section 6 lists what the principle leaves undecided.

## 1. The decision

The user's words (2026-10-29): "i want best and no duplicate data save but can be accessible from mac app and mobile app. the web is connector but extension is to call mac app, no data access to that." For meetings: "current is good, capture in extension and copy to mac app". For chat transcripts: "i want only in live time in DB and when end save in mac app and delete the DB data".

Read as four rules (the reading is mine; the quoted words are the user's):

1. **One stored copy.** Each kind of data has exactly one durable home. No duplicate across Mac files, the server DB, extension storage or caches. The Mac app and, through the Mac app (as today), the phone can read it.
2. **Live then archive.** While a chat session or a meeting is live, its working data lives in the server DB. When the session **ends**, it is written once into the Mac app's on-disk store (files under the project's `llm-doc/` and `source/`, and the Mac chat store), and the server rows for it are **deleted**.
3. **The web is a connector.** The web and external services (Slack, Box, Email, MCP connectors) are ingest sources only. The Chrome extension captures captions and copies them to the Mac app. It has **no data access of its own**: no store, and no reading back of stored data. The current meeting capture flow stays as is.
4. **Metadata is not a transcript.** Run history, tool events, rollups and usage (`agent.db`, `usage_ledger`) are not transcripts and are outside rule 2. **This is an assumption I made; the user has not said it.** See R7.

## 2. What the K0 maps show about the starting point

Four facts decide how large the change is. Each one is a place where today's code is not what the principle describes.

1. **Mac chat is live on the Mac, not in the server DB.** The Mac writes the transcript to `~/Library/Application Support/llm-ide/sessions/<uuid>.json` (`ChatSessionStore.swift:4-9`) while the chat runs, debounced, last 500 messages (`ChatEngine+Session.swift:79,81`). The server `chat_sessions` / `chat_messages` tables are used only by the extension (`kb/chat-sessions.mjs:1-4`). So "live in the DB, archive to the Mac at the end" is the **reverse** of today for Mac chat. It is a new design, not a cleanup.
2. **Mac meetings are live on the Mac too.** The Mac writes a partial file during capture and finalizes it at the end (`CaptionScraper.swift:311-333`); the server gets one `ingestMeeting` POST **after** that (`CaptionScraper.swift:354`), with `entities: []` (`:304`). The server meeting row is therefore not a live copy but an after-the-fact duplicate, redacted for secrets (`kb/meetings.mjs:26-30`).
3. **The extension does have a store.** `extension/src/lib/storage.ts` keeps saved meetings in `chrome.storage.local` under key `transcripts` (cap 50, `:6-10,47-69`) and a live draft per recording under `transcriptDraft:<id>` (`:11-12,89-104`). It is written by `useTranscript.ts` (`:6-7,215`). **Neither K0 map lists this store.** Rule 3 forbids it as a durable home. The way a finished extension capture reaches the Mac app is also not in the maps (section 7).
4. **The server also derives data from the single copy.** The FTS index (`search`), Pattern A connector rows (`sources`), `plans`, `session_memory` and others are read by the agent and planner in-process. Rule 1 has to say whether a derived, rebuildable index counts as a duplicate (R3).

## 3. Data kinds

Column key. **Live**: where the data sits while the session or item is in progress. **Archive**: the one durable home after the end. **At end**: what the server deletes. **Readers**: who reads it after the end. State: **today** is verified at the citation; **target** is what rules 1 to 3 imply. "Server" means `data.db` unless stated.

### 3a. Session data (rule 2 applies)

| Kind | Live | Archive (single copy) | At end the server deletes | Readers after the end | Today | Target |
|---|---|---|---|---|---|---|
| Meeting transcript, Mac capture | Mac partial file (`MeetingFileStore`, `PartialRecovery`); no server row yet | `<project>/source/meetings/YYYY/MM/*.md` (S1) | Nothing now; target: never write the `meetings` row, or delete it after the file is verified | Mac Library, phone (via `llm-doc` browse only, E10), agent through file tools | File plus a redacted server copy (`kb/meetings.mjs:26-30`, `CaptionScraper.swift:354`) | One copy: the file. The server row goes (Q4 knowledge answered, with consequences in section 5) |
| Meeting transcript, extension capture | `chrome.storage.local` draft and `transcripts` (`storage.ts:6-12,47-104`) | Mac app file (the copy path is not in the maps) | The extension store must not be durable: no `transcripts` history, drafts only as crash buffer | Mac only | Extension keeps up to 50 meetings itself | The extension holds only the in-progress draft and copies to the Mac at stop; no read-back (R1) |
| Meeting notes: summary, actions, decisions, blockers | Generated at stop by `MeetingSummarizationService` (`CaptionScraper.swift:333-345`) | Same note file, frontmatter and headings (knowledge-kit 5.2) | Nothing | Mac, phone, agent through files | Already one copy | Unchanged |
| Entities (action, decision, blocker) | Server `entities` rows, but no shipping client fills them (`CaptionScraper.swift:304`; `kb/meetings.mjs:80` is the only insert) | Would be derived from the note file | Table is empty in practice | `kb.search` kinds, `/kb/conflict-questions` history | Dead data (knowledge-kit P7) | Retire or derive from the Mac note; section 5 item 1 |
| Chat transcript, Mac chat | Today the Mac file (C1). Target: server `chat_messages` rows (a Mac client for them does not exist; `kb/chat-sessions.mjs:1-4`) | Mac chat store `sessions/<uuid>.json` (`ChatSessionStore.swift:4-9`) | `chat_sessions` and `chat_messages` rows for that session | Mac chat UI; phone through `MobileChatHosting` (agent-kit 5.4); agent: not at all unless a Mac-side index exists | Mac file is live and final; server rows unused by the Mac | Live rows in the DB, one archive write at end, delete rows: a new write path in `ChatEngine+Session` and the registry (R2) |
| Chat transcript, extension chat | Server `chat_messages` (`src/lib/unified-chat.ts:24,84,105-121`, surface `extension`, mode `transcript`) | None today: it never reaches the Mac | Would be archived, then deleted | Nobody today | The only consumer of C5; server is its durable home | Goes away (Q8 agent-kit): the extension keeps no chat store; the side-panel chat either calls the Mac app live or is removed (R1) |
| SDK transcript and session id (C2, C3) | SDK jsonl under `<dataDir>/agent-sdk/<userId>` or the operator's `~/.claude` (`transcripts.mjs:26-39`); mapping row in `agent_sessions` (`kb/agent-sessions.mjs:40,102`) | None. It is a model-private copy, not a user-visible archive | The existing delete path (`routes/agent-v2.mjs:751-770`) removes the mapping, the jsonl and the facts | Nobody (the SDK, to resume) | Lives until the user deletes the chat or signs out | Delete at end (rule 2). Resume after end then needs a fresh SDK session replaying history from the archive (`fresh` plus `history`, `AgentV2Transport.swift:276-282`). R2 |
| `session_memory` facts (C4) | Server `session_memory`, keyed by the Mac chat UUID with no FK (`kb/session-memory.mjs:3-6`) | None: derived working memory | Rows for the session (same delete route) | The model, only for a session without a transcript (`invariants.md:467`, per agent-kit 4) | Deleted with the chat | Delete at end; they are a duplicate by definition, so no archive |
| Phone session cache (C7) | iPhone `ExplorerChatStore` | None | n/a (not the server) | The phone | Cache of the Mac store | A cache the phone owns is a duplicate under rule 1; R5 |
| Ask-the-Agent history (C6) | `agent_ask_messages` | None | n/a | No live client (agent-kit 5.1) | Dead | Remove (agent-kit Q7) |

### 3b. Archive and index data (the Mac store, rule 1)

| Kind | Live | Archive (single copy) | Readers | Today | Target |
|---|---|---|---|---|---|
| Generated notes, plans written by Chat or Loop | Written once by Mac writers | `<project>/llm-doc/<type>/YYYY/MM/*.md` (S2; E9) | Mac, phone (`LlmDocBrowser`, E10) | One copy | Unchanged; this is the model for the archive |
| Raw email, Slack, MCP-backed items | Fetched by the server, returned to the Mac (Pattern B) | `source/emails/...` raw plus a note (S1, S2) | Mac, phone | One copy in files; server keeps only a seen-set | Unchanged; the seen-set is dedupe state, not content (R3) |
| Note index and hidden flag | Rebuilt from files | `system/index.sqlite` (S3); `hidden` tombstone is not rebuildable (knowledge-kit 5.1) | Mac | Derived, plus one non-derivable bit | Derived index is allowed if rebuildable (R3); the tombstone is real data and needs a home |
| Server-side note index (knowledge K1 option A) | n/a | Derived tables under a non-default kind | Agent, planner, phone | Not built | Only a derived, rebuildable index; never a second copy of note text (R3) |

### 3c. Connector, policy and metadata data (outside rule 2)

| Kind | Home today | Rule 1 verdict | Readers | Notes |
|---|---|---|---|---|
| Box documents, code, tickets, QA (Pattern A rows in `sources`) | Server `sources` and FTS, wholesale re-index per run (knowledge-kit 5.5) | The external service is the original; the server rows are a derived index. Allowed only if R3 says derived indexes are not duplicates | Agent `search_kb`, planner, extension search box | Not session data; no archive step |
| Connector config | Mac UserDefaults; secrets in server vault (knowledge-kit 5.2) | Single copy each | Mac | Unchanged |
| Seen-set and high-water per source | Server (`email_*`, `slack_*`, `mcp_connector_seen`) | Dedupe state, not content | Server | Unchanged; must survive session deletes |
| Personas | One JSON blob in `user_flags['agent.persona']` (`kb/personas.mjs:9`) | Configuration, single copy | Server, extension persona UI | Assumed to stay on the server (R7) |
| Tool permission rules and approvals | `tool_permission_rules`, `tool_approvals` (agent-kit 2a, migrations `0030`, `0034`) | Policy, single copy | Engine | Not a transcript; stay |
| Usage and budget | `usage_ledger` (authority), `usage_calls` (shadow, `agent-usage.mjs:1-8`) | Two copies by design while the shadow runs; the shadow ends at Stage 2b | Engine, Settings | Outside rule 2; assumption R7 |
| Agent history: runs, tool events, turn composition, activity, rollups | `agent.db` (`0001_agent_store.sql:7-8`: metadata only, "no prompt, response, tool argument or error message") | Metadata, single copy | Settings storage card, os-kit | Outside rule 2; assumption R7 |
| Plans (planner output) | Server `plans` (`kb/plans.mjs:68`), created and saved by `/kb/plan/save` (`routes/planning.mjs:131`); plan files also written under `llm-doc/` by Chat and Loop | Possibly two copies; not examined in the maps beyond E9 | Planner, Gantt, Mac | Not covered by either K0 map in depth; R6 |
| Graph and project-memory artifacts | `project_memory_ledger` in the DB; `chat-memory.md` and graph files in the project (agent-kit 3b) | Owned by [graph-kit](graph-kit.md); not re-verified here | Agent, Explorer | Out of scope of this page; flagged |
| Templates (Doc Gen) | Mac `DocTemplateStore` | Owned by docs-kit; not re-verified here | Doc Gen | Out of scope; flagged |

## 4. The lifecycle in one picture

```text
LIVE (server DB)                          END                       ARCHIVE (Mac app)
chat_sessions/chat_messages  ──────────►  1. write archive  ─────►  sessions/<uuid>.json   (Mac chat store)
meeting working rows         ──────────►  2. verify it reads  ───►  source/meetings/..*.md  llm-doc/..*.md
agent_sessions, SDK jsonl,                3. delete server rows
session_memory               ──────────►     (and SDK files)
                                          crash between 1 and 3:
                                          recover at next start, no data lost
```

The archive step must be **write, verify by reading it back, then delete**, and must be idempotent by session id so a crash between write and delete is repaired at next start by finding a session that is both archived and still live. This is the ordering the existing delete code already uses in the other direction (Mac removes its file, then drops the server mapping, best-effort; `ChatEngine+Session.swift:707-745`).

## 5. What breaks (consequences of the principle)

Each item is by reading the code; nothing was run.

1. **Server search kinds and conflict history.** `/kb/conflict-questions` builds its history from `kb.search` of kinds `decision`, `blocker`, `action` (`routes/router.mjs:1428-1432`). Those come from `entities`, which no shipping client fills (`CaptionScraper.swift:304`). So the history block is already empty; deleting server meeting rows changes nothing there. If entities are ever filled, they would be session data to delete. The extension's `conflictQuestions` (`kb.ts:114`) and `searchKB` (`kb.ts:89`, kinds `meeting|action|decision|blocker`) read stored data and are rule-3 violations (R1).
2. **Agent `search_kb` and planner for ended sessions.** `search-kb.mjs:27` calls `ctx.kb.search` over the server FTS; the planner imports `getMeeting` and `getMeetingTranscript` from the DB (`agents/planner.mjs:8-9`) and graphkit and code-sync call the same (knowledge-kit E14). After the delete, no ended meeting or chat is visible to them. They need a Mac-side index to read, or a derived server index (R3). Without either, the planner stops grounding in past meetings.
3. **Mobile access path.** The phone reads chat through the Mac (`MobileChatHosting`; session list pushed when `sessions/` changes, `MobileControlManager.swift:1630-1637`) and notes through `llm-doc` browsing. That path survives, because the archive is the Mac store. It does not give the phone live-session visibility if the live rows are in the server DB and the Mac app is the only reader (R5).
4. **SDK session resume after end.** The SDK transcript is deleted with the chat (`routes/agent-v2.mjs:751-770`). Reopening an ended chat for a new turn needs `fresh` plus the history from the archive, which exists (`AgentV2Transport.swift:276-282`) but costs the prompt cache and compaction state, and re-runs session-memory extraction. R2.
5. **Library delete propagation (knowledge Q3) becomes moot** for meetings: with no server copy, removing a note cannot leave a stale searchable copy. The `hidden` tombstone (`LibraryView.swift:1827-1835`) stays a Mac-only flag. It remains relevant for any derived index (R3).
6. **Redaction (Q2 agent-kit).** Redaction exists today because a second copy would replay secrets into later model calls (`kb/meetings.mjs:26-30`; `kb/chat-sessions.mjs:166-170`). With one archived copy on the Mac, the Mac file is raw today (`SecretRedactor` is not used by `Features/Chat/Session`, agent-kit 5.3 item 4). Redaction at archive time would change what the user sees on reload. Redaction during the live phase, when the data is in the DB and is replayed to the model, still has its original reason. The user must choose (R4); I do not.
7. **Extension store and chat.** `storage.ts` (`transcripts`, drafts), `unified-chat.ts`, `useChat.ts:145` (`/chat`), `useChat`'s persistence, `useQuestions.ts:88`, `Settings.tsx` search box and `kb.ts` read functions are all "data access" in the user's sense. `App.tsx:57-75` pins `/chat`, `/kb/search` and `/kb/chat/sessions` in `REQUIRED_ENDPOINTS`; removing the routes means editing that list and bumping `MIN_SERVER_API_VERSION` (`App.tsx:84`, per agent-kit 2c).
8. **Sign-out.** `ChatEngineRegistry.resetForSignOut` wipes the Mac chat store (`:459-462`) but not server state (agent-kit 5.3 item 2). Under the principle, sign-out mid-session leaves live server rows, and sign-out after the end deletes the only copy. Section 6, risk list.

## 6. Consequences and risks

- **Crash between archive and delete.** Recoverable if the order is write, verify, delete, with a startup sweep for sessions present in both places. A crash before the archive write is the dangerous one (next).
- **A session that never ends.** A crashed app, a closed laptop or an abandoned chat never triggers the end event, so the rows stay in the server DB indefinitely and nothing is archived. This needs an end rule (idle timeout, app quit, next start). Until then the server DB is the only copy of that session, which breaks rule 1.
- **Server DB loss during a live session.** The live copy is the only copy; today the Mac file is. Backup and restore of `data.db` therefore matter for live sessions in a way they do not now.
- **Sign-out mid-session.** Live rows stay on the server tied to a user, and the Mac has nothing to archive to. Decide whether sign-out ends the session (archive first) or discards it.
- **Multi-user.** The Mac store is one directory, not per user (agent-kit 5.3 item 3), while server rows are per user. A session archived by user A and read after user B signs in, and "one KB user per Mac user" (knowledge Q14), both need an owner on the archived file.
- **Offline and phone mid-session.** The phone reaches live sessions only through the Mac app; if the Mac app is off, a live session has no reader and no archive trigger. If the phone runs the turn through the Mac's engine pool (`ExplorerMobileEngineResolver`), the same end rule must cover it.
- **Backup and restore.** One copy means the Mac store and the project folder are the only backup target for finished work. The server DB is no longer a recovery source for transcripts.
- **Search over ended sessions.** See section 5 items 1 and 2.
- **Message cap.** Today the Mac keeps 500 messages (`ChatEngine+Session.swift:79`); the server keeps 2 000 with 64 KB per message (agent-kit 5.3 item 5). An archive that copies from the DB must pick one cap or truncate silently.
- **One live engine per session.** The registry rule ("two writers, one file", agent-kit 5.5) becomes "two writers, one set of rows" while live. It needs a version precondition on writes.

## 7. Residual questions the user must still answer

Only questions that change the design. I have not decided any. Each has a recommendation to react to.

| # | Question | Options | Recommendation |
|---|---|---|---|
| R1 | What does the extension do about meeting storage, chat and read views (`storage.ts`, `unified-chat.ts`, `kb.ts` search, conflict questions, stats, issues)? | (a) Keep only the in-progress draft; copy to the Mac at stop; remove the chat store and read views. (b) Same, but the side-panel chat and read views call the Mac app live and keep no copy. (c) Keep read views against the server for now | (b) if the Mac app has a reachable local API, otherwise (a). The Mac-to-extension call path is not in the K0 maps and must be found first |
| R2 | After a chat ends, can it be continued? | (a) Yes: reopen replays archived history into a fresh SDK session. (b) No: an ended chat is read-only, continuing starts a new chat. (c) Never delete the SDK transcript | (a). It matches today's `fresh` plus `history`; (b) is a product change; (c) breaks rule 1 |
| R3 | Is a derived, rebuildable index (FTS, Pattern A `sources`, a server index over Mac notes) a "duplicate"? | (a) No, an index is allowed if rebuildable. (b) Yes, so agent search reads the Mac only | (a). Without it `search_kb`, planner grounding and the phone have nothing to query after the delete. Needs your explicit yes |
| R4 | Redaction: when is it applied? | (a) During the live phase only (protects model replay), archive raw. (b) Also at archive. (c) Never | (a), because the replay risk exists only while the data is in the DB and sent back to a model. This is a change from Q2 of both K0 docs |
| R5 | Who can see a live session while the Mac app is closed or the phone is the only client? | (a) Nobody; a live session needs the Mac running. (b) Phone reads live rows through the Mac only. (c) Server API for the phone | (a) or (b); (c) contradicts "through the Mac app, as today" |
| R6 | Plans: `plans` rows (`kb/plans.mjs:68`) versus the plan files under `llm-doc/` | (a) Files are the single copy; server rows are working state deleted at end. (b) Server rows stay (planner state). (c) Out of scope | (c) for now, then decide with work-kit; the maps do not cover plans deeply enough to recommend |
| R7 | Confirm the metadata assumption: `agent.db`, `usage_ledger`, personas, tool permissions, connector seen-sets stay on the server | (a) Confirm. (b) Move some to the Mac | (a) |
| R8 | What ends a session that never ends? | (a) Idle timeout (for example 30 minutes). (b) App quit and next start. (c) Explicit user action only | (a) plus (b); (c) leaves live rows for ever |

## 8. What I could not verify

- **The extension-to-Mac copy path for meetings.** I found no code in `extension/src` that sends a finished capture to the Mac app (the maps say the extension never calls `/kb/ingest`, knowledge-kit 2c). "Current is good" is taken from the user; I could not locate the mechanism, so the row in 3a for extension capture is partly assumed.
- **That the Mac app has a local API the extension could call** (R1b). Not examined.
- **Real data.** Neither the live `data.db` nor any Mac store was opened.
- **graph-kit, docs-kit rows** (graph and memory artifacts, templates) are flagged, not analysed.
