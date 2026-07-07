// Memory fact types for the `.llm-ide/memory/` storage layer.
//
// Mirrors `extension/graphkit/types/memory.ts` (Task 1) so the Swift and
// TypeScript storage layers share an identical on-disk contract.
//
// NOTE: Task 1 defined these types only for TypeScript. The Swift app did not
// yet have a `ChatMemoryFact`, and Task 6's contract requires
// `readChatMemory() -> [ChatMemoryFact]` / `writeChatMemory(facts:)`. This
// file provides the minimal type needed for that contract. A future Swift
// "types" task should relocate/expand it (e.g. add BugReport, QAEntry) — the
// shape here is deliberately byte-for-byte compatible with the TS definition.

import Foundation

/// A single fact captured from agent turns or UI actions. Facts are durable
/// project knowledge that should remain true across sessions.
public struct ChatMemoryFact: Sendable, Codable, Equatable {
    /// The fact text (280 chars max in the TS contract; not enforced here).
    public var text: String

    /// Fact category for tagging.
    public var category: FactCategory

    /// When this fact was captured, in milliseconds since the Unix epoch
    /// (matches the TS `number` / `Date.now()` semantics).
    public var timestamp: Int

    /// Source of this fact.
    public var source: FactSource

    /// Optional metadata (e.g. file paths mentioned).
    public var metadata: FactMetadata?

    public init(
        text: String,
        category: FactCategory = .convention,
        timestamp: Int,
        source: FactSource = .agent,
        metadata: FactMetadata? = nil
    ) {
        self.text = text
        self.category = category
        self.timestamp = timestamp
        self.source = source
        self.metadata = metadata
    }
}

/// Fact categories for filtering/tagging. Mirrors the TS union:
/// `'convention' | 'architecture' | 'tooling' | 'command' | 'preference'`.
public enum FactCategory: String, Sendable, Codable, Equatable {
    case convention
    case architecture
    case tooling
    case command
    case preference
}

/// Where a fact came from. Mirrors `'agent' | 'ui' | 'manual'`.
public enum FactSource: String, Sendable, Codable, Equatable {
    case agent
    case ui
    case manual
}

/// Optional fact metadata. Mirrors `{ files?: string[]; relatedModules?: string[] }`.
public struct FactMetadata: Sendable, Codable, Equatable {
    public var files: [String]?
    public var relatedModules: [String]?

    public init(files: [String]? = nil, relatedModules: [String]? = nil) {
        self.files = files
        self.relatedModules = relatedModules
    }
}
