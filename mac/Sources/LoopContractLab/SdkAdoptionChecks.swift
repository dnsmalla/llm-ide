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
