import Testing
import Foundation
@testable import LlmIdeMac

@Suite("EmailNoteStore")
struct EmailNoteStoreTests {
  private func write(_ root: URL, _ rel: String, _ body: String) throws {
    let u = root.appendingPathComponent(rel)
    try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
    try body.data(using: .utf8)!.write(to: u)
  }
  @Test func scansOnlyOpenTodos() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("em-\(UUID().uuidString)")
    try write(root, "2026/07/a.md", """
    ---
    source: email
    from: "aki@co.com"
    date: 2026-07-04T09:00:00Z
    category: action_request
    noteWorthy: true
    todos:
      - title: "Send Q3"
        detail: "by Fri"
        due: "2026-07-10"
        priority: high
        issue: null
      - title: "Book room"
        detail: "for review"
        due: null
        priority: med
        issue: "https://gl/issues/9"
    ---
    # Quarterly review

    ## To-dos
    """)
    try write(root, "2026/07/b.md", """
    ---
    source: email
    from: "news@co.com"
    date: 2026-07-04T09:00:00Z
    category: newsletter
    noteWorthy: false
    skipped: newsletter
    ---
    # Weekly digest
    """)
    let todos = EmailNoteStore(root: root).scanOpenTodos()
    #expect(todos.count == 1)
    #expect(todos[0].title == "Send Q3")
    #expect(todos[0].subject == "Quarterly review")
    #expect(todos[0].todoIndex == 0)
  }
}
