import Testing
import Foundation
@testable import LlmIdeMacLib

@Suite("HostApiV1Origins")
struct HostApiV1OriginsTests {
    struct Fixture: Decodable {
        struct Case: Decodable { let origin: String?; let refused: Bool }
        let allowlist: String
        let parsed: [String]
        let cases: [Case]
    }

    static func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../schema/host-api/v1/fixtures/security/origins.json").standardized
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    @Test("parse matches the shared fixture and logs each dropped entry")
    func parse() throws {
        let f = try Self.fixture()
        var logged: [String] = []
        #expect(HostApiV1Origins.parse(f.allowlist, log: { logged.append($0) }) == f.parsed)
        #expect(logged.count == 7)
    }

    @Test("refused matches every fixture case")
    func refused() throws {
        let f = try Self.fixture()
        for c in f.cases {
            let headers: [(name: String, value: String)] = c.origin.map { [("Origin", $0)] } ?? []
            #expect(HostApiV1Origins.refused(headers: headers, allowlist: f.parsed) == c.refused, "origin \(String(describing: c.origin))")
        }
    }

    @Test("configured prefers the env value over UserDefaults, and is empty when neither is set")
    func configured() throws {
        let suite = "h6-test-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(HostApiV1Origins.configured(environment: [:], defaults: defaults) == "")
        defaults.set("https://from.defaults", forKey: "HostApiV1.webOrigins")
        #expect(HostApiV1Origins.configured(environment: [:], defaults: defaults) == "https://from.defaults")
        #expect(HostApiV1Origins.configured(environment: ["LLMIDE_HOST_API_WEB_ORIGINS": "https://from.env"], defaults: defaults) == "https://from.env")
    }
}
