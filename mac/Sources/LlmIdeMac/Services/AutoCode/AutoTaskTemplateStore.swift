import Combine
import Foundation
import os.log

private let logger = Logger(subsystem: "com.llmide.macapp", category: "AutoTaskTemplateStore")

/// Reads and writes the Auto Task prompt templates in
/// `<project>/templates/auto_task/*.md`.
///
/// Disk is the source of truth: every mutation writes the file and then
/// rescans, so a template edited in an external editor and one edited in the
/// app converge on the same list. Templates are per-project — a prompt that
/// says "review the API layer" only means something inside the project that has
/// an API layer — so the store is empty until `bindProject(root:)` names one.
@MainActor
final class AutoTaskTemplateStore: ObservableObject {

    @Published private(set) var templates: [AutoTaskTemplate] = []

    /// Unsaved editor text, keyed by template id.
    ///
    /// Held HERE rather than in the editor's `@State` because a SwiftUI view's
    /// state dies with its identity: the Auto Task detail pane reuses one view
    /// tree across tasks, so a half-written prompt was discarded the moment the
    /// user clicked another task in the sidebar (and, worse, leaked into the
    /// next task's card when both used the same template). A draft belongs to
    /// the template, survives every pane switch and rescan, and disappears only
    /// when the user saves or reverts it.
    @Published private(set) var drafts: [String: String] = [:]

    /// The bound project root, or nil when no project is open.
    private(set) var projectRoot: URL?

    /// Called after a rename so the caller can repoint task configs that
    /// referenced the old id. `(oldId, newId)`; newId is nil for a delete.
    var onTemplateIdChanged: ((String, String?) -> Void)?

    /// Fires when the SAVED set of templates changes — not on every keystroke.
    ///
    /// `objectWillChange` is unusable for observers that do real work, because
    /// `drafts` is `@Published` too: the mobile bridge subscribed to it and
    /// every 350 ms pause while typing a prompt ran two directory walks and
    /// pushed a snapshot to the phone whose template list had not changed
    /// (drafts are local unsaved state and are not in the payload).
    let templatesDidChange = PassthroughSubject<Void, Never>()

    private var directory: URL? {
        projectRoot.map { ProjectLayout(root: $0).autoTaskTemplatesDir }
    }

    var hasProject: Bool { projectRoot != nil }

    init() {}

    // MARK: - Project binding

    /// Point the store at a project (nil = project closed). Seeds the starter
    /// templates the first time a project has no `auto_task/` folder yet, so
    /// the picker is never an empty list with no way forward.
    func bindProject(root: URL?) {
        guard root != projectRoot else { return }
        projectRoot = root
        // Drafts are keyed by a slug that means something only inside one
        // project — every project seeds the same starter slugs — so they do
        // not travel across a project switch.
        drafts = [:]
        guard root != nil else {
            templates = []
            return
        }
        seedDefaultsIfMissing()
        reload()
    }

    /// Rescan the folder. Cheap enough to call after every mutation.
    func reload() {
        guard let directory else {
            setTemplates([])
            return
        }
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants]) else {
            setTemplates([])
            return
        }
        setTemplates(entries
            .filter { $0.pathExtension.lowercased() == AutoTaskTemplate.fileExtension }
            .compactMap { url in
                guard let contents = try? String(contentsOf: url, encoding: .utf8) else { return nil }
                return AutoTaskTemplate.parse(
                    fileContents: contents,
                    slug: url.deletingPathExtension().lastPathComponent,
                    url: url)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending })
    }

    /// Publish a new template list, announcing it only when it actually
    /// changed — a rescan that finds the same files must not wake observers
    /// that do real work (see `templatesDidChange`).
    private func setTemplates(_ next: [AutoTaskTemplate]) {
        guard next != templates else { return }
        templates = next
        templatesDidChange.send()
    }

    func template(id: String?) -> AutoTaskTemplate? {
        guard let id else { return nil }
        return templates.first { $0.id == id }
    }

    // MARK: - Drafts

    /// The editor text for `id`: the unsaved draft when there is one, otherwise
    /// what is on disk. nil for an unknown template.
    func editorText(for id: String) -> String? {
        if let draft = drafts[id] { return draft }
        return template(id: id)?.body
    }

    /// Record the editor text for `id`, VERBATIM.
    ///
    /// Storing exactly what was typed is what makes the editor's binding round
    /// trip. An earlier version refused to store text whose normalized form
    /// matched the saved body — which meant pressing Return at the end of an
    /// unmodified prompt stored nothing, the getter handed back the saved text,
    /// and the editor snapped the cursor back. The most common first keystroke
    /// when extending a prompt looked like a frozen editor. Whether the text
    /// counts as a CHANGE is `hasDraft`'s question, not this one's.
    func setDraft(_ text: String, for id: String) {
        guard drafts[id] != text else { return }
        drafts[id] = text
    }

    /// Throw away the unsaved draft for `id` (Revert, or after a save).
    func discardDraft(for id: String) {
        guard drafts[id] != nil else { return }
        drafts.removeValue(forKey: id)
    }

    /// True when `id`'s editor text differs from what is on disk.
    ///
    /// Compared through `normalizedBody` because that is the form a save
    /// writes: a trailing newline the user typed is not a change, so "Unsaved"
    /// must not appear for one (and must not survive a save that normalizes it
    /// away).
    func hasDraft(for id: String) -> Bool {
        guard let draft = drafts[id] else { return false }
        guard let saved = template(id: id)?.body else { return true }
        return AutoTaskTemplate.normalizedBody(draft) != saved
    }

    // MARK: - Mutations

    /// Create a template. Returns nil when no project is open or the write
    /// fails; the caller surfaces that rather than showing a phantom row.
    @discardableResult
    func create(name: String, body: String) -> AutoTaskTemplate? {
        guard let directory else { return nil }
        // Rescan first: the in-memory list can be stale (a `git pull`, the
        // paired iPhone, or the user's own editor may have added a file since),
        // and `write` overwrites — choosing a slug from memory alone would
        // silently replace someone else's template.
        reload()
        let slug = uniqueSlugOnDisk(base: AutoTaskTemplate.slug(for: name), excluding: nil)
        let url = directory.appendingPathComponent("\(slug).\(AutoTaskTemplate.fileExtension)")
        guard write(AutoTaskTemplate.render(name: name, body: body), to: url) else { return nil }
        reload()
        return template(id: slug)
    }

    /// Overwrite an existing template's prompt text, clearing its unsaved
    /// draft. No-op for an unknown id.
    @discardableResult
    func update(id: String, body: String) -> Bool {
        guard let existing = template(id: id), let url = existing.url else { return false }
        guard write(AutoTaskTemplate.render(name: existing.name, body: body), to: url) else { return false }
        discardDraft(for: id)
        reload()
        return true
    }

    /// Rename a template. The file moves to the new slug, so the id changes —
    /// `onTemplateIdChanged` fires so referring configs can be repointed. When
    /// the name maps to the same slug (e.g. "Review code" → "Review Code") only
    /// the frontmatter changes and the id is preserved.
    ///
    /// - Returns: the new id, or nil when the rename failed.
    @discardableResult
    func rename(id: String, to newName: String) -> String? {
        guard let directory, let existing = template(id: id), let oldURL = existing.url else { return nil }
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let base = AutoTaskTemplate.slug(for: trimmed)
        let newId = base == id ? id : uniqueSlugOnDisk(base: base, excluding: id)
        let newURL = directory.appendingPathComponent("\(newId).\(AutoTaskTemplate.fileExtension)")

        // Write the new content FIRST, then remove the old file — an
        // interrupted rename then leaves a duplicate (recoverable) rather than
        // deleting the only copy of the prompt.
        guard write(AutoTaskTemplate.render(name: trimmed, body: existing.body), to: newURL) else { return nil }
        if newId != id {
            do {
                try FileManager.default.removeItem(at: oldURL)
            } catch {
                logger.error("rename left the old template behind at \(oldURL.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
            // Carry any unsaved draft across. A rename writes the SAVED body,
            // so without this the user's in-progress edit would vanish the
            // moment they renamed the template they were editing.
            if let draft = drafts.removeValue(forKey: id) { drafts[newId] = draft }
            onTemplateIdChanged?(id, newId)
        }
        reload()
        return newId
    }

    /// Copy a template under a "<name> Copy" name. Returns the new template.
    @discardableResult
    func duplicate(id: String) -> AutoTaskTemplate? {
        guard let existing = template(id: id) else { return nil }
        return create(name: "\(existing.name) Copy", body: existing.body)
    }

    /// Delete a template and clear every config that pointed at it.
    @discardableResult
    func delete(id: String) -> Bool {
        guard let existing = template(id: id), let url = existing.url else { return false }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            logger.error("failed to delete template \(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
        discardDraft(for: id)
        onTemplateIdChanged?(id, nil)
        reload()
        return true
    }

    /// `base`, or `base-2`, `base-3`… until no FILE by that name exists.
    /// Checks the filesystem rather than the in-memory list because `write`
    /// overwrites: a template added since the last scan is invisible to
    /// `templates` but very much present on disk. `excluding` is the id being
    /// renamed, whose own file must not count as a collision.
    private func uniqueSlugOnDisk(base: String, excluding: String?) -> String {
        guard let directory else { return base }
        let fm = FileManager.default
        func taken(_ slug: String) -> Bool {
            guard slug != excluding else { return false }
            return fm.fileExists(
                atPath: directory.appendingPathComponent(
                    "\(slug).\(AutoTaskTemplate.fileExtension)").path)
        }
        guard taken(base) else { return base }
        var n = 2
        while taken("\(base)-\(n)") { n += 1 }
        return "\(base)-\(n)"
    }

    // MARK: - Seeding

    /// Starter templates written on first use, derived from the prompts the
    /// built-in review tasks already ship with. Without these the template
    /// picker opens empty on a fresh project and the feature looks broken;
    /// with them the user has five working prompts to edit.
    static let seeds: [(name: String, body: String)] = [
        ("Review Code", AppConfig.defaultTemplateReviewCode),
        ("Review Doc", AppConfig.defaultTemplateReviewDoc),
        ("Review Conflicts", AppConfig.defaultTemplateReviewConflicts),
        ("Generate Documentation", AppConfig.defaultTemplateGenerateDoc),
        ("Update Issues", AppConfig.defaultTemplateUpdateIssues),
    ]

    /// Create `templates/auto_task/` with the seed prompts, but ONLY when the
    /// folder does not exist. An existing folder — even an empty one the user
    /// emptied on purpose — is left alone, so deleting every template does not
    /// resurrect them on the next project open.
    private func seedDefaultsIfMissing() {
        guard let directory else { return }
        let fm = FileManager.default
        guard !fm.fileExists(atPath: directory.path) else { return }
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            logger.error("could not create \(directory.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return
        }
        for seed in Self.seeds {
            let url = directory.appendingPathComponent(
                "\(AutoTaskTemplate.slug(for: seed.name)).\(AutoTaskTemplate.fileExtension)")
            _ = write(AutoTaskTemplate.render(name: seed.name, body: seed.body), to: url)
        }
    }

    // MARK: - I/O

    private func write(_ contents: String, to url: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try contents.write(to: url, atomically: true, encoding: .utf8)
            return true
        } catch {
            logger.error("failed to write \(url.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
    }
}
