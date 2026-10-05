import Foundation

/// The SDK Adoption loop's records: one `.sdk` incident per Claude Agent SDK
/// version whose new surface is being adopted. It reuses Self-Heal's store and
/// proposal review so Settings › Self-Heal shows it without a second UI.
public enum SdkAdoption {
    public static let relativePath = ".sdk-adopt/BATCH.md"

    public static func incidentId(version: String) -> String { "sdk-adopt:\(version)" }

    /// Version from the batch header `# SDK adoption batch — <version>`.
    public static func version(fromBatch markdown: String) -> String? {
        guard let line = markdown.split(separator: "\n").first,
              let range = line.range(of: "# SDK adoption batch — ") else { return nil }
        let version = line[range.upperBound...].trimmingCharacters(in: .whitespaces)
        return version.isEmpty ? nil : version
    }

    @MainActor
    public static func recordPending(version: String, store: IncidentStore) {
        let id = incidentId(version: version)
        // upsert merges counts and resets .fixed; neither applies to a record, so only add when absent.
        guard !store.incidents.contains(where: { $0.id == id }) else { return }
        let now = Date()
        store.upsert(Incident(id: id, source: .sdk, category: "sdk-adoption",
                              message: "Claude Agent SDK \(version): new surface to classify and adopt",
                              stack: nil, firstSeen: now, lastSeen: now))
    }

    @MainActor
    public static func applyOutcome(version: String, runSucceeded: Bool, agentDown: Bool, runAborted: Bool,
                                    proposal: IncidentProposal?, store: IncidentStore) {
        recordPending(version: version, store: store)
        store.update(id: incidentId(version: version)) { item in
            switch (runSucceeded, proposal) {
            case (true, let proposal?):
                item.status = .proposed
                item.proposal = proposal
            case _ where agentDown || runAborted:
                // Infrastructure trouble is not the batch's fault; do not spend an attempt.
                item.status = .new
            default:
                item.attempts += 1
                item.status = item.attempts >= SelfHealOutcome.maxAttempts ? .needsHuman : .new
            }
        }
    }
}
