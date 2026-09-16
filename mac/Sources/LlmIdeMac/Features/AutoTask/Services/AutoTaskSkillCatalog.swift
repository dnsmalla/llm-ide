import Foundation

/// The agent skills an Auto Task can run under, read from the project's own
/// `.claude/skills/<name>/SKILL.md` files.
///
/// Why the folder and not the server's `/kb/agent/catalog`: an Auto Task runs
/// the AI CLI as a subprocess in the repo (`AutoCodeUpdateService.runCLI`), so
/// the only skills it can actually invoke are the ones the CLI itself discovers
/// on disk — the central kit `ProjectSkillsInstaller` writes there. The server
/// catalog lists the agent-loop's own tools, which that subprocess never sees;
/// offering them here would produce a picker full of skills that silently do
/// nothing.
///
/// A skill is invoked the way the CLI expects: a directive line prepended to
/// the prompt ("Use the code-review skill:"), which is what
/// `AutoTaskPromptComposer` folds in.
@MainActor
final class AutoTaskSkillCatalog: ObservableObject {

    struct Entry: Identifiable, Equatable {
        let name: String
        let description: String
        var id: String { name }
        /// The line prepended to the prompt to invoke this skill.
        var directive: String { AutoTaskSkillCatalog.directive(for: name) }
    }

    @Published private(set) var skills: [Entry] = []
    /// False until the first scan completes, so the UI can say "Loading…"
    /// rather than "no skills found" before it has looked.
    @Published private(set) var hasScanned = false

    private var scannedRoot: URL?

    init() {}

    /// The prompt line that invokes `name`.
    nonisolated static func directive(for name: String) -> String {
        "Use the \(name) skill:"
    }

    /// Rescan `root`'s `.claude/skills/`. No-op when the root is unchanged
    /// unless `force` is set (the Reload button).
    ///
    /// The scan itself runs OFF the main actor: it walks a directory and reads
    /// a manifest per skill, and this is called from `AppShell` on every
    /// project switch and from a view's `onAppear`. `hasScanned` flips only
    /// when the results land, so the UI says "Reading…" rather than "no skills
    /// found" while the walk is in flight.
    func reload(projectRoot: URL?, force: Bool = false) {
        if !force, scannedRoot == projectRoot, hasScanned { return }
        scannedRoot = projectRoot
        guard let projectRoot else {
            skills = []
            hasScanned = true
            return
        }
        hasScanned = false
        Task {
            let found = await Task.detached(priority: .userInitiated) {
                Self.scan(projectRoot: projectRoot)
            }.value
            // A later bind may have landed while this walk ran; the newest
            // root wins rather than an older scan overwriting it.
            guard self.scannedRoot == projectRoot else { return }
            self.skills = found
            self.hasScanned = true
        }
    }

    /// Read every `<root>/.claude/skills/*/SKILL.md`. Symlinked entries are
    /// included on purpose — `scripts/install-skills.sh` links the central kit
    /// in rather than copying it.
    nonisolated static func scan(projectRoot: URL) -> [Entry] {
        let dir = projectRoot
            .appendingPathComponent(".claude", isDirectory: true)
            .appendingPathComponent("skills", isDirectory: true)
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants]) else { return [] }

        return entries
            .compactMap { entry -> Entry? in
                let manifest = entry.appendingPathComponent("SKILL.md")
                guard let contents = try? String(contentsOf: manifest, encoding: .utf8) else { return nil }
                return parse(manifest: contents, folderName: entry.lastPathComponent)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Pull `name` / `description` out of a SKILL.md. The folder name is the
    /// fallback name, because that is the identifier the CLI resolves anyway —
    /// a manifest with a missing or malformed header still yields a usable,
    /// invocable entry rather than being dropped.
    nonisolated static func parse(manifest: String, folderName: String) -> Entry {
        guard let (header, _) = MarkdownFrontmatter.split(manifest) else {
            return Entry(name: folderName, description: "")
        }
        let name = MarkdownFrontmatter.value(forKey: "name", in: header) ?? folderName
        let description = MarkdownFrontmatter.value(forKey: "description", in: header) ?? ""
        return Entry(name: name, description: description)
    }
}
