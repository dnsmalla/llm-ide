import Foundation
import Observation

@MainActor
@Observable
final class EmailTodosViewModel {
    private(set) var open: [OpenTodo] = []
    var selected: Set<String> = []
    var target: IssueTargetOption?
    var status: String?
    private(set) var busy = false

    func reload(emailsRoot: URL) {
        open = EmailNoteStore(root: emailsRoot).scanOpenTodos()
        selected = selected.intersection(Set(open.map(\.id)))
    }

    func clear() {
        open = []
        selected = []
    }

    func payload(for todo: OpenTodo) -> RepoIssuePayload {
        var body = todo.detail
        if let due = todo.due, !due.isEmpty {
            body += "\n\nDue: \(due)"
        }
        body += "\n\nFrom email: \(todo.from) — \(todo.subject)"
        return RepoIssuePayload(title: todo.title, body: body, labels: nil, dueDate: todo.due)
    }

    func createSelected(config: AppConfig, emailsRoot: URL) async {
        guard let target else {
            status = "Choose a repo first."
            return
        }
        let selectedTodos = open.filter { selected.contains($0.id) }
        guard !selectedTodos.isEmpty else {
            status = "Select at least one to-do."
            return
        }
        busy = true
        defer { busy = false }

        let backend: RepoBackend = switch target.kind {
        case .gitlab:
            RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
        case .github:
            RepoBackendFactory.guarded(GitHubClient(config: config), config: config)
        }
        let store = EmailNoteStore(root: emailsRoot)
        var errors: [String] = []
        var created = 0

        for todo in selectedTodos {
            do {
                let issue = try await backend.createIssue(
                    projectId: target.projectId,
                    payload: payload(for: todo)
                )
                try store.markTodoCreated(file: todo.file, todoIndex: todo.todoIndex, issueURL: issue.webUrl)
                selected.remove(todo.id)
                created += 1
            } catch {
                errors.append("\(todo.title): \(error.localizedDescription)")
            }
        }

        reload(emailsRoot: emailsRoot)
        if errors.isEmpty {
            status = created == 1 ? "Created 1 issue." : "Created \(created) issues."
        } else if created > 0 {
            status = "Created \(created); \(errors.count) failed. \(errors.joined(separator: " "))"
        } else {
            status = errors.joined(separator: " ")
        }
    }
}
