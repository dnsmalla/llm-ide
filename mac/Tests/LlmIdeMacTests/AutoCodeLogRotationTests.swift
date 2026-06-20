import Testing
import Foundation
@testable import LlmIdeMac

struct AutoCodeLogRotationTests {
    private func tmpDir() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("logrot-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    @Test func rotateMovesExistingLogToPrev() throws {
        let dir = try tmpDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("auto-task-review-code.log")
        try "first run".write(to: log, atomically: true, encoding: .utf8)

        AutoCodeUpdateService.rotateLog(at: log)

        let prev = dir.appendingPathComponent("auto-task-review-code.prev.log")
        #expect(FileManager.default.fileExists(atPath: prev.path))
        #expect(try String(contentsOf: prev, encoding: .utf8) == "first run")
        // The live path is now free for the caller to create fresh.
        #expect(!FileManager.default.fileExists(atPath: log.path))
    }

    @Test func rotateIsNoopWhenNoExistingLog() throws {
        let dir = try tmpDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("auto-task-review-doc.log")
        AutoCodeUpdateService.rotateLog(at: log)   // must not throw / create anything
        #expect(!FileManager.default.fileExists(atPath: log.path))
    }

    @Test func secondRotateOverwritesOlderPrev() throws {
        let dir = try tmpDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("auto-code-42.log")

        try "run 1".write(to: log, atomically: true, encoding: .utf8)
        AutoCodeUpdateService.rotateLog(at: log)              // run1 → .prev
        try "run 2".write(to: log, atomically: true, encoding: .utf8)
        AutoCodeUpdateService.rotateLog(at: log)              // run2 → .prev (run1 dropped)

        let prev = dir.appendingPathComponent("auto-code-42.prev.log")
        #expect(try String(contentsOf: prev, encoding: .utf8) == "run 2")
    }
}
