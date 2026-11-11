import Foundation
import SharedProtocol

/// Loop from the phone: start a Factory run for chosen open issues, watch it, cancel it. A start waits for the
/// desktop's approval; the desktop claims and runs it, and Ship stays a desktop click. The phone sends issue ids only.
@MainActor
final class LoopStore: ObservableObject {
    @Published private(set) var runs: [HostApiLoopListResultRunsItem] = []
    @Published private(set) var issues: [HostApiLoopIssuesResultIssuesItem] = []
    @Published private(set) var loading = false
    @Published var error: String?
    weak var connection: ConnectionService?

    init(connection: ConnectionService) { self.connection = connection }

    private var host: HostConnection? {
        guard connection?.connectionStatus == .connected else { return nil }
        return connection?.host
    }

    func refresh(projectId: String?) async {
        guard let host else { return }
        do {
            runs = try await host.send(.loopList, HostApiLoopListRequest(projectId: projectId), as: HostApiLoopListResult.self).runs
            error = nil
        } catch { self.error = message(error) }
    }

    func loadIssues(projectId: String?) async {
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
    func start(issueIds: [String], projectId: String) async -> Bool {
        guard let host else { return false }
        do {
            _ = try await host.send(.loopStart, HostApiLoopStartRequest(issueIds: issueIds, projectId: projectId), as: HostApiLoopStartResult.self)
            error = nil
            await refresh(projectId: projectId)
            return true
        } catch { self.error = message(error); return false }
    }

    func cancel(_ run: HostApiLoopListResultRunsItem, projectId: String?) async {
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
