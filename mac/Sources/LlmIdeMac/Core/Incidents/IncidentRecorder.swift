import Foundation

public enum IncidentRecorder {
    /// Fire-and-forget entry point for every capture site, from any thread.
    public nonisolated static func record(source: IncidentSource, category: String,
                                          message: String, stack: String? = nil) {
        let at = Date()
        Task { @MainActor in
            record(source: source, category: category, message: message, stack: stack, at: at,
                   into: .shared, eligible: SelfHealSettings.isEnabled() && AppSourceRoot.gitRoot != nil)
        }
    }

    @MainActor
    public static func record(source: IncidentSource, category: String, message: String, stack: String?,
                              at date: Date, into store: IncidentStore, eligible: Bool) {
        guard eligible, !isSuppressed(at: date, source: source, category: category) else { return }
        let cleanMessage = IncidentRedactor.redact(message, limit: IncidentRedactor.maxMessage)
        let cleanStack = stack.map { IncidentRedactor.redact($0, limit: IncidentRedactor.maxStack) }
        guard !cleanMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let id = IncidentSignature.make(source: source.rawValue, category: category,
                                        message: cleanMessage, stack: cleanStack)
        store.upsert(Incident(id: id, source: source, category: category, message: cleanMessage,
                              stack: cleanStack, firstSeen: date, lastSeen: date))
    }

    /// Which incidents a suppression window drops. A window used to drop
    /// EVERYTHING, so a chat error or crash during a long Self-Heal verify was
    /// lost for good. Incidents carry no run id, so the scope is by origin:
    /// what the run itself can produce is dropped, the rest is recorded.
    public struct SuppressionScope: Sendable, Equatable {
        /// Sources dropped whatever their category.
        public var sources: Set<IncidentSource>
        /// `.ui` categories dropped (a `.ui` incident names its feature).
        public var uiCategories: Set<String>

        public init(sources: Set<IncidentSource>, uiCategories: Set<String>) {
            self.sources = sources
            self.uiCategories = uiCategories
        }

        public nonisolated func covers(source: IncidentSource, category: String) -> Bool {
            if sources.contains(source) { return true }
            return source == .ui && uiCategories.contains(category)
        }

        /// A Self-Heal-family run drives the backend (its stderr and 5xx replies)
        /// and in-process code that logs through os_log; neither can be told apart
        /// from another feature's, and letting them through would feed the run's
        /// own errors back as new incidents. The Loop's own `.ui` "loop" error is
        /// the run's too. A crash, or another feature's `.ui` error (chat), cannot
        /// come from the run and is recorded.
        public static let selfHealRun = SuppressionScope(sources: [.log, .server], uiCategories: ["loop"])
    }

    // Windows, not a flag: os_log lines are read up to a minute later and carry their own timestamps.
    @MainActor private static var windows: [(id: UUID, start: Date, end: Date?, scope: SuppressionScope)] = []

    // A run that never calls endSuppression (crash, hang) must not suppress forever.
    private static let maxOpenWindow: TimeInterval = 4 * 3600

    @MainActor
    public static func beginSuppression(scope: SuppressionScope = .selfHealRun) -> UUID {
        let id = UUID()
        windows.append((id, Date(), nil, scope))
        windows.removeAll { ($0.end ?? $0.start.addingTimeInterval(maxOpenWindow)) < Date().addingTimeInterval(-3600) }
        return id
    }

    @MainActor
    public static func endSuppression(_ token: UUID) {
        guard let i = windows.firstIndex(where: { $0.id == token }) else { return }
        windows[i].end = Date()
    }

    @MainActor
    public static func isSuppressed(at date: Date, source: IncidentSource, category: String) -> Bool {
        windows.contains {
            date >= $0.start && date <= ($0.end ?? $0.start.addingTimeInterval(maxOpenWindow))
                && $0.scope.covers(source: source, category: category)
        }
    }
}
