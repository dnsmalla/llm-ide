// Directory migration: move legacy memory/graph directories into the canonical
// `.llm-ide/` structure.
//
// Swift mirror of `extension/graphkit/storage/migrate.ts` (Task 5).
//
// Migration is graceful — a missing legacy path is reported as `skipped`, not
// an `error`, so calling `migrateToLLMIdeStructure` on a fresh repo is a no-op.
// Each entry (file or subdirectory) is moved with `FileManager.moveItem` /
// `replaceItem`, which are same-filesystem renames and therefore atomic in the
// same sense as the TS layer's `fs.rename`: an entry is either at the old path
// or the new one, never deleted-and-not-yet-recreated. A crash mid-migration
// can never lose data. After moving every entry the now-empty legacy leaf
// directory is removed; if it is non-empty (e.g. a concurrent writer added a
// file) it is left in place — mirroring `fs.rmdir`, which only succeeds on an
// empty directory.
//
// Conventions follow the sibling storage layers (`MemoryStorage`,
// `GraphStorage`): a stateless `Sendable` class with `public init()`, methods
// that take `repoRoot` explicitly, and `async` signatures to match the TS
// contract. `migrateToLLMIdeStructure` is intentionally non-`throws`: the TS
// design captures per-step failures into `result.errors` rather than aborting
// the remaining steps, and faithful parity requires the same shape in Swift.

import Foundation

/// One legacy -> canonical directory move planned by `Migration`.
///
/// Mirrors the TS `MigrationStep` (`{ from: string; to: string }`) as URLs,
/// which is the Mac app's path type. `Sendable` + `Equatable` so the result can
/// cross actors and be asserted on in tests.
public struct MigrationStep: Sendable, Equatable {
    public let from: URL
    public let to: URL

    public init(from: URL, to: URL) {
        self.from = from
        self.to = to
    }
}

/// A legacy path that was not migrated because it did not exist.
///
/// Mirrors the TS `skipped: Array<{ path: string; reason: string }>`. Only the
/// `not_found` reason is produced today, but the reason field is retained for
/// parity and for future sources (e.g. a `disabled` reason behind a flag).
public struct MigrationSkip: Sendable, Equatable {
    public let path: URL
    public let reason: String

    public init(path: URL, reason: String) {
        self.path = path
        self.reason = reason
    }
}

/// A per-step failure captured during migration. Mirrors the TS
/// `errors: Array<{ step: MigrationStep; error: string }>`. Modeled as a struct
/// (rather than the brief's `(step: MigrationStep, error: String)` tuple) so
/// that `MigrationResult` is `Equatable`/`Sendable` by synthesis — a tuple-
/// typed array cannot conform to `Equatable` and would force tests to unpack
/// fields instead of comparing whole results.
public struct MigrationError: Sendable, Equatable {
    public let step: MigrationStep
    public let message: String

    public init(step: MigrationStep, message: String) {
        self.step = step
        self.message = message
    }
}

/// Outcome of a migration run. Each list is independent: a step that was
/// migrated does not also appear in `skipped` or `errors`. Mirrors the TS
/// `MigrationResult` shape field-for-field.
public struct MigrationResult: Sendable, Equatable {
    public var migrated: [MigrationStep] = []
    public var skipped: [MigrationSkip] = []
    public var errors: [MigrationError] = []

    public init() {}

    public init(
        migrated: [MigrationStep] = [],
        skipped: [MigrationSkip] = [],
        errors: [MigrationError] = []
    ) {
        self.migrated = migrated
        self.skipped = skipped
        self.errors = errors
    }
}

/// Graceful, atomic migrator from legacy storage layouts to `.llm-ide/`.
///
/// Stateless: every operation takes the repo root explicitly, so a single
/// shared instance is safe to use from any actor (hence `Sendable`). Methods
/// are `async` to match the TS contract and the sibling storage layers, even
/// though the current bodies are synchronous file I/O; this leaves room for
/// genuinely async I/O later without breaking callers.
public final class Migration: Sendable {

    public init() {}

    /// The legacy memory directory: `<repoRoot>/graphify-out/memory`.
    private func legacyMemoryDir(repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent("graphify-out").appendingPathComponent("memory")
    }

    /// The legacy graph directory: `<repoRoot>/system/graph`.
    private func legacyGraphDir(repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent("system").appendingPathComponent("graph")
    }

    /// Canonical memory directory: `<repoRoot>/.llm-ide/memory`. Matches
    /// `MemoryStorage.getMemoryDir` so the destination is byte-for-byte the
    /// same path the storage layer reads/writes.
    private func canonicalMemoryDir(repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
    }

    /// Canonical graph directory: `<repoRoot>/.llm-ide/graph`. Matches
    /// `GraphStorage.getGraphDir`.
    private func canonicalGraphDir(repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent(".llm-ide").appendingPathComponent("graph")
    }

    /// The planned legacy -> canonical moves for a repo. Both the `from` and
    /// `to` paths are resolved from the same `repoRoot`, so a root with spaces
    /// (or any percent-encoding quirks) stays consistent between source and
    /// destination — the same invariant `fileURLToPath` establishes in the TS
    /// layer.
    private func plannedSteps(repoRoot: URL) -> [MigrationStep] {
        [
            MigrationStep(
                from: legacyMemoryDir(repoRoot: repoRoot),
                to: canonicalMemoryDir(repoRoot: repoRoot)
            ),
            MigrationStep(
                from: legacyGraphDir(repoRoot: repoRoot),
                to: canonicalGraphDir(repoRoot: repoRoot)
            ),
        ]
    }

    /// Check if migration is needed — true if any legacy path exists on disk.
    ///
    /// Mirrors TS `needsMigration`. `FileManager.fileExists` is the Swift
    /// equivalent of `fs.access` for existence probing and follows the same
    /// "exists -> true" semantics without throwing.
    public func needsMigration(repoRoot: URL) async -> Bool {
        for step in plannedSteps(repoRoot: repoRoot) {
            if FileManager.default.fileExists(atPath: step.from.path) {
                return true
            }
        }
        return false
    }

    /// Migrate legacy memory/graph directories to the canonical `.llm-ide/`
    /// structure. Moves `graphify-out/memory` -> `.llm-ide/memory` and
    /// `system/graph` -> `.llm-ide/graph`. Missing legacy paths are skipped;
    /// per-step failures are captured in `errors` and do not abort the
    /// remaining steps.
    ///
    /// Non-`throws` by design (matches the TS contract): the orchestrator never
    /// raises — a step either moves, is skipped, or records an error, and the
    /// caller inspects `MigrationResult` to decide what to surface.
    public func migrateToLLMIdeStructure(repoRoot: URL) async -> MigrationResult {
        var result = MigrationResult()

        for step in plannedSteps(repoRoot: repoRoot) {
            do {
                guard FileManager.default.fileExists(atPath: step.from.path) else {
                    result.skipped.append(MigrationSkip(path: step.from, reason: "not_found"))
                    continue
                }

                // Ensure the canonical target directory exists before moving
                // into it (matches TS `fs.mkdir(to, { recursive: true })`).
                try FileManager.default.createDirectory(
                    at: step.to, withIntermediateDirectories: true)

                // Move every entry (file or subdirectory) with an atomic,
                // same-filesystem rename. A same-named entry at the destination
                // is overwritten — `moveItem` refuses to overwrite, so use
                // `replaceItem` in that case (mirrors `fs.rename` clobber).
                let entries = try FileManager.default.contentsOfDirectory(
                    at: step.from, includingPropertiesForKeys: nil)
                for entry in entries {
                    let dest = step.to.appendingPathComponent(entry.lastPathComponent)
                    try Self.moveOrReplace(at: entry, to: dest)
                }

                // Best-effort: remove the now-empty legacy leaf directory, only
                // when it is actually empty. `FileManager.removeItem` removes
                // recursively, so we check emptiness explicitly to mirror
                // `fs.rmdir` — if a concurrent writer added a file between the
                // readdir above and now, we leave the directory in place rather
                // than deleting someone else's data.
                if let remaining = try? FileManager.default.contentsOfDirectory(
                    atPath: step.from.path),
                   remaining.isEmpty {
                    try? FileManager.default.removeItem(at: step.from)
                }

                result.migrated.append(step)
            } catch {
                result.errors.append(
                    MigrationError(step: step, message: error.localizedDescription))
            }
        }

        return result
    }

    /// Atomic move with overwrite semantics. Mirrors `fs.rename` (the TS layer)
    /// and the swap pattern used by `MemoryStorage.writeMemoryFile` /
    /// `GraphStorage.writeAtomically`: `moveItem` is a same-filesystem rename
    /// and is atomic, but it refuses to overwrite an existing destination, so
    /// when one exists we swap via `replaceItem` instead.
    ///
    /// `replaceItem` requires the destination to exist (it replaces it), and
    /// `moveItem` requires it to NOT exist — so the pre-check selects the right
    /// primitive. `resultingItemURL` is required by this SDK's signature; we
    /// pass nil because the replaced URL isn't needed.
    private static func moveOrReplace(at src: URL, to dest: URL) throws {
        if FileManager.default.fileExists(atPath: dest.path) {
            _ = try FileManager.default.replaceItem(
                at: dest, withItemAt: src, backupItemName: nil,
                options: [], resultingItemURL: nil)
        } else {
            try FileManager.default.moveItem(at: src, to: dest)
        }
    }
}
