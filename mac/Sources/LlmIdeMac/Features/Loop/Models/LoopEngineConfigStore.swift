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
    /// A file that exists but matches neither schema is NOT "no config": it is
    /// moved aside to `loop.json.corrupt-<timestamp>` (see
    /// `quarantineCorruptFile`) and `nil` is returned without consulting
    /// step 3, so the defaults the caller then saves never overwrite it.
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
        if FileManager.default.fileExists(atPath: url.path) {
            // A READ error is not a corrupt file (a transient I/O hiccup, a
            // sync client holding it): retry once, then report and leave the
            // file alone — `write` refuses to overwrite what it cannot read.
            guard let data = readData(at: url) else {
                NSLog("LoopEngineConfigStore: \(url.path) could not be read; leaving it untouched")
                LoopStoreNotices.shared.post(.readFailed, forFile: url)
                return nil
            }
            let version = fileSchemaVersion(data) ?? 1
            let decoder = JSONDecoder()
            decoder.userInfo[LoopDefinition.fileSchemaVersionKey] = version
            let decoded = try? decoder.decode(LoopEngineProjectStore.self, from: data)
            if version > LoopEngineProjectStore.currentSchemaVersion {
                // A newer build's file is read-only here — even when its shape
                // no longer decodes, it is NOT corrupt: never quarantine it,
                // and `write` refuses to put defaults over it.
                LoopStoreNotices.shared.post(.newerVersion(version), forFile: url)
                return decoded
            }
            if var store = decoded {
                // The pre-file, per-machine opt-in flag is a read-only hint:
                // a machine that already normalised this project keeps the
                // user's later opt-ins when the file is stamped v2.
                if store.schemaVersion < LoopEngineProjectStore.scheduleOptInSchemaVersion,
                   defaults.bool(forKey: "loopScheduleOptInMigrated.\(projectId)") {
                    store.schemaVersion = LoopEngineProjectStore.currentSchemaVersion
                }
                LoopStoreNotices.shared.clear(forFile: url)
                return store
            }
            if let legacyConfig = try? JSONDecoder().decode(LoopEngineConfig.self, from: data) {
                let wrapped = wrapAsMainLoop(legacyConfig)
                write(wrapped, to: url)
                return wrapped
            }
            // Present but unreadable/undecodable (a hand-edit typo, a bad
            // merge). This used to read as "no config", and `loops(...)` then
            // wrote fresh defaults over it — silently discarding the user's
            // loops. Move it aside first so nothing is lost, and do NOT fall
            // through to the pre-file UserDefaults entry: a project that has
            // a file is past that era, so resurrecting it would be a second,
            // quieter clobber.
            let moved = quarantineCorruptFile(at: url)
            LoopStoreNotices.shared.post(.quarantined(movedTo: moved?.lastPathComponent), forFile: url)
            return nil
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
        LoopStoreCache.shared.invalidate(projectRoot: projectRoot.path)
        write(store, to: fileURL(projectRoot: projectRoot))
        LoopStoreCache.shared.invalidate(projectRoot: projectRoot.path)
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
        // No project folder: nothing on disk to watch, so nothing to cache.
        guard let projectRoot else {
            return LoopStageDetector.withDetectionMemo {
                loadEnsured(projectRoot: nil, projectId: projectId, gitRoot: gitRoot, defaults: defaults)
            }
        }
        let key = LoopStoreCache.Key(projectRoot: projectRoot.path, projectId: projectId,
                                     gitRoot: gitRoot?.path, defaults: ObjectIdentifier(defaults))
        if let hit = LoopStoreCache.shared.value(for: key, file: fileURL(projectRoot: projectRoot),
                                                 gitRoot: gitRoot) {
            return hit
        }
        // Signature BEFORE the load: a write landing mid-load must not be
        // cached as if the (older) result matched it.
        let file = fileURL(projectRoot: projectRoot)
        let ticket = LoopStoreCache.shared.ticket(projectRoot: projectRoot.path, file: file, gitRoot: gitRoot)
        let result = LoopStageDetector.withDetectionMemo {
            loadEnsured(projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot, defaults: defaults)
        }
        LoopStoreCache.shared.store(result, for: key, ticket: ticket, file: file, gitRoot: gitRoot)
        return result
    }

    private static func loadEnsured(projectRoot: URL?, projectId: String, gitRoot: URL?,
                                    defaults: UserDefaults) -> LoopEngineProjectStore {
        let saved = load(projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        let (ensuredStore, revalidationChanges) = LoopStageDetector.ensureDefaultLoops(
            in: saved ?? LoopEngineProjectStore(loops: []), gitRoot: gitRoot, defaults: defaults)
        var ensured = ensuredStore
        // The ensure step rebuilds the store; the file's own version must
        // survive it, or a v1 file would look migrated before it ever is.
        if let saved { ensured.schemaVersion = saved.schemaVersion }
        // `revalidatingTestStages` (inside `ensureDefaultLoops`) is a pure
        // function on purpose — it never writes anything itself. This is the
        // one place its result actually reaches disk (`system/loop.json` is a
        // committed, team-shared contract per this file's own doc comment),
        // so an automatic rewrite of a stage's test command MUST be
        // explainable, not a silent diff someone finds in `git diff` later.
        //
        // An `ActivityStore` entry would be the richer notice, but
        // `ActivityStore` is a `@MainActor` SwiftUI environment object owned
        // by the app shell (`LlmIdeMacApp`) — not reachable from this static,
        // non-UI enum, which is also called from background contexts
        // (the Auto Task pipeline sweep) that never touch the shell. Wiring
        // it through would mean threading an ActivityStore reference into
        // every one of this function's callers (Loop views, MobileLoopBridge,
        // the Auto Task pipeline) for one log line — out of scope for this
        // fix. `NSLog`, matching `write(_:to:)` below, is the honest minimum.
        for change in revalidationChanges {
            switch change.kind {
            case let .updated(from, to):
                NSLog("LoopEngineConfigStore: [%@ / %@] test command re-detected, updating \"%@\" -> \"%@\"",
                      change.loopName, change.stageName, from, to)
            case .disabledRefactorApply:
                NSLog("LoopEngineConfigStore: [%@ / %@] no test tooling detected, disabling the code-applying stage",
                      change.loopName, change.stageName)
            case .reenabledRefactorApply:
                NSLog("LoopEngineConfigStore: [%@ / %@] test tooling detected again, re-enabling the code-applying stage",
                      change.loopName, change.stageName)
            case let .upgradedDefault(revision):
                NSLog("LoopEngineConfigStore: [%@ / %@] default stage upgraded to revision %d",
                      change.loopName, change.stageName, revision)
            }
        }
        // Only where there is a file to write the result to — see the helper.
        let unscheduled = projectRoot != nil && normalizeScheduleOptIn(&ensured)
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

    /// Bring a file saved under the old contract (`schemaVersion` < 2) in line
    /// with the current one. Returns whether it changed anything.
    ///
    /// `LoopDefinition.runsOnSchedule` used to default to `true`, so every loop
    /// an old build created was written already opted IN to the scheduled
    /// `.loopEngineering` Auto Task, without the user ever choosing it. This
    /// switches those off and stamps `schemaVersion` 2.
    ///
    /// **Keyed on the file, not the machine.** The version lives in the
    /// committed `loop.json`, so a second machine or a teammate sees a v2 file
    /// and does nothing — the old per-machine UserDefaults flag rewrote the
    /// shared file on every fresh install (those `loopScheduleOptInMigrated.*`
    /// keys are no longer read and are left harmlessly behind). Idempotent: a
    /// v2 store is never touched, so an opt-in the user makes afterwards is
    /// theirs. Stages, budgets, goals and Primary are untouched.
    static func normalizeScheduleOptIn(_ store: inout LoopEngineProjectStore) -> Bool {
        guard store.schemaVersion < LoopEngineProjectStore.scheduleOptInSchemaVersion else { return false }
        store.loops = store.loops.map { loop in
            var copy = loop
            copy.runsOnSchedule = false
            return copy
        }
        store.schemaVersion = LoopEngineProjectStore.currentSchemaVersion
        return true
    }

    /// What a scheduled sweep should do with `loop` right before running it:
    /// the freshly re-read definition to run, or the reason to skip it. The
    /// sweep takes its list once and then runs loops for hours; in that time
    /// the user (or a `git pull`) may have deleted, unscheduled or emptied it.
    static func sweepRecheck(_ loop: LoopDefinition, projectRoot: URL?, projectId: String,
                             gitRoot: URL?, defaults: UserDefaults = .standard)
        -> (loop: LoopDefinition?, skipReason: String?) {
        let fresh = loops(projectRoot: projectRoot, projectId: projectId, gitRoot: gitRoot,
                          defaults: defaults)
        guard let current = fresh.loops.first(where: { $0.id == loop.id }) else {
            return (nil, "it no longer exists")
        }
        if !current.runsOnSchedule { return (nil, "it is no longer scheduled") }
        if current.isManualOnly { return (nil, "it is manual-only") }
        if !current.config.stages.contains(where: \.enabled) { return (nil, "it has no enabled stages") }
        return (current, nil)
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

    /// Renames an undecodable `loop.json` to `loop.json.corrupt-<timestamp>`
    /// beside it, so the next save cannot overwrite the only copy of what the
    /// user wrote. Returns the new location, or nil when the move failed —
    /// in which case the file stays where it is and is still overwritten by
    /// the next save, but the log line says so.
    @discardableResult
    static func quarantineCorruptFile(at url: URL, now: Date = Date()) -> URL? {
        // Filename-safe (no colons), sortable, local time.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let base = "\(url.lastPathComponent).corrupt-\(formatter.string(from: now))"
        var dest = url.deletingLastPathComponent().appendingPathComponent(base)
        // Two quarantines within one second must not collide.
        if FileManager.default.fileExists(atPath: dest.path) {
            dest = url.deletingLastPathComponent()
                .appendingPathComponent("\(base)-\(UUID().uuidString.prefix(8))")
        }
        do {
            try FileManager.default.moveItem(at: url, to: dest)
            NSLog("LoopEngineConfigStore: \(url.path) could not be decoded — moved aside to \(dest.lastPathComponent); the Loop page starts from defaults")
            return dest
        } catch {
            NSLog("LoopEngineConfigStore: \(url.path) could not be decoded and could not be moved aside (\(error.localizedDescription)); it will be overwritten on the next save")
            return nil
        }
    }

    private struct VersionProbe: Decodable { let schemaVersion: Int? }

    /// The file's `schemaVersion` (nil when absent), or nil when `data` is not
    /// a JSON object at all.
    private static func fileSchemaVersion(_ data: Data) -> Int? {
        (try? JSONDecoder().decode(VersionProbe.self, from: data))?.schemaVersion
    }

    /// Reads the file, retrying once — a read error is never grounds to
    /// quarantine.
    private static func readData(at url: URL) -> Data? {
        if let data = try? Data(contentsOf: url) { return data }
        return try? Data(contentsOf: url)
    }

    /// Whether overwriting whatever sits at `url` is safe: refuses a file this
    /// build cannot read or one written by a newer schema; sets aside a file
    /// that is not even JSON so its content is never lost.
    private static func mayOverwrite(_ url: URL) -> Bool {
        guard FileManager.default.fileExists(atPath: url.path) else { return true }
        guard let data = readData(at: url) else {
            NSLog("LoopEngineConfigStore: refusing to write \(url.path): it exists but cannot be read")
            LoopStoreNotices.shared.post(.readFailed, forFile: url)
            return false
        }
        guard (try? JSONDecoder().decode(VersionProbe.self, from: data)) != nil else {
            let moved = quarantineCorruptFile(at: url)
            LoopStoreNotices.shared.post(.quarantined(movedTo: moved?.lastPathComponent), forFile: url)
            return true
        }
        if let onDisk = fileSchemaVersion(data), onDisk > LoopEngineProjectStore.currentSchemaVersion {
            NSLog("LoopEngineConfigStore: refusing to write \(url.path): schemaVersion \(onDisk) is newer than this build's \(LoopEngineProjectStore.currentSchemaVersion)")
            LoopStoreNotices.shared.post(.newerVersion(onDisk), forFile: url)
            return false
        }
        return true
    }

    /// Fail-quiet: losing a write is bad, but throwing from a SwiftUI action
    /// or the cron sweep would be worse than the user re-saving.
    private static func write(_ store: LoopEngineProjectStore, to url: URL) {
        guard mayOverwrite(url) else { return }
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try encoder().encode(store).write(to: url, options: .atomic)
            // A quarantine notice stays until the next clean load; the others
            // describe a state this write just proved is over.
            if case .quarantined? = LoopStoreNotices.shared.notice(forFile: url) {} else {
                LoopStoreNotices.shared.clear(forFile: url)
            }
        } catch {
            NSLog("LoopEngineConfigStore: write failed at \(url.path): \(error.localizedDescription)")
        }
    }
}
