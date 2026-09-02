// swift-tools-version: 5.9
import PackageDescription

/// GraphCore — the parts of the graph system that must always be present.
///
/// The split from `graph-kit` is what makes the graph *engine* removable. This
/// package holds the canonical data model, its JSON contract, and the layout
/// engine: everything needed to **read and draw** a graph. `graph-kit` holds the
/// producers — the scanners, extractors and memory generators that **create**
/// one — and becomes an installable plugin.
///
/// Keeping layout here rather than in the engine is the load-bearing decision:
/// with it here, uninstalling the engine stops new graphs being generated but
/// an existing `graph.json` still renders. With it in the engine, unplugging
/// would black out the Graph view entirely.
///
/// Zero dependencies, and no SwiftUI or AppKit — so it builds and is testable
/// without the app, and can be linked by any consumer.
let package = Package(
    name: "GraphCore",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "GraphCore", targets: ["GraphCore"]),
        // Headless layout benchmark and regression gate. This toolchain has
        // neither XCTest nor swift-testing (Command Line Tools, no Xcode), so
        // layout correctness is asserted by an executable that measures quality
        // metrics, compares against the pipeline it replaced, and exits
        // non-zero on a regression.
        .executable(name: "graph-layout-lab", targets: ["GraphLayoutLab"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "GraphCore",
            path: "Sources/GraphCore"
        ),
        .executableTarget(
            name: "GraphLayoutLab",
            dependencies: ["GraphCore"],
            path: "Sources/GraphLayoutLab"
        ),
    ]
)
