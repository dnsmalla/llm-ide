import Testing
import Foundation
import CryptoKit
@testable import LlmIdeMac

@Suite("InboxGenerationPipeline")
struct InboxGenerationPipelineTests {
  private func tmpRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("gen-\(UUID().uuidString)")
  }

  private func seedFile(root: URL, from: String, subject: String, date: String, body: String) throws {
    let store = InboxStore(root: root)
    _ = try store.write(from: from, date: AppDateFormatter.parseISO(date) ?? Date(), subject: subject, body: body)
  }

  @Test func generatesForUnknownHashesOnly() async throws {
    let root = tmpRoot()
    try seedFile(root: root, from: "a@co.com", subject: "one", date: "2026-07-01T00:00:00Z", body: "body one")
    try seedFile(root: root, from: "b@co.com", subject: "two", date: "2026-07-02T00:00:00Z", body: "body two")

    // Discover the hash of "one" up front so we can mark it as already-known.
    var discovered: [String] = []
    _ = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: []) { item in
      discovered.append(item.hash)
    }
    let knownHash = discovered.first { _ in true }! // any one hash from the first pass

    var generated: [String] = []
    let (processed, failures) = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: [knownHash]) { item in
      generated.append(item.subject)
    }
    #expect(processed == 1)
    #expect(failures.isEmpty)
    #expect(generated.count == 1)
  }

  @Test func parsesHeaderFieldsAndBody() async throws {
    let root = tmpRoot()
    try seedFile(root: root, from: "aki@co.com", subject: "Q3 numbers", date: "2026-07-01T09:00:00Z", body: "please send Q3")

    var seen: RawInboxItem?
    _ = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: []) { item in
      seen = item
    }
    #expect(seen?.from == "aki@co.com")
    #expect(seen?.subject == "Q3 numbers")
    #expect(seen?.body == "please send Q3")
  }

  @Test func oneFailureDoesNotStopTheRest() async throws {
    let root = tmpRoot()
    try seedFile(root: root, from: "a@co.com", subject: "one", date: "2026-07-01T00:00:00Z", body: "body one")
    try seedFile(root: root, from: "b@co.com", subject: "two", date: "2026-07-02T00:00:00Z", body: "body two")

    enum Boom: Error { case bad }
    var attempted: [String] = []
    let (processed, failures) = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: []) { item in
      attempted.append(item.subject)
      if item.subject == "one" { throw Boom.bad }
    }
    #expect(attempted.count == 2)
    #expect(processed == 1)
    #expect(failures.count == 1)
  }

  @Test func emptyInboxProducesNoWork() async {
    let root = tmpRoot()
    let (processed, failures) = await InboxGenerationPipeline.run(inboxRoot: root, knownHashes: []) { _ in }
    #expect(processed == 0)
    #expect(failures.isEmpty)
  }
}
