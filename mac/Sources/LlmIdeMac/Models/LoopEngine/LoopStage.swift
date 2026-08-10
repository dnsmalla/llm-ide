import Foundation

/// Whether a stage's failure gates the run.
///
/// Without this distinction every stage is a hard gate, which makes the loop
/// unusable for the checks teams most want in it: a formatter, a linter, a
/// type-check. Those fail for reasons the repair agent often should not chase,
/// and a single advisory failure would otherwise burn every iteration and end
/// the run — so in practice they get left out and the loop verifies less than it
/// could. An `.advisory` stage runs, logs, and is journalled, but never triggers
/// repair, never counts toward a stall, and never fails the run.
enum LoopStageSeverity: String, Codable, CaseIterable {
    /// Failure triggers repair and can end the run. The default.
    case blocking
    /// Failure is recorded only.
    case advisory

    var label: String {
        switch self {
        case .blocking: return "Blocking"
        case .advisory: return "Advisory"
        }
    }
}

/// One step of a Loop Engineering run. `.regressionSweep` re-runs the
/// existing `RegressionRunner` sweep (no shell command of its own);
/// `.shellCommand` runs an arbitrary project command (e.g. "swift test")
/// via `ShellFaultVerifier`, gated by `VerifyApprovalStore` like a fault
/// verify command.
struct LoopStage: Identifiable, Codable, Equatable {
    enum Kind: String, Codable {
        case regressionSweep
        case shellCommand
        case skill
    }

    var id: String = UUID().uuidString
    var name: String
    var kind: Kind
    /// nil for `.regressionSweep`; required for `.shellCommand`.
    var command: String?
    var order: Int
    /// `.skill` only — the central-skill id ("<family>/<dir>") the server resolves
    /// to its SKILL.md and frames as a trusted instruction via /code-assist.
    var skillId: String? = nil
    /// `.skill` only — optional Library path the skill is scoped to (included in
    /// the agent message). Phase 3 may attach its content as a CodeAttachment.
    var targetPath: String? = nil
    /// `.skill` only — optional task text; empty → a built-in default message.
    var prompt: String? = nil
    /// True for the detector-seeded default stages (Regression + Test). Default stages are
    /// always present (re-ensured on load) and cannot be deleted; they remain editable.
    /// User-added stages (the `+` menu, duplicates) are `false`.
    var isDefault: Bool = false
    /// Whether this stage's failure gates the run. Defaults to `.blocking`, so
    /// every stage that existed before this field was introduced keeps its
    /// original behaviour.
    var severity: LoopStageSeverity = .blocking
    /// Per-stage override of `LoopEngineRunner`'s global stage timeout.
    /// `nil` ⇒ use the runner's default. A full `swift build` + test cycle and a
    /// 2-second formatter check do not belong under one number.
    var timeoutSeconds: Int? = nil

    // Explicit memberwise initializer (preserved for existing call sites)
    init(id: String = UUID().uuidString, name: String, kind: Kind, command: String? = nil, order: Int,
         skillId: String? = nil, targetPath: String? = nil, prompt: String? = nil, isDefault: Bool = false,
         severity: LoopStageSeverity = .blocking, timeoutSeconds: Int? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.command = command
        self.order = order
        self.skillId = skillId
        self.targetPath = targetPath
        self.prompt = prompt
        self.isDefault = isDefault
        self.severity = severity
        self.timeoutSeconds = timeoutSeconds
    }

    // MARK: - Codable backward compatibility

    enum CodingKeys: String, CodingKey {
        case id, name, kind, command, order, skillId, targetPath, prompt, isDefault
        case severity, timeoutSeconds
    }

    /// Every field added after the first shipped version MUST be decoded with
    /// `decodeIfPresent` + a default. `LoopEngineConfig` is persisted as
    /// UserDefaults JSON on the user's machine and is never migrated, so one
    /// `decode` of a new key turns every existing project's saved stage list
    /// into a decode failure — which `LoopEngineConfig.load` reports as "no
    /// config", silently discarding the user's stages and re-detecting defaults.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        kind = try container.decode(Kind.self, forKey: .kind)
        command = try container.decodeIfPresent(String.self, forKey: .command)
        order = try container.decode(Int.self, forKey: .order)
        skillId = try container.decodeIfPresent(String.self, forKey: .skillId)
        targetPath = try container.decodeIfPresent(String.self, forKey: .targetPath)
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt)
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        severity = try container.decodeIfPresent(LoopStageSeverity.self, forKey: .severity) ?? .blocking
        timeoutSeconds = try container.decodeIfPresent(Int.self, forKey: .timeoutSeconds)
    }
}
