import Testing
import Foundation
@testable import LlmIdeMacLib

/// Scripts one v2 stream turn: `events` are delivered in order through
/// `onEvent`; `thrownError` (if set) is thrown after the events, mimicking a
/// transport-level failure (non-200 / connection error) as opposed to a
/// stream-carried `error` event. Records every body it was handed.
@MainActor
final class ScriptedAgentV2Stream: AgentV2Streaming, @unchecked Sendable {
    var events: [AgentV2Event] = []
    var thrownError: Error?
    private(set) var bodies: [[String: Any]] = []

    func agentV2Stream(
        _ body: [String: Any],
        onEvent: @escaping @MainActor (AgentV2Event) -> Void
    ) async throws {
        bodies.append(body)
        for event in events {
            await onEvent(event)
        }
        if let e = thrownError { throw e }
    }
}

/// A conformer that only implements the legacy 3-callback requirement —
/// pins the protocol-extension default: the 4-callback roundTrip must
/// compile against it, forward to the 3-callback method, and never fire
/// `onApproval`.
private struct LegacyOnlyTransport: ChatTransport {
    var result = ChatTransportResult(reply: "legacy", pendingTool: nil, tasks: nil,
                                     continueNeeded: nil, usage: nil, mode: "plan")
    private(set) var sawProgress = false
    private(set) var sawChunk = false

    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        await onProgress(.init(label: "Thinking…", phase: "thinking", tool: nil, detail: nil))
        await onChunk("legacy chunk")
        return result
    }
}

@MainActor
private func makeInput(
    message: String = "hello",
    mode: String? = "plan",
    attachments: [LlmIdeAPIClient.CodeAttachment] = []
) -> ChatTransportInput {
    ChatTransportInput(
        message: message,
        history: [],
        attachments: attachments,
        skills: ["kit/write"],
        agentContext: AgentContext(activeProject: nil, indexedRepos: [], recentIssues: nil,
                                   workspaceRoot: "~/proj", sessionId: "s-1",
                                   chatSessionId: "CS-1", currentBranch: nil, gitStatus: nil),
        language: "Japanese",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        mode: mode
    )
}

@MainActor
private func makeApproval(id: String) -> AgentV2Approval {
    AgentV2Approval(
        requestId: id,
        kind: "AskUserQuestion",
        questions: [AgentV2ApprovalQuestion(
            question: "Which file?",
            header: "Files",
            options: [AgentV2ApprovalOption(label: "A.md", description: nil),
                      AgentV2ApprovalOption(label: "B.md", description: nil)],
            multiSelect: false
        )]
    )
}

@Suite("AgentV2Transport")
@MainActor
struct AgentV2TransportTests {

    // MARK: - Reply accumulation

    @Test("Reply accumulates across deltas; chunks stream in order")
    func replyAccumulates() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .delta("Hello"),
            .delta(" "),
            .delta("world"),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
        let transport = AgentV2Transport(streamer: stream)
        var chunks: [String] = []
        let result = try await transport.roundTrip(
            makeInput(),
            onProgress: { _ in },
            onChunk: { chunks.append($0) },
            onApproval: { _ in }
        )
        #expect(result.reply == "Hello world")
        #expect(chunks == ["Hello", " ", "world"])
        #expect(result.pendingTool == nil)
        #expect(result.tasks == nil)
        #expect(result.continueNeeded == false)
    }

    @Test("tasks event after result maps continueNeeded and task list")
    func tasksEventMapped() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-tasks", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
            .tasks(tasks: [AgentTask(id: "1", title: "Step one", status: .pending)],
                   continueNeeded: true),
        ]
        let transport = AgentV2Transport(streamer: stream)
        let result = try await transport.roundTrip(
            makeInput(),
            onProgress: { _ in },
            onChunk: { _ in },
            onApproval: { _ in }
        )
        #expect(result.continueNeeded == true)
        #expect(result.tasks?.count == 1)
        #expect(result.tasks?.first?.title == "Step one")
    }

    @Test("tasks_progress fires onLiveTasks mid-turn without touching the result tasks")
    func liveTasksProgress() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-live", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .tasksProgress([AgentTask(id: "1", title: "Step one", status: .inProgress),
                            AgentTask(id: "2", title: "Step two", status: .pending)]),
            .tasksProgress([AgentTask(id: "1", title: "Step one", status: .completed),
                            AgentTask(id: "2", title: "Step two", status: .inProgress)]),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
            // No terminal `tasks` event: a mid-turn list must never be
            // mistaken for the turn's authoritative one, which is what
            // auto-continue reads.
        ]
        var live: [[AgentTask]] = []
        let transport = AgentV2Transport(streamer: stream)
        transport.onLiveTasks = { live.append($0) }
        let result = try await transport.roundTrip(
            makeInput(),
            onProgress: { _ in },
            onChunk: { _ in },
            onApproval: { _ in }
        )
        #expect(live.count == 2)
        #expect(live.last?.first?.status == .completed)
        #expect(result.tasks == nil)
        #expect(result.continueNeeded == false)
    }

    @Test("tasks_progress after the terminal result still updates the display")
    func liveTasksSurviveTheTerminalGuard() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-late", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
            // The route's post-turn bookkeeping can emit after `result`;
            // dropping this one would freeze the bar one step short.
            .tasksProgress([AgentTask(id: "1", title: "Step one", status: .completed)]),
        ]
        var live: [[AgentTask]] = []
        let transport = AgentV2Transport(streamer: stream)
        transport.onLiveTasks = { live.append($0) }
        _ = try await transport.roundTrip(
            makeInput(), onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        #expect(live.count == 1)
    }

    @Test("onApproval fires exactly once per approvalRequest, twice for two")
    func approvalFiresOncePerRequest() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .approvalRequest(makeApproval(id: "req-1")),
            .approvalResolved(requestId: "req-1", outcome: "answer"),
            .approvalRequest(makeApproval(id: "req-2")),
            .approvalResolved(requestId: "req-2", outcome: "deny"),
            .delta("done"),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
        let transport = AgentV2Transport(streamer: stream)
        var approvals: [AgentV2Approval] = []
        let result = try await transport.roundTrip(
            makeInput(),
            onProgress: { _ in },
            onChunk: { _ in },
            onApproval: { approvals.append($0) }
        )
        #expect(approvals.map(\.requestId) == ["req-1", "req-2"])
        #expect(approvals[0] == makeApproval(id: "req-1"))
        #expect(result.reply == "done")
    }

    // MARK: - Progress mapping

    @Test("Tool events fire progress carrying the tool name (id-resolved for results)")
    func progressForToolEvents() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .toolUseStart(id: "t-1", name: "read-file"),
            .toolResult(AgentV2ToolResult(toolUseId: "t-1", isError: false,
                                          text: "contents", truncated: false)),
            .toolResult(AgentV2ToolResult(toolUseId: "unknown", isError: false,
                                          text: "x", truncated: false)),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
        let transport = AgentV2Transport(streamer: stream)
        var progress: [LlmIdeAPIClient.AgentProgress] = []
        _ = try await transport.roundTrip(
            makeInput(),
            onProgress: { progress.append($0) },
            onChunk: { _ in },
            onApproval: { _ in }
        )
        #expect(progress.count == 3)
        // Start: name straight off the event.
        #expect(progress[0].tool == "read-file")
        #expect(progress[0].phase == "tool")
        #expect(progress[0].isTool)
        #expect(progress[0].label == "Reading…")
        // Result with a matching start: name resolved via toolUseId.
        #expect(progress[1].tool == "read-file")
        #expect(progress[1].label == "Reading…")
        // Result with no matching start: no name, degraded verb.
        #expect(progress[2].tool == nil)
        #expect(progress[2].label == "Working…")
    }

    // MARK: - Result field mapping

    @Test("Usage maps from the request's attachments; mode passes through absent mode_set")
    func resultFieldsMapped() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-9", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .usage(AgentV2Usage(inputTokens: 100, outputTokens: 50, cacheReadTokens: 10,
                                contextPercent: nil)),
            .delta("hi"),
            .result(AgentV2Result(subtype: "success", costUsd: 0.01, numTurns: 2,
                                  durationMs: 1500, sessionId: nil, stopReason: nil)),
        ]
        let transport = AgentV2Transport(streamer: stream)
        let attachments = [
            LlmIdeAPIClient.CodeAttachment(path: "~/a.md", content: "12345"),
            LlmIdeAPIClient.CodeAttachment(path: "~/b.md", content: "1234567"),
        ]
        let result = try await transport.roundTrip(
            makeInput(mode: "review", attachments: attachments),
            onProgress: { _ in },
            onChunk: { _ in },
            onApproval: { _ in }
        )
        #expect(result.mode == "review")
        #expect(result.usage?.attachmentCount == 2)
        #expect(result.usage?.attachmentChars == 12)
        #expect(result.usage?.paths == ["~/a.md", "~/b.md"])
        #expect(transport.sdkSessionId == "sdk-9")
    }

    @Test("mode_set overrides the requested mode on the result")
    func modeSetOverrides() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .modeSet("execute"),
            .delta("ok"),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
        let transport = AgentV2Transport(streamer: stream)
        let result = try await transport.roundTrip(
            makeInput(mode: nil),
            onProgress: { _ in },
            onChunk: { _ in },
            onApproval: { _ in }
        )
        #expect(result.mode == "execute")
    }

    // MARK: - Robustness

    @Test("Unknown event types are ignored silently")
    func unknownEventsIgnored() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .sdk("some_future_type"),
            .sdk(nil),
            .toolArgsDelta(index: 0, partialJson: "{\"path\":"),
            .delta("clean"),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
        let transport = AgentV2Transport(streamer: stream)
        var progressCount = 0
        let result = try await transport.roundTrip(
            makeInput(),
            onProgress: { _ in progressCount += 1 },
            onChunk: { _ in },
            onApproval: { _ in }
        )
        #expect(result.reply == "clean")
        #expect(progressCount == 0)
    }

    @Test("Events after the terminal result are ignored (post-result bookkeeping)")
    func postResultEventsIgnored() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .delta("final"),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
            .delta("junk-after-result"),
            .error(code: "ENGINE_ERROR", message: "spurious post-result failure"),
        ]
        let transport = AgentV2Transport(streamer: stream)
        let result = try await transport.roundTrip(
            makeInput(),
            onProgress: { _ in },
            onChunk: { _ in },
            onApproval: { _ in }
        )
        #expect(result.reply == "final")
    }

    @Test("Stream that never sends result throws streamEndedWithoutResult")
    func missingResultThrows() async {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .delta("partial"),
        ]
        let transport = AgentV2Transport(streamer: stream)
        await #expect(throws: AgentV2Error.streamEndedWithoutResult) {
            try await transport.roundTrip(
                makeInput(),
                onProgress: { _ in },
                onChunk: { _ in },
                onApproval: { _ in }
            )
        }
    }

    // MARK: - Error mapping

    @Test("error SESSION_UNRESUMABLE throws the typed sessionUnresumable case")
    func sessionUnresumableThrows() async {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .error(code: "SESSION_UNRESUMABLE", message: "SDK session is no longer resumable"),
        ]
        let transport = AgentV2Transport(streamer: stream)
        await #expect(throws: AgentV2Error.sessionUnresumable) {
            try await transport.roundTrip(
                makeInput(),
                onProgress: { _ in },
                onChunk: { _ in },
                onApproval: { _ in }
            )
        }
    }

    @Test("Other error events throw engine(code:message:)")
    func engineErrorThrows() async {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .error(code: "ENGINE_ERROR", message: "boom"),
        ]
        let transport = AgentV2Transport(streamer: stream)
        await #expect(throws: AgentV2Error.engine(code: "ENGINE_ERROR", message: "boom")) {
            try await transport.roundTrip(
                makeInput(),
                onProgress: { _ in },
                onChunk: { _ in },
                onApproval: { _ in }
            )
        }
    }

    @Test("Codeless error events throw engine(code: nil, …)")
    func codelessErrorThrows() async {
        let stream = ScriptedAgentV2Stream()
        stream.events = [.error(code: nil, message: "mystery")]
        let transport = AgentV2Transport(streamer: stream)
        await #expect(throws: AgentV2Error.engine(code: nil, message: "mystery")) {
            try await transport.roundTrip(
                makeInput(),
                onProgress: { _ in },
                onChunk: { _ in },
                onApproval: { _ in }
            )
        }
    }

    // MARK: - Request body

    @Test("Body carries message/model/mode/skills/attachments/agentContext; no history/provider/tier")
    func bodyShape() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
        let transport = AgentV2Transport(streamer: stream)
        let attachments = [LlmIdeAPIClient.CodeAttachment(path: "~/a.md", content: "abc")]
        _ = try await transport.roundTrip(
            makeInput(attachments: attachments),
            onProgress: { _ in },
            onChunk: { _ in },
            onApproval: { _ in }
        )
        let body = try #require(stream.bodies.last)
        #expect(body["message"] as? String == "hello")
        #expect(body["language"] as? String == "Japanese")
        #expect(body["model"] as? String == "claude-sonnet-4-5")
        #expect(body["mode"] as? String == "plan")
        #expect(body["skills"] as? [String] == ["kit/write"])
        let wireAttachments = try #require(body["attachments"] as? [[String: String]])
        #expect(wireAttachments == [["path": "~/a.md", "content": "abc"]])
        let agentContext = try #require(body["agentContext"] as? [String: Any])
        #expect(agentContext["chatSessionId"] as? String == "CS-1")
        #expect(agentContext["workspaceRoot"] as? String == "~/proj")
        // v2 owns none of these — server sessions hold history; the tier is
        // resolved server-side.
        #expect(body["history"] == nil)
        #expect(body["tier"] == nil)
        #expect(body["fresh"] == nil)
        // The resolved provider IS sent (since 15e0d7c2): the server points the
        // SDK at that provider's Anthropic-compatible endpoint.
        #expect(body["provider"] as? String == "anthropic")
    }

    @Test("fresh round trip sends fresh: true (sessionUnresumable recovery hook)")
    func freshBody() async throws {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-2", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                  durationMs: nil, sessionId: nil, stopReason: nil)),
        ]
        let transport = AgentV2Transport(streamer: stream)
        _ = try await transport.roundTrip(
            makeInput(), fresh: true,
            onProgress: { _ in },
            onChunk: { _ in },
            onApproval: { _ in }
        )
        let body = try #require(stream.bodies.last)
        #expect(body["fresh"] as? Bool == true)
    }

    // MARK: - 3-callback path (approvals unanswerable)

    @Test("3-callback roundTrip throws APPROVAL_UNHANDLED on approvalRequest, not a hang")
    func threeCallbackPathFailsFastOnApproval() async {
        let stream = ScriptedAgentV2Stream()
        stream.events = [
            .init_(AgentV2Init(sessionId: "sdk-1", claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .approvalRequest(makeApproval(id: "req-1")),
        ]
        let transport = AgentV2Transport(streamer: stream)
        // Bounded await: the scripted stream ends right after the parked
        // approval, so the call settling at all (with the typed failure, not
        // streamEndedWithoutResult) proves the 3-callback path fails fast
        // instead of awaiting an answer nobody can post.
        await #expect(throws: AgentV2Error.engine(
            code: "APPROVAL_UNHANDLED",
            message: "approvalRequest req-1 arrived on the 3-callback roundTrip path, "
                + "which has no onApproval handler to answer it"
        )) {
            try await transport.roundTrip(
                makeInput(),
                onProgress: { _ in },
                onChunk: { _ in }
            )
        }
    }

    // MARK: - Error surfacing (LocalizedError)

    // The panel shows `error.localizedDescription` — without LocalizedError
    // conformance that renders as the useless "The operation couldn't be
    // completed. (LlmIdeMacLib.AgentV2Error error 0.)", discarding the
    // server's actual message. Each case must render a human-readable
    // description, and `.engine` must carry the server's message verbatim.
    @Test("AgentV2Error: localizedDescription carries the server message, not an NSError code")
    func errorDescriptionsAreHumanReadable() {
        // The generic ENGINE_ERROR code is noise for the user — message only.
        let generic = AgentV2Error.engine(code: "ENGINE_ERROR", message: "Claude Code is not logged in")
        #expect(generic.localizedDescription == "Agent engine error: Claude Code is not logged in")

        // A specific code is diagnostic signal and stays visible.
        let coded = AgentV2Error.engine(code: "RATE_LIMITED", message: "try later")
        #expect(coded.localizedDescription == "Agent engine error (RATE_LIMITED): try later")

        let codeless = AgentV2Error.engine(code: nil, message: "boom")
        #expect(codeless.localizedDescription == "Agent engine error: boom")

        #expect(AgentV2Error.sessionUnresumable.localizedDescription.contains("session"))
        #expect(AgentV2Error.streamEndedWithoutResult.localizedDescription.contains("stream"))
    }

    // MARK: - Protocol-extension default (legacy conformers)

    @Test("Legacy-shaped conformer: 4-callback roundTrip compiles, forwards, never fires onApproval")
    func legacyDefaultNeverFiresApproval() async throws {
        let legacy = LegacyOnlyTransport()
        let transport: ChatTransport = legacy
        var approvals = 0
        var progressCount = 0
        var chunks: [String] = []
        let result = try await transport.roundTrip(
            makeInput(),
            onProgress: { _ in progressCount += 1 },
            onChunk: { chunks.append($0) },
            onApproval: { _ in approvals += 1 }
        )
        #expect(approvals == 0)
        #expect(progressCount == 1)
        #expect(chunks == ["legacy chunk"])
        #expect(result.reply == "legacy")
        #expect(result.mode == "plan")
    }
}
