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
// NOTE: the dependency closure over `AppFeature.requiredDependencies` (e.g.
// disabling `file_explorer` also disables `code_graph_3d`/`gantt_issues`/
// `doc_gen`) is NOT applied here — this manifest trusts whatever set it is
// given. Callers (the Phase 3 selection script, Makefile targets) are
// responsible for passing an already-validated set, e.g. via
// `AppFeature.validated(_:)`.
let envFeatures = ProcessInfo.processInfo.environment["LLMIDE_FEATURES"]
let includedFeatures: Set<String> = envFeatures.map {
    Set($0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
} ?? [   // unset → everything (list each excludable key here)
    "code_graph_3d", "file_explorer", "gantt_issues", "doc_gen", "terminal", "auto_tasks",
    "mobile_sync",
]

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
    ])
}
if explorerIncluded {
    featureDefines.append(.define("FEATURE_EXPLORER"))
} else {
    // Search and Source Control are also gated on `file_explorer` (controller
    // ruling: option b) — they're navigated to via the Explorer's panel-header
    // switcher (PanelSectionTabs) and make little sense without a file tree.
    libExcludes.append(contentsOf: ["Features/Explorer", "Features/Search", "Features/SourceControl"])
}
if ganttIncluded {
    featureDefines.append(.define("FEATURE_GANTT"))
} else {
    libExcludes.append(contentsOf: ["Features/Gantt", "Features/Issues"])
    testExcludes.append("GanttViewModelProviderParityTests.swift")
}
if docGenIncluded {
    featureDefines.append(.define("FEATURE_DOCGEN"))
} else {
    // DocGenViewModelTests.swift / DocGenTreeSelectionTests.swift moved to
    // GenerationViewModelTests.swift / GenerationTreeSelectionTests.swift
    // alongside their subjects' move to Views/Shared (always compiled), so
    // there is no longer a doc_gen-specific test file to exclude here.
    // Views/Visual mirrors Doc Gen's generation flow and rides on the same
    // flag (see ShellState.Section.backingFeature) — exclude it here too.
    libExcludes.append(contentsOf: ["Features/DocGen", "Features/Visual", "Features/Generation"])
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
        "AutoCodeCustomSchedulingTests.swift",
        "AutoCodeUpdateServiceCLITests.swift",
        "AutoCodeUpdateServiceComposedPromptTests.swift",
        "AutoCodeUpdateServiceCronTests.swift",
        "AutoCodeUpdateServiceCustomTaskTests.swift",
        "AutoCodeUpdateServiceLoopEngineeringTests.swift",
        "AutoCodeUpdateServicePipelineTasksTests.swift",
        "AutoTaskCatalogTests.swift",
        "AutoTaskConfigStoreTests.swift",
        "AutoTaskLoopEngineeringTests.swift",
        "AutoTaskModuleTests.swift",
        "AutoTaskPromptComposerTests.swift",
        "AutoTaskRunHistoryTests.swift",
        "AutoTaskRunTriggerTests.swift",
        "AutoTaskSettingsCronTests.swift",
        "AutoTaskSettingsLoopEngineeringTests.swift",
        "AutoTaskSettingsTests.swift",
        "AutoTaskTemplateStoreTests.swift",
        "AutoTaskTemplateTests.swift",
        "CustomAutoTaskTests.swift",
        "LoopDefaultLoopsTests.swift",
        "LoopDefinitionTests.swift",
        "LoopEngineConfigStoreTests.swift",
        "LoopEngineConfigTests.swift",
        "LoopEngineDefaultsTests.swift",
        "LoopEngineRunnerTests.swift",
        "LoopRunJournalTests.swift",
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
        "RegressionRunnerSweepAdapterTests.swift",
        "RepairScopeGuardTests.swift",
        "StageOutputParserTests.swift",
        "TaskLogStoreTests.swift",
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
        "PairingThrottleTests.swift",
        "MobilePairedDeviceStoreTests.swift",
        "MobileExploreIndexStoreTests.swift",
        "MobileLoopStateTests.swift",   // also in auto_tasks's list — dedupe below
        "ExplorerMobileEngineResolverTests.swift",
        "MobileModuleTests.swift",
    ]
    // Dedupe against auto_tasks's testExcludes (MobileLoopStateTests can
    // appear in both when auto_tasks is also excluded) — SwiftPM does not
    // tolerate duplicate exclude entries.
    for name in mobileTestExcludes where !testExcludes.contains(name) {
        testExcludes.append(name)
    }
}
if mobileIncluded && !autoTasksIncluded {
    // MobileAutoTaskBridge / MobileLoopBridge are UNSEALED (Task 23 pending
    // Tasks 17-18's protocol work): they still name AutoTask/Loop concrete
    // types directly. Before this task they lived inside AutoTask/ and
    // LoopEngine/, so `auto_tasks`'s own wholesale folder exclude (above)
    // removed them for free whenever auto_tasks was off, mobile or not. Now
    // that both live under the always-compiled Features/MobileControl/, that
    // free protection is gone — build-mac-mobile-only (mobile ON, auto_tasks
    // OFF) is exactly the config that exercises this, so these two files
    // need their own exclude. Kept as its OWN top-level `if` (not nested
    // inside the `if mobileIncluded { featureDefines... } else { ... }`
    // above) so feature-boundaries.sh's flagmap parser — which requires that
    // if-body to contain only the featureDefines.append call — still
    // recognizes Features/MobileControl as FEATURE_MOBILE-gated.
    libExcludes.append(contentsOf: [
        "Features/MobileControl/Services/MobileAutoTaskBridge.swift",
        "Features/MobileControl/Services/MobileLoopBridge.swift",
    ])
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
        .package(url: "https://github.com/dnsmalla/graph-kit.git", revision: "f3151c35f59c5440a48746ae9ebfb5f2adb14f38"),
        .package(path: "../ios_app/SharedProtocol"),
    ],
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
                // Vendored by Scripts/build-mermaid-bundle.mjs, same rationale
                // as monaco/highlight.js: the markdown preview is a WKWebView
                // rendering a LOCAL html string, so a remote <script> would put
                // diagram rendering at the mercy of the network.
                .copy("Resources/mermaid"),
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
            path: "Sources/LoopContractLab"
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
