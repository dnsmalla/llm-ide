import Foundation
import SharedProtocol

/// Runs ONE git command in the project's working tree and returns stdout.
typealias GitRun = @Sendable ([String]) async throws -> String

/// Read-only git for the phone. Never constructs the Mac's `SourceControlService` (it writes
/// `.gitignore` files and holds UI state); runs a small fixed set of read commands instead. Every
/// path the phone asks about is checked against the Mac's own current status first.
enum PhoneGit {
    static let maxFiles = 200
    static let maxCommits = 30
    static let maxDiffChars = 100_000
    /// Diffs bigger than this many changed lines are refused up front, before git renders them.
    static let maxDiffLines = 20_000
    static let maxUntrackedBytes = 200_000

    // MARK: State

    static func state(hasGitDir: Bool, run: GitRun) async -> ScmState {
        guard hasGitDir else {
            return ScmState(isRepo: false, branch: nil, ahead: 0, behind: 0, hasUpstream: false, files: [],
                            filesTruncated: false, commits: [], error: nil)
        }
        do {
            let porcelain = try await run(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"])
            let changes = StatusParser.parse(porcelain: porcelain)
            let branch = (try? await run(["rev-parse", "--abbrev-ref", "HEAD"]))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            var ahead = 0, behind = 0, hasUpstream = false
            if let counts = try? await run(["rev-list", "--count", "--left-right", "@{u}...HEAD"]) {
                let parts = counts.split(whereSeparator: { $0 == "\t" || $0 == " " || $0 == "\n" })
                if parts.count == 2, let b = Int(parts[0]), let a = Int(parts[1]) {
                    behind = b; ahead = a; hasUpstream = true
                }
            }
            let log = (try? await run(["log", "--pretty=%H%x1f%h%x1f%an%x1f%ar%x1f%s", "-n", String(maxCommits)])) ?? ""
            return shape(changes: changes, branch: branch, ahead: ahead, behind: behind, hasUpstream: hasUpstream,
                         commits: GitLog.parse(log))
        } catch let failure {
            return ScmState(isRepo: true, branch: nil, ahead: 0, behind: 0, hasUpstream: false, files: [],
                            filesTruncated: false, commits: [], error: PhoneRedaction.short(failure.localizedDescription))
        }
    }

    /// Pure shaping (capped, bounded text) so a test can pin it without git.
    static func shape(changes: [FileChange], branch: String?, ahead: Int, behind: Int, hasUpstream: Bool,
                      commits: [Commit]) -> ScmState {
        ScmState(
            isRepo: true,
            branch: branch.flatMap { $0.isEmpty ? nil : String($0.prefix(120)) },
            ahead: ahead, behind: behind, hasUpstream: hasUpstream,
            files: changes.prefix(maxFiles).map {
                ScmFile(path: String($0.path.prefix(300)), status: $0.status.rawValue, staged: $0.staged)
            },
            filesTruncated: changes.count > maxFiles,
            commits: commits.prefix(maxCommits).map {
                ScmCommit(sha: $0.shortSha, author: String($0.author.prefix(60)), relativeDate: $0.relativeDate,
                          subject: PhoneRedaction.short($0.subject, limit: 200))
            },
            error: nil)
    }

    // MARK: Diff

    /// `nil` = allowed to show this path.
    static func refusal(path: String, staged: Bool, in changes: [FileChange]) -> String? {
        guard changes.contains(where: { $0.path == path && $0.staged == staged }) else {
            return "That file isn't in the Mac's current change list. Refresh and try again."
        }
        let name = (path as NSString).lastPathComponent
        if MobileWorkspaceSearch.isDenied(relPath: path, name: name) {
            return "This looks like a secrets file (key, .env…), so its contents aren't shown on the phone."
        }
        return nil
    }

    static func diff(path: String, staged: Bool, root: URL, run: GitRun) async -> ScmDiffResult {
        func fail(_ why: String) -> ScmDiffResult { ScmDiffResult(path: path, staged: staged, diff: nil, error: why) }
        do {
            let porcelain = try await run(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"])
            let changes = StatusParser.parse(porcelain: porcelain)
            if let why = refusal(path: path, staged: staged, in: changes) { return fail(why) }
            let change = changes.first { $0.path == path && $0.staged == staged }

            if change?.status == .untracked {
                return untracked(path: path, root: root)
            }
            let cached = staged ? ["--cached"] : []
            let numstat = try await run(["diff", "--no-ext-diff", "--numstat"] + cached + ["--", path])
            if let line = numstat.split(separator: "\n").first {
                let cols = line.split(separator: "\t")
                if cols.count >= 2, cols[0] == "-", cols[1] == "-" {
                    return ScmDiffResult(path: path, staged: staged, diff: "Binary file — not shown.")
                }
                if cols.count >= 2, let a = Int(cols[0]), let r = Int(cols[1]), a + r > maxDiffLines {
                    return fail("This diff is too large to show on the phone (\(a + r) changed lines).")
                }
            }
            let raw = try await run(["diff", "--no-ext-diff", "--no-color"] + cached + ["--", path])
            let r = PhoneRedaction.lines(raw, maxChars: maxDiffChars)
            return ScmDiffResult(path: path, staged: staged, diff: r.text.isEmpty ? "(no changes)" : r.text,
                                 truncated: r.truncated)
        } catch let failure {
            return fail(PhoneRedaction.short(failure.localizedDescription))
        }
    }

    /// git shows nothing for an untracked file; present it as all-added, with a bounded read.
    static func untracked(path: String, root: URL) -> ScmDiffResult {
        let url = root.appendingPathComponent(path)
        let real = url.resolvingSymlinksInPath().standardizedFileURL.path
        let realRoot = root.resolvingSymlinksInPath().standardizedFileURL.path
        guard real.hasPrefix(realRoot + "/"),
              let handle = try? FileHandle(forReadingFrom: url) else {
            return ScmDiffResult(path: path, staged: false, diff: nil, error: "Couldn't read that file.")
        }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: maxUntrackedBytes + 1)) ?? Data()
        guard let text = String(data: data.prefix(maxUntrackedBytes), encoding: .utf8) else {
            return ScmDiffResult(path: path, staged: false, diff: "Binary file — not shown.")
        }
        let added = text.split(separator: "\n", omittingEmptySubsequences: false).map { "+" + $0 }.joined(separator: "\n")
        let r = PhoneRedaction.lines("New file (untracked)\n" + added, maxChars: maxDiffChars)
        return ScmDiffResult(path: path, staged: false, diff: r.text, truncated: r.truncated || data.count > maxUntrackedBytes)
    }
}
