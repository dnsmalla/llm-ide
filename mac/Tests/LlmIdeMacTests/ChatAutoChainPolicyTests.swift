import Foundation
import Testing
@testable import LlmIdeMacLib

/// Builds a `PendingTool` fixture by JSON-encoding typed args the same way
/// the wire protocol does, per AgentTypes.swift's `PendingToolKind.names`.
private func pendingTool(name: String, args: some Encodable) -> PendingTool {
    let data = try! AppJSON.encoder.encode(args)
    return PendingTool(name: name, arguments: .init(raw: data))
}

private func updateFileTool(content: String? = "full rewrite", path: String = "/repo/file.swift") -> PendingTool {
    pendingTool(name: "update-file", args: PendingTool.UpdateFileArgs(
        path: path, content: content, oldText: content == nil ? "old" : nil, newText: content == nil ? "new" : nil
    ))
}

private func bashTool() -> PendingTool {
    pendingTool(name: "bash", args: BashArgs(command: "echo hi", workingDirectory: nil))
}

private func gitOpTool(_ op: GitOp) -> PendingTool {
    pendingTool(name: "git-op", args: GitOpArgs(op: op, message: nil, branch: nil, ref: nil, mode: nil, slug: nil))
}

private func savePlanTool() -> PendingTool {
    pendingTool(name: "save-plan", args: PendingTool.SavePlanArgs(title: "A plan", content: "# A plan\n"))
}

@Suite("Auto-chain policy")
struct ChatAutoChainPolicyTests {
    @Test("Review mode never auto-applies an edit")
    func reviewMode() {
        let d = ChatAutoChainPolicy.decide(pendingTool: nil, editMode: .review, autoOpsUsed: 0,
                                           maxAutoOpsPerTurn: 10, truncatedPaths: [],
                                           isWholeFileRewrite: true, matchPath: nil,
                                           shouldAutoRunGitOp: { _ in false })
        #expect(d.isEmpty || d == [.none])
    }

    @Test("Auto mode + whole-file rewrite + truncated path → manual review with reason")
    func truncatedGuard() {
        let path = "/repo/big.swift"
        let d = ChatAutoChainPolicy.decide(
            pendingTool: updateFileTool(content: "full rewrite", path: path),
            editMode: .auto, autoOpsUsed: 0, maxAutoOpsPerTurn: 10,
            truncatedPaths: [path], isWholeFileRewrite: true, matchPath: path,
            shouldAutoRunGitOp: { _ in false }
        )
        guard case .requireManualReview(let reason) = d.first, d.count == 1 else {
            Issue.record("expected a single requireManualReview decision, got \(d)")
            return
        }
        #expect(reason != nil)
    }

    @Test("Auto mode + anchored edit on truncated file → still auto-applies")
    func anchoredEditSafe() {
        let path = "/repo/big.swift"
        let d = ChatAutoChainPolicy.decide(
            pendingTool: updateFileTool(content: nil, path: path),
            editMode: .auto, autoOpsUsed: 0, maxAutoOpsPerTurn: 10,
            truncatedPaths: [path], isWholeFileRewrite: false, matchPath: path,
            shouldAutoRunGitOp: { _ in false }
        )
        #expect(d == [.autoApplyEdit])
    }

    @Test("Budget exhausted → no further auto ops")
    func budget() {
        let dEdit = ChatAutoChainPolicy.decide(
            pendingTool: updateFileTool(), editMode: .auto, autoOpsUsed: 10, maxAutoOpsPerTurn: 10,
            truncatedPaths: [], isWholeFileRewrite: true, matchPath: nil,
            shouldAutoRunGitOp: { _ in false }
        )
        #expect(dEdit.isEmpty)

        let dBash = ChatAutoChainPolicy.decide(
            pendingTool: bashTool(), editMode: .auto, autoOpsUsed: 10, maxAutoOpsPerTurn: 10,
            truncatedPaths: [], isWholeFileRewrite: false, matchPath: nil,
            shouldAutoRunGitOp: { _ in false }
        )
        #expect(dBash.isEmpty)
    }

    @Test("Bash proposal in auto mode within budget → autoRunBash")
    func bash() {
        let d = ChatAutoChainPolicy.decide(
            pendingTool: bashTool(), editMode: .auto, autoOpsUsed: 0, maxAutoOpsPerTurn: 10,
            truncatedPaths: [], isWholeFileRewrite: false, matchPath: nil,
            shouldAutoRunGitOp: { _ in false }
        )
        #expect(d == [.autoRunBash])
    }

    @Test("Git-op tier behavior is delegated entirely to shouldAutoRunGitOp")
    func gitOpTierDelegation() {
        // Read-tier: auto-runs even in review mode, because the injected
        // predicate says so (mirroring shouldAutoRunGitOp's real behavior:
        // read ops ignore editMode entirely).
        let readPredicate: (GitOpArgs) -> Bool = { $0.op.tier == .read }
        let dRead = ChatAutoChainPolicy.decide(
            pendingTool: gitOpTool(.status), editMode: .review, autoOpsUsed: 0, maxAutoOpsPerTurn: 10,
            truncatedPaths: [], isWholeFileRewrite: false, matchPath: nil,
            shouldAutoRunGitOp: readPredicate
        )
        #expect(dRead == [.autoRunGitOp])

        // Write-tier: only when the predicate (standing in for `editMode ==
        // .auto`) says yes.
        let writeAutoPredicate: (GitOpArgs) -> Bool = { $0.op.tier == .write }
        let dWriteAuto = ChatAutoChainPolicy.decide(
            pendingTool: gitOpTool(.commit), editMode: .auto, autoOpsUsed: 0, maxAutoOpsPerTurn: 10,
            truncatedPaths: [], isWholeFileRewrite: false, matchPath: nil,
            shouldAutoRunGitOp: writeAutoPredicate
        )
        #expect(dWriteAuto == [.autoRunGitOp])

        let dWriteReview = ChatAutoChainPolicy.decide(
            pendingTool: gitOpTool(.commit), editMode: .review, autoOpsUsed: 0, maxAutoOpsPerTurn: 10,
            truncatedPaths: [], isWholeFileRewrite: false, matchPath: nil,
            shouldAutoRunGitOp: { _ in false } // review mode → predicate says no
        )
        #expect(dWriteReview.isEmpty)

        // Destructive-tier: never, regardless of mode — predicate always false.
        let dDestructive = ChatAutoChainPolicy.decide(
            pendingTool: gitOpTool(.merge), editMode: .auto, autoOpsUsed: 0, maxAutoOpsPerTurn: 10,
            truncatedPaths: [], isWholeFileRewrite: false, matchPath: nil,
            shouldAutoRunGitOp: { _ in false }
        )
        #expect(dDestructive.isEmpty)
    }

    @Test("save-plan always auto-saves — ungated by editMode, unlike update-file/bash")
    func savePlanIgnoresEditMode() {
        for mode: EditAcceptanceMode in [.auto, .review] {
            let d = ChatAutoChainPolicy.decide(
                pendingTool: savePlanTool(), editMode: mode, autoOpsUsed: 0, maxAutoOpsPerTurn: 10,
                truncatedPaths: [], isWholeFileRewrite: false, matchPath: nil,
                shouldAutoRunGitOp: { _ in false }
            )
            #expect(d == [.autoSavePlan], "editMode \(mode) should not change save-plan's decision")
        }
    }

    @Test("save-plan always auto-saves — ungated by the per-turn auto-ops budget, unlike update-file/bash")
    func savePlanIgnoresBudget() {
        let d = ChatAutoChainPolicy.decide(
            pendingTool: savePlanTool(), editMode: .review, autoOpsUsed: 10, maxAutoOpsPerTurn: 10,
            truncatedPaths: [], isWholeFileRewrite: false, matchPath: nil,
            shouldAutoRunGitOp: { _ in false }
        )
        #expect(d == [.autoSavePlan], "a spent budget should not block save-plan — it isn't counted against it")
    }
}
