// swift-tools-version: 5.9
import PackageDescription

/// graph-kit — the whole graph system in one repository, as TWO products with
/// deliberately different lifetimes:
///
/// - **GraphCore** — the canonical data model, its JSON contract, and the
///   layout engine: everything needed to **read and draw** a graph. The app
///   always links this.
/// - **GraphKit** — the producers: scanners, extractors, the InfiniteBrain
///   memory generator, doc↔code linking, memory-artifact rendering. Everything
///   that **creates** a graph. The app links this behind the
///   `GRAPHKIT_BUILTIN` define and can drop it (see the `// UNPLUG:` markers in
///   `mac/Package.swift`); an installed plugin can supply the same capability
///   through `graph-engine.json` instead.
///
/// One folder, two products, because the split is about *lifetime*, not
/// geography: uninstalling the engine must stop generation while an existing
/// `graph.json` keeps rendering — which is only possible if the model and the
/// layout never leave the app. Keeping both in this repository means the
/// TypeScript CLI (`typescript/`), the canonical schema (`schema/`), and the
/// plugin manifest (`graph-engine.json`) travel together with the Swift code
/// they must stay in step with.
let package = Package(
    name: "GraphKit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "GraphCore", targets: ["GraphCore"]),
        .library(name: "GraphKit", targets: ["GraphKit"]),
        // Headless layout benchmark + regression gate. XCTest and swift-testing
        // are unavailable in a Command-Line-Tools-only toolchain, so layout
        // correctness is asserted by an executable that measures against ground
        // truth and exits non-zero on a regression.
        .executable(name: "graph-layout-lab", targets: ["GraphLayoutLab"]),
        // Engine-level gate: merge cross-links, containment direction, doc
        // fingerprint stability — the invariants XCTest would cover elsewhere.
        .executable(name: "graph-engine-lab", targets: ["GraphEngineLab"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "GraphCore",
            path: "Sources/GraphCore"
        ),
        .target(
            name: "GraphKit",
            dependencies: ["GraphCore"],
            path: "Sources/GraphKit",
            resources: [
                .copy("Resources/code_ast_scan.py"),
                .copy("Resources/code_graph_scan.py"),
            ]
        ),
        .executableTarget(
            name: "GraphLayoutLab",
            dependencies: ["GraphCore"],
            path: "Sources/GraphLayoutLab"
        ),
        .executableTarget(
            name: "GraphEngineLab",
            dependencies: ["GraphKit"],
            path: "Sources/GraphEngineLab"
        ),
        .testTarget(
            name: "GraphKitTests",
            dependencies: ["GraphKit", "GraphCore"],
            path: "Tests/GraphKitTests",
            resources: [
                .copy("Fixtures"),
            ]
        ),
    ]
)
