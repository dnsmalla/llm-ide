# docs-kit

Status: **K0 Map**, reviewed 2026-10-27 (review fixes applied; decisions in §7).
No code changed. Line counts are `wc -l` at this commit. Citations are `path:line`.

## 1. Purpose

docs-kit turns the user's selected sources (project files, meeting transcripts,
KB notes, phone-supplied files) into a Markdown document, following a template
(sections) and/or a free-text command, and lets the user save, edit and revise
the result. It is the Mac **Doc Gen** and **Visual** tabs, the phone's
generation run, and the Chrome extension's DOCX export of a meeting.

## 2. Code on every side

### 2a. Server (Node)

| Piece | Path | Lines | Notes |
|---|---|---|---|
| Route handlers `POST /generate-doc`, `POST /generate-docx` | `extension/server/export-routes.mjs` (handler: `:315` `handleExportRoutes`; `/generate-docx` `:317-401`; `/generate-doc` `:404-466`) | 469 (whole file) | Only module that owns the two routes. |
| Source packing (water-fill budget) | `export-routes.mjs:80` (`MAX_SOURCE_CONTENT`), `:122` (`packSources`, body to `:202`) | ~80 | Pure; exported for tests. `MAX_TOTAL_SOURCE_CHARS` 400 000 is the default `budget`. |
| Prompt assembly | `export-routes.mjs:207` (`buildDocPrompt`) | ~11 | Template + command + prompt + sources. |
| Accept/reject gate | `export-routes.mjs:226` (`validateDocRequest`) | ~31 | 400 `VALIDATION_FAILED`. |
| KB ref builder (command hash) | `export-routes.mjs:257` (`buildDocRef`) | ~10 | Keeps KB rows from clobbering. |
| DOCX builder for meeting notes | `export-routes.mjs:267` (`buildMeetingDocx`), `:362` (`docx.Packer.toBuffer`) | ~47 | Uses npm `docx`; lazy-loaded by `loadDocx` `:12`, which does `import('docx')` at `:13`. |
| KB ingest of output (secret scan first) | `export-routes.mjs:36-64` (`ingestGeneratedDoc`) | 29 | Skips ingest when `scanForSecrets` hits. |
| Route registration | `extension/server.mjs:11` (import), `:283-284` (`ALL_ENDPOINTS`), `:431-432` (`llmFast` bucket), `:855` (dispatch) | — | `SERVER_API_VERSION = 79` at `:278`. |
| Feature-group comment (doc_gen is not gated) | `extension/routes/feature-routes.mjs:13-15` | 104 (file) | The `doc_gen` bullet: ExportMenu + REQUIRED_ENDPOINTS keep both routes always-on. |
| Templates served to the app | `extension/routes/agent.mjs:386-400` (`GET /kb/agent/generation-library`), `extension/llm_agent/skills/generation-library.mjs` | 207 | Reads the kit's `templates/{doc,vis}` and `commands/`. |
| Kit template files (data) | `.skills/templates/doc/*.md` (6 files), `.skills/templates/vis/*.md` (3 files) | — | Submodule; frontmatter `name`/`description`, body = `##` sections. |
| Kit command files (data) | `.skills/commands/doc/*.md` (4 files: `release-notes`, `explain-code`, `ship-it`, `summarize`), `.skills/commands/vis/*.md` (3 files: `read-chart`, `extract-text`, `describe-image`), `.skills/commands/cli/*.md` (8 files) | — | `commands/README.md` also present. The `cli/` group is not a Doc Gen or Visual menu family. |

**Model calls (providers/).** Both routes call `runClaude` from
`extension/providers/runtime.mjs` (imported `export-routes.mjs:2`), with
`maxTokens: 2048` (`:338`, `:437`) and `llmFast` rate-limit bucket (`server.mjs:432`).
Prompts: the meeting-notes JSON prompt (`export-routes.mjs:336`, returns
`{title,decisions,todos,agenda,minutes,qa}`), and the document prompt from
`buildDocPrompt` (`:207`). No `agents/` module is used.

**Other server imports.** `kb/db.mjs` (`:4`, `kb.ingestSources`), `guardrails/scan.mjs`
(`:5`), `core/utils.mjs` (`:3`). No new SQLite table; output is one `sources`
row with `kind='doc'`, `ref = u:<userId>:doc:<title>[:<hash>]:<sourceNames>`
(`:52`, `:257`) or `u:<userId>:docx:<meetingId | title:date>` (`:385`).

### 2b. Mac app (Swift)

| Layer | Piece | Path | Lines |
|---|---|---|---|
| Features | Doc Gen views | `Features/Generation/DocGen/Views/` (4 files: `DocGenView`, `DocGenSourcePanel`, `DocGenPromptBar`, `DocGenEditorPanel`) | 320 |
| Features | Visual views | `Features/Generation/Visual/Views/` (4 files: `VisualView` 360, `VisualCenterPanel` 143, `VisualSourcePanel` 194, `VisualPromptBar` 35) | 732 |
| Features | Shared generation views | `Features/Generation/Views/` (9 files; largest `GenerationEditorPanel` 640, `GenerationTemplateSection` 417, `GenerationPromptBar` 309, `GenerationSourceTree` 296, `DocTemplateManagerSheet` 223) | 2 219 |
| Features | **Total** | `Features/Generation/` (16 files) | **3 271** |
| Core | ViewModel + registry | `Core/Generation/Services/GenerationViewModel.swift` (579), `GenerationRegistry.swift` (74) | 653 |
| Core | Stores | `DocTemplateStore.swift` (307), `DocCommandStore.swift` (179), `DocGenOutputStore.swift` (92), `GenerationLibraryStore.swift` (138) | 716 |
| Core | Seeders | `ProjectDocTemplatesSeeder.swift` (108), `ProjectDocCommandsSeeder.swift` (88) | 196 |
| Core | Models | `DocTemplate.swift` (318), `DocCommand.swift` (168), `TemplateSurface.swift` (115), `DocGenOutputConfig.swift` (56) | 657 |
| Core | Mermaid/render helpers (not docs-only) | `Core/Generation/Services/GenerationConformance.swift` (115) | 115 |
| Core | **Total** | `Core/Generation/` (13 files) | **2 337** |
| Core | HTTP client | `Core/Networking/API/LlmIdeAPIClient+Export.swift` (285 file; `GenerateDocRequest` `:53`, `GenerateDocResponse` `:70`, `GeneratedDoc` `:88`, `generateDoc` `:115`, `exportMarkdown` `:173`) | lines 51–171 are docs-only |
| Core | Library catalogue client | `Core/Networking/API/LlmIdeAPIClient+AgentMeta.swift:107` (`generationLibrary()` → `GET /kb/agent/generation-library`) | — |
| Features | Phone bridge | `Features/MobileControl/Services/MobileGenerationBridge.swift` (225) | 225 |
| Core | Wrong-looking name, different path | `Core/Notes/Services/MeetingNoteGenerator.swift:60` `generateDocx` runs a bundled Python script, **not** `/generate-docx` (see §3) | — |
| Shell | Wiring | `Shell/FeatureCatalog.swift:206-221` (`docGenPane`, `visualPane`), `:629-637` (`provideGenerationStores`, `wireGenerationBridge`); `Shell/AppShell.swift:17-19` (env objects), `:495` (`GenerationRegistry.shared.reset()` on project switch/close), `:748-762` (`.visual`/`.docGen` cases gated by `registry.isEnabled(.docGen)`), `:1083` (`seedAndReloadGenerationFiles`, seeder calls at `:1096-1098`); `Shell/LlmIdeMacApp.swift:99-101, 181-186, 269, 371-373` (`bootstrap()` at launch), `:378` | — |
| Contracts | Section enum | `Core/Contracts/ShellSection.swift:22` (`visual`, `docGen`), `:41-42` and `:61-62` (titles/icons), `:78`, `:95-96` | — |
| Contracts | Chat seams used | `Core/Contracts/ChatPanelProviding.swift`, `Core/Contracts/ChatOutputProviding.swift` (used by `GenerationSaveChatOutputRow.swift:43`) | — |
| Feature key | Feature enum | `Core/FeatureToggles/AppFeature.swift:9` (`docGen = "doc_gen"`), `:22` (title), `:33` (requires `fileExplorer`), `:45` (icon), `:64` (excludable list), `:98` (`focusedAI` preset) | — |
| Settings | Help only | `Features/Settings/Views/HelpGuideView.swift:21-24, 93, 326-330` (no Settings card of its own) | — |

The `Core/Generation` side has **no SwiftUI views** but three `NSAlert` calls
(`GenerationViewModel.swift:527`, `:572`) and `GenerationViewModel.save` /
`saveChatOutput` (`:502`, `:555`) present UI from Core.

`GenerationConformance.swift` is **not docs-only**: `mac/Sources/ChatContractLab/main.swift:90-245`
calls it 16 times (Mermaid fence detection, rendered HTML, preview gating, per-scope
model memory). It is the Doc Gen twin of `Core/Editor/MermaidConformance.swift`.

### 2c. Extension (Chrome)

| Piece | Path | Lines |
|---|---|---|
| ExportMenu (DOCX export of a meeting) | `extension/src/sidepanel/components/ExportMenu.tsx` (calls `authFetch(${serverUrl}/generate-docx)` at `:86`) | 180 |
| Mount point + REQUIRED_ENDPOINTS | `extension/src/sidepanel/App.tsx:20` (import), `:59` (`'/generate-docx'` in REQUIRED_ENDPOINTS), `:627-633` (mount with `language`) | — |
| DOCX help text | `extension/src/sidepanel/components/HelpPanel.tsx:382` ("export as DOCX"), `:735` ("Download DOCX") | — |
| Timeout comment | `extension/src/lib/config.ts:251` | — |

The extension **does not** call `/generate-doc` (no match in `extension/src`
beyond the type file).

### 2d. Contract and phone wire

| Piece | Path | Count |
|---|---|---|
| Group spec | `schema/http/notes-generation.schema.json` (902 lines); `Source` def `:16-27`; `POST /generate-doc` `:494`; `POST /generate-docx` `:583` | 2 of the group's 9 endpoints (group also holds `/generate-notes`, `/generate-questions`, `/extract-entities`, `/chat`, `/code-assist*`, `/agent-sdk/spike`) |
| Fixtures (docs routes only) | `schema/http/fixtures/notes-generation/post-generate-doc-{200,400,401,429,500}.json` and `post-generate-docx-{200,400,401,429,500}.json` | 10 of 45 group fixtures |
| Inventory | `schema/http/INVENTORY.md:31-32`, `:91-92` | `/generate-doc` consumer: only `LlmIdeAPIClient+Export.swift`; `/generate-docx`: `ExportMenu.tsx`, `App.tsx` |
| TS types | `extension/src/lib/api-types.ts:840` (`Source`), `:3624-3682` (request/response types), `:6252-6269` (route map) | — |
| Live contract (extension) | `extension/tests/http-contract-live.test.mjs:103` (DOCX fixtures are the `200` for `POST /generate-docx`) | — |
| Mac contract lab | `mac/Sources/APIContractLab/Routes.swift` (references both routes) | — |
| iOS generate sheet | `ios_app/MyApp/Views/Control/GenerateSheet.swift` (169 lines): template/command pickers, prompt, sources; the Mac generates and saves under `llm-doc/generated/` | — |
| iOS client routing | `ios_app/MyApp/Services/ConnectionService.swift:668` (`generation_options`, `generation_result`, `llmdoc_*` dispatch), `:694` (`gen_` ids, `generation_run`) | — |
| iOS wire constants | `ios_app/SharedProtocol/Sources/SharedProtocol/MobileProtocol.swift:31` (feature key `generation`), `:133-136` (`generation_options_list`, `generation_options`, `generation_run`, `generation_result`) | 4 wire types (corrects the earlier `:132-134`) |
| iOS wire types | `ios_app/SharedProtocol/Sources/SharedProtocol/GenerationMessages.swift` (phone generation messages, sync-kit wire) | — |

### 2e. Feature key `doc_gen`

- **Package.swift** (`mac/Package.swift`): `:25` (key in the list), `:30`
  (`file_explorer` closure drops `doc_gen`), `:35` (`docGenIncluded`), `:106-116`
  (when off: **lib exclude `Features/Generation`**, **test exclude
  `GenerationTreeSelectionTests.swift`**; `GenerationViewModelTests` stays
  compiled because its type lives in `Core/Generation`). Lab product
  `:337`, target `:416-418`.
- **feature-map.txt** (`mac/Scripts/feature-map.txt`): `Features/Generation/` row, sealed.
- **Server**: not gated, by design. The evidence is the caller, not the generic
  rule: `extension/routes/feature-routes.mjs:13-15` (the `doc_gen` bullet: both
  routes are called by the Chrome ExportMenu, and `/generate-docx` is in its
  REQUIRED_ENDPOINTS), `ExportMenu.tsx:86`, `App.tsx:59`. `extension/CLAUDE.md:31`
  states the general single-owner rule that this exception falls outside.
  Consequence: `doc_gen` off leaves both routes live; `/generate-doc` is then
  reachable with no Mac caller.
- **Feature-matrix row**, run on 2026-10-27:
  - Server (`node scripts/feature-matrix.mjs --key doc_gen`): **ok**, live
    contract in assert mode **411 pass / 0 fail**.
  - Mac (`--key doc_gen --mac-only`): **ok, 5 s**. This was an incremental
    build in the existing scratch path, so it is not a cold-build measurement.
  - Plan wording "not server-gated" is accurate: `feature-matrix.test.mjs:80`
    asserts `/generate-docx` has no feature group.
- **Closure**: `file_explorer` off ⇒ `doc_gen` off (`AppFeature.swift:33`,
  `scripts/feature-matrix.mjs:69`, `docs/how-to/run-the-feature-matrix.md:12`).

### 2f. Tests and gates

| Side | File | Count (method) |
|---|---|---|
| Server | `extension/tests/generate-doc-prompt.test.mjs` (317 lines) | 29 `test(` (grep `^test(`): prompt shape, gate matrix, `buildDocRef`, `packSources` budget, `/generate-doc` 400 paths |
| Server | `extension/tests/generation-library.test.mjs` (171 lines) | 10 `test(`: kit template/command parsing, surface split (`commands/doc/`, `commands/vis/`), pre-split and `visual/` layouts. Coupled to the layout comment at `extension/llm-sources/registry.mjs:254-257` (`:256` names `llm_agent/skills/generation-library.mjs`), which must change with it. |
| Server | `extension/tests/feature-routes.test.mjs:139-140`, `extension/tests/server-features-health.test.mjs:91`, `extension/tests/feature-matrix.test.mjs:35-93`, `extension/tests/http-contract-live.test.mjs:103` | cross-cutting asserts (4 files, 1 to 4 refs each) |
| Mac | `mac/Tests/LlmIdeMacTests/GenerationViewModelTests.swift` (189) | 12 `func test` (XCTest); 3 of them drive `applyEdit` (`:127`, `:152`, `:173`; calls at `:133`, `:158`, `:179`) |
| Mac | `DocCommandTests.swift` (62) | 7 XCTest |
| Mac | `DocCommandStoreTests.swift` (171) | 6 XCTest |
| Mac | `DocGenOutputConfigTests.swift` (89) | 7 XCTest |
| Mac | `DocTemplateRewriteTests.swift` (80) | 6 swift-testing (`@Test`) |
| Mac | `GenerationTreeSelectionTests.swift` (145) | 11 XCTest; excluded with `doc_gen` |
| Mac | `LlmDocBrowserTests.swift` (84) | 10 XCTest; tests `MobileGenerationBridge` helpers (`:56-61`) |
| Mac | `AutoTaskTemplateStoreTests.swift:325` | 1 of 26 touches `DocTemplateStore` |
| SharedProtocol | `ios_app/SharedProtocol/Tests/SharedProtocolTests/GenerationMessagesTests.swift` (124) | 12 XCTest (phone wire) |
| Gate | `mac/Sources/GenerationContractLab/main.swift` (126 lines) via `make generation-gates` | 19 `expect(` call sites on the template **surface marker** (the 20th grep hit is the `func expect` definition at `:27`); `make generation-gates` → "all assertions passed" (2026-10-27) |
| Gate | `mac/Sources/ChatContractLab/main.swift:90-245` | 16 calls into `GenerationConformance` (Mermaid helpers); see §2b |
| Gate | `scripts/conformance-agent-v2.mjs:237-275` ("generation ownership") | source check: Doc Gen / Visual must resolve `GenerationViewModel` from `GenerationRegistry`. Note: `GenerationConformance.swift:22` names it `generationViewOwnership`, the code has no such identifier (comment drift). |
| Gate | `mac/Scripts/feature-boundaries.sh` (run 2026-10-27) | 0 cross-feature, 0 always-compiled violations, 0 Core→feature edges |
| Lint | `extension/server/export-routes.mjs`, `extension/routes/feature-routes.mjs` | eslint `--max-warnings 0`: clean |

Tests on the **generation path itself** (a live `/generate-doc` with a real model)
do not exist; all server tests stop before `runClaude`.

## 3. Cross-kit edges

Legend: **C** = through `Core/Contracts` or an HTTP route; **D** = direct type/module reference; **✗** = violates the K0 rule (Swift edges go through Core contracts or HTTP). Decision 9 (§7) makes server in-process imports that follow the ESLint layering **allowed**, so E2–E4 are not ✗.

| # | From → To | Mechanism | Ok? | Evidence |
|---|---|---|---|---|
| E1 | docs → core (Node) | import `core/utils.mjs` | ok | `export-routes.mjs:3` |
| E2 | docs → agent-kit (providers) | `runClaude`, `resolveLanguage` in-process | ok (server layering, decision 9) | `export-routes.mjs:2`, `:330`, `:338`, `:437` |
| E3 | docs → knowledge (kb) | `kb.ingestSources` in-process | ok (server layering, decision 9) | `export-routes.mjs:4`, `:54` |
| E4 | docs → work-kit guardrails | `scanForSecrets` in-process | ok (server layering, decision 9) | `export-routes.mjs:5`, `:45` |
| E5 | docs → agent-kit templates | `GET /kb/agent/generation-library` (Mac) → `llm_agent/skills/generation-library.mjs` | C | `LlmIdeAPIClient+AgentMeta.swift:107`, `routes/agent.mjs:396` |
| E6 | docs (Mac) → core HTTP | `generateDoc`, `exportMarkdown`, `getMeeting` | C | `GenerationViewModel.swift:213, 247, 327`; `LlmIdeAPIClient+KB.swift:109` |
| E7 | docs (Mac) → chat seams | `ChatPanelRegistry`, `ChatOutputRegistry` | C | `GenerationSaveChatOutputRow.swift:43`, `ChatOutputProviding.swift` |
| E8 | docs (Mac) → knowledge backing | `LibraryItem`, `LibraryItemStore` (Core/Notes) directly | **✗ (D)** | `Features/Generation/Views/GenerationTreeSelection.swift:14, 43`; `GenerationSourceTree.swift:37` |
| E9 | MobileControl (`Features/MobileControl`) → docs (`Core/Generation`) | `DocTemplateStore`, `DocCommandStore` (init + env), `GenerationViewModel.sourceFitNotice` static call; `api.generateDoc` (C) | **legal under today's gate** (Features may import Core); **✗ (D) under the K0 rule** (direct type, not `Core/Contracts`) | `MobileGenerationBridge.swift:19-20, 25, 166, 189` |
| E10 | ui-kit (`Core/DesignSystem`) → docs | `@EnvironmentObject DocTemplateStore / DocCommandStore` | **✗ (D)** | `Core/DesignSystem/ProjectPathsPanel.swift:14-15` |
| E11 | core (`Core/Platform`) → docs | `GenerationRegistry.shared.reset()` on session end | **✗ (D)** | `Core/Platform/SessionStore.swift:243` |
| E11b | Shell → docs | `GenerationRegistry.shared.reset()` on project switch/close | legal (Shell names every feature) | `Shell/AppShell.swift:495` |
| E12 | core (`Core/Project`) → docs | `GenerationLibraryStore.shared` + seeders at project scaffold | **✗ (D)** | `Core/Project/ProjectScaffolder.swift:152-154` |
| E12b | Shell → docs | seeders on project open and kit reload | legal (Shell) | `Shell/AppShell.swift:1096-1098` (function `:1083`) |
| E13 | agent-kit (`Core/Contracts/ChatScope`) → docs | enum cases `.visual`, `.docGen` name docs surfaces | D (enum, not behaviour) | `Core/Contracts/ChatScope.swift:13` |
| E14 | automation-kit → docs | none in code. AutoTask "Generate Documentation" runs a CLI prompt, not `/generate-doc`. Concept overlap only. | — | `AutoCodeUpdateService.swift:807-813` (`purposeMode: "document"`) |
| E15 | capture-kit (`Core/Notes`) ↔ docs | `MeetingNoteGenerator.generateDocx` → bundled Python script; a different DOCX path from `/generate-docx`. Both produce "meeting notes .docx". | duplicate path | `Core/Notes/Services/MeetingNoteGenerator.swift:60-75`, `MeetingSummarizationService.swift:94` |
| E16 | extension → docs | `ExportMenu` → `POST /generate-docx` | C | `ExportMenu.tsx:86` |

**Cycles.**
- No kit-level cycle found on the server: nothing in `kb/`, `llm_agent/`, `agents/` imports `export-routes.mjs` (only `server.mjs:11`).
- **Cycle inside `Core`:** `Core/Project/ProjectScaffolder.swift:152` → `Core/Generation/...GenerationLibraryStore`, and `Core/Generation/Services/DocTemplateStore.swift:175` → `Core/Project/ProjectLayout.swift`. Core/Project and Core/Generation depend on each other. This is invisible to the feature gate (both are Core).

**Violations to fix before K1** (E8–E12): direct references that the K0 rule forbids. E9 and E10 also break the "Core is the seam" rule. Fixes: a `Core/Contracts` seam for templates, commands and `sourceFitNotice` (decision 8); a Core hook for session reset. `Core/Contracts/SessionScoped.swift:23-24` explains why Core uses a notification (`accountCredentialsRevoked`, `:25`) so it never names a feature type; the precedent for a registry is `SessionScopedRegistry` (`:33`). Moving `ProjectScaffolder`'s seeding out (`:152-154`) is decision 4.

**Gate result:** `mac/Scripts/feature-boundaries.sh` passes (0 cross-feature, 0 always-compiled references into excludable features), so E8–E12 are legal under the current gate and remain invisible to it. E9 is the one that the stricter K0 rule re-labels: legal today, ✗ under K0.

## 4. Delegated vs owned

Rule (plan): *does it get better on its own when the model/SDK improves?* → delegated (thin adapter); project control → owned.

| Piece | Label | Reason |
|---|---|---|
| `runClaude` call that writes the document (`export-routes.mjs:437`) | Delegated | The writing is model capability; we only send the prompt. |
| `buildDocPrompt` wording (`:207-218`) | Delegated (thin) | Prompt is the adapter to the model; trim as models improve. |
| Meeting-notes JSON prompt (`:336`) + parse (`:340-353`) | **Retire candidate** | Duplicates `/generate-notes` (capture-kit) with a different output shape. One path is enough (decision 12). |
| `packSources` water-fill budget (`:122-202`) | Owned | Prompt-cap budget is project control; the model cannot know our 500 k cap. |
| `validateDocRequest` gate (`:226`) and `buildDocRef` (`:257`) | Owned | Request contract and KB identity. |
| Secret scan before KB ingest (`:36-51`) | Owned | Permission/guardrail. |
| Per-user KB ref prefix `u:<userId>:` (`:52`) | Owned | Tenancy. |
| DOCX builder `buildMeetingDocx` + npm `docx` (`:267`, `:362`) | Owned | Deterministic file format under contract; SDK/model does not improve it. Could instead use the docx skill, but output must stay byte-stable. |
| Source gathering from meetings: `getMeeting` + entities (`GenerationViewModel.swift:203-230`) | Owned | Selection and reading are app control. |
| `applyEdit` revision prompt (`GenerationViewModel.swift:284-378`) | **Retire candidate** | "Revise this document" is what the chat engine (agent-kit) already does with context; the Doc Gen "Use chat" toggle already routes there. Has one UI caller and three tests (§6). |
| `sourceFitNotice` text (`GenerationViewModel.swift:435-470`) | Owned (move to server) | Text derived from the server's omitted/truncated counts; belongs with the contract. |
| Template and command files on disk (`templates/`, `commands/`) and their seeders | Owned | User-editable project data (project control). |
| Kit template content (`.skills/templates/*`) | Owned content | Data that the project reuses; the model does not change it. |
| `DocTemplateStore` / `DocCommandStore` / `DocGenOutputStore` / `GenerationLibraryStore` | Owned | Persistence and migration (legacy app-support JSON). |
| `exportMarkdown` (`LlmIdeAPIClient+Export.swift:173`) | Owned | Local file write under user choice. |
| Phone bridge `MobileGenerationBridge` (`:142-189`) | Owned | Permission (`PhoneAccessSettings` `generationRun`), phone path. |
| Visual source handling (`VisualSourcePanel.swift:56-64`) | Owned UI | Image sources; the server reads text only. |
| SwiftUI views (`Features/Generation/`, 3 271 lines) | Owned UI | Replaced at K3 by Tauri screens. |
| `GenerationTreeSelection` (`Features/Generation/Views/GenerationTreeSelection.swift`) | Owned UI | Selection rules over `LibraryItem`. |
| iOS `GenerateSheet` and `generation_*` wire (`MobileProtocol.swift:133-136`) | Owned UI + wire | Phone surface; wire stays unchanged (decision 13). |

## 5. State and data (feeds K1a)

**Project folder** (per project, `ProjectLayout`, `Core/Project/ProjectLayout.swift:21-22, 43, 51`):
- `templates/<folder>/template.md` plus `templates/README.md` (`Core/Generation/Services/DocTemplateStore.swift:175-245`, `ProjectDocTemplatesSeeder.swift:23-68`). Surface marker in the file header (`TemplateSurface.swift`, `GenerationConformance.swift`).
- `commands/<folder>/command.md` plus `commands/README.md` (`DocCommandStore.swift:101-170`, `ProjectDocCommandsSeeder.swift:21-47`).
- Output: `data/` (`DocGenOutputConfig.swift:54`; `ProjectLayout.dataDir`). Phone saves go to `llm-doc/generated/` (`MobileControlManager.swift:756`).
- Auto-task folder `templates/auto_task/` is skipped by name (`ProjectLayout.swift:61`, `DocTemplateStore.swift:207`; `invariants.md:592`).
- Seed-source comment: `Core/Project/Project.swift:70-71` says doc templates are "seeded on disk under `templates/` by `ProjectDocTemplatesSeeder`", which is the real source.

**Application Support** (`~/Library/Application Support/com.llmide.macapp/`):
- `doc-templates.json` (legacy/global store, `DocTemplateStore.swift:57-63`; corrupt copies `doc-templates.json.corrupt-<ts>` at `:285`). **Still read on launch**: `Shell/LlmIdeMacApp.swift:371` → `DocTemplateStore.bootstrap()` (`:76-80`) → `load()` (`:274-281`), which accepts the current `StoreFile` envelope and falls back to a bare array (`:280-281`). Checked 2026-10-27.
- `doc-gen-output.json` (`DocGenOutputStore.swift:19-28`).
- `generation-library.json` (cache of `/kb/agent/generation-library`, `GenerationLibraryStore.swift:31-34`).

**UserDefaults / @AppStorage keys** (grep of `Features/Generation` and `Core/Generation`):
`DOCGEN_USE_CHAT`, `VISUAL_USE_CHAT` (`GenerationViewModel.swift:480-485` names both), `DOCGEN_SOURCES_VISIBLE`, `DOCGEN_CHAT_VISIBLE`, `DOCGEN_CHAT_PANEL_WIDTH` (`DocGenView.swift:14-25`), `VISUAL_CHAT_VISIBLE`, `VISUAL_CHAT_PANEL_WIDTH` (`VisualView.swift:38-43`), `docgen.expandedSections` (`DocGenSourcePanel.swift:30`), `visual.expandedSections` (`VisualSourcePanel.swift:37`). `GenerationViewModel.swift:425` resets the "Use chat" key via `UserDefaults.standard`.

**Server:** no table of its own. One `sources` row per generated document (`kind='doc'`), per `export-routes.mjs:52, 383-389`; the `sources.kind` CHECK accepts `doc` since `extension/kb/migrations/0005_doc_source_kind.sql`. Chat-session and KB state are not written by this kit.

**Keychain / secrets:** none.

## 6. What K1 would move (proposal, not done)

**Move to Node (business logic, not UI state):**

| Swift today | Lines | Node target (proposed route, additive, behind a new `doc_gen` route group) |
|---|---|---|
| `Core/Generation` models: `DocTemplate`, `DocCommand`, `TemplateSurface`, `DocGenOutputConfig` | 657 | `GET /kb/docs/templates`, `GET /kb/docs/commands` (scan project `templates/` and `commands/`, surface + marker parsing). Routes take a **project id** (decision 3). |
| `DocTemplateStore`, `DocCommandStore`, `DocGenOutputStore` | 578 | `PUT/DELETE /kb/docs/templates/:folder`, `PUT/DELETE /kb/docs/commands/:folder`, output-folder config |
| Seeders `ProjectDoc{Templates,Commands}Seeder` | 196 | `POST /kb/docs/seed` (kit list from `/kb/agent/generation-library`); called lazily on first Doc Gen open (decision 4) |
| `GenerationLibraryStore` (cache + fetch) | 138 | none (the cache is an app detail; keep in Swift) |
| `sourceFitNotice` + revision-count logic | ~40 | server returns `notice` in `/generate-doc` response (additive; bump `SERVER_API_VERSION`) |
| `MobileGenerationBridge` helpers (`relativePath`, `safeFileBase`, `buildOptions`) | ~60 | `GET /kb/docs/options` for the phone (only after sync-kit decision; decision 13 keeps the wire) |

Estimated size: **~1.5 k Swift lines out** (models 657 + stores 578 + seeders 196 + ~100 of ViewModel/bridge; of 2 337 in Core/Generation), **~550 Node lines in** (routes, marker/seed logic, template scan) plus **~400 lines of Node tests**. The `Features/Generation` views (3 271) stay until K3.

**Swift tests that move with the logic** (ported to node tests **before** the Swift test is deleted):
- `DocCommandTests` (7), `DocCommandStoreTests` (6), `DocTemplateRewriteTests` (6), `DocGenOutputConfigTests` (7) → `extension/tests/docs-templates.test.mjs` (≈26).
- `GenerationContractLab` marker assertions (19 `expect` call sites) → same node tests (the lab stays until K4).
- `LlmDocBrowserTests` (10; phone helpers) → follow the bridge decision.
- `AutoTaskTemplateStoreTests:325` (auto_task folder skip) → node template-scan test.
- Stay in Swift: `GenerationViewModelTests` (state machine; 9 of 12 after the `applyEdit` tests go), `GenerationTreeSelectionTests` (11, UI selection), `GenerationMessagesTests` (12, wire types in SharedProtocol, sync-kit).

**Retire instead of port (SDK/model or a duplicate path already does it):**
1. `applyEdit` revision path (`GenerationViewModel.swift:284-378`) → send the document to the chat engine (agent-kit). Delete ~95 Swift lines and its prompt. Retiring it also deletes or rewrites its callers:
   - UI: `Features/Generation/Views/GenerationPromptBar.swift:290` (`vm.applyEdit(api: api)`) → the "Use chat" route replaces it.
   - Tests: `GenerationViewModelTests.swift:127` (`testFailedRevisionPreservesDocument`), `:152` (`testCancelledRevisionRestoresPriorDocument`), `:173` (`testOversizedDocumentRefusesRevisionWithoutSending`); calls at `:133`, `:158`, `:179`. Rewrite as chat-path tests, or delete with the path. The failure-preserves-document invariant should survive in the chat path.
2. Meeting-notes JSON prompt in `/generate-docx` (`export-routes.mjs:336-353`) → call `/generate-notes` (capture-kit) and feed its output to `buildMeetingDocx`. Delete ~20 server lines. ExportMenu keeps its `/generate-docx` call; the route's notes input changes (decision 12).
3. Python meeting-docx path (decision 7 retires it) → the single Node DOCX path. Delete:
   - `Core/Notes/Services/MeetingNoteGenerator.swift:60-75` (`generateDocx`; the Python bridge and its JSON payload),
   - its only caller `Core/Notes/Services/MeetingSummarizationService.swift:94` (Step 2a, the "polished .docx" stage; its doc comment at `:15` describes it),
   - the bundled resources `mac/Sources/LlmIdeMac/Resources/generate_meeting_note.py` and `mac/Sources/LlmIdeMac/Resources/note_template.docx`, and their copy lines `mac/Package.swift:369-370`.
   The `.app/Contents/Resources/` copies are build output, not source. Owned by capture-kit; listed here because it is the same deliverable.

**Keep in Swift until K3:** `Features/Generation/**` views (3 271), selection logic, `exportMarkdown` (local file write).

## 7. Decisions (user-approved 2026-10-27)

These replace the earlier open-question list. Items 1–9 are user decisions. Item 10 is the one question the user did not decide; it is recorded as open with the map's recommendation.

1. **`/generate-docx` (meeting → Word) moves to capture-kit ownership.** Plan and ownership change only; the code moves during capture-kit's K1, not now.
2. **`/generate-doc` becomes gated by `doc_gen`** (only the Mac calls it). Feature-matrix expectations change accordingly (§2e: today's "not server-gated" exception is for `/generate-docx`, which stays always-on for the extension).
3. **Template and command routes take a project id, never a raw path.** The server resolves the project's root itself.
4. **Doc Gen seeds templates and commands lazily on first open**, not in `ProjectScaffolder`. This removes the Core/Project ↔ Core/Generation cycle (E12; `ProjectScaffolder.swift:152-154`).
5. **Legacy `doc-templates.json`: still read** (checked 2026-10-27; §5). K1a adds a migration test with a real old file (both the envelope and the bare-array fallback at `DocTemplateStore.swift:274-281`).
6. **Visual stays inside docs-kit for now.**
7. **The Python meeting-docx path is retired** (§6 item 3).
8. **Add a `Core/Contracts` seam for the direct Core/other-kit → Generation references (E8–E12) before K1.**
9. **Server in-process imports that follow the existing ESLint layering count as allowed edges** (E2–E4).
10. **Open (not user-decided): comment drift.** `Core/Generation/Services/GenerationConformance.swift:22` names `generationViewOwnership`, which no code declares; the check is a section comment in `scripts/conformance-agent-v2.mjs:237`. Recommended: correct the comment when `GenerationConformance` moves to `Core/Editor` (item 11), so it is fixed once.

Additional decisions from the review:

11. **`GenerationConformance` / Mermaid helpers belong to the editor/UI side.** They stay in Swift Core and move out of `Core/Generation` into `Core/Editor` (beside `MermaidConformance.swift`) during the seam work. They are not a Node concern. `ChatContractLab` keeps calling them from the new location.
12. **The `/generate-docx` notes-JSON prompt has no caller besides ExportMenu.** It is retired with the capture-kit move. ExportMenu uses `/generate-notes` output instead.
13. **The iOS `GenerateSheet` wire (SharedProtocol `generation_*` messages) stays unchanged.** When the phone bridge moves, it keeps the same messages and calls the new routes behind them.

### Next: pre-K1 work

In order:

1. **Seam (8) + `GenerationConformance` move (11).** Add the `Core/Contracts` seam for E8–E12; move `GenerationConformance` to `Core/Editor` and repoint `ChatContractLab` (`:90-245`).
2. **Lazy seeding (4).** Move `ProjectScaffolder` seeding (`:152-154`) to first Doc Gen open, behind the seam.
3. **Legacy-file check (5).** Check done (still read). Remaining: the K1a migration test with a real old `doc-templates.json`.
4. **Gate `/generate-doc` (2).** Add the `doc_gen` route group for `/generate-doc` only; keep `/generate-docx` always-on; update the feature-matrix expectations.
5. **Retire the Python path (7).** Delete the §6 item 3 files and call sites.
