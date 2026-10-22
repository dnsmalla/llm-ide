import SwiftUI
import XCTest
@testable import LlmIdeMacLib

/// `ChatPanelRegistry` / `ChatOutputRegistry` contract: features embed the
/// chat panel, open the code-change sheets and read chat output through these
/// Core seams, so an empty registry must degrade (never crash), an install
/// must replace, and every request field must reach the installed maker
/// untouched. Fresh instances per test — never `.shared`, which the app's
/// boot path fills.
@MainActor
final class ChatPanelRegistryTests: XCTestCase {
    private let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")

    func testFallbackWhenNothingInstalled() {
        let registry = ChatPanelRegistry()
        XCTAssertFalse(registry.isPanelInstalled)
        XCTAssertFalse(registry.isCodeWorkflowSheetInstalled)
        // Must return a placeholder rather than trap.
        _ = registry.makePanel(ChatPanelRequest(api: api, scope: .explorer))
    }

    func testInstallReplacesPreviousMaker() {
        let registry = ChatPanelRegistry()
        var firstCalls = 0
        var secondCalls = 0
        registry.installPanel { _ in firstCalls += 1; return AnyView(EmptyView()) }
        registry.installPanel { _ in secondCalls += 1; return AnyView(EmptyView()) }

        _ = registry.makePanel(ChatPanelRequest(api: api, scope: .docGen))

        XCTAssertTrue(registry.isPanelInstalled)
        XCTAssertEqual(firstCalls, 0, "a replaced maker must never run")
        XCTAssertEqual(secondCalls, 1)
    }

    func testRequestFieldsPassThrough() {
        let registry = ChatPanelRegistry()
        var seen: ChatPanelRequest?
        registry.installPanel { request in seen = request; return AnyView(EmptyView()) }
        let url = URL(fileURLWithPath: "/tmp/example.swift")

        _ = registry.makePanel(ChatPanelRequest(api: api, scope: .conflicts, initialURL: url,
                                                showFileAttachButtons: false,
                                                showModelPicker: true))

        XCTAssertEqual(seen?.scope, .conflicts)
        XCTAssertEqual(seen?.initialURL, url)
        XCTAssertEqual(seen?.showFileAttachButtons, false)
        XCTAssertEqual(seen?.showModelPicker, true)
        XCTAssertTrue(seen?.api === api)
    }

    /// The defaults must equal `CodeAssistantPanel`'s own, so a caller that
    /// omits an argument gets the same panel as constructing it directly.
    func testRequestDefaultsMatchThePanel() {
        let request = ChatPanelRequest(api: api, scope: .visual)
        XCTAssertNil(request.initialURL)
        XCTAssertTrue(request.showFileAttachButtons)
        XCTAssertFalse(request.showModelPicker)
    }

    func testCodeWorkflowSheetKindPassesThrough() {
        let registry = ChatPanelRegistry()
        var kinds: [CodeWorkflowSheetKind] = []
        registry.installCodeWorkflowSheet { request in
            kinds.append(request.kind)
            return AnyView(EmptyView())
        }
        let suite = "ChatPanelRegistryTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let config = AppConfig(userDefaults: defaults)
        let target = CodeWorkflowTarget.gitLab(
            SavedGitLabProject(url: "https://gitlab.com/acme/widgets", displayName: "widgets",
                               resolvedId: 7, isActive: true),
            config: config)

        _ = registry.makeCodeWorkflowSheet(CodeWorkflowSheetRequest(api: api, target: target, kind: .quickFix))
        _ = registry.makeCodeWorkflowSheet(CodeWorkflowSheetRequest(api: api, target: target, kind: .guided))

        XCTAssertEqual(kinds, [.quickFix, .guided])
    }

    // MARK: - ChatOutputRegistry

    private struct StubOutput: ChatOutputProviding {
        let replies: [ChatScope: String]
        func latestCompletedAssistantReply(scope: ChatScope, api: LlmIdeAPIClient) -> String? {
            replies[scope]
        }
    }

    func testOutputIsNilWhenNothingInstalled() {
        let registry = ChatOutputRegistry()
        XCTAssertNil(registry.latestCompletedAssistantReply(scope: .docGen, api: api))
    }

    func testOutputReadsTheInstalledProviderForTheScope() {
        let registry = ChatOutputRegistry()
        registry.install(StubOutput(replies: [.docGen: "doc reply", .visual: "visual reply"]))
        XCTAssertEqual(registry.latestCompletedAssistantReply(scope: .docGen, api: api), "doc reply")
        XCTAssertEqual(registry.latestCompletedAssistantReply(scope: .visual, api: api), "visual reply")
        XCTAssertNil(registry.latestCompletedAssistantReply(scope: .explorer, api: api))
    }
}
