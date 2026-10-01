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
        try git(["worktree", "remove", "--force", proposal.worktreePath], in: main)
        _ = try? git(["branch", "-D", proposal.branch], in: main)
    }

    // Both pipes are read on background threads before `waitUntilExit()`: a
    // process that writes more than the pipe buffer to stderr while nothing
    // drains it would otherwise deadlock here (git is noisy enough to hit
    // this on even a modest worktree listing).
    @discardableResult
    static func git(_ args: [String], in dir: URL, input: Data? = nil) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = args
        process.currentDirectoryURL = dir
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        let inPipe = Pipe()
        if input != nil { process.standardInput = inPipe }
        try process.run()
        if let input {
            inPipe.fileHandleForWriting.write(input)
            try? inPipe.fileHandleForWriting.close()
        }
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
        group.wait()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let errText = String(data: errData, encoding: .utf8) ?? ""
            throw Failure.git(errText.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return outData
    }
}
