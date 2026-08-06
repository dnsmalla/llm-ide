import Foundation

/// User-created Auto Task: a name + a prompt template, run through the same
/// generic CLI pipeline the 5 built-in template tasks (Review Code, Review
/// Doc, Review Conflicts, Generate Documentation, Update Issues) already
/// use. Unlike `AutoTask` (a closed, compiled enum with exactly 12 cases),
/// this is an open, user-extensible, runtime-created task — persisted the
/// same way `CustomProvider` persists named custom AI providers.
struct CustomAutoTask: Identifiable, Codable, Equatable {
    var id: String = UUID().uuidString
    var name: String
    /// The prompt run via `AutoCodeUpdateService.runCLI(prompt:...)` — same
    /// role as `AppConfig.autoTaskTemplateReviewCode` etc.
    var template: String
    var isEnabled: Bool = true
    var createdAt: Date = Date()

    init(id: String = UUID().uuidString, name: String, template: String,
         isEnabled: Bool = true, createdAt: Date = Date()) {
        self.id = id
        self.name = name
        self.template = template
        self.isEnabled = isEnabled
        self.createdAt = createdAt
    }
}

// MARK: - Persistence

extension CustomAutoTask {
    static let defaultsKey = "customAutoTasks"

    static func loadAll(from defaults: UserDefaults = .standard) -> [CustomAutoTask] {
        guard let data = defaults.data(forKey: defaultsKey) else { return [] }
        do {
            return try JSONDecoder().decode([CustomAutoTask].self, from: data)
        } catch {
            return []
        }
    }

    static func saveAll(_ tasks: [CustomAutoTask], to defaults: UserDefaults = .standard) {
        do {
            let data = try JSONEncoder().encode(tasks)
            defaults.set(data, forKey: defaultsKey)
        } catch {
            // Silent fail — validation happens in the UI (non-empty name/template).
        }
    }

    func save(in defaults: UserDefaults = .standard) {
        var all = CustomAutoTask.loadAll(from: defaults)
        if let idx = all.firstIndex(where: { $0.id == id }) {
            all[idx] = self
        } else {
            all.append(self)
        }
        CustomAutoTask.saveAll(all, to: defaults)
    }

    func delete(from defaults: UserDefaults = .standard) {
        var all = CustomAutoTask.loadAll(from: defaults)
        all.removeAll { $0.id == id }
        CustomAutoTask.saveAll(all, to: defaults)
    }
}
