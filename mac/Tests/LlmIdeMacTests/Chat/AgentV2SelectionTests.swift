import Testing
import Foundation
@testable import LlmIdeMacLib

/// v2 stream double with a PER-CALL script: `turns[i]` / `thrownErrors[i]`
/// drive the i-th `agentV2Stream` call, so one instance can play "first
/// attempt fails, fresh retry succeeds" — the sessionUnresumable recovery —
/// which the shared `ScriptedAgentV2Stream` (same events every call) cannot.
@MainActor
final class QueuedAgentV2Stream: AgentV2Streaming, @unchecked Sendable {
    var turns: [[AgentV2Event]] = []
    var thrownErrors: [Error?] = []
    private(set) var bodies: [[String: Any]] = []
    private var callIndex = 0

    func agentV2Stream(
        _ body: [String: Any],
        onEvent: @escaping @MainActor (AgentV2Event) -> Void
    ) async throws {
        bodies.append(body)
        defer { callIndex += 1 }
        if callIndex < turns.count {
            for event in turns[callIndex] { await onEvent(event) }
        }
        if callIndex < thrownErrors.count, let error = thrownErrors[callIndex] {
            throw error
        }
    }
}

/// The Agent v2 chat transport (K1 Phase 6, T6.8): every turn runs on the Agent engine. What is pinned
/// here is the provider rule, the two in-flight recoveries (an unresumable session, a stale server), the
/// continuation of a chat the classic engine wrote, and the new-chat stamp.
@MainActor
@Suite("AgentV2 transport + guards")
struct AgentV2SelectionTests {

    // MARK: - Helpers

    func makeInput(provider: String?, history: [LlmIdeAPIClient.CodeAssistTurn] = []) -> ChatTransportInput {
        ChatTransportInput(
            message: "hello", history: history, attachments: [], skills: [],
            agentContext: nil, language: nil, model: nil, provider: provider, mode: "plan")
    }

    func okTurn(sessionId: String, deltas: [String]) -> [AgentV2Event] {
        var events = [AgentV2Event.init_(AgentV2Init(sessionId: sessionId, claudeCodeVersion: nil,
                                                     model: nil, tools: [], capabilities: [],
                                                     mcpServers: []))]
        for d in deltas { events.append(.delta(d)) }
        events.append(.result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                             durationMs: nil, sessionId: nil, stopReason: nil)))
        return events
    }

    func unresumableTurn(sessionId: String) -> [AgentV2Event] {
        [
            .init_(AgentV2Init(sessionId: sessionId, claudeCodeVersion: nil, model: nil,
                               tools: [], capabilities: [], mcpServers: [])),
            .error(code: "SESSION_UNRESUMABLE", message: "SDK session is no longer resumable"),
        ]
    }

    func makeComposite(stream: QueuedAgentV2Stream,
                       capable: Set<String> = [AgentV2Selection.anthropicProvider]) -> AgentV2EngineTransport {
        AgentV2EngineTransport(v2: AgentV2Transport(streamer: stream), capableProviders: { capable })
    }

    /// `deleteSession` and the stamp touch `ChatSessionStore`, so the suite holds the ChatStoreOverrideGate
    /// and points the store at a throwaway directory.
    func withTempStore(_ body: () async throws -> Void) async rethrows {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-v2-selection-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        defer {
            ChatSessionStore.baseDirectoryOverride = nil
            try? FileManager.default.removeItem(at: tmp)
        }
        try await body()
    }

    // MARK: - Provider rule

    @Test("Anthropic-ness follows the app's provider resolution, not the raw picker id")
    func providerResolution() {
        #expect(AgentV2Selection.providerIsAnthropic(ChatTransportInput.makeProvider(selectedProvider: AICliTool.claudeCode.rawValue)))
        #expect(!AgentV2Selection.providerIsAnthropic(ChatTransportInput.makeProvider(selectedProvider: "custom:abc")))
        #expect(!AgentV2Selection.providerIsAnthropic(nil))
    }

    @Test("A turn on a provider that cannot run a chat fails before any request, with the unsupported message")
    func unsupportedProviderFailsFast() async {
        let stream = QueuedAgentV2Stream()
        let composite = makeComposite(stream: stream)
        for provider in ["openai", "deepseek", "custom:legacy-uuid", nil] as [String?] {
            await #expect(throws: ChatProviderUnsupportedError.self) {
                _ = try await composite.roundTrip(self.makeInput(provider: provider),
                                                  onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
            }
        }
        #expect(stream.bodies.isEmpty, "no request leaves for an unsupported provider")
        let message = ChatProviderUnsupportedError(provider: "openai").errorDescription ?? ""
        #expect(message.contains("Settings, Providers") && message.contains("session router"))
    }

    @Test("Factory: the transport is the v2 transport inside the chat composite")
    func factory() throws {
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        _ = try #require(ChatTransportFactory.makeTransport(api: api) as? AgentV2EngineTransport)
    }

    @Test("Composite onLiveTasks forwards to the v2 transport")
    func onLiveTasksForwards() throws {
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        let composite = try #require(ChatTransportFactory.makeTransport(api: api) as? AgentV2EngineTransport)
        var received: [[AgentTask]] = []
        composite.onLiveTasks = { received.append($0) }
        composite.v2.onLiveTasks?([AgentTask(id: "2", title: "Next", status: .pending)])
        #expect(received.count == 1)
    }

    // MARK: - sessionUnresumable -> fresh retry

    @Test("sessionUnresumable: retries once with fresh:true, notes, and returns the fresh reply")
    func sessionUnresumableRetriesFresh() async throws {
        let stream = QueuedAgentV2Stream()
        stream.turns = [unresumableTurn(sessionId: "sdk-old"),
                        okTurn(sessionId: "sdk-new", deltas: ["fresh ", "answer"])]
        let composite = makeComposite(stream: stream)

        var labels: [String] = []
        let result = try await composite.roundTrip(
            makeInput(provider: "anthropic"),
            onProgress: { labels.append($0.label) },
            onChunk: { _ in },
            onApproval: { _ in })

        #expect(result.reply == "fresh answer")
        #expect(labels.contains(AgentV2EngineTransport.freshSessionNote))
        #expect(stream.bodies.count == 2)
        #expect(stream.bodies[0]["fresh"] == nil)
        #expect(stream.bodies[1]["fresh"] as? Bool == true)
    }

    @Test("sessionUnresumable twice: surfaces as a failed turn")
    func sessionUnresumableTwiceFails() async {
        let stream = QueuedAgentV2Stream()
        stream.turns = [unresumableTurn(sessionId: "sdk-a"), unresumableTurn(sessionId: "sdk-b")]
        let composite = makeComposite(stream: stream)
        await #expect(throws: AgentV2Error.sessionUnresumable) {
            _ = try await composite.roundTrip(
                self.makeInput(provider: "anthropic"),
                onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        }
    }

    // MARK: - Stale-server 404 guard

    @Test("HTTP 404: the banner fires and the turn fails (no classic engine to fall back to)")
    func staleServer404RaisesBanner() async {
        let stream = QueuedAgentV2Stream()
        stream.thrownErrors = [APIError.http(status: 404, code: "HTTP_ERROR",
                                             message: "Agent v2 stream request failed (404)", details: nil)]
        let composite = makeComposite(stream: stream)
        var staleBanner = 0
        composite.onStaleServer = { staleBanner += 1 }
        await #expect(throws: APIError.self) {
            _ = try await composite.roundTrip(
                self.makeInput(provider: "anthropic"),
                onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        }
        #expect(staleBanner == 1)
    }

    @Test("Non-404 transport errors propagate with no banner")
    func non404Propagates() async {
        let stream = QueuedAgentV2Stream()
        stream.thrownErrors = [APIError.http(status: 500, code: "HTTP_ERROR", message: "boom", details: nil)]
        let composite = makeComposite(stream: stream)
        var staleBanner = 0
        composite.onStaleServer = { staleBanner += 1 }
        await #expect(throws: APIError.self) {
            _ = try await composite.roundTrip(
                self.makeInput(provider: "anthropic"),
                onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        }
        #expect(staleBanner == 0)
    }

    // MARK: - Legacy chat continuation

    @Test("A chat the classic engine wrote starts a fresh Agent session seeded with its recent turns")
    func legacyContinuationSendsFreshWithHistory() async throws {
        let stream = QueuedAgentV2Stream()
        stream.turns = [okTurn(sessionId: "sdk-1", deltas: ["continued"])]
        let composite = makeComposite(stream: stream)
        var input = makeInput(provider: "anthropic", history: [
            .init(role: .user, content: "old question"), .init(role: .assistant, content: "old answer")])
        input.continuesLegacyChat = true
        let result = try await composite.roundTrip(input, onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        #expect(result.reply == "continued")
        #expect(stream.bodies[0]["fresh"] as? Bool == true)
        let history = stream.bodies[0]["history"] as? [[String: Any]]
        #expect(history?.count == 2)
        #expect(history?.first?["content"] as? String == "old question")
    }

    @Test("A normal turn is not fresh and sends no history")
    func normalTurnResumes() async throws {
        let stream = QueuedAgentV2Stream()
        stream.turns = [okTurn(sessionId: "sdk-1", deltas: ["ok"])]
        let composite = makeComposite(stream: stream)
        _ = try await composite.roundTrip(makeInput(provider: "anthropic", history: [.init(role: .user, content: "x")]),
                                          onProgress: { _ in }, onChunk: { _ in }, onApproval: { _ in })
        #expect(stream.bodies[0]["fresh"] == nil)
        #expect(stream.bodies[0]["history"] == nil)
    }

    @Test("Engine: a legacy chat's first turn is fresh with at most the last 6 turns, then the chat is stamped and the next turn resumes")
    func engineContinuesLegacyChat() async throws {
        try await withTempStore {
            let stream = QueuedAgentV2Stream()
            stream.turns = [okTurn(sessionId: "sdk-1", deltas: ["first"]), okTurn(sessionId: "sdk-1", deltas: ["second"])]
            let engine = ChatEngine(scope: .explorer, transport: makeComposite(stream: stream))
            engine.hooks.resolveTransportInput = { message, history, attachments, skills in
                ChatTransportInput(message: message, history: history, attachments: attachments, skills: skills,
                                   agentContext: nil, language: nil, model: nil, provider: "anthropic", mode: "ask")
            }
            var legacy = ChatSession(scope: .explorer, engine: nil)
            legacy.messages = (0..<20).map { i in
                ChatMessage(role: i % 2 == 0 ? .user : .assistant, content: "turn \(i)", status: .done, createdAt: Date())
            }
            ChatSessionStore.save(legacy)
            engine.currentSessionIDString = legacy.id.uuidString
            engine.messages = legacy.messages
            #expect(engine.currentSessionEngineMarker() == nil)

            await engine.runTurn("continue please")
            #expect(stream.bodies[0]["fresh"] as? Bool == true)
            let sent = stream.bodies[0]["history"] as? [[String: Any]] ?? []
            #expect(!sent.isEmpty && sent.count <= AgentV2Selection.legacyContinuationTurns)
            #expect(engine.currentSessionEngineMarker() == AgentV2Selection.sessionEngineV2, "stamped once it landed")

            await engine.runTurn("and again")
            #expect(stream.bodies[1]["fresh"] == nil, "the stamped chat resumes its session")
        }
    }

    // MARK: - Engine-level behavior

    func makeV2Engine(stream: QueuedAgentV2Stream) -> ChatEngine {
        let engine = ChatEngine(scope: .explorer, transport: makeComposite(stream: stream))
        engine.hooks.resolveTransportInput = { message, history, attachments, skills in
            ChatTransportInput(message: message, history: history, attachments: attachments,
                               skills: skills, agentContext: nil, language: nil,
                               model: nil, provider: "anthropic", mode: "plan")
        }
        let session = ChatSession(scope: .explorer, engine: AgentV2Selection.sessionEngineV2)
        ChatSessionStore.save(session)
        engine.currentSessionIDString = session.id.uuidString
        return engine
    }

    @Test("Engine turn: fresh-retry note lands in the chat, turn succeeds")
    func engineFreshRetryNoteLandsInChat() async throws {
        try await withTempStore {
            let stream = QueuedAgentV2Stream()
            stream.turns = [unresumableTurn(sessionId: "sdk-old"),
                            okTurn(sessionId: "sdk-new", deltas: ["fresh ", "answer"])]
            let engine = makeV2Engine(stream: stream)
            await engine.runTurn("hello")
            let last = engine.messages.last(where: { $0.role == .assistant })
            #expect(last?.content == "fresh answer")
            #expect(last?.toolSteps.map(\.label).contains(AgentV2EngineTransport.freshSessionNote) == true)
            #expect(engine.error == nil)
        }
    }

    @Test("Engine turn on a 404: the notice banner is set and the turn fails; the next healthy turn clears it")
    func engineStaleServerNotice() async throws {
        try await withTempStore {
            let stream = QueuedAgentV2Stream()
            stream.thrownErrors = [APIError.http(status: 404, code: "HTTP_ERROR",
                                                 message: "Agent v2 stream request failed (404)", details: nil)]
            stream.turns = [[], okTurn(sessionId: "sdk-2", deltas: ["v2 ok"])]
            let engine = makeV2Engine(stream: stream)
            await engine.runTurn("one")
            #expect(engine.agentV2Notice == AgentV2EngineTransport.staleServerBannerText)
            #expect(engine.error != nil)
            await engine.runTurn("two")
            #expect(engine.agentV2Notice == nil)
        }
    }

    @Test("Engine turn on an unsupported provider shows the unsupported message and sends nothing")
    func engineUnsupportedProvider() async throws {
        try await withTempStore {
            let stream = QueuedAgentV2Stream()
            let engine = makeV2Engine(stream: stream)
            engine.hooks.resolveTransportInput = { message, history, attachments, skills in
                ChatTransportInput(message: message, history: history, attachments: attachments, skills: skills,
                                   agentContext: nil, language: nil, model: "gpt-x", provider: "openai", mode: "ask")
            }
            await engine.runTurn("hello")
            #expect(stream.bodies.isEmpty)
            #expect(engine.error?.contains("Settings, Providers") == true)
        }
    }

    // MARK: - Per-chat marker

    @Test("ChatSession engine marker: files persisted before the field decode as legacy; stamps round-trip")
    func chatSessionEngineDecode() throws {
        // A v2-envelope file written before the marker existed — no `engine`
        // key at all — must decode (nil marker = legacy chat), never throw.
        let oldJSON = """
        {"storeVersion":2,"id":"22222222-2222-2222-2222-222222222222","scope":"explorer",
         "title":"Old v2","createdAt":807271200.0,"lastUsedAt":807271200.0,"messages":[]}
        """
        let old = try AppJSON.decoder.decode(ChatSession.self, from: Data(oldJSON.utf8))
        #expect(old.engine == nil)

        // A stamped chat round-trips through the store's encoder.
        let stamped = ChatSession(scope: .explorer, engine: AgentV2Selection.sessionEngineV2)
        let data = try AppJSON.encoder.encode(stamped)
        #expect(try AppJSON.decoder.decode(ChatSession.self, from: data).engine
               == AgentV2Selection.sessionEngineV2)
    }


    @Test("setTransport swaps when idle and refuses mid-turn")
    func setTransportGuards() {
        let a = ScriptedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: a)
        engine.busy = true
        let b = ScriptedChatTransport()
        engine.setTransport(b)
        #expect((engine.transport as? ScriptedChatTransport) === a)
        engine.busy = false
        engine.setTransport(b)
        #expect((engine.transport as? ScriptedChatTransport) === b)
    }

    // MARK: - Save-plan action visibility

    // `contentLooksLikePlan: true` is explicit on the POSITIVE cases because
    // it became a hard precondition of the guard (a plan-like mode alone is
    // no longer enough — see `showsSavePlanAction`, which added it to stop
    // the "📋 Deliverables Created" summaries offering a Save Plan button).
    // The negative cases leave it at its default: they must stay false for
    // their own reason, and passing it would hide which condition is doing
    // the work.
    @Test("Save Plan action: plan-like v2 results only")
    func savePlanActionVisibility() {
        #expect(AgentV2Selection.showsSavePlanAction(mode: "plan", v2Selected: true, hasPendingTool: false,
                                                     contentLooksLikePlan: true))
        #expect(AgentV2Selection.showsSavePlanAction(mode: "assist_plan", v2Selected: true, hasPendingTool: false,
                                                     contentLooksLikePlan: true))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: "execute", v2Selected: true, hasPendingTool: false))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: "auto", v2Selected: true, hasPendingTool: false))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: nil, v2Selected: true, hasPendingTool: false))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: "plan", v2Selected: false, hasPendingTool: false))
        #expect(!AgentV2Selection.showsSavePlanAction(mode: "plan", v2Selected: true, hasPendingTool: true))
    }

    // After a successful save the affordance must retire: the saved-plan
    // card (a .toolResult message) doesn't shift lastAssistantTurnId, so
    // without this flag the button stayed live and re-saved on every click.
    @Test("Save Plan action: hidden once this message's plan was saved")
    func savePlanActionHiddenAfterSave() {
        #expect(!AgentV2Selection.showsSavePlanAction(
            mode: "plan", v2Selected: true, hasPendingTool: false, planSaved: true))
        #expect(AgentV2Selection.showsSavePlanAction(
            mode: "plan", v2Selected: true, hasPendingTool: false, planSaved: false,
            contentLooksLikePlan: true))
    }

    // The Execute action must never fire "Execute the attached plan" with
    // nothing attached: file attached OR the card's own plan text, else no send.
    @Test("Execute plan: fires only when the plan file or its text is attachable")
    func executePlanFireRule() {
        #expect(CodeAssistantPanel.executePlanCanFire(attached: true, hasPlanContent: false))
        #expect(CodeAssistantPanel.executePlanCanFire(attached: false, hasPlanContent: true))
        #expect(!CodeAssistantPanel.executePlanCanFire(attached: false, hasPlanContent: false))
    }

    @Test("Plan step parsing: numbered lines and Step headings; bullets lose to numbering")
    func planStepParsing() {
        let md = """
        # Plan

        1. Add model types
        2. Wire transport
        - Write tests
        ## Step 3: Update docs
        """
        let steps = CodeAssistantPanel.parsePlanSteps(from: md)
        // "- Write tests" is dropped: a plan that numbers its steps is read as
        // numbered, so stray bullets elsewhere never become tasks.
        #expect(steps == [
            "Add model types",
            "Wire transport",
            "Update docs",
        ])
    }

    // A real saved plan has Context/Files/Risks sections and sub-bullets. Each
    // returned line becomes a task-create call, so anything but the actual
    // steps is a junk task the agent then grinds through.
    @Test("Plan step parsing: scopes to the Steps section, ignoring prose, paths, sub-bullets, risks")
    func planStepParsingScopesToStepsSection() {
        let md = """
        # Add dark mode

        ## Context

        - The app currently hardcodes light colors.
        - Users have asked for this since March.

        ## Files to change

        - Sources/Theme.swift

        ## Steps

        1. Add a Theme token table
           - define light palette
           - define dark palette
        2. Wire the toggle into Settings
        3. Migrate AppShell to tokens

        ## Risks

        - Existing screenshots will need regenerating.
        """
        #expect(CodeAssistantPanel.parsePlanSteps(from: md) == [
            "Add a Theme token table",
            "Wire the toggle into Settings",
            "Migrate AppShell to tokens",
        ])
    }

    // The writing-plans skill's shape, seen for real: no H1 (the model put the
    // title in a Write call Plan mode refused), a "## Global Constraints"
    // section, `# 1. Builds` comments inside a bash fence, then one
    // "### Task N:" heading per step whose body carries Files/Interfaces
    // bullets and "- [ ] **Step 1:**" checklists. It executed as
    // 'Plan title: "Global Constraints"' with Task 1's bullets as the steps
    // ("Modify: `package.json`", "Consumes: nothing.", …).
    static let writingPlansShape = """
    I'll investigate the repo structure before proposing anything.

    > **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

    **Goal:** Use knip to find genuinely-dead TypeScript files in the monorepo, delete the empty folders, and keep the guard green.

    ## Global Constraints

    - **Scope is TypeScript/JavaScript dead code only.**

    ## Design decisions

    ### Verification recipe

    ```bash
    # 1. Builds
    npm run web:build
    # 2. Static guards
    npm run check:types
    ```

    ### Task 1: Install knip and capture a green baseline

    **Files:**
    - Modify: `package.json`
    - Create: `/tmp/knip-baseline.txt`

    **Interfaces:**
    - Consumes: nothing.

    - [ ] **Step 1: Confirm knip is genuinely absent**

    ```bash
    # 1. check the lockfile
    grep knip package-lock.json
    ```

    ### Task 2: Widen knip coverage

    - [ ] **Step 1: Edit knip.json**

    ### Task 3: Triage every reported file

    ## Risks

    - knip misses dynamic imports.
    """

    @Test("Plan step parsing: writing-plans \"### Task N:\" headings are the steps, not one task's bullets")
    func planStepParsingTaskHeadings() {
        #expect(CodeAssistantPanel.parsePlanSteps(from: Self.writingPlansShape) == [
            "Install knip and capture a green baseline",
            "Widen knip coverage",
            "Triage every reported file",
        ])
    }

    @Test("Plan step parsing: numbered comments inside a code fence are not steps")
    func planStepParsingSkipsCodeFences() {
        let md = """
        ## Steps

        1. Run the build

        ```bash
        # 2. not a step
        3. not a step either
        ```

        2. Ship it
        """
        #expect(CodeAssistantPanel.parsePlanSteps(from: md) == ["Run the build", "Ship it"])
    }

    @Test("Plan step parsing: checklist markers are stripped from task titles")
    func planStepParsingStripsCheckboxes() {
        let md = """
        ## Steps

        - [ ] Add model types
        - [x] Wire transport
        """
        #expect(CodeAssistantPanel.parsePlanSteps(from: md) == [
            "Add model types",
            "Wire transport",
        ])
    }

    @Test("Plan with no parseable steps falls back to the generic execute message")
    func planStepParsingFallback() {
        let prose = "We should probably modernize the theme layer at some point."
        #expect(CodeAssistantPanel.parsePlanSteps(from: prose).isEmpty)
        #expect(CodeAssistantPanel.executePlanMessage(forPlanContent: prose, planTitle: nil)
                == CodeAssistantPanel.executePlanMessage)
    }

    @Test("Execute plan message lists parsed steps and defers method to the injected skill")
    func executePlanMessageStructured() {
        let msg = CodeAssistantPanel.executePlanMessage(
            forPlanContent: "1. First\n2. Second",
            planTitle: "My plan")
        #expect(msg.contains("1. First"))
        #expect(msg.contains("2. Second"))
        #expect(msg.contains("My plan"))
        #expect(msg.contains("execution skill"))
        // The HOW moved server-side (plan-pipeline.mjs injects executing-plans
        // or subagent-driven-development for a planExecute turn). Restating it
        // here is what let the two drift before.
        #expect(!msg.contains("ask-subagent"))
        #expect(!msg.contains("Edit/Write"))
    }

    @Test("Plan title derivation: first non-empty heading line, hashes stripped, capped")
    func planTitleDerivation() {
        #expect(CodeAssistantPanel.planTitle(from: "# Add dark mode\n\nSteps…") == "Add dark mode")
        #expect(CodeAssistantPanel.planTitle(from: "###  Refactor parser ") == "Refactor parser")
        #expect(CodeAssistantPanel.planTitle(from: "\n\nplain first line") == "plain first line")
        let long = String(repeating: "x", count: 100)
        #expect(CodeAssistantPanel.planTitle(from: long).count == 60)
    }

    // A plan-like reply that opens with a sentence of chat preamble before
    // its heading used to save the FILE under that preamble sentence
    // instead of the real title (seen for real: "That plan is already
    // finalized from this conversation — here it is again:" became the
    // saved plan's filename, three lines above its actual
    // "# Remove Legacy Install Scripts — Plan" heading).
    @Test("Plan title derivation skips chat preamble and uses the heading line")
    func planTitleDerivationSkipsPreamble() {
        let reply = """
        That plan is already finalized from this conversation — here it is again:

        # Remove Legacy Install Scripts — Plan

        1. Delete `add-to-project.sh` and `install.sh` from repo root.
        """
        #expect(CodeAssistantPanel.planTitle(from: reply) == "Remove Legacy Install Scripts — Plan")
    }

    // Only a title-bearing ATX heading may outrank the first line: a
    // tab-indented heading still counts (and the tab must not leak a '#'
    // into the title), while a shebang and a marks-only line do not.
    @Test("Plan title derivation: ATX shape only — tab indent ok, shebang and bare hashes skipped")
    func planTitleDerivationAtxShape() {
        #expect(CodeAssistantPanel.planTitle(from: "Preamble:\n\n\t# Real Title\n") == "Real Title")
        #expect(CodeAssistantPanel.planTitle(from: "Run this:\n\n#!/bin/bash\necho hi") == "Run this:")
        #expect(CodeAssistantPanel.planTitle(from: "Here is the plan:\n\n###\n\n# Real Title") == "Real Title")
    }

    @Test("Plan title derivation: no H1 → the Goal line, never a generic section or a fenced comment")
    func planTitleDerivationWithoutH1() {
        #expect(CodeAssistantPanel.planTitle(from: Self.writingPlansShape)
                == "Use knip to find genuinely-dead TypeScript files in the mono")
        // An H1 still wins over everything — even one that comes after sections.
        #expect(CodeAssistantPanel.planTitle(from: "## Context\n\nx\n\n# Add dark mode\n") == "Add dark mode")
        // No H1 and no Goal: the first heading that names the work.
        #expect(CodeAssistantPanel.planTitle(from: "## Global Constraints\n\n- a\n\n## Migrate the auth layer\n\n### Task 1: x")
                == "Migrate the auth layer")
        // A heading inside a code fence is a shell comment, not a title.
        #expect(CodeAssistantPanel.planTitle(from: "Run:\n\n```bash\n# 1. Builds\n```\n\n## Ship the release")
                == "Ship the release")
        // A ```bash inside a ````markdown block does not close it (CommonMark).
        #expect(CodeAssistantPanel.planTitle(from: "````markdown\n```bash\n# inner\n```\n# Still Inside\n````\n## Real Heading")
                == "Real Heading")
        // A dot inside a word is not the end of the Goal's sentence.
        #expect(CodeAssistantPanel.planTitle(from: "**Goal:** Upgrade to Node.js 22 and v1.2 of the SDK. Then more.")
                == "Upgrade to Node.js 22 and v1.2 of the SDK")
        // The 60-char cap never leaves a trailing space.
        #expect(!CodeAssistantPanel.planTitle(from: "**Goal:** " + String(repeating: "word ", count: 20)).hasSuffix(" "))
        // Only generic headings: fall back to the first one rather than nothing.
        #expect(CodeAssistantPanel.planTitle(from: "## Context\n\nprose") == "Context")
    }

    // MARK: - deleteSession cleanup

    @Test("deleteSession additionally calls the v2 server-side session delete (best-effort)")
    func deleteSessionCallsAgentV2Cleanup() async throws {
        try await withTempStore {
            let engine = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
            var deleted: [String] = []
            engine.deleteAgentV2Session = { deleted.append($0) }

            let session = ChatSession(scope: .explorer, title: "Doomed")
            ChatSessionStore.save(session)
            engine.handleOnAppearSessions()
            #expect(engine.currentSessionIDString == session.id.uuidString)

            await engine.deleteSession(session.id)
            // The local delete proceeded (file gone, engine re-pointed) AND the
            // server-side chat→SDK-session mapping was dropped with the same id.
            #expect(deleted == [session.id.uuidString])
            #expect(ChatSessionStore.load(id: session.id) == nil)
        }
    }
}

@Suite("AgentV2Selection.providerHintNeeded")
struct AgentV2ProviderHintTests {
    @Test("the hint fires for a provider the chat cannot run, never for one it can")
    func hintFollowsCapableSet() {
        let capable: Set<String> = ["anthropic", "custom:glm", "custom:cat-deepseek"]
        for provider in ["anthropic", "custom:glm", "custom:cat-deepseek"] as [String] {
            #expect(!AgentV2Selection.providerHintNeeded(resolvedProvider: provider, capableProviders: capable), "\(provider)")
        }
        for provider in ["openai", "google", "deepseek", "custom:abc", nil] as [String?] {
            #expect(AgentV2Selection.providerHintNeeded(resolvedProvider: provider, capableProviders: capable), "\(provider ?? "nil")")
        }
    }
}

// The Agent SDK speaks the Anthropic Messages API only, so a non-Claude model reaches the Agent engine
// through a custom provider's Anthropic-compatible endpoint (Z.AI GLM `.../api/anthropic`), or through the
// session router and the adapter (a catalog connection). "Can this provider run a chat" is a set.
@Suite("AgentV2Selection.agentCapableProviders")
struct AgentV2CapableProviderTests {
    static func provider(_ id: String, door: String?, enabled: Bool = true) -> CustomProvider {
        var provider = CustomProvider(name: id, baseURL: "https://example.test/v1", apiKey: "custom.\(id).apiKey",
                                      models: [], anthropicBaseURL: door)
        provider.id = id
        provider.isEnabled = enabled
        return provider
    }

    @Test("Anthropic always; a custom provider only when enabled AND it declares an Anthropic-compatible URL")
    func setMembership() {
        let capable = AgentV2Selection.agentCapableProviders(customProviders: [
            Self.provider("glm", door: "https://api.z.ai/api/anthropic"),
            Self.provider("glm-off", door: "https://api.z.ai/api/anthropic", enabled: false),
            Self.provider("plain", door: nil),
            Self.provider("blank", door: "   "),
        ])
        #expect(capable == ["anthropic", "custom:glm"])
        #expect(AgentV2Selection.agentCapableProviders(customProviders: []) == ["anthropic"])
    }

    @Test("a catalog connection joins the set only when the caller passes it (the router is on)")
    func catalogJoins() {
        #expect(AgentV2Selection.agentCapableProviders(customProviders: [], catalogWireIds: ["custom:cat-groq"])
                == ["anthropic", "custom:cat-groq"])
    }
}

@Suite("CustomProvider.anthropicBaseURL")
struct CustomProviderAgentDoorTests {
    @Test("providers persisted before the field existed decode with no door")
    func decodesLegacyJSON() throws {
        let json = """
        [{"id":"abc","name":"GLM","baseURL":"https://api.z.ai/api/paas/v4","apiKey":"custom.abc.apiKey",\
        "models":[],"isOpenAICompatible":true,"description":"","isEnabled":true}]
        """
        let decoded = try JSONDecoder().decode([CustomProvider].self, from: Data(json.utf8))
        #expect(decoded.first?.anthropicBaseURL == nil)
        #expect(decoded.first?.canRunAgentEngine == false)
        #expect(decoded.first?.wireId == "custom:abc")
    }

    @Test("round-trips the door; whitespace-only counts as absent (matches the server's normalization)")
    func roundTripsDoor() throws {
        var provider = CustomProvider(name: "GLM", baseURL: "https://example.test/v1", apiKey: "k",
                                      anthropicBaseURL: "https://api.z.ai/api/anthropic")
        let back = try JSONDecoder().decode(CustomProvider.self, from: JSONEncoder().encode(provider))
        #expect(back.anthropicBaseURL == "https://api.z.ai/api/anthropic")
        #expect(back.canRunAgentEngine)
        provider.anthropicBaseURL = "  "
        #expect(!provider.canRunAgentEngine)
    }
}
