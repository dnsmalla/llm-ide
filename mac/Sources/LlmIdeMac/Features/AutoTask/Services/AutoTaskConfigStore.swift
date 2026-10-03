import Foundation
import SwiftUI
import os.log

/// Owns every task's `AutoTaskConfig`, scoped BY PROJECT and keyed by task id
/// (`AutoTask.rawValue` for built-ins, `CustomAutoTask.id` for custom ones).
///
/// The project scope is load-bearing, not tidiness. A config's `templateId` is
/// a filename stem in *that project's* `templates/auto_task/`, and every
/// project is seeded with the same starter slugs (`review-code`, …). A single
/// global bucket would therefore resolve "review-code" against whichever
/// project happens to be open — running a prompt the user wrote for a
/// different repo, with no warning. The same applies to the project-relative
/// input/output paths.
///
/// One JSON blob in UserDefaults rather than a key per field per task: the
/// settings arrive together, they are read together at run time, and the flat
/// key-per-property style next door in `AutoTaskSettings` already needs a
/// hand-written line per task in four separate places. A nested dictionary
/// means a new built-in task needs no storage change at all.
@MainActor
final class AutoTaskConfigStore: ObservableObject {

    static let defaultsKey = "autoTaskConfigsByProject"

    /// Bucket used while no project is open. Settings made there are kept
    /// rather than dropped, but they never leak into a real project's scope.
    static let noProjectScope = "__no_project__"

    /// projectId → taskId → config.
    @Published private(set) var byProject: [String: [String: AutoTaskConfig]] = [:]

    /// The project whose settings are live. Set by `bindProject(id:)`.
    private(set) var projectId: String?

    private let defaults: UserDefaults

    /// True when the stored blob was undecodable and could not be copied
    /// aside. The blob is left in place and `save()` refuses to run so it is
    /// never overwritten with a partial map.
    private(set) var isReadOnly = false

    /// - Parameter stashDirectory: where a corrupt blob is copied; defaults to
    ///   Application Support. Injectable so tests don't touch the real one.
    init(defaults: UserDefaults = .standard, stashDirectory: URL? = nil) {
        self.defaults = defaults
        load(stashDirectory: stashDirectory)
    }

    /// Point the store at a project (nil = no project open). Cheap — the whole
    /// blob is already in memory; this only changes which bucket is read.
    func bindProject(id: String?) {
        guard id != projectId else { return }
        projectId = id
        objectWillChange.send()
    }

    /// The active project's settings.
    var configs: [String: AutoTaskConfig] { byProject[scope] ?? [:] }

    private var scope: String { projectId ?? Self.noProjectScope }

    /// This task's settings in the active project, or an empty config.
    func config(for taskId: String) -> AutoTaskConfig {
        configs[taskId] ?? AutoTaskConfig()
    }

    /// Persist `config` for `taskId` in the active project. An all-blank config
    /// REMOVES the record rather than storing an empty one, so the store only
    /// ever holds tasks the user actually configured.
    func update(_ config: AutoTaskConfig, for taskId: String) {
        guard !refuseWhileReadOnly() else { return }
        let trimmed = config.trimmed
        var bucket = configs
        if trimmed.isEmpty {
            guard bucket[taskId] != nil else { return }
            bucket.removeValue(forKey: taskId)
        } else {
            guard bucket[taskId] != trimmed else { return }
            bucket[taskId] = trimmed
        }
        setBucket(bucket)
    }

    /// SwiftUI binding for a task's whole config — the settings controls read
    /// and write through this so every edit persists immediately.
    func binding(for taskId: String) -> Binding<AutoTaskConfig> {
        Binding(
            get: { [weak self] in self?.config(for: taskId) ?? AutoTaskConfig() },
            set: { [weak self] in self?.update($0, for: taskId) }
        )
    }

    /// Forget a task's settings — called when a custom task is deleted so its
    /// record doesn't linger against an id nothing can reach.
    func remove(taskId: String) {
        guard !refuseWhileReadOnly() else { return }
        var bucket = configs
        guard bucket.removeValue(forKey: taskId) != nil else { return }
        setBucket(bucket)
    }

    /// Repoint the ACTIVE PROJECT's configs that referenced `oldTemplateId`.
    /// Renaming a template changes its id (the id is the filename stem), and
    /// without this every task using it would silently fall back to its own
    /// prompt. Scoped to the active project because the template file that
    /// moved belongs to it — a same-named template in another project is a
    /// different file and must not be touched. Pass `nil` for a deleted
    /// template to clear the reference.
    func retargetTemplate(from oldTemplateId: String, to newTemplateId: String?) {
        guard !refuseWhileReadOnly() else { return }
        var bucket = configs
        var changed = false
        for (taskId, config) in bucket where config.templateId == oldTemplateId {
            var updated = config
            updated.templateId = newTemplateId
            if updated.isEmpty {
                bucket.removeValue(forKey: taskId)
            } else {
                bucket[taskId] = updated
            }
            changed = true
        }
        guard changed else { return }
        setBucket(bucket)
    }

    // MARK: - Persistence

    private var hasLoggedReadOnlyRefusal = false

    /// While read-only, save() is a no-op. Mutating `byProject` anyway made the
    /// UI show an edit as saved that then vanished on relaunch, so refuse the
    /// edit instead; `objectWillChange` makes bound controls re-read the
    /// unchanged value and snap back. Logged once (not per keystroke).
    /// - Returns: true when the edit must be dropped.
    private func refuseWhileReadOnly() -> Bool {
        guard isReadOnly else { return false }
        if !hasLoggedReadOnlyRefusal {
            hasLoggedReadOnlyRefusal = true
            Self.logger.error("Auto Task settings are read-only (stored blob unreadable, backup failed); edits are discarded")
        }
        objectWillChange.send()
        return true
    }

    private func setBucket(_ bucket: [String: AutoTaskConfig]) {
        if bucket.isEmpty {
            byProject.removeValue(forKey: scope)
        } else {
            byProject[scope] = bucket
        }
        save()
    }

    private func load(stashDirectory: URL?) {
        guard let data = defaults.data(forKey: Self.defaultsKey) else { return }
        do {
            byProject = try JSONDecoder()
                .decode([String: [String: AutoTaskConfig]].self, from: data)
        } catch {
            // Starting empty never blocks the page from opening, but the next
            // `save()` would then overwrite EVERY project's config with the
            // empty map. Keep the bad bytes on disk first so they can be
            // recovered by hand.
            byProject = [:]
            if Self.stashCorruptBlob(data, error: error, directory: stashDirectory) {
                defaults.removeObject(forKey: Self.defaultsKey)
            } else {
                // No verified copy: removing the key would destroy the only
                // one, and saving would overwrite it. Keep it, go read-only.
                isReadOnly = true
            }
        }
    }

    private static let logger = Logger(subsystem: "com.llmide.macapp", category: "AutoTaskConfigStore")

    /// Copy an undecodable blob under Application Support (same convention as
    /// `AppConfig`'s `*.corrupt-<ts>` stashes) and log it.
    /// Returns true only when a byte-identical copy exists on disk.
    private static func stashCorruptBlob(_ data: Data, error: Error, directory: URL?) -> Bool {
        let fm = FileManager.default
        let dir = directory ?? AppIdentity.applicationSupportRoot(fileManager: fm)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let ts = Int(Date().timeIntervalSince1970)
        let backup = dir.appendingPathComponent("\(defaultsKey).json.corrupt-\(ts)")
        do {
            try data.write(to: backup, options: .atomic)
            guard fm.contents(atPath: backup.path) == data else {
                logger.error("Corrupt \(defaultsKey, privacy: .public) stash failed verification")
                return false
            }
            logger.warning("Corrupt \(defaultsKey, privacy: .public) stashed to \(backup.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return true
        } catch {
            logger.error("Corrupt \(defaultsKey, privacy: .public) could not be stashed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func save() {
        guard !isReadOnly else { return }
        guard let data = try? JSONEncoder().encode(byProject) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}
