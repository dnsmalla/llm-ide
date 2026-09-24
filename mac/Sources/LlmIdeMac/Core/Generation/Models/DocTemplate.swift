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
    /// Which generation menu this template belongs to (`TemplateSurface`).
    /// Read from the marker line; absent means Doc Gen, as every template
    /// written before surfaces existed is.
    var surface: TemplateSurface

    /// Base marker written into every template file. Lets the scanner tell a
    /// template apart from any other `.md` in the folder, and carries the
    /// `surface=` attribute.
    static let markerComment = "<!-- llmide:doc-template -->"

    init(
        id: UUID,
        name: String,
        sections: [String],
        rawContent: String? = nil,
        isBuiltin: Bool = false,
        folderName: String? = nil,
        isProjectTemplate: Bool = false,
        surface: TemplateSurface = .default
    ) {
        self.id = id
        self.name = name
        self.sections = sections
        self.rawContent = rawContent
        self.isBuiltin = isBuiltin
        self.folderName = folderName
        self.isProjectTemplate = isProjectTemplate
        self.surface = surface
    }

    enum CodingKeys: String, CodingKey {
        case id, name, sections, rawContent, isBuiltin, folderName, isProjectTemplate, surface
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
        // Optional on decode: app-support templates persisted before surfaces
        // existed carry no key, and they are Doc Gen templates.
        surface = try c.decodeIfPresent(TemplateSurface.self, forKey: .surface) ?? .default
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(sections, forKey: .sections)
        try c.encodeIfPresent(rawContent, forKey: .rawContent)
        try c.encode(isBuiltin, forKey: .isBuiltin)
        try c.encodeIfPresent(folderName, forKey: .folderName)
        try c.encode(isProjectTemplate, forKey: .isProjectTemplate)
        try c.encode(surface, forKey: .surface)
    }

    /// App-owned templates seeded into every project's
    /// `templates/<slug>/template.md`.
    ///
    /// Only the INGEST layouts remain here. The Doc Gen and Visual templates a
    /// user picks from a menu moved to `dnsmalla/agent-kit`'s `templates/`
    /// family, so adding one is a file in the kit rather than an app release
    /// — see `GenerationLibraryStore`. These two cannot follow: they are
    /// `{{placeholder}}` layouts rendered by `IngestTemplateRenderer` for
    /// auto-generated notes, and they are deliberately excluded from the
    /// picker below.
    struct SeedDefinition {
        let id: UUID
        let folderName: String
        let name: String
        let sections: [String]
        var ingestKind: IngestTemplateKind? = nil
        var surface: TemplateSurface = .default

        func markdown() -> String {
            if let kind = ingestKind {
                return IngestTemplateRenderer.defaultTemplate(kind)
            }
            return DocTemplate.markdownBody(name: name, sections: sections, surface: surface)
        }
    }

    static let seedDefinitions: [SeedDefinition] = [
        SeedDefinition(
            id: UUID(uuidString: "A0000006-0000-4000-8000-000000000006")!,
            folderName: "meeting-note",
            name: "Meeting Note (auto)",
            sections: ["Summary", "Action items"],
            ingestKind: .meetingNote),
        SeedDefinition(
            id: UUID(uuidString: "A0000007-0000-4000-8000-000000000007")!,
            folderName: "email-note",
            name: "Email Note (auto)",
            sections: ["Summary", "To-dos"],
            ingestKind: .emailNote),
    ]

    /// Shipped skeletons when no project is open (fallback UI).
    ///
    /// Empty now that the menu templates come from the kit: with no project
    /// there is no `templates/` folder to read, and inventing a second,
    /// app-local copy of the kit's defaults is exactly the duplication this
    /// change removes. `DocTemplateStore` fills this surface from
    /// `GenerationLibraryStore` instead, which is cached and therefore
    /// available offline.
    static let builtins: [DocTemplate] = []

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
    static func markdownBody(name: String, sections: [String], surface: TemplateSurface = .default) -> String {
        var lines = [
            "# \(name)",
            "",
            TemplateSurfaceMarker.line(base: markerComment, surface: surface),
            "",
            "Template for \(surface.label). Edit the `##` sections below to change structure.",
            "",
        ]
        for section in sections where !section.isEmpty {
            lines.append("## \(section)")
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    /// Apply an edited title and section list to an existing template file
    /// WITHOUT losing its body text.
    ///
    /// The manager sheet used to null `rawContent` on Save, so
    /// `renderedMarkdown()` regenerated the bare `# name` / `## section`
    /// skeleton over the user's `template.md` — every instruction and example
    /// under the headings gone, no warning. The sheet edits only the title
    /// (retyped) and the section list (remove / add / reorder by name), so the
    /// rewrite is exact: the `# ` title line is replaced, everything before
    /// the first `## ` (marker line included) is kept, each surviving section
    /// keeps its heading AND the text beneath it in the new order, a removed
    /// section goes with its text (the user removed it), and a new one is an
    /// empty heading. A file with no `## ` headings keeps all its text and
    /// gets the sections appended.
    static func rewriting(raw: String, name: String, sections: [String]) -> String {
        // Split like `sections(from:)` does (any newline, CR stripped): a CRLF
        // file otherwise yields headings ending in "\r" that never match the
        // section names, and every body is dropped.
        var lines = raw.components(separatedBy: .newlines)
        // Title: replace the first `# ` line, or add one at the top.
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        if let titleIdx = lines.firstIndex(where: { $0.hasPrefix("# ") }) {
            lines[titleIdx] = "# \(trimmedName)"
        } else if !trimmedName.isEmpty {
            lines.insert(contentsOf: ["# \(trimmedName)", ""], at: 0)
        }
        // Split into preamble + `## ` blocks (heading line + its body lines).
        var preamble: [String] = []
        var blocks: [(heading: String, body: [String])] = []
        for line in lines {
            if line.hasPrefix("## ") {
                blocks.append((String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces), []))
            } else if blocks.isEmpty {
                preamble.append(line)
            } else {
                blocks[blocks.count - 1].body.append(line)
            }
        }
        // Bodies queued per heading name, so a template with two sections of
        // the same name keeps both bodies in order rather than emitting the
        // first twice.
        var byName: [String: [[String]]] = [:]
        for b in blocks { byName[b.heading, default: []].append(b.body) }
        // Preamble keeps its own trailing blank line at most once.
        while preamble.count > 1, preamble.last == "", preamble[preamble.count - 2] == "" { preamble.removeLast() }
        if preamble.last != "" { preamble.append("") }
        var out = preamble
        for section in sections.map({ $0.trimmingCharacters(in: .whitespaces) }) where !section.isEmpty {
            out.append("## \(section)")
            if var queue = byName[section], !queue.isEmpty {
                let body = queue.removeFirst()
                byName[section] = queue
                var kept = body
                while kept.count > 1, kept.last == "", kept[kept.count - 2] == "" { kept.removeLast() }
                if kept.last != "" { kept.append("") }
                out.append(contentsOf: kept)
            } else {
                out.append("")
            }
        }
        return out.joined(separator: "\n")
    }

    func renderedMarkdown() -> String {
        if let raw = rawContent, !raw.isEmpty { return raw }
        return Self.markdownBody(name: name, sections: sections, surface: surface)
    }

    /// The surface declared by a template file's own marker.
    static func surface(from markdown: String) -> TemplateSurface {
        TemplateSurfaceMarker.surface(in: markdown, base: markerComment)
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

    /// Total order for sending a SELECTION to the server.
    ///
    /// `GenerationViewModel.selectedSources` is a `Set`, whose iteration order
    /// is hash order — it varies between runs of the SAME selection. The
    /// server fits sources to a character budget and drops from the end, so
    /// unordered input makes "which file got dropped" non-deterministic from
    /// the user's point of view. Sorting on this before sending gives that
    /// decision a stable, explainable basis. Files sort by path (meetings
    /// first, by id) so the order matches how the Library lists them.
    var sendOrderKey: String {
        switch self {
        case .meeting(let id, _): return "0\(id)"
        case .file(let url, _): return "1\(url.path)"
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
