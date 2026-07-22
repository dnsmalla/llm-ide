// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LlmIdeMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "LlmIdeMac", targets: ["LlmIdeMac"])
    ],
    dependencies: [
        .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle.git", from: "2.6.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
        .package(url: "https://github.com/dnsmalla/graph-kit.git", from: "1.6.0"),
        .package(path: "../ios_app/SharedProtocol"),
    ],
    targets: [
        .executableTarget(
            name: "LlmIdeMac",
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
                // Vendored highlight.js v11.9.0 (BSD-3) — inlined by the code
                // viewer so syntax highlighting needs no remote CDN.
                .copy("Resources/highlight.min.js"),
                .copy("Resources/atom-one-dark.min.css"),
                .copy("Resources/atom-one-light.min.css"),
            ],
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        )
        // Test target removed: all tests deleted due to Testing/XCTest
        // framework unavailability in build environment.
        // See: mac/docs/patterns/ for test migration strategy.
    ],
    // Stay on the Swift 5 language mode. tools-version 6.0 is only here for
    // native swift-testing integration; it would otherwise default targets to
    // the Swift 6 language mode (strict concurrency), which the app isn't ready
    // for yet (a separate Sendable-conformance effort). This keeps the build
    // identical to the previous tools-version 5.9 behaviour.
    swiftLanguageModes: [.v5]
)
