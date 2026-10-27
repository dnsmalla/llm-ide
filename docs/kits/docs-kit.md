# docs-kit

Status: **K0 Map**, reviewed 2026-10-27 (review fixes applied; decisions in §7). Pre-K1 steps 1, 2, 4 and 5 are done (§7, §8); step 3 is open.
The map was written before the pre-K1 code changes; §8 records them. Citations are `path:line`, re-checked 2026-10-27 at the pre-K1 close-out.

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
| Route handler `POST /generate-doc` | `extension/routes/doc-gen.mjs` (`handleDocGenRoutes` `:197`; route `:199-261`) | 263 (whole file) | Owned by `doc_gen`: loaded only when the feature is on (`routes/feature-routes.mjs:38-43`). With it off the path answers 404 `feature_disabled`. Gated in `c6e350e0` (decision 2). |
| Route handler `POST /generate-docx` | `extension/server/export-routes.mjs` (`handleExportRoutes` `:128`; `/generate-docx` `:130-213`) | 217 (whole file) | Always on: the Chrome ExportMenu calls it. Also holds `ingestGeneratedDoc` `:35` and `safeTruncate` `:27`, which `doc-gen.mjs` imports (`:9`). |
| Source packing (water-fill budget) | `doc-gen.mjs:13` (`MAX_SOURCE_CONTENT`), `:34` (`MAX_TOTAL_SOURCE_CHARS`, the default `budget`), `:55` (`packSources`) | ~80 | Pure; exported for tests. Moved from `export-routes.mjs` in `c6e350e0`. |
| Prompt assembly | `doc-gen.mjs:140` (`buildDocPrompt`) | ~11 | Template + command + prompt + sources. |
| Accept/reject gate | `doc-gen.mjs:159` (`validateDocRequest`) | ~31 | 400 `VALIDATION_FAILED`. |
| KB ref builder (command hash) | `doc-gen.mjs:190` (`buildDocRef`) | ~5 | Keeps KB rows from clobbering. |
| DOCX builder for meeting notes | `export-routes.mjs:80` (`buildMeetingDocx`), `:175` (`docx.Packer.toBuffer`) | ~47 | Uses npm `docx`; lazy-loaded by `loadDocx` `:11`, which does `import('docx')` at `:12`. |
| KB ingest of output (secret scan first) | `export-routes.mjs:35-68` (`ingestGeneratedDoc`; scan `:42-44`, scoped ref `:51`) | 34 | Skips ingest when `scanForSecrets` hits. |
| Route registration | `extension/server.mjs:11` (import of `handleExportRoutes`), `:282-285` (`ALL_ENDPOINTS`), `:434-435` (`llmFast` bucket), `:863` (`featureHandlers.doc_gen`), `:864` (`handleExportRoutes`) | — | `SERVER_API_VERSION = 80` at `:279`; v80 changelog at `:278`. |
| Feature group `doc_gen` and its comment | `extension/routes/feature-routes.mjs:38-43` (group), `:14-16` (comment: `/generate-docx` stays always on) | 124 (file) | Prefix `/generate-doc` only; loads `routes/doc-gen.mjs`. |
| Templates served to the app | `extension/routes/agent.mjs:386-400` (`GET /kb/agent/generation-library`), `extension/llm_agent/skills/generation-library.mjs` | 207 | Reads the kit's `templates/{doc,vis}` and `commands/`. |
| Kit template files (data) | `.skills/templates/doc/*.md` (6 files), `.skills/templates/vis/*.md` (3 files) | — | Submodule; frontmatter `name`/`description`, body = `##` sections. |
| Kit command files (data) | `.skills/commands/doc/*.md` (4 files: `release-notes`, `explain-code`, `ship-it`, `summarize`), `.skills/commands/vis/*.md` (3 files: `read-chart`, `extract-text`, `describe-image`), `.skills/commands/cli/*.md` (8 files) | — | `commands/README.md` also present. The `cli/` group is not a Doc Gen or Visual menu family. |

**Model calls (providers/).** `/generate-doc` calls `runClaude` from
`extension/providers/runtime.mjs` (imported `doc-gen.mjs:7`, call `:232`, `maxTokens: 2048`).
`/generate-docx` calls it from `export-routes.mjs` (imported `:1`, call `:151`, `maxTokens: 2048`).
Both routes sit in the `llmFast` rate-limit bucket (`server.mjs:434-435`).
Prompts: the meeting-notes JSON prompt (`export-routes.mjs:149`, returns
`{title,decisions,todos,agenda,minutes,qa}`, parsed at `:162`), and the document prompt from
`buildDocPrompt` (`doc-gen.mjs:140`). No `agents/` module is used.

**Other server imports.** In `export-routes.mjs`: `core/utils.mjs` (`:2`),
`kb/db.mjs` (`:3`, `kb.ingestSources` at `:53`), `guardrails/scan.mjs` (`:4`).
No new SQLite table; output is one `sources` row with `kind='doc'`. The scoped
ref is `u:<userId>:<ref>` (`export-routes.mjs:51`); `ref` for `/generate-doc` is
`buildDocRef` (`doc-gen.mjs:190`), and for `/generate-docx` it is
`docx:<meetingId | title:date>` (`export-routes.mjs:198`), scoped the same way.

### 2b. Mac app (Swift)

| Layer | Piece | Path | Lines |
|---|---|---|---|
| Features | Doc Gen views | `Features/Generation/DocGen/Views/` (4 files: `DocGenView`, `DocGenSourcePanel`, `DocGenPromptBar`, `DocGenEditorPanel`) | 320 |
| Features | Visual views | `Features/Generation/Visual/Views/` (4 files: `VisualView` 360, `VisualCenterPanel` 143, `VisualSourcePanel` 194, `VisualPromptBar` 35) | 732 |
| Features | Shared generation views | `Features/Generation/Views/` (9 files; largest `GenerationEditorPanel` 640, `GenerationTemplateSection` 417, `GenerationPromptBar` 309, `GenerationSourceTree` 296, `DocTemplateManagerSheet` 223) | 2 219 |
| Features | **Total** | `Features/Generation/` (16 files) | **3 271** |
| Core | ViewModel + registry | `Core/Generation/Services/GenerationViewModel.swift` (579), `GenerationRegistry.swift` (74) | 653 |
| Core | Stores | `DocTemplateStore.swift` (307), `DocCommandStore.swift` (179), `DocGenOutputStore.swift` (92), `GenerationLibraryStore.swift` (138) | 716 |
| Core | Seeders | `ProjectDocTemplatesSeeder.swift` (106), `ProjectDocCommandsSeeder.swift` (88) | 194 |
| Core | Models | `DocTemplate.swift` (318), `DocCommand.swift` (168), `TemplateSurface.swift` (115), `DocGenOutputConfig.swift` (56) | 657 |
| Core | Mermaid/render helpers (not docs-only) | `Core/Editor/GenerationConformance.swift` (121; moved from `Core/Generation` in pre-K1 step 2, `0e7a985d`) | 121 |
| Core | Provider + refresh (pre-K1 seam) | `Core/Generation/Services/DocGenProvider.swift` (74; the one `GenerationProviding` conformer), `GenerationFilesRefresh.swift` (26; the kit-arrival and project-open seed decision) | 100 |
| Core | **Total** | `Core/Generation/` (14 files) | **2 320** |
| Core | HTTP client | `Core/Networking/API/LlmIdeAPIClient+Export.swift` (303 file; `GenerateDocRequest` `:53`, `GenerateDocResponse` `:70`, `GeneratedDoc` `:88`, `generateDoc` `:115`, `generateDocFailure` `:168` (names the `feature_disabled` 404), `exportMarkdown` `:186`) | lines 51–212 are docs-only |
| Core | Library catalogue client | `Core/Networking/API/LlmIdeAPIClient+AgentMeta.swift:107` (`generationLibrary()` → `GET /kb/agent/generation-library`) | — |
| Features | Phone bridge | `Features/MobileControl/Services/MobileGenerationBridge.swift` (225) | 225 |
| Core | Wrong-looking name, different path | `Core/Notes/Services/MeetingNoteGenerator.swift:60` `generateDocx` runs a bundled Python script, **not** `/generate-docx` (see §3) | — |
| Shell | Wiring | `Shell/FeatureCatalog.swift:206-221` (`docGenPane`, `visualPane`), `:629-637` (`provideGenerationStores`, `wireGenerationBridge`); `Shell/AppShell.swift:17-19` (env objects), `:500` (`GenerationProviderRegistry.shared.provider?.resetForProjectChange()` on project switch/close), `:753-762` (`.visual`/`.docGen` cases gated by `registry.isEnabled(.docGen)`), `:518` (`.generationLibraryChanged` observer), `:1091` (`seedAndReloadGenerationFiles`, which calls `GenerationFilesRefresh.run` at `:1093`); `Shell/LlmIdeMacApp.swift:99-101, 181-186, 269, 371-373` (`bootstrap()` at launch), `:378` | — |
| Contracts | Section enum | `Core/Contracts/ShellSection.swift:22` (`visual`, `docGen`), `:41-42` and `:61-62` (titles/icons), `:78`, `:95-96` | — (not re-checked at close-out) |
| Contracts | Chat seams used | `Core/Contracts/ChatPanelProviding.swift`, `Core/Contracts/ChatOutputProviding.swift` (used by `GenerationSaveChatOutputRow.swift:43`) | — |
| Feature key | Feature enum | `Core/FeatureToggles/AppFeature.swift:9` (`docGen = "doc_gen"`), `:22` (title), `:33` (requires `fileExplorer`), `:45` (icon), `:64` (excludable list), `:98` (`focusedAI` preset) | — |
| Settings | Help only | `Features/Settings/Views/HelpGuideView.swift:21-24, 93, 326-330` (no Settings card of its own) | — |

The `Core/Generation` side has **no SwiftUI views** but three `NSAlert` calls
(`GenerationViewModel.swift:527`, `:572`) and `GenerationViewModel.save` /
`saveChatOutput` (`:502`, `:555`) present UI from Core.

`Core/Editor/GenerationConformance.swift` (moved from `Core/Generation`) is **not docs-only**: `mac/Sources/ChatContractLab/main.swift:90-245`
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
| Inventory | `schema/http/INVENTORY.md:31-32`, `:92-93` | `/generate-doc` consumer: only `LlmIdeAPIClient+Export.swift` (route at `routes/doc-gen.mjs:199`, gate `doc_gen`); `/generate-docx`: `ExportMenu.tsx`, `App.tsx` (route at `server/export-routes.mjs:130`, always on) |
| TS types | `extension/src/lib/api-types.ts:840` (`Source`), `:3624-3682` (request/response types), `:6252-6269` (route map) | — |
| Live contract (extension) | `extension/tests/http-contract-live.test.mjs:103` (DOCX fixtures are the `200` for `POST /generate-docx`) | — |
| Schema prose (stale, not edited here) | `schema/http/notes-generation.schema.json:2` (description) still says the group "is not feature-gated" and lists `/generate-doc` on the core set | Contradicts decision 2 / `c6e350e0`. Flagged for the schema owner; `make contract-gates` passes regardless. |
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
- **Server**: gated for `/generate-doc` (decision 2, `c6e350e0`). It is a
  `doc_gen` route group: `extension/routes/feature-routes.mjs:38-43` (prefix
  `/generate-doc`, loads `routes/doc-gen.mjs`), dispatched at `server.mjs:863`
  (`featureHandlers.doc_gen`). With `doc_gen` off it answers 404
  `{error:'feature_disabled', feature:'doc_gen'}` and `/health` ENDPOINTS omits
  it. `/generate-docx` stays always on: `feature-routes.mjs:14-16` (comment),
  `ExportMenu.tsx:86` and `App.tsx:59` (REQUIRED_ENDPOINTS). `extension/CLAUDE.md:30-31`
  states the single-owner rule; `/generate-docx` is the documented exception.
  The Mac's `GenerationProviding` path is the only caller of `/generate-doc`.
- **Feature-matrix row**, run on 2026-10-27:
  - Server (`node scripts/feature-matrix.mjs --key doc_gen`): **ok**, live
    contract in assert mode **411 pass / 0 fail**.
  - Mac (`--key doc_gen --mac-only`): **ok, 5 s**. This was an incremental
    build in the existing scratch path, so it is not a cold-build measurement.
  - Plan wording: `feature-matrix.test.mjs:80-81` asserts `/generate-doc` is owned by
    `doc_gen` and `/generate-docx` has no feature group.
- **Closure**: `file_explorer` off ⇒ `doc_gen` off (`AppFeature.swift:33`,
  `scripts/feature-matrix.mjs:69`, `docs/how-to/run-the-feature-matrix.md:12`).

### 2f. Tests and gates

| Side | File | Count (method) |
|---|---|---|
| Server | `extension/tests/generate-doc-prompt.test.mjs` (317 lines) | 29 `test(` (grep `^test(`, re-counted 2026-10-27): prompt shape, gate matrix, `buildDocRef`, `packSources` budget, `/generate-doc` 400 paths |
| Server | `extension/tests/generation-library.test.mjs` (171 lines) | 10 `test(`: kit template/command parsing, surface split (`commands/doc/`, `commands/vis/`), pre-split and `visual/` layouts. Coupled to the layout comment at `extension/llm-sources/registry.mjs:254-257` (`:256` names `llm_agent/skills/generation-library.mjs`), which must change with it. |
| Server | `extension/tests/feature-routes.test.mjs:139-141`, `extension/tests/server-features-health.test.mjs:91`, `extension/tests/feature-matrix.test.mjs:35-93`, `extension/tests/http-contract-live.test.mjs:103` | cross-cutting asserts (4 files, 1 to 4 refs each) |
| Mac | `mac/Tests/LlmIdeMacTests/GenerationViewModelTests.swift` (189) | 12 `func test` (XCTest); 3 of them drive `applyEdit` (`:127`, `:152`, `:173`; calls at `:133`, `:158`, `:179`) |
| Mac | `DocCommandTests.swift` (62) | 7 XCTest |
| Mac | `DocCommandStoreTests.swift` (171) | 6 XCTest |
| Mac | `DocGenOutputConfigTests.swift` (89) | 7 XCTest |
| Mac | `DocGenLazySeedingTests.swift` | 10 XCTest (7 at `e1525074`; +3 kit-arrival cases from `8ee96783`: kit arrives while Doc Gen or Visual is open → templates appear; while elsewhere → reload only) |
| Mac | `GenerateDocFailureTests.swift` (new in `8ee96783`) | 4 XCTest: `feature_disabled`/`doc_gen` names the feature; other 404s do not; structured and unparseable bodies keep their message |
| Mac | `DocTemplateRewriteTests.swift` (80) | 6 swift-testing (`@Test`) |
| Mac | `GenerationTreeSelectionTests.swift` (145) | 11 XCTest; excluded with `doc_gen` |
| Mac | `LlmDocBrowserTests.swift` (84) | 10 XCTest; tests `MobileGenerationBridge` helpers (`:56-61`) |
| Mac | `AutoTaskTemplateStoreTests.swift:325` | 1 of 26 touches `DocTemplateStore` |
| SharedProtocol | `ios_app/SharedProtocol/Tests/SharedProtocolTests/GenerationMessagesTests.swift` (124) | 12 XCTest (phone wire) |
| Gate | `mac/Sources/GenerationContractLab/main.swift` (126 lines) via `make generation-gates` | 19 `expect(` call sites on the template **surface marker** (the 20th grep hit is the `func expect` definition at `:27`); `make generation-gates` → "all assertions passed" (2026-10-27) |
| Gate | `mac/Sources/ChatContractLab/main.swift:90-245` | 16 calls into `GenerationConformance` (Mermaid helpers); see §2b |
| Gate | `scripts/conformance-agent-v2.mjs:237-275` ("generation ownership") | source check: Doc Gen / Visual must resolve `GenerationViewModel` from `GenerationRegistry`. Note: `GenerationConformance.swift:22` names it `generationViewOwnership`, the code has no such identifier (comment drift). |
| Gate | `mac/Scripts/feature-boundaries.sh` (run 2026-10-27, after `8ee96783`) | 0 cross-feature, 0 always-compiled violations, 0 Core→feature edges |
| Lint | `extension/server/export-routes.mjs`, `extension/routes/doc-gen.mjs`, `extension/routes/feature-routes.mjs` | eslint `--max-warnings 0`: not re-run at close-out |

Tests on the **generation path itself** (a live `/generate-doc` with a real model)
do not exist; all server tests stop before `runClaude`.

## 3. Cross-kit edges

Legend: **C** = through `Core/Contracts` or an HTTP route; **D** = direct type/module reference; **✗** = violates the K0 rule (Swift edges go through Core contracts or HTTP). Decision 9 (§7) makes server in-process imports that follow the ESLint layering **allowed**, so E2–E4 are not ✗.

| # | From → To | Mechanism | Ok? | Evidence |
|---|---|---|---|---|
| E1 | docs → core (Node) | import `core/utils.mjs` | ok | `doc-gen.mjs:8`, `export-routes.mjs:2` |
| E2 | docs → agent-kit (providers) | `runClaude`, `resolveLanguage` in-process | ok (server layering, decision 9) | `doc-gen.mjs:7`, `:232`; `export-routes.mjs:1`, `:143`, `:151` |
| E3 | docs → knowledge (kb) | `kb.ingestSources` in-process | ok (server layering, decision 9) | `export-routes.mjs:3`, `:53`; `doc-gen.mjs` reaches it through `ingestGeneratedDoc` (`:9`, `:241`) |
| E4 | docs → work-kit guardrails | `scanForSecrets` in-process | ok (server layering, decision 9) | `export-routes.mjs:4`, `:44` |
| E5 | docs → agent-kit templates | `GET /kb/agent/generation-library` (Mac) → `llm_agent/skills/generation-library.mjs` | C | `LlmIdeAPIClient+AgentMeta.swift:107`, `routes/agent.mjs:396` |
| E6 | docs (Mac) → core HTTP | `generateDoc`, `exportMarkdown`, `getMeeting` | C | `GenerationViewModel.swift:213, 247, 327, 506, 559`; `MobileGenerationBridge.swift:172, 184`; `LlmIdeAPIClient+KB.swift:109` |
| E7 | docs (Mac) → chat seams | `ChatPanelRegistry`, `ChatOutputRegistry` | C | `GenerationSaveChatOutputRow.swift:43`, `ChatOutputProviding.swift` |
| E8 | docs (Mac) → knowledge backing | `LibraryItem` (data type) named directly; the store is reached through the `LibrarySourceFeed` seam (`c62c9e6a`) | **open (D, data type)**: store edge resolved; whether a model type may be named is open question 14 | `Features/Generation/Views/GenerationTreeSelection.swift:14, 43`; `GenerationSourceTree.swift:24, 46, 57` |
| E9 | MobileControl (`Features/MobileControl`) → docs | the bridge reaches Doc Gen only through `GenerationProviding` (`generation.sourceFitNotice` `:195`; `api.generateDoc` `:172`) | **resolved** (seam, `c62c9e6a`) | `MobileGenerationBridge.swift:172, 195` |
| E10 | ui-kit (`Core/DesignSystem`) → docs | reload through `GenerationProviderRegistry` (`ProjectPathsPanel.swift:184`) | **resolved** (seam, `c62c9e6a`) | `Core/DesignSystem/ProjectPathsPanel.swift:7, 184` |
| E11 | core (`Core/Platform`) → docs | sign-out reset through `GenerationProviderRegistry` (`resetForSignOut`) | **resolved** (seam, `c62c9e6a`) | `Core/Platform/SessionStore.swift:243` |
| E11b | Shell → docs | `resetForProjectChange()` through the registry on project switch/close | legal (Shell names every feature) | `Shell/AppShell.swift:500` |
| E12 | core (`Core/Project`) → docs | was `GenerationLibraryStore.shared` + seeders at project scaffold | **resolved** (lazy seeding, `e1525074`); scaffold now seeds ingest templates only | `Core/Project/ProjectScaffolder.swift:148` (`IngestTemplateSeeder`) |
| E12b | Shell → docs | seeders on project open, first Doc Gen/Visual open, and kit reload | legal (Shell) | `Shell/AppShell.swift:1093` (`GenerationFilesRefresh.run`, inside `seedAndReloadGenerationFiles` `:1091`; observer `:518`) |
| E13 | agent-kit (`Core/Contracts/ChatScope`) → docs | enum cases `.visual`, `.docGen` name docs surfaces | D (enum, not behaviour) | `Core/Contracts/ChatScope.swift:13` |
| E14 | automation-kit → docs | none in code. AutoTask "Generate Documentation" runs a CLI prompt, not `/generate-doc`. Concept overlap only. | — | `AutoCodeUpdateService.swift:807-813` (`purposeMode: "document"`) |
| E15 | capture-kit (`Core/Notes`) ↔ docs | was `MeetingNoteGenerator.generateDocx` → bundled Python script (a second DOCX path) | **resolved** (retired in `53804a47`, decision 7): `MeetingNoteGenerator.swift`, the Python script and `note_template.docx` are deleted; the Step 2a caller in `MeetingSummarizationService` is gone | — |
| E16 | extension → docs | `ExportMenu` → `POST /generate-docx` (always on) | C | `ExportMenu.tsx:86` |

**Cycles.**
- No kit-level cycle found on the server: nothing in `kb/`, `llm_agent/`, `agents/` imports `export-routes.mjs` (only `server.mjs:11` and `routes/doc-gen.mjs:9`, which sits behind the `doc_gen` group).
- **Cycle inside `Core` (resolved, pre-K1 step 3):** the `ProjectScaffolder` → `GenerationLibraryStore` edge is gone; Core/Project no longer names any Doc Gen type. The reverse edge (`DocTemplateStore` → `ProjectLayout`) is an ordinary dependency and stays.

**Original finding:** `Core/Project/ProjectScaffolder.swift:152` → `Core/Generation/...GenerationLibraryStore`, and `Core/Generation/Services/DocTemplateStore.swift:175` → `Core/Project/ProjectLayout.swift`. Core/Project and Core/Generation depend on each other. This is invisible to the feature gate (both are Core).

**Resolved before K1 (pre-K1 steps 1, 2, 4 and 5, see §8).** E9 through E12 and the Core/Project ↔ Core/Generation cycle are fixed; E8 keeps only its data-type edge (open question 14). The rows above keep their original evidence for the record.

**Violations to fix before K1** (E8–E12; all but E8's data-type edge are now fixed): direct references that the K0 rule forbids. E9 and E10 also break the "Core is the seam" rule. Fixes: a `Core/Contracts` seam for templates, commands and `sourceFitNotice` (decision 8); a Core hook for session reset. `Core/Contracts/SessionScoped.swift:23-24` explains why Core uses a notification (`accountCredentialsRevoked`, `:25`) so it never names a feature type; the precedent for a registry is `SessionScopedRegistry` (`:33`). Moving `ProjectScaffolder`'s seeding out (`:152-154`) is decision 4.

**Gate result:** `mac/Scripts/feature-boundaries.sh` passes (0 cross-feature, 0 always-compiled references into excludable features), so E8–E12 are legal under the current gate and remain invisible to it. E9 is the one that the stricter K0 rule re-labels: legal today, ✗ under K0.

## 4. Delegated vs owned

Rule (plan): *does it get better on its own when the model/SDK improves?* → delegated (thin adapter); project control → owned.

| Piece | Label | Reason |
|---|---|---|
| `runClaude` call that writes the document (`doc-gen.mjs:232`) | Delegated | The writing is model capability; we only send the prompt. |
| `buildDocPrompt` wording (`doc-gen.mjs:140`) | Delegated (thin) | Prompt is the adapter to the model; trim as models improve. |
| Meeting-notes JSON prompt (`export-routes.mjs:149`) + parse (`:162`) | **Retire candidate** (still in code: `/generate-docx` keeps it until the capture-kit move) | Duplicates `/generate-notes` (capture-kit) with a different output shape. One path is enough (decision 12). |
| `packSources` water-fill budget (`doc-gen.mjs:55`) | Owned | Prompt-cap budget is project control; the model cannot know our 500 k cap. |
| `validateDocRequest` gate (`doc-gen.mjs:159`) and `buildDocRef` (`doc-gen.mjs:190`) | Owned | Request contract and KB identity. |
| Secret scan before KB ingest (`export-routes.mjs:42-44`) | Owned | Permission/guardrail. |
| Per-user KB ref prefix `u:<userId>:` (`export-routes.mjs:51`) | Owned | Tenancy. |
| DOCX builder `buildMeetingDocx` + npm `docx` (`export-routes.mjs:80`, `:175`) | Owned | Deterministic file format under contract; SDK/model does not improve it. Could instead use the docx skill, but output must stay byte-stable. |
| Source gathering from meetings: `getMeeting` + entities (`GenerationViewModel.swift:203-230`) | Owned | Selection and reading are app control. |
| `applyEdit` revision prompt (`GenerationViewModel.swift:284-378`) | **Retire candidate** | "Revise this document" is what the chat engine (agent-kit) already does with context; the Doc Gen "Use chat" toggle already routes there. Has one UI caller and three tests (§6). |
| `sourceFitNotice` text (`GenerationViewModel.swift:435-470`) | Owned (move to server) | Text derived from the server's omitted/truncated counts; belongs with the contract. |
| Template and command files on disk (`templates/`, `commands/`) and their seeders | Owned | User-editable project data (project control). |
| Kit template content (`.skills/templates/*`) | Owned content | Data that the project reuses; the model does not change it. |
| `DocTemplateStore` / `DocCommandStore` / `DocGenOutputStore` / `GenerationLibraryStore` | Owned | Persistence and migration (legacy app-support JSON). |
| `exportMarkdown` (`LlmIdeAPIClient+Export.swift:186`) | Owned | Local file write under user choice. |
| Phone bridge `MobileGenerationBridge` (`:142-189`) | Owned | Permission (`PhoneAccessSettings` `generationRun`), phone path. |
| Visual source handling (`VisualSourcePanel.swift:56-64`) | Owned UI | Image sources; the server reads text only. |
| SwiftUI views (`Features/Generation/`, 3 271 lines) | Owned UI | Replaced at K3 by Tauri screens. |
| `GenerationTreeSelection` (`Features/Generation/Views/GenerationTreeSelection.swift`) | Owned UI | Selection rules over `LibraryItem`. |
| iOS `GenerateSheet` and `generation_*` wire (`MobileProtocol.swift:133-136`) | Owned UI + wire | Phone surface; wire stays unchanged (decision 13). |

## 5. State and data (feeds K1a)

**Project folder** (per project, `ProjectLayout`, `Core/Project/ProjectLayout.swift:21-22, 43, 51`):
- `templates/<folder>/template.md` plus `templates/README.md` (`Core/Generation/Services/DocTemplateStore.swift:175-245`, `ProjectDocTemplatesSeeder.swift:24-71`). Surface marker in the file header (`TemplateSurface.swift`, `GenerationConformance.swift`).
- `commands/<folder>/command.md` plus `commands/README.md` (`DocCommandStore.swift:101-170`, `ProjectDocCommandsSeeder.swift:19-53`).
- Output: `data/` (`DocGenOutputConfig.swift:54`; `ProjectLayout.dataDir`). Phone saves go to `llm-doc/generated/` (`MobileControlManager.swift:756`).
- Auto-task folder `templates/auto_task/` is skipped by name (`ProjectLayout.swift:61`, `DocTemplateStore.swift:207`; `invariants.md:592`).
- Seed-source comment: `Core/Project/Project.swift:70-71` says doc templates are "seeded on disk under `templates/` by `ProjectDocTemplatesSeeder`", which is the real source.

**Application Support** (`~/Library/Application Support/com.llmide.macapp/`):
- `doc-templates.json` (legacy/global store, `DocTemplateStore.swift:57-63`; corrupt copies `doc-templates.json.corrupt-<ts>` at `:285`). **Still read on launch**: `Shell/LlmIdeMacApp.swift:371` → `DocTemplateStore.bootstrap()` (`:76-80`) → `load()` (`:274-281`), which accepts the current `StoreFile` envelope and falls back to a bare array (`:280-281`). Checked 2026-10-27.
- `doc-gen-output.json` (`DocGenOutputStore.swift:19-28`).
- `generation-library.json` (cache of `/kb/agent/generation-library`, `GenerationLibraryStore.swift:31-34`).

**UserDefaults / @AppStorage keys** (grep of `Features/Generation` and `Core/Generation`):
`DOCGEN_USE_CHAT`, `VISUAL_USE_CHAT` (`GenerationViewModel.swift:480-485` names both), `DOCGEN_SOURCES_VISIBLE`, `DOCGEN_CHAT_VISIBLE`, `DOCGEN_CHAT_PANEL_WIDTH` (`DocGenView.swift:14-25`), `VISUAL_CHAT_VISIBLE`, `VISUAL_CHAT_PANEL_WIDTH` (`VisualView.swift:38-43`), `docgen.expandedSections` (`DocGenSourcePanel.swift:30`), `visual.expandedSections` (`VisualSourcePanel.swift:37`). `GenerationViewModel.swift:425` resets the "Use chat" key via `UserDefaults.standard`.

**Server:** no table of its own. One `sources` row per generated document (`kind='doc'`), per `export-routes.mjs:51` (scoped ref) and `routes/doc-gen.mjs:241` (`/generate-doc` ingest); the `sources.kind` CHECK accepts `doc` since `extension/kb/migrations/0005_doc_source_kind.sql`. Chat-session and KB state are not written by this kit.

**Keychain / secrets:** none.

## 6. What K1 would move (proposal, not done)

**Move to Node (business logic, not UI state):**

| Swift today | Lines | Node target (proposed route, additive, behind a new `doc_gen` route group) |
|---|---|---|
| `Core/Generation` models: `DocTemplate`, `DocCommand`, `TemplateSurface`, `DocGenOutputConfig` | 657 | `GET /kb/docs/templates`, `GET /kb/docs/commands` (scan project `templates/` and `commands/`, surface + marker parsing). Routes take a **project id** (decision 3). |
| `DocTemplateStore`, `DocCommandStore`, `DocGenOutputStore` | 578 | `PUT/DELETE /kb/docs/templates/:folder`, `PUT/DELETE /kb/docs/commands/:folder`, output-folder config |
| Seeders `ProjectDoc{Templates,Commands}Seeder` | 194 | `POST /kb/docs/seed` (kit list from `/kb/agent/generation-library`); called lazily on first Doc Gen open (decision 4) |
| `GenerationLibraryStore` (cache + fetch) | 138 | none (the cache is an app detail; keep in Swift) |
| `sourceFitNotice` + revision-count logic | ~40 | server returns `notice` in `/generate-doc` response (additive; bump `SERVER_API_VERSION`) |
| `MobileGenerationBridge` helpers (`relativePath`, `safeFileBase`, `buildOptions`) | ~60 | `GET /kb/docs/options` for the phone (only after sync-kit decision; decision 13 keeps the wire) |

Estimated size: **~1.5 k Swift lines out** (models 657 + stores 578 + seeders 194 + ~100 of ViewModel/bridge; of 2 320 in Core/Generation), **~550 Node lines in** (routes, marker/seed logic, template scan) plus **~400 lines of Node tests**. The `Features/Generation` views (3 271) stay until K3.

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
3. **Done (`53804a47`, decision 7).** Python meeting-docx path → the single Node DOCX path. Deleted:
   - `Core/Notes/Services/MeetingNoteGenerator.swift` (was `:60-75` `generateDocx`; the file is deleted),
   - its only caller, the Step 2a "polished .docx" stage in `MeetingSummarizationService.swift` (removed),
   - the bundled resources `mac/Sources/LlmIdeMac/Resources/generate_meeting_note.py` and `mac/Sources/LlmIdeMac/Resources/note_template.docx` (deleted), and their copy lines in `mac/Package.swift` (removed).
   The `.app/Contents/Resources/` copies are build output, not source. Owned by capture-kit; listed here because it is the same deliverable.

**Keep in Swift until K3:** `Features/Generation/**` views (3 271), selection logic, `exportMarkdown` (local file write).

## 7. Decisions (user-approved 2026-10-27)

These replace the earlier open-question list. Items 1–9 are user decisions. Item 10 is the one question the user did not decide; it is recorded as open with the map's recommendation.

1. **`/generate-docx` (meeting → Word) moves to capture-kit ownership.** Plan and ownership change only; the code moves during capture-kit's K1, not now.
2. **`/generate-doc` becomes gated by `doc_gen`** (only the Mac calls it). Feature-matrix expectations change accordingly (§2e: today's "not server-gated" exception is for `/generate-docx`, which stays always-on for the extension). **Done (`c6e350e0`):** `routes/doc-gen.mjs` is a `doc_gen` route group; see §2e.
3. **Template and command routes take a project id, never a raw path.** The server resolves the project's root itself.
4. **Doc Gen seeds templates and commands lazily on first open**, not in `ProjectScaffolder`. This removes the Core/Project ↔ Core/Generation cycle (E12; was `ProjectScaffolder.swift:152-154`). Done, pre-K1 step 2 (`e1525074`); see §8 for the deviation from the "missing or empty" gate.
5. **Legacy `doc-templates.json`: still read** (checked 2026-10-27; §5). K1a adds a migration test with a real old file (both the envelope and the bare-array fallback at `DocTemplateStore.swift:274-281`).
6. **Visual stays inside docs-kit for now.**
7. **The Python meeting-docx path is retired** (§6 item 3). **Done (`53804a47`).**
8. **Add a `Core/Contracts` seam for the direct Core/other-kit → Generation references (E8–E12) before K1.** Done, pre-K1 step 1 (`c62c9e6a`): `GenerationProviding` + `GenerationProviderRegistry` (`Core/Contracts/GenerationProviding.swift`), `LibrarySourceFeed` (`Core/Contracts/LibrarySourceFeed.swift`).
9. **Server in-process imports that follow the existing ESLint layering count as allowed edges** (E2–E4).
10. **Open (not user-decided): comment drift.** `Core/Generation/Services/GenerationConformance.swift:22` names `generationViewOwnership`, which no code declares; the check is a section comment in `scripts/conformance-agent-v2.mjs:237`. Recommended: correct the comment when `GenerationConformance` moves to `Core/Editor` (item 11), so it is fixed once. **Resolved** in pre-K1 step 2 (`0e7a985d`): the comment now names the "generation ownership" section.

14. **Open (not user-decided): the K0 rule for model types.** May other kits name docs-kit *data/model* types (`LibraryItem`, `LlmIdeAPIClient.GeneratedDoc`), or only seams? Recommendation: data types allowed; stores and services reached only via seams (`Core/Contracts`). Raised by §8's seam note and by E8 and E9.

Additional decisions from the review:

11. **`GenerationConformance` / Mermaid helpers belong to the editor/UI side.** They stay in Swift Core and move out of `Core/Generation` into `Core/Editor` (beside `MermaidConformance.swift`) during the seam work. They are not a Node concern. `ChatContractLab` keeps calling them from the new location. Done, pre-K1 step 2 (`0e7a985d`).
12. **The `/generate-docx` notes-JSON prompt has no caller besides ExportMenu.** It is retired with the capture-kit move. ExportMenu uses `/generate-notes` output instead.
13. **The iOS `GenerateSheet` wire (SharedProtocol `generation_*` messages) stays unchanged.** When the phone bridge moves, it keeps the same messages and calls the new routes behind them.

### Next: pre-K1 work

In order:

1. [x] **Seam (8) + `GenerationConformance` move (11).** Done: `c62c9e6a` (seam), `0e7a985d` (move).
2. [x] **Lazy seeding (4).** Done: `e1525074`. Ingest templates stay eager (`IngestTemplateSeeder`); Doc Gen seeds on first open. Kit-arrival reseed while open: `8ee96783`.
3. **Legacy-file check (5).** Check done (still read). Remaining: the K1a migration test with a real old `doc-templates.json`. Not started.
4. [x] **Gate `/generate-doc` (2).** Done: `c6e350e0` (`routes/doc-gen.mjs` as a `doc_gen` group; `/generate-docx` stays always-on). Contract fixtures and changelog for API v80: `ad9664b2`.
5. [x] **Retire the Python path (7).** Done: `53804a47`.

## 8. Pre-K1 work: what was done (2026-10-27)

Steps 1, 2, 4 and 5 of "Next: pre-K1 work" are done (step 3 is not started). The sections below record each step. Gates at the end of the work: `bash mac/Scripts/feature-boundaries.sh` exit 0; `make build-mac-min`, `make build-mac-lite`, `make chat-gates`, `make generation-gates` all pass; full `LLMIDE_KEYCHAIN_BACKEND=memory swift test`: 2352 tests, 0 failures, 1 skipped.

**Seam (decision 8), `c62c9e6a`.**
- `Core/Contracts/GenerationProviding.swift`: protocol `GenerationProviding` (sign-out reset, project-change reset, project file reload, first-open seed, phone template/command lookup, fit notice) with value types `GenerationTemplateRef` and `GenerationCommandRef`, plus `GenerationProviderRegistry` (`install`/`uninstall`, `provider` optional).
- `Core/Generation/Services/DocGenProvider.swift`: the one conformer. Installed by `FeatureCatalog.provideGenerationStores` at app init. Unlike the phone bridge wiring, this is not behind `FEATURE_DOCGEN`, because Core/Generation is always compiled.
- `Core/Contracts/LibrarySourceFeed.swift`: an environment value that lets Doc Gen's source tree read Library items without naming `LibraryItemStore`. AppShell injects it over the live store. Reading inside a view body keeps `@Observable` tracking.
- Edges: E8 (source tree → `LibraryItemStore`) → `LibrarySourceFeed`. E9 (phone bridge → stores, `sourceFitNotice`) → registry. E10 (`ProjectPathsPanel` → stores) → registry reload. E11 (`SessionStore` → `GenerationRegistry`) → registry `resetForSignOut`. E11b (AppShell) → registry `resetForProjectChange`.
- Note: the source tree still names the `LibraryItem` model type, and the phone bridge still names `LlmIdeAPIClient.GeneratedDoc` in the seam signature. Both are data types, not backing stores. Say so if K0 is meant to forbid model types too.

**GenerationConformance move (decision 11), `0e7a985d`.** `Core/Generation/Services/GenerationConformance.swift` → `Core/Editor/GenerationConformance.swift` (`git mv`, public API unchanged). Comment drift at the old `:22` fixed to point at the "generation ownership" section of `scripts/conformance-agent-v2.mjs`.

**Lazy seeding (decision 4), `e1525074`.**
- `ProjectScaffolder` seeds only the ingest templates, through `IngestTemplateSeeder` (`Core/Notes/Services/IngestTemplateSeeder.swift`). Core/Project no longer names any Doc Gen type. E12 is gone.
- The ingest templates stay eager because `IngestTemplateRenderer` reads `templates/meeting-note` and `templates/email-note` from disk for auto-generated notes. Moving them lazily would have broken meeting and email note rendering for projects where Doc Gen was never opened.
- Doc Gen and Visual seed the kit's templates, commands and README on first open of either section (`AppShell` `.onChange(of: shell.section)`), and before the phone lists or runs a template (`MobileGenerationBridge`), through `GenerationProviding.seedProjectFiles`.
- Deviation from the brief: seeding is per-file `writeIfAbsent`, not gated on "folders missing or empty". Gating on empty would stop kit seeds added later from reaching existing projects, which is the top-up behaviour the kit-arrival observer exists for. Trade-off: a user who deletes one kit template gets it back on the next Doc Gen open. Say if you want the gate instead.
- `ProjectDocTemplatesSeeder` no longer writes the ingest files (they moved to `IngestTemplateSeeder`). `DocGenProvider.seedProjectFiles(at:templateKit:commandKit:)` runs the ingest seeder, the template seeder and the command seeder in that order.

**Tests added.** `GenerationProviderRegistryTests` (7 cases, including install, uninstall and replace, plus an empty `LibrarySourceFeed`). `DocGenLazySeedingTests` (7 cases at `e1525074`: a new project gets no Doc Gen files; the ingest files exist; first open seeds exactly the expected file set; the kit folders match `projectMarkdown`; a second open rewrites nothing, checked by mtime; a user-edited Doc Gen template and a user-edited ingest template both survive).

**Kit arrives while open (`8ee96783`).** The `.generationLibraryChanged` observer already re-ran the seed with the section read at call time, but the logic was inline in `AppShell` and untested. It is now `GenerationFilesRefresh.run` (`Core/Generation/Services/GenerationFilesRefresh.swift`), called by the observer (`AppShell.swift:518`) and by project open. `DocGenLazySeedingTests` gained 3 cases (10 total): kit arrives while Doc Gen is open → templates appear; while Visual is open → seeds; while elsewhere → reload only.

**Steps 4 and 5 (`c6e350e0`, `53804a47`, `ad9664b2`, `8ee96783`).**
- Gate `/generate-doc` (decision 2): `extension/routes/doc-gen.mjs` owns the route; `feature-routes.mjs` lists the `doc_gen` group; `/generate-docx` stays in `server/export-routes.mjs`, always on. Feature-matrix expectations, spec and how-to updated in the same commit.
- Client error (`8ee96783`): a 404 `feature_disabled`/`doc_gen` from `/generate-doc` shows "The connected server has Doc Gen turned off." (`LlmIdeAPIClient.generateDocFailure`, `LlmIdeAPIClient+Export.swift:168`; tests in `GenerateDocFailureTests`).
- Contract (`ad9664b2`): health and root fixtures to apiVersion 80; `SERVER_API_VERSION` changelog v79 before v80; `schema/http/INVENTORY.md` regenerated for the new Swift file. `make contract-gates` passes.
- Python path (decision 7, `53804a47`): `MeetingNoteGenerator`, the Python script, `note_template.docx`, the Step 2a caller and the Package.swift copy lines are gone.

**Not done here.** Step 3 (legacy-file check, the K1a migration test with a real `doc-templates.json`) is not started. Decisions 1, 3, 5, 6, 9, 10, 12, 13 are untouched. Open question 14 (the K0 rule for model types) is recorded in §7 and not decided.

