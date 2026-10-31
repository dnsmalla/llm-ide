import XCTest
import SharedProtocol

final class MobileProtocolTests: XCTestCase {
    func testServiceTypeMatchesLlmIde() {
        XCTAssertEqual(MobileProtocol.serviceType, "_llmide._tcp")
    }

    func testDefaultPort() {
        XCTAssertEqual(MobileProtocol.defaultPort, 3006)
    }

    func testHeartbeatIntervals() {
        XCTAssertEqual(MobileProtocol.heartbeatInterval, 10)
        XCTAssertEqual(MobileProtocol.heartbeatTimeout, 25)
    }

    /// `Tag.all` is hand-maintained; parse the declaring source so a tag added without being listed fails here.
    func testTagAllListsEveryTag() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/SharedProtocol/MobileProtocol.swift")
        let text = try String(contentsOf: source, encoding: .utf8)
        let tagBody = String(text[text.range(of: "public enum Tag {")!.upperBound...])
        let regex = try NSRegularExpression(pattern: #"public static let (\w+) = "([^"]+)""#)
        let range = NSRange(tagBody.startIndex..., in: tagBody)
        let declared = regex.matches(in: tagBody, range: range).compactMap { m -> String? in
            Range(m.range(at: 2), in: tagBody).map { String(tagBody[$0]) }
        }
        XCTAssertGreaterThan(declared.count, 90)
        XCTAssertEqual(Set(MobileProtocol.Tag.all), Set(declared),
                       "MobileProtocol.Tag.all and the declared tags diverged")
        XCTAssertEqual(MobileProtocol.Tag.all.count, Set(MobileProtocol.Tag.all).count, "duplicate tag value")
    }
}
