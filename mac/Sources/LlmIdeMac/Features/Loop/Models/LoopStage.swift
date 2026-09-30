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
public enum LoopStageSeverity: String, Codable, CaseIterable {
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
public struct LoopStage: Identifiable, Codable, Equatable {
    public enum Kind: String, Codable {
        case regressionSweep
        case shellCommand
        case skill
        /// An in-app check of generated artifacts (no shell, no agent): files
        /// that must exist, line caps, resolvable citations. Its parameters are
        /// `check`. A build that predates this kind reads it as `.unsupported`
        /// (kept verbatim, never run).
        case artifactCheck
        /// A kind this build does not know (written by a newer build). The
        /// stage is kept verbatim in `rawJSON`, written back unchanged on
        /// save, shown as unsupported, and NEVER run.
        case unsupported

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unsupported
        }
    }

    /// The stage's original JSON, kept only for `.unsupported` stages so a save
    /// by this build does not destroy what a newer build wrote.
    var rawJSON: AnyCodable? = nil

    public var id: String = UUID().uuidString
    public var name: String
    public var kind: Kind
    /// nil for `.regressionSweep`; required for `.shellCommand`.
    public var command: String?
    public var order: Int
    /// `.skill` only — the central-skill id ("<family>/<dir>") the server resolves
    /// to its SKILL.md and frames as a trusted instruction via /code-assist.
    public var skillId: String? = nil
    /// `.skill` only — optional input path (relative to the project's git root
    /// when it lies under it, via `PathUtils.relative`) the skill is scoped to,
    /// included in the agent message. Phase 3 may attach its content as a
    /// CodeAttachment; today it is a text hint only, same as `outputPath`.
    public var targetPath: String? = nil
    /// `.skill` only — optional path (same relative-path convention as
    /// `targetPath`) describing where the skill's generated output should go,
    /// included in the agent message. Like `targetPath`, this is a hint the
    /// skill acts on via its own tool calls, not a mechanically enforced
    /// redirect — the runner does not read or write this path itself.
    public var outputPath: String? = nil
    /// `.skill` only — optional task text; empty → a built-in default message.
    public var prompt: String? = nil
    /// True for the detector-seeded default stages (Regression + Test). Default stages are
    /// always present (re-ensured on load) and cannot be deleted; they remain editable.
    /// User-added stages (the `+` menu, duplicates) are `false`.
    public var isDefault: Bool = false
    /// Whether the runner executes this stage at all. `false` ⇒ skipped entirely:
    /// not run, not preflighted for approval, never gates the run. This is the
    /// escape hatch for pinned default stages — they cannot be deleted (the
    /// detector re-adds them on load), so without this a project whose detector
    /// finds many defaults could never run a smaller loop.
    /// `ensureDefaultStages` pins matches in place without touching this flag,
    /// so a disabled default stays disabled across loads.
    public var enabled: Bool = true
    /// Stable identity of the detector default this stage IS, or `nil` for a
    /// user-added stage. `ensureDefaultStages` matches on this first, so
    /// renaming a pinned default (including a deliberately-disabled one) can
    /// no longer make the detector re-append a fresh enabled copy — the bug
    /// that name-based matching invited. Stamped onto legacy stages the first
    /// time they are matched by the old name/kind rules, so existing configs
    /// migrate on load. Cleared on Duplicate: a copy must not claim the
    /// default's identity.
    public var defaultKey: String? = nil
    /// Whether this stage's failure gates the run. Defaults to `.blocking`, so
    /// every stage that existed before this field was introduced keeps its
    /// original behaviour.
    public var severity: LoopStageSeverity = .blocking
    /// Per-stage override of `LoopEngineRunner`'s global stage timeout.
    /// `nil` ⇒ use the runner's default. A full `swift build` + test cycle and a
    /// 2-second formatter check do not belong under one number.
    public var timeoutSeconds: Int? = nil
    /// The command `LoopStageDetector` last auto-detected FOR THIS STAGE, or
    /// `nil` when unknown (every stage saved before this field existed, or a
    /// user-added stage that was never seeded from detection).
    ///
    /// This is what makes re-validating a stale default command (see
    /// `LoopStageDetector.revalidatingTestStages`) provably safe instead of a
    /// guess: a stage is touched only when `command == detectedCommand` —
    /// proof the saved command is still exactly what detection last put
    /// there, never edited since. A stage `pinning()`'s legacy kind-alone
    /// fallback stamps `defaultKey` onto (adopting a user's own unkeyed
    /// `.shellCommand` stage) never gets this field set by that stamping, so
    /// its `command` and `detectedCommand` disagree (or `detectedCommand` is
    /// nil) and it is left alone. Set only where a stage's command is
    /// actually seeded FROM detection; never touched by hand-authoring.
    public var detectedCommand: String? = nil
    /// `.artifactCheck` only — what to check.
    public var check: ArtifactCheckSpec? = nil
    /// Revision of the detector default this stage's content was last brought
    /// to (`LoopStageDetector.upgradingDefaultRevisions`); `nil` on a stage
    /// saved before revisions existed, which reads as revision 1.
    public var defaultRevision: Int? = nil

    // Explicit memberwise initializer (preserved for existing call sites)
    public init(id: String = UUID().uuidString, name: String, kind: Kind, command: String? = nil, order: Int,
         skillId: String? = nil, targetPath: String? = nil, outputPath: String? = nil, prompt: String? = nil,
         isDefault: Bool = false, enabled: Bool = true, defaultKey: String? = nil,
         severity: LoopStageSeverity = .blocking, timeoutSeconds: Int? = nil,
         detectedCommand: String? = nil, check: ArtifactCheckSpec? = nil,
         defaultRevision: Int? = nil) {
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
        self.defaultKey = defaultKey
        self.severity = severity
        self.timeoutSeconds = timeoutSeconds
        self.detectedCommand = detectedCommand
        self.check = check
        self.defaultRevision = defaultRevision
    }

    // MARK: - Codable backward compatibility

    enum CodingKeys: String, CodingKey {
        case id, name, kind, command, order, skillId, targetPath, outputPath, prompt, isDefault
        case enabled, defaultKey, severity, timeoutSeconds, detectedCommand, check, defaultRevision
    }

    /// Every field added after the first shipped version MUST be decoded with
    /// `decodeIfPresent` + a default. `LoopEngineConfig` is persisted as
    /// UserDefaults JSON on the user's machine and is never migrated, so one
    /// `decode` of a new key turns every existing project's saved stage list
    /// into a decode failure — which `LoopEngineConfig.load` reports as "no
    /// config", silently discarding the user's stages and re-detecting defaults.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(Kind.self, forKey: .kind)
        if kind == .unsupported {
            // Lenient: the unknown stage may have any shape. Keep it whole,
            // disabled, and out of the runner's reach.
            id = try container.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
            name = try container.decodeIfPresent(String.self, forKey: .name) ?? "Unsupported stage"
            order = try container.decodeIfPresent(Int.self, forKey: .order) ?? 0
            enabled = false
            rawJSON = try? AnyCodable(from: decoder)
            return
        }
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        command = try container.decodeIfPresent(String.self, forKey: .command)
        order = try container.decode(Int.self, forKey: .order)
        skillId = try container.decodeIfPresent(String.self, forKey: .skillId)
        targetPath = try container.decodeIfPresent(String.self, forKey: .targetPath)
        outputPath = try container.decodeIfPresent(String.self, forKey: .outputPath)
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt)
        isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        defaultKey = try container.decodeIfPresent(String.self, forKey: .defaultKey)
        // Lenient: an unknown severity from a newer build reads as the safe,
        // gating default rather than failing the whole file's decode.
        severity = (try? container.decodeIfPresent(LoopStageSeverity.self, forKey: .severity)) ?? .blocking
        timeoutSeconds = try container.decodeIfPresent(Int.self, forKey: .timeoutSeconds)
        detectedCommand = try container.decodeIfPresent(String.self, forKey: .detectedCommand)
        check = try container.decodeIfPresent(ArtifactCheckSpec.self, forKey: .check)
        defaultRevision = try container.decodeIfPresent(Int.self, forKey: .defaultRevision)
    }

    /// An `.unsupported` stage writes back its original JSON untouched;
    /// everything else encodes field by field (optionals omitted when nil,
    /// same as the synthesized encoder this replaces).
    public func encode(to encoder: Encoder) throws {
        if kind == .unsupported, let rawJSON {
            try rawJSON.encode(to: encoder)
            return
        }
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(kind, forKey: .kind)
        try c.encodeIfPresent(command, forKey: .command)
        try c.encode(order, forKey: .order)
        try c.encodeIfPresent(skillId, forKey: .skillId)
        try c.encodeIfPresent(targetPath, forKey: .targetPath)
        try c.encodeIfPresent(outputPath, forKey: .outputPath)
        try c.encodeIfPresent(prompt, forKey: .prompt)
        try c.encode(isDefault, forKey: .isDefault)
        try c.encode(enabled, forKey: .enabled)
        try c.encodeIfPresent(defaultKey, forKey: .defaultKey)
        try c.encode(severity, forKey: .severity)
        try c.encodeIfPresent(timeoutSeconds, forKey: .timeoutSeconds)
        try c.encodeIfPresent(detectedCommand, forKey: .detectedCommand)
        try c.encodeIfPresent(check, forKey: .check)
        try c.encodeIfPresent(defaultRevision, forKey: .defaultRevision)
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

    /// "Run this stage only": force-enable the stage carrying `id` and disable
    /// every other stage, for one run. The FULL list is kept (rather than
    /// fabricating a one-stage config) so the journal snapshot records the
    /// project's real pipeline with the skipped stages marked disabled — not a
    /// record that reads as "the user deleted their whole pipeline". Returns
    /// nil when no stage carries `id`, so callers refuse the run instead of
    /// silently running everything. Shared by the desktop's "Run this stage
    /// only" menu action and the phone's `loop_start_stage`.
    static func soloing(_ stages: [LoopStage], id: String) -> [LoopStage]? {
        guard stages.contains(where: { $0.id == id }) else { return nil }
        return stages.map { stage in
            var copy = stage
            copy.enabled = (stage.id == id)
            return copy
        }
    }

    // MARK: - Code-applying stages
    //
    // The ONE place the "never edit code without a verify stage after it" rule
    // lives. The Refactoring loop's apply stage rewrites the tree batch by
    // batch; with no test run after it, a behaviour change would land in Run
    // Changes unproven. The default loop never ships one without a Test stage,
    // but the stage can still be reached without one by hand: "Run this stage
    // only" (`soloing`, the phone's `loop_start_stage`), a disabled Test stage,
    // a template applied to a repo with no test tooling, or a user-built loop.

    /// Skill ids whose stage applies code edits that must be verified.
    static let codeApplySkillIds: Set<String> = ["skills/refactor-apply"]

    /// Whether this stage applies code edits (see `codeApplySkillIds`).
    var appliesCode: Bool {
        kind == .skill && skillId.map(Self.codeApplySkillIds.contains) == true
    }

    /// Whether this stage verifies the tree: a BLOCKING shell command. The
    /// regression sweep only re-checks already-known faults, and an advisory
    /// stage never fails the run — neither proves a code edit changed nothing.
    var verifies: Bool { kind == .shellCommand && severity != .advisory }

    /// Whether this stage is a blocking in-app artifact check. It gates a
    /// generate loop (a failure re-runs the generate stages) but is NOT a
    /// `verifies` stage: checking that a file exists proves nothing about a
    /// code edit, so it never satisfies `lacksVerifyAfter`.
    var isBlockingArtifactCheck: Bool { kind == .artifactCheck && severity != .advisory }

    /// Whether `stage` applies code but no ENABLED verify stage comes after it
    /// in `stages`' run order — the runner refuses such a stage without
    /// calling the skill executor.
    static func lacksVerifyAfter(_ stage: LoopStage, in stages: [LoopStage]) -> Bool {
        guard stage.appliesCode else { return false }
        let ordered = runOrder(stages)
        guard let index = ordered.firstIndex(where: { $0.id == stage.id }) else { return true }
        return !ordered[(index + 1)...].contains { $0.enabled && $0.verifies }
    }

    /// Whether `stages` contains an enabled code-applying stage — what makes a
    /// loop manual-only whatever its `defaultKey` (`LoopDefinition.isManualOnly`).
    static func containsEnabledCodeApply(_ stages: [LoopStage]) -> Bool {
        stages.contains { $0.enabled && $0.appliesCode }
    }
}
