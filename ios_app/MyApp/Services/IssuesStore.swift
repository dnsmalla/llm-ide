import Foundation
import SharedProtocol

/// The active project's issues, through the Mac's own GitHub/GitLab sign-in. Read-only unless the Mac
/// has switched "Comment on issues" on.
@MainActor
final class IssuesStore: ObservableObject {
    @Published var list: IssuesState?
    @Published var details: [Int: IssueDetail] = [:]
    @Published var filter = "opened"
    @Published var isPosting = false
    @Published var loadError: String?

    weak var connection: ConnectionService?
    private var watchdog: Task<Void, Never>?

    init(connection: ConnectionService) {
        self.connection = connection
        connection.issuesStore = self
    }

    func refresh() {
        guard connection?.connectionStatus == .connected,
              connection?.supports(MobileProtocol.Capability.issues) == true else { return }
        connection?.sendEncodable(IssuesList(state: filter))
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard !Task.isCancelled, let self, self.list == nil,
                  self.connection?.connectionStatus == .connected else { return }
            self.loadError = "The Mac didn't answer. Update LLM-IDE on the Mac to a version with Issues on the phone."
        }
    }

    func setFilter(_ state: String) {
        guard state != filter else { return }
        filter = state
        list = nil
        refresh()
    }

    func loadDetail(_ number: Int) {
        guard connection?.connectionStatus == .connected else { return }
        connection?.sendEncodable(IssueGet(number: number))
    }

    func post(_ body: String, to number: Int) {
        guard !isPosting else { return }
        isPosting = true
        connection?.sendEncodable(IssueCommentPost(number: number, body: body))
        // The Mac answers with the refreshed issue; give up on a silent Mac.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            self?.isPosting = false
        }
    }

    func handleInbound(type: String, data: Data) {
        let decoder = JSONDecoder()
        switch type {
        case MobileProtocol.Tag.issuesState:
            if let s = try? decoder.decode(IssuesState.self, from: data), s.state == filter {
                list = s
                loadError = nil
                watchdog?.cancel()
            }
        case MobileProtocol.Tag.issueDetail:
            if let d = try? decoder.decode(IssueDetail.self, from: data) {
                details[d.number] = d
                isPosting = false
            }
        default:
            break
        }
    }

    func invalidate() {
        list = nil
        details = [:]
    }

    func resetForNewDevice() {
        invalidate()
        loadError = nil
        isPosting = false
        watchdog?.cancel()
    }
}
