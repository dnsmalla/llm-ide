import Foundation
import SharedProtocol

/// Serves `scm_status_list` / `scm_diff`: a read-only view of the active project's git tree.
/// All git work is `PhoneGit`; this class only resolves the working tree, checks the Phone access
/// switch on every request, and replies.
@MainActor
final class MobileSourceControlBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?

    init(manager: MobileControlManager) { self.manager = manager }

    func handle(type: String, data: Data?) -> Bool {
        switch type {
        case MobileProtocol.Tag.scmStatusList:
            Task { @MainActor [weak self] in await self?.sendState() }
            return true
        case MobileProtocol.Tag.scmDiff:
            guard let req = try? manager?.decoder.decode(ScmDiffRequest.self, from: data ?? Data()) else {
                manager?.reply(ScmDiffResult(path: "", staged: false, diff: nil, error: "The Mac could not read this request."))
                return true
            }
            Task { @MainActor [weak self] in await self?.sendDiff(req) }
            return true
        default:
            return false
        }
    }
    func installPushObservers() {}
    func removePushObservers() {}

    private var gitRoot: URL? {
        guard let config = manager?.config, let store = manager?.projectStore else { return nil }
        return WorkspaceRoot.gitWorkingTree(config: config, projectStore: store)
    }

    private func denied() -> Bool { manager?.phoneAccess.isAllowed(.sourceControlRead) != true }

    private func runner(_ root: URL) -> GitRun {
        { args in try await RepoManager().runGit(args, at: root) }
    }

    private func sendState() async {
        guard let manager else { return }
        if denied() {
            manager.reply(ScmState(isRepo: false, branch: nil, ahead: 0, behind: 0, hasUpstream: false, files: [],
                                   filesTruncated: false, commits: [], error: PhoneAccess.sourceControlRead.deniedMessage))
            return
        }
        guard let root = gitRoot else {
            manager.reply(ScmState(isRepo: false, branch: nil, ahead: 0, behind: 0, hasUpstream: false, files: [],
                                   filesTruncated: false, commits: [], error: nil))
            return
        }
        let hasGit = FileManager.default.fileExists(atPath: root.appendingPathComponent(".git").path)
        manager.reply(await PhoneGit.state(hasGitDir: hasGit, run: runner(root)))
    }

    private func sendDiff(_ req: ScmDiffRequest) async {
        guard let manager else { return }
        if denied() {
            manager.reply(ScmDiffResult(path: req.path, staged: req.staged, diff: nil,
                                        error: PhoneAccess.sourceControlRead.deniedMessage))
            return
        }
        guard let root = gitRoot else {
            manager.reply(ScmDiffResult(path: req.path, staged: req.staged, diff: nil, error: "No git project is open on the Mac."))
            return
        }
        manager.reply(await PhoneGit.diff(path: req.path, staged: req.staged, root: root, run: runner(root)))
    }
}
