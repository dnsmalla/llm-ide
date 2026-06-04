// In-memory bookkeeping for "the user just asked this 3 times in a
// row" detection. Lives for the lifetime of a CodeAssistantPanel
// instance + active repo. Reset on app launch (fresh instance) and
// on active-repo switch (caller invokes reset()).
//
// Prompts are normalised before hashing so cosmetic variations
// ("How does auth work?" vs "how does auth work") collapse to the
// same bucket.

import Foundation
import CryptoKit

@MainActor
final class CodeAssistantSession: ObservableObject {
    /// Number of repeats that triggers the banner. 3 is the spec's
    /// conservative default; tunable here if it proves noisy.
    static let nudgeThreshold = 3

    @Published private(set) var counts: [String: Int] = [:]
    @Published private(set) var dismissed: Set<String> = []

    /// Record a user prompt. Returns the hash so the caller can pass
    /// it back to `dismiss(hash:)` without recomputing. Empty / pure-
    /// whitespace prompts return "" and are ignored.
    @discardableResult
    func record(prompt: String) -> String {
        let h = hashForPrompt(prompt)
        guard !h.isEmpty else { return "" }
        counts[h, default: 0] += 1
        return h
    }

    /// Stable hash of a normalised prompt. Public for tests + UI
    /// (the banner needs it to look up the dismiss set).
    func hashForPrompt(_ prompt: String) -> String {
        let n = normalise(prompt)
        guard !n.isEmpty else { return "" }
        let digest = SHA256.hash(data: Data(n.utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    func count(for hash: String) -> Int { counts[hash, default: 0] }

    /// True iff the prompt has hit the threshold AND the user hasn't
    /// dismissed the nudge for this hash yet.
    func shouldNudge(for prompt: String) -> Bool {
        let h = hashForPrompt(prompt)
        guard !h.isEmpty else { return false }
        return counts[h, default: 0] >= Self.nudgeThreshold && !dismissed.contains(h)
    }

    /// Suppress the banner for this hash for the rest of the session.
    func dismiss(hash: String) { dismissed.insert(hash) }

    /// Wipe all counters + dismiss state. Called on app launch
    /// (implicitly — new instance) and on active-repo switch.
    func reset() {
        counts.removeAll()
        dismissed.removeAll()
    }

    // MARK: - Normalisation

    /// Lowercase, collapse whitespace runs, strip trailing
    /// punctuation. Keeps the bucket forgiving without being
    /// aggressive — "fix the auth bug" and "Fix the auth bug." land
    /// together, but "explain auth" and "explain the auth flow"
    /// stay separate.
    private func normalise(_ s: String) -> String {
        let lower = s.lowercased()
        let parts = lower.split(whereSeparator: { $0.isWhitespace })
        let collapsed = parts.joined(separator: " ")
        let trimmed = collapsed.trimmingCharacters(in: CharacterSet(charactersIn: " .!?…,;:"))
        return trimmed
    }
}
