import Foundation
import Testing
@testable import LlmIdeMacLib

@MainActor
private final class FakeDecisionHost: ChatArchiveDecisionHosting {
    var items: [ChatArchiveAttentionItem]
    var outcome: ChatArchiveOutcome = .committed
    var gate: Gate?
    private(set) var accepted: [String] = []
    private(set) var dismissed: [String] = []
    init(_ items: [ChatArchiveAttentionItem]) { self.items = items }
    func attentionItems() async -> [ChatArchiveAttentionItem] { items }
    func acceptIncompleteArchive(_ id: String) async -> ChatArchiveOutcome {
        accepted.append(id)
        if let gate { await gate.wait() }
        if outcome == .committed { items.removeAll { $0.serverId == id } }
        return outcome
    }
    func dismissAttention(_ id: String) async { dismissed.append(id); items.removeAll { $0.serverId == id } }
}

private func incomplete(_ id: String, title: String = "Plan") -> ChatArchiveAttentionItem {
    .init(serverId: id, title: title, serverMessages: 40, macMessages: nil, reason: .incomplete(pruned: 12, truncated: 1))
}
private func conflict(_ id: String) -> ChatArchiveAttentionItem {
    .init(serverId: id, title: "", serverMessages: 6, macMessages: 4, reason: .conflict)
}

@MainActor
@Suite("Chat archive: attention list")
struct ChatArchiveAttentionModelTests {

    @Test func reload_lists_the_items() async {
        let model = ChatArchiveAttentionModel(host: FakeDecisionHost([incomplete("a"), conflict("b")]))
        await model.reload()
        #expect(model.items.map(\.serverId) == ["a", "b"])
    }

    @Test func archive_as_is_needs_a_confirmation_and_never_runs_without_it() async {
        let host = FakeDecisionHost([incomplete("a")])
        let model = ChatArchiveAttentionModel(host: host)
        await model.reload()
        model.requestArchiveAsIs("a")
        #expect(model.confirming?.serverId == "a" && host.accepted.isEmpty)
        model.cancelConfirm()
        await model.confirmArchiveAsIs()
        #expect(host.accepted.isEmpty, "cancelled: nothing archived")
        model.requestArchiveAsIs("a")
        await model.confirmArchiveAsIs()
        #expect(host.accepted == ["a"] && model.items.isEmpty && model.message == nil)
    }

    @Test func a_conflict_cannot_be_archived_as_is() async {
        let host = FakeDecisionHost([conflict("b")])
        let model = ChatArchiveAttentionModel(host: host)
        await model.reload()
        model.requestArchiveAsIs("b")
        #expect(model.confirming == nil)
        await model.keepOnServer("b")
        #expect(host.dismissed == ["b"] && model.items.isEmpty)
    }

    @Test func a_failure_keeps_the_row_and_says_why() async {
        let host = FakeDecisionHost([incomplete("a")])
        host.outcome = .failed("commit: down")
        let model = ChatArchiveAttentionModel(host: host)
        await model.reload()
        model.requestArchiveAsIs("a")
        await model.confirmArchiveAsIs()
        #expect(model.items.count == 1)
        #expect(model.message?.contains("still kept on the server") == true)
        #expect(model.busy.isEmpty)
    }

    @Test func signed_out_gets_its_own_message() async {
        let host = FakeDecisionHost([incomplete("a")])
        host.outcome = .failed("signed out")
        let model = ChatArchiveAttentionModel(host: host)
        await model.reload()
        model.requestArchiveAsIs("a")
        await model.confirmArchiveAsIs()
        #expect(model.message?.contains("Sign in") == true)
    }

    @Test func a_row_archived_meanwhile_drops_the_open_confirmation() async {
        let host = FakeDecisionHost([incomplete("a")])
        let model = ChatArchiveAttentionModel(host: host)
        await model.reload()
        model.requestArchiveAsIs("a")
        host.items = []
        await model.reload()
        #expect(model.confirming == nil && model.items.isEmpty)
    }

    @Test func a_second_tap_while_archiving_is_ignored() async {
        let host = FakeDecisionHost([incomplete("a")])
        let gate = Gate(); host.gate = gate
        let model = ChatArchiveAttentionModel(host: host)
        await model.reload()
        model.requestArchiveAsIs("a")
        let first = Task { await model.confirmArchiveAsIs() }
        for _ in 0..<10_000 where !model.busy.contains("a") { await Task.yield() }
        model.requestArchiveAsIs("a")                 // busy: refused
        #expect(model.confirming == nil)
        gate.open()
        await first.value
        #expect(host.accepted == ["a"])
    }

    @Test func wording_names_title_counts_and_reason() {
        #expect(ChatArchiveAttentionWording.displayTitle(conflict("b")) == "Untitled chat")
        #expect(ChatArchiveAttentionWording.counts(conflict("b")) == "6 messages on the server, 4 in the file on this Mac")
        #expect(ChatArchiveAttentionWording.counts(incomplete("a")) == "40 messages on the server")
        let r = ChatArchiveAttentionWording.reason(incomplete("a"))
        #expect(r.contains("12 older messages were dropped") && r.contains("1 long message was cut short"))
        #expect(ChatArchiveAttentionWording.confirmMessage.contains("cannot be recovered"))
    }

    @Test func service_lists_titles_and_counts_and_dismiss_removes_without_deleting() async {
        let rig = await ArchiveRig.make(); defer { rig.close() }
        let id = UUID()
        rig.remote.addExtensionChat(id, [("user", "a"), ("assistant", "b")])
        rig.remote.chats[id.uuidString]!.pruned = 5
        _ = await rig.service.archiveExtensionChat(id.uuidString)
        let items = await rig.service.attentionItems()
        #expect(items.count == 1 && items[0].serverMessages == 2 && items[0].canArchiveAsIs)
        #expect(items[0].reason == .incomplete(pruned: 5, truncated: 0))
        await rig.service.dismissAttention(id.uuidString)
        #expect(await rig.service.attentionItems().isEmpty)
        #expect(rig.remote.chats[id.uuidString] != nil, "dismiss keeps the server rows")
    }
}
