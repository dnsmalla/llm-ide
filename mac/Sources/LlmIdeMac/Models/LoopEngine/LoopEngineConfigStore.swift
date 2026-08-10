import Foundation

/// Reads and writes a project's Loop contract at `<projectRoot>/system/loop.json`.
///
/// **Why a file and not UserDefaults.** The stage list, budgets and
/// protected-path policy describe *this repo's* verification contract, so they
/// belong to the repo — not to one macOS user account on one Mac. Stored in
/// UserDefaults they survived closing the app and logging out, but a fresh clone,
/// a second machine, or a teammate got none of it: stages were silently
/// re-detected and budgets fell back to the app defaults. The file sits next to
/// `system/project.json` and is committed, so the contract travels with the code
/// it verifies.
///
/// **What deliberately stays local.** Shell-command approvals
/// (`VerifyApprovalStore`) are NOT moved here. Their whole purpose is that each
/// machine approves a command before it ever runs; committed, a cloned repo could
/// ship pre-approved arbitrary shell commands for the loop to run unattended on
/// the cron trigger. `LoopEngineDefaults` also stays in UserDefaults — it is a
/// per-user preference for *new* projects, not a property of any one repo.
enum LoopEngineConfigStore {
    /// `<projectRoot>/system/loop.json`.
    static func fileURL(projectRoot: URL) -> URL {
        projectRoot.appendingPathComponent("system", isDirectory: true)
            .appendingPathComponent("loop.json")
    }

    /// Pretty-printed with sorted keys because this file is committed: a compact
    /// single-line JSON blob would make every budget tweak an unreadable one-line
    /// diff, and unsorted keys would produce spurious churn between writes.
    private static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }

    /// This project's saved contract, or `nil` when it has none yet.
    ///
    /// Resolution order: the file, then the legacy UserDefaults entry — which is
    /// **migrated to the file on the spot**, so a project configured before this
    /// existed becomes portable the first time it is opened, with no action from
    /// the user. `projectRoot == nil` (no resolvable project folder) falls back to
    /// UserDefaults entirely; there is nowhere to put a file.
    static func load(projectRoot: URL?, projectId: String,
                     defaults: UserDefaults = .standard) -> LoopEngineConfig? {
        guard let projectRoot else {
            return LoopEngineConfig.load(for: projectId, defaults: defaults)
        }
        let url = fileURL(projectRoot: projectRoot)
        if let data = try? Data(contentsOf: url),
           let config = try? JSONDecoder().decode(LoopEngineConfig.self, from: data) {
            return config
        }
        if let legacy = LoopEngineConfig.load(for: projectId, defaults: defaults) {
            write(legacy, to: url)
            return legacy
        }
        return nil
    }

    /// Persists `config` for this project.
    ///
    /// The file is the single source of truth once a project folder is resolvable —
    /// the legacy UserDefaults entry is deliberately NOT kept in step, because two
    /// writable copies of one config is exactly the drift that makes "which one is
    /// live?" unanswerable. The stale entry is harmless: `load` prefers the file.
    static func save(_ config: LoopEngineConfig, projectRoot: URL?, projectId: String,
                     defaults: UserDefaults = .standard) {
        guard let projectRoot else {
            config.save(for: projectId, defaults: defaults)
            return
        }
        write(config, to: fileURL(projectRoot: projectRoot))
    }

    /// Whether this project has a saved contract.
    ///
    /// Note the side effect: this goes through `load`, so a project still on the
    /// legacy UserDefaults entry is **migrated to the file** by asking this
    /// question. That is idempotent and is the migration we want to happen as early
    /// as possible, but it does mean this is not a pure read.
    static func exists(projectRoot: URL?, projectId: String,
                       defaults: UserDefaults = .standard) -> Bool {
        load(projectRoot: projectRoot, projectId: projectId, defaults: defaults) != nil
    }

    private static func write(_ config: LoopEngineConfig, to url: URL) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try encoder().encode(config).write(to: url, options: .atomic)
        } catch {
            // Fail-quiet, matching every other write on this path: losing a config
            // write is bad, but throwing from a SwiftUI action or the cron sweep
            // would be worse than the user re-saving.
            NSLog("LoopEngineConfigStore: write failed at \(url.path): \(error.localizedDescription)")
        }
    }
}
