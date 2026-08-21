import Foundation

/// Owns the Loop Engineering template library: the shipped starters plus the
/// user's saved recipes. Mirrors `DocTemplateStore`'s role for doc templates.
///
/// Templates are **app-wide, not per-project** — the entire point is to carry a
/// recipe from one project to the next, which is why this is stored under a
/// single key rather than the per-`Project.id` key `LoopEngineConfig` uses.
/// UserDefaults (rather than `DocTemplateStore`'s on-disk store) keeps it in the
/// same place the loop's own config already lives.
@MainActor
final class LoopTemplateStore: ObservableObject {
    private static let storeKey = "loopTemplateStore"

    /// Only the user's own templates. Built-ins are a static constant, never
    /// persisted — otherwise an improved starter could never reach a user who had
    /// already opened the page once.
    @Published private(set) var customTemplates: [LoopTemplate] = []

    /// Built-ins first, then the user's, each group in its own order.
    var templates: [LoopTemplate] { LoopTemplate.builtIns + customTemplates }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        load()
    }

    func template(id: UUID) -> LoopTemplate? {
        templates.first { $0.id == id }
    }

    /// Saves `config` as a new named template. The name is de-duplicated against
    /// built-ins as well as custom entries, so a user cannot end up with two rows
    /// reading "Test & Fix" and no way to tell them apart.
    @discardableResult
    func save(name rawName: String, summary: String, config: LoopEngineConfig) -> LoopTemplate {
        let template = LoopTemplate(
            name: uniqueName(from: rawName.trimmingCharacters(in: .whitespacesAndNewlines)),
            summary: summary.trimmingCharacters(in: .whitespacesAndNewlines),
            config: config, isBuiltIn: false)
        customTemplates.append(template)
        persist()
        return template
    }

    /// Deletes a custom template. Built-ins are not deletable.
    func delete(id: UUID) {
        guard let index = customTemplates.firstIndex(where: { $0.id == id }) else { return }
        customTemplates.remove(at: index)
        persist()
    }

    /// `name`, or `name 2`, `name 3`… when taken. Compared case-insensitively so
    /// "test & fix" does not read as distinct from "Test & Fix".
    private func uniqueName(from name: String) -> String {
        let base = name.isEmpty ? "Untitled loop" : name
        let taken = Set(templates.map { $0.name.lowercased() })
        guard taken.contains(base.lowercased()) else { return base }
        var n = 2
        while taken.contains("\(base) \(n)".lowercased()) { n += 1 }
        return "\(base) \(n)"
    }

    // MARK: - Persistence

    private struct StoreFile: Codable {
        var storeVersion: Int = 1
        var templates: [LoopTemplate]
    }

    private func load() {
        guard let data = defaults.data(forKey: Self.storeKey),
              let file = try? JSONDecoder().decode(StoreFile.self, from: data)
        else { return }
        // Anything persisted is the user's by definition; force the flag so a
        // stored `isBuiltIn: true` (e.g. hand-edited defaults) can never make a
        // custom template undeletable.
        customTemplates = file.templates.map {
            var t = $0
            t.isBuiltIn = false
            return t
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(StoreFile(templates: customTemplates)) else { return }
        defaults.set(data, forKey: Self.storeKey)
    }
}
