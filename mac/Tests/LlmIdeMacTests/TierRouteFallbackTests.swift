import Testing
import Foundation
@testable import LlmIdeMacLib

/// Refuses a routed provider the way the server does (400
/// PROVIDER_UNAVAILABLE) and records every input it was sent.
@MainActor
private final class RefusingTransport: ChatTransport, @unchecked Sendable {
    var refusedProvider = "openai"
    var refusal: Error = APIError.http(status: 400, code: "PROVIDER_UNAVAILABLE", message: "codex is not logged in",
                                       details: nil)
    private(set) var inputs: [ChatTransportInput] = []
    /// Emit one progress event before refusing (the turn had started acting).
    var progressBeforeRefusal = false

    func roundTrip(_ input: ChatTransportInput,
                   onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
                   onChunk: @escaping @MainActor (String) -> Void) async throws -> ChatTransportResult {
        inputs.append(input)
        if input.provider == refusedProvider {
            if progressBeforeRefusal {
                onProgress(.init(label: "Searching…", phase: "tool", tool: "web-search", detail: nil))
            }
            throw refusal
        }
        return ChatTransportResult(reply: "ok via \(input.provider ?? "nil")", pendingTool: nil, tasks: nil,
                                   continueNeeded: nil, usage: nil, mode: nil, tokenUsage: nil)
    }
}

@Suite("Tier route fallback for chat turns")
@MainActor
struct TierRouteFallbackTests {
    private func input(routed: Bool) -> ChatTransportInput {
        var input = ChatTransportInput(message: "hi", history: [], attachments: [], skills: [], agentContext: nil,
                                       language: nil, model: "gpt-5", provider: "openai", mode: "ask")
        if routed { input.routeFallback = TierRouteFallback(model: "claude-sonnet-4-6", provider: "anthropic") }
        return input
    }

    private func send(_ transport: RefusingTransport, _ input: ChatTransportInput) async throws -> ChatTransportResult {
        try await transport.roundTripWithRouteFallback(input, onProgress: { _ in }, onChunk: { _ in },
                                                       onApproval: { _ in })
    }

    @Test func aRefusedRouteIsRetriedOnceOnTheFallback() async throws {
        let transport = RefusingTransport()
        let result = try await send(transport, input(routed: true))
        #expect(result.reply == "ok via anthropic")
        #expect(transport.inputs.count == 2)
        #expect(transport.inputs[1].model == "claude-sonnet-4-6")
        #expect(transport.inputs[1].routeFallback == nil)
    }

    @Test func anUnroutedTurnIsNeverRetried() async {
        let transport = RefusingTransport()
        await #expect(throws: (any Error).self) { try await send(transport, input(routed: false)) }
        #expect(transport.inputs.count == 1)
    }

    @Test func aGenericFailureOfAWorkingRouteIsNotRetried() async {
        let transport = RefusingTransport()
        transport.refusal = APIError.http(status: 502, code: "INTERNAL_ERROR", message: "boom", details: nil)
        await #expect(throws: (any Error).self) { try await send(transport, input(routed: true)) }
        #expect(transport.inputs.count == 1)
    }

    @Test func aRefusalAfterProgressIsNotRetried() async {
        // The turn already acted (a tool ran) — replaying it would repeat that.
        let transport = RefusingTransport()
        transport.progressBeforeRefusal = true
        await #expect(throws: (any Error).self) { try await send(transport, input(routed: true)) }
        #expect(transport.inputs.count == 1)
    }

    @Test func legacySSEErrorWithProviderCodeMapsToTheRetryableRefusal() {
        // ai-routes.mjs (v70) adds `code` to the SSE error event only before
        // any progress; the Mac double-gates on its own sawProgress.
        let refused = LlmIdeAPIClient.streamError(message: "codex is not logged in", code: "PROVIDER_UNAVAILABLE",
                                                  sawProgress: false)
        #expect(TierRouting.isProviderConfigError(refused))
        let afterProgress = LlmIdeAPIClient.streamError(message: "x", code: "PROVIDER_UNAVAILABLE", sawProgress: true)
        #expect(!TierRouting.isProviderConfigError(afterProgress))
        let plain = LlmIdeAPIClient.streamError(message: "boom", code: nil, sawProgress: false)
        #expect(!TierRouting.isProviderConfigError(plain))
        if case .agent(let message) = plain { #expect(message == "boom") } else { Issue.record("expected .agent") }
    }

    @Test func agentV2StreamErrorWithProviderCodeIsTheRetryableRefusal() throws {
        let wire = Data(#"{"type":"error","code":"PROVIDER_UNAVAILABLE","message":"no key","retryable":false}"#.utf8)
        guard case .error(let code, let message)? = AgentV2Event.decode(fromJSON: wire) else {
            Issue.record("did not decode as an error event"); return
        }
        #expect(TierRouting.isProviderConfigError(AgentV2Error.forStreamError(code: code, message: message)))
        #expect(!TierRouting.isProviderConfigError(AgentV2Error.forStreamError(code: "ENGINE_ERROR", message: "x")))
        #expect(AgentV2Error.forStreamError(code: "SESSION_UNRESUMABLE", message: "x") == .sessionUnresumable)
    }

    @Test func serverReasonsAndRoleStatusAreWorded() throws {
        for code in ["cli_unverified", "cli_failed", "route_failed", "cli_untrusted_input"] {
            #expect(TierRouting.describeServerReason(code) != code)
        }
        let json = Data(#"{"status":{},"featureStatus":{"internal":{"usable":false,"reason":"cli_untrusted_input"}}}"#.utf8)
        struct Payload: Decodable { let featureStatus: [String: TierFeatureServerStatus]? }
        let decoded = try JSONDecoder().decode(Payload.self, from: json)
        let server = TierRoutingServerState(apiVersion: 69, status: [:], featureStatus: decoded.featureStatus)
        #expect(TierRouting.serverFeatureUnusableReason(.internal, server: server)?.contains("API key") == true)
        #expect(TierRouting.serverFeatureUnusableReason(.pipeline, server: server) == nil)
        // An older server (no featureStatus) never produces a role note.
        #expect(TierRouting.serverFeatureUnusableReason(.internal,
                                                        server: TierRoutingServerState(apiVersion: 68, status: [:])) == nil)
    }
}
