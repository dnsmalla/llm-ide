import Foundation

/// Reads the Host API v1 contract straight from the repo, so these tests judge the same bytes
/// as `scripts/conformance-host-api.mjs`. Path: Tests/SharedProtocolTests/<file> → repo root is 5 levels up.
enum HostApiFixtures {
    static let root: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("schema/host-api/v1", isDirectory: true)
    }()

    static func data(_ relative: String) throws -> Data {
        try Data(contentsOf: root.appendingPathComponent(relative))
    }

    static func json(_ relative: String) throws -> Any {
        try JSONSerialization.jsonObject(with: data(relative), options: [.fragmentsAllowed])
    }

    static func names(_ dir: String) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(dir).path)
            .filter { $0.hasSuffix(".json") }
            .sorted()
    }
}
