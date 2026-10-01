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
        guard eligible, !isSuppressed(at: date) else { return }
        let cleanMessage = IncidentRedactor.redact(message, limit: IncidentRedactor.maxMessage)
        let cleanStack = stack.map { IncidentRedactor.redact($0, limit: IncidentRedactor.maxStack) }
        guard !cleanMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let id = IncidentSignature.make(source: source.rawValue, category: category,
                                        message: cleanMessage, stack: cleanStack)
        store.upsert(Incident(id: id, source: source, category: category, message: cleanMessage,
                              stack: cleanStack, firstSeen: date, lastSeen: date))
    }

    // Windows, not a flag: os_log lines are read up to a minute later and carry their own timestamps.
    @MainActor private static var windows: [(id: UUID, start: Date, end: Date?)] = []

    // A run that never calls endSuppression (crash, hang) must not suppress forever.
    private static let maxOpenWindow: TimeInterval = 4 * 3600

    @MainActor
    public static func beginSuppression() -> UUID {
        let id = UUID()
        windows.append((id, Date(), nil))
        windows.removeAll { ($0.end ?? $0.start.addingTimeInterval(maxOpenWindow)) < Date().addingTimeInterval(-3600) }
        return id
    }

    @MainActor
    public static func endSuppression(_ token: UUID) {
        guard let i = windows.firstIndex(where: { $0.id == token }) else { return }
        windows[i].end = Date()
    }

    @MainActor
    public static func isSuppressed(at date: Date) -> Bool {
        windows.contains { date >= $0.start && date <= ($0.end ?? $0.start.addingTimeInterval(maxOpenWindow)) }
    }
}
