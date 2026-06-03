import Testing
import Foundation
@testable import MeetNotesMac

struct AnalyzePhaseTests {
    final class MockLauncher: ProcessLauncher, @unchecked Sendable {
        var capturedArgs: [String] = []
        var capturedCwd: URL?
        var exitCode: Int32 = 0
        func run(executable: URL, arguments: [String], currentDirectory: URL?, environment: [String: String]?) async throws -> (Int32, Data, Data) {
            capturedArgs = arguments
            capturedCwd = currentDirectory
            return (exitCode, Data(), Data())
        }
    }

    private func sampleBatch() -> CodeBatch {
        CodeBatch(index: 0, files: ["a.ts"], neighbors: ["a.ts": ["b.ts"]])
    }
    private func sampleScan() -> ScanResult {
        ScanResult(
            files: [.init(path: "a.ts", language: "typescript", loc: 10)],
            imports: ["a.ts": ["b.ts"]],
            symbols: ["a.ts": [.init(name: "foo", kind: "function", line: 3)]])
    }

    @Test func promptIncludesFilesSymbolsNeighborsAndNotesDir() {
        let prompt = AnalyzePhase.buildPrompt(batch: sampleBatch(), scan: sampleScan(),
                                              notesDir: ".code-notes/notes")
        #expect(prompt.contains("a.ts"))
        #expect(prompt.contains("foo"))
        #expect(prompt.contains("b.ts"))        // neighbor
        #expect(prompt.contains(".code-notes/notes"))
        #expect(prompt.contains("imports"))     // import-link instruction
    }

    @Test func runSucceedsOnZeroExitAndSetsCwd() async throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("analyze-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }

        let launcher = MockLauncher()
        let phase = AnalyzePhase(launcher: launcher, cliExecutable: URL(fileURLWithPath: "/usr/bin/true"))
        let result = await phase.run(batch: sampleBatch(), scan: sampleScan(), repoRoot: repo)
        if case .failure(let e) = result { Issue.record("expected success, got \(e)") }
        #expect(launcher.capturedCwd == repo)
    }

    @Test func runReportsAnalyzeFailedOnNonZeroExit() async {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("analyze-fail-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let launcher = MockLauncher()
        launcher.exitCode = 3
        let phase = AnalyzePhase(launcher: launcher, cliExecutable: URL(fileURLWithPath: "/usr/bin/true"))
        let result = await phase.run(batch: sampleBatch(), scan: sampleScan(), repoRoot: repo)
        guard case .failure(.analyzeFailed(let batch, _)) = result else {
            Issue.record("expected analyzeFailed, got \(result)"); return
        }
        #expect(batch == 0)
    }
}
