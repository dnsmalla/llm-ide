import Testing
import Foundation
@testable import LlmIdeMacLib

/// Characterization suite for the session-management half of `ChatEngine` —
/// the create/switch/delete/persist logic lifted out of
/// `CodeAssistantPanel+Session.swift`. These pin the four behaviours whose
/// "why" only existed as prose comments in the panel:
///
///  1. swapping the active chat bumps `sessionEpoch`, which is the ONLY thing
///     stopping a scheduled auto-continue from firing a turn into a different
///     chat's history;
///  2. deleting the active chat falls back to the newest survivor, or mints a
///     blank chat when nothing is left (it must never leave no current chat);
///  3. `resetActiveTurnState` finalizes an in-flight placeholder
///     *synchronously*, because its callers persist `history` on the very next
///     line and `runTask.cancel()` alone is asynchronous;
///  4. deleting a chat forgets that chat's server-side session memory.
///
/// `.serialized` because every test here drives the process-global
/// `ChatSessionStore.baseDirectoryOverride` and the shared UserDefaults
/// relaunch pointer.
@MainActor
@Suite("ChatEngine sessions", .serialized)
struct ChatEngineSessionTests {
    static let scope: ChatScope = .explorer
    static var pointerKey: String { "chat.current.\(scope.rawValue)" }

    func makeEngine() -> (ChatEngine, ScriptedChatTransport) {
        let t = ScriptedChatTransport()
        let engine = ChatEngine(scope: Self.scope, transport: t)
        engine.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [],
                               skills: skills, agentContext: nil, language: "en",
                               model: nil, provider: nil, mode: "auto")
        }
        return (engine, t)
    }

    /// Point `ChatSessionStore` at a throwaway directory and clear the
    /// relaunch pointer for the duration of `body`, then restore both. Same
    /// intent as `ChatSessionStoreTests`' setUp/tearDown, expressed as a scope
    /// because a `struct` suite has no `deinit` to restore process globals in.
    func withTempStore(_ body: () async -> Void) async {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("chat-engine-session-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        UserDefaults.standard.removeObject(forKey: Self.pointerKey)
        await body()
        UserDefaults.standard.removeObject(forKey: Self.pointerKey)
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    /// `ChatSessionStore.save` stamps `lastUsedAt = Date()` itself, so save
    /// ORDER — not the value passed in — decides `list(for:)`'s newest-first
    /// ordering. A millisecond between saves makes that ordering unambiguous.
    func settle(_ ms: UInt64 = 2) async {
        try? await Task.sleep(nanoseconds: ms * 1_000_000)
    }

    @Test("switchSession bumps epoch — a scheduled auto-continue from the old session no-ops")
    func epochBump() async {
        await withTempStore {
            let (engine, t) = makeEngine()
            // Fire the auto-continue on the next main-queue drain instead of
            // 0.8 real seconds from now.
            engine.continueDelayNanos = 0

            let old = ChatSession(scope: Self.scope, title: "Old")
            ChatSessionStore.save(old)
            engine.handleOnAppearSessions()
            #expect(engine.currentSessionIDString == old.id.uuidString)

            await settle()
            let other = ChatSession(scope: Self.scope, title: "Other")
            ChatSessionStore.save(other)
            engine.refreshSessions()

            // A reply that asks the agent to keep going — this is what
            // schedules the delayed follow-up turn against `old`.
            t.result = .init(reply: "working", pendingTool: nil, tasks: nil,
                             continueNeeded: true, usage: nil, mode: nil)
            await engine.runTurn("kick off")
            #expect(engine.agent.agentIsAutonomous == true)

            // No `await` between here and `switchSession`: the main actor runs
            // this stretch to completion, so the 0-delay `asyncAfter` provably
            // has NOT fired yet and the switch really does beat it.
            let epochBefore = engine.sessionEpoch
            engine.switchSession(to: other.id)
            #expect(engine.sessionEpoch > epochBefore)

            // Now let the scheduled continue fire — and be rejected.
            await settle(100)

            #expect(engine.currentSessionIDString == other.id.uuidString)
            // The decisive assertion: the follow-up turn did NOT land in the
            // newly active chat.
            #expect(engine.messages.isEmpty)
            #expect(engine.busy == false)
            // ...and the outgoing chat was persisted with exactly its own two
            // turns — no "Continue working" turn appended after the switch.
            #expect(ChatSessionStore.load(id: old.id)?.messages.map(\.content) == ["kick off", "working"])

            // Control: with no session swap, the identical setup DOES fire the
            // follow-up. Without this, the assertion above would still pass if
            // auto-continue were simply broken.
            let (control, ct) = makeEngine()
            control.continueDelayNanos = 0
            ct.result = .init(reply: "working", pendingTool: nil, tasks: nil,
                              continueNeeded: true, usage: nil, mode: nil)
            await control.runTurn("kick off")
            // Stop the chain after one hop so a 0-delay continue can't loop.
            ct.result = .init(reply: "done", pendingTool: nil, tasks: nil,
                              continueNeeded: nil, usage: nil, mode: nil)
            await settle(100)
            #expect(control.messages.map(\.content).contains("Continue working on your pending tasks."))
        }
    }

    @Test("deleteSession(active) falls back to newest remaining, else mints fresh")
    func deleteFallback() async {
        await withTempStore {
            let (engine, _) = makeEngine()
            var replaced: [[String]] = []
            engine.onHistoryReplaced = { replaced.append($0.map(\.content)) }

            let keep = ChatSession(scope: Self.scope, title: "Keep",
                                   messages: [ChatMessage(wireTurn: .init(role: .user, content: "kept"), sessionDate: Date())])
            ChatSessionStore.save(keep)
            await settle()
            let active = ChatSession(scope: Self.scope, title: "Active",
                                     messages: [ChatMessage(wireTurn: .init(role: .user, content: "doomed"), sessionDate: Date())])
            ChatSessionStore.save(active)

            engine.handleOnAppearSessions()
            #expect(engine.currentSessionIDString == active.id.uuidString)
            #expect(engine.messages.map(\.content) == ["doomed"])
            #expect(replaced == [["doomed"]])

            // Delete the ACTIVE chat → newest survivor becomes current, with
            // its own history loaded and the relaunch pointer moved with it.
            await engine.deleteSession(active.id)
            #expect(engine.currentSessionIDString == keep.id.uuidString)
            #expect(engine.messages.map(\.content) == ["kept"])
            #expect(ChatSessionStore.load(id: active.id)?.id == nil)
            #expect(UserDefaults.standard.string(forKey: Self.pointerKey) == keep.id.uuidString)
            // The panel's ↑-recall seed is re-fired for the loaded history.
            #expect(replaced == [["doomed"], ["kept"]])
            #expect(engine.sessions.map(\.id) == [keep.id])

            // Delete the LAST remaining chat → a fresh blank chat is minted so
            // the scope is never left without a current session.
            await engine.deleteSession(keep.id)
            #expect(engine.currentSessionIDString != keep.id.uuidString)
            #expect(UUID(uuidString: engine.currentSessionIDString) != nil)
            #expect(engine.messages.isEmpty)
            #expect(engine.sessions.map(\.id.uuidString) == [engine.currentSessionIDString])
            #expect(UserDefaults.standard.string(forKey: Self.pointerKey) == engine.currentSessionIDString)
            // A blank chat replaces no history, so no extra hook call.
            #expect(replaced == [["doomed"], ["kept"]])
        }
    }

    @Test("resetActiveTurnState finalizes an in-flight placeholder synchronously")
    func syncFinalize() async {
        // No store needed: this path is pure in-memory turn state.
        let (engine, _) = makeEngine()
        var extraResets = 0
        engine.onResetActiveTurnExtra = { extraResets += 1 }

        let streamingID = engine.beginStreamingTurn()
        engine.appendStreamedChunk(streamingID, "half an answer")
        engine.enqueue("queued while streaming", skillIds: [])
        #expect(engine.revealingTurnID == streamingID)

        // Deliberately NOT awaited — callers (createNewSession/switchSession)
        // persist `history` on the very next line, so the placeholder must be
        // finalized by the time this call returns.
        engine.resetActiveTurnState()

        #expect(engine.revealingTurnID == nil)
        #expect(engine.revealedCount == 0)
        // Task 9: the partial text is left exactly as it streamed; the stop
        // is carried by `status`, not by a marker glued onto the content.
        #expect(engine.messages.last?.content == "half an answer")
        #expect(engine.messages.last?.status == .stopped)
        #expect(engine.busy == false)
        #expect(engine.queued.isEmpty)
        // The panel's view-only expand state is reset through the hook.
        #expect(extraResets == 1)

        // With nothing streaming it is a no-op beyond the counters.
        engine.resetActiveTurnState()
        #expect(engine.messages.map(\.content) == ["half an answer"])
        #expect(extraResets == 2)
    }

    @Test("persistCurrentChat preserves id/createdAt across re-saves — only genuinely new turns get fresh ones")
    func persistPreservesIdentity() async {
        await withTempStore {
            let (engine, t) = makeEngine()

            // Seed a session with one message stamped with a REAL, distinct
            // id/createdAt — standing in for a message an append site (e.g.
            // `MobileControlManager`) already wrote correctly, the same way
            // the bug's finding described. If `persistCurrentChat` rebuilds
            // the whole array via `ChatMessage(wireTurn:sessionDate:)` on
            // every call, this identity is exactly what gets clobbered.
            let seededID = UUID()
            let seededCreatedAt = Date(timeIntervalSince1970: 1_000_000)
            let seeded = ChatMessage(id: seededID, role: .user, content: "seeded turn",
                                     status: .done, createdAt: seededCreatedAt)
            let session = ChatSession(scope: Self.scope, title: "New chat", messages: [seeded])
            ChatSessionStore.save(session)
            engine.handleOnAppearSessions()
            #expect(engine.currentSessionIDString == session.id.uuidString)
            #expect(engine.messages.map(\.content) == ["seeded turn"])

            // Run one real turn — appends "second question" (user) and
            // "first answer" (assistant) to history.
            t.result = .init(reply: "first answer", pendingTool: nil, tasks: nil,
                             continueNeeded: nil, usage: nil, mode: nil)
            await engine.runTurn("second question")
            engine.persistCurrentChat()

            let firstSave = ChatSessionStore.load(id: session.id)
            #expect(firstSave?.messages.map(\.content) == ["seeded turn", "second question", "first answer"])
            // The seeded message's identity survived the FIRST persist — it
            // was already loaded from disk one line above `session.messages
            // = capped.map { ... }` in the old code, and got overwritten
            // anyway; this pins that it no longer does.
            #expect(firstSave?.messages[0].id == seededID)
            #expect(firstSave?.messages[0].createdAt == seededCreatedAt)
            let newIDs = Set((firstSave?.messages ?? []).dropFirst().map(\.id))
            #expect(newIDs.count == 2)

            // Persisting AGAIN with no history change at all is the exact
            // shape of the bug: every call to `persistCurrentChat` fires on
            // every turn, so a re-save with nothing new must be a no-op on
            // identity — not just the seeded turn, but the two turns from
            // the round-trip above too.
            engine.persistCurrentChat()
            let secondSave = ChatSessionStore.load(id: session.id)
            #expect(secondSave?.messages.map(\.id) == firstSave?.messages.map(\.id))
            #expect(secondSave?.messages.map(\.createdAt) == firstSave?.messages.map(\.createdAt))

            // A genuinely new turn since the last persist gets a fresh id —
            // the fix must not freeze the array, only stabilize the part
            // that didn't change.
            t.result = .init(reply: "second answer", pendingTool: nil, tasks: nil,
                             continueNeeded: nil, usage: nil, mode: nil)
            await engine.runTurn("third question")
            engine.persistCurrentChat()
            let thirdSave = ChatSessionStore.load(id: session.id)
            #expect(thirdSave?.messages.map(\.content) ==
                    ["seeded turn", "second question", "first answer", "third question", "second answer"])
            // First three messages: same ids/createdAt as before, unchanged.
            #expect(Array((thirdSave?.messages ?? []).prefix(3)).map(\.id) ==
                    Array((secondSave?.messages ?? []).prefix(3)).map(\.id))
            #expect(Array((thirdSave?.messages ?? []).prefix(3)).map(\.createdAt) ==
                    Array((secondSave?.messages ?? []).prefix(3)).map(\.createdAt))
            // Last two: brand new ids, disjoint from everything seen so far.
            let priorIDs = Set((secondSave?.messages ?? []).map(\.id))
            let latestIDs = Set((thirdSave?.messages ?? []).suffix(2).map(\.id))
            #expect(latestIDs.isDisjoint(with: priorIDs))
            #expect(latestIDs.count == 2)
        }
    }

    @Test("deleteSession fires session-memory forget (injected closure)")
    func forgetMemory() async {
        await withTempStore {
            let (engine, _) = makeEngine()
            var forgotten: [String] = []
            engine.forgetSessionMemory = { id in forgotten.append(id) }

            let active = ChatSession(scope: Self.scope, title: "Active")
            ChatSessionStore.save(active)
            await settle()
            let bystander = ChatSession(scope: Self.scope, title: "Bystander")
            ChatSessionStore.save(bystander)
            engine.handleOnAppearSessions()
            #expect(engine.currentSessionIDString == bystander.id.uuidString)

            // A non-active chat still gets its session memory forgotten...
            await engine.deleteSession(active.id)
            // ...and because the forget is awaited (it used to be a detached
            // fire-and-forget Task), it has provably completed by the time
            // `deleteSession` returns — no polling/sleeping needed here.
            #expect(forgotten == [active.id.uuidString])
            #expect(engine.currentSessionIDString == bystander.id.uuidString)

            // ...as does the active chat, via the header-trash path.
            await engine.clearCurrentChat()
            #expect(forgotten == [active.id.uuidString, bystander.id.uuidString])
            #expect(engine.currentSessionIDString != bystander.id.uuidString)
            #expect(engine.messages.isEmpty)
        }
    }
}
