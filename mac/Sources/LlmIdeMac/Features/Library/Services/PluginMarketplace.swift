import Foundation
import os.log

/// Reads a Claude-format plugin **marketplace** — a Git repo whose
/// `.claude-plugin/marketplace.json` lists several plugins — and packages any
/// one of them for the existing install endpoint.
///
/// The clone happens CLIENT-side, like `PluginGitInstaller`, because the server
/// deliberately fetches no URLs (its SSRF posture, documented in
/// `extension/plugins/installer.mjs`). Nothing here talks to the server: it
/// produces a zip, and the caller hands that to `installPlugin(zipURL:)`.
enum PluginMarketplace {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "PluginMarketplace")

    /// One plugin a marketplace offers.
    struct Entry: Identifiable, Equatable {
        let name: String
        let description: String
        let version: String?
        /// Path of the plugin inside the cloned repo, relative to its root.
        let relativePath: String
        var id: String { name }
    }

    /// A cloned marketplace, ready to install from. `cleanup` removes the
    /// clone; the caller owns it.
    struct Staged {
        let marketplaceName: String
        let entries: [Entry]
        /// Entries that were listed but cannot be installed from here, with the
        /// reason — shown rather than silently dropped.
        let skipped: [String]
        let repoRoot: URL
        let cleanup: () -> Void
        /// The URL that was cloned, the ref asked for (nil = default branch) and
        /// the commit checked out — the marketplace half of each install's
        /// provenance. Defaulted so a hand-built `Staged` (tests) stays short.
        var url: String = ""
        var ref: String?
        var commit: String = ""
        /// Tree hash of each entry's directory at `commit`, keyed by the entry's
        /// recordable path. Read at fetch time because `.git` is dropped before
        /// anything is zipped out of the clone.
        var trees: [String: String] = [:]

        /// The provenance to send when installing `entry` from this marketplace.
        /// Throws when it cannot be expressed under the server's rules (e.g. a
        /// plugin at the repository root, path `.`, or a name the server's entry
        /// pattern refuses): the caller then installs without a record.
        func source(for entry: Entry) throws -> PluginInstallSource {
            guard let path = PluginMarketplace.recordablePath(entry.relativePath) else {
                throw MarketplaceError.unrecordable("\(entry.name): its path cannot be recorded")
            }
            guard let tree = trees[path] else {
                throw MarketplaceError.unrecordable("\(entry.name): no tree hash for \(path)")
            }
            let trimmedRef = ref?.trimmingCharacters(in: .whitespacesAndNewlines)
            // `version` is only a display label from the (untrusted) manifest:
            // when it alone breaks the server's rules, drop it rather than lose
            // the tree/commit the update check depends on.
            let version = entry.version.flatMap { PluginInstallSource.validVersion($0) ? $0 : nil }
            let source = PluginInstallSource.marketplace(
                url: url, ref: (trimmedRef?.isEmpty ?? true) ? nil : trimmedRef, commit: commit,
                entry: entry.name, path: path, tree: tree, version: version)
            guard source.isServerAcceptable else {
                throw MarketplaceError.unrecordable("\(entry.name): source would be refused by the server")
            }
            return source
        }
    }

    enum MarketplaceError: LocalizedError {
        case noManifest
        case badManifest(String)
        case noPlugins
        case unknownPlugin(String)
        case unrecordable(String)

        var errorDescription: String? {
            switch self {
            case .noManifest:
                return "That repository has no .claude-plugin/marketplace.json — it is not a plugin marketplace."
            case .badManifest(let why):
                return "Could not read marketplace.json: \(why)"
            case .noPlugins:
                return "That marketplace lists no installable plugins."
            case .unknownPlugin(let name):
                return "Plugin '\(name)' is not in this marketplace."
            case .unrecordable(let why):
                return "Install source not recorded — \(why)."
            }
        }
    }

    /// Clone a marketplace repo and read what it offers. The clone is kept
    /// (unlike `PluginGitInstaller.cloneAndZip`) because installing a plugin
    /// from it means zipping one of its subdirectories afterwards.
    static func fetch(url rawURL: String, ref: String? = nil) async throws -> Staged {
        let staged = try await PluginGitInstaller.cloneKeepingRepo(url: rawURL, ref: ref)
        let manifestURL = staged.repoRoot
            .appendingPathComponent(".claude-plugin", isDirectory: true)
            .appendingPathComponent("marketplace.json")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            staged.cleanup()
            throw MarketplaceError.noManifest
        }
        let data: Data
        do { data = try Data(contentsOf: manifestURL) }
        catch {
            staged.cleanup()
            throw MarketplaceError.badManifest(error.localizedDescription)
        }
        let parsed: Parsed
        do { parsed = try parse(data: data) }
        catch {
            staged.cleanup()
            throw error
        }
        if parsed.entries.isEmpty {
            staged.cleanup()
            throw MarketplaceError.noPlugins
        }
        // Tree hashes need `.git`; read them all now, then drop it so no zip made
        // from this clone (a root-level plugin included) carries history.
        var trees: [String: String] = [:]
        for entry in parsed.entries {
            guard let path = recordablePath(entry.relativePath), trees[path] == nil else { continue }
            if let tree = await PluginGitInstaller.treeHash(at: path, in: staged.repoRoot) {
                trees[path] = tree
            }
        }
        PluginGitInstaller.dropGitDir(of: staged.repoRoot)
        return Staged(marketplaceName: parsed.name, entries: parsed.entries, skipped: parsed.skipped,
                      repoRoot: staged.repoRoot, cleanup: staged.cleanup,
                      url: staged.normalizedURL, ref: ref, commit: staged.commit, trees: trees)
    }

    /// An entry path in the form the server records: leading `./` stripped,
    /// trailing `/` trimmed, and nil when what is left breaks the server's path
    /// rule (empty or `.` = the repository root, `..`, a backslash, …).
    static func recordablePath(_ relativePath: String) -> String? {
        var path = relativePath
        while path.hasPrefix("./") { path.removeFirst(2) }
        while path.hasSuffix("/") { path.removeLast() }
        return PluginInstallSource.validPath(path) ? path : nil
    }

    /// Zip one plugin out of a cloned marketplace, ready for the install
    /// endpoint. The zip's root is the plugin directory itself, which the
    /// server accepts (manifest at root or in a single top-level dir).
    static func package(_ entry: Entry, from staged: Staged) async throws -> URL {
        let pluginDir = try resolve(entry.relativePath, inside: staged.repoRoot)
        let zipURL = staged.repoRoot.deletingLastPathComponent()
            // Not `entry.name`: it comes from the cloned (untrusted) manifest, and a
            // name holding `/` or `..` would write the zip outside this folder. The
            // installer reads the plugin's real name from its own manifest anyway.
            .appendingPathComponent("plugin-\(UUID().uuidString).zip")
        try await PluginGitInstaller.zipDirectory(pluginDir, to: zipURL)
        return zipURL
    }

    // MARK: - Parsing (pure — this is where the tests live)

    struct Parsed: Equatable {
        let name: String
        let entries: [Entry]
        let skipped: [String]
    }

    /// Parse a `marketplace.json` body.
    ///
    /// Only plugins whose `source` is a path INSIDE the repo are offered: a
    /// marketplace entry pointing at another Git URL would need its own clone,
    /// and one pointing outside the tree (`../`, an absolute path) is refused
    /// outright rather than followed.
    static func parse(data: Data) throws -> Parsed {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw MarketplaceError.badManifest("not a JSON object")
        }
        let name = (root["name"] as? String) ?? "marketplace"
        guard let plugins = root["plugins"] as? [[String: Any]] else {
            throw MarketplaceError.badManifest("no plugins array")
        }
        var entries: [Entry] = []
        var skipped: [String] = []
        for plugin in plugins {
            guard let pluginName = plugin["name"] as? String, !pluginName.isEmpty else {
                skipped.append("an entry with no name")
                continue
            }
            // `source` may be a relative path, or an object/URL form this
            // client does not follow.
            let relative: String?
            switch plugin["source"] {
            case let path as String:
                relative = path
            case nil:
                // Convention when omitted: ./plugins/<name>.
                relative = "./plugins/\(pluginName)"
            default:
                relative = nil
            }
            guard let source = relative else {
                skipped.append("\(pluginName): source form not supported here")
                continue
            }
            if source.contains("://") || source.hasPrefix("git@") {
                skipped.append("\(pluginName): lives in another repository")
                continue
            }
            let cleaned = source.hasPrefix("./") ? String(source.dropFirst(2)) : source
            if cleaned.hasPrefix("/") || cleaned.split(separator: "/").contains("..") {
                skipped.append("\(pluginName): source path escapes the repository")
                continue
            }
            entries.append(Entry(
                name: pluginName,
                description: (plugin["description"] as? String) ?? "",
                version: plugin["version"] as? String,
                relativePath: cleaned
            ))
        }
        return Parsed(name: name, entries: entries, skipped: skipped)
    }

    /// Resolve a relative plugin path and prove it stayed inside the clone.
    static func resolve(_ relativePath: String, inside root: URL) throws -> URL {
        // Resolve symlinks too: a lexical check passes `plugins/x` even when `x`
        // is a link to a directory outside the clone.
        let candidate = root.appendingPathComponent(relativePath).standardizedFileURL.resolvingSymlinksInPath()
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        guard candidate.path == base.path || candidate.path.hasPrefix(base.path + "/") else {
            throw MarketplaceError.badManifest("plugin path escapes the repository")
        }
        // Fail closed on a path that cannot be resolved: `resolvingSymlinksInPath`
        // leaves a missing path as written, so a link further up would go unseen.
        guard FileManager.default.fileExists(atPath: candidate.path) else {
            throw MarketplaceError.badManifest("plugin path not found in the repository")
        }
        return candidate
    }
}
