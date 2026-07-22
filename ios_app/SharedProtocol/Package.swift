// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SharedProtocol",
    platforms: [
        .macOS(.v14),
        .iOS(.v16)
    ],
    products: [
        .library(name: "SharedProtocol", targets: ["SharedProtocol"]),
    ],
    targets: [
        .target(
            name: "SharedProtocol",
            path: "Sources/SharedProtocol"
        ),
        .testTarget(
            name: "SharedProtocolTests",
            dependencies: ["SharedProtocol"],
            path: "Tests/SharedProtocolTests"
        ),
    ]
)
