import Testing
@testable import LlmIdeMac

@Suite struct GitGutterTests {
    @Test func insertsFollowingADeleteAreModified() {
        // A delete followed by inserts is a replaced region: every insert in
        // that run is `.modified` (not `.added`).
        let diff = """
        @@ -1,2 +1,3 @@
         keep
        -old
        +new1
        +new2
        """
        let map = GitGutter.changedLines(fromDiff: diff)
        #expect(map[1] == nil)             // context line unchanged
        #expect(map[2] == .modified)       // new1 — replaces `old`
        #expect(map[3] == .modified)       // new2 — still part of the replaced run
    }

    @Test func pureInsertWithNoPrecedingDeleteIsAdded() {
        // Inserts with no delete in the run are `.added`.
        let diff = """
        @@ -1,1 +1,3 @@
         keep
        +addedA
        +addedB
        """
        let map = GitGutter.changedLines(fromDiff: diff)
        #expect(map[1] == nil)
        #expect(map[2] == .added)
        #expect(map[3] == .added)
    }

    @Test func runFlagResetsAcrossContextAndHunks() {
        // The delete-run flag must reset on a context line and at each hunk,
        // so a later pure insert is `.added`, not `.modified`.
        let diff = """
        @@ -1,3 +1,3 @@
         keep
        -gone
        +repl
         tail
        @@ -10,1 +10,2 @@
         anchor
        +fresh
        """
        let map = GitGutter.changedLines(fromDiff: diff)
        #expect(map[2] == .modified)   // repl replaces gone (first hunk)
        #expect(map[11] == .added)     // fresh — new hunk, no preceding delete
    }
}
