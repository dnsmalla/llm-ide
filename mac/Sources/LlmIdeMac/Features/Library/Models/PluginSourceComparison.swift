import Foundation

/// Pure decisions for "is there a newer version at the plugin's origin?".
/// No I/O: the checker feeds in what it fetched.
enum PluginSourceComparison {
    enum SourceStatus: Equatable {
        case upToDate
        case updateAvailable
        case unavailable(String)
    }

    struct MarketplaceKey: Hashable {
        let url: String
        let ref: String?
    }

    /// Pick the commit for `ref` out of `git ls-remote` output. Precedence: the
    /// peeled tag (`refs/tags/<ref>^{}`, the commit an annotated tag points at)
    /// over the tag object, then the branch, then a lightweight tag; with no
    /// ref, the `HEAD` line. Returns 40-hex or nil.
    static func parseLsRemote(_ out: String, ref: String?) -> String? {
        var byName: [String: String] = [:]
        for line in out.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: true)
            guard parts.count == 2 else { continue }
            let sha = String(parts[0])
            guard PluginInstallSource.isSHA(sha) else { continue }
            byName[String(parts[1]).trimmingCharacters(in: .whitespaces)] = sha
        }
        guard let ref, !ref.isEmpty else { return byName["HEAD"] }
        return byName["refs/tags/\(ref)^{}"] ?? byName["refs/heads/\(ref)"] ?? byName["refs/tags/\(ref)"]
    }

    static func gitStatus(installed: String, remote: String?) -> SourceStatus {
        guard let remote else { return .unavailable("the ref was not found at the source") }
        return remote == installed ? .upToDate : .updateAvailable
    }

    /// Compares tree hashes, not commits: a new commit that leaves the plugin's
    /// directory untouched is not an update.
    static func marketplaceStatus(installedTree: String, currentTree: String?) -> SourceStatus {
        guard let currentTree else { return .unavailable("not in the marketplace any more") }
        return currentTree == installedTree ? .upToDate : .updateAvailable
    }

    /// Plugin names grouped by the marketplace (url, ref) they came from, so one
    /// clone serves the whole group. Non-marketplace sources are ignored.
    static func groupMarketplaces(_ items: [(name: String, source: PluginInstallSource)]) -> [MarketplaceKey: [String]] {
        var groups: [MarketplaceKey: [String]] = [:]
        for item in items where item.source.kind == "marketplace" {
            guard let url = item.source.url else { continue }
            groups[MarketplaceKey(url: url, ref: item.source.ref), default: []].append(item.name)
        }
        return groups
    }
}
