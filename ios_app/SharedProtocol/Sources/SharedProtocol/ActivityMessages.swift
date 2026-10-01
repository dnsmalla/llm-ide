import Foundation

// MARK: - Activity feed
//
// The Mac keeps one per-user activity feed (loop finished, meeting added, model fell back…) and an
// unread cursor on the backend. The phone mirrors the newest entries and the unread count; it never
// writes entries. `activity_mark_seen` moves the SAME cursor the Mac's bell uses, so reading the feed
// on the phone clears the Mac's badge too — one feed, one "seen" state.

/// One feed entry, flattened for display. Titles only: the Mac's free-form `detail` JSON and `link`
/// (which can carry local paths) deliberately never cross the wire.
public struct ActivityEntry: Codable, Equatable, Identifiable, Hashable {
    public let id: Int
    /// The backend's kind string ("loop_engineering_done", …). Nil/unknown ⇒ generic icon.
    public let kind: String?
    public let title: String
    /// Seconds since 1970.
    public let createdAt: Double
    public init(id: Int, kind: String?, title: String, createdAt: Double) {
        self.id = id
        self.kind = kind
        self.title = title
        self.createdAt = createdAt
    }
}

public struct ActivityList: Codable, Equatable {
    public let type = MobileProtocol.Tag.activityList
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}

public struct ActivityState: Codable, Equatable {
    public let type = MobileProtocol.Tag.activityState
    /// Newest first, capped by the Mac.
    public let entries: [ActivityEntry]
    public let unread: Int
    public init(entries: [ActivityEntry], unread: Int) {
        self.entries = entries
        self.unread = unread
    }
    private enum CodingKeys: String, CodingKey { case type, entries, unread }
}

public struct ActivityMarkSeen: Codable, Equatable {
    public let type = MobileProtocol.Tag.activityMarkSeen
    public init() {}
    private enum CodingKeys: String, CodingKey { case type }
}
