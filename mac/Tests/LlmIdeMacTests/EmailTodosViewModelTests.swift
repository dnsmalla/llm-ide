import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
@Suite("EmailTodosViewModel")
struct EmailTodosViewModelTests {
    private func makeTodo(due: String? = "2026-07-10") -> OpenTodo {
        OpenTodo(
            id: "/tmp/a.md#0",
            file: URL(fileURLWithPath: "/tmp/a.md"),
            todoIndex: 0,
            from: "aki@co.com",
            subject: "Quarterly review",
            title: "Send Q3",
            detail: "by Fri",
            due: due,
            priority: "high"
        )
    }

    @Test func payloadMapsTitleAndDueDateAndIncludesFromSubjectInBody() throws {
        let vm = EmailTodosViewModel()
        let todo = makeTodo()
        let payload = vm.payload(for: todo)

        #expect(payload.title == "Send Q3")
        #expect(payload.dueDate == "2026-07-10")
        #expect(payload.labels == nil)
        let body = try #require(payload.body)
        #expect(body.contains("by Fri"))
        #expect(body.contains("Due: 2026-07-10"))
        #expect(body.contains("From email: aki@co.com — Quarterly review"))
    }

    @Test func payloadOmitsDueLineWhenNoDueDate() throws {
        let vm = EmailTodosViewModel()
        let todo = makeTodo(due: nil)
        let payload = vm.payload(for: todo)

        #expect(payload.dueDate == nil)
        let body = try #require(payload.body)
        #expect(!body.contains("Due:"))
        #expect(body.contains("From email: aki@co.com — Quarterly review"))
    }

    @Test func createSelectedWithoutTargetSetsStatusAndCreatesNothing() async {
        let vm = EmailTodosViewModel()
        vm.open = [makeTodo()]
        vm.selected = [makeTodo().id]
        vm.target = nil

        let config = AppConfig(userDefaults: UserDefaults(suiteName: "email-todos-vm-\(UUID().uuidString)")!)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("email-todos-vm-\(UUID().uuidString)")

        await vm.createSelected(config: config, notesRoot: root)

        #expect(vm.status == "Choose a repo first.")
        #expect(vm.open.count == 1)
    }

    @Test func createSelectedWithEmptySelectionSetsStatus() async {
        let vm = EmailTodosViewModel()
        vm.open = [makeTodo()]
        vm.selected = []
        vm.target = IssueTargetOption(id: "p1", kind: .gitlab, projectId: "1", label: "demo (GitLab)", isActive: true)

        let config = AppConfig(userDefaults: UserDefaults(suiteName: "email-todos-vm-\(UUID().uuidString)")!)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("email-todos-vm-\(UUID().uuidString)")

        await vm.createSelected(config: config, notesRoot: root)

        #expect(vm.status == "Select at least one to-do.")
    }
}
