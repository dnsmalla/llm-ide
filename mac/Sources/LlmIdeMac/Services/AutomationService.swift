// High-level automation service: orchestrates automatic memory capture,
// cleanup, contradiction detection, and graph regeneration by delegating to
// the MemoryService (Task 4) and GraphService (Task 5) service tiers.
//
// Mirrors the TS service layer (Task 6 of the storage/service split). The
// LLM-driven capture paths (`captureFromAgentTurn` / `captureFromUI`) are
// intentional no-ops today — extraction lands in a later phase — so this ships
// safe (does nothing) rather than guessing facts. Cleanup and contradiction
// detection, however, are fully functional and unit-tested.
//
// Deviations from the original task template (forced by the real Phase 1
// types / module contents so the code compiles with no breaking changes):
//   - The template's `AgentContext` is renamed `AgentTurnContext`. A major
//     domain type `AgentContext` already lives in
//     `Agent/Models/AgentTypes.swift` (used by CodeAssistantPanel and the
//     code-assist API) with a different shape (active project + indexed
//     repos); redeclaring it here would be an invalid redeclaration.
//     `AgentTurnContext` is descriptive and parallels `captureFromAgentTurn`.
//   - `ChatMemoryFact.timestamp` is `Int` milliseconds (Phase 1 contract), so
//     the cleanup age cutoff is computed in ms (Int), not Double seconds.
//   - `CleanupReport` / `ContradictionReport` cannot use tuples (tuples are
//     not `Codable`); their entries are small `Codable & Sendable` structs
//     (`RemovedFact`, `FactError`, `Contradiction`). Field access
//     (`.removed[0].reason`, `.kept`, `.contradictions`, counts) is unchanged.
//   - `detectContradictions` matches affirmative/negative phrases over the
//     FULL fact text with word boundaries (the template grouped by the first
//     whitespace token, which would never pair "This project uses …" with
//     "This project does not use …") and flags a pair only when the two facts
//     share a non-polarity subject word, generalising the template's
//     hard-coded `npm` check.

import Foundation

/// Automation service protocol for automatic memory operations.
///
/// Conforming types must be `Sendable` (the bundled impl is an actor) so a
/// single shared instance is safe to reuse across the app. The capture methods
/// are fire-and-forget safe — they never block the caller on LLM work today.
protocol AutomationService: Sendable {
    /// Capture durable facts from a completed agent turn. No-op today; LLM
    /// extraction lands in a later phase.
    func captureFromAgentTurn(context: AgentTurnContext) async throws

    /// Capture durable facts from a UI action. No-op today.
    func captureFromUI(action: UIAction) async throws

    /// Remove stale (too old) and invalid (failed validation) facts from the
    /// repo's chat memory, returning a report of what was removed, kept, and
    /// errored. Degrades gracefully — never crashes on read failure; returns
    /// an empty report instead.
    func cleanupStaleFacts(repoRoot: URL, olderThanDays: Int) async throws -> CleanupReport

    /// Detect facts that make contradictory claims about the same subject.
    func detectContradictions(repoRoot: URL) async throws -> ContradictionReport

    /// Mark the repo's graph for regeneration after documentation changes.
    func regenerateOnDocChange(repoRoot: URL) async throws

    /// Mark the repo's graph for regeneration after code changes.
    func regenerateOnCodeChange(repoRoot: URL) async throws
}

/// Context for a single agent turn to capture facts from. The `timestamp` is
/// `TimeInterval` (seconds since epoch) — the moment the turn completed.
struct AgentTurnContext: Codable, Sendable {
    let repoRoot: URL
    let userMessage: String
    let agentReply: String
    let timestamp: TimeInterval
}

/// UI action types that may yield durable facts.
enum UIAction: Codable, Sendable {
    case agentReply(reply: String)
    case fileViewed(file: URL)
    case commandExecuted(command: String)
}

/// A fact removed during cleanup, with the reason (e.g. `stale_age` or the
/// joined validation errors).
struct RemovedFact: Codable, Sendable {
    let fact: ChatMemoryFact
    let reason: String
}

/// A fact that errored during cleanup (validation threw), with the message.
/// The fact is kept in such cases — it could not be proven invalid.
struct FactError: Codable, Sendable {
    let fact: ChatMemoryFact
    let error: String
}

/// A pair of facts that contradict each other, with the reason.
struct Contradiction: Codable, Sendable {
    let fact1: ChatMemoryFact
    let fact2: ChatMemoryFact
    let reason: String
}

/// Report returned by `cleanupStaleFacts`.
struct CleanupReport: Codable, Sendable {
    let removed: [RemovedFact]
    let kept: [ChatMemoryFact]
    let errors: [FactError]
}

/// Report returned by `detectContradictions`.
struct ContradictionReport: Codable, Sendable {
    let contradictions: [Contradiction]
}

/// Automation service implementation. An actor for thread safety; delegates
/// memory I/O to `MemoryService` and graph regeneration to `GraphService`.
final actor AutomationServiceImpl: AutomationService {
    private let memoryService: MemoryService
    private let graphService: GraphService

    init(
        memoryService: MemoryService = MemoryServiceImpl(),
        graphService: GraphService = GraphServiceImpl()
    ) {
        self.memoryService = memoryService
        self.graphService = graphService
    }

    func captureFromAgentTurn(context: AgentTurnContext) async throws {
        // TODO: LLM extraction lands in a later phase. Ship as a no-op so
        // auto-capture is safe (never invents facts) until then.
    }

    func captureFromUI(action: UIAction) async throws {
        // TODO: UI-based capture lands in a later phase.
    }

    func cleanupStaleFacts(repoRoot: URL, olderThanDays: Int = 30) async throws -> CleanupReport {
        var removed: [RemovedFact] = []
        var kept: [ChatMemoryFact] = []
        var errors: [FactError] = []

        do {
            let facts = try await memoryService.readChatMemory(repoRoot: repoRoot)
            let nowMs = Int(Date().timeIntervalSince1970 * 1000)
            let cutoffMs = nowMs - olderThanDays * Self.msPerDay

            for fact in facts {
                // Age check (timestamps are ms since epoch).
                if fact.timestamp < cutoffMs {
                    removed.append(RemovedFact(fact: fact, reason: "stale_age"))
                    continue
                }

                // Validation check. If validation itself throws, record the
                // error and keep the fact (we couldn't prove it invalid).
                do {
                    let validation = try await memoryService.validateFact(repoRoot: repoRoot, fact: fact)
                    if !validation.valid {
                        // Prefer the per-check details (joined), then fall back
                        // to the summary reason, then a generic label — matching
                        // the TS-side cleanup reconciliation shape.
                        let reason = validation.details?.joined(separator: ", ")
                            ?? validation.reason
                            ?? "invalid"
                        removed.append(RemovedFact(fact: fact, reason: reason))
                        continue
                    }
                } catch {
                    errors.append(FactError(fact: fact, error: String(describing: error)))
                }

                kept.append(fact)
            }

            // Persist the survivors if anything was pruned.
            if !removed.isEmpty {
                try await memoryService.writeChatMemory(repoRoot: repoRoot, facts: kept)
            }
        } catch {
            // Graceful degradation — never crash; return the partial (likely
            // empty) report. MemoryService.readChatMemory already degrades to
            // [] so this catch is a last-resort guard.
            print("Cleanup failed: \(error)")
        }

        return CleanupReport(removed: removed, kept: kept, errors: errors)
    }

    func detectContradictions(repoRoot: URL) async throws -> ContradictionReport {
        let facts = try await memoryService.readChatMemory(repoRoot: repoRoot)
        var contradictions: [Contradiction] = []

        // Affirmative/negative phrase pairs that signal opposing claims.
        let opposites = [("uses", "does not use"),
                         ("requires", "does not require")]

        for (pos, neg) in opposites {
            // Tokens of the polarity phrases themselves, excluded from
            // subject matching so a pair isn't flagged only because both
            // facts contain "use" / "does".
            let excluded = Set((pos + " " + neg)
                .lowercased()
                .components(separatedBy: .whitespaces))
            let posFacts = facts.filter { Self.containsWord($0.text, pos) }
            let negFacts = facts.filter { Self.containsWord($0.text, neg) }

            for f1 in posFacts {
                let subjects1 = Self.subjectWords(f1.text, excluding: excluded)
                for f2 in negFacts {
                    let subjects2 = Self.subjectWords(f2.text, excluding: excluded)
                    // Flag only when both facts discuss the same subject, so
                    // unrelated positive/negative facts aren't paired.
                    guard !subjects1.isDisjoint(with: subjects2) else { continue }
                    contradictions.append(Contradiction(
                        fact1: f1,
                        fact2: f2,
                        reason: "Conflicting statements about \(neg)"))
                }
            }
        }

        return ContradictionReport(contradictions: contradictions)
    }

    func regenerateOnDocChange(repoRoot: URL) async throws {
        try await graphService.regenerateGraph(repoRoot: repoRoot)
    }

    func regenerateOnCodeChange(repoRoot: URL) async throws {
        try await graphService.regenerateGraph(repoRoot: repoRoot)
    }

    // MARK: - Helpers

    /// Milliseconds in one day.
    private static let msPerDay = 24 * 60 * 60 * 1000

    /// Common English stop words excluded from subject matching so two facts
    /// aren't paired merely because both say "this project …". `project` is
    /// included because it appears in nearly every template example sentence
    /// and carries no discriminative signal for contradiction detection.
    private static let stopWords: Set<String> = [
        "the", "this", "that", "these", "those", "a", "an",
        "is", "are", "was", "were", "be", "been", "being",
        "for", "to", "of", "in", "on", "with", "and", "or",
        "not", "does", "do", "did", "has", "have", "had",
        "it", "its", "we", "you", "they", "our", "their", "project"
    ]

    /// Whole-word, case-insensitive match so "uses" doesn't hit "houses".
    /// Handles multi-word phrases (e.g. "does not use") as well.
    private static func containsWord(_ text: String, _ word: String) -> Bool {
        guard let regex = try? NSRegularExpression(
            pattern: "\\b" + NSRegularExpression.escapedPattern(for: word) + "\\b",
            options: [.caseInsensitive]) else { return false }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return regex.firstMatch(in: text, options: [], range: range) != nil
    }

    /// Lowercased alphabetic subject tokens (length >= 3) of `text`, minus
    /// stop words and the polarity-phrase tokens.
    private static func subjectWords(_ text: String, excluding excluded: Set<String>) -> Set<String> {
        let tokens = text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
        return Set(tokens.filter { token in
            token.count >= 3
                && token.allSatisfy { $0.isLetter }
                && !stopWords.contains(token)
                && !excluded.contains(token)
        })
    }
}
