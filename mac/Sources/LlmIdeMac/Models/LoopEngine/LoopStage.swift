import Foundation

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

    // Explicit memberwise initializer (preserved for existing call sites)
    init(id: String = UUID().uuidString, name: String, kind: Kind, command: String? = nil, order: Int,
         skillId: String? = nil, targetPath: String? = nil, prompt: String? = nil, isDefault: Bool = false) {
        self.id = id
        self.name = name
        self.kind = kind
        self.command = command
        self.order = order
        self.skillId = skillId
        self.targetPath = targetPath
        self.prompt = prompt
        self.isDefault = isDefault
    }

    // MARK: - Codable backward compatibility

    enum CodingKeys: String, CodingKey {
        case id, name, kind, command, order, skillId, targetPath, prompt, isDefault
    }

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
    }
}
