// mac/Sources/LlmIdeMac/ViewModels/EmailTodosViewModel.swift
import Foundation

/// Drives the Phase 2 "Email to-dos" review panel: aggregates open to-dos
/// parsed out of `<notesRoot>/Email` notes and lets the user file selected
/// ones as issues against a chosen repo target.
@MainActor
final class EmailTodosViewModel: ObservableObject {
    @Published var open: [OpenTodo] = []
    @Published var selected: Set<String> = []
    @Published var target: IssueTargetOption? = nil
    @Published var status: String? = nil

    init() {}

    /// Reloads `open` by rescanning `<notesRoot>/Email` for to-dos that
    /// haven't yet been turned into an issue.
    func reload(notesRoot: URL) {
        open = EmailNoteStore(root: notesRoot.appendingPathComponent("Email")).scanOpenTodos()
    }

    /// Pure mapping from a parsed to-do to the payload used to create its
    /// issue. Unit-tested independent of any network/backend.
    func payload(for todo: OpenTodo) -> RepoIssuePayload {
        var body = todo.detail
        if let due = todo.due {
            body += "\n\nDue: \(due)"
        }
        body += "\n\nFrom email: \(todo.from) — \(todo.subject)"

        return RepoIssuePayload(
            title: todo.title,
            body: body,
            labels: nil,
            dueDate: todo.due
        )
    }

    /// Creates an issue for every selected open to-do against `target`,
    /// marking each note's to-do as created on success. Per-todo failures
    /// are collected into `status` rather than aborting the whole batch.
    func createSelected(config: AppConfig, notesRoot: URL) async {
        guard let target else {
            status = "Choose a repo first."
            return
        }
        guard !selected.isEmpty else {
            status = "Select at least one to-do."
            return
        }

        let client = RepoBackendFactory.guarded(
            target.kind == .gitlab ? GitLabClient(config: config) : GitHubClient(config: config),
            config: config
        )
        let store = EmailNoteStore(root: notesRoot.appendingPathComponent("Email"))

        var created = 0
        var failures: [String] = []

        for todo in open where selected.contains(todo.id) {
            do {
                let issue = try await client.createIssue(projectId: target.projectId, payload: payload(for: todo))
                try store.markTodoCreated(file: todo.file, todoIndex: todo.todoIndex, issueURL: issue.webUrl)
                created += 1
            } catch {
                failures.append("\(todo.title): \(error.localizedDescription)")
            }
        }

        if failures.isEmpty {
            status = "Created \(created) issue\(created == 1 ? "" : "s")."
        } else {
            status = "Created \(created) issue\(created == 1 ? "" : "s"); \(failures.count) failed — " + failures.joined(separator: "; ")
        }

        reload(notesRoot: notesRoot)
    }
}
