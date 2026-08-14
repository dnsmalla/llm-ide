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
    /// `.skill` only — optional input path (relative to the project's git root
    /// when it lies under it, via `PathUtils.relative`) the skill is scoped to,
    /// included in the agent message. Phase 3 may attach its content as a
    /// CodeAttachment; today it is a text hint only, same as `outputPath`.
    var targetPath: String? = nil
    /// `.skill` only — optional path (same relative-path convention as
    /// `targetPath`) describing where the skill's generated output should go,
    /// included in the agent message. Like `targetPath`, this is a hint the
    /// skill acts on via its own tool calls, not a mechanically enforced
    /// redirect — the runner does not read or write this path itself.
    var outputPath: String? = nil
    /// `.skill` only — optional task text; empty → a built-in default message.
    var prompt: String? = nil
    /// True for the detector-seeded default stages (Regression + Test). Default stages are
    /// always present (re-ensured on load) and cannot be deleted; they remain editable.
    /// User-added stages (the `+` menu, duplicates) are `false`.
    var isDefault: Bool = false
    /// Whether the runner executes this stage at all. `false` ⇒ skipped entirely:
    /// not run, not preflighted for approval, never gates the run. This is the
    /// escape hatch for pinned default stages — they cannot be deleted (the
    /// detector re-adds them on load), so without this a project whose detector
    /// finds many defaults could never run a smaller loop.
    /// `ensureDefaultStages` pins matches in place without touching this flag,
    /// so a disabled default stays disabled across loads.
    var enabled: Bool = true
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
         skillId: String? = nil, targetPath: String? = nil, outputPath: String? = nil, prompt: String? = nil,
         isDefault: Bool = false, enabled: Bool = true, severity: LoopStageSeverity = .blocking,
         timeoutSeconds: Int? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.command = command
        self.order = order
        self.skillId = skillId
        self.targetPath = targetPath
        self.outputPath = outputPath
        self.prompt = prompt
        self.isDefault = isDefault
        self.enabled = enabled
        self.severity = severity
        self.timeoutSeconds = timeoutSeconds
    }

    // MARK: - Codable backward compatibility

    enum CodingKeys: String, CodingKey {
        case id, name, kind, command, order, skillId, targetPath, outputPath, prompt, isDefault
        case enabled, severity, timeoutSeconds
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
        outputPath = try container.decodeIfPresent(String.self, forKey: .outputPath)
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt)
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        severity = try container.decodeIfPresent(LoopStageSeverity.self, forKey: .severity) ?? .blocking
        timeoutSeconds = try container.decodeIfPresent(Int.self, forKey: .timeoutSeconds)
    }
}

extension LoopStage {
    /// The runner's canonical execution order: `(order, id)` — `order` values
    /// can collide (e.g. after a remove + add), and a sort keyed on `order`
    /// alone isn't stable across call sites. Single source of truth for the
    /// runner and every view that renders "run order".
    static func runOrder(_ stages: [LoopStage]) -> [LoopStage] {
        stages.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }

    /// `stages` with the stage `id` moved by `offset` positions in run order
    /// (−1 = up, +1 = down), every stage's `order` renumbered to its final
    /// position. Renumbering all of them — not swapping two `order` values —
    /// is what makes this correct when orders collide or have gaps.
    /// Returns `stages` unchanged when `id` is unknown or the move would fall
    /// off either end.
    static func moving(_ stages: [LoopStage], id: String, by offset: Int) -> [LoopStage] {
        var ordered = runOrder(stages)
        guard let index = ordered.firstIndex(where: { $0.id == id }) else { return stages }
        let target = index + offset
        guard ordered.indices.contains(target) else { return stages }
        ordered.swapAt(index, target)
        return renumbered(ordered)
    }

    /// `ordered` with each stage's `order` set to its position. Used after any
    /// reorder (menu move or list drag) so the persisted `order` values match
    /// what the user sees.
    static func renumbered(_ ordered: [LoopStage]) -> [LoopStage] {
        ordered.enumerated().map { position, stage in
            var copy = stage
            copy.order = position
            return copy
        }
    }
}
