// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MeetNotesMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "MeetNotesMac", targets: ["MeetNotesMac"])
    ],
    dependencies: [
        .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle.git", from: "2.6.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
        .package(url: "https://github.com/dnsmalla/graph-kit.git", from: "1.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "MeetNotesMac",
            dependencies: [
                "Yams",
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "GraphKit", package: "graph-kit"),
            ],
            path: "Sources/MeetNotesMac",
            resources: [
                .copy("Resources/note_template.docx"),
                .copy("Resources/generate_meeting_note.py"),
            ],
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        ),
        .testTarget(
            name: "MeetNotesMacTests",
            dependencies: ["MeetNotesMac"],
            path: "Tests/MeetNotesMacTests",
            swiftSettings: [
                .unsafeFlags([
                    "-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xfrontend", "-disable-cross-import-overlays"
                ])
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-framework", "Testing",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"
                ])
            ]
        )
    ]
)
