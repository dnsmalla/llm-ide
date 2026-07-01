import Testing
import GraphKit
import Foundation
@testable import LlmIdeMac

@MainActor
struct CodeNotePipelineIntegrationTests {
    /// Mock launcher for the structural pipeline. Intercepts every process
    /// call: `git ls-files` returns the repo's code files; anything else
    /// (python3 AST scan, the background note agent) returns benign output.
    final class ScriptedLauncher: ProcessLauncher, @unchecked Sendable {
        func run(executable: URL, arguments: [String], currentDirectory: URL?, environment: [String: String]?) async throws -> (Int32, Data, Data) {
            if arguments.contains("ls-files") {
                return (0, Data("a.ts\nb.ts\n".utf8), Data())
            }
            // python3 AST scan → no Python files; note agent → no-op.
            return (0, Data("{}".utf8), Data())
        }
    }

    @Test func structuralPipelineBuildsGraphFromImports() async throws {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pipeline-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }

        // Real source files on disk — RipgrepExtractor reads them.
        try "import { x } from './b'\nexport function foo() {}\n"
            .write(to: repo.appendingPathComponent("a.ts"), atomically: true, encoding: .utf8)
        try "export const y = 1\n"
            .write(to: repo.appendingPathComponent("b.ts"), atomically: true, encoding: .utf8)

        let service = CodeNoteService(
            launcher: ScriptedLauncher(),
            cliExecutable: URL(fileURLWithPath: "/usr/bin/true"))
        // generate() returns the deterministic skeleton immediately (note
        // enrichment continues in the background and is not asserted here).
        let data = try await service.generate(repoRoot: repo).get()

        // Two file nodes from the structural scan.
        #expect(data.nodes.contains { $0.id == "file:a.ts" && $0.kind == .file })
        #expect(data.nodes.contains { $0.id == "file:b.ts" })

        // The import a.ts -> b.ts was resolved deterministically (no LLM).
        #expect(data.edges.contains {
            $0.fromId == "file:a.ts" && $0.toId == "file:b.ts" && $0.kind == .imports
        })

        // File nodes carry an absolute fileURL so the detail panel can show content.
        let a = data.nodes.first { $0.id == "file:a.ts" }
        #expect(a?.metadata["fileURL"]?.hasPrefix("file://") == true)
    }
}
