import Foundation

/// A reusable Auto Task prompt — "what to do in this task" — stored as one
/// markdown file at `<project>/templates/auto_task/<slug>.md`.
///
/// The FILE is the source of truth, not a UserDefaults blob: templates are then
/// diffable, reviewable, and shareable with the rest of the team through the
/// same repo the tasks run against. `id` is the filename stem, which is what
/// `AutoTaskConfig.templateId` stores; renaming rewrites the file, so the id
/// changes and `AutoTaskTemplateStore.rename` repoints the configs that
/// referenced it.
///
/// Everything in this type is pure — parsing, rendering, and slugging have no
/// I/O so they can be unit-tested without a project on disk. The store owns
/// every file operation.
struct AutoTaskTemplate: Identifiable, Equatable {
    /// Filename stem. Stable id referenced by `AutoTaskConfig.templateId`.
    let id: String
    /// Display name, from the file's `name:` frontmatter key.
    var name: String
    /// The prompt itself (frontmatter stripped).
    var body: String
    /// Where it came from. nil for in-memory instances (tests, previews).
    var url: URL?

    init(id: String, name: String, body: String, url: URL? = nil) {
        self.id = id
        self.name = name
        self.body = body
        self.url = url
    }

    static let fileExtension = "md"

    /// Placeholders a template body may use; the composer substitutes them
    /// with absolute paths at run time. Surfaced in the editor as a hint.
    static let placeholders = ["{{INPUT_PATH}}", "{{OUTPUT_PATH}}", "{{PROJECT_ROOT}}"]

    // MARK: - Slugs

    /// Filename-safe stem for a display name: lowercased, non-alphanumerics
    /// collapsed to single dashes, trimmed. Empty input yields "untitled" so a
    /// name made entirely of punctuation can never produce a dotfile or a
    /// zero-length filename.
    static func slug(for name: String) -> String {
        let parts = name.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
        let joined = parts.joined(separator: "-")
        return joined.isEmpty ? "untitled" : String(joined.prefix(64))
    }

    /// `base`, or `base-2`, `base-3`… until it is not in `existing`.
    static func uniqueSlug(base: String, existing: Set<String>) -> String {
        guard existing.contains(base) else { return base }
        var n = 2
        while existing.contains("\(base)-\(n)") { n += 1 }
        return "\(base)-\(n)"
    }

    /// Human-readable fallback name for a slug with no frontmatter:
    /// `nightly-cleanup` → `Nightly Cleanup`.
    static func displayName(forSlug slug: String) -> String {
        let words = slug.components(separatedBy: CharacterSet(charactersIn: "-_"))
            .filter { !$0.isEmpty }
        guard !words.isEmpty else { return slug }
        return words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    // MARK: - File format

    /// The single canonical form of a prompt body: no leading or trailing
    /// newlines. `render` and `parse` BOTH apply it, which is what makes
    /// `parse(render(x)).body == normalizedBody(x)` for every input.
    ///
    /// Editors must decide DIRTINESS against this rather than against raw
    /// typed text. Without it, pressing Return at the end of a prompt (an
    /// ordinary `TextEditor` habit) saves fine but leaves the draft one newline
    /// longer than the stored body forever — the card reads "Unsaved" and the
    /// Save button stays lit no matter how many times it is pressed. They must
    /// still STORE the raw text, or the editor's binding stops round-tripping
    /// and the keystroke appears to do nothing at all.
    static func normalizedBody(_ body: String) -> String {
        body.trimmingCharacters(in: .newlines)
    }

    /// Parse a template file. Accepts a `---` fenced header carrying `name:`;
    /// a file with no frontmatter is still a valid template whose name is
    /// derived from its slug, so a prompt dropped into the folder by hand
    /// (or by another tool) shows up rather than being skipped.
    static func parse(fileContents: String, slug: String, url: URL? = nil) -> AutoTaskTemplate {
        guard let (header, body) = MarkdownFrontmatter.split(fileContents) else {
            return AutoTaskTemplate(id: slug, name: displayName(forSlug: slug),
                                    body: normalizedBody(fileContents), url: url)
        }
        let name = MarkdownFrontmatter.value(forKey: "name", in: header)
            ?? displayName(forSlug: slug)
        return AutoTaskTemplate(id: slug, name: name,
                                body: normalizedBody(body), url: url)
    }

    /// The on-disk text for a template. The name is always quoted so a name
    /// containing `:` or `#` round-trips through `parse` unchanged.
    static func render(name: String, body: String) -> String {
        "---\nname: \(MarkdownFrontmatter.quoted(name))\n---\n\n\(normalizedBody(body))\n"
    }

    /// This template's on-disk text.
    var rendered: String { Self.render(name: name, body: body) }
}
