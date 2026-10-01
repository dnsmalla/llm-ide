import Foundation
import SharedProtocol

/// Serves `issues_list` / `issue_get` / `issue_comment_post` through the Mac's own `RepoBackend`
/// (GitHub/GitLab), so the Mac's sign-in and its operation allow-list apply unchanged. The phone can
/// read (switch "See issues") and comment (switch "Comment on issues", default off); it cannot close,
/// edit or delete.
@MainActor
final class MobileIssuesBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?
    init(manager: MobileControlManager) { self.manager = manager }

    func handle(type: String, data: Data?) -> Bool {
        switch type {
        case MobileProtocol.Tag.issuesList:
            let state = (try? manager?.decoder.decode(IssuesList.self, from: data ?? Data()))?.state ?? "opened"
            Task { @MainActor [weak self] in await self?.sendList(state: state) }
            return true
        case MobileProtocol.Tag.issueGet:
            guard let req = try? manager?.decoder.decode(IssueGet.self, from: data ?? Data()) else { return true }
            Task { @MainActor [weak self] in await self?.sendDetail(number: req.number) }
            return true
        case MobileProtocol.Tag.issueCommentPost:
            guard let req = try? manager?.decoder.decode(IssueCommentPost.self, from: data ?? Data()) else { return true }
            Task { @MainActor [weak self] in await self?.post(req) }
            return true
        default:
            return false
        }
    }
    func installPushObservers() {}
    func removePushObservers() {}

    private func emptyList(_ state: String, error: String?) -> IssuesState {
        IssuesState(available: false, provider: nil, state: state, issues: [], error: error)
    }

    private func sendList(state: String) async {
        guard let manager else { return }
        guard manager.phoneAccess.isAllowed(.issuesRead) else {
            return manager.reply(emptyList(state, error: PhoneAccess.issuesRead.deniedMessage))
        }
        guard let config = manager.config, let target = PhoneIssues.target(config: config) else {
            return manager.reply(emptyList(state, error: nil))
        }
        let filter = RepoIssueFilter(state: RepoIssueFilter.IssueState(rawValue: state) ?? .opened, search: "", labelName: "")
        do {
            let issues = try await RepoBackendFactory.backend(for: target.kind, config: config)
                .listIssues(projectId: target.projectId, filter: filter, page: 1)
            manager.reply(IssuesState(available: true, provider: target.providerName, state: state,
                                      issues: PhoneIssues.summaries(issues)))
        } catch let failure {
            manager.reply(IssuesState(available: true, provider: target.providerName, state: state, issues: [],
                                      error: PhoneRedaction.short(failure.localizedDescription)))
        }
    }

    private func canComment(config: AppConfig, kind: RepoBackendKind) -> Bool {
        manager?.phoneAccess.isAllowed(.issueComment) == true && config.isAllowed(.commentIssue, provider: kind)
    }

    private func sendDetail(number: Int, message: String? = nil, error: String? = nil) async {
        guard let manager else { return }
        guard manager.phoneAccess.isAllowed(.issuesRead) else {
            return manager.reply(IssueDetail(number: number, title: "", state: "", body: nil, labels: [], author: "",
                                             assignees: [], comments: [], webUrl: nil, canComment: false,
                                             error: PhoneAccess.issuesRead.deniedMessage))
        }
        guard let config = manager.config, let target = PhoneIssues.target(config: config) else {
            return manager.reply(IssueDetail(number: number, title: "", state: "", body: nil, labels: [], author: "",
                                             assignees: [], comments: [], webUrl: nil, canComment: false,
                                             error: "No GitHub or GitLab project is connected on the Mac."))
        }
        let backend = RepoBackendFactory.backend(for: target.kind, config: config)
        do {
            async let issue = backend.getIssue(projectId: target.projectId, number: number)
            async let notes = backend.listNotes(projectId: target.projectId, number: number)
            manager.reply(PhoneIssues.detail(try await issue, notes: try await notes,
                                             canComment: canComment(config: config, kind: target.kind),
                                             message: message, error: error))
        } catch let failure {
            manager.reply(IssueDetail(number: number, title: "", state: "", body: nil, labels: [], author: "",
                                      assignees: [], comments: [], webUrl: nil, canComment: false,
                                      error: PhoneRedaction.short(failure.localizedDescription)))
        }
    }

    private func post(_ req: IssueCommentPost) async {
        guard let manager, let config = manager.config, let target = PhoneIssues.target(config: config) else { return }
        if let why = PhoneIssues.commentRefusal(switchOn: manager.phoneAccess.isAllowed(.issueComment), body: req.body) {
            return await sendDetail(number: req.number, error: why)
        }
        do {
            // The Mac's own allow-list gate runs inside the backend and throws if it forbids commenting.
            _ = try await RepoBackendFactory.backend(for: target.kind, config: config)
                .createNote(projectId: target.projectId, number: req.number,
                            body: req.body.trimmingCharacters(in: .whitespacesAndNewlines))
            manager.append(.info, "issue_comment_post #\(req.number) (phone)")
            await sendDetail(number: req.number, message: "Comment posted.")
        } catch let failure {
            await sendDetail(number: req.number, error: PhoneRedaction.short(failure.localizedDescription))
        }
    }
}
