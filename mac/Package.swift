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
                .product(name: "GraphKit", package: "graph-kit"),
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
