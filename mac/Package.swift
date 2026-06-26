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
        .package(url: "https://github.com/dnsmalla/graph-kit.git", from: "1.5.3"),
    ],
    targets: [
        .executableTarget(
            name: "LlmIdeMac",
            dependencies: [
                "Yams",
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "GraphKit", package: "graph-kit"),
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
        ),
        .testTarget(
            name: "LlmIdeMacTests",
            dependencies: ["LlmIdeMac"],
            path: "Tests/LlmIdeMacTests",
            exclude: ["README-skipped-tests.md"]
        )
        // swift-testing is linked natively by SwiftPM (tools-version 6.0+) from
        // the ACTIVE toolchain — no hardcoded -framework Testing / framework
        // search path. The old workaround pointed at CommandLineTools, whose
        // Testing.framework could be built with a different Swift than the
        // selected compiler ("failed to build module 'Testing' … the SDK is
        // built with X while this compiler is Y"); deriving it from the
        // toolchain makes that skew impossible.
    ],
    // Stay on the Swift 5 language mode. tools-version 6.0 is only here for
    // native swift-testing integration; it would otherwise default targets to
    // the Swift 6 language mode (strict concurrency), which the app isn't ready
    // for yet (a separate Sendable-conformance effort). This keeps the build
    // identical to the previous tools-version 5.9 behaviour.
    swiftLanguageModes: [.v5]
)
