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
        #expect(!ChatArchiveLogic.orphanIsDue(firstSeen: now, now: now))
        #expect(ChatArchiveLogic.orphanIsDue(firstSeen: now.addingTimeInterval(-8 * 86400), now: now))
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

    @Test func mode_off_stamps_nothing_and_writes_no_sidecar() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        ChatSessionStore.save(ChatSession(id: id, scope: .quick, title: "x"))
        #expect(ChatSessionStore.load(id: id)?.ownerUserId == nil)
        #expect(!FileManager.default.fileExists(atPath: rig.dir.appendingPathComponent("chat-tags.json").path))
    }

    @Test func older_chats_stay_visible_to_everyone_until_the_user_claims_them_explicitly() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let legacy = UUID(); rig.macChat(legacy)
        var current: String? = "user-A"
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { current })
        #expect(ChatSessionStore.unownedCount() == 1)
        #expect(ChatSessionStore.list(for: .quick).count == 1)
        current = "user-B"
        #expect(ChatSessionStore.list(for: .quick).count == 1, "no silent claim: nothing hides an older chat from B")
        #expect(ChatSessionStore.load(id: legacy) != nil)
        // an ordinary save of the older chat does not claim it either
        var s = try! #require(ChatSessionStore.load(id: legacy)); s.title = "renamed"
        ChatSessionStore.save(s)
        #expect(ChatSessionStore.unownedCount() == 1)
        // the explicit action
        #expect(ChatSessionStore.claimUnowned(owner: "user-B") == 1)
        #expect(ChatSessionStore.unownedCount() == 0)
        current = "user-A"
        #expect(ChatSessionStore.list(for: .quick).isEmpty && ChatSessionStore.load(id: legacy) == nil)
    }

    @Test func claiming_patches_the_raw_json_and_keeps_every_other_byte_even_for_a_file_this_build_cannot_fully_read() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        let dir = rig.dir.appendingPathComponent("sessions", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let raw = """
        {"storeVersion":2,"id":"\(id.uuidString)","scope":"quick","title":"old","createdAt":0,"lastUsedAt":0,"projectId":"p",
         "futureKey":{"a":[1,2,3]},
         "messages":[{"id":"\(UUID().uuidString)","role":"user","content":"hi","status":"streaming","createdAt":0},
                     {"role":"hologram","content":"a message kind this build does not know","extra":true}]}
        """
        let url = dir.appendingPathComponent("\(id.uuidString).json")
        try raw.write(to: url, atomically: true, encoding: .utf8)
        let before = try Data(contentsOf: url)
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { "user-A" })
        #expect(ChatSessionStore.claimUnowned(owner: "user-A") == 1)
        let after = try Data(contentsOf: url)
        // the file is the original with exactly one key inserted after the opening brace
        let inserted = Data("\"ownerUserId\":\"user-A\",".utf8)
        let brace = before.firstIndex(of: UInt8(ascii: "{"))!
        var expected = Data(before[...brace]); expected.append(inserted); expected.append(before[before.index(after: brace)...])
        #expect(after == expected)
        let obj = try #require(JSONSerialization.jsonObject(with: after) as? [String: Any])
        let msgs = try #require(obj["messages"] as? [[String: Any]])
        #expect(msgs.count == 2 && msgs[0]["status"] as? String == "streaming" && msgs[1]["role"] as? String == "hologram")
        #expect((obj["futureKey"] as? [String: Any]) != nil)
    }

    @Test func the_claim_refuses_a_file_that_is_not_a_json_object_or_already_has_an_owner() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let dir = rig.dir.appendingPathComponent("sessions", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let a = dir.appendingPathComponent("\(UUID().uuidString).json")
        try "[1,2,3]".write(to: a, atomically: true, encoding: .utf8)
        let b = dir.appendingPathComponent("\(UUID().uuidString).json")
        try #"{"ownerUserId":"someone"}"#.write(to: b, atomically: true, encoding: .utf8)
        #expect(!ChatSessionStore.patchOwner(a, owner: "u"))
        #expect(!ChatSessionStore.patchOwner(b, owner: "u"))
        #expect(try String(contentsOf: a, encoding: .utf8) == "[1,2,3]")
        #expect(try String(contentsOf: b, encoding: .utf8) == #"{"ownerUserId":"someone"}"#)
        // an owner name with characters that need escaping still produces valid JSON
        let c = dir.appendingPathComponent("\(UUID().uuidString).json")
        try #"{"x":1}"#.write(to: c, atomically: true, encoding: .utf8)
        #expect(ChatSessionStore.patchOwner(c, owner: "a\"b\\c"))
        let obj = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: c)) as? [String: Any])
        #expect(obj["ownerUserId"] as? String == "a\"b\\c" && obj["x"] as? Int == 1)
    }

    @Test func another_users_file_is_not_loadable_and_a_save_cannot_overwrite_it() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        var current: String? = "user-A"
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { current })
        let id = UUID()
        ChatSessionStore.save(ChatSession(id: id, scope: .quick, title: "A's secret", projectId: "p"))
        current = "user-B"
        #expect(ChatSessionStore.load(id: id) == nil)
        ChatSessionStore.save(ChatSession(id: id, scope: .quick, title: "B overwrites", projectId: "p"))
        current = "user-A"
        #expect(ChatSessionStore.load(id: id)?.title == "A's secret", "the foreign save was refused")
    }

    @Test func the_phone_bridge_and_the_registry_get_the_owner_rule_from_load() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        var current: String? = "user-A"
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { current })
        let id = UUID()
        ChatSessionStore.save(ChatSession(id: id, scope: .explorer, title: "A", projectId: "p"))
        current = "user-B"
        let engine = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
        #expect(engine.loadSessionForBackgroundUse(id: id) == false)
    }

    @Test func before_the_session_is_restored_nothing_is_hidden_and_lists_follow_the_sign_in() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        var current: String? = "user-A"
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { current })
        ChatSessionStore.save(ChatSession(id: UUID(), scope: .quick, title: "A", projectId: "p"))
        current = nil                                   // app start: nobody known yet
        #expect(ChatSessionStore.list(for: .quick).count == 1, "an empty list at startup would stay empty until reloaded")
        current = "user-A"
        #expect(ChatSessionStore.list(for: .quick).count == 1)
        current = "user-B"
        #expect(ChatSessionStore.list(for: .quick).isEmpty)
    }

    @Test func the_settings_status_counts_unowned_chats_and_claiming_needs_a_signed_in_user() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatArchiveHost.shared.installForTesting(mode: .shadow, service: rig.service)
        rig.macChat(UUID()); rig.macChat(UUID())
        ChatArchiveHost.shared.setUserForTesting(nil)
        #expect(await ChatArchiveHost.shared.claimOlderChats() == 0)
        ChatArchiveHost.shared.setUserForTesting("user-A")
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { "user-A" })
        #expect(await ChatArchiveHost.shared.status().unowned == 2)
        #expect(await ChatArchiveHost.shared.claimOlderChats() == 2)
        #expect(await ChatArchiveHost.shared.status().unowned == 0)
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

    @Test func the_sidecar_mirrors_the_archive_digest_and_restores_it_after_an_old_build_strips_it() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { "user-A" })
        let id = UUID()
        ChatSessionStore.save(ChatSession(id: id, scope: .quick, title: "x", projectId: "p", origin: "extension",
                                          archive: .init(hash: String(repeating: "a", count: 64), count: 7)))
        let url = rig.dir.appendingPathComponent("sessions/\(id.uuidString).json")
        var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        for k in ["ownerUserId", "origin", "archive"] { json.removeValue(forKey: k) }
        try JSONSerialization.data(withJSONObject: json).write(to: url)
        let back = try #require(ChatSessionStore.load(id: id))
        #expect(back.archive == .init(hash: String(repeating: "a", count: 64), count: 7) && back.origin == "extension")
    }

    @Test func stale_sidecar_entries_are_pruned_when_their_file_is_gone() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatSessionStore.ownership = .init(stamp: true, filter: true, currentUserId: { "user-A" })
        let keep = UUID(), gone = UUID()
        ChatSessionStore.save(ChatSession(id: keep, scope: .quick, title: "k", projectId: "p"))
        ChatSessionStore.save(ChatSession(id: gone, scope: .quick, title: "g", projectId: "p"))
        try FileManager.default.removeItem(at: rig.dir.appendingPathComponent("sessions/\(gone.uuidString).json"))
        #expect(ChatSessionStore.Tags.tag(for: gone) != nil)
        ChatSessionStore.pruneStaleTags()
        #expect(ChatSessionStore.Tags.tag(for: gone) == nil && ChatSessionStore.Tags.tag(for: keep) != nil)
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

    @Test func sign_out_in_shadow_keeps_every_file_because_shadow_never_deletes() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        ChatArchiveHost.shared.installForTesting(mode: .shadow, service: rig.service)
        let id = UUID(); rig.macChat(id)
        ChatEngineRegistry().resetForSignOut()
        #expect(ChatSessionStore.fileExists(id: id))
    }

    @Test func sign_out_in_off_wipes_ordinary_chats_but_never_a_chat_that_exists_nowhere_else() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let plain = UUID(), archived = UUID(), stamped = UUID()
        rig.macChat(plain)
        try? ChatSessionStore.saveOrThrow(ChatSession(id: archived, scope: .quick, title: "ext", projectId: "p", origin: "extension"), touch: false)
        try? ChatSessionStore.saveOrThrow(ChatSession(id: stamped, scope: .quick, title: "arch", projectId: "p",
                                                      archive: .init(hash: String(repeating: "b", count: 64), count: 1)), touch: false)
        ChatEngineRegistry().resetForSignOut()
        #expect(!ChatSessionStore.fileExists(id: plain), "legacy behaviour for an ordinary chat")
        #expect(ChatSessionStore.fileExists(id: archived) && ChatSessionStore.fileExists(id: stamped))
    }

    @Test func off_after_on_keeps_archived_files_and_still_hides_them_from_another_user() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        try? ChatSessionStore.saveOrThrow(ChatSession(id: id, scope: .quick, title: "ext", projectId: "p", ownerUserId: "user-A", origin: "extension"), touch: false)
        ChatSessionStore.ownership = .init(stamp: false, filter: true, currentUserId: { "user-B" })   // what install(mode: .off) sets
        #expect(ChatSessionStore.list(for: .quick).isEmpty)
        #expect(ChatSessionStore.fileExists(id: id))
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
