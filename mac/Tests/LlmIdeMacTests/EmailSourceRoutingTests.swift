import Testing
import Foundation
@testable import LlmIdeMac

@Suite("EmailSource routing")
struct EmailSourceRoutingTests {
  // EmailSource.route(...) is a pure helper extracted from makeNote so it can be
  // unit-tested without a network client. It decides the write action.
  @Test func bulkSenderRoutesToSkippedWithoutClassifying() {
    let decision = EmailSource.routeDecision(from: "noreply@shop.com", classification: nil)
    #expect(decision == .skipped(category: "bulk"))
  }
  @Test func noteWorthyClassificationRoutesToNote() {
    let c = LlmIdeAPIClient.EmailClassification(category: "work", noteWorthy: true, summary: "s", todos: [])
    let decision = EmailSource.routeDecision(from: "aki@co.com", classification: c)
    #expect(decision == .note(c))
  }
  @Test func skipCategoryRoutesToSkipped() {
    let c = LlmIdeAPIClient.EmailClassification(category: "newsletter", noteWorthy: false, summary: "", todos: [])
    let decision = EmailSource.routeDecision(from: "news@co.com", classification: c)
    #expect(decision == .skipped(category: "newsletter"))
  }
  @Test func classifyErrorRoutesToUnclassified() {
    let decision = EmailSource.routeDecision(from: "aki@co.com", classification: nil, classifyFailed: true)
    #expect(decision == .skipped(category: "unclassified"))
  }
}
