import Foundation
import Combine

/// Loop from the phone: start a Factory run for chosen open issues, watch it, cancel it. A start waits for the
/// desktop's approval; the desktop claims and runs it, and Ship stays a desktop click. The phone sends issue ids only.
@MainActor
public final class LoopStore: ObservableObject {
    @Published public private(set) var runs: [HostApiLoopListResultRunsItem] = []
    @Published public private(set) var issues: [HostApiLoopIssuesResultIssuesItem] = []
    /// The desktop's own Loop journal for the project (Regression, Test, Factory… runs), newest first.
    @Published public private(set) var history: [HostApiLoopHistoryResultRunsItem] = []
    @Published public private(set) var loading = false
    @Published public var error: String?
    private weak var context: HostContext?

    public init(context: HostContext) { self.context = context }

    private var host: HostConnection? {
        guard context?.isConnected == true else { return nil }
        return context?.host
    }

    public func refresh(projectId: String?) async {
        guard let host else { return }
        do {
            runs = try await host.send(.loopList, HostApiLoopListRequest(projectId: projectId), as: HostApiLoopListResult.self).runs
            if let projectId {
                history = try await host.send(.loopHistory, HostApiLoopHistoryRequest(projectId: projectId), as: HostApiLoopHistoryResult.self).runs
            } else { history = [] }
            error = nil
        } catch { self.error = message(error) }
    }

    public func loadIssues(projectId: String?) async {
        guard let host else { return }
        loading = true
        do {
            issues = try await host.send(.loopIssues, HostApiLoopIssuesRequest(limit: 50, projectId: projectId), as: HostApiLoopIssuesResult.self).issues
            error = nil
        } catch { self.error = message(error) }
        loading = false
    }

    /// True when the desktop accepted the run (it then waits for approval on the desktop).
    @discardableResult
    public func start(issueIds: [String], projectId: String) async -> Bool {
        guard let host else { return false }
        do {
            _ = try await host.send(.loopStart, HostApiLoopStartRequest(issueIds: issueIds, projectId: projectId), as: HostApiLoopStartResult.self)
            error = nil
            await refresh(projectId: projectId)
            return true
        } catch { self.error = message(error); return false }
    }

    public func cancel(_ run: HostApiLoopListResultRunsItem, projectId: String?) async {
        guard let host else { return }
        do {
            _ = try await host.send(.loopCancel, HostApiLoopCancelRequest(id: run.id), as: HostApiLoopCancelResult.self)
            error = nil
        } catch { self.error = message(error) }
        await refresh(projectId: projectId)
    }

    private func message(_ error: Error) -> String {
        if let rejection = error as? HostApiRejection { return rejection.message }
        return error.localizedDescription
    }
}
