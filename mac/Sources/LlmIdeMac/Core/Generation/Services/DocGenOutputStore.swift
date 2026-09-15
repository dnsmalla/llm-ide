import Foundation
import os.log

private let logger = Logger(subsystem: "com.llmide.macapp", category: "DocGenOutputStore")

/// Persists Doc Gen output settings, keyed by project path — the default
/// output folder is project-relative, so one global setting would point at the
/// wrong project the moment the user switches.
@MainActor
final class DocGenOutputStore: ObservableObject {
    /// Config for the active project. Writes go through `update(_:)`.
    @Published private(set) var config = DocGenOutputConfig()

    private var byProject: [String: DocGenOutputConfig] = [:]
    private var currentKey: String?
    private var hasBootstrapped = false
    private let storeDirectory: URL?

    private var storeURL: URL {
        if let dir = storeDirectory {
            return dir.appendingPathComponent("doc-gen-output.json")
        }
        guard let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("com.llmide.macapp/doc-gen-output.json")
        }
        return support.appendingPathComponent("com.llmide.macapp/doc-gen-output.json")
    }

    init(storeDirectory: URL? = nil) {
        self.storeDirectory = storeDirectory
        // Disk read deferred to `bootstrap()` so app init stays cheap — same
        // reasoning as DocTemplateStore.
    }

    /// Load persisted settings from disk. Idempotent.
    func bootstrap() {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        load()
        if let key = currentKey { config = byProject[key] ?? DocGenOutputConfig() }
    }

    /// Point the store at a project. Publishes that project's stored config, or
    /// a fresh default when the project has none yet.
    func activate(projectRoot: URL?) {
        bootstrap()
        currentKey = projectRoot?.path
        guard let key = currentKey else {
            config = DocGenOutputConfig()
            return
        }
        config = byProject[key] ?? DocGenOutputConfig()
    }

    /// Replace the active project's config and persist.
    func update(_ newValue: DocGenOutputConfig) {
        bootstrap()
        config = newValue
        guard let key = currentKey else { return }
        byProject[key] = newValue
        save()
    }

    // MARK: - Disk I/O

    private func load() {
        guard let data = try? Data(contentsOf: storeURL) else { return }
        do {
            byProject = try JSONDecoder().decode([String: DocGenOutputConfig].self, from: data)
        } catch {
            logger.error("load failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(
                at: storeURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try JSONEncoder().encode(byProject).write(to: storeURL, options: .atomic)
        } catch {
            logger.error("save failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
