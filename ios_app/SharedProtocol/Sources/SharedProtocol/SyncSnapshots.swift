import Foundation

// Plaintexts of the sync v1 files (design 4.2-4.4; extension/routes/sync/kinds.mjs, producer.mjs, consumer.mjs). The
// desktop signs them, so decoding ignores extra fields but requires the shapes the screens use.

public struct SyncManifest: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var file: String
        public var seq: Int
        public var sha256: String
    }
    public var v: Int
    public var manifestSeq: Int
    public var epoch: Int
    public var generatedAt: Int
    public var validUntil: Int
    public var kinds: [String: Entry]
}

public struct SyncKindFrame<Item: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public var v: Int
    public var kind: String
    public var generatedAt: Int
    public var truncated: Bool
    public var items: [Item]
}

public struct SyncChat: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var updatedAt: Double?
    public var phoneChat: Bool?
    public var messages: [HostApiChatHistoryResultMessagesItem]
}

public struct SyncMeeting: Codable, Equatable, Sendable, Identifiable {
    public struct Note: Codable, Equatable, Sendable {
        public var kind: String
        public var text: String
    }
    public var id: String
    public var title: String
    public var date: String
    public var durationSec: Double?
    public var participants: [String]
    public var notes: [Note]
}

public struct SyncPlanTask: Codable, Equatable, Sendable {
    public var title: String, status: String, owner: String
    public var due: String?
    public var milestone: String, risk: String
}

public struct SyncPlan: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var goal: String
    public var updatedAt: Double?
    public var tasks: [SyncPlanTask]
}

public struct SyncSnapshot: Equatable, Sendable {
    public var manifest: SyncManifest
    public var chats: [SyncChat] = []
    public var meetings: [SyncMeeting] = []
    public var plans: [SyncPlan] = []
    public var usage: HostApiUsageGetResult?
    public var truncated: Set<String> = []

    public init(manifest: SyncManifest) { self.manifest = manifest }

    public var usageState: UsageState? { usage.map(HostApiReadMapping.usageState) }
}

public struct SyncRequestPlain: Codable, Equatable, Sendable {
    public var v = 1
    public var requestId: String
    public var kind: String = "chat.send"
    public var text: String
    enum CodingKeys: String, CodingKey { case v, requestId, kind = "class", text }
    public init(requestId: String, text: String) { self.requestId = requestId; self.text = text }
}

public enum SyncReply: Equatable, Sendable {
    case answered(text: String, finishedAt: Int)
    case failed(code: String)

    static func parse(_ data: Data, requestId: String) throws -> SyncReply {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], (o["v"] as? Int) == 1,
              o["requestId"] as? String == requestId, let ok = o["ok"] as? Bool else { throw SyncCryptoError("bad_reply") }
        if ok {
            guard let text = o["text"] as? String else { throw SyncCryptoError("bad_reply") }
            return .answered(text: text, finishedAt: o["finishedAt"] as? Int ?? 0)
        }
        guard let code = o["code"] as? String else { throw SyncCryptoError("bad_reply") }
        return .failed(code: code)
    }
}

public enum SyncFreshness: Equatable, Sendable {
    case current(lastUpdatedMs: Int)
    case withheld(lastUpdatedMs: Int)
    public init(_ m: SyncManifest, nowMs: Int) {
        self = nowMs > m.validUntil ? .withheld(lastUpdatedMs: m.generatedAt) : .current(lastUpdatedMs: m.generatedAt)
    }
}
