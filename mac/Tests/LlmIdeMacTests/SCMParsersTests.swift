import Testing
import Foundation
@testable import LlmIdeMac

@Suite struct StatusParserTests {
    @Test func parsesStagedUnstagedUntrackedRenamed() {
        let porcelain = """
        M  staged.swift
         M unstaged.swift
        MM both.swift
        ?? new.txt
        A  added.swift
         D deleted.swift
        R  old.swift -> renamed.swift
        """
        let files = StatusParser.parse(porcelain: porcelain)

        // staged.swift → one staged modified
        #expect(files.contains { $0.path == "staged.swift" && $0.staged && $0.status == .modified })
        // unstaged.swift → one unstaged modified
        #expect(files.contains { $0.path == "unstaged.swift" && !$0.staged && $0.status == .modified })
        // both.swift → two entries (staged + unstaged)
        #expect(files.filter { $0.path == "both.swift" }.count == 2)
        // new.txt → untracked, unstaged
        #expect(files.contains { $0.path == "new.txt" && !$0.staged && $0.status == .untracked })
        // added.swift → staged added
        #expect(files.contains { $0.path == "added.swift" && $0.staged && $0.status == .added })
        // deleted.swift → unstaged deleted
        #expect(files.contains { $0.path == "deleted.swift" && !$0.staged && $0.status == .deleted })
        // rename → staged renamed, path is the new name
        #expect(files.contains { $0.path == "renamed.swift" && $0.staged && $0.status == .renamed })
    }

    @Test func emptyStatusYieldsNoFiles() {
        #expect(StatusParser.parse(porcelain: "").isEmpty)
        #expect(StatusParser.parse(porcelain: "\n").isEmpty)
    }
}

@Suite struct UnifiedDiffParserTests {
    @Test func parsesHunkWithInsertDeleteContext() {
        let diff = """
        diff --git a/f.swift b/f.swift
        index 111..222 100644
        --- a/f.swift
        +++ b/f.swift
        @@ -1,3 +1,3 @@
         let a = 1
        -let b = 2
        +let b = 20
         let c = 3
        """
        let hunks = UnifiedDiffParser.parse(diff)
        #expect(hunks.count == 1)
        let rows = hunks[0].rows
        // first row: context, old 1 / new 1
        #expect(rows[0].kind == .context && rows[0].oldLine == 1 && rows[0].newLine == 1)
        // delete row: old 2, no new
        #expect(rows.contains { $0.kind == .delete && $0.oldLine == 2 && $0.newLine == nil && $0.text == "let b = 2" })
        // insert row: new 2, no old
        #expect(rows.contains { $0.kind == .insert && $0.newLine == 2 && $0.oldLine == nil && $0.text == "let b = 20" })
    }

    @Test func emptyDiffYieldsNoHunks() {
        #expect(UnifiedDiffParser.parse("").isEmpty)
    }

    @Test func hunkHeaderWithFunctionContextDoesNotClobberLineNumbers() {
        let diff = """
        @@ -10,3 +12,3 @@ func add() -> Int {
         let a = 1
        -let b = 2
        +let b = 20
         let c = 3
        """
        let hunks = UnifiedDiffParser.parse(diff)
        #expect(hunks.count == 1)
        let rows = hunks[0].rows
        #expect(rows[0].oldLine == 10 && rows[0].newLine == 12)   // not 0
        #expect(rows.contains { $0.kind == .delete && $0.oldLine == 11 })
        #expect(rows.contains { $0.kind == .insert && $0.newLine == 13 })
    }
}
