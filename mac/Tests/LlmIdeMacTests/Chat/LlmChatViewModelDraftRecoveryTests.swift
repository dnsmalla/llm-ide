import Testing
import Foundation
@testable import LlmIdeMacLib

/// `LlmChatViewModel.recoverableDraftAfterFailure` — the `.quick` engine is
/// shared by the menu-bar chat, the sheet and the phone, and every failed
/// turn used to restore its prompt into BOTH quick composers: a failed phone
/// turn overwrote whatever the Mac user was typing with the phone's prompt.
@MainActor
@Suite("LlmChatViewModel draft recovery", .serialized)
struct LlmChatViewModelDraftRecoveryTests {
    func withTempStore(_ body: () async -> Void) async {
        await ChatStoreOverrideGate.shared.acquire()
        defer { ChatStoreOverrideGate.shared.release() }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("quick-draft-recovery-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        ChatSessionStore.baseDirectoryOverride = tmp
        await body()
        ChatSessionStore.baseDirectoryOverride = nil
        try? FileManager.default.removeItem(at: tmp)
    }

    private func failedTurn(_ prompt: String) -> (old: [ChatMessage], new: [ChatMessage]) {
        let user = ChatMessage(role: .user, content: prompt, status: .done, createdAt: Date())
        let streaming = ChatMessage(role: .assistant, content: "", status: .streaming, createdAt: Date())
        var failed = streaming
        failed.status = .failed
        return ([user, streaming], [user, failed])
    }

    @Test("A turn this composer sent comes back into an empty composer, once")
    func restoresOwnPrompt() async {
        await withTempStore {
            let vm = LlmChatViewModel(engine: ChatEngine(scope: .quick, transport: ScriptedChatTransport()))
            vm.send("my question")
            vm.stop()
            let turn = failedTurn("my question")
            #expect(vm.recoverableDraftAfterFailure(oldValue: turn.old, newValue: turn.new) == "my question")
            #expect(vm.pendingPrompt == nil)
            // A later failure of someone else's turn no longer matches.
            let other = failedTurn("my question")
            #expect(vm.recoverableDraftAfterFailure(oldValue: other.old, newValue: other.new) == nil)
        }
    }

    @Test("A failed phone turn (never sent from this composer) restores nothing")
    func ignoresPhonePrompt() async {
        await withTempStore {
            let vm = LlmChatViewModel(engine: ChatEngine(scope: .quick, transport: ScriptedChatTransport()))
            let turn = failedTurn("sent from the iPhone")
            #expect(vm.recoverableDraftAfterFailure(oldValue: turn.old, newValue: turn.new,
                                                    currentDraft: "half-typed on the Mac") == nil)
            #expect(vm.recoverableDraftAfterFailure(oldValue: turn.old, newValue: turn.new) == nil)
        }
    }

    @Test("A turn that finished is forgotten, so a later same-text failure from elsewhere restores nothing")
    func finishedTurnForgotten() async {
        await withTempStore {
            let vm = LlmChatViewModel(engine: ChatEngine(scope: .quick, transport: ScriptedChatTransport()))
            vm.send("yes")
            vm.stop()
            let user = ChatMessage(role: .user, content: "yes", status: .done, createdAt: Date())
            let streaming = ChatMessage(role: .assistant, content: "", status: .streaming, createdAt: Date())
            var done = streaming
            done.status = .done
            #expect(vm.recoverableDraftAfterFailure(oldValue: [user, streaming], newValue: [user, done]) == nil)
            #expect(vm.pendingPrompt == nil)
            let phone = failedTurn("yes")
            #expect(vm.recoverableDraftAfterFailure(oldValue: phone.old, newValue: phone.new) == nil)
        }
    }

    @Test("Own prompt is not restored over text typed since")
    func keepsNewDraft() async {
        await withTempStore {
            let vm = LlmChatViewModel(engine: ChatEngine(scope: .quick, transport: ScriptedChatTransport()))
            vm.send("first")
            vm.stop()
            let turn = failedTurn("first")
            #expect(vm.recoverableDraftAfterFailure(oldValue: turn.old, newValue: turn.new,
                                                    currentDraft: "something newer") == nil)
        }
    }
}
