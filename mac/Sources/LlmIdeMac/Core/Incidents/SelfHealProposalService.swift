import Foundation

/// Git operations on a Self-Heal proposal's worktree: discarding one that
/// produced no fix (Task 9), diffing and applying one that did (Task 10).
public enum SelfHealProposalService {
    public enum Failure: Error, LocalizedError {
        case git(String)
        public var errorDescription: String? { if case .git(let m) = self { return m } else { return nil } }
    }

    public static func discard(_ proposal: IncidentProposal) throws {
        let main = URL(fileURLWithPath: proposal.mainRepo)
        // A worktree already removed by hand must not block marking the proposal discarded.
        if FileManager.default.fileExists(atPath: proposal.worktreePath) {
            try git(["worktree", "remove", "--force", proposal.worktreePath], in: main)
        } else {
            _ = try? git(["worktree", "prune"], in: main)
        }
        _ = try? git(["branch", "-D", proposal.branch], in: main)
    }

    public static let excludedPaths = [".self-heal", ".skills", "mac/LocalPackages/graph-kit", "extension/node_modules"]

    private static var pathspec: [String] { ["--", "."] + excludedPaths.map { ":(exclude)\($0)" } }

    private static func stagedPatch(_ proposal: IncidentProposal, binary: Bool) throws -> Data {
        let wt = URL(fileURLWithPath: proposal.worktreePath)
        try git(["add", "-A"] + pathspec, in: wt)
        return try git(["diff", "--cached"] + (binary ? ["--binary"] : []) + [proposal.baseCommit] + pathspec, in: wt)
    }

    public static func diff(_ proposal: IncidentProposal) throws -> String {
        String(data: try stagedPatch(proposal, binary: false), encoding: .utf8) ?? ""
    }

    /// All-or-nothing: `--check` first, because a partial apply would leave the main checkout half-changed.
    public static func apply(_ proposal: IncidentProposal) throws {
        let patch = try stagedPatch(proposal, binary: true)
        guard !patch.isEmpty else { throw Failure.git("The proposal has no changes.") }
        let main = URL(fileURLWithPath: proposal.mainRepo)
        try git(["apply", "--check", "-"], in: main, input: patch)
        try git(["apply", "-"], in: main, input: patch)
    }

    @MainActor
    public static func markApplied(_ proposal: IncidentProposal, store: IncidentStore) {
        for incident in store.incidents where incident.proposal == proposal {
            store.update(id: incident.id) { $0.status = .fixed; $0.proposal = nil }
        }
    }

    @MainActor
    public static func markDiscarded(_ proposal: IncidentProposal, store: IncidentStore) {
        for incident in store.incidents where incident.proposal == proposal {
            store.update(id: incident.id) { $0.status = .ignored; $0.proposal = nil; $0.note = "proposal discarded" }
        }
    }

    // Drains start before stdin is written, and stdin is written on its own queue, to avoid a deadlock if git exits early.
    @discardableResult
    public static func git(_ args: [String], in dir: URL, input: Data? = nil) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = args
        process.currentDirectoryURL = dir
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        let inPipe = Pipe()
        if input != nil {
            process.standardInput = inPipe
            // Without this, the kernel's default SIGPIPE action kills the process on a broken
            // pipe before `write(contentsOf:)` can return EPIPE, so `try?` alone would not help.
            _ = fcntl(inPipe.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        }
        try process.run()

        var outData = Data()
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            outData = out.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            errData = err.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        if let input {
            group.enter()
            DispatchQueue.global().async {
                // A broken pipe (git exited early) must not crash the process.
                try? inPipe.fileHandleForWriting.write(contentsOf: input)
                try? inPipe.fileHandleForWriting.close()
                group.leave()
            }
        }
        group.wait()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let errText = String(data: errData, encoding: .utf8) ?? ""
            throw Failure.git(errText.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return outData
    }
}
