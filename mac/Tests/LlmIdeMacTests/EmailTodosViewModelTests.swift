import Testing
import Foundation
@testable import LlmIdeMac

@Suite("EmailTodosViewModel")
struct EmailTodosViewModelTests {
    @Test @MainActor func payloadIncludesEmailContext() {
        let vm = EmailTodosViewModel()
        let todo = OpenTodo(
            id: "x#0",
            file: URL(fileURLWithPath: "/tmp/x.md"),
            todoIndex: 0,
            from: "aki@co.com",
            subject: "Quarterly review",
            title: "Send Q3",
            detail: "by Fri",
            due: "2026-07-10",
            priority: "high"
        )
        let payload = vm.payload(for: todo)
        #expect(payload.title == "Send Q3")
        #expect(payload.dueDate == "2026-07-10")
        #expect(payload.body?.contains("aki@co.com") == true)
        #expect(payload.body?.contains("Quarterly review") == true)
    }

    @Test @MainActor func createSelectedRequiresTarget() async {
        let vm = EmailTodosViewModel()
        vm.selected = ["x#0"]
        vm.open = [
            OpenTodo(id: "x#0", file: URL(fileURLWithPath: "/tmp/x.md"), todoIndex: 0,
                     from: "a", subject: "s", title: "t", detail: "d", due: nil, priority: "med")
        ]
        let defaults = UserDefaults(suiteName: "EmailTodosVM-\(UUID().uuidString)")!
        let config = AppConfig(userDefaults: defaults)
        await vm.createSelected(config: config, emailsRoot: URL(fileURLWithPath: "/tmp/emails"))
        #expect(vm.status == "Choose a repo first.")
    }
}
