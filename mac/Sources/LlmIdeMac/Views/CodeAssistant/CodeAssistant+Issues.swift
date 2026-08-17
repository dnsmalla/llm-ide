import SwiftUI

extension CodeAssistantPanel {
    // MARK: - Issue confirmation functions
    //
    // NOTE: confirmCreateIssue lives in CodeAssistantPanel+Session.swift, not
    // here — a duplicate Void-returning overload previously lived in this
    // file, shadowed by the CreateIssueSheet.ConfirmResult-returning one at
    // the actual call site, so it was permanently dead. Removed rather than
    // fixed in place to avoid the "two copies, only one reachable" trap.

    func confirmCommentIssue(_ args: CommentIssueSheet.Args, target: IssueTarget) async -> CommentIssueSheet.ConfirmResult {
        let client = RepoBackendFactory.backend(for: target.kind, config: config)

        do {
            _ = try await client.createNote(
                projectId: target.projectId,
                number: args.iid,
                body: args.body
            )
            engine.agent.pendingTool = nil
            sheets.showingCommentSheet = false
            let ackPayload = ChatMessage.ToolResultPayload(
                kind: .issue, summary: "(executed comment-issue → #\(args.iid))",
                exitCode: nil, command: nil, output: nil, url: nil, isFailure: false)
            await engine.acknowledge(ackPayload, followUp: true)
            return .success(args.iid)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    func confirmUpdateIssue(_ args: UpdateIssueSheet.Args, target: IssueTarget) async -> UpdateIssueSheet.ConfirmResult {
        let client = RepoBackendFactory.backend(for: target.kind, config: config)

        do {
            let payload = RepoIssuePayload(
                title: args.title,
                body: args.body,
                labels: args.labels
            )
            _ = try await client.updateIssue(
                projectId: target.projectId,
                number: args.iid,
                payload: payload
            )
            engine.agent.pendingTool = nil
            sheets.showingUpdateIssueSheet = false
            let ackPayload = ChatMessage.ToolResultPayload(
                kind: .issue, summary: "(executed update-issue → #\(args.iid))",
                exitCode: nil, command: nil, output: nil, url: nil, isFailure: false)
            await refreshRecentIssuesOnce()
            await engine.acknowledge(ackPayload, followUp: true)
            return .success(args.iid)
        } catch {
            return .failure(error.localizedDescription)
        }
    }
}
