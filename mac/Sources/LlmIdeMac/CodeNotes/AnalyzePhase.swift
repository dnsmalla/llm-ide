import Foundation
import GraphKit

/// Runs the note-enrichment phase for one ``CodeBatch``: builds a prompt that
/// describes the batch's files, their symbols, and their import neighbors, then
/// invokes the configured CLI (e.g. `claude`) with the repo as the working
/// directory to write enriched notes under `notesDir`.
public struct AnalyzePhase {
    private let launcher: ProcessLauncher
    private let cliExecutable: URL

    public init(launcher: ProcessLauncher, cliExecutable: URL) {
        self.launcher = launcher
        self.cliExecutable = cliExecutable
    }

    public static func buildPrompt(batch: CodeBatch, scan: ScanResult, notesDir: String) -> String {
        var lines: [String] = []
        lines.append("Write one enriched code note per file into `\(notesDir)`.")
        lines.append("For each file, summarize its purpose and record import links to its neighbors.")
        lines.append("")

        for file in batch.files {
            lines.append("## \(file)")
            let symbols = scan.symbols[file] ?? []
            if !symbols.isEmpty {
                lines.append("Symbols: " + symbols.map(\.name).joined(separator: ", "))
            }
            let neighbors = batch.neighbors[file] ?? []
            if !neighbors.isEmpty {
                lines.append("imports / neighbors: " + neighbors.joined(separator: ", "))
            }
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    public func run(batch: CodeBatch, scan: ScanResult, repoRoot: URL) async -> Result<Void, CodeNoteError> {
        let prompt = Self.buildPrompt(batch: batch, scan: scan,
                                      notesDir: "system/graph/notes")
        do {
            let (code, _, stderr) = try await launcher.run(
                executable: cliExecutable,
                arguments: ["-p", prompt],
                currentDirectory: repoRoot,
                environment: nil)
            guard code == 0 else {
                let message = String(data: stderr, encoding: .utf8) ?? "exit \(code)"
                return .failure(.analyzeFailed(batch: batch.index, message: message))
            }
            return .success(())
        } catch {
            return .failure(.analyzeFailed(batch: batch.index, message: error.localizedDescription))
        }
    }
}
