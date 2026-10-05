import Foundation
import LlmIdeMacLib

@MainActor
func runSdkAdoptionCoreChecks() {
    print("sdk-adoption: core")
    let json = #"{"id":"x","source":"future-source","category":"c","message":"m","firstSeen":0,"lastSeen":0,"count":1,"attempts":0,"status":"new"}"#
    let decoded = try? JSONDecoder().decode(Incident.self, from: Data(json.utf8))
    expect(decoded?.source == .ui, "unknown incident source decodes (falls back to .ui) instead of failing the file")
    expect(IncidentSource.sdk.rawValue == "sdk", "the sdk source is stored as \"sdk\"")

    let store = IncidentStore(fileURL: FileManager.default.temporaryDirectory
        .appendingPathComponent("sdk-\(UUID().uuidString).json"))
    SdkAdoption.recordPending(version: "1.2.3", store: store)
    SdkAdoption.recordPending(version: "1.2.3", store: store)
    expect(store.incidents.filter { $0.id == "sdk-adopt:1.2.3" }.count == 1, "recordPending is idempotent per version")
    expect(!store.candidatesForTriage().contains { $0.source == .sdk }, "triage skips sdk incidents")

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
        "extension/llm_agent/sdk/**", "extension/providers/**", "extension/tests/**",
        "extension/scripts/sdk-surface.mjs", "extension/package.json", "extension/package-lock.json",
    ], "adopt scope is the server linker, its tests and the pin only")
    expect(LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.sdkAdoption,
                                          gitRoot: FileManager.default.temporaryDirectory).isEmpty,
           "sdk-adoption exists only on the LLM-IDE checkout")

    // On the LLM-IDE checkout: the loop's shape, its scope allowlist (the safety
    // boundary the scheduler passes through as `loop.scopeGlobs`), and that an
    // existing project picks it up on load.
    let llmIde = FileManager.default.temporaryDirectory.appendingPathComponent("sdk-\(UUID().uuidString)")
    let scriptDir = llmIde.appendingPathComponent("mac/Scripts")
    try? FileManager.default.createDirectory(at: scriptDir, withIntermediateDirectories: true)
    for name in ["self-heal-verify.sh", "sdk-adopt-diff.sh"] {
        try? "#!/bin/sh\n".write(to: scriptDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }
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
    expect(adopt?.config.extraProtectedGlobs.contains("mac/Scripts/**") == true,
           "SDK Adoption protects the scripts its stages execute")
    let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: "sdk-\(UUID().uuidString)")!)
    if let verify = adopt?.config.stages.last, let command = verify.command {
        expect(command == LoopStageDetector.selfHealVerifyCommand
                   && LoopStageApproval.isApproved(verify, command: command, repo: llmIde, approvals: approvals, fresh: true),
               "the SDK Adoption verify stage is the regression gate, run without a first-run approval")
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
    LoopStageDetector.appSourceRoot = { AppSourceRoot.gitRoot }
    try? FileManager.default.removeItem(at: llmIde)
    #endif
}
