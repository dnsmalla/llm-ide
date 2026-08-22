import Foundation

/// Sniffs a repo's root for common test-command conventions to propose the
/// project's DEFAULT LOOPS, and keeps each one's pinned stages in place on
/// every load.
///
/// **Loops, not one pipeline.** The built-in checks used to be pinned stages
/// inside a single loop, so one iteration re-ran all of them from the top and
/// a Mac-app failure dragged the whole suite round again. They are now
/// independent loops (`LoopDefaultLoopKey`) — Regression, Test, System Check,
/// Plan — each with its own process, budgets, and run history, each runnable
/// on its own. `defaultStages(forLoop:gitRoot:)` is the authority for what
/// each one contains; `ensureDefaultLoops` creates them, splits a pre-split
/// project's aggregate loop into them, and is idempotent so it can run on
/// every load.
///
/// Everything stays marker-gated: on a repo that is not llm-ide none of the
/// System Check markers match, so that loop is never created, and a repo with
/// no detectable test tooling gets Regression alone — exactly what such a repo
/// got before the split.
enum LoopStageDetector {
    /// The PRE-SPLIT flat catalogue of default stages, each marked
    /// `isDefault = true`. It is deliberately still the legacy nine and does
    /// NOT include the Regression loop's own `regression-test` verify stage
    /// (which no old build ever wrote): its only remaining job is stamping
    /// `defaultKey`s onto stages saved before keys existed, so that
    /// `ensureDefaultLoops` can route each one to the loop that owns it. What
    /// each loop actually contains is `defaultStages(forLoop:gitRoot:)`.
    ///
    /// Contents:
    /// Regression always; a Test (`shellCommand`) only when test tooling is
    /// detected at `gitRoot`; then the System Check stages (Skills, Plugins,
    /// Connectors, GitHub dispatch, Backend, iOS↔Mac shared protocol, Mac
    /// app), each only when ITS marker is found — see `systemCheckStages`.
    /// `gitRoot == nil` ⇒ Regression only (no tooling to detect).
    static func defaultStages(gitRoot: URL?) -> [LoopStage] {
        var stages: [LoopStage] = [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0,
                      isDefault: true, defaultKey: "regression")
        ]
        guard let gitRoot else { return stages }
        if let testCommand = detectTestCommand(gitRoot: gitRoot) {
            stages.append(LoopStage(name: "Test", kind: .shellCommand, command: testCommand,
                                    order: stages.count, isDefault: true, defaultKey: "test"))
        }
        for check in systemCheckStages(gitRoot: gitRoot) {
            stages.append(LoopStage(name: check.name, kind: .shellCommand, command: check.command,
                                    order: stages.count, isDefault: true, defaultKey: check.key))
        }
        return stages
    }

    /// The System Check stages (see `LoopTemplate.systemCheck`), each gated on
    /// its own marker so this stays safe to run in the GLOBAL detector — used
    /// for every project the app opens, not just llm-ide. Every marker below
    /// is llm-ide's own directory layout, so on a repo that isn't llm-ide none
    /// of them match and the defaults stay exactly what they were before this
    /// existed (Regression, plus Test if detected) — the same "only add what's
    /// actually there" rule `detectTestCommand` already follows for Test.
    private static func systemCheckStages(gitRoot: URL) -> [(key: String, name: String, command: String)] {
        let fm = FileManager.default
        func exists(_ relativePath: String) -> Bool {
            fm.fileExists(atPath: gitRoot.appendingPathComponent(relativePath).path)
        }
        // `key` is the stage's stable identity (`LoopStage.defaultKey`) — it
        // must never change once shipped, or every saved config's pinned stage
        // is orphaned and re-appended. `name` is just the initial display name.
        var checks: [(key: String, name: String, command: String)] = []
        if exists("extension/tests/agent-skills.test.mjs") {
            checks.append(("skills", "Skills", "cd extension && node --test tests/agent-skills.test.mjs "
                + "tests/agent-skill-telemetry.test.mjs tests/skill-library.test.mjs "
                + "tests/install-project-skills.test.mjs tests/task-skill-routing.test.mjs"))
        }
        if exists("extension/tests/plugins-loader.test.mjs") {
            checks.append(("plugins", "Plugins", "cd extension && node --test tests/plugins-loader.test.mjs "
                + "tests/plugins-installer.test.mjs"))
        }
        // Plugin↔MCP integration and hook trust: the surfaces where a plugin
        // acquires capability (declared MCP servers, shell-running hooks). Its
        // own stage rather than more suites bolted onto "plugins" so a failure
        // names the subsystem, and because the `plugins` key already shipped.
        if exists("extension/tests/mcp-plugin-servers.test.mjs") {
            checks.append(("plugins-mcp", "Plugins + MCP", "cd extension && node --test tests/mcp-config.test.mjs "
                + "tests/mcp-state.test.mjs tests/mcp-plugin-servers.test.mjs "
                + "tests/plugin-mcp-wiring.test.mjs tests/agent-v2-user-mcp.test.mjs "
                + "tests/plugin-hook-trust.test.mjs tests/plugin-hook-runner.test.mjs "
                + "tests/plugin-hook-trust-route.test.mjs tests/agent-v2-plugin-hooks.test.mjs "
                + "tests/mcp-cli-args.test.mjs tests/route-mcp-mode.test.mjs"))
        }
        if exists("extension/tests/box-connector.test.mjs") {
            checks.append(("connectors", "Connectors", "cd extension && node --test tests/box-connector.test.mjs "
                + "tests/box-routes.test.mjs tests/slack-source.test.mjs tests/slack-oauth.test.mjs "
                + "tests/slack-oauth-routes.test.mjs tests/email-source.test.mjs "
                + "tests/scip-connector.test.mjs tests/scip-scanner.test.mjs "
                + "tests/git-connector-chunking.test.mjs"))
        }
        if exists("extension/tests/dispatch-preview.test.mjs") {
            checks.append(("github-dispatch", "GitHub dispatch", "cd extension && node --test tests/dispatch-concurrency.test.mjs "
                + "tests/dispatch-preview.test.mjs tests/github-pr-secrets.test.mjs "
                + "tests/outcome-dispatch-sentinel.test.mjs"))
        }
        if exists("extension/package.json") {
            checks.append(("backend", "Backend", "cd extension && npm test"))
        }
        if let makefile = try? String(contentsOf: gitRoot.appendingPathComponent("Makefile"), encoding: .utf8),
           makefile.range(of: #"(?m)^test-shared-protocol:"#, options: .regularExpression) != nil {
            checks.append(("shared-protocol", "iOS ↔ Mac shared protocol", "make test-shared-protocol"))
        }
        if exists("mac/Package.swift") {
            checks.append(("mac-app", "Mac app", "cd mac && swift test"))
        }
        return checks
    }

    /// Ensure `config` contains the WHOLE pre-split default catalogue, each
    /// stage pinned (`isDefault = true`): Regression always; Test and the
    /// System Check stages only when their tooling/markers are detected at
    /// `gitRoot`.
    ///
    /// **Only `ensureDefaultLoops` should call this now.** Its remaining job is
    /// the legacy key-stamping pass on a project whose single loop predates the
    /// split — stamping is what lets the split route each stage to the loop
    /// that owns it. Every surface that loads a loop calls the loop-scoped
    /// overload below instead; calling this one on a per-loop config is exactly
    /// the bug the split fixed (all nine defaults cloned into every loop).
    static func ensureDefaultStages(in config: LoopEngineConfig, gitRoot: URL?) -> LoopEngineConfig {
        pinning(defaultStages(gitRoot: gitRoot), into: config)
    }

    /// Ensure `loop` contains the default stages **its own `defaultKey` owns**,
    /// and nothing else.
    ///
    /// This is the loop-scoped replacement for the aggregate version above, and
    /// the reason the split works at all: the aggregate helper ran on whatever
    /// config it was handed, so once a project had several loops it cloned all
    /// nine pinned defaults into every one of them. Here, the Regression loop
    /// re-pins only its Regression (+ verify) stage, the System Check loop only
    /// its subsystem checks, and a loop the USER created (`defaultKey == nil`)
    /// gets nothing injected at all — its stage list is entirely its own.
    static func ensureDefaultStages(in loop: LoopDefinition, gitRoot: URL?) -> LoopDefinition {
        guard let key = loop.defaultKey else { return loop }
        var updated = loop
        updated.config = pinning(defaultStages(forLoop: key, gitRoot: gitRoot), into: loop.config)
        return updated
    }

    /// Pin `defaults` into `config`: the first existing stage matching each
    /// default is pinned IN PLACE (its command/edits/enabled flag preserved);
    /// a default with no match is appended. Shared by both `ensureDefaultStages`
    /// overloads so the match rules below cannot drift between them.
    private static func pinning(_ defaults: [LoopStage], into config: LoopEngineConfig) -> LoopEngineConfig {
        var stages = config.stages
        for def in defaults {
            // Primary match: the stable `defaultKey`. This is what makes a
            // pinned default survive a RENAME — matching on the display name
            // meant renaming a (possibly disabled) default orphaned it, and
            // a fresh enabled copy was appended on the next load.
            //
            // Legacy fallback, for stages saved before `defaultKey` existed
            // (restricted to key-less stages so it can never steal a stage
            // that already carries a different default's identity):
            // "Test" predates every other `.shellCommand` default and was
            // always matched by kind alone, so a renamed Test keeps its
            // pinned status; the System Check stages match by exact name.
            // Whichever way a stage matches, its key is stamped, so every
            // config migrates to key-matching on first load.
            let matches: (LoopStage) -> Bool
            if stages.contains(where: { $0.defaultKey == def.defaultKey }) {
                matches = { $0.defaultKey == def.defaultKey }
            } else if def.defaultKey == "test" || def.kind == .regressionSweep {
                // Kind-alone is unambiguous for these two: there is exactly one
                // Test default and one Regression default, so even a legacy
                // stage renamed before keys existed is recovered, not duplicated.
                matches = { $0.kind == def.kind && $0.defaultKey == nil }
            } else {
                matches = { $0.kind == def.kind && $0.name == def.name && $0.defaultKey == nil }
            }
            if let idx = stages.firstIndex(where: matches) {
                stages[idx].isDefault = true
                stages[idx].defaultKey = def.defaultKey
            } else {
                stages.append(def)
            }
        }
        // Rebuild via `stages` assignment rather than the memberwise initializer:
        // an initializer call here has to restate every field, so each new
        // `LoopEngineConfig` field would silently reset to its default every time
        // a config is loaded (this helper runs on all three load paths). Copying
        // and mutating cannot drift that way.
        var updated = config
        updated.stages = stages
        return updated
    }

    /// The project's test command, or `nil` when no tooling is recognised.
    /// Internal (not private) because `LoopTemplate.applied(to:)` needs the same
    /// answer to resolve its `detectedTestCommand` placeholder — a built-in
    /// template must not hardcode `swift test`.
    static func detectTestCommand(gitRoot: URL) -> String? {
        let fm = FileManager.default

        if fm.fileExists(atPath: gitRoot.appendingPathComponent("Package.swift").path) {
            return "swift test"
        }

        if let data = try? Data(contentsOf: gitRoot.appendingPathComponent("package.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let scripts = obj["scripts"] as? [String: Any],
           scripts["test"] != nil {
            return "npm test"
        }

        if let makefile = try? String(
            contentsOf: gitRoot.appendingPathComponent("Makefile"), encoding: .utf8
        ), makefile.range(of: #"(?m)^(test|regression):"#, options: .regularExpression) != nil {
            return "make test"
        }

        let pytestMarkers = ["pytest.ini", "pyproject.toml", "setup.cfg"]
        for marker in pytestMarkers {
            let path = gitRoot.appendingPathComponent(marker)
            if fm.fileExists(atPath: path.path) {
                if marker == "pytest.ini" { return "pytest" }
                if let contents = try? String(contentsOf: path, encoding: .utf8),
                   contents.contains("pytest") {
                    return "pytest"
                }
            }
        }

        return nil
    }

    // MARK: - Default loops

    /// Which default LOOP owns each default STAGE key. The authority the split
    /// migration routes by, and the one place a new built-in check has to be
    /// registered — `defaultStages(forLoop:gitRoot:)` may only emit keys that
    /// map back to its own loop here (`LoopStageDetectorTests` asserts this).
    ///
    /// Keys are persisted, so an entry may be added but never renamed.
    private static let stageKeyOwner: [String: String] = [
        "regression": LoopDefaultLoopKey.regression,
        "regression-test": LoopDefaultLoopKey.regression,
        "test": LoopDefaultLoopKey.test,
        "skills": LoopDefaultLoopKey.systemCheck,
        "plugins": LoopDefaultLoopKey.systemCheck,
        "plugins-mcp": LoopDefaultLoopKey.systemCheck,
        "connectors": LoopDefaultLoopKey.systemCheck,
        "github-dispatch": LoopDefaultLoopKey.systemCheck,
        "backend": LoopDefaultLoopKey.systemCheck,
        "shared-protocol": LoopDefaultLoopKey.systemCheck,
        "mac-app": LoopDefaultLoopKey.systemCheck,
        "plan-structure-index": LoopDefaultLoopKey.plan,
        "plan-director": LoopDefaultLoopKey.plan,
    ]

    /// The Plan loop's two generate stages: refresh the structure indexes,
    /// then consolidate every collected plan into the master plan. Both are
    /// `.skill` stages, so they need no shell approval and never gate the run
    /// — the loop exists to (re)generate `llm-doc/plans/INDEX.md` and
    /// `PLAN.md`, not to verify anything.
    ///
    /// The `prompt` carries the whole contract on its own: the skill ids
    /// (`skills/plan-structure-index`, `skills/plan-director`) deepen the
    /// instructions when the central skills repo is installed, but a machine
    /// without it must still produce the right artifacts.
    ///
    /// The prompts deliberately name no concrete path — they defer to the
    /// stage's editable Input/Output fields (`targetPath`/`outputPath`, which
    /// `composeSkillMessage` appends as "Input: …" / "Write output to: …"), so
    /// editing those fields on the Loop page actually REDIRECTS the loop
    /// instead of contradicting a path baked into the prompt. The defaults
    /// below are relative to the PROJECT root (the folder holding
    /// `system/project.json`), which in the clone-into-code layout is two
    /// levels above the git root — the prompt tells the agent how to find it.
    /// Stage keys of detector defaults that exist on EVERY tree with a
    /// resolvable git root — the Plan loop's two skill stages. Like the bare
    /// Regression sweep, their presence proves nothing about the tree's
    /// contents, so `LoopEngineConfig.shouldPersist` must not read them as
    /// "real tooling was detected" (an all-unconditional detection can still
    /// mean "the tree has not finished populating"). Keep in sync with
    /// `planStages()` below.
    static let unconditionalStageKeys: Set<String> = ["plan-structure-index", "plan-director"]

    private static func planStages() -> [LoopStage] {
        [
            LoopStage(name: "Structure Index", kind: .skill, order: 0,
                      skillId: "skills/plan-structure-index",
                      targetPath: "llm-doc/plans",
                      outputPath: "llm-doc/plans/INDEX.md",
                      prompt: "Refresh the plan structure index: read every plan in the Input directory and "
                          + "rewrite only the drifted sections of the Output index file, creating it if missing. "
                          + "Resolve relative paths against the repo root first, then the project root (the "
                          + "directory containing system/project.json — the repo root itself, or two levels up "
                          + "when the repo is checked out under code/). The index holds: a folder-structure index "
                          + "of the codebase, a file index and a function index for the areas the collected plans "
                          + "touch, and a registry of every plan file in the Input directory. With no plans yet, "
                          + "build the index from the code itself: entry points, each area's key modules and "
                          + "public functions, and the largest refactor candidates (files over 500 lines), rows "
                          + "marked status proposed.",
                      isDefault: true, defaultKey: "plan-structure-index"),
            LoopStage(name: "Plan Director", kind: .skill, order: 1,
                      skillId: "skills/plan-director",
                      targetPath: "llm-doc/plans",
                      outputPath: "llm-doc/plans/PLAN.md",
                      prompt: "Consolidate every plan in the Input directory into the master plan at the Output "
                          + "path: a hierarchy of areas → file plans → function plans, each entry with a stable "
                          + "task ID, a status, and links back to its source plan and its structure-index rows. "
                          + "With no plans yet, derive the first master plan from the code itself via the "
                          + "structure index: propose areas from real signals (oversized files, missing tests, "
                          + "TODO/FIXME markers, layering violations), each area marked status proposed — future "
                          + "plans build on these indexes. Keep every generated plan file "
                          + "within the 250-line limit, splitting oversized areas into an areas/ folder beside "
                          + "the Output file. Preserve existing task IDs and completed ticks; never delete or "
                          + "rewrite the source plans.",
                      isDefault: true, defaultKey: "plan-director"),
        ]
    }

    /// The default stages of ONE default loop, in run order — the authority for
    /// what each built-in loop contains.
    ///
    /// - `regression`: the fault sweep, then (when test tooling is detected) a
    ///   verify stage that runs the suite. That second stage is what makes the
    ///   loop's process match what it is for — find the code behind a fault,
    ///   repair it, then prove the repair did not break the suite — instead of
    ///   certifying a fix nothing re-tested. It carries its own key
    ///   (`regression-test`), not `test`, so it is never confused with the Test
    ///   loop's stage by the split or by pinning.
    /// - `test`: the project's own test command, alone.
    /// - `system-check`: llm-ide's per-subsystem checks, each marker-gated.
    ///
    /// An empty result means "this loop does not apply to this repo" — nothing
    /// detected, so `defaultLoops` does not create it. Returning `[]` never
    /// removes a loop that already exists (see `ensureDefaultLoops`), so a
    /// temporarily unresolvable git root cannot delete a project's loops.
    static func defaultStages(forLoop loopKey: String, gitRoot: URL?) -> [LoopStage] {
        switch loopKey {
        case LoopDefaultLoopKey.regression:
            // Gated on a resolvable git root like every other loop: with no
            // working tree there is nothing to sweep, and a loop invented here
            // would make a surface report "configured" for a run the sweep
            // refuses ("no git working tree resolved"). Existing loops are
            // never affected — pinning only ever ADDS a missing stage.
            guard let gitRoot else { return [] }
            var stages = [LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0,
                                    isDefault: true, defaultKey: "regression")]
            if let testCommand = detectTestCommand(gitRoot: gitRoot) {
                stages.append(LoopStage(name: "Test", kind: .shellCommand, command: testCommand,
                                        order: 1, isDefault: true, defaultKey: "regression-test"))
            }
            return stages
        case LoopDefaultLoopKey.test:
            guard let gitRoot, let testCommand = detectTestCommand(gitRoot: gitRoot) else { return [] }
            return [LoopStage(name: "Test", kind: .shellCommand, command: testCommand, order: 0,
                              isDefault: true, defaultKey: "test")]
        case LoopDefaultLoopKey.systemCheck:
            guard let gitRoot else { return [] }
            return systemCheckStages(gitRoot: gitRoot).enumerated().map { index, check in
                LoopStage(name: check.name, kind: .shellCommand, command: check.command,
                          order: index, isDefault: true, defaultKey: check.key)
            }
        case LoopDefaultLoopKey.plan:
            // Gated like Regression — on a resolvable working tree only. The
            // loop is generic (index the structure, consolidate whatever plans
            // exist, create the director when missing), so there is no
            // llm-ide-style marker to require; `llm-doc/plans/` lives at the
            // PROJECT root, which in the clone-into-code layout is not under
            // `gitRoot` at all, so a filesystem marker here would wrongly
            // suppress the loop for exactly that layout.
            guard gitRoot != nil else { return [] }
            return planStages()
        default:
            return []
        }
    }

    /// Display name of a default loop.
    static func defaultLoopName(_ loopKey: String) -> String {
        switch loopKey {
        case LoopDefaultLoopKey.regression: return "Regression"
        case LoopDefaultLoopKey.test: return "Test"
        case LoopDefaultLoopKey.systemCheck: return "System Check"
        case LoopDefaultLoopKey.plan: return "Plan"
        default: return loopKey
        }
    }

    /// The starting goal / acceptance criteria of a default loop. Pre-filled
    /// rather than left blank because both are handed to the repair agent
    /// (`LoopDefinition.goal`): a loop that states what "done" means gets
    /// repairs aimed at that, not merely at making a command exit 0. The user
    /// owns the text from then on — nothing rewrites it.
    private static func defaultLoopContract(_ loopKey: String) -> (goal: String, acceptance: String)? {
        switch loopKey {
        case LoopDefaultLoopKey.regression:
            return ("Find the code behind each known fault and fix it for real, without weakening any test.",
                    "The fault sweep reports no failing faults and the test suite still passes.")
        case LoopDefaultLoopKey.test:
            return ("Keep this project's own test suite green.",
                    "The test command exits 0 with no failures.")
        case LoopDefaultLoopKey.systemCheck:
            return ("Keep every subsystem of this project passing its own checks.",
                    "Every enabled subsystem check exits 0.")
        case LoopDefaultLoopKey.plan:
            return ("Keep one coherent, indexed master plan: every plan collected in llm-doc/plans/ "
                        + "consolidated into a clear hierarchy whose structure indexes match the real codebase.",
                    "llm-doc/plans/INDEX.md and PLAN.md exist, reference every active plan and the files and "
                        + "functions it touches, match the current folder structure, and every plan file stays "
                        + "within the 250-line limit.")
        default:
            return nil
        }
    }

    /// The default loops that apply to `gitRoot`, in display order — each an
    /// independent `LoopDefinition` with its own stages, contract, and budgets.
    /// A loop with no applicable stages is omitted entirely.
    ///
    /// `isPrimary` is left `false` on every one of them: exactly-one-Primary is
    /// `ensureDefaultLoops`'s invariant to keep, and it is the only path that
    /// should build a project's loop list.
    static func defaultLoops(gitRoot: URL?, defaults: UserDefaults = .standard) -> [LoopDefinition] {
        LoopDefaultLoopKey.all.compactMap { key in
            let stages = defaultStages(forLoop: key, gitRoot: gitRoot)
            guard !stages.isEmpty else { return nil }
            let contract = defaultLoopContract(key)
            return LoopDefinition(name: defaultLoopName(key),
                                  goal: contract?.goal,
                                  acceptanceCriteria: contract?.acceptance,
                                  defaultKey: key,
                                  config: LoopEngineDefaults.newConfig(stages: stages, defaults: defaults))
        }
    }

    /// Bring `store` up to the current default-loops contract, and migrate a
    /// pre-split project into it. Pure, idempotent, and non-destructive: it
    /// creates and moves, and the only thing it ever removes is a loop this
    /// call itself emptied.
    ///
    /// Steps:
    /// 1. **Stamp.** A project with exactly one un-keyed loop predates the
    ///    split, so its stages may carry no `defaultKey` at all. The aggregate
    ///    `ensureDefaultStages` stamps them by the old name/kind rules, which
    ///    is what makes step 2 able to route them.
    /// 2. **Split.** Every keyed default stage moves to the loop that owns it
    ///    (`stageKeyOwner`), carrying the user's edits — command, name,
    ///    severity, timeout, and `enabled` — with it. Loops are visited
    ///    Primary-first, so when several loops hold a copy of the same pinned
    ///    stage (what the aggregate helper used to produce once a project had
    ///    more than one loop) the Primary's tuned copy is the one that wins.
    ///    User-added stages (`defaultKey == nil`) never move.
    /// 3. **Create** any default loop the project is missing, inheriting the
    ///    budgets of the loop its stages came from so a migrated project keeps
    ///    the numbers the user set.
    /// 4. **Re-pin** each default loop's own stages (the loop-scoped ensure).
    /// 5. **Keep one editable loop.** The built-ins cannot be deleted, so a
    ///    project whose loops were ALL built-ins would leave nowhere to put
    ///    work of the user's own. A loop emptied by the split is therefore
    ///    kept, not dropped — it is the user's own loop, and its stages simply
    ///    moved to the loops that own them — and a project starting from an
    ///    empty list is seeded with one. Deliberately NOT a standing
    ///    invariant: it is only ever added when the incoming list is empty, so
    ///    deleting your own loop later keeps it deleted.
    /// 6. **Primary.** Exactly one, and never a stage-less loop (the phone and
    ///    the chat command run the Primary, and an empty one would run
    ///    nothing).
    static func ensureDefaultLoops(in store: LoopEngineProjectStore, gitRoot: URL?,
                                   defaults: UserDefaults = .standard) -> LoopEngineProjectStore {
        var loops = store.loops

        // 1. Stamp. Skipped without a git root: the stamping rules are what
        // route each stage to its own loop, so migrating on a load where the
        // working tree is not resolvable would split a project by half the
        // evidence. Waiting costs nothing — the next load with a root does it.
        if gitRoot != nil, loops.count == 1, loops[0].defaultKey == nil {
            loops[0].config = ensureDefaultStages(in: loops[0].config, gitRoot: gitRoot)
        }

        // Budgets a newly created default loop inherits: the Primary loop's,
        // or the first loop's. `LoopEngineDefaults` is the fallback only when
        // the project has no loop to inherit from at all.
        let budgetSource = loops.first(where: \.isPrimary) ?? loops.first

        // 2. Split — Primary first so its copy of a duplicated pinned stage wins.
        let visitOrder = loops.filter(\.isPrimary) + loops.filter { !$0.isPrimary }
        var moved: [String: [LoopStage]] = [:]
        var updatedById: [String: LoopDefinition] = [:]
        for var loop in visitOrder {
            var kept: [LoopStage] = []
            for stage in LoopStage.runOrder(loop.config.stages) {
                guard let stageKey = stage.defaultKey, let owner = stageKeyOwner[stageKey] else {
                    kept.append(stage)   // user-added stages never move
                    continue
                }
                if loop.defaultKey == owner {
                    kept.append(stage)   // already in the loop that owns it
                    continue
                }
                // A copy of this exact default was already claimed from an
                // earlier (higher-priority) loop — drop this duplicate rather
                // than stacking two of the same pinned stage in one loop.
                if moved[owner]?.contains(where: { $0.defaultKey == stageKey }) == true { continue }
                moved[owner, default: []].append(stage)
            }
            loop.config.stages = LoopStage.renumbered(kept)
            updatedById[loop.id] = loop
        }
        loops = loops.map { updatedById[$0.id] ?? $0 }

        // 3. Create missing default loops (only where something applies).
        let templates = defaultLoops(gitRoot: gitRoot, defaults: defaults)
        for key in LoopDefaultLoopKey.all where !loops.contains(where: { $0.defaultKey == key }) {
            let claimed = moved[key] ?? []
            if !claimed.isEmpty {
                var created = LoopDefinition(
                    name: defaultLoopName(key),
                    goal: defaultLoopContract(key)?.goal,
                    acceptanceCriteria: defaultLoopContract(key)?.acceptance,
                    defaultKey: key,
                    config: budgetSource?.config ?? LoopEngineDefaults.newConfig(stages: [], defaults: defaults))
                created.config.stages = LoopStage.renumbered(claimed)
                loops.append(created)
                moved[key] = []
            } else if let template = templates.first(where: { $0.defaultKey == key }) {
                loops.append(template)
            }
        }

        // Stages claimed for a default loop that ALREADY existed.
        for (key, claimed) in moved where !claimed.isEmpty {
            guard let index = loops.firstIndex(where: { $0.defaultKey == key }) else { continue }
            let present = Set(loops[index].config.stages.compactMap(\.defaultKey))
            let additions = claimed.filter { !present.contains($0.defaultKey ?? "") }
            loops[index].config.stages = LoopStage.renumbered(
                LoopStage.runOrder(loops[index].config.stages) + additions)
        }

        // 4. Re-pin each default loop's own stages.
        loops = loops.map { ensureDefaultStages(in: $0, gitRoot: gitRoot) }

        // 5. Keep one editable loop. A first-time project gets one; an
        //    existing project keeps whatever it has (including a loop this
        //    call emptied), so a deletion is never undone.
        // `gitRoot != nil` for the same reason the built-ins are gated on it: a
        // project with no resolvable working tree has nothing to run, and a
        // loop invented here would make every surface report "configured".
        if store.loops.isEmpty, gitRoot != nil {
            loops.append(LoopDefinition(name: "Main Loop",
                                        config: LoopEngineDefaults.newConfig(stages: [], defaults: defaults)))
        }

        // 6. Primary: exactly one, never a stage-less loop.
        loops = loops.map { loop in
            guard loop.isPrimary, loop.config.stages.isEmpty else { return loop }
            var copy = loop
            copy.isPrimary = false
            return copy
        }
        let primaries = loops.filter(\.isPrimary)
        if primaries.count != 1 {
            // Prefer the surviving Primary if there is exactly one candidate;
            // otherwise the Regression loop, which every project has.
            let winner = primaries.first?.id
                ?? loops.first(where: { $0.defaultKey == LoopDefaultLoopKey.regression })?.id
                ?? loops.first(where: { !$0.config.stages.isEmpty })?.id
                ?? loops.first?.id
            loops = loops.map { loop in
                var copy = loop
                copy.isPrimary = (loop.id == winner)
                return copy
            }
        }
        return LoopEngineProjectStore(loops: loops)
    }

}
