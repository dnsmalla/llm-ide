// High-level memory service: typed read/write + validation over the Phase 1
// MemoryStorage layer. This is the service-tier surface other Mac-app code
// (and later service tasks) consume; it delegates all file I/O to
// MemoryStorage and adds graceful degradation (never crashes on read —
// returns empty data / logs) and fact validation.
//
// Mirrors the TS service layer (Task 4 of the storage/service split). The
// bugs/qa fields of MemoryData are forward-looking placeholders — fault/QA
// ingestion lands in a later phase — so they are always empty for now.
//
// Deviations from the original task template (forced by the real Phase 1
// types so the code compiles with no breaking changes):
//   - ChatMemoryFact.timestamp is `Int` (ms), not Double.
//   - QAEntry already exists (CodeGraph) and is not Codable, so MemoryData is
//     Sendable-only (Codable dropped); it is implicitly Sendable because all
//     stored properties are Sendable.
//   - BugReport is undefined in the module today, so a minimal Codable &
//     Sendable placeholder is declared here for the `bugs` slot.

import Foundation

/// Memory service protocol for high-level memory operations.
///
/// Conforming types must be `Sendable` (the bundled impl is an actor) so a
/// single shared instance is safe to reuse across the app.
protocol MemoryService: Sendable {
    /// Read the full memory snapshot for a repo (facts today; bugs/qa in a
    /// later phase). Degrades gracefully — returns empty data on read failure
    /// rather than throwing.
    func readMemory(repoRoot: URL) async throws -> MemoryData

    /// Read the chat-memory facts for a repo. Returns `[]` when absent or
    /// unreadable.
    func readChatMemory(repoRoot: URL) async throws -> [ChatMemoryFact]

    /// Persist chat-memory facts, overwriting any existing file atomically.
    func writeChatMemory(repoRoot: URL, facts: [ChatMemoryFact]) async throws

    /// Validate a fact without writing it. Checks text length (<=280 chars,
    /// matching the TS contract) and that every referenced file exists under
    /// `repoRoot`. Returns the accumulated errors; `valid` is true iff there
    /// are none.
    func validateFact(repoRoot: URL, fact: ChatMemoryFact) async throws -> ValidationResult

    /// Overwrite `repo.md` with `content` (atomic write via MemoryStorage).
    func updateRepoMD(repoRoot: URL, content: String) async throws
}

/// Memory data container returned by `readMemory`.
///
/// `bugs` and `qa` are placeholders for later phases (fault + Q&A ingestion)
/// and are empty today. `Sendable` so it can cross the actor boundary.
struct MemoryData: Sendable {
    let facts: [ChatMemoryFact]
    let bugs: [BugReport]
    let qa: [QAEntry]

    init(facts: [ChatMemoryFact] = [], bugs: [BugReport] = [], qa: [QAEntry] = []) {
        self.facts = facts
        self.bugs = bugs
        self.qa = qa
    }
}

/// Validation outcome for `validateFact`.
struct ValidationResult: Codable, Sendable {
    let valid: Bool
    let errors: [String]
}

/// Placeholder for a bug/fault entry. The faults pipeline (a later phase)
/// will populate this; for now it exists so `MemoryData` has a concrete,
/// `Codable` & `Sendable` slot for `bugs`.
struct BugReport: Codable, Sendable {}

/// Memory service implementation. An actor for thread safety; all file I/O
/// is delegated to the injected `MemoryStorage` (Phase 1 storage layer).
final actor MemoryServiceImpl: MemoryService {
    private let storage: MemoryStorage

    init(storage: MemoryStorage = MemoryStorage()) {
        self.storage = storage
    }

    func readMemory(repoRoot: URL) async throws -> MemoryData {
        do {
            // Read repo.md too so this stays the one "load all memory" entry
            // point. The content isn't surfaced in MemoryData yet (no field),
            // but performing the read keeps the call shape ready for that
            // field and mirrors the service-tier contract.
            _ = try? await storage.readMemoryFile(repoRoot: repoRoot, filename: "repo.md")
            let chatMemory = try await storage.readChatMemory(repoRoot: repoRoot)
            return MemoryData(facts: chatMemory, bugs: [], qa: [])
        } catch {
            // Graceful degradation — never crash; return empty data.
            return MemoryData(facts: [], bugs: [], qa: [])
        }
    }

    func readChatMemory(repoRoot: URL) async throws -> [ChatMemoryFact] {
        do {
            return try await storage.readChatMemory(repoRoot: repoRoot)
        } catch {
            // Graceful degradation — log and return empty rather than throw.
            print("Chat memory read failed: \(error)")
            return []
        }
    }

    func writeChatMemory(repoRoot: URL, facts: [ChatMemoryFact]) async throws {
        try await storage.writeChatMemory(repoRoot: repoRoot, facts: facts)
    }

    func validateFact(repoRoot: URL, fact: ChatMemoryFact) async throws -> ValidationResult {
        var errors: [String] = []

        // Text length (TS contract: 280 chars max).
        if fact.text.count > 280 {
            errors.append("Fact text exceeds 280 characters")
        }

        // Referenced files must exist under the repo root.
        if let files = fact.metadata?.files {
            for fileRef in files {
                let fullPath = repoRoot.appendingPathComponent(fileRef)
                if FileManager.default.fileExists(atPath: fullPath.path) == false {
                    errors.append("Referenced file does not exist: \(fileRef)")
                }
            }
        }

        return ValidationResult(valid: errors.isEmpty, errors: errors)
    }

    func updateRepoMD(repoRoot: URL, content: String) async throws {
        try await storage.writeMemoryFile(repoRoot: repoRoot, filename: "repo.md", content: content)
    }
}
