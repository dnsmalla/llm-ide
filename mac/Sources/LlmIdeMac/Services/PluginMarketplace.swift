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
    }

    enum MarketplaceError: LocalizedError {
        case noManifest
        case badManifest(String)
        case noPlugins
        case unknownPlugin(String)

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
        return Staged(marketplaceName: parsed.name, entries: parsed.entries, skipped: parsed.skipped,
                      repoRoot: staged.repoRoot, cleanup: staged.cleanup)
    }

    /// Zip one plugin out of a cloned marketplace, ready for the install
    /// endpoint. The zip's root is the plugin directory itself, which the
    /// server accepts (manifest at root or in a single top-level dir).
    static func package(_ entry: Entry, from staged: Staged) async throws -> URL {
        let pluginDir = try resolve(entry.relativePath, inside: staged.repoRoot)
        let zipURL = staged.repoRoot.deletingLastPathComponent()
            .appendingPathComponent("\(entry.name).zip")
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
        let candidate = root.appendingPathComponent(relativePath).standardizedFileURL
        let base = root.standardizedFileURL
        guard candidate.path == base.path || candidate.path.hasPrefix(base.path + "/") else {
            throw MarketplaceError.badManifest("plugin path escapes the repository")
        }
        return candidate
    }
}
