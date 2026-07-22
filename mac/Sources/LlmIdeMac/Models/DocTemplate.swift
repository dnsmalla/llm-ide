import Foundation
import CryptoKit

struct DocTemplate: Identifiable, Codable, Equatable {
    let id: UUID
    var name: String
    var sections: [String]
    /// Raw markdown content of the source `.md` file, if loaded from disk.
    var rawContent: String?
    /// Legacy app-support templates only — not used for project `templates/` folders.
    let isBuiltin: Bool
    /// Subfolder name under `<project>/templates/`, e.g. `meeting-summary`.
    var folderName: String?
    /// Loaded from or saved to the active project's `templates/` tree.
    var isProjectTemplate: Bool

    init(
        id: UUID,
        name: String,
        sections: [String],
        rawContent: String? = nil,
        isBuiltin: Bool = false,
        folderName: String? = nil,
        isProjectTemplate: Bool = false
    ) {
        self.id = id
        self.name = name
        self.sections = sections
        self.rawContent = rawContent
        self.isBuiltin = isBuiltin
        self.folderName = folderName
        self.isProjectTemplate = isProjectTemplate
    }

    enum CodingKeys: String, CodingKey {
        case id, name, sections, rawContent, isBuiltin, folderName, isProjectTemplate
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        sections = try c.decode([String].self, forKey: .sections)
        rawContent = try c.decodeIfPresent(String.self, forKey: .rawContent)
        isBuiltin = try c.decodeIfPresent(Bool.self, forKey: .isBuiltin) ?? false
        folderName = try c.decodeIfPresent(String.self, forKey: .folderName)
        isProjectTemplate = try c.decodeIfPresent(Bool.self, forKey: .isProjectTemplate) ?? false
    }

    /// Default templates seeded into every project's `templates/<slug>/template.md`.
    struct SeedDefinition {
        let id: UUID
        let folderName: String
        let name: String
        let sections: [String]

        func markdown() -> String {
            DocTemplate.markdownBody(name: name, sections: sections)
        }
    }

    static let seedDefinitions: [SeedDefinition] = [
        SeedDefinition(
            id: UUID(uuidString: "A0000001-0000-4000-8000-000000000001")!,
            folderName: "meeting-summary",
            name: "Meeting Summary",
            sections: ["Key Decisions", "Action Items", "Blockers", "Next Steps"]),
        SeedDefinition(
            id: UUID(uuidString: "A0000002-0000-4000-8000-000000000002")!,
            folderName: "sprint-review",
            name: "Sprint Review",
            sections: ["Sprint Goal", "Completed Items", "Carry-overs", "Blockers & Risks", "Next Sprint Goals"]),
        SeedDefinition(
            id: UUID(uuidString: "A0000003-0000-4000-8000-000000000003")!,
            folderName: "decision-log",
            name: "Decision Log",
            sections: ["Context", "Decision", "Rationale", "Alternatives Considered", "Follow-ups"]),
        SeedDefinition(
            id: UUID(uuidString: "A0000004-0000-4000-8000-000000000004")!,
            folderName: "status-update",
            name: "Status Update",
            sections: ["Summary", "Completed This Period", "In Progress", "Risks", "Next Period"]),
        SeedDefinition(
            id: UUID(uuidString: "A0000005-0000-4000-8000-000000000005")!,
            folderName: "action-plan",
            name: "Action Plan",
            sections: ["Objective", "Actions", "Owners", "Timeline", "Success Criteria"]),
    ]

    /// Shipped skeletons when no project is open (fallback UI).
    static let builtins: [DocTemplate] = seedDefinitions.map {
        DocTemplate(
            id: $0.id,
            name: $0.name,
            sections: $0.sections,
            isBuiltin: true,
            folderName: $0.folderName)
    }

    /// Parse `## ` headings from a Markdown string into section names.
    static func sections(from markdown: String) -> [String] {
        let headings = markdown
            .components(separatedBy: .newlines)
            .filter { $0.hasPrefix("## ") }
            .map { String($0.dropFirst(3)).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return headings.isEmpty ? ["Content"] : headings
    }

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
        return slug.isEmpty ? "template" : slug
    }

    /// Stable id for a project template folder across rescans.
    static func stableID(forFolder folderName: String) -> UUID {
        if let seed = seedDefinitions.first(where: { $0.folderName == folderName }) {
            return seed.id
        }
        let digest = SHA256.hash(data: Data("llmide.doc-template.\(folderName)".utf8))
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

    /// Serialize sections back to editable `template.md` content.
    static func markdownBody(name: String, sections: [String]) -> String {
        var lines = [
            "# \(name)",
            "",
            "<!-- llmide:doc-template -->",
            "",
            "Document template for Doc Gen. Edit the `##` sections below to change structure.",
            "",
        ]
        for section in sections where !section.isEmpty {
            lines.append("## \(section)")
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    func renderedMarkdown() -> String {
        if let raw = rawContent, !raw.isEmpty { return raw }
        return Self.markdownBody(name: name, sections: sections)
    }

    var isEditable: Bool {
        isProjectTemplate || !isBuiltin
    }
}

enum DocGenSource: Hashable {
    case meeting(id: String, title: String)
    case file(url: URL, name: String)

    var displayName: String {
        switch self {
        case .meeting(_, let title): return title
        case .file(_, let name): return name
        }
    }

    func hash(into hasher: inout Hasher) {
        switch self {
        case .meeting(let id, _): hasher.combine(0); hasher.combine(id)
        case .file(let url, _): hasher.combine(1); hasher.combine(url)
        }
    }

    static func == (lhs: DocGenSource, rhs: DocGenSource) -> Bool {
        switch (lhs, rhs) {
        case (.meeting(let a, _), .meeting(let b, _)): return a == b
        case (.file(let a, _), .file(let b, _)): return a == b
        default: return false
        }
    }
}
