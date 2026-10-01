import Foundation
import os

/// Whether a shell-command stage may run on this machine: approved by the user
/// (`VerifyApprovalStore`), or a stage with a `defaultKey` whose command is
/// exactly what this build detects for that key in this checkout.
///
/// The second rule lets the built-in loops run without a first-run approval
/// click, on every lane (Mac, phone, schedule). It only pins the command
/// STRING: a `loop.json` cannot get an arbitrary command through, but the
/// detected commands themselves (`make test`, `npm test`, `swift test`) run
/// the repo's own Makefile/package.json/Package.swift — so a cloned repo's
/// test recipe runs with no click. Accepted deliberately for out-of-the-box
/// loops; edited and user-added commands still need explicit approval.
public enum LoopStageApproval {
    /// - Parameter fresh: re-detect from disk (the runner's preflight); views
    ///   pass `false` and accept a few seconds of staleness.
    public static func isApproved(_ stage: LoopStage, command: String, repo: URL,
                           approvals: VerifyApprovalStore, fresh: Bool = false) -> Bool {
        approvals.isStageApproved(repo: repo, stageId: stage.id, command: command)
            || isDetectedDefault(stage, command: command, repo: repo, fresh: fresh)
    }

    /// True when the stage passes because it is an unedited default.
    public static func isDetectedDefault(_ stage: LoopStage, command: String, repo: URL,
                                  fresh: Bool = false) -> Bool {
        guard stage.kind == .shellCommand, let key = stage.defaultKey else { return false }
        let detected = fresh
            ? LoopStageDetector.detectedDefaultCommand(forKey: key, gitRoot: repo)
            : detectedCommand(forKey: key, repo: repo)
        return detected == command
    }

    /// Enabled shell stages still waiting for an explicit approval, with the
    /// exact command string the runner's preflight will hash.
    public static func pending(_ stages: [LoopStage], repo: URL,
                        approvals: VerifyApprovalStore) -> [(stage: LoopStage, command: String)] {
        stages.compactMap { stage in
            guard stage.enabled, stage.kind == .shellCommand,
                  let command = stage.command,
                  !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !isApproved(stage, command: command, repo: repo, approvals: approvals)
            else { return nil }
            return (stage, command)
        }
    }

    // Detection reads the Makefile/package.json; SwiftUI bodies call this on
    // every re-render (each log line during a run), so results are reused
    // briefly rather than re-read from disk per row.
    private struct CacheEntry {
        let at: Date
        let commands: [String: String?]
    }
    private static let cache = OSAllocatedUnfairLock<[String: CacheEntry]>(initialState: [:])
    private static let cacheLifetime: TimeInterval = 5

    private static func detectedCommand(forKey key: String, repo: URL) -> String? {
        let path = repo.standardizedFileURL.path
        if let hit = cache.withLock({ entries -> String?? in
            guard let entry = entries[path], Date().timeIntervalSince(entry.at) < cacheLifetime else { return nil }
            return entry.commands[key]
        }) {
            return hit
        }
        let value = LoopStageDetector.detectedDefaultCommand(forKey: key, gitRoot: repo)
        cache.withLock { entries in
            let now = Date()
            let live = entries[path].flatMap { now.timeIntervalSince($0.at) < cacheLifetime ? $0 : nil }
            var commands = live?.commands ?? [:]
            commands[key] = .some(value)
            entries[path] = CacheEntry(at: live?.at ?? now, commands: commands)
        }
        return value
    }
}
