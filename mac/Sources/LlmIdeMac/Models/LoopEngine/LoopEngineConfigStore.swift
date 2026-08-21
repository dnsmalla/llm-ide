import Foundation

/// Reads and writes a project's Loop contract at `<projectRoot>/system/loop.json`.
///
/// **Why a file and not UserDefaults.** The loop list, its stages, budgets
/// and protected-path policy describe *this repo's* verification contract,
/// so it belongs to the repo — not to one macOS user account on one Mac.
/// Stored in UserDefaults it survived closing the app and logging out, but a
/// fresh clone, a second machine, or a teammate got none of it. The file sits
/// next to `system/project.json` and is committed, so the contract travels
/// with the code it verifies.
///
/// **Schema.** The file holds a `LoopEngineProjectStore` — a project's full
/// list of `LoopDefinition`s, each with its own stages/budgets/goal/scope.
/// Before this existed the file held a single bare `LoopEngineConfig`; `load`
/// migrates that transparently (see below) so an existing project becomes
/// "one loop, named Main Loop, marked Primary" the first time it is opened
/// after this ships, with no action from the user.
///
/// **What deliberately stays local.** Shell-command approvals
/// (`VerifyApprovalStore`) are NOT moved here, for the same reason as before:
/// each machine must approve a command before it runs, or a cloned repo could
/// ship pre-approved arbitrary shell commands for a loop to run unattended.
/// `LoopEngineDefaults` also stays in UserDefaults — a per-user preference for
/// *new* loops, not a property of any one repo.
enum LoopEngineConfigStore {
    /// `<projectRoot>/system/loop.json`.
    static func fileURL(projectRoot: URL) -> URL {
        projectRoot.appendingPathComponent("system", isDirectory: true)
            .appendingPathComponent("loop.json")
    }

    /// Pretty-printed with sorted keys because this file is committed: a
    /// compact single-line JSON blob would make every budget tweak an
    /// unreviewable diff, and unsorted keys would churn between writes.
    private static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }

    /// This project's saved loops, or `nil` when it has none yet.
    ///
    /// Resolution order:
    /// 1. The file, decoded as the current `LoopEngineProjectStore` schema.
    /// 2. The file, decoded as the legacy bare `LoopEngineConfig` schema —
    ///    wrapped as one Primary loop named "Main Loop" and **written back
    ///    immediately** in the new schema, so the next read hits step 1.
    /// 3. The legacy UserDefaults entry (pre-file era) — wrapped the same way
    ///    and written to the file if a `projectRoot` is available.
    ///
    /// `projectRoot == nil` (no resolvable project folder) skips the file
    /// entirely and falls back to UserDefaults, same as before this existed —
    /// there is nowhere to put a file.
    static func load(projectRoot: URL?, projectId: String,
                     defaults: UserDefaults = .standard) -> LoopEngineProjectStore? {
        guard let projectRoot else {
            return LoopEngineConfig.load(for: projectId, defaults: defaults).map(wrapAsMainLoop)
        }
        let url = fileURL(projectRoot: projectRoot)
        if let data = try? Data(contentsOf: url) {
            if let store = try? JSONDecoder().decode(LoopEngineProjectStore.self, from: data) {
                return store
            }
            if let legacyConfig = try? JSONDecoder().decode(LoopEngineConfig.self, from: data) {
                let wrapped = wrapAsMainLoop(legacyConfig)
                write(wrapped, to: url)
                return wrapped
            }
        }
        if let legacy = LoopEngineConfig.load(for: projectId, defaults: defaults) {
            let wrapped = wrapAsMainLoop(legacy)
            write(wrapped, to: url)
            return wrapped
        }
        return nil
    }

    /// Wraps a pre-multi-loop config as the project's one Primary loop. The
    /// SAME wrapping used by both migration steps in `load`, so a project
    /// migrated via the file path and one migrated via the UserDefaults path
    /// end up with an identical "Main Loop".
    private static func wrapAsMainLoop(_ config: LoopEngineConfig) -> LoopEngineProjectStore {
        LoopEngineProjectStore(loops: [LoopDefinition(name: "Main Loop", isPrimary: true, config: config)])
    }

    /// Persists `store` for this project.
    ///
    /// With a resolvable `projectRoot` the file is the sole source of truth —
    /// the legacy UserDefaults entry is deliberately NOT kept in step, same
    /// reasoning as before. With no `projectRoot`, the Primary loop's bare
    /// `LoopEngineConfig` is written to the legacy UserDefaults slot as a
    /// degraded fallback; a non-Primary loop has nowhere to persist in that
    /// corner case (no project folder resolvable at all), which is an
    /// existing limitation of that fallback, not a new one.
    static func save(_ store: LoopEngineProjectStore, projectRoot: URL?, projectId: String,
                     defaults: UserDefaults = .standard) {
        guard let projectRoot else {
            if let primary = store.loops.first(where: \.isPrimary) ?? store.loops.first {
                primary.config.save(for: projectId, defaults: defaults)
            }
            return
        }
        write(store, to: fileURL(projectRoot: projectRoot))
    }

    /// Whether this project has a saved contract. Goes through `load`, so a
    /// project still on an old schema is migrated by asking this question —
    /// idempotent, and the earliest point we want the migration to happen.
    static func exists(projectRoot: URL?, projectId: String,
                       defaults: UserDefaults = .standard) -> Bool {
        load(projectRoot: projectRoot, projectId: projectId, defaults: defaults) != nil
    }

    /// The loop the scheduled Auto Task sweep and the phone target. Resolves
    /// to the loop marked `isPrimary`, or the first loop if (defensively)
    /// none is marked — the UI never allows unsetting the only Primary
    /// without designating a new one first, so this fallback should not be
    /// reachable in practice.
    static func primaryLoop(projectRoot: URL?, projectId: String,
                            defaults: UserDefaults = .standard) -> LoopDefinition? {
        guard let store = load(projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        else { return nil }
        return store.loops.first(where: \.isPrimary) ?? store.loops.first
    }

    private static func write(_ store: LoopEngineProjectStore, to url: URL) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try encoder().encode(store).write(to: url, options: .atomic)
        } catch {
            NSLog("LoopEngineConfigStore: write failed at \(url.path): \(error.localizedDescription)")
        }
    }
}
