import XCTest
@testable import LlmIdeMacLib

/// `AICliTool.nonInteractivePromptArgs(_:)` — per-tool argument mapping for
/// unattended auto-task invocation (the spawn previously appended `-p`
/// unconditionally, which is Claude-only).
final class AICliToolTests: XCTestCase {
    func testClaudeUsesDashP() {
        XCTAssertEqual(AICliTool.claudeCode.nonInteractivePromptArgs("do X"), ["-p", "do X"])
    }

    func testCodexUsesExecYolo() {
        // codex exec --yolo <prompt>  (--yolo = --dangerously-bypass-approvals-and-sandbox)
        XCTAssertEqual(AICliTool.openai.nonInteractivePromptArgs("do X"), ["exec", "--yolo", "do X"])
    }

    func testGeminiUsesYoloDashP() {
        // --yolo auto-approves tool calls; -p passes the prompt.
        XCTAssertEqual(AICliTool.gemini.nonInteractivePromptArgs("do X"), ["--yolo", "-p", "do X"])
    }

    func testInteractiveEditorsUnsupported() {
        XCTAssertNil(AICliTool.copilot.nonInteractivePromptArgs("do X"))
        XCTAssertNil(AICliTool.cursor.nonInteractivePromptArgs("do X"))
    }

    func testNoCLIToolsUnsupported() {
        XCTAssertNil(AICliTool.deepseek.nonInteractivePromptArgs("do X"))
        XCTAssertNil(AICliTool.glm.nonInteractivePromptArgs("do X"))
        XCTAssertNil(AICliTool.custom.nonInteractivePromptArgs("do X"))
    }

    // GLM has no built-in backend route — no adapter, no base URL, and
    // resolveProvider sends `glm-*` ids to a provider that fails loudly. It is
    // reached as a named Custom Provider (`custom:<uuid>`). Offering it in the
    // picker meant the turn was answered by Claude with nothing saying so.
    func testGLMIsNotSelectableAsABuiltInProvider() {
        XCTAssertFalse(AICliTool.selectable.contains(.glm))
        XCTAssertTrue(AICliTool.glm.models.isEmpty,
                      "a non-selectable tool must not carry a stale built-in model list")
    }

    // Every provider offered in the composer needs a row in Settings → Model
    // Providers to key it, and a row in Auto Tasks → Model & Limits to cap it.
    // These three lists drifted apart before (GLM in one, DeepSeek missing
    // from another), so pin the set the other two are built to match.
    func testSelectableProvidersAreTheKeyableSet() {
        XCTAssertEqual(AICliTool.selectable, [.claudeCode, .openai, .gemini, .deepseek, .custom])
        // Each one resolves to a distinct backend provider id.
        XCTAssertEqual(AICliTool.selectable.map(\.provider),
                       ["anthropic", "openai", "google", "deepseek", "custom"])
    }

    // MARK: - One list behind all three surfaces

    // The composer menu, the Settings credential rows, and the usage-limits
    // picker are all built from ProviderCatalog. Assert they still agree —
    // this is the drift that shipped GLM into one list only, and left DeepSeek
    // out of another.
    func testCatalogIsTheSourceOfSelectableTools() {
        XCTAssertEqual(AICliTool.selectable, ProviderCatalog.selectableTools)
        XCTAssertEqual(ProviderCatalog.limitProviders.map(\.id),
                       AICliTool.selectable.map(\.provider),
                       "every selectable provider must be cappable, in the same order")
    }

    func testCatalogEntriesAgreeWithTheirTool() {
        for entry in ProviderCatalog.modelProviders {
            guard let tool = entry.tool else { return XCTFail("modelProviders must all carry a tool") }
            XCTAssertEqual(entry.id, tool.provider,
                           "the row id is the backend provider id used by verify + the usage ledger")
            XCTAssertEqual(entry.vaultKey, tool.vaultKey,
                           "\(entry.id): the row must write the key the backend reads")
            XCTAssertFalse(entry.label.isEmpty)
            XCTAssertFalse(entry.shortLabel.isEmpty)
        }
        // The non-chat credential row is still rendered, and still has no tool.
        XCTAssertTrue(ProviderCatalog.all.contains { $0.id == "web-search" && $0.tool == nil })
        // Only the shared OpenAI-compatible endpoint needs a base URL.
        XCTAssertEqual(ProviderCatalog.all.filter(\.needsBaseURL).map(\.id), ["custom"])
    }

    // MARK: - Model ids

    // These static lists are fallbacks, but the FIRST entry is defaultModelId
    // — the id sent before anything is chosen — so a retired id here was the
    // default, not a harmless extra.
    func testClaudeIdsCarryNoDateSuffix() {
        for model in AICliTool.claudeCode.models {
            XCTAssertNil(model.id.range(of: "-20[0-9]{6}$", options: .regularExpression),
                         "\(model.id): the undated id tracks the current snapshot")
        }
        XCTAssertEqual(AICliTool.claudeCode.defaultModelId, "claude-opus-5")
    }

    func testNoRetiredModelIdsAreStillOffered() {
        let offered = Set(AICliTool.selectable.flatMap { $0.models.map(\.id) })
        for retired in AppConfig.retiredModelIds.keys {
            XCTAssertFalse(offered.contains(retired), "\(retired) is retired but still offered")
        }
        // Every migration target must be a real, currently-offered id —
        // mapping onto another dead id would just move the problem.
        for (from, to) in AppConfig.retiredModelIds {
            XCTAssertTrue(offered.contains(to), "\(from) migrates to \(to), which nothing offers")
        }
    }

    func testEveryProviderWithBuiltInModelsHasADefault() {
        for tool in AICliTool.selectable where !tool.models.isEmpty {
            XCTAssertEqual(tool.defaultModelId, tool.models[0].id)
        }
        // Custom is the deliberate exception: its model comes from the
        // endpoint, so it has no built-in list and an empty default.
        XCTAssertTrue(AICliTool.custom.models.isEmpty)
        XCTAssertEqual(AICliTool.custom.defaultModelId, "")
    }
}
