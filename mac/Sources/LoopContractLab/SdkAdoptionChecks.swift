import Foundation
import LlmIdeMacLib

@MainActor
func runSdkAdoptionCoreChecks() {
    print("sdk-adoption: core")
    let json = #"{"id":"x","source":"future-source","category":"c","message":"m","firstSeen":0,"lastSeen":0,"count":1,"attempts":0,"status":"new"}"#
    let decoded = try? JSONDecoder().decode(Incident.self, from: Data(json.utf8))
    expect(decoded?.source == .ui, "unknown incident source decodes (falls back to .ui) instead of failing the file")

    let store = IncidentStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("sdk-\(UUID().uuidString).json"))
    SdkAdoption.recordPending(version: "1.2.3", store: store)
    SdkAdoption.recordPending(version: "1.2.3", store: store)
    expect(store.incidents.filter { $0.id == "sdk-adopt:1.2.3" }.count == 1, "recordPending is idempotent per version")
    let record = store.incidents.first { $0.id == "sdk-adopt:1.2.3" }
    expect(record?.source == .server && record?.category == "sdk-adoption",
           "SDK records persist under an existing source (.server), so older builds still decode the file")
    expect(record.map(SdkAdoption.isRecord) == true
               && SdkAdoption.isRecord(Incident(id: "sdk-adopt:9", source: .server, category: "other", message: "m",
                                                stack: nil, firstSeen: Date(), lastSeen: Date()))
               && !SdkAdoption.isRecord(Incident(id: "srv:1", source: .server, category: "server", message: "m",
                                                 stack: nil, firstSeen: Date(), lastSeen: Date())),
           "isRecord keys on the sdk-adoption category or the sdk-adopt: id prefix, not the source")
    store.upsert(Incident(id: "srv:1", source: .server, category: "server", message: "boom", stack: nil,
                          firstSeen: Date(), lastSeen: Date()))
    let triage = store.candidatesForTriage().map(\.id)
    expect(triage.contains("srv:1") && !triage.contains("sdk-adopt:1.2.3"),
           "triage skips SDK adoption records but keeps ordinary server incidents")

    // C1: the status gate and the Diff exit-code mapping.
    expect([IncidentStatus.proposed, .needsHuman, .ignored, .fixed].allSatisfy { SdkAdoption.shouldSkip(status: $0) }
               && ![IncidentStatus.new, .fixing].contains { SdkAdoption.shouldSkip(status: $0) }
               && !SdkAdoption.shouldSkip(status: nil),
           "a proposed/needs-human/ignored/fixed version is skipped; new, fixing or unrecorded runs")
    expect(SdkAdoption.diffAction(exitCode: 0) == .proceed && SdkAdoption.diffAction(exitCode: 3) == .nothingToAdopt
               && SdkAdoption.diffAction(exitCode: 4) == .needsHuman && SdkAdoption.diffAction(exitCode: 1) == .error
               && SdkAdoption.diffAction(exitCode: 2) == .error,
           "diff exit 0 proceeds, 3 is nothing to adopt, 4 needs a human, anything else is an error")
    let mainRepo = FileManager.default.temporaryDirectory.appendingPathComponent("sdk-main-\(UUID().uuidString)")
    let sdkPkg = mainRepo.appendingPathComponent("extension/node_modules/@anthropic-ai/claude-agent-sdk")
    try? FileManager.default.createDirectory(at: sdkPkg, withIntermediateDirectories: true)
    expect(SdkAdoption.installedVersion(mainRepo: mainRepo) == nil, "no installed SDK reads as nil")
    try? #"{"name":"@anthropic-ai/claude-agent-sdk","version":"0.3.290"}"#
        .write(to: sdkPkg.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
    expect(SdkAdoption.installedVersion(mainRepo: mainRepo) == "0.3.290", "the installed version is read from main's node_modules")
    try? FileManager.default.removeItem(at: mainRepo)
    SdkAdoption.settle(version: "3.0.0", status: .fixed, note: SdkAdoption.nothingToAdoptNote, store: store)
    let settled = store.incidents.first { $0.id == "sdk-adopt:3.0.0" }
    expect(settled?.status == .fixed && settled?.note == "no new top-level SDK surface"
               && SdkAdoption.shouldSkip(status: settled?.status),
           "a version-only bump (exit 3) is recorded fixed, so the next tick skips it")
    SdkAdoption.settle(version: "3.0.1", status: .needsHuman, note: SdkAdoption.pinRefusedNote, store: store)
    expect(store.incidents.first { $0.id == "sdk-adopt:3.0.1" }?.note?.hasPrefix("main has unrelated dependency edits") == true,
           "a refused pin (exit 4) parks the version for a human with the reason")

    let proposal = IncidentProposal(mainRepo: "/m", worktreePath: "/w", branch: "b", baseCommit: "c")
    SdkAdoption.applyOutcome(version: "1.2.3", runSucceeded: true, agentDown: false, runAborted: false,
                             proposal: proposal, store: store)
    expect(store.incidents.first { $0.id == "sdk-adopt:1.2.3" }?.status == .proposed, "a verified run with changes is proposed")
    SdkAdoption.recordPending(version: "2.0.0", store: store)
    for _ in 0..<3 {
        SdkAdoption.applyOutcome(version: "2.0.0", runSucceeded: false, agentDown: false, runAborted: false,
                                 proposal: nil, store: store)
    }
    expect(store.incidents.first { $0.id == "sdk-adopt:2.0.0" }?.status == .needsHuman, "three failed runs need a human")
    expect(SdkAdoption.version(fromBatch: "# SDK adoption batch — 0.3.289\n\nx") == "0.3.289", "batch header carries the version")
    expect(SelfHealProposalService.excludedPaths.contains(".sdk-adopt"), "the batch dir never enters a proposal")

    checkIdenticalPathsExcluded()
}

/// Real temp repo + worktree: a path already byte-identical in the main checkout
/// must not reach the patch, or `git apply --check` would fail on it.
@MainActor
private func checkIdenticalPathsExcluded() {
    func git(_ args: [String], _ dir: URL) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-c", "user.name=lab", "-c", "user.email=lab@example.invalid"] + args
        p.currentDirectoryURL = dir
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try? p.run(); p.waitUntilExit()
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("sdk-ident-\(UUID().uuidString)")
    let repo = root.appendingPathComponent("repo")
    let wt = root.appendingPathComponent("wt")
    defer { try? FileManager.default.removeItem(at: root) }
    try? FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
    _ = git(["init", "-q"], repo)
    for name in ["a.txt", "b.txt"] { try? "v1".write(to: repo.appendingPathComponent(name), atomically: true, encoding: .utf8) }
    _ = git(["add", "-A"], repo)
    _ = git(["commit", "-q", "-m", "init"], repo)
    let head = git(["rev-parse", "HEAD"], repo).trimmingCharacters(in: .whitespacesAndNewlines)
    _ = git(["worktree", "add", "-q", "-b", "wt", wt.path], repo)
    try? "v2".write(to: repo.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try? "v2".write(to: wt.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try? "v2".write(to: wt.appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)
    let diff = (try? SelfHealProposalService.diff(IncidentProposal(
        mainRepo: repo.path, worktreePath: wt.path, branch: "wt", baseCommit: head))) ?? ""
    expect(diff.contains("b.txt") && !diff.contains("a.txt"), "identical paths are excluded from the proposal patch")
}

func runSdkAdoptionLoopChecks() {
    #if FEATURE_AUTOTASK
    print("sdk-adoption: loop")
    let kind = try? JSONDecoder().decode(LoopStage.self,
        from: JSONEncoder().encode(LoopStage(name: "Diff", kind: .sdkSurfaceDiff, order: 0)))
    expect(kind?.kind == .sdkSurfaceDiff, "the sdkSurfaceDiff kind round-trips through loop.json")
    expect(LoopDefaultLoopKey.all.contains(LoopDefaultLoopKey.sdkAdoption), "sdk-adoption is a default loop key")
    let stages = [LoopStage(name: "Diff", kind: .sdkSurfaceDiff, order: 0, isDefault: true, defaultKey: "sdk-adopt-diff")]
    let config = LoopEngineConfig(stages: stages)
    expect(config.isSelfHealRun && config.requiresWorktree, "an sdk-adoption run is Self-Heal family: forced worktree")
    expect(LoopStageDetector.sdkAdoptScopeGlobs == [
        "extension/llm_agent/sdk/**", "extension/providers/**", "extension/tests/sdk-adopt-*.test.mjs",
    ], "adopt scope is the server linker and the adopted items' top-level sdk-adopt-* tests only — not existing tests or the pin")
    // I1: the sdk-adopt test dir is exempt from the default test globs in SDK
    // Adoption runs only; every other test stays protected.
    let sdkGlobs = config.protectedGlobs
    let plainGlobs = LoopEngineConfig(stages: [LoopStage(name: "T", kind: .shellCommand, command: "true", order: 0)])
        .protectedGlobs
    let adoptTest = "extension/tests/sdk-adopt-x.test.mjs"
    expect(!ProtectedGlobs.isProtected(adoptTest, by: sdkGlobs)
               && ProtectedGlobs.isProtected(adoptTest, by: plainGlobs),
           "extension/tests/sdk-adopt-*.test.mjs is writable in an SDK Adoption run and protected in any other loop")
    expect(ProtectedGlobs.isProtected("extension/tests/sub/sdk-adopt-x.test.mjs", by: sdkGlobs)
               && ProtectedGlobs.isProtected("extension/tests/sdk-surface.test.mjs", by: sdkGlobs),
           "the exemption is top-level sdk-adopt-* only: a subdirectory copy and sdk-surface.test.mjs stay protected")
    expect(["extension/tests/sdk-surface.test.mjs", "extension/tests/sdk-surface-ledger.test.mjs",
            "extension/tests/providers.test.mjs", "extension/package.json"]
               .allSatisfy { ProtectedGlobs.isProtected($0, by: sdkGlobs) },
           "existing tests and package.json stay protected in an SDK Adoption run")
    var sneaky = LoopEngineConfig(stages: [LoopStage(name: "T", kind: .shellCommand, command: "true", order: 0)])
    sneaky.extraProtectedGlobs = ["!**", "!", "!extension/tests/**"]
    expect(ProtectedGlobs.isProtected("extension/tests/x.test.mjs", by: sneaky.protectedGlobs)
               && ProtectedGlobs.isProtected("Makefile", by: ["Makefile", "!"]),
           "a stored or bare \"!\" entry cannot grant itself an exemption")
    // I3: the agent's own sandbox code sits inside the in-scope linker dir.
    let familyCheck = config.enforcingFamilyProtection().protectedGlobs
    expect(["extension/llm_agent/sdk/loop-agent.mjs", "extension/llm_agent/sdk/subprocess-env.mjs",
            "extension/llm_agent/sdk/updater.mjs"].allSatisfy { ProtectedGlobs.isProtected($0, by: familyCheck) }
               && !ProtectedGlobs.isProtected("extension/llm_agent/sdk/engine.mjs", by: familyCheck),
           "an SDK Adoption run protects the agent's loop, env scrubbing and updater, not the rest of the linker")
    expect(LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.sdkAdoption,
                                          gitRoot: FileManager.default.temporaryDirectory).isEmpty,
           "sdk-adoption exists only on the LLM-IDE checkout")

    // On the LLM-IDE checkout: the loop's shape, its scope allowlist (the safety
    // boundary the scheduler passes through as `loop.scopeGlobs`), and that an
    // existing project picks it up on load.
    let llmIde = FileManager.default.temporaryDirectory.appendingPathComponent("sdk-\(UUID().uuidString)")
    let scriptDir = llmIde.appendingPathComponent("mac/Scripts")
    try? FileManager.default.createDirectory(at: scriptDir, withIntermediateDirectories: true)
    for name in ["self-heal-verify.sh", "sdk-adopt-diff.sh", "sdk-adopt-verify.sh"] {
        try? "#!/bin/sh\n".write(to: scriptDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }
    let previousAppSourceRoot = LoopStageDetector.appSourceRoot
    LoopStageDetector.appSourceRoot = { llmIde }
    let adopt = LoopStageDetector.defaultLoops(gitRoot: llmIde).first { $0.defaultKey == LoopDefaultLoopKey.sdkAdoption }
    expect(adopt?.name == "SDK Adoption", "the LLM-IDE checkout gets an SDK Adoption loop")
    expect(adopt?.config.stages.map(\.kind) == [.sdkSurfaceDiff, .skill, .shellCommand],
           "SDK Adoption is diff → classify & adopt → verify")
    // The preflight's skill guard is inline in the runner (not a public helper),
    // so assert what it checks: a non-blank skillId.
    let adoptSkill = adopt?.config.stages.first { $0.defaultKey == "sdk-adopt-adopt" }?.skillId
    expect(adoptSkill == "skills/test-driven-development"
               && adoptSkill?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false,
           "the Adopt stage carries the TDD skill, so the preflight's no-bare-agent guard admits it")
    expect(adopt?.scopeGlobs == LoopStageDetector.sdkAdoptScopeGlobs, "the SDK Adoption loop carries its scope allowlist")
    expect(adopt?.runsOnSchedule == true && adopt?.config.alwaysUseWorktree == true && adopt?.config.maxIterations == 3,
           "SDK Adoption runs on the schedule, always in a worktree, with 3 iterations")
    expect(adopt?.config.extraProtectedGlobs.contains("mac/Scripts/**") == true
               && adopt?.config.extraProtectedGlobs.contains("extension/scripts/sdk-surface.mjs") == true,
           "SDK Adoption protects the scripts its stages execute and the ledger gate")
    let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: "sdk-\(UUID().uuidString)")!)
    if let verify = adopt?.config.stages.last, let command = verify.command {
        expect(command == LoopStageDetector.sdkAdoptVerifyCommand
                   && LoopStageApproval.isApproved(verify, command: command, repo: llmIde, approvals: approvals, fresh: true),
               "the SDK Adoption verify stage runs extension tests + the regression gate, without a first-run approval")
    } else {
        expect(false, "the SDK Adoption verify stage has a command")
    }
    let existing = LoopEngineProjectStore(loops: [
        LoopDefinition(name: "Mine", isPrimary: true,
                       config: LoopEngineConfig(stages: [LoopStage(name: "T", kind: .regressionSweep, order: 0)])),
    ])
    let ensured = LoopStageDetector.ensureDefaultLoops(in: existing, gitRoot: llmIde).store
    expect(ensured.loops.contains { $0.defaultKey == LoopDefaultLoopKey.sdkAdoption
               && $0.scopeGlobs == LoopStageDetector.sdkAdoptScopeGlobs },
           "a project that already has loops gains the SDK Adoption loop, scope included")
    LoopStageDetector.appSourceRoot = previousAppSourceRoot
    try? FileManager.default.removeItem(at: llmIde)

    // Run-time enforcement: editable policy and globs cannot loosen the family's guard.
    let familyGlobs = LoopStageDetector.selfHealFamilyProtectedGlobs
    let gateGlobs = LoopStageDetector.sdkAdoptProtectedGlobs
    for policy in [ProtectedPathPolicy.warn, .off, .stop] {
        var heal = LoopEngineConfig(stages: [LoopStage(name: "Triage", kind: .incidentTriage, order: 0)])
        heal.protectedPathPolicy = policy
        heal.extraProtectedGlobs = []
        let enforced = heal.enforcingFamilyProtection()
        expect(enforced.protectedPathPolicy == .revert && familyGlobs.allSatisfy(enforced.extraProtectedGlobs.contains)
                   && !gateGlobs.contains(where: enforced.extraProtectedGlobs.contains),
               "a Self-Heal run with policy \(policy.rawValue) and cleared globs is forced to revert + family globs")
    }
    var sdk = LoopEngineConfig(stages: stages)
    sdk.protectedPathPolicy = .off
    sdk.extraProtectedGlobs = ["custom/**"]
    let sdkEnforced = sdk.enforcingFamilyProtection()
    expect(sdkEnforced.protectedPathPolicy == .revert
               && (familyGlobs + gateGlobs + ["custom/**"]).allSatisfy(sdkEnforced.extraProtectedGlobs.contains),
           "an SDK Adoption run also protects the ledger gate, keeping user globs")
    for requested in [[], ["**"]] as [[String]] {
        expect(LoopStageDetector.effectiveScopeGlobs(requested, stages: stages) == LoopStageDetector.sdkAdoptScopeGlobs,
               "an SDK Adoption run's scope is exactly the allowlist whatever was passed (\(requested))")
    }
    var plain = LoopEngineConfig(stages: [LoopStage(name: "Test", kind: .shellCommand, command: "true", order: 0)])
    plain.protectedPathPolicy = .warn
    expect(plain.enforcingFamilyProtection() == plain, "an ordinary loop's policy and globs are left alone")
    expect(LoopStageDetector.effectiveScopeGlobs(["src/**"], stages: plain.stages) == ["src/**"]
               && LoopStageDetector.effectiveScopeGlobs([], stages: plain.stages).isEmpty,
           "an ordinary loop's scope is what it asked for")
    #endif
}
