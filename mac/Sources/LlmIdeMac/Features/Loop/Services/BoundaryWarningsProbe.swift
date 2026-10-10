import Foundation

/// Counts cross-feature boundary warnings by running `mac/Scripts/feature-boundaries.sh`.
/// llm-ide only: returns nil when the script is absent, the run times out or no `total:` line is printed.
/// Runs only in LLM-IDE's own checkout: another repo may ship a script at the same path.
struct BoundaryWarningsProbe {
    static let timeout: TimeInterval = 120

    static func count(gitRoot: URL) async -> Int? {
        guard LoopStageDetector.isAppSourceRoot(gitRoot) else { return nil }
        let script = gitRoot.appendingPathComponent("mac/Scripts/feature-boundaries.sh")
        guard FileManager.default.fileExists(atPath: script.path) else { return nil }

        let quoted = "'" + script.path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let process: GroupedSubprocess
        do {
            process = try GroupedSubprocess.launch(shellCommand: "bash \(quoted)", directory: gitRoot)
        } catch {
            return nil
        }
        // The gate's exit status is not used: it is 1 whenever a build-failing check fails,
        // and the total line is printed before those checks run.
        defer { if !process.hasExited { process.terminateTree(grace: 1) } }

        let deadline = Date().addingTimeInterval(timeout)
        while !process.hasExited {
            if Task.isCancelled || Date() >= deadline { return nil }
            await GroupedSubprocess.pause(nanoseconds: 50_000_000)
        }
        let output = await process.collectOutput()
        return parseTotal(output)
    }

    /// Parses `total: N  sealed violations: M` into N.
    static func parseTotal(_ output: String) -> Int? {
        for line in output.split(whereSeparator: \.isNewline) where line.hasPrefix("total: ") {
            let rest = line.dropFirst("total: ".count)
            let digits = rest.prefix { $0.isNumber }
            return Int(digits)
        }
        return nil
    }
}
