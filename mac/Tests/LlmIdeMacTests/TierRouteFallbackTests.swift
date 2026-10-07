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

    func roundTrip(_ input: ChatTransportInput,
                   onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
                   onChunk: @escaping @MainActor (String) -> Void) async throws -> ChatTransportResult {
        inputs.append(input)
        if input.provider == refusedProvider { throw refusal }
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
