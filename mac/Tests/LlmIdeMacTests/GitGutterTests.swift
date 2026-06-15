import Testing
@testable import LlmIdeMac

@Suite struct GitGutterTests {
    @Test func extractsAddedAndModifiedNewSideLines() {
        let diff = """
        @@ -1,2 +1,3 @@
         keep
        -old
        +new1
        +new2
        """
        let map = GitGutter.changedLines(fromDiff: diff)
        // new1 replaces old (modified region), new2 is an addition — both on new side
        #expect(map[2] != nil)   // new1 at new-line 2
        #expect(map[3] != nil)   // new2 at new-line 3
        #expect(map[1] == nil)   // context line unchanged
    }
}
