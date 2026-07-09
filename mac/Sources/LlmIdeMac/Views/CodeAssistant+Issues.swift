import SwiftUI

extension CodeAssistantPanel {
    // MARK: - Issue confirmation functions

    func confirmCreateIssue(_ args: CreateIssueSheet.Args, target: IssueTarget) async {
        let payload = RepoIssuePayload(
            title: args.title,
            body: args.description,
            labels: args.labels
        )
        let client: RepoBackend = (target.kind == .gitlab)
            ? RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
            : RepoBackendFactory.guarded(GitHubClient(config: config), config: config)

        do {
            let issue = try await client.createIssue(projectId: target.projectId, payload: payload)
            // Success: acknowledge and clear the tool
            pendingTool = nil
            showingIssueSheet = false
            // Add a synthetic turn so the agent can see the result and continue
            history.append(.init(
                role: .user,
                content: "(executed create-issue → #\(issue.number): \(issue.webUrl))"
            ))
            await refreshRecentIssuesOnce()
            await sendFollowup()
        } catch {
            // Error stays in the sheet so the user can retry or cancel
            // The sheet itself surfaces `error.localizedDescription`
        }
    }

    func confirmCommentIssue(_ args: CommentIssueSheet.Args, target: IssueTarget) async -> CommentIssueSheet.ConfirmResult {
        let client: RepoBackend = (target.kind == .gitlab)
            ? RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
            : RepoBackendFactory.guarded(GitHubClient(config: config), config: config)

        do {
            _ = try await client.createNote(
                projectId: target.projectId,
                number: args.iid,
                body: args.body
            )
            pendingTool = nil
            showingCommentSheet = false
            history.append(.init(
                role: .user,
                content: "(executed comment-issue → #\(args.iid))"
            ))
            await sendFollowup()
            return .success(args.iid)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    func confirmGetIssue() {
        showingGetIssueSheet = false
        pendingTool = nil
        // No synthetic turn — get-issue is purely for the agent's context
    }

    func confirmUpdateIssue(_ args: UpdateIssueSheet.Args, target: IssueTarget) async -> UpdateIssueSheet.ConfirmResult {
        let client: RepoBackend = (target.kind == .gitlab)
            ? RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
            : RepoBackendFactory.guarded(GitHubClient(config: config), config: config)

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
            pendingTool = nil
            showingUpdateIssueSheet = false
            history.append(.init(
                role: .user,
                content: "(executed update-issue → #\(args.iid))"
            ))
            await refreshRecentIssuesOnce()
            await sendFollowup()
            return .success(args.iid)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    func confirmListIssues(_ args: ListIssuesSheetArgs) {
        showingListIssuesSheet = false
        pendingTool = nil
        // No synthetic turn — list-issues is purely for the agent's context
    }
}
