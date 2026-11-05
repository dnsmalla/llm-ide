import Testing
import Foundation
import SharedProtocol

@Suite("HostApiReadGate + HostApiReadMapping")
struct HostApiReadMappingTests {
    @Test("the gate is on only for v1 with read granted; never optimistic, never on v2")
    func gate() {
        #expect(HostApiReadGate.isOn(apiVersion: 1, capabilities: ["host", "chat", "read"]))
        #expect(!HostApiReadGate.isOn(apiVersion: 1, capabilities: ["host", "chat"]))
        #expect(!HostApiReadGate.isOn(apiVersion: 1, capabilities: nil))
        #expect(!HostApiReadGate.isOn(apiVersion: 2, capabilities: ["read", "usage"]))
        #expect(!HostApiReadGate.isOn(apiVersion: 2, capabilities: nil))
    }

    typealias Model = HostApiUsageGetResultProvidersItemModelsItem

    @Test("one provider: label wins, capped and uncapped detail, ms → s reset, no permission mode")
    func oneProvider() {
        let r = HostApiUsageGetResult(providers: [.init(activeModel: "claude-sonnet", models: [
            Model(label: "Sonnet", limit: 100, model: "claude-sonnet", pct: 42, resetAt: 1_700_000_000_000,
                  state: "ok", unit: "runs", used: 42, window: "daily"),
            Model(limit: 0, model: "claude-haiku", resetAt: 0, state: "ok", unit: "tokens", used: 900, window: "monthly"),
        ], provider: "claude", status: "ok")])
        let s = HostApiReadMapping.usageState(r)
        #expect(s.provider == "claude")
        #expect(s.status == "ok")
        #expect(s.activeModel == "claude-sonnet")
        #expect(s.permissionMode == "")
        #expect(s.subscription.isEmpty && s.subscriptionNote == nil && s.error == nil && s.statusReason == nil)
        #expect(s.models == [
            UsageMeter(name: "Sonnet", pct: 42, state: "ok", detail: "42 of 100 runs · Daily", resetsAt: 1_700_000_000),
            UsageMeter(name: "claude-haiku", pct: nil, state: "ok", detail: "900 tokens · Monthly, no cap", resetsAt: nil),
        ])
    }

    @Test("several providers: names are prefixed, the first non-ok status wins, empty stays empty")
    func severalProviders() {
        let m = Model(limit: 10, model: "m", resetAt: 0, state: "exhausted", unit: "runs", used: 10, window: "daily")
        let r = HostApiUsageGetResult(providers: [
            .init(models: [m], provider: "claude", status: "ok"),
            .init(models: [m], provider: "openai", status: "paused"),
        ])
        let s = HostApiReadMapping.usageState(r)
        #expect(s.provider == "claude, openai")
        #expect(s.status == "paused")
        #expect(s.models.map(\.name) == ["claude · m", "openai · m"])
        let empty = HostApiReadMapping.usageState(HostApiUsageGetResult(providers: []))
        #expect(empty.provider == nil && empty.status == nil && empty.models.isEmpty)
    }
}

/// A host whose replies the test releases one by one, so ordering races can be scripted.
@MainActor
final class FakeReadHost: HostConnection {
    var apiVersion = 1
    var state: HostConnectionState = .connected
    var capabilities: Set<String> = ["host", "chat", "read"]
    var onEvent: ((HostEvent) -> Void)?
    private(set) var calls: [(command: HostApiCommand, payload: Data)] = []
    private var waiting: [CheckedContinuation<Data, Error>] = []

    func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data {
        calls.append((command, payload))
        return try await withCheckedThrowingContinuation { waiting.append($0) }
    }
    func close() {}
    func answer<R: Encodable>(_ i: Int, _ result: R) { waiting[i].resume(returning: try! JSONEncoder().encode(result)) }
    func fail(_ i: Int, _ message: String) {
        waiting[i].resume(throwing: HostApiRejection(replyTo: nil, code: "not_found", message: message))
    }
    func waitForCalls(_ n: Int) async { for _ in 0..<1000 where calls.count < n { await Task.yield() } }
    func payload<P: Decodable>(_ i: Int, as: P.Type) -> P { try! JSONDecoder().decode(P.self, from: calls[i].payload) }
}

@MainActor
@Suite("HostApiReadController")
struct HostApiReadControllerTests {
    let host = FakeReadHost()
    func controller() -> HostApiReadController { HostApiReadController(host: { [host] in host }) }
    func sessions(_ r: Range<Int>) -> [HostApiChatSessionsResultSessionsItem] {
        r.map { .init(id: "s\($0)", title: "Chat \($0)", updatedAt: $0) }
    }
    func lines(_ r: ClosedRange<Int>) -> [HostApiChatHistoryResultMessagesItem] {
        r.map { .init(content: "m\($0)", role: $0 % 2 == 0 ? "assistant" : "user", seq: $0) }
    }
    func loaded(_ c: HostApiReadController, first: Range<Int>, next: Int?) async {
        let t = Task { await c.refresh() }
        await host.waitForCalls(host.calls.count + 1)
        host.answer(host.calls.count - 1, HostApiChatSessionsResult(nextOffset: next, sessions: sessions(first)))
        await t.value
    }

    @Test("sends nothing without a host, on v2, or without read")
    func gated() async {
        let none = HostApiReadController(host: { nil })
        await none.refresh()
        host.apiVersion = 2
        await controller().refresh()
        host.apiVersion = 1; host.capabilities = ["host", "chat"]
        let c = controller()
        await c.refresh(); await c.open(id: "a", title: "A")
        #expect(host.calls.isEmpty)
        #expect(c.state == HostApiReadState())
    }

    @Test("refresh asks for the first 50 and keeps nextOffset")
    func refresh() async {
        let c = controller()
        var seen: [HostApiReadState] = []
        c.onChange = { seen.append($0) }
        await loaded(c, first: 0..<50, next: 50)
        #expect(host.calls[0].command == .chatSessions)
        #expect(host.payload(0, as: HostApiChatSessionsRequest.self) == .init(limit: 50, offset: nil))
        #expect(c.state.sessions.count == 50 && c.state.nextOffset == 50 && !c.state.loading)
        #expect(seen.first?.loading == true && seen.last == c.state)
    }

    @Test("more: one page at a time, de-duplicated, stops at 500")
    func more() async {
        let c = controller()
        await loaded(c, first: 0..<480, next: 480)
        let a = Task { await c.moreSessions() }
        await host.waitForCalls(2)
        await c.moreSessions()   // a second tap while the first is in flight sends nothing
        #expect(host.calls.count == 2)
        #expect(host.payload(1, as: HostApiChatSessionsRequest.self) == .init(limit: 50, offset: 480))
        host.answer(1, HostApiChatSessionsResult(nextOffset: 530, sessions: sessions(0..<1) + sessions(480..<530)))
        await a.value
        #expect(c.state.sessions.count == HostApiReadController.maxSessions)
        #expect(c.state.sessions.map(\.id).filter { $0 == "s0" }.count == 1)
        #expect(c.state.nextOffset == nil)
    }

    @Test("open: a reply for an earlier open is dropped, and so is its error")
    func staleOpen() async {
        let c = controller()
        let a = Task { await c.open(id: "a", title: "A") }
        await host.waitForCalls(1)
        let b = Task { await c.open(id: "b", title: "B") }
        await host.waitForCalls(2)
        host.answer(1, HostApiChatHistoryResult(messages: lines(1...3)))
        await b.value
        host.fail(0, "That chat is gone.")
        await a.value
        #expect(c.state.open?.id == "b" && c.state.open?.title == "B")
        #expect(c.state.open?.messages.count == 3 && c.state.open?.nextBeforeSeq == nil)
        #expect(c.state.error == nil)
        #expect(host.payload(1, as: HostApiChatHistoryRequest.self) == .init(beforeSeq: nil, limit: 100, sessionId: "b"))
    }

    @Test("older prepends, keeps the newest 2000, and is dropped after close")
    func older() async {
        let c = controller()
        let o = Task { await c.open(id: "a", title: "A") }
        await host.waitForCalls(1)
        host.answer(0, HostApiChatHistoryResult(messages: lines(101...2090), nextBeforeSeq: 101))
        await o.value
        let p = Task { await c.older() }
        await host.waitForCalls(2)
        #expect(host.payload(1, as: HostApiChatHistoryRequest.self) == .init(beforeSeq: 101, limit: 100, sessionId: "a"))
        host.answer(1, HostApiChatHistoryResult(messages: lines(1...100)))
        await p.value
        #expect(c.state.open?.messages.count == HostApiReadController.maxOpenMessages)
        #expect(c.state.open?.messages.first?.seq == 91 && c.state.open?.messages.last?.seq == 2090)
        #expect(c.state.open?.nextBeforeSeq == nil)

        let q = Task { await c.open(id: "a", title: "A") }
        await host.waitForCalls(3)
        host.answer(2, HostApiChatHistoryResult(messages: lines(5...6), nextBeforeSeq: 5))
        await q.value
        let r = Task { await c.older() }
        await host.waitForCalls(4)
        c.close()
        // A late FAILURE for the closed chat: only close()'s ticket bump can drop its error.
        host.fail(3, "late")
        await r.value
        #expect(c.state.open == nil && c.state.error == nil && !c.state.loading)
    }

    @Test("a host error is shown, clamped; reset drops an in-flight reply")
    func errorsAndReset() async {
        let c = controller()
        let t = Task { await c.refresh() }
        await host.waitForCalls(1)
        host.fail(0, String(repeating: "x", count: 900))
        await t.value
        #expect(c.state.error?.count == 500 && !c.state.loading)

        let u = Task { await c.refresh() }
        await host.waitForCalls(2)
        c.reset()
        host.answer(1, HostApiChatSessionsResult(sessions: sessions(0..<3)))
        await u.value
        #expect(c.state == HostApiReadState())
    }

    @Test("reset during a hanging \"more\" does not leave more blocked after reconnect")
    func resetUnblocksMore() async {
        let c = controller()
        let t = Task { await c.refresh() }
        await host.waitForCalls(1)
        host.answer(0, HostApiChatSessionsResult(nextOffset: 50, sessions: sessions(0..<50)))
        await t.value
        let hung = Task { await c.moreSessions() }
        await host.waitForCalls(2)
        c.reset()                                   // the old "more" (call 1) never answers before reconnect
        let again = Task { await c.refresh() }
        await host.waitForCalls(3)
        host.answer(2, HostApiChatSessionsResult(nextOffset: 50, sessions: sessions(0..<50)))
        await again.value
        let more = Task { await c.moreSessions() }
        await host.waitForCalls(4)                  // a new "more" is sent: the flag was not stuck
        host.answer(3, HostApiChatSessionsResult(sessions: sessions(50..<60)))
        await more.value
        #expect(c.state.sessions.count == 60)
        host.answer(1, HostApiChatSessionsResult(sessions: sessions(90..<99)))  // the stale one lands last
        await hung.value
        #expect(c.state.sessions.count == 60, "a reply from before reset never writes")
    }
}