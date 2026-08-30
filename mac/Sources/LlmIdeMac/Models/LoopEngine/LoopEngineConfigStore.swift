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

    /// This project's loops **as the app actually runs them**: `load`, then
    /// `LoopStageDetector.ensureDefaultLoops` — which creates the built-in
    /// default loops (Regression / Test / System Check), migrates a pre-split
    /// project's single aggregate loop into them, and re-pins each loop's own
    /// stages.
    ///
    /// Every surface that needs a project's real loop list goes through here,
    /// so the desktop, the scheduler, the chat command and the phone can never
    /// disagree about which loops exist — the divergence that made the phone
    /// under-report stages before.
    ///
    /// **When it writes.** Only when the ensure actually changed something AND
    /// the result is worth committing: either the project already had a saved
    /// file, or the ensured list contains a stage beyond the unconditional
    /// defaults — the bare Regression sweep and the Plan loop's skill stages
    /// (`LoopEngineConfig.shouldPersist`, applied across all loops). That is
    /// the same rule as before — an all-unconditional detection can mean "the
    /// tree has not finished populating", and persisting it would silently
    /// disable a Test loop for good. `projectRoot == nil` never writes.
    ///
    /// It also runs `normalizeScheduleOptIn` once per project, which switches
    /// off the schedule flag that older builds set on every loop they created.
    static func loops(projectRoot: URL?, projectId: String, gitRoot: URL?,
                      defaults: UserDefaults = .standard) -> LoopEngineProjectStore {
        let saved = load(projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        var ensured = LoopStageDetector.ensureDefaultLoops(
            in: saved ?? LoopEngineProjectStore(loops: []), gitRoot: gitRoot, defaults: defaults)
        // Only where there is a file to write the result to — see the helper.
        let unscheduled = projectRoot != nil
            && normalizeScheduleOptIn(&ensured, projectId: projectId, defaults: defaults)
        // `unscheduled` implies `ensured != saved` (a flag was flipped on a
        // loaded loop), so it is belt-and-braces — but a normalization that
        // silently failed to persist would leave the loops running, which is
        // the exact thing it exists to stop.
        guard ensured != saved || unscheduled else { return ensured }
        let worthKeeping = saved != nil
            || LoopEngineConfig.shouldPersist(ensured.loops.flatMap(\.config.stages))
        if worthKeeping {
            save(ensured, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        }
        return ensured
    }

    /// UserDefaults flag marking a project as already normalized. Per project,
    /// not per app: projects are opened at different times, so a single global
    /// flag would normalize whichever project happened to be opened first and
    /// leave every other one scheduled.
    private static func scheduleOptInMigrationKey(_ projectId: String) -> String {
        "loopScheduleOptInMigrated.\(projectId)"
    }

    /// Bring a project saved under the old contract in line with the current
    /// one, exactly once. Returns whether it changed anything.
    ///
    /// `LoopDefinition.runsOnSchedule` used to default to `true`, so every loop
    /// this app has ever created — the four built-in defaults included — was
    /// written to `system/loop.json` already opted IN to the scheduled
    /// `.loopEngineering` Auto Task, without the user ever choosing it.
    /// Flipping the creation default to `false` fixes loops created from now
    /// on and does nothing for the ones already on disk, which would keep
    /// running on the cron; this switches those off.
    ///
    /// **Once, then never again.** The flag is set on the first call for a
    /// project whether or not anything changed, so an opt-in the user makes
    /// afterwards (Loop page → ⋯ → "Run on schedule") is theirs and is never
    /// reverted. Deliberately not destructive beyond that one flag: stages,
    /// budgets, goals and Primary are untouched, and re-enabling a loop is one
    /// menu item.
    static func normalizeScheduleOptIn(_ store: inout LoopEngineProjectStore, projectId: String,
                                       defaults: UserDefaults = .standard) -> Bool {
        let key = scheduleOptInMigrationKey(projectId)
        guard !defaults.bool(forKey: key) else { return false }
        defaults.set(true, forKey: key)
        guard store.loops.contains(where: \.runsOnSchedule) else { return false }
        store.loops = store.loops.map { loop in
            var copy = loop
            copy.runsOnSchedule = false
            return copy
        }
        return true
    }

    /// The project's Primary loop — the phone's target, and what a surface
    /// that can only address ONE loop (chat's "run the loop") acts on.
    ///
    /// Goes through `loops(...)`, so it sees the same ensured list as every
    /// other surface, and returns nil only for a project with no loops at all
    /// (no git root to detect from and nothing saved). `ensureDefaultLoops`
    /// guarantees exactly one `isPrimary`; the `?? first` is defensive only.
    static func primaryLoop(projectRoot: URL?, projectId: String, gitRoot: URL?,
                            defaults: UserDefaults = .standard) -> LoopDefinition? {
        let store = loops(projectRoot: projectRoot, projectId: projectId,
                          gitRoot: gitRoot, defaults: defaults)
        return store.loops.first(where: \.isPrimary) ?? store.loops.first
    }

    /// Fail-quiet: losing a write is bad, but throwing from a SwiftUI action
    /// or the cron sweep would be worse than the user re-saving.
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
