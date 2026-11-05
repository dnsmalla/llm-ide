import Foundation

// MARK: - Host API v1 `read` (chat.sessions, chat.history, usage.get) on the phone
//
// Read-only. Nothing here sends a write, and opening a chat never changes where `chat.send` goes.
// Behaviour mirrors web/src/read/controller.ts: same pages, caps, stale-reply ticket and in-flight guard.

/// Whether the read screens exist at all. Not optimistic: no capability list means off, and v2 is always off.
public enum HostApiReadGate {
    public static func isOn(apiVersion: Int, capabilities: Set<String>?) -> Bool {
        apiVersion == 1 && capabilities?.contains(HostApiCommand.chatSessions.capability) == true
    }
}

public enum HostApiReadMapping {
    /// `usage.get` → the `UsageState` the existing Usage screen renders. v1 carries no permission mode, no
    /// subscription windows and no limit configuration, so those stay empty rather than guessed.
    public static func usageState(_ r: HostApiUsageGetResult) -> UsageState {
        let prefix = r.providers.count > 1
        let models = r.providers.flatMap { p in
            p.models.map { m -> UsageMeter in
                let name = m.label ?? m.model
                let window = m.window.capitalized
                let detail = m.limit > 0 ? "\(m.used) of \(m.limit) \(m.unit) · \(window)"
                                         : "\(m.used) \(m.unit) · \(window), no cap"
                return UsageMeter(name: prefix ? "\(p.provider) · \(name)" : name, pct: m.pct.map { Double($0) },
                                  state: m.state, detail: detail,
                                  resetsAt: m.resetAt > 0 ? Double(m.resetAt) / 1000 : nil)
            }
        }
        return UsageState(
            provider: r.providers.isEmpty ? nil : r.providers.map(\.provider).joined(separator: ", "),
            status: r.providers.first(where: { $0.status != "ok" })?.status ?? r.providers.first?.status,
            statusReason: nil, activeModel: r.providers.first?.activeModel, models: models,
            subscription: [], subscriptionNote: nil, permissionMode: "", error: nil)
    }
}

public struct HostApiOpenChat: Equatable, Sendable {
    public var id: String
    public var title: String
    public var messages: [HostApiChatHistoryResultMessagesItem]
    public var nextBeforeSeq: Int?
}

public struct HostApiReadState: Equatable, Sendable {
    public var sessions: [HostApiChatSessionsResultSessionsItem] = []
    public var nextOffset: Int?
    public var open: HostApiOpenChat?
    public var loading = false
    public var error: String?
    public init() {}
}

/// The phone's chat list and one open chat over Host API v1 `read`. Sends only through the host the owner
/// hands it, and only when `HostApiReadGate` is on for that host.
@MainActor
public final class HostApiReadController {
    public static let maxSessions = 500, maxOpenMessages = 2000, sessionsPage = 50, historyPage = 100

    public private(set) var state = HostApiReadState() {
        didSet { if state != oldValue { onChange?(state) } }
    }
    public var onChange: ((HostApiReadState) -> Void)?

    private let host: () -> HostConnection?
    private var ticket = 0      // the open chat's request generation: a reply for an older open() is dropped
    private var generation = 0  // bumped by reset(): every reply from before a disconnect is dropped
    private var moreBusy = false

    public init(host: @escaping () -> HostConnection?) { self.host = host }

    public func refresh() async {
        await run(.chatSessions, HostApiChatSessionsRequest(limit: Self.sessionsPage), as: HostApiChatSessionsResult.self) { s, r in
            s.sessions = r.sessions; s.nextOffset = r.nextOffset
        }
    }

    public func moreSessions() async {
        guard let offset = state.nextOffset, !moreBusy else { return }
        moreBusy = true
        // Only this generation's request may clear the flag: a request left hanging by reset() must not
        // unblock (or block) "more" after a reconnect.
        let gen = generation
        defer { if gen == generation { moreBusy = false } }
        await run(.chatSessions, HostApiChatSessionsRequest(limit: Self.sessionsPage, offset: offset),
                  as: HostApiChatSessionsResult.self) { s, r in
            let seen = Set(s.sessions.map(\.id))
            s.sessions = Array((s.sessions + r.sessions.filter { !seen.contains($0.id) }).prefix(Self.maxSessions))
            // At the memory cap there is nothing more to show, so "more" goes away.
            s.nextOffset = s.sessions.count >= Self.maxSessions ? nil : r.nextOffset
        }
    }

    public func open(id: String, title: String) async {
        ticket += 1
        let mine = ticket
        await run(.chatHistory, HostApiChatHistoryRequest(limit: Self.historyPage, sessionId: id),
                  as: HostApiChatHistoryResult.self, current: { [weak self] in self?.ticket == mine }) { s, r in
            s.open = HostApiOpenChat(id: id, title: title, messages: r.messages, nextBeforeSeq: r.nextBeforeSeq)
        }
    }

    public func older() async {
        guard let o = state.open, let beforeSeq = o.nextBeforeSeq else { return }
        let mine = ticket
        await run(.chatHistory, HostApiChatHistoryRequest(beforeSeq: beforeSeq, limit: Self.historyPage, sessionId: o.id),
                  as: HostApiChatHistoryResult.self, current: { [weak self] in self?.ticket == mine }) { s, r in
            guard s.open?.id == o.id else { return }
            s.open = HostApiOpenChat(id: o.id, title: o.title,
                                     messages: Array((r.messages + o.messages).suffix(Self.maxOpenMessages)),
                                     nextBeforeSeq: r.nextBeforeSeq)
        }
    }

    /// Leaving the open chat: its late reply and late error are both dropped.
    public func close() {
        ticket += 1
        state.open = nil
        state.error = nil
    }

    /// Disconnect, a new device, or `read` revoked: forget everything and drop every in-flight reply.
    public func reset() {
        generation += 1
        ticket += 1
        moreBusy = false
        state = HostApiReadState()
    }

    // `current` false = the reply belongs to a chat the user already left: drop its error too, not only its data.
    private func run<P: Encodable, R: Decodable>(_ command: HostApiCommand, _ payload: P, as: R.Type,
                                                 current: @escaping () -> Bool = { true },
                                                 apply: (inout HostApiReadState, R) -> Void) async {
        guard let h = host(), HostApiReadGate.isOn(apiVersion: h.apiVersion, capabilities: h.capabilities) else { return }
        let gen = generation
        state.loading = true
        state.error = nil
        do {
            let r = try await h.send(command, payload, as: R.self)
            guard gen == generation else { return }
            var next = state
            if current() { apply(&next, r) }
            next.loading = false
            state = next
        } catch {
            guard gen == generation else { return }
            var next = state
            next.loading = false
            if current() {
                let text = (error as? HostApiRejection)?.message ?? ""
                next.error = String((text.isEmpty ? "Something went wrong." : text).prefix(500))
            }
            state = next
        }
    }
}