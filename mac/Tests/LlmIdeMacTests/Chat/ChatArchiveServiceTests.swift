import Foundation
import Testing
@testable import LlmIdeMacLib

/// T4.2: every row of the plan's crash table (3.4, C1-C16), with a failure injected at each step against a fake server and
/// a real temp chat store.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock(); private var n = 0
    func inc() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
}

@MainActor
@Suite("Chat archive: crash table", .serialized)
struct ChatArchiveServiceTests {

    private func extChat(_ n: Int = 4) -> [(String, String)] {
        (0..<n).map { ($0 % 2 == 0 ? "user" : "assistant", "message \($0) héllo ✓") }
    }

    // MARK: Mac chats (option B)

    @Test func off_mode_touches_nothing() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.knobs.mode = .off
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        let r = await rig.service.quit()
        #expect(r == ChatQuitReport())
        #expect(rig.remote.calls.isEmpty)
        #expect(await rig.service.sendTombstone(id) == .unreachable)
    }

    @Test func quit_verifies_then_receipts_then_purges() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); let s = rig.macChat(id, turns: 3); rig.remote.addWorking(id)
        let r = await rig.service.quit()
        #expect(r.purged == [id.uuidString])
        let hash = ChatArchiveLogic.archiveHash(ChatArchiveService.wire(s.messages))
        #expect(rig.remote.receipts[id.uuidString]?.hash == hash && rig.remote.receipts[id.uuidString]?.count == 6)
        #expect(rig.remote.workingIDs().isEmpty)
        #expect(ChatSessionStore.load(id: id)?.messages.count == 6, "the Mac file is untouched")
        // order: receipt before purge
        let calls = rig.remote.calls
        #expect(calls.firstIndex(of: "recordReceipt")! < calls.firstIndex(of: "purgeWorkingState")!)
    }

    @Test func shadow_records_receipt_but_never_purges() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.knobs.mode = .shadow
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        let r = await rig.service.quit()
        #expect(r.purged.isEmpty)
        #expect(rig.remote.callCount("purgeWorkingState") == 0)
        #expect(rig.remote.workingIDs() == [id.uuidString])
    }

    @Test func C1_killed_before_quit_hook_sweep_purges_working_state() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        let r = await rig.service.sweep()
        #expect(r.purged == [id.uuidString])
        #expect(ChatSessionStore.load(id: id) != nil)
    }

    @Test func C2_purge_call_fails_after_verify_working_state_stays_then_sweep_finishes() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        rig.remote.failures["purgeWorkingState"] = 1
        let q = await rig.service.quit()
        #expect(q.purged.isEmpty && !q.errors.isEmpty)
        #expect(rig.remote.workingIDs() == [id.uuidString], "nothing lost: working state is derivative")
        #expect(ChatSessionStore.load(id: id) != nil)
        let s = await rig.service.sweep()
        #expect(s.purged == [id.uuidString] && rig.remote.workingIDs().isEmpty)
    }

    @Test func C3_partial_purge_is_idempotent_on_the_next_pass() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let a = UUID(), b = UUID(); rig.macChat(a); rig.macChat(b)
        rig.remote.addWorking(a); rig.remote.addWorking(b)
        // The first call removes `a` and then fails for the batch (a crash between pieces).
        rig.remote.before["purgeWorkingState"] = { [remote = rig.remote] in
            remote.working.removeAll { $0.chatSessionId == a.uuidString }
            remote.before["purgeWorkingState"] = nil
            remote.failures["purgeWorkingState"] = 1
        }
        let q = await rig.service.quit()
        #expect(q.purged.isEmpty)
        let s = await rig.service.sweep()
        #expect(rig.remote.workingIDs().isEmpty && s.errors.isEmpty)
    }

    @Test func C4_the_quit_cap_cuts_the_work_and_the_sweep_completes_it() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let ids = (0..<6).map { _ in UUID() }
        for id in ids { rig.macChat(id); rig.remote.addWorking(id) }
        rig.remote.delays["recordReceipt"] = 30
        let service = rig.service!
        let started = Date()
        let report = await AppTerminationHooks.runAsync([
            .init(label: "chat archive", timeout: 6) { _ = await service.quit() }
        ], cap: 0.4)
        #expect(Date().timeIntervalSince(started) < 3)
        #expect(report.results.first?.outcome == .timedOut)
        #expect(rig.remote.workingIDs().count == 6, "a cut quit purges nothing it did not verify")
        rig.remote.delays["recordReceipt"] = nil
        let s = await rig.service.sweep()
        #expect(s.purged.count == 6 && rig.remote.workingIDs().isEmpty)
    }

    @Test func a_mismatch_never_purges() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        // file missing -> orphan (not purged inside the grace)
        let missing = UUID(); rig.remote.addWorking(missing)
        // file older than the server's last use of the chat
        let stale = UUID(); rig.macChat(stale, lastUsed: Date().addingTimeInterval(-3600)); rig.remote.addWorking(stale, updatedAt: Date())
        // engine has more messages than the file
        let behind = UUID(); rig.macChat(behind, turns: 1); rig.remote.addWorking(behind)
        rig.knobs.setEngine(behind, .init(held: true, running: false, messageCount: 9))
        // owned by somebody else
        let foreign = UUID(); rig.macChat(foreign, owner: "user-B"); rig.remote.addWorking(foreign)
        // empty file
        let empty = UUID(); rig.macChat(empty, turns: 0); rig.remote.addWorking(empty)
        // a turn is running
        let busy = UUID(); rig.macChat(busy); rig.remote.addWorking(busy)
        rig.knobs.setEngine(busy, .init(held: true, running: true, messageCount: 2))
        let r = await rig.service.quit()
        #expect(r.purged.isEmpty)
        #expect(rig.remote.callCount("purgeWorkingState") == 0)
        #expect(r.skipped[stale.uuidString] == "fileOlderThanServer")
        #expect(r.skipped[behind.uuidString] == "engineCountMismatch")
        #expect(r.skipped[foreign.uuidString] == "ownedByOtherUser")
        #expect(r.skipped[empty.uuidString] == "emptyFile")
        #expect(r.skipped[busy.uuidString] == "engineRunning")
        #expect(rig.remote.workingIDs().count == 6)
    }

    @Test func receipt_failure_for_one_chat_leaves_only_that_chat() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let a = UUID(), b = UUID(); rig.macChat(a); rig.macChat(b)
        rig.remote.addWorking(a); rig.remote.addWorking(b)
        rig.remote.failures["recordReceipt"] = 1
        let r = await rig.service.quit()
        #expect(r.purged.count == 1 && rig.remote.workingIDs().count == 1)
    }

    @Test func C13_phone_turn_in_flight_is_not_purged_at_quit_or_sweep() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        rig.knobs.setEngine(id, .init(held: true, running: true, messageCount: 2))
        _ = await rig.service.quit()
        _ = await rig.service.sweep()
        #expect(rig.remote.workingIDs() == [id.uuidString])
        // a held (idle) chat is left alone by the start sweep but verified and purged by the quit
        rig.knobs.setEngine(id, .init(held: true, running: false, messageCount: 4))
        _ = await rig.service.sweep()
        #expect(rig.remote.workingIDs() == [id.uuidString])
        let q = await rig.service.quit()
        #expect(q.purged == [id.uuidString])
    }

    @Test func engine_opened_between_verify_and_purge_is_not_purged_by_the_sweep() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        let k = rig.knobs
        rig.remote.before["recordReceipt"] = { k.setEngine(id, .init(held: true, running: false, messageCount: 4)) }
        let r = await rig.service.sweep()
        #expect(r.purged.isEmpty && r.skipped[id.uuidString] == "heldBeforePurge")
    }

    @Test func an_unreadable_extension_list_means_no_orphan_is_ever_acted_on() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let extId = UUID()
        rig.remote.addExtensionChat(extId, extChat())
        rig.remote.addWorking(extId, updatedAt: rig.knobs.now.addingTimeInterval(-30 * 24 * 3600))
        rig.remote.failures["serverChats"] = 99
        let r = await rig.service.archiveMacChats(inQuit: false)
        #expect(!r.errors.isEmpty && rig.remote.tombstones.isEmpty && rig.remote.chats[extId.uuidString] != nil)
    }

    // MARK: orphans (reverse sweep, 7-day grace)

    @Test func orphan_is_purged_only_after_the_grace_by_the_working_state_route_never_the_tombstone() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.storage.healthyOverride = true
        let id = UUID(); rig.remote.addWorking(id, updatedAt: rig.knobs.now)
        _ = await rig.service.sweep()
        #expect(rig.remote.orphanPurged.isEmpty)
        rig.knobs.now = rig.knobs.now.addingTimeInterval(8 * 24 * 3600)
        let r = await rig.service.sweep()
        #expect(rig.remote.orphanPurged == [id.uuidString] && r.purged == [id.uuidString])
        #expect(rig.remote.tombstones.isEmpty, "the full-delete tombstone route is never used for an orphan")
    }

    @Test func an_old_server_timestamp_does_not_shorten_the_grace() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.storage.healthyOverride = true
        let id = UUID(); rig.remote.addWorking(id, updatedAt: rig.knobs.now.addingTimeInterval(-90 * 24 * 3600))
        _ = await rig.service.sweep()
        #expect(rig.remote.orphanPurged.isEmpty, "first seen today: 7 days from today")
        rig.knobs.now = rig.knobs.now.addingTimeInterval(6 * 24 * 3600)
        _ = await rig.service.sweep()
        #expect(rig.remote.orphanPurged.isEmpty)
        rig.knobs.now = rig.knobs.now.addingTimeInterval(2 * 24 * 3600)
        _ = await rig.service.sweep()
        #expect(rig.remote.orphanPurged == [id.uuidString])
    }

    @Test func an_unhealthy_store_directory_purges_nothing_ever() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.storage.healthyOverride = false
        let id = UUID(); rig.remote.addWorking(id)
        rig.knobs.now = rig.knobs.now.addingTimeInterval(30 * 24 * 3600)
        _ = await rig.service.sweep()
        rig.knobs.now = rig.knobs.now.addingTimeInterval(30 * 24 * 3600)
        let r = await rig.service.sweep()
        #expect(rig.remote.orphanPurged.isEmpty && rig.remote.purgedWorkingState.isEmpty)
        #expect(r.completed == false, "a sweep that could not trust the store is not complete")
    }

    @Test func the_real_store_check_needs_an_existing_non_empty_directory() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let real = FileChatArchiveStorage()
        #expect(real.storeLooksHealthy() == false, "no sessions directory yet")
        rig.macChat(UUID())
        #expect(real.storeLooksHealthy() == true)
    }

    @Test func a_chat_with_server_rows_is_never_an_orphan_even_when_the_server_refuses_to_say_so() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.storage.healthyOverride = true
        let ext = UUID()
        rig.remote.chats[ext.uuidString] = .init(id: ext.uuidString, messages: [("user", "only copy")], surface: "mac")   // any surface
        rig.remote.addWorking(ext, updatedAt: rig.knobs.now.addingTimeInterval(-60 * 24 * 3600))
        rig.knobs.now = rig.knobs.now.addingTimeInterval(30 * 24 * 3600)
        _ = await rig.service.sweep(); _ = await rig.service.sweep()
        #expect(rig.remote.orphanPurged.isEmpty && rig.remote.chats[ext.uuidString] != nil)
    }

    @Test func the_server_skipping_an_orphan_is_not_counted_as_purged() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.storage.healthyOverride = true
        let id = UUID(); rig.remote.addWorking(id); rig.remote.purgeBusyIDs = [id.uuidString]
        rig.knobs.now = rig.knobs.now.addingTimeInterval(8 * 24 * 3600)
        _ = await rig.service.sweep()
        rig.knobs.now = rig.knobs.now.addingTimeInterval(8 * 24 * 3600)
        let r = await rig.service.sweep()
        #expect(r.purged.isEmpty && r.skipped[id.uuidString] == "orphanSkippedByServer")
    }

    @Test func orphan_in_shadow_is_never_purged() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.storage.healthyOverride = true
        rig.knobs.mode = .shadow
        let id = UUID(); rig.remote.addWorking(id, updatedAt: rig.knobs.now.addingTimeInterval(-30 * 24 * 3600))
        rig.knobs.now = rig.knobs.now.addingTimeInterval(30 * 24 * 3600)
        _ = await rig.service.sweep()
        #expect(rig.remote.orphanPurged.isEmpty)
    }

    // MARK: the server skips (busy / stale receipt) is "retry later", never success

    @Test func a_turn_that_started_after_the_recheck_is_reported_busy_by_the_server_and_not_counted_purged() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        rig.remote.purgeBusyIDs = [id.uuidString]
        let r = await rig.service.quit()
        #expect(r.purged.isEmpty && r.skipped[id.uuidString] == "serverBusy")
        #expect(rig.remote.workingIDs() == [id.uuidString])
        rig.remote.purgeBusyIDs = []
        #expect(await rig.service.sweep().purged == [id.uuidString])
    }

    @Test func a_stale_receipt_is_retry_later_too() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        rig.remote.purgeStaleIDs = [id.uuidString]
        let r = await rig.service.quit()
        #expect(r.purged.isEmpty && r.skipped[id.uuidString] == "staleReceipt")
        #expect(rig.remote.callCount("recordReceipt") == 1)
        rig.remote.purgeStaleIDs = []
        #expect(await rig.service.sweep().purged == [id.uuidString], "the next pass re-verifies the file and records a fresh receipt")
        #expect(rig.remote.callCount("recordReceipt") == 2)
    }

    // MARK: sweep scope and completion

    @Test func the_start_sweep_leaves_an_active_extension_chat_but_the_quit_archives_it() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let active = UUID(), idle = UUID()
        rig.remote.addExtensionChat(active, extChat(), updatedAt: Date().addingTimeInterval(-60))
        rig.remote.addExtensionChat(idle, extChat(), updatedAt: Date().addingTimeInterval(-3600))
        let s = await rig.service.sweep()
        #expect(s.archivedExtension[idle.uuidString] == .committed && s.archivedExtension[active.uuidString] == nil)
        #expect(rig.remote.chats[active.uuidString] != nil)
        let q = await rig.service.quit()
        #expect(q.archivedExtension[active.uuidString] == .committed)
    }

    @Test func a_sweep_that_cannot_reach_the_server_is_not_complete() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.remote.failures["workingState"] = 1
        #expect(await rig.service.sweep().completed == false)
        #expect(await rig.service.sweep().completed == true)
    }

    @Test func backoff_retries_until_the_backend_is_up_then_stops() async {
        let down = Counter()
        let slept = Counter()
        let tries = await ChatArchiveBackoff.run(delays: [5, 15, 45, 135, 300], sleep: { _ in slept.inc() }) {
            down.inc()
            return down.value >= 3                       // the backend comes up on the third attempt
        }
        #expect(tries == 3 && slept.value == 3)
        let never = await ChatArchiveBackoff.run(delays: [1, 2], sleep: { _ in }) { false }
        #expect(never == 2, "the schedule is bounded")
    }

    @Test func the_real_sweep_survives_a_backend_that_is_down_then_up() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        rig.remote.failures["workingState"] = 2
        let service = rig.service!
        let tries = await ChatArchiveBackoff.run(delays: [0, 0, 0, 0], sleep: { _ in }) { await service.sweep().completed }
        #expect(tries == 3 && rig.remote.workingIDs().isEmpty)
    }

    // MARK: conflicts and incomplete archives are surfaced

    @Test func conflicts_and_incomplete_archives_are_listed_for_the_settings_card() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let conflict = UUID(), incomplete = UUID()
        rig.remote.addExtensionChat(conflict, extChat()); rig.remote.addExtensionChat(incomplete, extChat())
        rig.remote.chats[incomplete.uuidString]!.pruned = 3
        _ = await rig.service.archiveExtensionChat(conflict.uuidString)           // committed, file exists
        rig.remote.addExtensionChat(conflict, extChat() + [("user", "different")])
        var f = try #require(ChatSessionStore.load(id: conflict))
        f.messages[0].content = "edited on the Mac"
        try ChatSessionStore.saveOrThrow(f, touch: false)
        _ = await rig.service.archiveExtensionChat(conflict.uuidString)
        _ = await rig.service.archiveExtensionChat(incomplete.uuidString)
        let a = await rig.service.attention()
        #expect(a[conflict.uuidString] == .conflictKept && a[incomplete.uuidString] != nil)
    }

    @Test func a_file_that_differs_but_is_not_a_prefix_is_a_conflict_never_overwritten() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat(4))
        rig.remote.failures["commitArchive"] = 1
        _ = await rig.service.archiveExtensionChat(id.uuidString)                 // file written, rows kept
        var f = try #require(ChatSessionStore.load(id: id))
        f.messages[1].content = "the user edited this on the Mac"
        try ChatSessionStore.saveOrThrow(f, touch: false)
        rig.remote.chats[id.uuidString]!.messages.append(("user", "more"))
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .conflictKept)
        #expect(ChatSessionStore.load(id: id)?.messages[1].content == "the user edited this on the Mac")
    }

    @Test func the_archive_file_is_flushed_to_disk_before_the_commit() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .committed)
        #expect(ChatSessionStore.fullSync(id: id), "F_FULLFSYNC (or fsync) of the file and its directory succeeds")
    }

    // MARK: tombstones are bound to their user

    @Test func a_delete_with_nobody_signed_in_records_nothing_and_an_ownerless_entry_is_never_sent() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.knobs.user = nil
        let id = UUID()
        rig.service.registerDeleteIntent(id)
        #expect(!rig.pending.containsDelete(id))
        rig.pending.addDelete(id: id, owner: nil)                     // an entry of unknown origin
        rig.knobs.user = "user-B"
        #expect(rig.pending.deletes(for: "user-B").isEmpty)
        #expect(await rig.service.sendTombstone(id) == .unreachable)
        #expect(rig.remote.tombstones.isEmpty)
    }

    @Test func the_tombstone_carries_the_original_delete_time_and_a_busy_answer_keeps_it_pending() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        rig.pending.addDelete(id: id, owner: "user-A", now: t0)
        rig.remote.tombstoneBusy = true
        #expect(await rig.service.sendTombstone(id) == .queued)
        #expect(rig.remote.tombstoneRequestedAt[id.uuidString] == t0)
        #expect(rig.pending.containsDelete(id))
    }

    // MARK: extension list paging

    @Test func the_pager_reads_every_page_and_refuses_a_server_that_ignores_the_offset() async throws {
        let all = (0..<450).map { "c\($0)" }
        let got = try await LlmIdeAPIClient.readAllPages(pageSize: 200, id: { $0 }) { offset in
            Array(all[offset..<min(offset + 200, all.count)])
        }
        #expect(got.count == 450 && Set(got).count == 450)
        let exact = try await LlmIdeAPIClient.readAllPages(pageSize: 200, id: { $0 }) { offset in
            Array(all[min(offset, 400)..<min(offset + 200, 400)])
        }
        #expect(exact.count == 400, "an exactly-full last page is followed by an empty one")
        await #expect(throws: URLError.self) {
            _ = try await LlmIdeAPIClient.readAllPages(pageSize: 200, id: { $0 }) { _ in Array(all[0..<200]) }
        }
    }

    // MARK: extension chats (option D)

    @Test func extension_chat_is_archived_paged_verified_and_committed() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.remote.pageSize = 2
        let id = UUID(); rig.remote.addExtensionChat(id, extChat(7))
        let out = await rig.service.archiveExtensionChat(id.uuidString)
        #expect(out == .committed)
        let f = try #require(ChatSessionStore.load(id: id))
        #expect(f.scope == .quick && f.origin == "extension" && f.ownerUserId == "user-A" && f.projectId == "proj-1")
        #expect(f.messages.count == 7 && f.archive?.count == 7)
        #expect(f.messages.map(\.content) == extChat(7).map(\.1))
        #expect(rig.remote.chats[id.uuidString] == nil, "server rows deleted only by the commit")
        #expect(rig.remote.callCount("beginArchive") == 4, "one first page + three continuation pages")
    }

    @Test func a_committed_extension_chat_also_loses_its_working_state() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat()); rig.remote.addWorking(id)
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .committed)
        #expect(rig.remote.workingIDs().isEmpty)
    }

    @Test func the_commit_carries_the_hash_of_the_FILE() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat(3))
        _ = await rig.service.archiveExtensionChat(id.uuidString)
        let f = ChatSessionStore.load(id: id)!
        #expect(rig.remote.receipts[id.uuidString]?.hash == ChatArchiveLogic.archiveHash(ChatArchiveService.wire(f.messages)))
    }

    @Test func C5_crash_after_begin_before_file_write_sweep_begins_again() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat(), updatedAt: Date().addingTimeInterval(-3600))
        _ = try? await rig.remote.beginArchive(chatSessionId: id.uuidString, after: nil, fence: nil)   // the crashed run
        #expect(rig.remote.chats[id.uuidString]?.lifecycle == "archiving" && !ChatSessionStore.fileExists(id: id))
        let r = await rig.service.sweep()
        #expect(r.archivedExtension[id.uuidString] == .committed && ChatSessionStore.load(id: id)?.messages.count == 4)
    }

    @Test func C6_file_written_commit_fails_rows_and_file_both_exist_then_sweep_commits() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat(), updatedAt: Date().addingTimeInterval(-3600))
        rig.remote.failures["commitArchive"] = 1
        let first = await rig.service.archiveExtensionChat(id.uuidString)
        if case .failed = first {} else { Issue.record("expected failed, got \(first)") }
        #expect(rig.remote.chats[id.uuidString] != nil && ChatSessionStore.fileExists(id: id))
        let writes = rig.storage.writes
        let r = await rig.service.sweep()
        #expect(r.archivedExtension[id.uuidString] == .committed)
        #expect(rig.storage.writes == writes, "the file already matched the server: it was not rewritten")
    }

    @Test func C6b_file_hash_differs_it_is_stale_so_the_next_run_overwrites_it() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat(4))
        rig.remote.failures["commitArchive"] = 1
        _ = await rig.service.archiveExtensionChat(id.uuidString)
        rig.remote.chats[id.uuidString]!.messages.append(("user", "one more from the extension"))
        let out = await rig.service.archiveExtensionChat(id.uuidString)
        #expect(out == .committed && ChatSessionStore.load(id: id)?.messages.count == 5)
    }

    @Test func an_append_racing_the_commit_is_stale_then_archived_on_the_retry() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        rig.remote.commitStaleTimes = 1
        let out = await rig.service.archiveExtensionChat(id.uuidString)
        #expect(out == .committed && rig.remote.callCount("commitArchive") == 2)
    }

    @Test func staying_stale_gives_up_with_rows_and_file_intact() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        rig.remote.commitStaleTimes = 99
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .staleGaveUp)
        #expect(rig.remote.chats[id.uuidString] != nil && ChatSessionStore.load(id: id)?.messages.count == 4)
    }

    @Test func C7_commit_succeeded_but_the_mac_never_heard_nothing_to_do() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        _ = await rig.service.archiveExtensionChat(id.uuidString)
        let again = await rig.service.archiveExtensionChat(id.uuidString)
        #expect(again == .goneOnServer && ChatSessionStore.load(id: id)?.messages.count == 4)
        #expect(await rig.service.sweep().archivedExtension.isEmpty)
    }

    @Test func C8_server_db_lost_the_sweep_touches_no_mac_file() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let a = UUID(); rig.macChat(a)
        _ = await rig.service.sweep()
        #expect(ChatSessionStore.load(id: a)?.messages.count == 4)
    }

    @Test func C9_disk_full_nothing_is_committed_and_rows_stay() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat(), updatedAt: Date().addingTimeInterval(-3600))
        rig.storage.failWrites = true
        let out = await rig.service.archiveExtensionChat(id.uuidString)
        if case .failed(let why) = out { #expect(why.contains("write")) } else { Issue.record("expected failed") }
        #expect(rig.remote.callCount("commitArchive") == 0 && rig.remote.chats[id.uuidString] != nil)
        rig.storage.failWrites = false
        #expect(await rig.service.sweep().archivedExtension[id.uuidString] == .committed)
    }

    @Test func C11_two_windows_the_same_chat_is_archived_once() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        rig.remote.delays["beginArchive"] = 0.3
        let service = rig.service!
        async let a = service.archiveExtensionChat(id.uuidString)
        async let b = service.archiveExtensionChat(id.uuidString)
        let results = await [a, b]
        #expect(results.contains(.committed) && results.contains(.skippedBusy))
    }

    @Test func C12_sign_out_mid_archive_aborts_before_the_commit() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        let service = rig.service!
        rig.remote.before["beginArchive"] = { Task { await service.signedOut() } ; Thread.sleep(forTimeInterval: 0.1) }
        let out = await service.archiveExtensionChat(id.uuidString)
        #expect(out == .userChanged && rig.remote.callCount("commitArchive") == 0)
        #expect(rig.remote.chats[id.uuidString] != nil)
    }

    @Test func account_switch_mid_archive_aborts_too() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        let k = rig.knobs
        rig.remote.before["beginArchive"] = { k.user = "user-B" }
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .userChanged)
        #expect(rig.remote.callCount("commitArchive") == 0)
    }

    @Test func C14_idle_archive_takes_only_chats_idle_for_30_minutes() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let idle = UUID(), fresh = UUID()
        rig.remote.addExtensionChat(idle, extChat(), updatedAt: Date().addingTimeInterval(-31 * 60))
        rig.remote.addExtensionChat(fresh, extChat(), updatedAt: Date().addingTimeInterval(-5 * 60))
        let r = await rig.service.idleArchive()
        #expect(r[idle.uuidString] == .committed && r[fresh.uuidString] == nil)
        #expect(rig.remote.chats[fresh.uuidString] != nil)
    }

    @Test func C15_restored_db_resurrects_an_archived_chat_the_file_is_not_rewritten() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        _ = await rig.service.archiveExtensionChat(id.uuidString)
        let before = rig.storage.writes
        rig.remote.addExtensionChat(id, extChat())               // the restore
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .committed)
        #expect(rig.storage.writes == before)
    }

    @Test func C15b_a_file_the_user_continued_is_never_overwritten() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        _ = await rig.service.archiveExtensionChat(id.uuidString)
        var f = try #require(ChatSessionStore.load(id: id))
        f.messages.append(ChatMessage(role: .user, content: "continued on the Mac", status: .done, createdAt: Date()))
        try ChatSessionStore.saveOrThrow(f, touch: false)
        rig.remote.addExtensionChat(id, extChat())               // restored rows
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .conflictKept)
        #expect(ChatSessionStore.load(id: id)?.messages.count == 5 && rig.remote.chats[id.uuidString] != nil)
    }

    @Test func an_unreadable_file_with_the_same_id_is_never_overwritten() async throws {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        let dir = rig.dir.appendingPathComponent("sessions", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "{not json".write(to: dir.appendingPathComponent("\(id.uuidString).json"), atomically: true, encoding: .utf8)
        // load() quarantines the unreadable file (existing behaviour); the archive then sees no file and writes a fresh one,
        // while the original bytes stay in the .corrupt copy.
        let out = await rig.service.archiveExtensionChat(id.uuidString)
        #expect(out == .conflictKept || out == .committed)
        let corrupt = (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.contains { $0.contains("corrupt") } ?? false
        #expect(corrupt)
    }

    @Test func incomplete_archive_keeps_the_rows_until_the_user_accepts() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        rig.remote.chats[id.uuidString]!.pruned = 12
        let out = await rig.service.archiveExtensionChat(id.uuidString)
        #expect(out == .incomplete(pruned: 12, truncated: 0))
        #expect(rig.remote.callCount("commitArchive") == 0 && rig.remote.chats[id.uuidString] != nil)
        #expect(await rig.service.needsDecision[id.uuidString] != nil)
        #expect(await rig.service.acceptIncomplete(id.uuidString) == .committed)
        #expect(await rig.service.needsDecision[id.uuidString] == nil)
    }

    @Test func a_system_message_cannot_be_stored_so_the_chat_is_not_archived() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, [("user", "a"), ("system", "b")])
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .unsupportedRole)
        #expect(rig.remote.chats[id.uuidString] != nil && !ChatSessionStore.fileExists(id: id))
    }

    @Test func shadow_writes_the_file_but_never_commits() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.knobs.mode = .shadow
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .shadowWritten)
        #expect(rig.remote.callCount("commitArchive") == 0 && rig.remote.chats[id.uuidString] != nil)
        #expect(ChatSessionStore.load(id: id)?.messages.count == 4)
    }

    @Test func a_3000_message_chat_is_archived_whole() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        rig.remote.pageSize = 500
        let id = UUID(); rig.remote.addExtensionChat(id, extChat(3000))
        let t = Date()
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .committed)
        #expect(ChatSessionStore.load(id: id)?.messages.count == 3000)
        #expect(Date().timeIntervalSince(t) < 20)
    }

    @Test func an_unknown_server_id_is_not_a_uuid_and_is_skipped() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        #expect(await rig.service.archiveExtensionChat("not-a-uuid") == .invalidId)
    }

    // MARK: delete everywhere (T4.3)

    @Test func delete_writes_the_intent_then_the_tombstone_and_clears_it_on_done() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addWorking(id)
        rig.service.registerDeleteIntent(id)
        #expect(rig.pending.containsDelete(id))
        #expect(await rig.service.sendTombstone(id) == .done)
        #expect(!rig.pending.containsDelete(id) && rig.remote.tombstones == [id.uuidString])
    }

    @Test func C10_server_down_during_delete_the_entry_survives_and_a_restart_replays_it() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addWorking(id)
        rig.remote.failures["requestSessionPurge"] = 1
        rig.service.registerDeleteIntent(id)
        #expect(await rig.service.sendTombstone(id) == .unreachable)
        #expect(rig.pending.containsDelete(id))
        // "restart": a new service over the same files
        let again = rig.makeService()
        let r = await again.sweep()
        #expect(!rig.pending.containsDelete(id) && rig.remote.workingIDs().isEmpty)
        _ = r
    }

    @Test func a_queued_answer_keeps_the_local_entry_for_the_next_start() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        rig.remote.purgeAnswer = "pending"
        rig.service.registerDeleteIntent(id)
        #expect(await rig.service.sendTombstone(id) == .queued)
        #expect(rig.pending.containsDelete(id))
        rig.remote.purgeAnswer = "done"
        _ = await rig.service.replayPendingDeletes()
        #expect(!rig.pending.containsDelete(id))
    }

    @Test func double_delete_is_one_entry_and_one_effect() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        rig.service.registerDeleteIntent(id); rig.service.registerDeleteIntent(id)
        #expect(rig.pending.deletes(for: "user-A").count == 1)
        #expect(await rig.service.sendTombstone(id) == .done)
        rig.service.registerDeleteIntent(id)                       // a second delete of the same id (the UI path records it again)
        #expect(await rig.service.sendTombstone(id) == .done)
        #expect(rig.pending.deletes(for: "user-A").isEmpty)
    }

    @Test func delete_during_archive_the_chat_is_not_resurrected_and_not_committed_back() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        let service = rig.service!
        rig.remote.before["commitArchive"] = { service.registerDeleteIntent(id) }
        let out = await service.archiveExtensionChat(id.uuidString)
        // the delete intent landed just before the commit: the result honours it
        #expect(out == .committed || out == .deletedByUser)
        #expect(!ChatSessionStore.fileExists(id: id), "the file the user deleted does not come back")
    }

    @Test func delete_intent_before_archive_starts_skips_it() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.remote.addExtensionChat(id, extChat())
        rig.service.registerDeleteIntent(id)
        #expect(await rig.service.archiveExtensionChat(id.uuidString) == .deletedByUser)
        #expect(rig.remote.callCount("beginArchive") == 0)
    }

    @Test func a_resurrected_file_with_a_pending_delete_is_removed_again() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.macChat(id)
        rig.service.registerDeleteIntent(id)
        _ = await rig.service.replayPendingDeletes()
        #expect(!ChatSessionStore.fileExists(id: id))
    }

    @Test func a_pending_delete_keeps_its_working_state_out_of_the_receipt_path() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID(); rig.macChat(id); rig.remote.addWorking(id)
        rig.pending.addDelete(id: id, owner: "user-A")
        let r = await rig.service.archiveMacChats(inQuit: true)
        #expect(r.skipped[id.uuidString] == "deletePending" && rig.remote.callCount("recordReceipt") == 0)
    }

    @Test func other_users_tombstones_are_not_replayed() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        rig.pending.addDelete(id: id, owner: "user-B")
        _ = await rig.service.replayPendingDeletes()
        #expect(rig.remote.tombstones.isEmpty && rig.pending.containsDelete(id))
    }
}
