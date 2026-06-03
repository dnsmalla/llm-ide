import Testing
@testable import MeetNotesMac

struct BatchPlannerTests {
    @Test func importConnectedFilesShareABatch() {
        // a imports b; c is isolated. With maxBatchSize 10, {a,b} together.
        let imports = ["a": ["b"], "b": [], "c": []]
        let batches = BatchPlanner.plan(files: ["a", "b", "c"], imports: imports, maxBatchSize: 10)
        let batchOfA = batches.first { $0.files.contains("a") }!
        #expect(batchOfA.files.contains("b"))
        #expect(!batchOfA.files.contains("c"))
    }

    @Test func respectsMaxBatchSize() {
        // 5 mutually-connected files, maxBatchSize 2 → at least 3 batches.
        let imports = ["a": ["b"], "b": ["c"], "c": ["d"], "d": ["e"], "e": ["a"]]
        let files = ["a", "b", "c", "d", "e"]
        let batches = BatchPlanner.plan(files: files, imports: imports, maxBatchSize: 2)
        #expect(batches.allSatisfy { $0.files.count <= 2 })
        let total = batches.reduce(0) { $0 + $1.files.count }
        #expect(total == 5)
    }

    @Test func neighborMapHasCrossBatchImports() {
        // a imports b but maxBatchSize 1 forces them apart; a's neighborMap
        // should include b.
        let imports = ["a": ["b"], "b": []]
        let batches = BatchPlanner.plan(files: ["a", "b"], imports: imports, maxBatchSize: 1)
        let batchOfA = batches.first { $0.files.contains("a") }!
        #expect(batchOfA.neighbors["a"]?.contains("b") == true)
    }

    @Test func emptyInputProducesNoBatches() {
        let batches = BatchPlanner.plan(files: [], imports: [:], maxBatchSize: 10)
        #expect(batches.isEmpty)
    }
}
