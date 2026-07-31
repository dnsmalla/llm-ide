import Foundation
import XCTest
@testable import LlmIdeMacLib

final class InboxStorePipelineTests: XCTestCase {
    func testInboxStoreWritesArbitraryHeadersAndBody() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("inbox-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let url = try InboxStore(root: tmp).write(
            headers: ["Channel": "#team", "User": "alice", "Ts": "1700000000.0001",
                      "Date": "2026-07-31T09:00:00Z"],
            body: "hello world",
            slug: "team-1700000000.0001")
        let contents = try String(contentsOf: url, encoding: .utf8)
        // `InboxStore.write` sorts headers by key, so output is byte-stable
        // (Channel < Date < Ts < User). Lock the sorted order + the blank-line
        // separator so the dedup hash invariant can't silently regress.
        let expectedPrefix = "Channel: #team\n"
            + "Date: 2026-07-31T09:00:00Z\n"
            + "Ts: 1700000000.0001\n"
            + "User: alice\n\n"
        XCTAssertTrue(contents.hasPrefix(expectedPrefix),
                      "header block must be key-sorted; got:\n\(contents)")
        XCTAssertTrue(contents.hasSuffix("\n\nhello world"))
        XCTAssertTrue(url.lastPathComponent.hasPrefix("20"))            // YYYY stamp
        XCTAssertTrue(url.lastPathComponent.contains("team-1700000000")) // slug present
    }
}

extension InboxStorePipelineTests {
    func testPipelineParsesArbitraryHeadersAndDedupsByHash() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("pipe-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        try InboxStore(root: tmp).write(
            headers: ["Channel": "#team", "User": "alice", "Date": "2026-07-31T09:00:00Z"],
            body: "standup", slug: "team-a")
        try InboxStore(root: tmp).write(
            headers: ["From": "boss@x", "Subject": "hi", "Date": "2026-07-31T10:00:00Z"],
            body: "email body", slug: "email-hi")

        var seen: [[String: String]] = []
        let result = await InboxGenerationPipeline.run(
            inboxRoot: tmp, knownHashes: []) { item in
                seen.append(item.headers)
            }
        XCTAssertEqual(result.processed, 2)
        XCTAssertEqual(result.failures, [])
        XCTAssertEqual(seen.count, 2)
        XCTAssertEqual(seen.compactMap { $0["Channel"] }, ["#team"])
        XCTAssertEqual(seen.compactMap { $0["From"] }, ["boss@x"])
    }

    func testPipelineSkipsItemsWhoseHashIsKnown() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("pipe-dedup-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try InboxStore(root: tmp).write(
            headers: ["Channel": "#team", "Date": "2026-07-31T09:00:00Z"],
            body: "once", slug: "team-x")

        var hash = ""
        _ = await InboxGenerationPipeline.run(inboxRoot: tmp, knownHashes: []) { item in hash = item.hash }

        var calls = 0
        let result = await InboxGenerationPipeline.run(inboxRoot: tmp, knownHashes: [hash]) { _ in calls += 1 }
        XCTAssertEqual(result.processed, 0)
        XCTAssertEqual(calls, 0)
    }
}

extension InboxStorePipelineTests {
    /// Email's routeDecision is pure — lock its behavior so the signature
    /// change in saveRaw/generateNote can't silently alter routing.
    func testEmailRouteDecisionUnchanged() {
        let worthy = LlmIdeAPIClient.EmailClassification(
            category: "work", noteWorthy: true, summary: "s", todos: [])
        let notWorthy = LlmIdeAPIClient.EmailClassification(
            category: "newsletter", noteWorthy: false, summary: "s", todos: [])

        XCTAssertEqual(EmailSource.routeDecision(from: "noreply@x.com", classification: worthy),
                       .skipped(category: "bulk"))
        XCTAssertEqual(EmailSource.routeDecision(from: "alice@x.com", classification: worthy),
                       .note(worthy))
        XCTAssertEqual(EmailSource.routeDecision(from: "alice@x.com", classification: notWorthy),
                       .skipped(category: "newsletter"))
        XCTAssertEqual(EmailSource.routeDecision(from: "alice@x.com", classification: nil, classifyFailed: true),
                       .skipped(category: "unclassified"))
    }
}
