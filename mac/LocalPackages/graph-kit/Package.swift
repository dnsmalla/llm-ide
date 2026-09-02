// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GraphKit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "GraphKit", targets: ["GraphKit"]),
    ],
    dependencies: [
        // The canonical model + JSON contract. GraphKit is the *producer* side
        // of the graph system and is destined to become an installable plugin;
        // the model and the layout engine live in GraphCore because the app
        // must still be able to read and draw a graph with no engine installed.
        .package(path: "../graph-core"),
    ],
    targets: [
        .target(
            name: "GraphKit",
            dependencies: [
                .product(name: "GraphCore", package: "graph-core"),
            ],
            path: "Sources/GraphKit",
            resources: [
                .copy("Resources/code_ast_scan.py"),
                .copy("Resources/code_graph_scan.py"),
            ]
        ),
        .testTarget(
            name: "GraphKitTests",
            dependencies: ["GraphKit"],
            path: "Tests/GraphKitTests",
            resources: [
                .copy("Fixtures"),
            ]
        ),
    ]
)
