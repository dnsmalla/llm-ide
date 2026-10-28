# knowledge-kit

Status: **K0 Map**, written 2026-10-28. No code was changed. Citations are `path:line`, read on 2026-10-28 at `main` (`84b35166`). Counts say how they were taken (grep or run). Section 11 lists what could not be verified; section 10 lists where the migration plan's premises do not match the code.

## 1. Purpose

knowledge-kit is what the product *knows*: the **Library** (meeting transcripts, ingested mail, Slack and MCP-backed items, generated LLM docs, code and data files), the server **knowledge base** (SQLite + FTS5 over meetings, entities and non-meeting `sources`), the **connectors** that bring outside content in, and the **search** over it. It is the hub that capture, chat, planning, docs and automation all read.

The plan row (`docs/superpowers/plans/2026-10-27-kit-by-kit-migration.md`, kit 4) names: `kb/` sources, exporter, project-export, install-project-skills, search; `connectors/`; `agents/` slack, email-classify, connector-classify, code-sync; `Features/Library`, `Features/ReviewConflicts`; extension KB views. Key `always`, contract group `kb-sources`, depends on core and agent-kit (summaries via `providers/`). The plan calls K1 a **dual-store unification**, not a folder move. This map confirms that, and finds that it is more than two stores (section 5).

## 2. Code on every side

### 2a. Server (Node, `extension/`)

| Piece | Path | Lines | Notes |
|---|---|---|---|
| Source ingest (kinds `code`, `ticket`, `qa`, `doc`) | `kb/sources.mjs` | 196 | `ALLOWED_SOURCE_KINDS` `:12`; `MAX_INGEST_BATCH = 5000` `:23`; `ingestSources` `:25` (per-user delete then insert in one tx, dedupes the batch `:48-55`); `deleteSourcesByPrefix` `:97`; `sourceContentHashes` `:116`; `pruneMissingCodeRepos` `:168` |
| Unified search + retrieval | `kb/db.mjs` (1059 lines in all) | about 250 | `buildSearchFilter` `:137` (CJK runs, trigram needs 3+ chars, shorter terms become LIKE); `searchFilterSql` `:158`; `search` `:214` (cap 100, tenant hydration, overshoot re-fetch); `findContext` `:658` (OR semantics, used by planner and graphkit); re-exports `:176`, `:525`, `:647` |
| Meetings and entities | `kb/meetings.mjs` | 333 | `ingestMeeting` `:29` redacts secrets before storage (`:26-30`) and replaces the meeting's entities wholesale. Plan row 8 (capture-kit) also lists `kb/meetings`; shared ownership (section 10, D12) |
| Legacy NDJSON exporter | `kb/exporter.mjs` | 66 | `iterateUserMeetings` `:36`; constant `platform: 'meet'`, `notes: ''` (`:18-19`) |
| Project export | `kb/project-export.mjs` | 172 | `exportProject` `:29`: meetings by `meta.projectId`, entities, plans, tasks in at most 4 queries |
| Skills install | `kb/install-project-skills.mjs` | 193 | `installProjectSkills` `:136`; refuses folders without `system/project.json` (`assertInstallableProjectPath` `:78`) |
| Route handlers | `routes/router.mjs` | n/a (one file for all) | `/kb/ingest` `:137`, `/kb/delete` `:263`, `/kb/search` `:274`, `/kb/issues` `:306`, `/kb/meeting/:id` `:349`, `/kb/entity/:id` `:372`, project export `:390`, install-skills `:413`, `/kb/connect-git` `:477`, `/kb/ingest-scip` `:504`, GitHub issues `:531`, tickets JSON `:550`, email test/fetch `:570`, email seen `:691`, Slack `:708`, Box `:801`, MCP connector `:857`, email classify `:1148`, `/kb/export-all` `:1194`, `/kb/connect-qa` `:1398`, `/kb/conflict-questions` `:1417` |
| Connectors, knowledge-owned | `connectors/` box 275, email-source 387, slack-source 312, slack-oauth 70, google-oauth 91, mcp-client 544, mcp-connector-defs 283, connector-catalog 53, connector-state 106 | 2 121 | Box is the Pattern A reference (`box.mjs:1`). `mcp-client.mjs` wraps the MCP SDK client (`:48-50`) with a vault-backed OAuth provider |
| Connectors, corpus feeders | `connectors/git.mjs` 234, `issues.mjs` 134, `qa.mjs` 130 | 498 | Write `code`/`ticket`/`qa` rows that the planner and Issues read. Not knowledge UX; shared with work-kit |
| Connectors, graph | `connectors/scip.mjs` 67, `scip-scanner.mjs` 174, `structure-graph.mjs` 129 | 370 | Code-graph ingest; graph-kit's (`structure-graph.mjs:8-13`), but `/kb/ingest-scip` sits in the kb-sources schema |
| Classifiers | `agents/email-classify.mjs` 103, `agents/connector-classify.mjs` 102 | 205 | One `runClaude` call each (`providers/runtime.mjs`), JSON out, one stricter retry. Delegated work behind a fixed contract |
| Not knowledge | `agents/slack.mjs` 182, `agents/code-sync.mjs` 24 | 206 | `slack.mjs` is the outbound **webhook notifier** (`:1-5`), served by `/kb/notify/slack` (planning group). `code-sync.mjs` is a deterministic graphkit lookup (`:1-9`) called from `routes/planning.mjs:17`. Neither ingests anything (section 10, P2, P3) |
| Migrations | `kb/migrations/` (49 files) | n/a | `0001` meetings, entities, FTS `search`, `sources`; `0005` `doc` kind; `0013`, `0017`, `0031` `email_*`, `slack_*`, `mcp_connector_seen` state; `0022` per-user unique on `sources`; `0033` trigram FTS rebuild; `0037` `search_source_rowid` (delete by rowid, no full scan) |
| Registration | `server.mjs` | n/a | `SERVER_API_VERSION = 83` `:284`; `ALL_ENDPOINTS` `/kb/ingest` `:308` to `/kb/connect-qa` area `:299-345`; `/kb/ingest` in the `kbWrite` bucket `:481` |
| Connector selection and OAuth | `server/auth-routes.mjs` | n/a | `/auth/me/connectors*` `:246-249`, `/auth/google/*`, `/auth/slack/*`, `/auth/mcp-connector/*` `:250-258`: **health-auth group, not kb-sources** |

**Model calls.** Only the two classifiers and `/kb/conflict-questions` (`router.mjs:1417`, one prompt over the last 10 decisions, blockers and actions plus the transcript and an optional file) call a model. Search, ingest, export and connectors make no model call.

**FTS shape.** One shared FTS5 table `search(meeting_id, entity_id, kind, title, body)` with the trigram tokenizer (`0033`). It indexes meetings, entities, `sources` (code, ticket, qa, doc), plans, tasks and outcomes. It does **not** index anything under the Mac's project folder.

### 2b. Mac app (Swift, `mac/Sources/LlmIdeMac/`)

| Layer | Piece | Path | Lines |
|---|---|---|---|
| Features | Library, 64 files (Models 9, Services 24, Views 31) | `Features/Library/` | 12 108 |
| Features | of which plugin, MCP and LLM-source UI (28 files by name: `Plugin*`, `Mcp*`, `LlmSource*`, `ClaudePluginImport`, `CodexPluginImport`) | `Features/Library/` | 5 457 (45%), agent-kit territory (D6) |
| Features | Knowledge UI and logic left after that: `LibraryView` 1 843, `MeetingDetailView` 305, `EmailSourceSheet` 488, `SlackSourceSheet` 390, `BoxSourceSheet` 215, `ConnectionsSettingsSection` 533, source services (`SourceConnector` 222, `SourceConnectorManifest` 192, `EmailSource` 156, `SlackSource` 140, `EmailNoteWriter` 159, `InboxStore` 86, `SourceIngestService` 122, `SourceRegistry` 80, `LegacyExporter` 75) | `Features/Library/` | about 6 650 |
| Features | ReviewConflicts: one file | `Features/ReviewConflicts/Views/ReviewView.swift` | 284 |
| Resources | Declarative connector manifests | `Resources/source_connectors/{miro,gcal,gdrive}.json` | 3 files |
| Core | Notes backing code, 21 files | `Core/Notes/` | 3 557 |
| Core | Stores and indexes | `LibraryItemStore` 740, `MeetingIndex` 306, `FolderIndexer` 178, `NoteService` 512, `NotesFolderConfig` 105 | 1 841 |
| Core | Capture-side writers | `MeetingFileStore` 332, `MeetingNoteWriter` 105, `PartialRecovery` 74, `IngestNoteDedup` 55, `IngestTemplateRenderer` 284, `IngestTemplateSeeder` 41, `MeetingSummarizationService` 113 | 1 004 |
| Core | Formats and migrations | `MeetingFrontmatter` 101, `MarkdownFrontmatter` 63, `FrontmatterCoder` 44, `NotesToLlmDocMigration` 47, `SourceFolderMigration` 93, `SourceNestedLlmDocMigration` 170 | 518 |
| Core | Seams (all in `Core/Contracts/`) | `NoteSourceClassifying` 31 (`:15`), `SourceIngesting` 39 (`:33`), `ProjectNotesProviding` 39 (`:35`), `LibrarySourceFeed` 29 (`:10`), `LibrarySelection`, `LiveCaptureProviding` | 138 + 2 |
| Core | Mac half of server modules | `Core/Project/ProjectExporter.swift` 552 (`:79` fetch, `:118` write), `ProjectExportBundle` 61, `ProjectSkillsInstaller` 43 | 656 |
| Core | HTTP | `Core/Networking/API/LlmIdeAPIClient+KB.swift` (`ingestMeeting` `:75`, `search` `:91`, `getMeeting` `:109`, `exportProject` `:119`, `installProjectSkills` `:142`), `+Email`, `+Slack`, `+Box`, `LegacyExportRecord` | n/a |
| Core | Folder layout | `Core/Project/ProjectLayout.swift`: `source/`, `code/`, `data/`, `llm-doc/` (`userFolders` `:101`), `system/index.sqlite` (`indexDB` `:89`) | 107 |
| Core | Config | `Core/Platform/Config.swift`: `SavedEmailSource` `:66`, `SavedSlackSource` `:126`, `SavedBoxSource` `:157` | n/a |
| Shell | Wiring | `AppShell.swift:19` (`LibraryItemStore(sourceClassifier: SourceRegistryClassifier())`), `:397` (`librarySourceFeed`), `:1002` (`LegacyExporter`); `FeatureCatalog.swift:335` (`installLiveSeams`), `:618` (`setAutoCodeProjectNotes`) | n/a |

`mac/Package.swift:421` links `sqlite3` for `MeetingIndex` (`MeetingIndex.swift:2`).

### 2c. Extension (Chrome)

| Piece | Path | Lines |
|---|---|---|
| KB client | `extension/src/lib/kb.ts` (`connectGitRepo` `:58`, `connectQA` `:70`, `searchKB` `:89`, `conflictQuestions` `:114`, `getKBStats` `:128`, `listIssues` `:139`) | 168 |
| Connectors card | `src/sidepanel/components/ConnectorsSettings.tsx` | 239 |
| KB search box | `src/sidepanel/components/Settings.tsx` (imports `:7`, search `:160`) | 264 |
| Conflict questions | `src/sidepanel/hooks/useQuestions.ts:88` | 160 |
| Issues in chat | `src/sidepanel/hooks/useChat.ts:133` | n/a |
| Endpoint list | `src/sidepanel/App.tsx:63-72` lists `/kb/ingest`, `/kb/search`, `/kb/connect-git` in `REQUIRED_ENDPOINTS` | n/a |

The extension does **not** call `/kb/ingest`: the only match in `extension/src` outside `api-types.ts` is the endpoint list (`App.tsx:63`) and a comment (`:143`). No Mac or extension client calls `/kb/delete` (INVENTORY: "tests only").

### 2d. Contract and fixtures

| Piece | Path | Count |
|---|---|---|
| Group spec | `schema/http/kb-sources.schema.json` (1 844 lines) | 34 endpoint rows (python count of `endpoints`) |
| Fixtures | `schema/http/fixtures/kb-sources/` | 96 files |
| Connector rows in another group | `schema/http/health-auth.schema.json`: `/auth/google/{start,status,callback}`, `/auth/slack/{start,status,callback}`, `/auth/mcp-connector/callback`, `/auth/me/connectors{,/catalog,/add,/:id}` | 11 of 65 rows |
| Conflict route in another group | `schema/http/planning.schema.json:1578` `POST /kb/conflict-questions` | 1 of 25 rows, 4 fixtures |
| Inventory | `schema/http/INVENTORY.md`: `/kb/search` Mac caller is only `LlmIdeAPIClient+KB.swift`; `/kb/conflict-questions` has no Mac caller (`mac/Sources/APIContractLab/Routes.swift:192`) | n/a |
| Live contract | `extension/tests/http-contract-live.test.mjs` | 402 lines |
| Phone wire | `ios_app/SharedProtocol/.../MobileProtocol.swift:137-140` (`llmdoc_list`, `llmdoc_listing`, `llmdoc_read`, `llmdoc_file`); Mac side `Features/MobileControl/Services/LlmDocBrowser.swift` (86; read-only, containment checked, `:10`) | 4 wire types |

### 2e. Feature key

None. Library and ReviewConflicts are in the always-compiled set (`mac/Scripts/feature-map.txt`: both `sealed`); `grep` of `mac/Package.swift` for `Library`/`ReviewConflicts` finds no exclude, only `linkedLibrary("sqlite3")` `:421`. `AppFeature.swift:4-11` has 8 keys and none is a knowledge key. The server has no `feature-routes.mjs` group for the kb-sources routes (INVENTORY: feature `core`). `build-mac-min` therefore still contains the whole of Library.

### 2f. Tests and gates

| Side | Files | Count (method) |
|---|---|---|
| Server | 45 test files named for the kit's modules (`box-*`, `connector-*`, `email-*`, `slack-*`, `mcp-connector-*`, `scip-*`, `git-connector-*`, `kb-router*`, `kb-search-*`, `kb-prune-*`, `kb-meeting-transcript`, `kb-stats-cache-bound`, `sources-ingest-dedupe`, `structure-graph-ingest`, `exporter`, `install-project-skills`, `code-sync-expand`, `agent-search-kb`, `slack*`) | **261 tests, 5 406 lines** (grep for test and it call sites); **run: 261 pass, 0 fail, 9.4 s** (`node --test`, unsandboxed; in the sandbox 14 fail on listen EPERM and 3 git tests fail) |
| Server gap | `kb/project-export.mjs`, `kb/meetings.mjs` `ingestMeeting` and the `/kb/conflict-questions` prompt have no test named for them. Project export is covered only by contract fixtures and Mac tests (`ProjectExporter*Tests`) | grep of `extension/tests` for `exportProject` finds none |
| Mac | 30 files by type name (`LibraryItemStore*`, `MeetingFileStore*`, `MeetingIndexHidden`, `NoteService*`, `NoteType`, `NoteWriterDedup`, `NotesToLlmDoc*`, `SourceConnector*`, `SourceFolderMigration`, `SourceRegistryMcp`, `McpConnectorAdapter`, `InboxStorePipeline`, `IngestTemplateRenderer`, `LibraryHardening`, `LibraryRemoval`, `ProjectExporter*`, `TextFileWriter`, `PartialRecovery`, `EmailSourceRawDir`, `SourceLinkStore`, `MeetingSummarizationFallback`) | **133 tests, 2 646 lines** (grep for `func test` and `@Test`; **not run**, see section 11). A looser grep adds `LegacyMeetingCountTests`, `MeetingCaptureMatrixTests`, `LibraryRefreshTokenTests` |
| Mac gap | Test files | No test file names `ReviewView`, `ReviewConfig`, `SourceIngestService`, `LibrarySourceIngester` or `ProjectNotesProviding` (grep). `FolderIndexer` is named in 1 file, `MeetingFrontmatter` in 1 |
| Gates | Boundary script and eslint | `bash mac/Scripts/feature-boundaries.sh` (run 2026-10-28): all sections `none`, zero violations. `npx eslint connectors agents kb/{sources,project-export,exporter,install-project-skills,meetings}.mjs --max-warnings 0`: clean |

## 3. Cross-kit edges

Legend: **C** = through `Core/Contracts` or an HTTP route; **D** = direct reference to a type that lives in Core (allowed, and invisible to the boundary gate by design, see `CLAUDE.md` "known limitation"); **S** = server in-process import (allowed by the ESLint layering).

| # | Reader or writer | Reads or writes | Mechanism | Evidence |
|---|---|---|---|---|
| E1 | Live (capture) | writes meeting `.md` files; posts the transcript | D `MeetingFileStore`, `MeetingSummarizationService`; C `POST /kb/ingest` | `CaptionScraper.swift:205,311,333,354` |
| E2 | Library meeting detail | wraps in Live's recording view | C `LiveCaptureRegistry` | `FeatureCatalog.swift:335` |
| E3 | Chat | reads Library items for the file picker | D `LibraryItemStore` env, `LibraryPicker` (Core) | `CodeAssistantPanel.swift:44` |
| E4 | CodeGraph, SourceControl | read `LibraryItemStore` | D | `UAGraphView.swift:105`; `GitLabSettingsSection.swift:10`; `GitHubSettingsSection.swift:16` |
| E5 | AutoTask | project notes; source ingestion; **opens its own `MeetingIndex` on `system/index.sqlite`** | C `ProjectNotesProviding` (`AutoCodeUpdateService.swift:133`), C `SourceIngesting` (`:93,177`); D `MeetingIndex(url:)` | `AutoCodeUpdateService+PipelineTasks.swift:256-258` |
| E6 | Loop | writes run summaries as notes | D `NoteService` | `LoopRunSummaryWriter.swift:45` |
| E7 | Doc Gen | source tree lists Library items | C `LibrarySourceFeed` | `AppShell.swift:397`; `LibrarySourceFeed.swift:10` |
| E8 | Doc Gen | `getMeeting(id:)` for a `.meeting` source | C HTTP, but **no code creates a `.meeting` source** | defined `DocTemplate.swift:278`, only consumer `GenerationViewModel.swift:212` |
| E9 | Chat, Loop, Doc Gen | write plans and generated docs under `llm-doc/` | files | `ProposedPlan.swift`, `LoopTemplate.swift`, `llm-doc/generated/` |
| E10 | MobileControl | browses `llm-doc/` read-only | files, wire `llmdoc_*` | `LlmDocBrowser.swift:10` |
| E11 | ReviewConflicts | tree of code and notes; chat scope `.conflicts` | D `LibraryItemStore`; C `ChatPanelRegistry` | `ReviewView.swift:18-27,151` |
| E12 | Core/Notes | classifies files with Library's source list | C `NoteSourceClassifying` | `LibraryItemStore.swift:83`; `SourceRegistry.swift:67` |
| E13 | Agent (search-kb tool) | server FTS | S `ctx.kb.search` | `llm_agent/runtime/handlers/search-kb.mjs:27`, `tools/registry.mjs:154` |
| E14 | Planner, risk, graphkit | `findContext`, `getMeeting`, `getMeetingTranscript` | S | `agents/planner.mjs:8-9`; `graphkit/graph.mjs:8,70,80`; `agents/code-sync.mjs:9` |
| E15 | Legacy chat engine | recent meetings in prompt context | S `kb.listMeetings` | `server/ai-routes.mjs:554` |
| E16 | os-kit | counts of `sources` and `meetings` | S | `kb/os-state.mjs:151-180` |
| E17 | docs-kit, capture-kit | write `doc` rows into `sources` | S `kb.ingestSources` | `server/export-routes.mjs:35,53`; `server/ai-routes.mjs:91,318,337` (two copies of `ingestGeneratedDoc`, kept in sync by comment `export-routes.mjs:16,41`) |
| E18 | knowledge to agent-kit | classifiers use `runClaude`, `routeOpts` | S | `agents/email-classify.mjs:6-7` |
| E19 | Extension | search, stats, connectors, conflict questions | C HTTP | `kb.ts` |

**Cycles and violations.** Seal check: zero cross-feature edges (gate run). Core to feature: none (gate). Server layering: clean (eslint). No cycle on the Node side. Two soft spots, neither a gate failure: E5 (a feature opening Core's SQLite index directly, so the on-disk schema of `index.sqlite` is a cross-kit contract that nothing pins) and E8 (a dead edge). The notes folder layout (E9, E10) is a third, file-based contract with no schema or test of its own.

## 4. Delegated vs owned

| Piece | Label | Why |
|---|---|---|
| Conflict and undecided-item detection (`/kb/conflict-questions`, chat scope `.conflicts`) | **delegated** | One prompt (`router.mjs:1428-1450`). ReviewConflicts has no conflict logic of its own; Chat has no conflict-specific code (grep) |
| Email and connector triage (`email-classify`, `connector-classify`) | **delegated**, thin adapters | JSON contract fixed by the Mac (`connector-classify.mjs:13-14`); candidate to move to SDK structured output |
| Meeting summarization | **delegated** (capture-kit) | `api.summarize` in `MeetingSummarizationService.swift:44` |
| MCP client (`mcp-client.mjs`) | **delegated** for protocol, **owned** for the credential scheme | Uses the MCP SDK client; the vault key scheme keyed by issuer is project control (permission) |
| FTS5 index, tenancy hydration, search ranking | **owned** (knowledge) | No model; user scoping is a security property |
| Source ingest, chunking, dedupe, prune (`sources.mjs`, `git.mjs`, `box.mjs`) | **owned** | Deterministic. Retirement candidate to measure, not assume: the agent already has file tools, so the `code` FTS rows may be partly superseded; decide only with the token bench |
| Folder layout, frontmatter schema, note templates, folder migrations | **owned** (contract) | The files are shared with the user's repo, sync tools, the phone and other kits |
| Connector secrets and OAuth (vault) | **owned** (permission) | `server/vault.mjs` allow-list |
| Seen-set and high-water per source (`email_*`, `slack_*`, `mcp_connector_seen`) | **owned** | Device-independent dedupe (`router.mjs:638-642`) |
| `ProjectExporter`, `LegacyExporter` | **owned**, retire candidates | Projections of server rows into files (section 5) |
| Skills install | **delegated** to the kit's `install.sh` | `install-project-skills.mjs:1-10` |
| Library and ReviewConflicts SwiftUI | **owned** until K3 | |

## 5. State and data: the dual-store problem (feeds K1a)

### 5.1 The stores

| # | Store | Where | Written by | Rebuildable? |
|---|---|---|---|---|
| S1 | Raw transcripts and raw inbox files | `<project>/source/meetings/YYYY/MM/*.md`, `source/emails/...` (`MeetingFileStore.swift:246-248`; `EmailSource.swift:91`) | Live, Email, Slack, MCP sources on the Mac | no: the files are the data |
| S2 | Generated notes | `<project>/llm-doc/<type>/YYYY/MM/*.md` plus `llm-doc/index.json` (`NoteService.swift:180`) | Mac writers, Chat, Loop, Doc Gen | notes no; `index.json` yes (`NoteService.rebuildIndex` `:419`) |
| S3 | Meeting index | `<project>/system/index.sqlite`, `PRAGMA user_version` 3 (`MeetingIndex.swift:78`) | `FolderIndexer.fullScan` (`:59`), watched by kqueue | yes, **except** the `hidden` tombstone (v3, `:114`; `LibraryView.swift:1827-1835`) |
| S4 | In-memory Library list | `LibraryItemStore.items`, built by `performScan` (`:260`); `library_items.json` is decode-only legacy (`:72-78`) | scan of `source/ code/ data/ llm-doc/` plus external code folders | yes |
| S5 | Server KB | `kb/data.db`: `meetings`, `entities`, `sources`, `search` FTS, `email_seen/state`, `slack_*`, `mcp_connector_seen`, vault | `/kb/ingest` (Live only), Pattern A connectors, doc generation | partly: Pattern A rows are re-indexable; meetings and entities are not |
| S6 | Mac config | UserDefaults `Saved*Source`, notes-folder bookmark `MEETNOTES_NOTES_FOLDER_*` (`NotesFolderConfig.swift:18-19`) | Settings | n/a |

Two roots exist: the global notes folder (default `AppIdentity.documentsRoot()`, `NotesFolderConfig.swift:104`) and the project root. With a project open the notes folder is bound to `<project>/source`, and the index is placed at `<project>/system/index.sqlite` (`AppEnvironment.swift:42-48`).

### 5.2 Source of truth, per datum

| Datum | Truth today | Copy |
|---|---|---|
| Meeting transcript text | Mac file (raw) | Server `meetings.transcript`, **redacted** for secrets (`meetings.mjs:26-30`), so the two differ by design |
| Meeting summary, actions, decisions, blockers | Mac file (frontmatter `tldr`, body headings; `MeetingSummarizationService.swift:44-56`) | none |
| Entities (action, decision, blocker) on the server | nobody | `CaptionScraper.swift:304` always sends `entities: []`; the extension never calls `/kb/ingest`; `INSERT INTO entities` exists only in `meetings.mjs:80`. So no shipping client fills the table |
| Email, Slack, MCP-backed notes | Mac files only | none: `ingestMeeting` has one caller (`CaptionScraper.swift:354`); `EmailSource.fetchAndIngest` (`:30-86`) writes files and marks seen |
| Box documents, code, tickets, QA | Server `sources` | none on disk; no Mac code calls `/kb/search` (`search(q:)` has no caller, grep) |
| Seen-set and high-water | Server | none |
| Connector config | Mac UserDefaults | secrets on the server vault |
| Hidden meetings | `index.sqlite` only | none |

### 5.3 Where they disagree today (findings)

1. **Server entities are empty for Mac captures** (above). Server search kinds `action`, `decision`, `blocker` and the history block of `/kb/conflict-questions` (`router.mjs:1428-1430`) therefore have no data from the shipping clients. Evidence by reading; the live DB was not inspected (section 11).
2. **Pattern B notes are invisible to server search**, the agent's `search_kb` tool and the planner. They are reachable by the agent only through file tools.
3. **Pattern A rows are invisible to the Mac Library.** No Mac screen lists `sources`.
4. **Deleting does not propagate.** "Remove from List" only hides in `index.sqlite` (`LibraryView.swift:1827`); no Mac code calls `/kb/delete`. The redacted server copy of every captured meeting persists and stays searchable.
5. **`ProjectExporter` writes a second file for each server meeting** into the same folder Live writes to: `source/meetings/YYYY/MM/` (`ProjectExporter.swift:174-187`). Names differ (it appends the **last** 8 id characters, `:512`; Live appends the **first** 8 or an FNV hash, `MeetingFileStore.swift:256-262,270-281`), and its frontmatter has `date`, `duration` and no `started_at`, `platform` or `tldr` (`:374-382`), which `MeetingFrontmatter.init(from:)` requires (`:78-87`). `FolderIndexer` swallows that failure with `try?` (`FolderIndexer.swift:95`). By reading, such files sit on disk unindexed. Not run.
6. **Library "Sources" is three different things**: the UI category `.meetings` shown as "Sources" (`LibraryItem.swift:46-55`), the server `sources` table, and `InputSource`. `sources.mjs:2-4` claims the table surfaces in the Library's Sources filter; the Mac does not read it.
7. **The memory note** "Pattern B: Mac turns items into notes, then `meetings`/`entities` via `/kb/ingest`" is out of date (finding 2).

### 5.4 Read paths per consumer

| Consumer | Reads | Via |
|---|---|---|
| Library UI | S4 list, S3 rows for meetings | in-process |
| Chat, CodeGraph, SourceControl, ReviewConflicts | S4 | `LibraryItemStore` env |
| AutoTask | S2 notes, S3 meetings | `ProjectNotesProviding`, its own `MeetingIndex` |
| Doc Gen | S4 items; files by URL | `LibrarySourceFeed` |
| Phone | S2 files | `LlmDocBrowser` |
| Agent, planner, graphkit, os-kit, legacy chat | S5 | in-process Node |
| Extension | S5 | HTTP |

No consumer reads both stores for one question.

### 5.5 Ingest flows

- **Pattern A** (server indexes, `box.mjs:1-5`): fetch, chunk, `deleteSourcesByPrefix` then `ingestSources` (`box.mjs:266-275`), wholesale re-index per run, rows `{kind, ref, chunkIdx, title, body, meta}` capped at 50 000 chars (`sources.mjs:70`), per-user unique since `0022`. Git adds a content-hash incremental path (`git.mjs:185-186`). Trigger: one `/kb/connect-*` route.
- **Pattern B** (fetch only, Mac writes files): the route returns items (`router.mjs:648-665`), the Mac saves raw files (`EmailSource.swift:91`), classifies by `/kb/email/classify` or the manifest engine's classify route, writes a note with `EmailNoteWriter` or `SourceConnectorNoteWriter`, then `markEmailSeen` (`:61`). Dedupe is by content hash against existing notes (`:70-73`) plus the server seen-set. Declarative connectors need a manifest in `Resources/source_connectors/` and the server defs in `mcp-connector-defs.mjs`.
- **Server to files** (the reverse): `ProjectExporter` on project close (`ProjectStore.swift:290-312`) and the manual `LegacyExporter` (`AppShell.swift:996-1012`, from `/kb/export-all`).

## 6. K1a data plan (home of the state after K1)

K1a is tests and fixtures only. Constraints from the plan: one-way migration, N-1 readability, rollback with the Swift path kept one release behind a preference, migration test with a real old-format fixture. `mac/Tests/LlmIdeMacTests/Fixtures/` today holds only `docgen/`; **no notes fixtures exist**, so K1a must first capture real old-format files (meeting `.md` with and without `platform`, `llm-doc` notes with `index.json`, legacy `library_items.json`, `index.sqlite` at user_version 1, 2 and 3 with a hidden row).

Constraint from the token plan: putting notes into the shared FTS table changes what `search_kb` returns by default (`search-kb.mjs:27` passes `kind: null`). That is behaviour-changing work and must not ride in a K1: new rows go under a kind the default search skips until the bench says otherwise.

| Option | Home of notes after K1 | N-1 readability | Rollback | Main risks |
|---|---|---|---|---|
| **A. Files stay the truth; Node owns a derived index and the read API** | Files unchanged. New additive tables in `data.db` (next migration after `0049`): note index (user, project, relative path, id, type, source, title, started, size, mtime, hash, hidden) plus FTS under a non-default kind. Node scans registered roots (precedent: `kb/project-roots.mjs:34` and `kb/doc-project-files.mjs` confinement rules) | Perfect: no file is rewritten; an old Mac ignores the new routes | Preference `knowledgeUseServerIndex`, default off. Off runs S3 and S4 exactly as today; derived rows can be dropped and rebuilt | Server reads user folders (iCloud, Dropbox placeholders, TCC under a future sidecar); two roots to register; `hidden` is not derivable and must be dual-written for one release; frontmatter parse parity between Swift (`asDate` regex) and Node; index growth (trigram, bodies up to 50 000 chars per row) |
| B. Server DB becomes the truth; files are an export | Notes live in SQLite; Mac writes through routes; files projected | Breaks unless every write is dual | Re-export, slow and lossy | Reverses the product premise that the project folder is the single source of truth (`LibraryItemStore.swift:44-49`); touches Live write path (1 s flush, `MeetingFileStore.swift:25`); phone and sync tools lose the files |
| C. Both stay; Mac pushes every note it writes | Files truth; server receives `POST` upserts keyed by path and hash, deletes propagate | Good: an old Mac simply does not push | Stop pushing; rows stale but harmless | Push can fail or lag, so a reconcile pass is needed anyway; logic stays in Swift (little K1 gain); fine only if the server cannot read the disk (relay) |
| D. No unification: fix the three defects and document the seam | Stores stay separate: stop sending empty entities (or send real ones), propagate delete, decide Pattern B visibility | n/a | n/a | Leaves the hub with no common query; K3 Tauri screens cannot list notes without a scan route |

**Recommendation (not a decision): A**, staged so that every stage is reversible: (1) fixtures and parity tests; (2) read-only scan, tables and routes behind the preference; (3) Mac list and meeting-row reads switch under the preference; (4) hidden and delete propagation; (5) later, after the bench, the opt-in to include notes in agent search. Keep C as the fallback for a deployment where the server cannot read the notes folder. A matches how docs-kit handled the same file-versus-server question (files stay the contract, Node reads and writes by project id).

**Other state after K1.** Connector config stays in UserDefaults and secrets in the vault; seen and high-water stay on the server; `index.sqlite` stays one release; `ProjectExporter` is frozen (not extended) pending Q8.

## 7. Open questions for the user

Options are listed; the leaning is my recommendation only.

| # | Question | Options | Leaning |
|---|---|---|---|
| Q1 | Source of truth for note content after K1 | A files, B server DB, C push, D none | A |
| Q2 | Should meeting and Pattern B notes be searchable by the agent and planner by default? (changes tokens) | never, behind a flag, on after the bench | flag, then bench |
| Q3 | When a meeting is removed or deleted in the Library, delete the server copy? | never, on file delete, on hide too | on file delete |
| Q4 | Keep sending the full transcript to the server for Mac meetings? | keep, metadata only, stop | keep until Q1 settles |
| Q5 | Entities: fill them from the Mac summary, or retire the table, the `action/decision/blocker` search kinds and the `/kb/conflict-questions` history | fill, retire | needs your call; today it is dead data |
| Q6 | Keep ReviewConflicts as its own section, or fold it into a Chat scope? (it is a file tree plus a chat panel) | keep, fold | keep until K3 |
| Q7 | Who owns the 5 457 lines of plugin, MCP and LLM-source UI in `Features/Library`? | knowledge-kit, agent-kit K3/K4 | agent-kit |
| Q8 | `ProjectExporter` second `.md` per meeting | fix names and frontmatter, retire | retire after Q1 |
| Q9 | Kit boundaries in the plan table: `agents/slack.mjs`, `agents/code-sync.mjs`, `connectors/{git,issues,qa}`, `/kb/conflict-questions`, `/kb/notify/slack` | reassign to work-kit and graph-kit, leave | reassign |
| Q10 | Project registration route (`/kb/projects/register`) is in the `doc_gen` group; knowledge K1 needs it always on | move out of the group, add a second route | move |
| Q11 | Notes folder in iCloud, Dropbox, Google Drive or OneDrive (`NotesFolderConfig.detectSyncProvider` `:95-103`) | server reads it, fallback to C for those | fallback |
| Q12 | N-1 window for the Swift path | one release (plan), two | one |
| Q13 | Does the kit stay keyless (always on)? | keep, add a `library` key | keep |
| Q14 | One KB user per Mac user: are notes on disk per user? | single user assumed, per-user folders | single user |

## 8. K1 task breakdown (proposal, assumes option A)

Size is in tasks of about 1.5 to 3 k lines each, at the plan's 0.4 to 0.7 M agent tokens per task.

| # | Task | Size | Exit |
|---|---|---|---|
| 1 | K1a fixtures and tests: old-format meeting, `llm-doc` and `index.json`, `library_items.json`, `index.sqlite` v1 to v3 with hidden row; Swift decode tests | 1 | Fixture committed; both parsers agree |
| 2 | Node frontmatter and note-layout reader (port of `MeetingFrontmatter`, `MarkdownFrontmatter`, `FrontmatterCoder`, `FolderIndexer`, about 690 Swift lines) plus golden parity | 1.5 | Golden fixtures pass on both sides |
| 3 | Migration for note index and FTS under a non-default kind; root registration always on (Q10) | 1 | Rebuildable; drop-and-rebuild test |
| 4 | Routes: list, filter, hide, rescan, search (additive, kb-sources group, fixtures, `SERVER_API_VERSION` 84) | 1.5 | Contract gates and live test green |
| 5 | Mac read switch behind `knowledgeUseServerIndex` (LibraryViewModel, rows, AutoTask meeting rows) | 2 | Same list on same fixture, flag off unchanged |
| 6 | Hide and delete propagation, entities decision (Q3, Q5) | 0.5 to 1 | Tests both ways |
| 7 | Port Swift tests for moved logic to node tests before deleting any Swift test | 1 | Count parity |
| 8 | Bench and budgets | 0.5 | Table below |
| 9 | Review and hardening (symlinks, folder caps, sync placeholders) | 1 | |
| 10 (optional, K1b) | Pattern B fetch, classify and write loop to Node (about 1 400 Swift lines in `EmailSource`, `SlackSource`, `SourceConnector*`, `Inbox*`) | 2 to 3 | |

Total 10 to 13, consistent with the plan's 10 to 14 for K0 to K2. The capture-side writers (`MeetingFileStore`, 1 s flush) stay in Swift until capture-kit.

**Latency budgets** (measured baselines on a synthetic 10 000-row corpus, random vocabulary, unsandboxed, one machine; real corpora will differ):

| Call | Baseline now | Budget |
|---|---|---|
| `search` p95, 10 k rows | 22.8 to 27.5 ms (5 queries, 20 runs each, including CJK and 2-character) | 50 ms |
| `findContext` p95 | 124.6 ms | 200 ms |
| `ingestSources` 10 k rows of about 2 KB | 5.0 s | no regression |
| Node scan of 5 000 notes: walk | 6 ms | |
| same: read and frontmatter regex | 75 ms | cold scan under 1.5 s with a real YAML parser |
| same: stat only (no change) | 12 ms | incremental rescan under 100 ms |
| Library list from the server index | not built | under 50 ms at 5 k notes |
| Live capture write path | unchanged, stays in Swift | |

## 9. K2, K3, K4

**K2 Remove.** The key is `always`, so there is no `LLMIDE_FEATURES` row to turn off and no server `feature_disabled` to assert. "Remove" for this kit means: (a) the kit's replaceable parts are independently removable: a per-user connector deselected (`connector-catalog.mjs`, `connector-state.mjs`) leaves no dangling route or card; (b) the Library compiles and boots against a stub for each Core seam (`NoteSourceClassifying`, `SourceIngesting`, `ProjectNotesProviding`, `LibrarySourceFeed` default is already empty, `LibrarySourceFeed.swift:17`); (c) `build-mac-min` and `build-mac-lite` still build and the feature matrix stays green; (d) gate check 1 stays at none. If Q13 adds a `library` key, K2 adds the usual matrix row. I could not find a smaller always-on example to copy; docs-kit and graph-kit both have keys.

**K3 Screen.** Tauri screens for Library list and detail, connectors and search read only the K1 routes; a WebView cannot scan the folder. Depends on task 4. Plugin and MCP screens follow Q7.

**K4 Retire.** `Core/Notes` is read by Chat, CodeGraph, SourceControl, AutoTask, Live (writes), Loop (writes), Doc Gen and ReviewConflicts, plus the phone through files. It cannot be deleted before those kits move to routes, so knowledge K4 is the last K4 in the DAG, not an early one. `MeetingIndex` (E5) and `NoteService` direct users must be moved first.

## 10. Drift, gaps and corrections to the plan's premises

| # | Finding | Evidence |
|---|---|---|
| P1 | Contract group is not only `kb-sources`: connector selection and OAuth are in `health-auth` (11 rows) and `/kb/conflict-questions` is in `planning` | section 2d |
| P2 | `agents/slack.mjs` is outbound webhook delivery for plans and dispatch, not a Slack source; it belongs with work-kit | `agents/slack.mjs:1-5`; `router.mjs:15,1352` |
| P3 | `code-sync` is a deterministic graphkit lookup used by the planning route; no knowledge edge except through `graphkit` | `agents/code-sync.mjs:1-9`; `routes/planning.mjs:17` |
| P4 | ReviewConflicts has no conflict logic: a file tree plus `ChatPanelView(scope: .conflicts)`; the Mac never calls `/kb/conflict-questions` | `ReviewView.swift:18-27,151`; `Routes.swift:192` |
| P5 | The dual store is wider than two stores read by five features: four Mac-side read models and the server, read by at least eight features, plus the phone | section 5, section 3 |
| P6 | 45% of `Features/Library` is plugin, MCP and LLM-source UI | section 2b |
| P7 | Server `entities` has no writer in shipping clients | `CaptionScraper.swift:304`; `meetings.mjs:80` |
| P8 | `/kb/search`, `/kb/meeting/:id`, `/kb/entity/:id`, `/kb/delete` have no live Mac UI caller | INVENTORY; `DocTemplate.swift:278` |
| P9 | The "known hard spot" omits that deletes do not propagate and that `ProjectExporter` duplicates meeting files | section 5.3 |
| P10 | Another stale doc: `kb/sources.mjs:2-4` says sources surface in the Library "Sources" filter | section 5.3, item 6 |
| P11 | Test pollution: `extension/tests/` holds 2 261 entries including hundreds of `_llm-sources-discovery-fixture-*` directories (gitignored, so not in the repo, but local runs leave them) | `ls` count; `git check-ignore` on `_kb-router-test.db` |
| P12 | `kb/meetings.mjs` is listed under both knowledge (search reads it) and capture-kit (plan row 8); `ingestMeeting` needs one owner | plan rows 4 and 8 |

## 11. What I could not verify

- **Real data.** I did not open the user's live `data.db`; the repo copy `extension/kb/data.db` has no tables. The claim that server `entities` is empty comes from reading every writer, not from counting rows.
- **Mac tests were not run.** Counts are greps. `swift test` was skipped (sandbox, shared `.build` lock with another agent, about 60 s with the memory keychain). So no Mac pass or fail is claimed.
- **Finding 5.3 item 5** (exporter files unindexed) is by reading `FolderIndexer.upsert` and the frontmatter decoder; I did not run an export.
- **Mac scan cost.** I did not measure `LibraryItemStore.performScan` or `MeetingIndex` at scale, so the Mac side has no baseline; the Node numbers are a synthetic stand-in.
- **Benchmarks** used a random vocabulary; trigram index size and ranking under real text were not measured.
- **Sandbox.** Server tests need `listen` on 127.0.0.1 and git; run unsandboxed (261 of 261 pass).
- **Phone.** I read the wire constants and `LlmDocBrowser`, not the iOS app.
- **Unread in depth:** `SlackSource` and `SourceConnector` engine bodies, `MeetingDetailViewModel`, `NoteService.saveNote` internals, the Chrome extension's `Settings.tsx` search UI beyond the call site.

## 12. Verification log

| Command | Outcome (2026-10-28) |
|---|---|
| `node --test` on the 45 server test files | 261 tests, 261 pass, 0 fail, 9.4 s (sandboxed: 244 pass, 17 fail, all `listen EPERM` or git) |
| `bash mac/Scripts/feature-boundaries.sh` | every section `none` |
| `npx eslint connectors agents kb/sources.mjs kb/project-export.mjs kb/exporter.mjs kb/install-project-skills.mjs kb/meetings.mjs --max-warnings 0` | no output |
| Synthetic bench: 10 000 `doc` rows, `search` and `findContext`, 20 runs per query | see section 8 |
| Synthetic scan: 5 000 `.md` files, Node | walk 6 ms, read and regex 75 ms, stat 12 ms |
| Python count of `kb-sources.schema.json` endpoints; file count of `fixtures/kb-sources` | 34 rows; 96 files |
| `grep` for Mac callers of `search(q:`, `ingestMeeting`, `/kb/delete`, `DocGenSource.meeting` | one, `CaptionScraper.swift:354`; none; none |
| Not run | `make regression`, `make contract-gates`, Mac `swift test`, `make feature-matrix` |
