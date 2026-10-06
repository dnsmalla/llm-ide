import Testing
@testable import LlmIdeMacLib

private let shaA = String(repeating: "a", count: 40)
private let shaB = String(repeating: "b", count: 40)
private let shaP = String(repeating: "c", count: 40)

@Test func lsRemotePicksBranchPeeledTagOrHead() {
    let out = "\(shaA)\tHEAD\n\(shaB)\trefs/heads/main\n\(shaA)\trefs/tags/v1\n\(shaP)\trefs/tags/v1^{}\n"
    #expect(PluginSourceComparison.parseLsRemote(out, ref: "main") == shaB)
    #expect(PluginSourceComparison.parseLsRemote(out, ref: "v1") == shaP)
    #expect(PluginSourceComparison.parseLsRemote(out, ref: nil) == shaA)
    #expect(PluginSourceComparison.parseLsRemote(out, ref: "gone") == nil)
}

@Test func sourceStatuses() {
    #expect(PluginSourceComparison.gitStatus(installed: shaA, remote: shaA) == .upToDate)
    #expect(PluginSourceComparison.gitStatus(installed: shaA, remote: shaB) == .updateAvailable)
    if case .unavailable = PluginSourceComparison.gitStatus(installed: shaA, remote: nil) {
    } else {
        Issue.record("missing ref reports a reason")
    }
    #expect(PluginSourceComparison.marketplaceStatus(installedTree: shaA, currentTree: shaA) == .upToDate)
    #expect(PluginSourceComparison.marketplaceStatus(installedTree: shaA, currentTree: shaB) == .updateAvailable)
    if case .unavailable = PluginSourceComparison.marketplaceStatus(installedTree: shaA, currentTree: nil) {
    } else {
        Issue.record("missing path reports a reason")
    }
}

@Test func groupsMarketplacesByUrlAndRef() {
    let first = PluginInstallSource.marketplace(
        url: "https://h/mp.git", ref: nil, commit: shaA, entry: "x", path: "plugins/x", tree: shaA, version: nil)
    let second = PluginInstallSource.marketplace(
        url: "https://h/mp.git", ref: nil, commit: shaA, entry: "y", path: "plugins/y", tree: shaB, version: nil)
    let other = PluginInstallSource.marketplace(
        url: "https://h/mp.git", ref: "dev", commit: shaA, entry: "z", path: "plugins/z", tree: shaB, version: nil)
    let zip = PluginInstallSource.zip(fileName: "a.zip")
    let groups = PluginSourceComparison.groupMarketplaces([("x", first), ("y", second), ("z", other), ("q", zip)])
    #expect(groups.count == 2)
    #expect(groups[.init(url: "https://h/mp.git", ref: nil)]?.sorted() == ["x", "y"])
}
