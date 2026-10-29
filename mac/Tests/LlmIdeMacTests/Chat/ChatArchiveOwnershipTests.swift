import Foundation
import Testing
@testable import LlmIdeMacLib

/// T4.4 sign-out and multi-user, T4.5 phone path, and the pure logic.
@MainActor
@Suite("Chat archive: ownership, sign-out, logic", .serialized)
struct ChatArchiveOwnershipTests {

    // MARK: pure logic (hash vectors computed by the server's archiveHash)

    @Test func hash_matches_the_server_for_known_vectors() {
        #expect(ChatArchiveLogic.archiveHash([]) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        #expect(ChatArchiveLogic.archiveHash([.init(role: "user", content: "héllo"),
                                              .init(role: "assistant", content: "wörld ✓ 日本語 😀")])
                == "b9275ae1740b03c21c3ee1c24cd702208869fe0f6112a981efc3f6e42829d168")
        #expect(ChatArchiveLogic.archiveHash([.init(role: "user", content: "a"), .init(role: "assistant", content: "")])
                == "677d1d2aba64cf75c7fea428dc1e619cc7ad69119e76d33e77fca4aa571487a6")
    }

    @Test func hash_has_no_ambiguity_between_message_splits() {
        let a = ChatArchiveLogic.archiveHash([.init(role: "user", content: "ab"), .init(role: "user", content: "c")])
        let b = ChatArchiveLogic.archiveHash([.init(role: "user", content: "a"), .init(role: "user", content: "bc")])
        #expect(a != b)
    }

    @Test func orphan_grace_and_idle_rules() {
        let now = Date()
        #expect(!ChatArchiveLogic.orphanIsDue(firstSeen: now, serverUpdatedAt: nil, now: now))
        #expect(ChatArchiveLogic.orphanIsDue(firstSeen: now.addingTimeInterval(-8 * 86400), serverUpdatedAt: nil, now: now))
        #expect(ChatArchiveLogic.orphanIsDue(firstSeen: now, serverUpdatedAt: now.addingTimeInterval(-8 * 86400), now: now))
        #expect(ChatArchiveLogic.isIdle(serverUpdatedAt: now.timeIntervalSince1970 - 1900, now: now))
        #expect(!ChatArchiveLogic.isIdle(serverUpdatedAt: now.timeIntervalSince1970 - 100, now: now))
        #expect(ChatArchiveLogic.parseServerTime("2026-10-29 10:00:00") != nil)
    }

    // MARK: ownership

    @Test func user_B_never_sees_user_A_chats_but_they_stay_on_disk() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        var current: String? = "user-A"
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { current })
        let mine = UUID()
        ChatSessionStore.save(ChatSession(id: mine, scope: .quick, title: "A's", messages: [], projectId: "p"))
        #expect(ChatSessionStore.load(id: mine)?.ownerUserId == "user-A", "stamped at save")
        #expect(ChatSessionStore.list(for: .quick).count == 1)
        current = "user-B"
        #expect(ChatSessionStore.list(for: .quick).isEmpty)
        #expect(ChatSessionStore.list(for: .quick, projectId: "p").isEmpty)
        #expect(ChatSessionStore.fileExists(id: mine), "nothing is wiped")
        current = "user-A"
        #expect(ChatSessionStore.list(for: .quick).count == 1)
    }

    @Test func shadow_stamps_but_does_not_filter() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatSessionStore.ownership = .init(stamp: true, filter: false, currentUserId: { "user-B" })
        let id = UUID()
        ChatSessionStore.save(ChatSession(id: id, scope: .quick, title: "x", ownerUserId: "user-A"))
        #expect(ChatSessionStore.list(for: .quick).count == 1)
    }

    @Test func mode_off_stamps_nothing_and_writes_no_sidecar() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        ChatSessionStore.save(ChatSession(id: id, scope: .quick, title: "x"))
        #expect(ChatSessionStore.load(id: id)?.ownerUserId == nil)
        #expect(!FileManager.default.fileExists(atPath: rig.dir.appendingPathComponent("chat-tags.json").path))
    }

    @Test func unowned_legacy_chats_are_claimed_so_the_next_user_cannot_adopt_them() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let legacy = UUID(); rig.macChat(legacy)
        var current: String? = "user-A"
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { current })
        #expect(ChatSessionStore.list(for: .quick).count == 1, "unowned is visible until claimed")
        #expect(ChatSessionStore.stampUnowned(owner: "user-A") == 1)
        current = "user-B"
        #expect(ChatSessionStore.list(for: .quick).isEmpty)
    }

    @Test func old_build_strips_the_tags_on_resave_and_the_sidecar_restores_them() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { "user-A" })
        let id = UUID()
        ChatSessionStore.save(ChatSession(id: id, scope: .quick, title: "x", projectId: "p", meetingId: "m-1", origin: "extension"))
        // An old build re-saves the file through its own model: the new keys are dropped.
        let url = rig.dir.appendingPathComponent("sessions/\(id.uuidString).json")
        var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        for k in ["ownerUserId", "meetingId", "origin", "archive"] { json.removeValue(forKey: k) }
        try JSONSerialization.data(withJSONObject: json).write(to: url)
        let back = try #require(ChatSessionStore.load(id: id))
        #expect(back.ownerUserId == "user-A" && back.meetingId == "m-1" && back.origin == "extension")
        ChatSessionStore.Tags.resetCache()          // and across a restart
        #expect(ChatSessionStore.load(id: id)?.ownerUserId == "user-A")
    }

    @Test func new_keys_decode_on_a_file_without_them_and_never_throw() throws {
        let json = #"{"storeVersion":2,"id":"\#(UUID().uuidString)","scope":"quick","title":"t","createdAt":0,"lastUsedAt":0,"messages":[]}"#
        let s = try AppJSON.decoder.decode(ChatSession.self, from: Data(json.utf8))
        #expect(s.ownerUserId == nil && s.meetingId == nil && s.origin == nil && s.archive == nil)
    }

    @Test func the_sidecar_is_outside_the_sessions_directory() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { "user-A" })
        ChatSessionStore.save(ChatSession(id: UUID(), scope: .quick, title: "x"))
        #expect(FileManager.default.fileExists(atPath: rig.dir.appendingPathComponent("chat-tags.json").path))
        let inSessions = (try? FileManager.default.contentsOfDirectory(atPath: rig.dir.appendingPathComponent("sessions").path)) ?? []
        #expect(!inSessions.contains("chat-tags.json"))
    }

    @Test func deleting_a_chat_drops_its_sidecar_entry() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { "user-A" })
        let id = UUID()
        ChatSessionStore.save(ChatSession(id: id, scope: .quick, title: "x"))
        ChatSessionStore.delete(id: id)
        #expect(ChatSessionStore.Tags.tag(for: id) == nil)
    }

    @Test func a_user_delete_calls_the_hook_but_the_service_cleanup_does_not() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        var seen: [UUID] = []
        ChatSessionStore.onUserDelete = { seen.append($0) }
        let a = UUID(), b = UUID()
        ChatSessionStore.delete(id: a)
        ChatSessionStore.deleteQuietly(id: b)
        #expect(seen == [a])
    }

    // MARK: sign-out (Q5)

    @Test func sign_out_with_the_server_down_keeps_every_file_in_on() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatArchiveHost.shared.installForTesting(mode: .on, service: rig.service)
        ChatArchiveHost.shared.setUserForTesting("user-A")
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { "user-A" })
        rig.remote.failures["workingState"] = 99
        let ids = (0..<3).map { _ in UUID() }
        for id in ids { rig.macChat(id) }
        let registry = ChatEngineRegistry()
        registry.resetForSignOut()
        for id in ids { #expect(ChatSessionStore.load(id: id)?.ownerUserId == "user-A") }
        #expect(rig.remote.calls.isEmpty, "sign-out makes no server call")
    }

    @Test func sign_out_still_wipes_in_off_and_shadow() async {
        for mode in [LiveThenArchiveMode.off, .shadow] {
            let rig = await ArchiveRig.make(); defer { rig.close() }
            if mode == .shadow { ChatArchiveHost.shared.installForTesting(mode: .shadow, service: rig.service) }
            let id = UUID(); rig.macChat(id)
            ChatEngineRegistry().resetForSignOut()
            #expect(!ChatSessionStore.fileExists(id: id), "\(mode): legacy behaviour is unchanged")
        }
    }

    @Test func the_next_user_gets_no_current_chat_pointer_from_the_previous_one() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatArchiveHost.shared.installForTesting(mode: .on, service: rig.service)
        UserDefaults.standard.set("some-id", forKey: "chat.current.quick")
        ChatEngineRegistry().resetForSignOut()
        #expect(UserDefaults.standard.string(forKey: "chat.current.quick") == nil)
    }

    @Test func user_A_signs_out_B_signs_in_A_chats_stay_hidden_then_return_for_A() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatArchiveHost.shared.installForTesting(mode: .on, service: rig.service)
        ChatArchiveHost.shared.setUserForTesting("user-A")
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { rig.knobs.user })
        rig.knobs.user = "user-A"
        let a = UUID(); rig.macChat(a)
        ChatSessionStore.stampUnowned(owner: "user-A")
        ChatEngineRegistry().resetForSignOut()
        rig.knobs.user = "user-B"
        #expect(ChatSessionStore.list(for: .quick).isEmpty)
        rig.knobs.user = "user-A"
        #expect(ChatSessionStore.list(for: .quick).count == 1)
    }

    // MARK: phone path (T4.5)

    @Test func the_registry_reports_phone_held_engines_as_held_and_running() async {
        let holder = FakeHolder()
        let registry = ChatEngineRegistry()
        registry.externalHolder = holder
        let id = UUID()
        let engine = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
        engine.loadSessionForBackgroundUse(id: id)   // no file: returns false, id unset
        #expect(registry.archiveFacts(for: id) == .init())
        holder.engine = engine
        engine.currentSessionIDString = id.uuidString
        engine.messages = [ChatMessage(role: .user, content: "hi", status: .done, createdAt: Date())]
        let f = registry.archiveFacts(for: id)
        #expect(f.held && f.messageCount == 1)
    }

    // MARK: engine cap for archived chats (DL12)

    @Test func continuing_an_archived_3000_message_chat_does_not_truncate_it_to_500() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        var big = ChatSession(id: id, scope: .quick, title: "big", projectId: "proj-1", origin: "extension")
        big.messages = (0..<3000).map { ChatMessage(role: $0 % 2 == 0 ? .user : .assistant, content: "m\($0)", status: .done, createdAt: Date()) }
        try? ChatSessionStore.saveOrThrow(big, touch: false)
        let engine = ChatEngine(scope: .quick, transport: ScriptedChatTransport())
        #expect(engine.loadSessionForBackgroundUse(id: id))
        engine.persistCurrentChat()
        #expect(ChatSessionStore.load(id: id)?.messages.count == 3000)
    }

    @Test func an_ordinary_chat_is_still_capped_at_500() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        ChatSessionStore.save(ChatSession(id: id, scope: .quick, title: "n", projectId: "proj-1"))
        let engine = ChatEngine(scope: .quick, transport: ScriptedChatTransport())
        #expect(engine.loadSessionForBackgroundUse(id: id))
        engine.messages = (0..<700).map { ChatMessage(role: .user, content: "m\($0)", status: .done, createdAt: Date()) }
        engine.persistCurrentChat()
        #expect(ChatSessionStore.load(id: id)?.messages.count == 500)
    }
}

@MainActor
private final class FakeHolder: ExternalEngineHolder {
    var engine: ChatEngine?
    func heldEngine(for sessionID: UUID) -> ChatEngine? {
        engine?.currentSessionIDString == sessionID.uuidString ? engine : nil
    }
    func releaseHeldEngine(for sessionID: UUID) {}
    func forgetAllHeldEngines() {}
    var heldEngines: [ChatEngine] { engine.map { [$0] } ?? [] }
}
