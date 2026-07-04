import Testing
import Foundation
@testable import LlmIdeMac

@Suite("EmailClassification decode")
struct EmailClassificationDecodeTests {
  @Test func decodesFullPayload() throws {
    let json = """
    {"category":"action_request","noteWorthy":true,"summary":"Aki needs Q3 numbers.",
     "todos":[{"title":"Send Q3","detail":"by Fri","due":"2026-07-10","priority":"high"}]}
    """.data(using: .utf8)!
    let c = try JSONDecoder().decode(LlmIdeAPIClient.EmailClassification.self, from: json)
    #expect(c.category == "action_request")
    #expect(c.noteWorthy == true)
    #expect(c.todos.count == 1)
    #expect(c.todos[0].due == "2026-07-10")
  }
  @Test func decodesNullDueAndEmptyTodos() throws {
    let json = """
    {"category":"newsletter","noteWorthy":false,"summary":"","todos":[]}
    """.data(using: .utf8)!
    let c = try JSONDecoder().decode(LlmIdeAPIClient.EmailClassification.self, from: json)
    #expect(c.noteWorthy == false)
    #expect(c.todos.isEmpty)
  }
}
