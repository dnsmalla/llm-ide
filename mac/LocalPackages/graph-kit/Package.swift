// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GraphKit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "GraphKit", targets: ["GraphKit"]),
    ],
    dependencies: [
    ],
    targets: [
        .target(
            name: "GraphKit",
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
