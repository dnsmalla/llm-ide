import SwiftUI

extension CodeAssistantPanel {
    // MARK: - PR/MR creation

    /// Confirm a PR/MR creation. Executes via createMergeRequest API and
    /// appends a synthetic turn so the agent can acknowledge.
    func confirmPRCreation(_ args: PRCreationSheet.Args, target: IssueTarget) async -> PRCreationSheet.ConfirmResult {
        let client: RepoBackend
        if target.kind == .gitlab {
            client = RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
        } else {
            client = RepoBackendFactory.guarded(GitHubClient(config: config), config: config)
        }

        do {
            let payload = RepoMergeRequestPayload(
                title: args.title,
                description: args.description,
                sourceBranch: args.sourceBranch,
                targetBranch: args.targetBranch,
                draft: false
            )
            let result = try await client.createMergeRequest(projectId: target.projectId, payload: payload)

            pendingTool = nil
            showingCreatePRSheet = false
            history.append(.init(
                role: .user,
                content: "(executed create-pr → #\(result.number): \(result.webUrl))"
            ))
            await sendFollowup()
            return .success(iid: result.number, webUrl: result.webUrl)
        } catch {
            return .failure(error.localizedDescription)
        }
    }
}
