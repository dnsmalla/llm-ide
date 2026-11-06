import Foundation
import SharedProtocol

/// `HostConnection` over today's MobileProtocol v2 socket (spec "Compatibility with MobileProtocol v2").
/// `ConnectionService` still owns pairing, heartbeat and backoff; this only translates the chat + approvals
/// slice through `HostApiV2ChatBridge`, so the moved store speaks one vocabulary on either wire.
@MainActor
final class V2HostConnection: HostConnection {
    let apiVersion = 2
    var onEvent: ((HostEvent) -> Void)?

    private unowned let service: ConnectionService
    /// The chat request Stop cancels. v1 `chat.cancel` names none, but a v2 `Cancel` needs one. This is the
    /// latest `chat.send` until its done or error, the same id the store's `currentCommandId` held.
    private var lastChatSend: String?
    private enum Reply { case snapshot, clear }
    private var waiters: [Reply: [(id: UUID, continuation: CheckedContinuation<Data, Error>)]] = [:]
    /// Requests that timed out but whose reply the Mac still sends, in order. Each such reply is dropped so it
    /// cannot resolve the next waiter. Relies on the Mac answering every request of a kind.
    private var orphanedReplies: [Reply: Int] = [:]
    private static let replyTimeout: TimeInterval = 15

    init(service: ConnectionService) { self.service = service }

    var state: HostConnectionState {
        switch service.connectionStatus {
        case .connected: return .connected
        case .connecting: return .connecting
        case .disconnected: return .disconnected
        }
    }

    /// v2 has no `host` or `approvals` capability; both come with any v2 connection that serves chat.
    var capabilities: Set<String> {
        let caps = service.macCapabilities ?? MobileProtocol.Capability.legacy
        return caps.contains(MobileProtocol.Capability.chat) ? caps.union(["host", "approvals"]) : caps.union(["host"])
    }

    func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data {
        let id = id ?? UUID().uuidString
        let enc = JSONEncoder()
        guard let frame = try HostApiV2ChatBridge.outbound(command, payload: payload, id: id, cancelTarget: lastChatSend) else {
            if command == .chatCancel { return try enc.encode(HostApiChatCancelResult(cancelled: false)) }
            throw HostApiRejection(replyTo: id, code: "capability_unavailable",
                                   message: "This Mac does not serve \(command.rawValue) over MobileProtocol v2.")
        }
        switch command {
        case .chatSend:
            // Unguarded, exactly as LlmIdeChatStore sent it before this adapter (the store checks the status).
            service.sendTextFrame(String(decoding: frame, as: UTF8.self))
            lastChatSend = id
            return try enc.encode(HostApiChatSendResult(accepted: true, requestId: id))
        case .chatSnapshot:
            guard service.sendV2Frame(frame) else { throw Self.unreachable(id) }
            return try await awaitReply(.snapshot, requestId: id)
        case .chatHistoryClear:
            guard service.sendV2Frame(frame, userFacing: true) else { throw Self.unreachable(id) }
            return try await awaitReply(.clear, requestId: id)
        case .chatCancel:
            return try enc.encode(HostApiChatCancelResult(cancelled: service.sendV2Frame(frame)))
        case .approvalsAnswer:
            return try enc.encode(HostApiApprovalsAnswerResult(accepted: service.sendV2Frame(frame)))
        case .toolApprovalsAnswer:
            return try enc.encode(HostApiToolApprovalsAnswerResult(accepted: service.sendV2Frame(frame)))
        default:
            throw HostApiRejection(replyTo: id, code: "capability_unavailable", message: "Not served over MobileProtocol v2.")
        }
    }

    func close() { service.closeConnection() }

    /// ConnectionService's v2 dispatch hands over the chat slice's frames here.
    func receive(type: String, json: [String: Any], data: Data) {
        switch type {
        case MobileProtocol.Tag.llmIdeChatHistoryReply:
            if let r = HostApiV2ChatBridge.snapshotResult(data), let d = try? JSONEncoder().encode(r) {
                deliverReply(.snapshot, with: .success(d))
            }
        case MobileProtocol.Tag.llmIdeChatHistoryClearAck:
            if let r = HostApiV2ChatBridge.clearResult(data), let d = try? JSONEncoder().encode(r) {
                deliverReply(.clear, with: .success(d))
            }
        default:
            for event in HostApiV2ChatBridge.inbound(type: type, json: json, data: data) {
                if case .event(let name, _, let replyTo) = event,
                   (name == .chatDone && replyTo == lastChatSend) || (name == .chatError && (replyTo == nil || replyTo == lastChatSend)) {
                    lastChatSend = nil
                }
                onEvent?(event)
            }
        }
    }

    /// The socket went away (ConnectionService.invalidateSocket): no pending reply will come. `lastChatSend`
    /// is kept on purpose: today a Stop after a silent reconnect still sends Cancel for the store's current id.
    func connectionEnded() {
        for kind in [Reply.snapshot, .clear] {
            // A new socket never answers the old one's requests.
            orphanedReplies[kind] = 0
            while waiters[kind]?.isEmpty == false { resolve(kind, token: nil, with: .failure(Self.unreachable(nil))) }
        }
    }

    private func awaitReply(_ kind: Reply, requestId: String) async throws -> Data {
        let token = UUID()
        return try await withCheckedThrowingContinuation { c in
            waiters[kind, default: []].append((token, c))
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.replyTimeout * 1_000_000_000))
                guard let self, let index = self.waiters[kind]?.firstIndex(where: { $0.id == token }) else { return }
                let waiter = self.waiters[kind]!.remove(at: index)
                self.orphanedReplies[kind, default: 0] += 1
                waiter.continuation.resume(throwing: Self.unreachable(requestId))
            }
        }
    }

    /// v2 replies carry no id, and the Mac answers in order: a reply goes to the oldest live waiter, unless it
    /// answers a request that already timed out.
    private func deliverReply(_ kind: Reply, with result: Result<Data, Error>) {
        if orphanedReplies[kind, default: 0] > 0 {
            orphanedReplies[kind, default: 0] -= 1
            return
        }
        resolve(kind, token: nil, with: result)
    }

    private func resolve(_ kind: Reply, token: UUID?, with result: Result<Data, Error>) {
        var list = waiters[kind] ?? []
        guard let index = token == nil ? list.indices.first : list.firstIndex(where: { $0.id == token }) else { return }
        let waiter = list.remove(at: index)
        waiters[kind] = list
        waiter.continuation.resume(with: result)
    }

    private static func unreachable(_ id: String?) -> HostApiRejection {
        HostApiRejection(replyTo: id, code: "host_unreachable", message: "Not connected to your Mac.", retryable: true)
    }
}
