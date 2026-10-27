// swift-tools-version: 6.0
import Foundation
import PackageDescription

// Build-time feature selection (Phase 2): LLMIDE_FEATURES lists the
// INCLUDED features by AppFeature rawValue, comma-separated; unset = all.
// Deselected features' source folders are excluded from compilation and
// their defines omitted, so FeatureCatalog compiles the inert branches.
// SwiftPM does not key its manifest cache on env vars — selection changes
// must build with `--manifest-cache none` (the Makefile targets do).
//
// NOTE: the dependency closure over `AppFeature.requiredDependencies` IS
// applied here (code_graph_3d / gantt_issues / doc_gen each require
// file_explorer), because a hand-typed LLMIDE_FEATURES never passes through
// `AppFeature.validated(_:)` the way Settings / Apply & Rebuild do. Without
// it such a build compiles in features the app's own validated set then
// refuses to enable, so the binary carries dead code and its compiled set
// disagrees with what drift detection expects. The manifest cannot import
// AppFeature, so the closure is restated below; keep it in step with
// `AppFeature.requiredDependencies`.
let envFeatures = ProcessInfo.processInfo.environment["LLMIDE_FEATURES"]
let requestedFeatures: Set<String> = envFeatures.map {
    Set($0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
} ?? [   // unset → everything (list each excludable key here)
    "code_graph_3d", "file_explorer", "gantt_issues", "doc_gen", "terminal", "auto_tasks",
    "mobile_sync",
]
let includedFeatures: Set<String> = requestedFeatures.contains("file_explorer")
    ? requestedFeatures
    : requestedFeatures.subtracting(["code_graph_3d", "gantt_issues", "doc_gen"])

let graphIncluded = includedFeatures.contains("code_graph_3d")
let explorerIncluded = includedFeatures.contains("file_explorer")
let ganttIncluded = includedFeatures.contains("gantt_issues")
let docGenIncluded = includedFeatures.contains("doc_gen")
let terminalIncluded = includedFeatures.contains("terminal")
let autoTasksIncluded = includedFeatures.contains("auto_tasks")
let mobileIncluded = includedFeatures.contains("mobile_sync")

// Resources/monaco-src/ is the hand-authored INPUT to
// Scripts/build-monaco-bundle.mjs, which copies it into Resources/monaco/ (the
// bundle the app loads, declared as a resource below). It is never read at
// runtime, so tell SwiftPM it is not a resource — otherwise every build warns
// "found 2 file(s) which are unhandled" for index.html / bootstrap.js.
var libExcludes: [String] = ["Resources/monaco-src"]
var testExcludes: [String] = ["README-truncated-tests.md"]
var featureDefines: [SwiftSetting] = []
if graphIncluded {
    featureDefines.append(.define("FEATURE_GRAPH"))
} else {
    libExcludes.append("Features/CodeGraph")
    testExcludes.append(contentsOf: [
        "CodeGraphUploadServiceTests.swift",
        "CodeNotePruneTests.swift",
        "GraphAutoUpdaterRepoResolutionTests.swift",
        "KnowledgeGraphEndToEndTests.swift",
        "KnowledgeGraphServiceTests.swift",
        "GraphModuleTests.swift",
        "LoopGraphRescannerTests.swift",
        "IssuesGanttGraphFixesTests.swift",
        "CodeGraphCitationUploadTests.swift",
        "CodeNoteGeneratorCallsTests.swift",
        "CodeNoteGeneratorKindsTests.swift",
        "CodeNoteServiceSupersedeTests.swift",
    ])
}
if explorerIncluded {
    featureDefines.append(.define("FEATURE_EXPLORER"))
} else {
    // Search and Source Control are also gated on `file_explorer` (controller
    // ruling: option b) — they're navigated to via the Explorer's panel-header
    // switcher (PanelSectionTabs) and make little sense without a file tree.
    libExcludes.append(contentsOf: ["Features/Explorer", "Features/Search", "Features/SourceControl"])
    // Tests naming an Explorer/Search/SourceControl type. (TextFileWriterTests
    // is NOT here: its one SearchEngine assertion moved to SearchEngineTests,
    // so the Core writer keeps its coverage in reduced builds.)
    testExcludes.append(contentsOf: [
        "ExplorerClipboardTests.swift",
        "ExplorerDragPayloadTests.swift",
        "ExplorerFileOpsTests.swift",
        "ExplorerKeyCommandTests.swift",
        "ExplorerTreeStorePersistenceTests.swift",
        "ExplorerTreeStoreTests.swift",
        "ExplorerTreeStoreWatchTests.swift",
        "SearchEngineTests.swift",
        "SearchReplaceTests.swift",
        "SearchStreamTests.swift",
        "SearchTruncationTests.swift",
    ])
}
if ganttIncluded {
    featureDefines.append(.define("FEATURE_GANTT"))
} else {
    // Gantt lives inside Features/Issues (Issues/Gantt/): the two reference
    // each other and share this flag, so one folder drops both.
    libExcludes.append("Features/Issues")
    testExcludes.append(contentsOf: [
        "GanttViewModelProviderParityTests.swift",
        "RepoIssuesLoadGateTests.swift",
    ])
    // Also listed under graph — SwiftPM rejects duplicate exclude entries.
    if !testExcludes.contains("IssuesGanttGraphFixesTests.swift") {
        testExcludes.append("IssuesGanttGraphFixesTests.swift")
    }
}
if docGenIncluded {
    featureDefines.append(.define("FEATURE_DOCGEN"))
} else {
    // Doc Gen and Visual (Generation/DocGen/, Generation/Visual/) both build
    // on the shared generation views in Generation/Views/ and ride on this one
    // flag (see ShellState.Section.backingFeature), so one folder drops all three.
    libExcludes.append("Features/Generation")
    // GenerationViewModelTests stays compiled: GenerationViewModel lives in
    // Core/Generation. GenerationTreeSelection, however, lives under the
    // excluded Features/Generation/Views, so its test must go with it.
    testExcludes.append("GenerationTreeSelectionTests.swift")
}
if terminalIncluded {
    featureDefines.append(.define("FEATURE_TERMINAL"))
} else {
    libExcludes.append("Features/Terminal")
}
if autoTasksIncluded {
    featureDefines.append(.define("FEATURE_AUTOTASK"))
} else {
    libExcludes.append(contentsOf: ["Features/AutoTask", "Features/Loop"])
    testExcludes.append(contentsOf: [
        "AgentLoopStageRepairerTests.swift",
        "ArtifactCheckSectionRulesTests.swift",
        "AutoCodeCustomSchedulingTests.swift",
        "AutoCodeUpdateServiceMeteringTests.swift",
        "AutoCodeUpdateServiceReviewSkipTests.swift",
        "CustomAutoTaskProjectScopeTests.swift",
        "MobileAutoTaskBridgeScopeTests.swift",
        "AutoCodeUpdateServiceCLITests.swift",
        "AutoCodeUpdateServiceComposedPromptTests.swift",
        "AutoCodeUpdateServiceCronTests.swift",
        "AutoCodeUpdateServiceCustomTaskTests.swift",
        "AutoCodeUpdateServiceLoopEngineeringTests.swift",
        "AutoCodeUpdateServicePipelineTasksTests.swift",
        "AutoTaskLoopHardeningTests.swift",
        "AutoTaskIncidentScopeTests.swift",
        "AutoTaskCatalogTests.swift",
        "AutoTaskConfigStoreTests.swift",
        "AutoTaskLoopEngineeringTests.swift",
        "AutoTaskModuleTests.swift",
        "AutoTaskPromptComposerTests.swift",
        "AutoTaskRunHistoryTests.swift",
        "AutoTaskRunHistoryLastFinishedTests.swift",
        "AutoTaskRunTriggerTests.swift",
        "AutoTaskSettingsCronTests.swift",
        "AutoTaskSettingsLoopEngineeringTests.swift",
        "AutoTaskSettingsTests.swift",
        "AutoTaskTemplateStoreTests.swift",
        "AutoTaskTemplateTests.swift",
        "CodeQuadrantClassifierTests.swift",
        "CustomAutoTaskTests.swift",
        "LoopDefaultLoopsTests.swift",
        "LoopDefinitionTests.swift",
        "LoopEngineConfigStoreTests.swift",
        "LoopEngineConfigTests.swift",
        "LoopEngineDefaultsTests.swift",
        "LoopEngineRunnerTests.swift",
        "LoopRunJournalTests.swift",
        "LoopRunAvailabilityTests.swift",
        "LoopShipPlanningTests.swift",
        "LoopRunQueueTests.swift",
        "LoopRunSummaryWriterTests.swift",
        "LoopStageDetectorTests.swift",
        "LoopStageSoloingTests.swift",
        "LoopStageTests.swift",
        "LoopTemplateStoreTests.swift",
        "LoopTemplateTests.swift",
        "LoopWorktreeManagerTests.swift",
        "MobileLoopStateTests.swift",
        "NoWallClockDefaultsTests.swift",
        "ProgressWatchTests.swift",
        "RefactorPlanDiffTests.swift",
        "RefactorRulesCollectorTests.swift",
        "RegressionRunnerSweepAdapterTests.swift",
        "RepairScopeGuardTests.swift",
        "StageOutputParserTests.swift",
        "TaskLogStoreTests.swift",
        "TestPruneScannerTests.swift",
        "TestMapBuilderTests.swift",
        "TestStructureDetectorTests.swift",
        "TestSourceMapperTests.swift",
        "LoopStageTestMapKindTests.swift",
        "LoopStageDetectorTestLoopTests.swift",
        "LoopStageDetectorRefactorLoopTests.swift",
        "TestLedgerTests.swift",
        "AutoCodeUpdateServiceCancelTests.swift",
        "AutoCodeUpdateServiceLoopLaneTests.swift",
        "AutoTaskTemplateApprovalTests.swift",
        "AutoTaskWorktreeTests.swift",
        "ConfigHardeningTests.swift",
        "CronExpressionTests.swift",
        "GraphIndexCallsTests.swift",
        "GraphReportTests.swift",
        "IssueImplementWorktreeTests.swift",
        "LoopAgentRunningTests.swift",
        "LoopArtifactCheckTests.swift",
        "LoopAttemptLedgerTests.swift",
        "LoopConfigBlessGateTests.swift",
        "LoopFinalFixTests.swift",
        "LoopPauseTimeoutTests.swift",
        "LoopPhase1FixTests.swift",
        "LoopSmartRunFlowTests.swift",
        "LoopStageCodeGraphKindTests.swift",
        "LoopStoreCacheTests.swift",
        "LoopStoreVersioningTests.swift",
        "MobileLoopSnapshotTests.swift",
        "MobileLoopStopTests.swift",       // also in mobile_sync's list — deduped there
        "RegressionFaultSyncTests.swift",
        "ReviewMergeCandidatesTests.swift",
        "TestFailureExtractorTests.swift",
        "VerifyCommandBuilderTests.swift",
        // The verify/repair/regression machinery (Features/Loop/Services/
        // Verification, Models/VerifyApprovalStore + AppWrittenFiles) used to
        // sit in Core/Verification and so ran in every build; it is Loop's.
        "AppWrittenFilesTests.swift",
        "GroupedSubprocessTests.swift",
        "VerifyApprovalStoreLoopStageTests.swift",
        "VerifyApprovalStoreTests.swift",
    ])
}
if mobileIncluded {
    featureDefines.append(.define("FEATURE_MOBILE"))
} else {
    // One folder, one line. Was a 14-entry file list plus a nested
    // auto_tasks conditional, because the unit was scattered across
    // Services/, Views/Settings/, Chat/Session/, AutoTask/ and LoopEngine/.
    libExcludes.append("Features/MobileControl")
    let mobileTestExcludes: Set<String> = [
        "MobilePairingFrameTests.swift",
        "MobileWebSocketServerBindTests.swift",
        "MobileWebSocketServerRebindTests.swift",
        "MobileWebSocketServerRoutingTests.swift",
        "MobileControlPortTests.swift",
        "MobileFeatureBridgeTests.swift",
        "LlmDocBrowserTests.swift",
        "PhoneAccessTests.swift",
        "MobileUsageBridgeTests.swift",
        "MobileProjectBridgeTests.swift",
        "MobileSelfHealBridgeTests.swift",
        "MobileToolApprovalTests.swift",
        "MobileHardeningTests.swift",
        "PhoneGitTests.swift",
        "PhoneFilesTests.swift",
        "PhoneIssuesTests.swift",
        "PairingThrottleTests.swift",
        "MobilePairedDeviceStoreTests.swift",
        "MobileExploreIndexStoreTests.swift",
        "MobileModuleTests.swift",
        "MobileExploreScopeTests.swift",
        "MobileExploreTurnPolicyTests.swift",
        "MobileInflightTaskTests.swift",
        "MobileLoopStopTests.swift",       // also in auto_tasks's list — dedupe below
        "MobilePairedDeviceExpiryTests.swift",
        "MobilePhoneApprovalHookTests.swift",
        "MobilePinValidationTests.swift",
    ]
    // Dedupe against auto_tasks's testExcludes (MobileLoopStopTests, marked
    // above, drives the Loop bridge through a real MobileControlManager, so it
    // appears in both lists) — SwiftPM does not tolerate duplicate exclude
    // entries. The Loop/Auto Task bridges themselves need no entry here: they
    // live in Features/Loop and Features/AutoTask, reach the manager only
    // through Core/Contracts' `MobileBridgeHosting`, and import no
    // SharedProtocol, so a mobile-off build compiles them as-is.
    for name in mobileTestExcludes where !testExcludes.contains(name) {
        testExcludes.append(name)
    }
}
if mobileIncluded {
    // The folder's agent guide is not a resource; without this every build
    // warns "found 1 file(s) which are unhandled". Only when the folder is
    // compiled: with mobile_sync off the whole folder is already excluded,
    // and SwiftPM rejects an exclude nested inside another. Its own `if`
    // (not the featureDefines one above) for feature-boundaries.sh's parser.
    libExcludes.append("Features/MobileControl/CLAUDE.md")
}

// GraphCore/GraphKit are only imported from within
// Sources/LlmIdeMac/Features/CodeGraph/ (verified in Task 1 Step 1:
// Services/Memory has zero GraphCore imports, and the only non-Graph-folder
// importer, LlmIdeAPIClient+CodeGraph.swift, was moved INTO Graph/ by Task 1;
// Task 18 then relocated the whole folder to Features/CodeGraph/, re-verified
// with `grep -rln "import GraphCore\|import GraphKit" Sources/LlmIdeMac` —
// every hit is still under Features/CodeGraph/). RepoGraphLocator.swift moved
// to Core/Platform/ in the same task instead of into Features/CodeGraph/: it
// has zero GraphCore/GraphKit imports and is a concrete Core dependency (see
// its own doc comment — the auto-task pipeline calls it even when Graph is
// excluded). So when Graph is excluded, neither product is referenced
// anywhere in the target and both can be dropped from the dependency list.
// SharedProtocol (the mac↔iOS wire-format package) is imported ONLY from
// within the Mobile Control unit (verified: `grep -rln "import SharedProtocol"
// mac/Sources/LlmIdeMac --include="*.swift"` — every hit is one of the
// Features/MobileControl/ unit files). So the product can be dropped from
// the dependency list entirely when mobile_sync is excluded, same
// UNPLUG-style gating as GraphCore/GraphKit below.
var libDependencies: [Target.Dependency] = [
    "Yams",
    .product(name: "Sparkle", package: "Sparkle"),
]
if mobileIncluded {
    libDependencies.append(.product(name: "SharedProtocol", package: "SharedProtocol"))
}
if terminalIncluded {
    libDependencies.append(.product(name: "SwiftTerm", package: "SwiftTerm"))
}
if graphIncluded {
    libDependencies.append(.product(name: "GraphCore", package: "graph-kit"))
    libDependencies.append(.product(name: "GraphKit", package: "graph-kit"))   // UNPLUG: remove
}

// The SharedProtocol PACKAGE is gated with its product: a local path
// dependency no target uses (mobile_sync off) makes SwiftPM warn "dependency
// 'sharedprotocol' is not used by any target" on every build-mac-min.
var sharedProtocolPackage: [Package.Dependency] = []
if mobileIncluded {
    sharedProtocolPackage.append(.package(path: "../ios_app/SharedProtocol"))
}

let package = Package(
    name: "LlmIdeMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "LlmIdeMac", targets: ["LlmIdeMacMain"]),
        .library(name: "LlmIdeMacLib", targets: ["LlmIdeMacLib"]),
        // Assertion gate for the Chat slice. An EXECUTABLE, not a test target,
        // because a Command-Line-Tools-only toolchain has no XCTest and
        // `swift test` is skipped there (see the Makefile's HAS_XCTEST guard) —
        // same rationale as graph-kit's graph-layout-lab / graph-engine-lab.
        .executable(name: "chat-contract-lab", targets: ["ChatContractLab"]),
        .executable(name: "generation-contract-lab", targets: ["GenerationContractLab"]),
        .executable(name: "loop-contract-lab", targets: ["LoopContractLab"]),
        .executable(name: "api-contract-lab", targets: ["APIContractLab"]),
    ],
    dependencies: [
        .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle.git", from: "2.6.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
        // The graph system — one repository, two products with different
        // lifetimes. GraphCore (model + JSON contract + layout: everything
        // needed to READ and DRAW a graph) is always linked. GraphKit (the
        // producers: scanners, extractors, memory generators) is the engine —
        // to UNPLUG it, comment out the `.product(name: "GraphKit", …)` line
        // and the `GRAPHKIT_BUILTIN` define below (this `.package` line stays:
        // GraphCore comes from it). The app still builds: the Graph view
        // reports that no engine is installed and keeps rendering any
        // graph.json already on disk. See Sources/LlmIdeMac/Graph/Engine/.
        //
        // Resolved from the GitHub remote (not the local submodule checkout
        // in LocalPackages/graph-kit/) so a build works even when that
        // submodule was never initialized — SwiftPM fetches/caches it into
        // .build/checkouts itself. Pinned to the exact commit currently
        // checked out locally; bump this when graph-kit cuts a new release.
        .package(url: "https://github.com/dnsmalla/graph-kit.git", revision: "f94a7c2a12fc961c20ac47af61fcf18b9a38c476"),
    ] + sharedProtocolPackage,
    targets: [
        .target(
            name: "LlmIdeMacLib",
            dependencies: libDependencies,
            path: "Sources/LlmIdeMac",
            exclude: libExcludes,
            resources: [
                .copy("Resources/note_template.docx"),
                .copy("Resources/generate_meeting_note.py"),
                .copy("Resources/highlight.min.js"),
                .copy("Resources/atom-one-dark.min.css"),
                .copy("Resources/atom-one-light.min.css"),
                // Directory copy: the Source Connector manifest engine reads
                // `source_connectors/*.json` as a directory, not by filename.
                // Required even though Scripts/build.sh already rsyncs
                // Sources/LlmIdeMac/Resources/ into the .app — without the
                // declaration SwiftPM warns about unhandled files, and
                // Bundle.module (the only bundle `swift test` can see) would
                // not carry the manifests.
                .copy("Resources/source_connectors"),
                // Vendored Monaco editor (offline, no CDN — same policy as
                // highlight.min.js above). Generated by
                // Scripts/build-monaco-bundle.mjs from monaco-editor's
                // prebuilt files; do not hand-edit anything under
                // Resources/monaco/ except by re-running that script — edit
                // Resources/monaco-src/ instead for the hand-authored parts.
                .copy("Resources/monaco"),
                // The System view (os-kit OS-3): built from ui/os-view by
                // `make os-view`, which writes this folder. Do not hand-edit
                // anything under Resources/os-view/; edit ui/os-view/src instead.
                .copy("Resources/os-view"),
                // NOT mermaid: it used to be vendored here (3.4 MB) and is now
                // an optional component downloaded on demand, pinned by version
                // and SHA-256 — see Core/Editor/Mermaid.swift. Do not re-add a
                // `Resources/mermaid` copy; Scripts/build.sh excludes it anyway.
            ],
            swiftSettings: [
                // Gates the compiled-in graph engine. An explicit define rather
                // than `#if canImport(GraphKit)`: `canImport` still answers yes
                // for a module left behind in `.build`, so it compiled the
                // builtin engine in and then failed at link time instead of
                // degrading cleanly.
                .define("GRAPHKIT_BUILTIN"),   // UNPLUG: remove
            ] + featureDefines,
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        ),
        .executableTarget(
            name: "LlmIdeMacMain",
            dependencies: ["LlmIdeMacLib"],
            path: "Sources/LlmIdeMacMain"
        ),
        .executableTarget(
            name: "GenerationContractLab",
            dependencies: ["LlmIdeMacLib"],
            path: "Sources/GenerationContractLab",
            // Same defines as the library, for the same reason ChatContractLab
            // carries them: Doc Gen and Visual are build-excludable features.
            swiftSettings: featureDefines
        ),
        .executableTarget(
            name: "ChatContractLab",
            dependencies: ["LlmIdeMacLib"],
            path: "Sources/ChatContractLab",
            // Same defines as the library, so an assertion about a
            // build-excludable feature can be wrapped in the matching `#if` and
            // simply vanish from the reduced builds. Without this the lab could
            // assert nothing about Graph at all — naming a Graph type would
            // break build-mac-lite/min, where `Graph/` is excluded.
            swiftSettings: featureDefines
        ),
        .executableTarget(
            name: "LoopContractLab",
            dependencies: ["LlmIdeMacLib"],
            path: "Sources/LoopContractLab",
            // Same reason as ChatContractLab: Loop lives under Features/Loop,
            // which `libExcludes` drops entirely when `auto_tasks` is not in
            // LLMIDE_FEATURES (build-mac-min: agent_chat only) — see
            // Package.swift's `libExcludes.append(..., "Features/Loop")`.
            // Without this the lab could not even name LoopStageDetector in
            // the reduced builds.
            swiftSettings: featureDefines
        ),
        .executableTarget(
            // Decodes every 2xx HTTP contract fixture with the Mac client's
            // real Codable models (Phase 1 P12). Routed models are public.
            name: "APIContractLab",
            dependencies: ["LlmIdeMacLib"],
            path: "Sources/APIContractLab",
            swiftSettings: featureDefines
        ),
        .testTarget(
            name: "LlmIdeMacTests",
            dependencies: ["LlmIdeMacLib"],
            path: "Tests/LlmIdeMacTests",
            exclude: testExcludes
        ),
    ],
    swiftLanguageModes: [.v5]
)
