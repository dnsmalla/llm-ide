import Foundation

/// Approval tier of a phone-started action, from `schema/bus/registry.json` (the single source of truth).
enum PhoneApprovalTier: Int, Comparable {
    /// Read-only: no desktop approval.
    case t0 = 0
    /// Enqueue only; the person at the Mac confirms in a native modal.
    case t1 = 1
    /// Writes code or leaves the machine: the Mac confirms with the exact ids/branches shown.
    case t2 = 2

    static func < (a: PhoneApprovalTier, b: PhoneApprovalTier) -> Bool { a.rawValue < b.rawValue }
    var needsDesktopApproval: Bool { self >= .t1 }
}

/// Which tier each phone-startable task needs. Foundation-only so Auto Tasks, Loop and Mobile Control
/// share it without naming each other. Keys are `AutoTask` raw values or the `loop.*` / `generation.run`
/// / `custom.*` pseudo-keys below. `PhoneApprovalPolicyTests` parses registry.json and fails on any
/// mismatch, so this Swift table cannot drift from the registry.
enum PhoneApprovalPolicy {
    struct Entry {
        /// The registry kind this row mirrors, or nil for a phone surface the registry has no kind for.
        let registryKind: String?
        let tier: PhoneApprovalTier
    }

    static let loopStart = "loop.start"
    static let loopStartStage = "loop.startStage"
    static let generationRun = "generation.run"
    static let customRead = "custom.read"
    static let customWrite = "custom.write"

    static let table: [String: Entry] = [
        // Built-in Auto Tasks (keys are AutoTask raw values)
        "sourceUpdate":      Entry(registryKind: "sources.update", tier: .t1),
        "sourcesToIssue":    Entry(registryKind: "issues.from_notes", tier: .t1),
        "updateIssues":      Entry(registryKind: "issues.from_notes", tier: .t1),   // writes the upstream tracker as the user
        "implementIssues":   Entry(registryKind: "issues.implement", tier: .t2),
        "reviewMerge":       Entry(registryKind: "issues.implement", tier: .t2),    // the ship step: push + open MR/PR
        "loopEngineering":   Entry(registryKind: "loop.run", tier: .t1),
        "generateDoc":       Entry(registryKind: nil, tier: .t1),                   // writes files and spends model quota
        "reviewCode":        Entry(registryKind: "review", tier: .t0),
        "reviewDoc":         Entry(registryKind: "review", tier: .t0),
        "reviewConflicts":   Entry(registryKind: "review", tier: .t0),
        "regression":        Entry(registryKind: nil, tier: .t0),
        "generateKnowledge": Entry(registryKind: nil, tier: .t0),
        "updatePlanStatus":  Entry(registryKind: nil, tier: .t0),
        // Loop page
        loopStart:           Entry(registryKind: "loop.run", tier: .t1),
        loopStartStage:      Entry(registryKind: "loop.run", tier: .t1),
        // Doc Gen
        generationRun:       Entry(registryKind: nil, tier: .t1),
        // Custom tasks: classified by capability. Read-only is the registry's custom.run (T1); anything
        // that can write (or is unknown) is escalated to T2.
        customRead:          Entry(registryKind: "custom.run", tier: .t1),
        customWrite:         Entry(registryKind: "custom.run", tier: .t2),
    ]

    /// Fails closed: an unknown key needs the strictest tier.
    static func tier(forKey key: String) -> PhoneApprovalTier { table[key]?.tier ?? .t2 }

    /// `writes == nil` (unknown capability) is treated as able to write.
    static func customKey(writes: Bool?) -> String { writes == false ? customRead : customWrite }
}
