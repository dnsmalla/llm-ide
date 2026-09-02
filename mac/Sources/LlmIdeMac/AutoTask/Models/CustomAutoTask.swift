import Foundation

/// User-created Auto Task: a name + a prompt template, run through the same
/// generic CLI pipeline the 5 built-in template tasks (Review Code, Review
/// Doc, Review Conflicts, Generate Documentation, Update Issues) already
/// use. Unlike `AutoTask` (a closed, compiled enum), this is an open,
/// user-extensible, runtime-created task — persisted the same way
/// `CustomProvider` persists named custom AI providers.
struct CustomAutoTask: Identifiable, Codable, Equatable {
    var id: String = UUID().uuidString
    var name: String
    /// The prompt run via `AutoCodeUpdateService.runCLI(prompt:...)` — same
    /// role as `AppConfig.autoTaskTemplateReviewCode` etc.
    var template: String
    var isEnabled: Bool = true
    var createdAt: Date = Date()
    /// `.review` (default) discards the CLI's edits; `.implement` commits them
    /// on an isolated `fix/custom-<slug>-<token>` branch.
    var mode: Mode = .review
    /// Cron schedule (nil = manual ▶ only). Parsed by `CronExpression`.
    var cron: String?

    enum Mode: String, Codable, CaseIterable {
        case review, implement

        var label: String {
            switch self {
            case .review: return "Review"
            case .implement: return "Implement"
            }
        }

        var detail: String {
            switch self {
            case .review: return "Discards CLI edits after the run"
            case .implement: return "Commits on an isolated fix/custom-* branch"
            }
        }
    }

    init(id: String = UUID().uuidString, name: String, template: String,
         isEnabled: Bool = true, createdAt: Date = Date(),
         mode: Mode = .review, cron: String? = nil) {
        self.id = id; self.name = name; self.template = template
        self.isEnabled = isEnabled; self.createdAt = createdAt
        self.mode = mode; self.cron = cron
    }

    // MARK: Backward-compatible Codable (mode/cron predate existing payloads)

    enum CodingKeys: String, CodingKey {
        case id, name, template, isEnabled, createdAt, mode, cron
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        template = try c.decode(String.self, forKey: .template)
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? true
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        mode = try c.decodeIfPresent(Mode.self, forKey: .mode) ?? .review
        cron = try c.decodeIfPresent(String.self, forKey: .cron)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(name, forKey: .name)
        try c.encode(template, forKey: .template); try c.encode(isEnabled, forKey: .isEnabled)
        try c.encode(createdAt, forKey: .createdAt); try c.encode(mode, forKey: .mode)
        try c.encodeIfPresent(cron, forKey: .cron)
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
