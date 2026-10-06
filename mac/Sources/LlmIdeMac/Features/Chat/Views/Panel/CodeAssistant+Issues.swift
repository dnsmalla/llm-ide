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
            // Sheet-driven, not the auto-chain path — .ifIdle matches the old
            // plain sendFollowup() (no-op if an autonomous turn is streaming).
            // The follow-up is a model round trip (tens of seconds). Awaiting it
            // here kept the sheet on its "Creating…" spinner after the action had
            // already succeeded, and reported success even if the follow-up failed.
            // Append the acknowledgement now; run the follow-up detached.
            await engine.acknowledge(ackPayload, followUp: .none)
            scheduleFollowup()
            return .success(args.iid)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    func confirmUpdateIssue(_ args: UpdateIssueSheet.Args, target: IssueTarget) async -> UpdateIssueSheet.ConfirmResult {
        let client = RepoBackendFactory.backend(for: target.kind, config: config)

        do {
            // `state` used to be dropped here, so picking Closed (or the
            // agent's `state: "closed"`) did nothing while the chat reported
            // "executed update-issue".
            let payload = RepoIssuePayload(
                title: args.title,
                body: args.body,
                labels: args.labels,
                stateChange: UpdateIssueSheet.stateChange(for: args.state)
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
            // Append the ack BEFORE the await below, matching the original
            // ordering (appendTurn was synchronous): the transcript shows the
            // acknowledgement immediately rather than only after the issue
            // list refresh completes. The follow-up itself still waits for
            // the refresh, same as before.
            await engine.acknowledge(ackPayload, followUp: .none)
            // Refresh + follow-up run detached so the sheet closes now (see the
            // other confirmers): the follow-up still waits for the refresh.
            scheduleFollowup(refreshRecentIssues: true)
            return .success(args.iid)
        } catch {
            return .failure(error.localizedDescription)
        }
    }
}
