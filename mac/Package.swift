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
    "code_graph_3d", "file_explorer", "gantt_issues", "doc_gen", "terminal",
]

let graphIncluded = includedFeatures.contains("code_graph_3d")
let explorerIncluded = includedFeatures.contains("file_explorer")
let ganttIncluded = includedFeatures.contains("gantt_issues")
let docGenIncluded = includedFeatures.contains("doc_gen")
let terminalIncluded = includedFeatures.contains("terminal")

var libExcludes: [String] = []
var testExcludes: [String] = ["README-truncated-tests.md"]
var featureDefines: [SwiftSetting] = []
if graphIncluded {
    featureDefines.append(.define("FEATURE_GRAPH"))
} else {
    libExcludes.append("Graph")
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
    libExcludes.append("Views/Explorer")
}
if ganttIncluded {
    featureDefines.append(.define("FEATURE_GANTT"))
} else {
    libExcludes.append(contentsOf: ["Views/Gantt", "Views/Issues"])
    testExcludes.append("GanttViewModelProviderParityTests.swift")
}
if docGenIncluded {
    featureDefines.append(.define("FEATURE_DOCGEN"))
} else {
    libExcludes.append("Views/DocGen")
}
if terminalIncluded {
    featureDefines.append(.define("FEATURE_TERMINAL"))
} else {
    libExcludes.append("Views/Terminal")
}

// GraphCore/GraphKit are only imported from within Sources/LlmIdeMac/Graph/
// (verified in Task 1 Step 1: Services/Memory has zero GraphCore imports, and
// the only non-Graph-folder importer, LlmIdeAPIClient+CodeGraph.swift, was
// moved INTO Graph/ by Task 1). So when Graph is excluded, neither product is
// referenced anywhere in the target and both can be dropped from the
// dependency list.
var libDependencies: [Target.Dependency] = [
    "Yams",
    .product(name: "Sparkle", package: "Sparkle"),
    .product(name: "SharedProtocol", package: "SharedProtocol"),
]
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
        .package(path: "LocalPackages/graph-kit"),
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
        .testTarget(
            name: "LlmIdeMacTests",
            dependencies: ["LlmIdeMacLib"],
            path: "Tests/LlmIdeMacTests",
            exclude: testExcludes
        ),
    ],
    swiftLanguageModes: [.v5]
)
