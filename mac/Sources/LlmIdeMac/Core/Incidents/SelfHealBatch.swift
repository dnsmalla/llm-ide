import Foundation

/// The fix agent's hand-off file for a triage pass: a Markdown batch of
/// incidents written at the run's git root, answered in place with a
/// `## Results` section the verify stage reads back.
public enum SelfHealBatch {
    public static let relativePath = ".self-heal/BATCH.md"

    public enum Verdict: String, Sendable {
        case fixed
        case environmental
        case cannotReproduce = "cannot-reproduce"
    }

    public struct Result: Equatable, Sendable {
        public var verdict: Verdict
        public var reason: String
        public init(verdict: Verdict, reason: String) {
            self.verdict = verdict
            self.reason = reason
        }
    }

    /// Picks up to `max` new, non-environmental incidents (most frequent
    /// first) and marks them in the store: environmental ones are ignored
    /// with a reason so they never resurface in triage, selected ones move
    /// to `.fixing` so a concurrent triage pass cannot double-pick them.
    @MainActor
    public static func select(from store: IncidentStore, max: Int) -> [Incident] {
        var picked: [Incident] = []
        for incident in store.candidatesForTriage() where picked.count < max {
            if let reason = IncidentClassifier.environmentalReason(message: incident.message) {
                store.update(id: incident.id) { $0.status = .ignored; $0.note = "environment: \(reason)" }
                continue
            }
            store.update(id: incident.id) { $0.status = .fixing }
            picked.append(incident)
        }
        return picked
    }

    public static func render(_ batch: [Incident]) -> String {
        var out = """
        # Self-Heal batch

        Errors recorded by the LLM-IDE Mac app. For each one: find the root cause in this \
        repository before changing anything, make the smallest fix, and do not weaken tests.

        ## Incidents

        """
        for incident in batch {
            out += "\n### \(incident.id)\n\n"
            out += "- source: \(incident.source.rawValue) · category: \(incident.category) · seen \(incident.count) times\n\n"
            out += "```text\n\(incident.message)\n```\n"
            if let stack = incident.stack { out += "\nStack:\n\n```text\n\(stack)\n```\n" }
        }
        out += """

        ## Results

        <!-- Write exactly one line per incident:  - <id>: fixed|environmental|cannot-reproduce — <one-line reason> -->

        """
        return out
    }

    private static let resultLine = try! NSRegularExpression(
        pattern: #"^- ([0-9a-f]{16}): (fixed|environmental|cannot-reproduce)\s*(?:[—-]\s*)?(.*)$"#,
        options: [.anchorsMatchLines])

    public static func parseResults(_ markdown: String) -> [String: Result] {
        // The LAST heading, not the first: an incident's message or stack is
        // embedded verbatim above and can itself contain the literal text
        // "## Results" followed by a fabricated verdict line — reading from
        // the first occurrence would let that spoof a real answer.
        guard let range = markdown.range(of: "## Results", options: .backwards) else { return [:] }
        let section = String(markdown[range.upperBound...])
        var results: [String: Result] = [:]
        for match in resultLine.matches(in: section, range: NSRange(section.startIndex..., in: section)) {
            guard let id = Range(match.range(at: 1), in: section).map({ String(section[$0]) }),
                  let raw = Range(match.range(at: 2), in: section).map({ String(section[$0]) }),
                  let verdict = Verdict(rawValue: raw) else { continue }
            let reason = Range(match.range(at: 3), in: section).map { String(section[$0]) } ?? ""
            results[id] = Result(verdict: verdict, reason: reason.trimmingCharacters(in: .whitespaces))
        }
        return results
    }
}
