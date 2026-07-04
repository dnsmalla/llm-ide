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

  @Test func markTodoCreatedClosesIt() throws {
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
    ---
    # Quarterly review

    ## To-dos

    - [ ] Send Q3 — due 2026-07-10 (high)
    """)
    let store = EmailNoteStore(root: root)
    let open = store.scanOpenTodos()
    #expect(open.count == 1)
    try store.markTodoCreated(file: open[0].file, todoIndex: 0, issueURL: "https://gl/issues/42")
    #expect(store.scanOpenTodos().isEmpty)
    let text = try String(contentsOf: open[0].file, encoding: .utf8)
    #expect(text.contains("https://gl/issues/42"))
  }

  @Test func markTodoCreatedPreservesBodyAndFlipsCheckbox() throws {
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
        issue: null
    ---
    # Quarterly review

    ## To-dos

    - [ ] Send Q3 — due 2026-07-10 (high)
    - [ ] Book room — for review (med)

    Some trailing note text that must survive verbatim.
    """)
    let store = EmailNoteStore(root: root)
    try store.markTodoCreated(file: root.appendingPathComponent("2026/07/a.md"), todoIndex: 0, issueURL: "https://gl/issues/42")
    let text = try String(contentsOf: root.appendingPathComponent("2026/07/a.md"), encoding: .utf8)
    #expect(text.contains("- [x] Send Q3 — due 2026-07-10 (high) — https://gl/issues/42"))
    #expect(text.contains("- [ ] Book room — for review (med)"))
    #expect(text.contains("Some trailing note text that must survive verbatim."))

    let remaining = store.scanOpenTodos()
    #expect(remaining.count == 1)
    #expect(remaining[0].title == "Book room")
  }

  @Test func markTodoCreatedThrowsOnOutOfRangeIndex() throws {
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
    ---
    # Quarterly review
    """)
    let store = EmailNoteStore(root: root)
    let file = root.appendingPathComponent("2026/07/a.md")
    #expect(throws: (any Error).self) {
      try store.markTodoCreated(file: file, todoIndex: 5, issueURL: "https://gl/issues/42")
    }
  }
}
