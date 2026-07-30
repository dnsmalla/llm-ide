// mac/Sources/LlmIdeMac/Services/NotesFolder/EmailFileStore.swift
import Foundation

/// Email-store helpers. The instance write/read API (one `.md` per email,
/// source-hash scan) was never wired — email ingestion writes via
/// `EmailNoteWriter` — so only the static `isBulkSender` heuristic remains,
/// used by `EmailSource` to skip automated senders without an LLM call.
struct EmailFileStore {
    /// Sender-address heuristic: automated senders never need an LLM call.
    static func isBulkSender(_ from: String) -> Bool {
        let lower = from.lowercased()
        return lower.contains("no-reply@") || lower.contains("noreply@") || lower.contains("donotreply@")
    }
}
