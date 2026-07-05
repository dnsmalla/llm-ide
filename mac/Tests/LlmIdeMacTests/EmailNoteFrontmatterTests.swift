import Testing
import Foundation
import Yams
@testable import LlmIdeMac

@Suite("EmailNoteFrontmatter sourceHash")
struct EmailNoteFrontmatterTests {
  @Test func decodesSourceHashWhenPresent() throws {
    let yaml = """
    source: email
    from: "aki@co.com"
    date: 2026-07-05T00:00:00Z
    category: work
    noteWorthy: true
    sourceHash: "abc123"
    todos: []
    """
    let fm = try YAMLDecoder().decode(EmailNoteFrontmatter.self, from: yaml)
    #expect(fm.sourceHash == "abc123")
  }

  @Test func sourceHashDefaultsToNilWhenAbsent() throws {
    let yaml = """
    source: email
    from: "aki@co.com"
    date: 2026-07-05T00:00:00Z
    category: work
    noteWorthy: true
    todos: []
    """
    let fm = try YAMLDecoder().decode(EmailNoteFrontmatter.self, from: yaml)
    #expect(fm.sourceHash == nil)
  }
}
