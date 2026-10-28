import Foundation
import GraphCore

/// Runs the note-enrichment phase for one ``CodeBatch``.
///
/// Least privilege (review finding 2): the model runs READ-ONLY in the cloned
/// repo, with Read/Glob/Grep allowed and Edit/Write/Bash denied, and a turn cap.
/// It replies with the notes as delimited text. The app parses the reply,
/// keeps only blocks whose path is a file of this batch, and writes each note
/// itself to `<notesDir>/<path>.md`, where `notesDir` is the project's
/// `system/graph/` (see `GeneratedDataLocator`). Repo content therefore cannot
/// make the model write anything.
public struct AnalyzePhase {
    private let launcher: ProcessLauncher
    private let cliExecutable: URL

    /// Turn cap for the read-only enrichment run.
    static let maxTurns = 12
    /// A note body above this is dropped, not truncated.
    static let maxNoteBytes = 64 * 1024

    public init(launcher: ProcessLauncher, cliExecutable: URL) {
        self.launcher = launcher
        self.cliExecutable = cliExecutable
    }

    public static func buildPrompt(batch: CodeBatch, scan: ScanResult, notesDir: String) -> String {
        var lines: [String] = []
        lines.append("Write one short enriched code note for each file listed below.")
        lines.append("Reply with ONLY the notes, one block per file, in exactly this form:")
        lines.append("<<<NOTE path=RELATIVE/PATH>>>")
        lines.append("the note body in Markdown: what the file does, and links to its neighbours")
        lines.append("<<<END>>>")
        lines.append("Use each path exactly as listed. Do not write or edit any file: the app saves the notes under \(notesDir).")
        lines.append("Read a file only when you need it to describe it.")
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

    /// Arguments for the read-only enrichment run. Read/Glob/Grep are the only
    /// allowed tools; Edit, Write and Bash are denied; the turn count is capped.
    static func arguments(prompt: String) -> [String] {
        ClaudeCLI.promptArgs(prompt) + [
            "--allowedTools", "Read", "Glob", "Grep",
            "--disallowedTools", "Edit", "Write", "Bash",
            "--max-turns", String(maxTurns),
        ]
    }

    /// Parses `<<<NOTE path=…>>>` … `<<<END>>>` blocks from the model reply.
    /// Keeps a block only when its path is one of `allowed` (the batch's files),
    /// it is the first block for that path, and its body is non-empty and within
    /// `maxNoteBytes`.
    static func parseNotes(_ output: String, allowed: Set<String>) -> [(path: String, body: String)] {
        guard let regex = try? NSRegularExpression(
            pattern: #"<<<NOTE path=([^>\n]+)>>>\n([\s\S]*?)\n?<<<END>>>"#) else { return [] }
        let ns = output as NSString
        var seen = Set<String>()
        var notes: [(path: String, body: String)] = []
        for match in regex.matches(in: output, range: NSRange(location: 0, length: ns.length)) {
            let path = ns.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let body = ns.substring(with: match.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard allowed.contains(path), !seen.contains(path), !body.isEmpty,
                  body.utf8.count <= maxNoteBytes else { continue }
            seen.insert(path)
            notes.append((path, body))
        }
        return notes
    }

    /// Where the note for `path` is written: `<notesDir>/<path>.md`. Nil unless
    /// `path` is a plain relative path (no leading `/`, no `.`/`..`/empty parts)
    /// and the result stays inside `notesDir`.
    static func noteURL(notesDir: URL, path: String) -> URL? {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\0") else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
        let base = notesDir.standardizedFileURL
        let url = base.appendingPathComponent(path + ".md").standardizedFileURL
        guard url.path.hasPrefix(base.path + "/") else { return nil }
        return url
    }

    public func run(batch: CodeBatch, scan: ScanResult, repoRoot: URL) async -> Result<Void, CodeNoteError> {
        let notesDir = GeneratedDataLocator.graphDir(forRepo: repoRoot)
        let prompt = Self.buildPrompt(batch: batch, scan: scan, notesDir: notesDir.path)
        do {
            let (code, stdout, stderr) = try await launcher.run(
                executable: cliExecutable,
                arguments: Self.arguments(prompt: prompt),
                currentDirectory: repoRoot,
                environment: nil)
            guard code == 0 else {
                let message = String(data: stderr, encoding: .utf8) ?? "exit \(code)"
                return .failure(.analyzeFailed(batch: batch.index, message: message))
            }
            let reply = String(data: stdout, encoding: .utf8) ?? ""
            let notes = Self.parseNotes(reply, allowed: Set(batch.files))
            guard !notes.isEmpty else {
                return .failure(.analyzeFailed(batch: batch.index, message: "reply held no valid note blocks"))
            }
            for note in notes {
                guard let url = Self.noteURL(notesDir: notesDir, path: note.path) else { continue }
                do {
                    try FileManager.default.createDirectory(
                        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try (note.body + "\n").write(to: url, atomically: true, encoding: .utf8)
                } catch {
                    return .failure(.analyzeFailed(batch: batch.index, message: error.localizedDescription))
                }
            }
            return .success(())
        } catch {
            return .failure(.analyzeFailed(batch: batch.index, message: error.localizedDescription))
        }
    }
}
