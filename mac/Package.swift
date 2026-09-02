// swift-tools-version: 6.0
import PackageDescription

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
            dependencies: [
                "Yams",
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "GraphCore", package: "graph-kit"),
                .product(name: "GraphKit", package: "graph-kit"),   // UNPLUG: remove
                .product(name: "SharedProtocol", package: "SharedProtocol"),
            ],
            path: "Sources/LlmIdeMac",
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
                // TEMP(Phase2a-Task3): replaced by env-driven selection
                .define("FEATURE_GRAPH"),
            ],
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
            exclude: ["README-truncated-tests.md"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
