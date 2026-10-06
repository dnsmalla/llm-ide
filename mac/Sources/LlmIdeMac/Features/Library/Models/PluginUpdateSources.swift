import Foundation

/// Pure decisions behind the update center's git / marketplace checks and its
/// merged update list — kept out of the center so they are testable.
enum PluginUpdateSources {
    typealias Tracked = [(name: String, source: PluginInstallSource)]

    /// Installed plugins whose record names a git or marketplace origin.
    static func tracked(_ plugins: [String: PluginInfo]) -> Tracked {
        plugins.values
            .compactMap { info in info.installSource.map { (name: info.name, source: $0) } }
            .filter { $0.source.kind == "git" || $0.source.kind == "marketplace" }
            .sorted { $0.name < $1.name }
    }

    /// Whether a source check is due: forced, never run, older than `ttl`, or a
    /// tracked plugin the last check did not cover (a check of one plugin must
    /// not stamp the TTL for all of them).
    static func isDue(tracked: Set<String>, checked: Set<String>, lastCheck: Date?,
                      now: Date, ttl: TimeInterval, force: Bool) -> Bool {
        guard !tracked.isEmpty else { return false }
        if force { return true }
        guard let lastCheck, now.timeIntervalSince(lastCheck) < ttl else { return true }
        return !tracked.isSubset(of: checked)
    }

    /// The update rows and per-plugin failure messages one source check yields.
    static func outcome(_ answered: [String: SourceCheckResult], tracked: Tracked)
        -> (entries: [PluginUpdateEntry], failures: [String: String]) {
        var found: [PluginUpdateEntry] = []
        var failures: [String: String] = [:]
        for (name, source) in tracked {
            guard let answer = answered[name] else { continue }
            switch answer.status {
            case .updateAvailable:
                found.append(PluginUpdateEntry(
                    name: name, pluginId: nil, importedVersion: source.version, claudeVersion: nil,
                    latest: answer.latest, tier: "upstream", source: source.kind))
            case .unavailable(let reason):
                failures[name] = PluginUpdatePresentation.sourceCheckFailedMessage(name: name, reason: reason)
            case .upToDate:
                break
            }
        }
        return (found, failures)
    }

    /// The list the Library shows. A source row survives only for a plugin
    /// still installed from that source; a vendor row only for a plugin that
    /// updates through its vendor (or one the center has not listed yet) —
    /// otherwise it would be a badge, and an "Update all" entry, that can
    /// only ever fail.
    static func merge(vendor: [PluginUpdateEntry], source: [PluginUpdateEntry],
                      plugins: [String: PluginInfo], oneClick: Bool) -> [PluginUpdateEntry] {
        let trackedNames = Set(tracked(plugins).map(\.name))
        let vendorRows = vendor.filter { entry in
            guard let info = plugins[entry.name] else { return true }
            switch PluginUpdatePresentation.action(for: info, entry: entry, oneClick: oneClick) {
            case .claudeOneClick, .reimportClaude, .reimportCodex: return true
            default: return false
            }
        }
        return vendorRows + source.filter { trackedNames.contains($0.name) }
    }
}
