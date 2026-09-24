import Testing
import Foundation
@testable import LlmIdeMacLib

/// Unsaved editor text survives the view churn that used to destroy it.
@MainActor
@Suite("EditorDraftStore")
struct EditorDraftStoreTests {
    let a = URL(fileURLWithPath: "/p/src/A.swift")
    let b = URL(fileURLWithPath: "/p/src/B.swift")

    @Test("A dirty buffer is kept; a clean one clears it")
    func stashAndClear() {
        let s = EditorDraftStore()
        s.stash(a, content: "edited", base: "orig")
        #expect(s.draft(for: a) == .init(content: "edited", base: "orig"))
        #expect(s.hasDraft(a))
        s.stash(a, content: "orig", base: "orig")
        #expect(!s.hasDraft(a), "back to the saved text = no draft")
        s.stash(a, content: "edited", base: "orig")
        s.discard(a)
        #expect(!s.hasDraft(a))
    }

    @Test("Keys are path-based, so two URL spellings of one file share a draft")
    func keying() {
        let s = EditorDraftStore()
        s.stash(URL(fileURLWithPath: "/p/src/./A.swift"), content: "x", base: "")
        #expect(s.hasDraft(a))
    }

    @Test("A rename moves the file's draft and everything under a renamed folder")
    func rename() {
        let s = EditorDraftStore()
        s.stash(a, content: "x", base: "")
        s.stash(b, content: "y", base: "")
        s.rename(from: URL(fileURLWithPath: "/p/src"), to: URL(fileURLWithPath: "/p/lib"))
        #expect(!s.hasDraft(a))
        #expect(s.draft(for: URL(fileURLWithPath: "/p/lib/A.swift"))?.content == "x")
        #expect(s.draft(for: URL(fileURLWithPath: "/p/lib/B.swift"))?.content == "y")
        // A sibling file whose name merely starts with the old name is untouched.
        s.stash(URL(fileURLWithPath: "/p/lib-old/C.swift"), content: "z", base: "")
        s.rename(from: URL(fileURLWithPath: "/p/lib"), to: URL(fileURLWithPath: "/p/lib2"))
        #expect(s.draft(for: URL(fileURLWithPath: "/p/lib-old/C.swift"))?.content == "z")
    }

    @Test("Deleting a folder drops the drafts beneath it and nothing else")
    func discardUnder() {
        let s = EditorDraftStore()
        s.stash(a, content: "x", base: "")
        s.stash(URL(fileURLWithPath: "/p/other/D.swift"), content: "d", base: "")
        s.discardAll(under: URL(fileURLWithPath: "/p/src"))
        #expect(!s.hasDraft(a))
        #expect(s.hasDraft(URL(fileURLWithPath: "/p/other/D.swift")))
    }
}
