import SwiftUI

extension CodeAssistantPanel {
    // MARK: - PR/MR creation

    /// Confirm a PR/MR creation. Executes via createMergeRequest API and
    /// appends a synthetic turn so the agent can acknowledge.
    func confirmPRCreation(_ args: PRCreationSheet.Args, target: IssueTarget) async -> PRCreationSheet.ConfirmResult {
        let client = RepoBackendFactory.backend(for: target.kind, config: config)

        do {
            let payload = RepoMergeRequestPayload(
                title: args.title,
                description: args.description,
                sourceBranch: args.sourceBranch,
                targetBranch: args.targetBranch,
                draft: false
            )
            let result = try await client.createMergeRequest(projectId: target.projectId, payload: payload)

            engine.agent.pendingTool = nil
            sheets.showingCreatePRSheet = false
            let ackPayload = ChatMessage.ToolResultPayload(
                kind: .issue, summary: "(executed create-pr → #\(result.number): \(result.webUrl))",
                exitCode: nil, command: nil, output: nil, url: result.webUrl, isFailure: false)
            await engine.acknowledge(ackPayload, followUp: true)
            return .success(iid: result.number, webUrl: result.webUrl)
        } catch {
            return .failure(error.localizedDescription)
        }
    }
}
