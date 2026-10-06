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

@Test func lsRemotePrefersBranchOverSameNameTag() {
    // `git clone --branch x` checks out the branch when both exist.
    let out = "\(shaA)\trefs/tags/x\n\(shaP)\trefs/tags/x^{}\n\(shaB)\trefs/heads/x\n"
    #expect(PluginSourceComparison.parseLsRemote(out, ref: "x") == shaB)
    let lightweight = "\(shaA)\trefs/tags/v2\n"
    #expect(PluginSourceComparison.parseLsRemote(lightweight, ref: "v2") == shaA)
}

@Test func lsRemoteToleratesCRLFAndMalformedLines() {
    let out = "\(shaA)\tHEAD\r\n\(shaB)\trefs/heads/main\r\n"
        + "garbage\n\("z" + String(repeating: "b", count: 39))\trefs/heads/dev\n\(shaP)\t\n\tHEAD\n"
    #expect(PluginSourceComparison.parseLsRemote(out, ref: "main") == shaB)
    #expect(PluginSourceComparison.parseLsRemote(out, ref: nil) == shaA)
    #expect(PluginSourceComparison.parseLsRemote(out, ref: "dev") == nil)
}

@Test func marketplaceRecordWithoutUrlIsReportedNotDropped() {
    var broken = PluginInstallSource.marketplace(
        url: "https://h/mp.git", ref: nil, commit: shaA, entry: "x", path: "plugins/x", tree: shaA, version: nil)
    broken.url = nil
    let items: [(name: String, source: PluginInstallSource)] = [("x", broken)]
    #expect(PluginSourceComparison.groupMarketplaces(items).isEmpty)
    #expect(PluginSourceComparison.incompleteMarketplaces(items) == ["x"])
}
