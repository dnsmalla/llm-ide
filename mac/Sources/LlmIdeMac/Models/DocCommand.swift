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
    /// Which generation menu this command belongs to (`TemplateSurface`).
    var surface: TemplateSurface

    init(
        id: UUID,
        name: String,
        instruction: String,
        rawContent: String? = nil,
        isBuiltin: Bool = false,
        folderName: String? = nil,
        isProjectCommand: Bool = false,
        surface: TemplateSurface = .default
    ) {
        self.id = id
        self.name = name
        self.instruction = instruction
        self.rawContent = rawContent
        self.isBuiltin = isBuiltin
        self.folderName = folderName
        self.isProjectCommand = isProjectCommand
        self.surface = surface
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
        var surface: TemplateSurface = .default

        func markdown() -> String {
            DocCommand.markdownBody(name: name, instruction: instruction, surface: surface)
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
        // Visual surface — instructions for reading an image, which is what
        // that menu's sources are.
        SeedDefinition(
            id: UUID(uuidString: "B0000010-0000-4000-8000-000000000010")!,
            folderName: "describe-image",
            name: "Describe Image",
            instruction: "Describe what the selected image shows, in the order a reader would notice it. Name concrete elements — labels, values, controls, people, layout — rather than summarising the impression. Say plainly when something is unreadable rather than guessing at it.",
            surface: .visual),
        SeedDefinition(
            id: UUID(uuidString: "B0000011-0000-4000-8000-000000000011")!,
            folderName: "extract-text",
            name: "Extract Text",
            instruction: "Transcribe every piece of text visible in the selected image, preserving its reading order and grouping. Keep labels with their values. Mark anything you cannot read confidently as [unclear] instead of inventing it.",
            surface: .visual),
        SeedDefinition(
            id: UUID(uuidString: "B0000012-0000-4000-8000-000000000012")!,
            folderName: "read-chart",
            name: "Read Chart",
            instruction: "Read the selected chart or diagram. State what is being measured, over what range, and what the data actually says — including the trend and any outlier. Quote axis labels and units verbatim, and say when a value can only be estimated from the image.",
            surface: .visual),
    ]

    /// Shipped skeletons when no project is open (fallback UI).
    static let builtins: [DocCommand] = seedDefinitions.map {
        DocCommand(
            id: $0.id,
            name: $0.name,
            instruction: $0.instruction,
            isBuiltin: true,
            folderName: $0.folderName,
            surface: $0.surface)
    }

    // MARK: - Markdown parsing

    /// Instruction body: everything except the `# Title` line and the marker.
    static func instruction(from markdown: String) -> String {
        let body = markdown
            .components(separatedBy: .newlines)
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("# ") { return false }
                // Matches the marker in EITHER form — bare, or carrying
                // `surface=visual`. An equality check against the bare marker
                // left the attributed line in the instruction body, so the
                // model would have been sent "<!-- llmide:doc-command
                // surface=visual -->" as part of its instruction.
                if trimmed.hasPrefix("<!--"), trimmed.contains("llmide:doc-command") { return false }
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
    static func markdownBody(name: String, instruction: String,
                             surface: TemplateSurface = .default) -> String {
        """
        # \(name)

        \(TemplateSurfaceMarker.line(base: markerComment, surface: surface))

        \(instruction)
        """
    }

    func renderedMarkdown() -> String {
        if let raw = rawContent, !raw.isEmpty { return raw }
        return Self.markdownBody(name: name, instruction: instruction, surface: surface)
    }

    /// The surface declared by a command file's own marker.
    static func surface(from markdown: String) -> TemplateSurface {
        TemplateSurfaceMarker.surface(in: markdown, base: markerComment)
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
