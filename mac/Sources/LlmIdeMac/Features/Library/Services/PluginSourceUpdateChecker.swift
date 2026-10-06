import Foundation
import os.log

struct SourceCheckResult: Equatable {
    let status: PluginSourceComparison.SourceStatus
    /// Newest known version label: the marketplace entry's `version`, nil for git.
    let latest: String?
}

/// Detects newer versions of plugins installed from git or a marketplace.
/// Runs on the Mac because the server never fetches URLs (SSRF posture).
/// Every network call is bounded by `networkTimeout`.
actor PluginSourceUpdateChecker {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "PluginSourceUpdateChecker")
    static let networkTimeout: TimeInterval = 60

    /// Results keyed by plugin name; zip / unrecorded sources are omitted.
    func check(_ plugins: [(name: String, source: PluginInstallSource)]) async -> [String: SourceCheckResult] {
        var results: [String: SourceCheckResult] = [:]
        for plugin in plugins where plugin.source.kind == "git" {
            results[plugin.name] = await checkGit(plugin.source)
        }
        let groups = PluginSourceComparison.groupMarketplaces(plugins)
        let byName = Dictionary(plugins.map { ($0.name, $0.source) }, uniquingKeysWith: { first, _ in first })
        for (key, names) in groups {
            let sources = names.compactMap { name in byName[name].map { (name: name, source: $0) } }
            for (name, result) in await checkMarketplace(key, sources) { results[name] = result }
        }
        return results
    }

    private func checkGit(_ source: PluginInstallSource) async -> SourceCheckResult {
        guard let url = source.url, let installed = source.commit else {
            return SourceCheckResult(status: .unavailable("the install record is incomplete"), latest: nil)
        }
        guard (try? PluginGitInstaller.normalize(url)) != nil else {
            return SourceCheckResult(status: .unavailable("source URL is no longer valid"), latest: nil)
        }
        let ref = source.ref.flatMap { $0.isEmpty ? nil : $0 }
        let patterns = ref.map { ["refs/heads/\($0)", "refs/tags/\($0)", "refs/tags/\($0)^{}"] } ?? ["HEAD"]
        guard let out = await PluginGitInstaller.lsRemote(
            url: url, patterns: patterns, timeoutSec: Self.networkTimeout) else {
            return SourceCheckResult(status: .unavailable("could not reach the source"), latest: nil)
        }
        let remote = PluginSourceComparison.parseLsRemote(out, ref: ref)
        return SourceCheckResult(status: PluginSourceComparison.gitStatus(installed: installed, remote: remote),
                                 latest: nil)
    }

    /// One shallow clone for the whole group. Only the trees of the installed
    /// plugins' paths are computed (cheaper than `PluginMarketplace.fetch`,
    /// which hashes every entry); the manifest is parsed just for versions.
    private func checkMarketplace(
        _ key: PluginSourceComparison.MarketplaceKey,
        _ plugins: [(name: String, source: PluginInstallSource)]
    ) async -> [String: SourceCheckResult] {
        func all(_ result: SourceCheckResult) -> [String: SourceCheckResult] {
            Dictionary(plugins.map { ($0.name, result) }, uniquingKeysWith: { first, _ in first })
        }
        guard (try? PluginGitInstaller.normalize(key.url)) != nil else {
            return all(SourceCheckResult(status: .unavailable("source URL is no longer valid"), latest: nil))
        }
        let staged: PluginGitInstaller.StagedRepo
        do {
            staged = try await PluginGitInstaller.cloneKeepingRepo(
                url: key.url, ref: key.ref, timeoutSec: Self.networkTimeout)
        } catch {
            Self.log.error("marketplace clone failed: \(error.localizedDescription, privacy: .public)")
            return all(SourceCheckResult(status: .unavailable("could not reach the source"), latest: nil))
        }
        defer { staged.cleanup() }

        let manifest = staged.repoRoot.appendingPathComponent(".claude-plugin/marketplace.json")
        let versions: [String: String] = {
            guard let data = try? Data(contentsOf: manifest),
                  let parsed = try? PluginMarketplace.parse(data: data) else { return [:] }
            return Dictionary(parsed.entries.compactMap { entry in entry.version.map { (entry.name, $0) } },
                              uniquingKeysWith: { first, _ in first })
        }()

        var results: [String: SourceCheckResult] = [:]
        for plugin in plugins {
            guard let path = plugin.source.path, let installedTree = plugin.source.tree else {
                results[plugin.name] = SourceCheckResult(
                    status: .unavailable("the install record is incomplete"), latest: nil)
                continue
            }
            let current = await PluginGitInstaller.treeHash(at: path, in: staged.repoRoot)
            let entry = plugin.source.entry ?? plugin.name
            results[plugin.name] = SourceCheckResult(
                status: PluginSourceComparison.marketplaceStatus(installedTree: installedTree, currentTree: current),
                latest: current == nil ? nil : versions[entry])
        }
        return results
    }
}
