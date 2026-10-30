import XCTest
@testable import LlmIdeMacLib

/// POST /kb/complete wire shape and the Loop regression replay/judge moving
/// onto it (agent-kit K1 P3). Fake transport only; no network, no model.
final class CompleteRouteTests: XCTestCase {

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testRequestEncodesServerFieldNamesAndOmitsNil() throws {
        let full = try json(LlmIdeAPIClient.CompleteRequest(
            prompt: "p", language: "en", model: "m", provider: "anthropic", tier: "subagent", framing: "code-assist"))
        XCTAssertEqual(Set(full.keys), ["prompt", "language", "model", "provider", "tier", "framing"])
        let bare = try json(LlmIdeAPIClient.CompleteRequest(
            prompt: "p", language: nil, model: nil, provider: nil, tier: nil, framing: nil))
        XCTAssertEqual(Set(bare.keys), ["prompt"])
    }

    func testResponseDecodesWithAndWithoutUsage() throws {
        let a = try JSONDecoder().decode(LlmIdeAPIClient.CompleteResponse.self,
                                         from: Data(#"{"reply":"ok"}"#.utf8))
        XCTAssertEqual(a.reply, "ok")
        XCTAssertNil(a.usage)
        let b = try JSONDecoder().decode(LlmIdeAPIClient.CompleteResponse.self, from: Data(
            #"{"reply":"ok","usage":{"inputTokens":3,"outputTokens":1,"modelCalls":1}}"#.utf8))
        XCTAssertEqual(b.usage?.inputTokens, 3)
        XCTAssertNil(b.usage?.cacheReadTokens)
    }

    private final class FakeTransport: RegressionCompletionTransport, @unchecked Sendable {
        struct Call: Equatable { let prompt: String; let language: String; let model: String?; let provider: String?; let tier: String? }
        var calls: [Call] = []
        var failFirstWith: Error?
        var reply = "YES"
        func complete(prompt: String, language: String, model: String?, provider: String?,
                      tier: String?) async throws -> String {
            calls.append(Call(prompt: prompt, language: language, model: model, provider: provider, tier: tier))
            if calls.count == 1, let e = failFirstWith { throw e }
            return reply
        }
    }

    func testReplaySendsPromptUnchangedOnTheDefault() async throws {
        let t = FakeTransport(); t.reply = "answer"
        let p = CodeAssistPrompter(transport: t, language: "ja")
        let out = try await p.ask(prompt: "what is X?")
        XCTAssertEqual(out, "answer")
        XCTAssertEqual(t.calls, [.init(prompt: "what is X?", language: "ja", model: nil, provider: nil, tier: nil)])
    }

    func testReplayRetriesOnceWithoutTheRouteOnAProviderConfigRefusal() async throws {
        let t = FakeTransport()
        t.failFirstWith = APIError.http(status: 400, code: "PROVIDER_UNAVAILABLE", message: "no key", details: nil)
        let route = TierRoute(provider: "deepseek", model: "deepseek-chat")
        let p = CodeAssistPrompter(transport: t, routeResolver: { route })
        _ = try await p.ask(prompt: "q")
        XCTAssertEqual(t.calls.count, 2)
        XCTAssertEqual(t.calls[0].provider, "deepseek")
        XCTAssertEqual(t.calls[0].model, "deepseek-chat")
        XCTAssertNil(t.calls[1].provider)
        XCTAssertNil(t.calls[1].model)
    }

    func testReplayDoesNotRetryAGenericFailure() async {
        let t = FakeTransport()
        t.failFirstWith = APIError.http(status: 502, code: "INTERNAL_ERROR", message: "x", details: nil)
        let p = CodeAssistPrompter(transport: t, routeResolver: { TierRoute(provider: "deepseek", model: "m") })
        do { _ = try await p.ask(prompt: "q"); XCTFail("expected throw") } catch {}
        XCTAssertEqual(t.calls.count, 1)
    }

    func testJudgeUsesTheSubagentTierAndTheSamePrompt() async throws {
        let t = FakeTransport(); t.reply = "YES, same."
        let judge = CodeAssistJudge(transport: t)
        let same = try await judge.sameMeaning(prompt: "Q", original: "A1", current: "A2")
        XCTAssertTrue(same)
        let call = try XCTUnwrap(t.calls.first)
        XCTAssertEqual(call.tier, "subagent")
        XCTAssertNil(call.model)
        XCTAssertEqual(call.language, "en")
        XCTAssertEqual(call.prompt, CodeAssistJudge.buildPrompt(prompt: "Q", original: "A1", current: "A2"))
    }

    func testJudgeStillRejectsAnAmbiguousReply() async {
        let t = FakeTransport(); t.reply = "maybe"
        do { _ = try await CodeAssistJudge(transport: t).sameMeaning(prompt: "Q", original: "a", current: "b"); XCTFail() }
        catch { XCTAssertTrue(error is CodeAssistJudge.JudgeError) }
    }
}
