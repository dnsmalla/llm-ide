import Testing
@testable import LlmIdeMac

struct AppShellTests {
    @Test func deepLinkTabMapsToSection() {
        #expect(ShellState.Section(deepLinkTabName: "transcript") == .live)
        #expect(ShellState.Section(deepLinkTabName: "history") == .library)
        #expect(ShellState.Section(deepLinkTabName: "review") == .review)
        #expect(ShellState.Section(deepLinkTabName: "plan") == .plans)
        #expect(ShellState.Section(deepLinkTabName: "settings") == .settings)
        #expect(ShellState.Section(deepLinkTabName: "unknown") == nil)
    }
}
