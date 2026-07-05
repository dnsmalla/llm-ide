import Testing
import Foundation
import Yams
@testable import LlmIdeMac

@Suite("EmailFileStore")
struct EmailFileStoreTests {
  private func tmpRoot() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("eml-\(UUID().uuidString)")
    return u
  }
  @Test func writesNoteWithFrontmatterAndTodos() throws {
    let root = tmpRoot()
    let store = EmailFileStore(root: root)
    let c = LlmIdeAPIClient.EmailClassification(
      category: "action_request", noteWorthy: true, summary: "Aki needs Q3.",
      todos: [.init(title: "Send Q3", detail: "by Fri", due: "2026-07-10", priority: "high")])
    let url = try store.writeNote(from: "aki@co.com",
      date: Date(timeIntervalSince1970: 1_780_000_000), subject: "Q3 numbers",
      classification: c, originalBody: "please send Q3", sourceHash: "hash123")
    let text = try String(contentsOf: url, encoding: .utf8)
    #expect(text.contains("source: email"))
    #expect(text.contains("category: action_request"))
    #expect(text.contains("noteWorthy: true"))
    #expect(text.contains("sourceHash: \"hash123\""))
    #expect(text.contains("title: \"Send Q3\""))
    #expect(text.contains("issue: null"))
    #expect(text.contains("**Summary:** Aki needs Q3."))
    #expect(text.contains("- [ ] Send Q3"))
    #expect(text.contains("please send Q3"))
  }
  @Test func writesSkippedRawStub() throws {
    let root = tmpRoot()
    let store = EmailFileStore(root: root)
    let url = try store.writeSkipped(from: "news@co.com",
      date: Date(timeIntervalSince1970: 1_780_000_000), subject: "Weekly",
      category: "newsletter", originalBody: "digest", sourceHash: "hash456")
    let text = try String(contentsOf: url, encoding: .utf8)
    #expect(text.contains("noteWorthy: false"))
    #expect(text.contains("skipped: newsletter"))
    #expect(text.contains("sourceHash: \"hash456\""))
    #expect(text.contains("digest"))
    #expect(!text.contains("## To-dos"))
  }
  @Test func isBulkSenderMatchesNoReply() {
    #expect(EmailFileStore.isBulkSender("No-Reply@example.com"))
    #expect(EmailFileStore.isBulkSender("Store <noreply@shop.com>"))
    #expect(EmailFileStore.isBulkSender("donotreply@bank.com"))
    #expect(!EmailFileStore.isBulkSender("aki@company.com"))
  }
  @Test func existingSourceHashesCollectsHashesFromNotesOnly() throws {
    let root = tmpRoot()
    let store = EmailFileStore(root: root)
    let c = LlmIdeAPIClient.EmailClassification(category: "work", noteWorthy: true, summary: "s", todos: [])
    _ = try store.writeNote(from: "a@co.com", date: Date(timeIntervalSince1970: 1_780_000_000),
      subject: "one", classification: c, originalBody: "b1", sourceHash: "hashA")
    _ = try store.writeSkipped(from: "b@co.com", date: Date(timeIntervalSince1970: 1_780_100_000),
      subject: "two", category: "bulk", originalBody: "b2", sourceHash: "hashB")
    let hashes = store.existingSourceHashes()
    #expect(hashes == Set(["hashA", "hashB"]))
  }
}
