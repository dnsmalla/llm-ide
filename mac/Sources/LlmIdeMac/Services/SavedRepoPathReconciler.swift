import Foundation

/// One-shot startup repair for a saved GitHub/GitLab repo whose `localPath`
/// is nil even though its clone already exists on disk — e.g. cloned
/// manually outside the app, or the app quit between `git clone` finishing
/// and the config write persisting (`GitHubSettingsSection.cloneOrSync` sets
/// `localPath` as a separate step after the clone completes). Without this,
/// `isCloned` (computed from `localPath != nil`) stays false forever, so
/// `ReviewView.linkedCodeRepo` / `CodeWorkflowTarget` report no linked repo
/// even though the code is right there and visible in Explorer.
enum SavedRepoPathReconciler {

    /// Compares two remote URLs ignoring scheme, "www.", trailing slash, and
    /// a trailing ".git" — the same repo reads identically as
    /// "https://github.com/a/b", "https://github.com/a/b.git", or
    /// "git@github.com:a/b.git" for this purpose... except SSH remotes use a
    /// different host separator, so this only normalises the HTTPS forms
    /// this app saves URLs in; that's the only form `GitHubSettingsSection`/
    /// `GitLabSettingsSection` ever store.
    static func remoteMatches(repoURL: String, remoteURL: String) -> Bool {
        func normalize(_ s: String) -> String {
            var t = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if let r = t.range(of: "://") { t = String(t[r.upperBound...]) }
            if t.hasPrefix("www.") { t.removeFirst(4) }
            if t.hasSuffix(".git") { t.removeLast(4) }
            while t.hasSuffix("/") { t.removeLast() }
            return t
        }
        let a = normalize(repoURL)
        return !a.isEmpty && a == normalize(remoteURL)
    }

    /// Searches `candidateDirs` (checked in order) for a folder named `name`
    /// whose git origin remote matches `url`. Returns the first match's path,
    /// or nil if none of the candidates exist or match. `remoteURL` is
    /// injected so this stays testable without shelling out to real git.
    static func findExistingClone(
        name: String,
        url: String,
        candidateDirs: [URL],
        remoteURL: (URL) async throws -> String
    ) async -> String? {
        guard !name.isEmpty else { return nil }
        for base in candidateDirs {
            let candidate = base.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: candidate.path) else { continue }
            guard let remote = try? await remoteURL(candidate) else { continue }
            if remoteMatches(repoURL: url, remoteURL: remote) {
                return candidate.path
            }
        }
        return nil
    }
}
