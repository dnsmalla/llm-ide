# Project structure

Moved from the root `CLAUDE.md` so the agent instructions stay focused. See [`CLAUDE.md`](https://github.com/dnsmalla/llm-ide/blob/main/CLAUDE.md) for the architecture summary.

```text
llm-ide/
├── .skills/             # git submodule → dnsmalla/agent-kit (single source of truth)
├── scripts/install-skills.sh  # symlink kit into Claude/Cursor/Codex/.agents/Gemini
├── extension/           # Chrome extension + local server
│   ├── core/            # Framework-free primitives (config, utils, errors, logger)
│   ├── server/          # HTTP server (no framework), routing, middleware
│   ├── kb/              # SQLite knowledge base, migrations, FTS5; sources.mjs = source hub
│   ├── routes/          # HTTP route modules (router.mjs + agent/chat/live/planning/review/…; extension-routes.mjs = plugin/MCP/LLM-source)
│   ├── providers/       # Model-provider layer: dispatch, CLI spawn, retry/backoff, web client
│   ├── agents/          # Server pipeline agents (planner, risk, codegen, dispatcher, …) — not skills
│   ├── llm_agent/       # Agent engine glue: sdk/ adapter/ tools/ modes/ memory/ plan/ tasks/ skills/ + synced agent-tool defs
│   ├── connectors/      # Inbound source adapters (box, git, issues, qa, scip, email, slack + OAuth)
│   ├── llm-sources/     # LLM source registry + state (feeds kb/sources.mjs hub)
│   ├── mcp/             # MCP server config + Claude MCP source adapter
│   ├── graphkit/        # Server-side graph access (graph.mjs seeds/neighbors, memory reader/writer)
│   ├── graph_generation/ # Graph-engine contract: how an engine is supplied + swapped (README)
│   ├── guardrails/      # Secret/PII/destructive-op pattern scanners
│   ├── plugins/         # Extension plugin loader/installer (claude-adapter, loader, installer, state)
│   ├── src/             # React UI (side panel, popup, content scripts)
│   ├── tests/           # Node test runner (tests/**/*.test.{ts,mjs})
│   └── server.mjs       # Server entry point
├── mac/                 # Native macOS app
│   ├── LocalPackages/
│   │   └── graph-kit/   # THE graph repo — one folder, two products:
│   │       ├── Sources/GraphCore/   # ALWAYS LINKED: canonical model + JSON contract
│   │       │                        #   + layout (2D/3D) + memory-artifact rendering
│   │       ├── Sources/GraphKit/    # PLUGGABLE ENGINE: scanners, extractors,
│   │       │                        #   MemoryGenerator (InfiniteBrain), GraphMerger
│   │       ├── Sources/Graph*Lab/   # graph-layout-lab + graph-engine-lab gates
│   │       ├── typescript/          # TS implementation + CLI (plugin runtime)
│   │       ├── schema/              # canonical JSON schema + conformance fixtures
│   │       └── graph-engine.json    # plugin manifest
│   ├── Sources/LlmIdeMac/     # Shell → Features → Core (see "Module Boundaries (macOS app)" below)
│   │   ├── Core/        # Leaf infrastructure — never build-excluded, importable by ANY layer.
│   │   │   │            #   Subfolders are named by CAPABILITY, not by feature:
│   │   │   ├── Contracts/   #   Cross-feature protocols: LoopRunning, TaskLogWriting,
│   │   │   │                #   MobileFeatureBridge, MobileBridgeHosting,
│   │   │   │                #   MobileChatHosting (Mobile Control → Chat),
│   │   │   │                #   LoopLaneControlling, ProjectNotesProviding,
│   │   │   │                #   NoteSourceClassifying (Library's SourceRegistry seam),
│   │   │   │                #   SourceIngesting (Library's ingestion, for AutoTask's
│   │   │   │                #   Source Update), LoopSweepPlanning (Loop's loop selection
│   │   │   │                #   for AutoTask's Loop Engineering sweep), LoopRunnerProviding
│   │   │   │                #   (+SweepOutcome: Loop's runners and regression sweep for
│   │   │   │                #   AutoTask's Loop Engineering + Regression tasks),
│   │   │   │                #   ChatTransport (+Input/Result: the engine↔transport contract
│   │   │   │                #   ClaudeLink's AgentV2Transport implements), ChatScope,
│   │   │   │                #   ShellSection + LibrarySelection (the section / Library-row
│   │   │   │                #   enums, aliased as ShellState.Section / .LibrarySelection),
│   │   │   │                #   SettingsSectionRegistry (+Slot: feature-contributed Settings
│   │   │   │                #   cards), ChatEnginePreference (Agent v2 toggle key),
│   │   │   │                #   ChatPanelProviding (ChatPanelRegistry/ChatPanelView: the chat
│   │   │   │                #   panel + code-change sheets features embed), ChatOutputProviding
│   │   │   │                #   (latest finished chat reply), EditAcceptanceMode (chat permission
│   │   │   │                #   mode, read by Mobile Control too), LiveCaptureProviding
│   │   │   │                #   (LiveCaptureRegistry/LiveCaptureGate: Live's recording take-over
│   │   │   │                #   of Library's meeting detail), IssueSeams (IssueSeamRegistry:
│   │   │   │                #   Issues' existing-issue picker + RecentIssuesProviding),
│   │   │   │                #   ProjectMemoryProviding (Explorer's memory viewer),
│   │   │   │                #   TerminalPanelProviding (TerminalPanelSlot: the Terminal dock)
│   │   │   ├── DesignSystem/#   Shared SwiftUI chrome: FileTreePanel, EditorTabBar, FileDetailView,
│   │   │   │                #   ColorPalette, Components/ (SettingsSectionCard, ResizableDivider,
│   │   │   │                #   PersistedPanelWidth, …), LibraryItem+UI (category colors),
│   │   │   │                #   LibraryPicker (the "Add from Library" sheet other features open),
│   │   │   │                #   section chrome features render: SectionChromeBar (+SectionToggle),
│   │   │   │                #   PanelSectionTabs (Explorer/Source Control/Search switcher),
│   │   │   │                #   WindowHeightKey
│   │   │   ├── Editor/      #   CompletionController/Menu, HunkStagingList, ChatSlashCommands,
│   │   │   │                #   Mermaid + MermaidRuntime (diagram renderer, downloaded on demand)
│   │   │   │                #   (the built-in "/" catalog the completion menu lists)
│   │   │   ├── FeatureToggles/ # Feature runtime: AppFeature (+ProfilePreset), FeatureRegistry
│   │   │   │                #   (+AppModule / FeatureService protocols). Shell's FeatureCatalog
│   │   │   │                #   assigns compiledFeatures and registers modules at boot
│   │   │   ├── Generation/  #   GenerationRegistry + GenerationViewModel (concrete type,
│   │   │   │                #   referenced unconditionally by Shell — see invariants.md)
│   │   │   ├── Incidents/   #   Incident capture + Self-Heal proposals — stays in Core: Settings,
│   │   │   │                #   Mobile Control, Chat, Core/Networking and AppShell use it too
│   │   │   ├── Memory/      #   Fault reports, Q&A store, environment note — shared by Chat
│   │   │   │                #   (Q&A), Shell + Loop (environment note), Loop (faults); MemoryStore
│   │   │   │                #   is used by Core/Platform + Core/Project, so it stays in Core; works with CodeGraph
│   │   │   │                #   compiled out
│   │   │   ├── Networking/  #   LlmIdeAPIClient + API/ extensions (and the wire models they decode:
│   │   │   │                #   SourceConnectorClassification, LegacyExportRecord), BackendManager,
│   │   │   │                #   AuthRedirectGuard
│   │   │   ├── Notes/       #   On-disk notes store every feature reads (Library's backing code):
│   │   │   │                #   LibraryItem(Store), NoteService, NotesFolderConfig, MeetingIndex,
│   │   │   │                #   FolderIndexer, Markdown/MeetingFrontmatter, FrontmatterCoder,
│   │   │   │                #   NoteAction, MeetingSummary, IngestTemplateRenderer, launch-time
│   │   │   │                #   folder migrations (NotesToLlmDoc, SourceFolder, SourceNestedLlmDoc),
│   │   │   │                #   meeting files + summarization shared by Live and Library:
│   │   │   │                #   MeetingFileStore, PartialRecovery, MeetingSummarizationService,
│   │   │   │                #   MeetingNoteWriter, IngestNoteDedup
│   │   │   ├── Platform/    #   App lifecycle + shared utilities: AppDelegate (+ AppTerminationHooks:
│   │   │   │                #   quit-time flushes Shell registers, e.g. Chat's), FeatureCacheHooks
│   │   │   │                #   (graph/Mobile-PIN cache seams Shell installs), BashService, Config,
│   │   │   │                #   AppIdentity, AppJSON, DateFormatters, PathUtils, SecretRedactor,
│   │   │   │                #   FilesystemSlug, AgentTypes, ActivityStore, SessionStore,
│   │   │   │                #   NotificationNames, LaunchPathResolver, ProcessedActionsRegistry,
│   │   │   │                #   ShellState (app-session UI state: section, Library selection,
│   │   │   │                #   handoff ids; + ShellSection.backingFeature/resolveHome/tint),
│   │   │   │                #   TerminalPanelState (dock open/height — always compiled, see
│   │   │   │                #   invariants.md)
│   │   │   ├── Project/     #   Project/Plan/CodeTree models, WorkspaceRoot, FileSystemTree,
│   │   │   │                #   ExplorerPaths, ProjectLayout, ProjectScaffolder, ProjectSkillsInstaller,
│   │   │   │                #   ProjectStore, ProjectExporter + ProjectExportBundle (KB → folder export)
│   │   │   └── Repo/        #   Models/ + Services/ — git clients shared by SourceControl,
│   │   │                    #   Issues, Gantt, AutoTask behind the RepoBackend protocol
│   │   │                    #   (GitHub/GitLab adapters + RepoBackendFactory in Services/Repo/),
│   │   │                    #   RepoFileWatcher, RepoGraphLocator
│   │   ├── Features/    # One folder per build-excludable unit (a unit may hold several
│   │   │   │            #   menu items as sub-folders: Generation/{DocGen,Visual},
│   │   │   │            #   Issues/Gantt) + the non-menu features (Chat, MobileControl,
│   │   │   │            #   Terminal). Normally {Models,Services,Views}; MUST NOT
│   │   │   │            #   reference another feature.
│   │   │   ├── Library/ · Live/ · Explorer/ · Search/ · ReviewConflicts/ · SourceControl/
│   │   │   ├── Extensions/  #   plugins, MCP servers, LLM sources, skills sources (UI + update/install
│   │   │   │            #   services); always compiled, sealed; Library embeds its sidebar
│   │   │   │            #   sections/detail panes via ExtensionsLibraryRegistry
│   │   │   ├── Issues/ (+ Gantt/) · AutoTask/ · CodeGraph/ · Loop/ · Settings/
│   │   │   │            #   Loop/ also owns the verify/repair machinery (compiled out
│   │   │   │            #   with auto_tasks): Services/Verification/ (RegressionRunner,
│   │   │   │            #   ShellFaultVerifier, AgentFaultRepairer, RepairScopeGuard,
│   │   │   │            #   GroupedSubprocess) + Models/ (VerifyApprovalStore, AppWrittenFiles)
│   │   │   ├── Chat/    #   splits further: Models/ (incl. DiffStats, ProposedEdit, ProposedPlan)
│   │   │   │            #   Engine/ Session/ Transport/ (AgentV2Selection)
│   │   │   │            #   Services/ Views/ (Panel/ = CodeAssistant
│   │   │   │            #   + its action sheets, Quick/ = menu bar + sheet, Shared/)
│   │   │   ├── MobileControl/  # WebSocket server, Bonjour, PIN cache, pairing UI
│   │   │   ├── Generation/     # the doc_gen unit: Views/ = Doc Gen + Visual's shared
│   │   │   │                   #   generation views, DocGen/ + Visual/ = the two menu
│   │   │   │                   #   items (registry/view-model stay in Core/Generation)
│   │   │   └── Terminal/       # excludable; Core/Platform/TerminalPanelState.swift stays
│   │   │                       #   outside it, in Core — see invariants.md
│   │   ├── Shell/       # Composition root — the ONLY layer permitted to name every feature:
│   │   │   │            #   app entry (LlmIdeMacApp.swift), AppShell, ContentView,
│   │   │   │            #   FeatureCatalog, DeepLinkRouter, LoginView, ReconnectView,
│   │   │   │            #   CrashReportStore, PassiveModule, ProjectMigrator, Recovery/, Welcome/,
│   │   │   │            #   ChatScope+Shell (scope → ShellSection mapping)
│   │   │   └── Chrome/  #   StatusBar, ActivityBell, toolbar/banners (exempt from the
│   │   │                #   feature/boundary rule, NOT from build-exclusion — see invariants.md)
│   │   └── ClaudeLink/  # Top-level (not under Core/), but declared Core in the feature map —
│   │                    #   Claude SDK/CLI glue incl. ClaudeSubscriptionUsageClient;
│   │                    #   see docs/explanation/claude-linker.md
│   └── Tests/           # XCTest + swift-testing suites
├── docs/                # mkdocs site (Diátaxis framework)
└── kb/                  # Dev/test runtime data (repo kb). On first boot with LLMIDE_DATA_DIR (the Mac app's
                         #   ~/Library/Application Support/llm-ide/system) the DB, agent.db, secrets and agent-sdk
                         #   are MOVED there (originals kept as *.pre-move for one boot); kb/backups/ is left alone (see the how-to)
```
