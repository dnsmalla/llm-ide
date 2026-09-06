import Foundation
import CryptoKit

/// A reusable instruction for Doc Gen, stored as Markdown exactly the way a
/// `DocTemplate` is. A template supplies document *structure* (`##` sections);
/// a command supplies *instructions*. Either one alone is enough to generate.
struct DocCommand: Identifiable, Codable, Equatable {
    let id: UUID
    var name: String
    /// Body text below the `# Title` line, sent to the server as the instruction.
    var instruction: String
    /// Raw markdown content of the source `.md` file, if loaded from disk.
    var rawContent: String?
    /// Shipped skeleton (used only when no project is open).
    let isBuiltin: Bool
    /// Subfolder name under `<project>/commands/`, e.g. `summarize`.
    var folderName: String?
    /// Loaded from or saved to the active project's `commands/` tree.
    var isProjectCommand: Bool

    init(
        id: UUID,
        name: String,
        instruction: String,
        rawContent: String? = nil,
        isBuiltin: Bool = false,
        folderName: String? = nil,
        isProjectCommand: Bool = false
    ) {
        self.id = id
        self.name = name
        self.instruction = instruction
        self.rawContent = rawContent
        self.isBuiltin = isBuiltin
        self.folderName = folderName
        self.isProjectCommand = isProjectCommand
    }

    /// Marker line written into every command file, mirroring
    /// `<!-- llmide:doc-template -->`. Lets the scanner tell a command file
    /// apart from any other `.md` that lands in the folder.
    static let markerComment = "<!-- llmide:doc-command -->"

    // MARK: - Seeds

    /// Default commands seeded into every project's `commands/<slug>/command.md`.
    struct SeedDefinition {
        let id: UUID
        let folderName: String
        let name: String
        let instruction: String

        func markdown() -> String {
            DocCommand.markdownBody(name: name, instruction: instruction)
        }
    }

    static let seedDefinitions: [SeedDefinition] = [
        SeedDefinition(
            id: UUID(uuidString: "B0000001-0000-4000-8000-000000000001")!,
            folderName: "summarize",
            name: "Summarize",
            instruction: "Summarize the selected sources. Lead with the single most important point, then give the supporting detail as short bullets. Omit anything the sources do not state."),
        SeedDefinition(
            id: UUID(uuidString: "B0000002-0000-4000-8000-000000000002")!,
            folderName: "explain-code",
            name: "Explain Code",
            instruction: "Explain the selected code for an engineer who is new to this codebase. Cover what it does, how it is used, and what it depends on. Reference concrete file and symbol names."),
        SeedDefinition(
            id: UUID(uuidString: "B0000003-0000-4000-8000-000000000003")!,
            folderName: "release-notes",
            name: "Release Notes",
            instruction: "Write release notes from the selected sources. Group changes under Added, Changed, and Fixed. Write each entry for a user of the product, not for its authors."),
    ]

    /// Shipped skeletons when no project is open (fallback UI).
    static let builtins: [DocCommand] = seedDefinitions.map {
        DocCommand(
            id: $0.id,
            name: $0.name,
            instruction: $0.instruction,
            isBuiltin: true,
            folderName: $0.folderName)
    }

    // MARK: - Markdown parsing

    /// Instruction body: everything except the `# Title` line and the marker.
    static func instruction(from markdown: String) -> String {
        let body = markdown
            .components(separatedBy: .newlines)
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("# ") { return false }
                if trimmed == markerComment { return false }
                return true
            }
            .joined(separator: "\n")
        return body.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Display name from `# Title` or a humanized folder slug.
    static func displayName(from markdown: String, folderName: String) -> String {
        for line in markdown.components(separatedBy: .newlines) {
            if line.hasPrefix("# ") {
                let title = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if !title.isEmpty { return title }
            }
        }
        return folderName
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

    /// Serialize back to editable `command.md` content.
    static func markdownBody(name: String, instruction: String) -> String {
        """
        # \(name)

        \(markerComment)

        \(instruction)
        """
    }

    func renderedMarkdown() -> String {
        if let raw = rawContent, !raw.isEmpty { return raw }
        return Self.markdownBody(name: name, instruction: instruction)
    }

    // MARK: - Identity

    /// Derive a filesystem-safe slug from a display name.
    static func slug(for name: String) -> String {
        let lowered = name.lowercased()
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-"))
        var slug = lowered
            .replacingOccurrences(of: " ", with: "-")
            .unicodeScalars
            .filter { allowed.contains($0) }
            .map { String($0) }
            .joined()
        while slug.contains("--") { slug = slug.replacingOccurrences(of: "--", with: "-") }
        slug = slug.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return slug.isEmpty ? "command" : slug
    }

    /// Stable id for a project command folder across rescans. The hash input is
    /// namespaced `llmide.doc-command.` so a command and a template sharing a
    /// folder name never collide on id.
    static func stableID(forFolder folderName: String) -> UUID {
        if let seed = seedDefinitions.first(where: { $0.folderName == folderName }) {
            return seed.id
        }
        let digest = SHA256.hash(data: Data("llmide.doc-command.\(folderName)".utf8))
        var bytes = Array(digest.prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x40
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    var isEditable: Bool { isProjectCommand || !isBuiltin }
}
