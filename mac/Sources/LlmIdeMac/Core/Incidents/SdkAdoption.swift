import Foundation

/// The SDK Adoption loop's records: one incident per Claude Agent SDK version
/// whose new surface is being adopted. It reuses Self-Heal's store and
/// proposal review so Settings › Self-Heal shows it without a second UI.
public enum SdkAdoption {
    public static let relativePath = ".sdk-adopt/BATCH.md"
    /// Records are stored under an existing source (`.server`), not a new one:
    /// an older build decoding an unknown source would fail the whole
    /// incidents.json and archive it. The category is what marks a record.
    public static let category = "sdk-adoption"

    public static func incidentId(version: String) -> String { "sdk-adopt:\(version)" }

    /// An adoption record, not a captured error — triage must never pick it.
    public static func isRecord(_ incident: Incident) -> Bool {
        incident.category == category || incident.id.hasPrefix("sdk-adopt:")
    }

    /// Whether a version's record means this run has nothing to do: it already
    /// produced a proposal, waits on a human, or was settled. Without this gate
    /// every scheduled tick re-ran the agent over the same version.
    public static func shouldSkip(status: IncidentStatus?) -> Bool {
        switch status {
        case .proposed?, .needsHuman?, .ignored?, .fixed?: return true
        case .new?, .fixing?, nil: return false
        }
    }

    /// The SDK version installed in the main checkout — the one the Diff stage
    /// reads, since worktrees borrow main's node_modules. Nil when unreadable.
    public static func installedVersion(mainRepo: URL) -> String? {
        let file = mainRepo.appendingPathComponent(
            "extension/node_modules/@anthropic-ai/claude-agent-sdk/package.json")
        guard let data = try? Data(contentsOf: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = json["version"] as? String,
              !version.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return version
    }

    /// What the runner does with the Diff script's exit code (see
    /// extension/scripts/sdk-surface.mjs).
    public enum DiffAction: Equatable, Sendable { case proceed, nothingToAdopt, needsHuman, error }

    public static func diffAction(exitCode: Int32) -> DiffAction {
        switch exitCode {
        case 0: return .proceed
        case 3: return .nothingToAdopt
        case 4: return .needsHuman
        default: return .error
        }
    }

    public static let nothingToAdoptNote = "no new top-level SDK surface"
    public static let pinRefusedNote = "main has unrelated dependency edits — commit or revert them, then Retry"

    /// Settles a version's record without an agent run (nothing to adopt, or
    /// a pin a human must sort out), creating it first when absent.
    @MainActor
    public static func settle(version: String, status: IncidentStatus, note: String, store: IncidentStore) {
        recordPending(version: version, store: store)
        store.update(id: incidentId(version: version)) { item in
            item.status = status
            item.note = note
        }
    }

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
        store.upsert(Incident(id: id, source: .server, category: category,
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
