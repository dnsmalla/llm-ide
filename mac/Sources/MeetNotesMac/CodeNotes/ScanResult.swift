import Foundation

/// Phase 1 ground truth: deterministic structural facts the agent emits
/// by running git ls-files + ripgrep/ctags. Written to
/// `<repo>/.code-notes/scan.json` and decoded here.
public struct ScanResult: Codable, Equatable, Sendable {
    public struct FileEntry: Codable, Equatable, Sendable {
        public let path: String          // relative to repo root
        public let language: String
        public let loc: Int
    }
    public struct Symbol: Codable, Equatable, Sendable {
        public let name: String
        public let kind: String          // function | class | heading | ...
        public let line: Int
        /// Trimmed source declaration (everything up to `{` or end of line).
        public let declaration: String?
        public init(name: String, kind: String, line: Int, declaration: String? = nil) {
            self.name = name; self.kind = kind; self.line = line; self.declaration = declaration
        }
    }

    public let files: [FileEntry]
    /// path -> repo-internal import target paths (external packages dropped)
    public let imports: [String: [String]]
    /// path -> symbols defined in that file
    public let symbols: [String: [Symbol]]

    public init(files: [FileEntry],
                imports: [String: [String]],
                symbols: [String: [Symbol]]) {
        self.files = files
        self.imports = imports
        self.symbols = symbols
    }

    public static func decode(_ data: Data) throws -> ScanResult {
        do { return try AppJSON.decoder.decode(ScanResult.self, from: data) }
        catch { throw CodeNoteError.parseFailed(message: error.localizedDescription) }
    }
}
