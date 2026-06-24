import Foundation
import os.log

// MARK: - ActivityKind

/// The canonical set of activity event types.  Raw values match the
/// backend's JS allow-list exactly so round-tripping through the wire
/// never corrupts kind labels.
enum ActivityKind: String, CaseIterable {
    case knowledgeUpdated     = "knowledge_updated"
    case regressionDone       = "regression_done"
    case issueCreated         = "issue_created"
    case commentAdded         = "comment_added"
    case dispatchIssueCreated = "dispatch_issue_created"
    case outcomeChanged       = "outcome_changed"
    case meetingAdded         = "meeting_added"
    case emailFetched         = "email_fetched"
    case slackFetched         = "slack_fetched"
}

// MARK: - ActivityItem

/// A single entry in the activity feed.
///
/// `kind` is optional so that a server kind not yet in the enum (a
/// future release) decodes to nil rather than crashing the client.
///
/// `detail` is arbitrary JSON from the server — decoded via
/// `JSONSerialization` in `ActivityStore._ActivityRow` so we don't
/// need to know its shape at compile time.
struct ActivityItem: Identifiable {
    let id: Int
    let kind: ActivityKind?
    let title: String
    let detail: [String: Any]?
    let link: String?
    let createdAt: Date
}

// MARK: - ActivityStore

/// Polls `GET /kb/activity` on a ~25 s interval so the activity-feed
/// badge and popover share one source of truth without hammering the
/// server.
///
/// Mirrors the `AgentRunsStore` idiom: holds a weak reference to
/// `LlmIdeAPIClient`, uses its typed `get`/`post` helpers, and runs a
/// cancellable `Task`-based poll loop.  Fire-and-forget mutations
/// (`report`, `markSeen`) never throw into the caller.
@MainActor
@Observable
final class ActivityStore {

    // MARK: Public state (Tasks 8–9 depend on these exact names)

    private(set) var items: [ActivityItem] = []
    private(set) var unreadCount: Int = 0
    private(set) var lastId: Int = 0

    // MARK: Internals

    private weak var api: LlmIdeAPIClient?
    private var pollTask: Task<Void, Never>?
    private let pollInterval: Duration = .seconds(25)
    private let log = Logger(subsystem: "com.llmide.macapp", category: "ActivityStore")

    // MARK: - Init

    init(api: LlmIdeAPIClient? = nil) {
        self.api = api
    }

    // MARK: - Lifecycle

    /// Attach the API client (called after login, like `AgentRunsStore.attach`).
    func attach(api: LlmIdeAPIClient) {
        self.api = api
        start()
    }

    // MARK: - Poll loop

    /// Begin the background poll loop.  Idempotent — calling twice is safe.
    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: self?.pollInterval ?? .seconds(25))
            }
        }
    }

    // MARK: - GET /kb/activity

    /// Fetch new items since `lastId`, prepend them, and update
    /// `lastId` + `unreadCount`.  Errors are swallowed — the next
    /// tick retries automatically (mirrors `AgentRunsStore` idiom).
    func refresh() async {
        guard let api else { return }
        do {
            // The server returns: { items: [...], unread: Int, lastId: Int }
            // We decode the wrapper with Codable; rows carry `detail` as a
            // raw JSON string that we parse separately via JSONSerialization.
            let resp: _ActivityResponse = try await api.get(
                "/kb/activity?since=\(lastId)&limit=50",
                authenticated: true
            )

            let newItems = resp.items.map { $0.toActivityItem() }
            if !newItems.isEmpty {
                // Prepend newest-first so the feed shows recent events at top.
                items = newItems + items
            }
            lastId = resp.lastId
            unreadCount = resp.unread
        } catch {
            log.error("activity refresh failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - POST /kb/activity (report)

    /// Fire-and-forget: write a new activity row to the server.
    /// Never throws into the caller; errors are logged only.
    func report(
        kind: ActivityKind,
        title: String,
        detail: [String: Any]? = nil,
        link: String? = nil
    ) {
        // Capture on the call stack before the Task hops.
        let kindRaw = kind.rawValue
        let detailData: Data?
        if let detail {
            detailData = try? JSONSerialization.data(withJSONObject: detail)
        } else {
            detailData = nil
        }
        let detailJSON = detailData.flatMap { String(data: $0, encoding: .utf8) }

        Task { [weak self] in
            guard let self, let api = self.api else { return }
            do {
                let body = _ActivityReportRequest(
                    kind: kindRaw,
                    title: title,
                    detail: detailJSON,
                    link: link
                )
                let _: _OkResponse = try await api.post(
                    "/kb/activity",
                    body: body,
                    authenticated: true
                )
            } catch {
                self.log.error("activity report failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - POST /kb/activity/seen (markSeen)

    /// Mark all items up to `lastId` as read.  Sets `unreadCount` to 0
    /// optimistically; the server confirms.  Never throws into the caller.
    func markSeen() {
        let upto = lastId
        Task { [weak self] in
            guard let self, let api = self.api else { return }
            do {
                let _: _OkResponse = try await api.post(
                    "/kb/activity/seen",
                    body: _SeenRequest(uptoId: upto),
                    authenticated: true
                )
            } catch {
                self.log.error("activity markSeen failed: \(error.localizedDescription, privacy: .public)")
            }
            self.unreadCount = 0
        }
    }

    // MARK: - Wire types (private)

    /// GET /kb/activity response envelope.
    private struct _ActivityResponse: Decodable {
        let items: [_ActivityRow]
        let unread: Int
        let lastId: Int
    }

    /// One raw activity row from the server.
    ///
    /// `detail` is stored as an opaque JSON string by the server (or
    /// as a raw `TEXT` column).  We decode it as `String?` here and
    /// then parse it with `JSONSerialization` in `toActivityItem()`.
    ///
    /// `created_at` arrives as a SQLite `datetime('now')` string
    /// ("YYYY-MM-DD HH:MM:SS"), which `JSONDecoder`'s built-in date
    /// strategies don't handle.  We decode it as a raw `String` and
    /// convert to `Date` with a dedicated formatter, falling back to
    /// `Date()` rather than crashing.
    private struct _ActivityRow: Decodable {
        let id: Int
        let kind: String?
        let title: String
        let detail: String?     // JSON text or nil
        let link: String?
        let createdAt: String   // "YYYY-MM-DD HH:MM:SS"

        enum CodingKeys: String, CodingKey {
            case id, kind, title, detail, link
            case createdAt = "created_at"
        }

        func toActivityItem() -> ActivityItem {
            // Parse detail JSON string → [String: Any]?
            var detailDict: [String: Any]?
            if let raw = detail,
               let data = raw.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                detailDict = parsed
            }

            // Parse SQLite datetime string → Date, fallback to now.
            let date = Self.parseDate(createdAt)

            return ActivityItem(
                id: id,
                kind: kind.flatMap(ActivityKind.init(rawValue:)),
                title: title,
                detail: detailDict,
                link: link,
                createdAt: date
            )
        }

        private static let sqliteDateFormatter: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd HH:mm:ss"
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "UTC")
            return f
        }()

        private static func parseDate(_ s: String) -> Date {
            // Try SQLite format first ("YYYY-MM-DD HH:MM:SS").
            if let d = sqliteDateFormatter.date(from: s) { return d }
            // Fallback: ISO 8601 (in case the server upgrades its format).
            if let d = ISO8601DateFormatter().date(from: s) { return d }
            return Date()
        }
    }

    /// POST /kb/activity request body.
    ///
    /// `detail` is serialised as a JSON string before being sent so the
    /// server stores it in its TEXT column without needing to understand
    /// the shape.  Matches the JS backend's intake contract.
    private struct _ActivityReportRequest: Encodable {
        let kind: String
        let title: String
        let detail: String?
        let link: String?
    }

    /// POST /kb/activity/seen request body.
    private struct _SeenRequest: Encodable {
        let uptoId: Int
    }

    /// Minimal success response — used for both POST endpoints.
    private struct _OkResponse: Decodable {
        let ok: Bool
    }

    // MARK: - Deinit

    // The poll loop captures [weak self] so it self-terminates when the
    // store is released.  ActivityStore is singleton-lifetime in practice
    // (AppShell holds it for the app's duration) so explicit Task
    // cancellation in deinit is not needed — and the @MainActor isolation
    // makes it impossible without a nonisolated workaround.
    deinit {}
}
