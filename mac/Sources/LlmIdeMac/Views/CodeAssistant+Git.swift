import SwiftUI

extension CodeAssistantPanel {
    // Note: branchSheetContext @State property is in the main file

    private var showingCreateBranchSheetContent: some View {
        Group {
            if let pt = pendingTool, let args = pt.createBranchArgs {
                BranchCreationSheet(
                    initialArgs: BranchCreationSheet.CreateBranchArgs(
                        branch: args.branch,
                        startPoint: args.startPoint
                    ),
                    currentBranch: branchSheetContext?.currentBranch,
                    onConfirm: { editedArgs in
                        await confirmBranchCreation(editedArgs)
                    }
                )
            } else {
                VStack(spacing: 12) {
                    Text("Branch creation unavailable.")
                        .font(.system(size: 13))
                    Button("Close") { showingCreateBranchSheet = false }
                }
                    .padding(20)
            }
        }
    }

    // MARK: - Branch creation

    func confirmBranchCreation(_ args: BranchCreationSheet.Args) async -> BranchCreationSheet.ConfirmResult {
        guard let repoURL = config.activeRepoLocalURL, WorkspaceRoot.isGitRepo(repoURL) else {
            return .failure("Not in a git repository")
        }

        let repoManager = RepoManager()
        do {
            // Build the git command arguments
            var gitArgs = ["branch", args.branch]
            if let startPoint = args.startPoint {
                gitArgs.append(startPoint)
            }

            _ = try await repoManager.runGit(gitArgs, at: repoURL)

            self.pendingTool = nil
            history.append(.init(
                role: .user,
                content: "(executed create-branch → \(args.branch))"
            ))
            await sendFollowup()
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
        case .write:       return editMode == .auto
        case .destructive: return false
        }
    }

    /// Execute an agent git-op: clear pendingTool, run the op, append a synthetic
    /// result turn, and call sendFollowup so the agent can acknowledge.
    /// Read-tier ops are auto-run from runTurn; write/destructive run after sheet confirm.
    @MainActor
    func runGitOpFlow(_ args: GitOpArgs) async {
        pendingTool = nil
        showingGitOpSheet = false
        // Resolve the active repo URL — GitLab first, then GitHub (mirrors config.activeRepoLocalURL).
        guard let repoURL = config.activeRepoLocalURL else {
            history.append(.init(role: .user,
                content: "(git \(args.op.rawValue) skipped — no active repository)"))
            busy = false   // release the turn's busy flag so sendFollowup isn't skipped by its !busy guard
            await sendFollowup()
            return
        }
        // Resolve auth token: prefer the active GitLab project's token, fall back to GitHub.
        // For read/local ops the token may be nil; push/pull/merge_to_main use it for the remote.
        let token: String?
        if !config.gitLabToken.isEmpty,
           config.gitLabSavedProjects.first(where: { $0.isActive }) != nil {
            token = config.gitLabToken
        } else if !config.gitHubToken.isEmpty,
                  config.gitHubSavedRepos.first(where: { $0.isActive }) != nil {
            token = config.gitHubToken
        } else {
            token = nil
        }
        do {
            let out = try await RepoManager().runGitOp(args, at: repoURL, token: token)
            history.append(.init(role: .user,
                content: "(git \(args.op.rawValue) result)\n\(out.prefix(4000))"))
        } catch {
            history.append(.init(role: .user,
                content: "(git \(args.op.rawValue) failed) \(error.localizedDescription)"))
        }
        // A read-tier op auto-runs from INSIDE runTurn (busy still true); clear it
        // here — like confirmUpdateFile does — or sendFollowup's `guard !busy`
        // skips and the agent never acts on the git result (the stall). On the
        // sheet/card path busy is already false, so this is a benign no-op there.
        busy = false
        await sendFollowup()
    }
}
