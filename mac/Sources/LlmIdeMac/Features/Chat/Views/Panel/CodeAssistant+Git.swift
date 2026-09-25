import SwiftUI

extension CodeAssistantPanel {
    // Note: sheets.branchSheetContext @State property is in the main file

    // MARK: - Branch creation

    func confirmBranchCreation(_ args: BranchCreationSheet.Args) async -> BranchCreationSheet.ConfirmResult {
        guard let repoURL = config.activeRepoLocalURL, WorkspaceRoot.isGitRepo(repoURL) else {
            return .failure("Not in a git repository")
        }

        let repoManager = RepoManager()
        do {
            // Both names come from the agent. Unvalidated, `branch: "-D",
            // start: "main"` deleted main and `branch: "-f"` reset it.
            var gitArgs = ["branch", try RepoManager.safeRef(args.branch)]
            if let startPoint = args.startPoint {
                gitArgs.append(try RepoManager.safeRef(startPoint))
            }

            _ = try await repoManager.runGit(gitArgs, at: repoURL)

            engine.agent.pendingTool = nil
            let payload = ChatMessage.ToolResultPayload(
                kind: .git, summary: "(executed create-branch → \(args.branch))",
                exitCode: nil, command: nil, output: nil, url: nil, isFailure: false)
            // Sheet-driven, not the auto-chain path — .ifIdle matches the old
            // plain sendFollowup() (no-op if an autonomous turn is streaming).
            await engine.acknowledge(payload, followUp: .ifIdle)
            return .success(args.branch)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    // MARK: - Git operations

    /// Whether a proposed git op may run WITHOUT the confirm card:
    ///   - read-tier (status/log/diff/branch): always — never mutates anything.
    ///   - write-tier (add, commit, create_branch, checkout, pull_ff, push): only
    ///     in Auto mode. The user opted into automation and these are recoverable
    ///     (commits/branches are local; push targets the auto-created agent/
    ///     branch, never main).
    ///   - destructive (merge, revert, reset, stash, clean, merge_to_main): NEVER
    ///     — they can lose work or rewrite main, so they always confirm.
    /// The per-turn count bound stops a looping agent from chaining write ops.
    func shouldAutoRunGitOp(_ args: GitOpArgs) -> Bool {
        guard autoGitOpsThisTurn < Self.maxAutoGitOpsPerTurn else { return false }
        switch args.op.tier {
        case .read:        return true
        case .write:       return editMode.autoRunsCommands
        case .destructive: return false
        }
    }

    /// Execute an agent git-op: clear pendingTool, run the op, append a synthetic
    /// result turn, and call sendFollowup so the agent can acknowledge.
    /// Read-tier ops are auto-run from runTurn; write/destructive run after sheet confirm.
    @MainActor
    func runGitOpFlow(_ args: GitOpArgs) async {
        engine.agent.pendingTool = nil
        sheets.showingGitOpSheet = false
        // Resolve the active repo URL — GitLab first, then GitHub (mirrors config.activeRepoLocalURL).
        guard let repoURL = config.activeRepoLocalURL else {
            let payload = ChatMessage.ToolResultPayload(
                kind: .git, summary: "(git \(args.op.rawValue) skipped — no active repository)",
                exitCode: nil, command: nil, output: nil, url: nil, isFailure: true)
            // Read-tier ops can reach here from INSIDE runTurn's auto-run path
            // (busy still true) — force the follow-up through, as the old
            // unblockAndFollowUp() call here always did.
            await engine.acknowledge(payload, followUp: .forceUnblock)
            return
        }
        // Pick the token by the REPO'S remote host, not by which project is
        // active: `activeRepoLocalURL` falls back to the GitHub clone when the
        // active GitLab project is not cloned, and choosing by activity then
        // sent the GitLab PAT to github.com. RepoManager refuses a mismatch
        // anyway (credentialScope); this just picks the right one first. Read/
        // local ops need no token and `nil` is fine for them.
        let manager = RepoManager()
        let host = await manager.remoteHost(at: repoURL)
        let gitLabHost = URL(string: config.gitLabBaseURL.trimmingCharacters(in: .whitespacesAndNewlines))?
            .host?.lowercased() ?? "gitlab.com"
        let token: String?
        var backend: RepoManager.Backend = .gitlab
        if host == "github.com", !config.gitHubToken.isEmpty {
            token = config.gitHubToken
            backend = .github
        } else if host == gitLabHost, !config.gitLabToken.isEmpty {
            token = config.gitLabToken
        } else {
            token = nil
        }
        do {
            let out = try await manager.runGitOp(args, at: repoURL, token: token, backend: backend)
            let payload = ChatMessage.ToolResultPayload(
                kind: .git, summary: "(git \(args.op.rawValue) result)",
                exitCode: nil, command: nil, output: String(out.prefix(4000)), url: nil, isFailure: false)
            // A read-tier op auto-runs from INSIDE runTurn (busy still true) —
            // .forceUnblock (`unblockAndFollowUp()`) is required for exactly
            // this reason (see its doc). On the sheet/card path busy is
            // already false, so that's a benign no-op there.
            await engine.acknowledge(payload, followUp: .forceUnblock)
        } catch {
            let payload = ChatMessage.ToolResultPayload(
                kind: .git, summary: "(git \(args.op.rawValue) failed) \(error.localizedDescription)",
                exitCode: nil, command: nil, output: nil, url: nil, isFailure: true)
            await engine.acknowledge(payload, followUp: .forceUnblock)
        }
    }
}
