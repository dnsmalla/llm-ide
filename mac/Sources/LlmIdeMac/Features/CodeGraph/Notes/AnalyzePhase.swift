import Foundation
import GraphCore

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
        lines.append("Write one enriched code note per file into `system/graph/`.")
        lines.append("These are code notes that become part of the graph - write them directly into the graph folder.")
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

    /// Arguments for the headless enrichment run. Edits are unattended
    /// (`acceptEdits`, the same mode the other headless runs use). The notes dir
    /// is the project's `system/graph/`, which is outside the cloned repo the CLI
    /// runs in, so it is granted with `--add-dir`. A notes dir inside `repoRoot`
    /// (the project root itself) needs no grant.
    static func arguments(prompt: String, notesDir: URL, repoRoot: URL) -> [String] {
        var args = ClaudeCLI.promptArgs(prompt) + ClaudeCLI.unattendedPermissionArgs
        let notes = notesDir.standardizedFileURL.path
        let repo = repoRoot.standardizedFileURL.path
        if !(notes == repo || notes.hasPrefix(repo + "/")) {
            args += ["--add-dir", notes]
        }
        return args
    }

    public func run(batch: CodeBatch, scan: ScanResult, repoRoot: URL) async -> Result<Void, CodeNoteError> {
        let notesDir = GeneratedDataLocator.graphDir(forRepo: repoRoot)
        let prompt = Self.buildPrompt(batch: batch, scan: scan, notesDir: notesDir.path)
        do {
            let (code, _, stderr) = try await launcher.run(
                executable: cliExecutable,
                arguments: Self.arguments(prompt: prompt, notesDir: notesDir, repoRoot: repoRoot),
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
