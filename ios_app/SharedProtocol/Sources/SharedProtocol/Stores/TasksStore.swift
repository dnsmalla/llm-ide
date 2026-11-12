import Foundation
import Combine

/// Auto Tasks from the phone: the list comes from the desktop registry, `tasks.run` starts ONE registry task on
/// the desktop, and `tasks.status` is polled until it ends. The phone never sends a command or prompt.
@MainActor
public final class TasksStore: ObservableObject {
    public struct Run: Identifiable, Equatable {
        public let id: String
        public var status: String = "running"
        public var summary: String?
        public var output: String?
        public var error: String?
        public var taskLabel: String = ""
    }

    @Published public private(set) var tasks: [HostApiTasksListResultTasksItem] = []
    @Published public private(set) var loading = false
    @Published public private(set) var error: String?
    @Published public private(set) var runs: [Run] = []
    private var polls: [String: Task<Void, Never>] = [:]
    private weak var context: HostContext?

    public init(context: HostContext) { self.context = context }

    private var host: HostConnection? {
        guard context?.isConnected == true else { return nil }
        return context?.host
    }

    public func refresh() async {
        guard let host else { return }
        loading = true; error = nil
        do {
            tasks = try await host.send(.tasksList, HostApiTasksListRequest(), as: HostApiTasksListResult.self).tasks
        } catch {
            self.error = message(error)
        }
        loading = false
    }

    public func run(_ task: HostApiTasksListResultTasksItem, projectId: String?, args: [String: String] = [:]) async {
        guard let host else { return }
        error = nil
        do {
            let r = try await host.send(.tasksRun, HostApiTasksRunRequest(args: args.isEmpty ? nil : args, projectId: projectId, taskId: task.id), as: HostApiTasksRunResult.self)
            var run = Run(id: r.runId, taskLabel: task.label)
            run.status = "running"
            runs.insert(run, at: 0)
            poll(runId: r.runId)
        } catch {
            self.error = message(error)
        }
    }

    public func cancel(_ run: Run) async {
        guard let host else { return }
        _ = try? await host.send(.tasksCancel, HostApiTasksCancelRequest(runId: run.id), as: HostApiTasksCancelResult.self)
        polls[run.id]?.cancel(); polls[run.id] = nil
        update(run.id) { $0.status = "cancelled"; $0.error = "Cancelled." }
    }

    private func poll(runId: String) {
        polls[runId]?.cancel()
        polls[runId] = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                guard let self, let host = self.host else { return }
                do {
                    let s = try await host.send(.tasksStatus, HostApiTasksStatusRequest(runId: runId), as: HostApiTasksStatusResult.self)
                    self.update(runId) { $0.status = s.status; $0.summary = s.summary; $0.output = s.output; $0.error = s.error }
                    if s.status != "running" { break }
                } catch {
                    self.update(runId) { $0.status = "failed"; $0.error = self.message(error) }
                    break
                }
            }
        }
    }

    private func update(_ id: String, _ change: (inout Run) -> Void) {
        guard let i = runs.firstIndex(where: { $0.id == id }) else { return }
        change(&runs[i])
    }

    private func message(_ error: Error) -> String {
        if let rejection = error as? HostApiRejection { return rejection.message }
        return error.localizedDescription
    }
}
