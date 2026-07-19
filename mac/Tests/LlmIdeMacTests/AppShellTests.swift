import Testing
@testable import LlmIdeMac

struct AppShellTests {
    @Test func deepLinkTabMapsToSection() {
        #expect(ShellState.Section(deepLinkTabName: "transcript") == .live)
        #expect(ShellState.Section(deepLinkTabName: "history") == .library)
        // "review" (Review Code) section was removed; now unmapped.
        #expect(ShellState.Section(deepLinkTabName: "review") == nil)
        // "plan" (Plans) sidebar section was removed; now unmapped.
        #expect(ShellState.Section(deepLinkTabName: "plan") == nil)
        #expect(ShellState.Section(deepLinkTabName: "settings") == .settings)
        #expect(ShellState.Section(deepLinkTabName: "unknown") == nil)
    }
}
