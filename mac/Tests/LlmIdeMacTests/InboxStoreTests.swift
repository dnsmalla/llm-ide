import Testing
import Foundation
@testable import LlmIdeMac

@Suite("InboxStore")
struct InboxStoreTests {
  private func tmpRoot() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-\(UUID().uuidString)")
  }

  @Test func writesHeaderBlockThenBlankLineThenBody() throws {
    let root = tmpRoot()
    let store = InboxStore(root: root)
    let url = try store.write(from: "aki@co.com", date: Date(timeIntervalSince1970: 1_780_000_000),
                              subject: "Q3 numbers", body: "please send Q3")
    let text = try String(contentsOf: url, encoding: .utf8)
    #expect(text.hasPrefix("From: aki@co.com\nSubject: Q3 numbers\nDate: "))
    #expect(text.contains("\n\nplease send Q3"))
  }

  @Test func writesUnderYearMonthSubfolders() throws {
    let root = tmpRoot()
    let store = InboxStore(root: root)
    let url = try store.write(from: "a@b.com", date: Date(timeIntervalSince1970: 1_780_000_000),
                              subject: "hi", body: "hello")
    let comps = url.pathComponents
    #expect(comps.contains("2026"))
    #expect(comps.contains("06"))
    #expect(url.pathExtension == "txt")
  }

  @Test func emptySubjectFallsBackToItemSlug() throws {
    let root = tmpRoot()
    let store = InboxStore(root: root)
    let url = try store.write(from: "a@b.com", date: Date(timeIntervalSince1970: 1_780_000_000),
                              subject: "", body: "hello")
    #expect(url.lastPathComponent.contains("item"))
  }
}
