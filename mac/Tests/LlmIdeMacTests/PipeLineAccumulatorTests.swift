import Foundation
import Testing
@testable import LlmIdeMacLib

@Suite("PipeLineAccumulator")
struct PipeLineAccumulatorTests {
    @Test func multiByteCharacterSplitAcrossChunksSurvives() {
        var acc = PipeLineAccumulator()
        let bytes = Array("エラー: 失敗\n".utf8)
        // Split inside the first 3-byte character.
        #expect(acc.feed(Data(bytes[..<2])).isEmpty)
        #expect(acc.feed(Data(bytes[2...])) == ["エラー: 失敗"])
        #expect(acc.finish().isEmpty)
    }

    @Test func lineSplitAcrossChunksIsOneLine() {
        var acc = PipeLineAccumulator()
        #expect(acc.feed(Data("Error: boom\n    at foo (".utf8)) == ["Error: boom"])
        #expect(acc.feed(Data("a.mjs:1:2)\n".utf8)) == ["    at foo (a.mjs:1:2)"])
    }

    @Test func remainderIsFlushedAtEOFAndOnlyOnce() {
        var acc = PipeLineAccumulator()
        #expect(acc.feed(Data("one\r\ntwo".utf8)) == ["one"])
        #expect(acc.finish() == ["two"])
        #expect(acc.finish().isEmpty)
    }

    @Test func emptyLinesAreReported() {
        var acc = PipeLineAccumulator()
        #expect(acc.feed(Data("a\n\nb\n".utf8)) == ["a", "", "b"])
    }

    @Test func overlongUnterminatedLineIsEmittedNotHoarded() {
        var acc = PipeLineAccumulator()
        let big = Data(repeating: 0x61, count: PipeLineAccumulator.maxPendingBytes + 1)
        let lines = acc.feed(big)
        #expect(lines.count == 1)
        #expect(lines.first?.utf8.count == PipeLineAccumulator.maxPendingBytes + 1)
        #expect(acc.finish().isEmpty)
    }
}
