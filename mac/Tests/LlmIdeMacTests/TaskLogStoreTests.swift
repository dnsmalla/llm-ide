import Testing
import Foundation
@testable import LlmIdeMac

@Suite("TaskLogStore + LineAccumulator", .serialized)
struct TaskLogStoreTests {

    // MARK: - LineAccumulator (pure value type)

    @Test func accumulatorEmitsCompleteLinesOnly() {
        var acc = LineAccumulator()
        #expect(acc.feed("alpha\nbet") == ["alpha"])   // "bet" is partial, kept
        #expect(acc.flush() == "bet")
    }

    @Test func accumulatorHandlesMultipleLinesPerChunk() {
        var acc = LineAccumulator()
        #expect(acc.feed("a\nb\n") == ["a", "b"])
        #expect(acc.flush() == nil)
    }

    @Test func accumulatorJoinsSplitLineAcrossChunks() {
        var acc = LineAccumulator()
        #expect(acc.feed("al") == [])
        #expect(acc.feed("pha\nbet") == ["alpha"])
        #expect(acc.flush() == "bet")
    }

    @Test func accumulatorFlushIsEmptyForNoPending() {
        var acc = LineAccumulator()
        #expect(acc.feed("done\n") == ["done"])
        #expect(acc.flush() == nil)
    }

    // MARK: - TaskLogStore (MainActor)

    @MainActor
    @Test func appendStoresLineUnderTaskKey() {
        let store = TaskLogStore()
        store.append(.reviewCode, "hello")
        let lines = store.lines(for: .reviewCode)
        #expect(lines.count == 1)
        #expect(lines.first?.text == "hello")
        #expect(lines.first?.level == .info)
    }

    @MainActor
    @Test func appendIgnoresBlankLines() {
        let store = TaskLogStore()
        store.append(.reviewDoc, "   \n")
        #expect(store.lines(for: .reviewDoc).isEmpty)
    }

    @MainActor
    @Test func tasksAreIsolatedByBuffer() {
        let store = TaskLogStore()
        store.append(.reviewCode, "a")
        store.append(.reviewDoc, "b")
        #expect(store.lines(for: .reviewCode).map(\.text) == ["a"])
        #expect(store.lines(for: .reviewDoc).map(\.text) == ["b"])
    }

    @MainActor
    @Test func clearWipesOnlyOneTask() {
        let store = TaskLogStore()
        store.append(.reviewCode, "a")
        store.append(.reviewDoc, "b")
        store.clear(.reviewCode)
        #expect(store.lines(for: .reviewCode).isEmpty)
        #expect(store.lines(for: .reviewDoc).map(\.text) == ["b"])
    }

    @MainActor
    @Test func ringBufferCapsAtMaxLines() {
        let store = TaskLogStore()
        for i in 0..<(TaskLogStore.maxLinesPerTask + 50) {
            store.append(.reviewCode, "line \(i)")
        }
        let lines = store.lines(for: .reviewCode)
        #expect(lines.count == TaskLogStore.maxLinesPerTask)
        // Oldest dropped; the first kept line is the one right after the cap overflow.
        #expect(lines.first?.text == "line 50")
    }
}
