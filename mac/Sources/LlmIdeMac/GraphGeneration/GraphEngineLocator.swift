import Foundation
import GraphCore
import os

/// Finds graph engines provided by installed plugins.
///
/// Plugins are installed through Library → Plugins (the Mac app clones the git
/// repo itself — see `Services/PluginGitInstaller.swift` and
/// `Services/PluginMarketplace.swift` — then hands the bundle to the server,
/// which extracts it into the per-user plugin directory). A plugin advertises a
/// graph engine by dropping a `graph-engine.json` manifest at its root; nothing
/// else about the plugin system needs to change.
///
/// Discovery only reads a manifest. Nothing is executed here — a command runs
/// only when the app actually asks for a graph, through `PluginGraphEngine`.
public struct GraphEngineLocator {

    /// Manifest filename a plugin uses to declare a graph engine.
    public static let manifestName = "graph-engine.json"

    private static let log = Logger(subsystem: "com.llmide.macapp",
                                    category: "GraphEngineLocator")

    public init() {}

    /// Directories searched for plugins, most specific first.
    ///
    /// Mirrors `extension/plugins/loader.mjs`'s `defaultPluginDir()` so the app
    /// and the server agree on where plugins live.
    public static func pluginDirectories() -> [URL] {
        var roots: [URL] = []
        if let override = ProcessInfo.processInfo.environment["LLMIDE_PLUGIN_DIR"] {
            roots.append(URL(fileURLWithPath: override, isDirectory: true))
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let support = home.appendingPathComponent("Library/Application Support",
                                                  isDirectory: true)
        // Current name first, then the legacy one the loader still accepts.
        roots.append(support.appendingPathComponent("llm-ide/plugins", isDirectory: true))
        roots.append(support.appendingPathComponent("LLM IDE/plugins", isDirectory: true))
        return roots
    }

    /// Every engine declared by an installed plugin, in discovery order.
    public func installedEngines() -> [GraphEngine] {
        let fm = FileManager.default
        var engines: [GraphEngine] = []
        var claimedIdentifiers = Set<String>()

        for root in Self.pluginDirectories() {
            guard let entries = try? fm.contentsOfDirectory(
                at: root, includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]) else { continue }
            // Sorted so discovery order — and therefore which engine wins — is
            // stable rather than dependent on filesystem enumeration.
            for pluginDir in entries.sorted(by: { $0.path < $1.path }) {
                let manifestURL = pluginDir.appendingPathComponent(Self.manifestName)
                guard fm.fileExists(atPath: manifestURL.path) else { continue }
                guard let manifest = load(manifestURL, pluginDir: pluginDir) else { continue }
                // A plugin installed in a more specific directory shadows a
                // same-named one found later.
                guard claimedIdentifiers.insert(manifest.name).inserted else { continue }
                engines.append(PluginGraphEngine(manifest: manifest, root: pluginDir))
                Self.log.info("""
                    graph engine plugin: \(manifest.name, privacy: .public) \
                    at \(pluginDir.path, privacy: .public)
                    """)
            }
        }
        return engines
    }

    private func load(_ url: URL, pluginDir: URL) -> GraphEngineManifest? {
        do {
            let data = try Data(contentsOf: url)
            // Cap the read: a manifest is a few hundred bytes, and a plugin
            // should not be able to make discovery expensive.
            guard data.count <= 64 * 1024 else {
                Self.log.error("\(url.path, privacy: .public): manifest too large")
                return nil
            }
            let manifest = try JSONDecoder().decode(GraphEngineManifest.self, from: data)
            try manifest.validate()
            return manifest
        } catch {
            // A malformed manifest is skipped, never fatal — one bad plugin
            // must not stop the others being found.
            Self.log.error("""
                \(url.path, privacy: .public): ignoring engine manifest — \
                \(String(describing: error), privacy: .public)
                """)
            return nil
        }
    }
}

/// A plugin's `graph-engine.json`.
///
/// The contract is deliberately a **subprocess plus canonical JSON**, not a
/// Swift interface: that keeps the engine's own language its business. graph-kit
/// can supply a Node CLI, a Python scanner, or a compiled binary and the app
/// neither knows nor cares, because the wire format is the canonical graph
/// schema that already exists (`graph-kit/schema/graph.schema.json`).
public struct GraphEngineManifest: Codable, Sendable {
    /// Contract version. Bump when the command set or wire format changes.
    let schemaVersion: Int
    /// Plugin-unique identifier, used as the engine identifier.
    let name: String
    let displayName: String?
    /// Extensions this engine treats as documents. Defaults to the shared
    /// convention when absent.
    let docExtensions: [String]?
    let commands: Commands

    struct Commands: Codable, Sendable {
        /// Required: code → canonical graph JSON.
        let scanCode: Invocation
        /// Required: docs → canonical graph JSON plus chunks.
        let docMemory: Invocation
        /// Optional: join the two tracks with doc→code cross-links. When a
        /// plugin omits it the app falls back to a plain union, which is
        /// correct but carries no cross-links — see `PluginGraphEngine.merge`.
        let merge: Invocation?
    }

    struct Invocation: Codable, Sendable {
        /// Executable. A relative path resolves inside the plugin directory;
        /// a bare name (`node`, `python3`) resolves on `PATH`.
        let command: String
        /// Arguments, with `{repo}`, `{roots}`, `{code}`, `{doc}`, `{chunks}`
        /// and `{out}` substituted at call time.
        let args: [String]
        /// Seconds before the run is abandoned. Clamped to a sane range.
        let timeoutSeconds: Int?

        enum CodingKeys: String, CodingKey { case command, args, timeoutSeconds }

        /// Trimmed at decode so `validate()` and `resolveExecutable` see the
        /// same string — otherwise `" node"` passed validation, which checks
        /// the trimmed form, and then failed at exec, which used the raw one.
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            command = try container.decode(String.self, forKey: .command)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            args = try container.decodeIfPresent([String].self, forKey: .args) ?? []
            timeoutSeconds = try container.decodeIfPresent(Int.self, forKey: .timeoutSeconds)
        }
    }

    enum ManifestError: Error, LocalizedError {
        case unsupportedSchema(Int)
        case badName(String)
        case emptyCommand(String)
        case escapesPlugin(String, String)

        var errorDescription: String? {
            switch self {
            case let .unsupportedSchema(version):
                return "graph-engine.json schemaVersion \(version) is not supported "
                    + "(this app understands \(GraphEngineManifest.supportedSchemaVersion))"
            case let .badName(name):
                return "engine name '\(name)' is not a plain identifier"
            case let .emptyCommand(which):
                return "command '\(which)' has no executable"
            case let .escapesPlugin(which, command):
                return "command '\(which)' (\(command)) points outside the plugin directory"
            }
        }
    }

    static let supportedSchemaVersion = 1

    func validate() throws {
        guard schemaVersion == Self.supportedSchemaVersion else {
            throw ManifestError.unsupportedSchema(schemaVersion)
        }
        // Character-set check rather than a regex. `^…$` in ICU matches before
        // a trailing line terminator, so `"abc\n"` passed the old anchored
        // pattern — defeating the very guarantee it was there to give. It also
        // rejected legitimate one-character names.
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-")
        guard let first = name.first, first.isLowercase, first.isLetter,
              name.count <= 41,
              name.allSatisfy({ allowed.contains($0) })
        else { throw ManifestError.badName(name) }

        for (label, invocation) in [("scanCode", commands.scanCode),
                                    ("docMemory", commands.docMemory)]
            + (commands.merge.map { [("merge", $0)] } ?? []) {
            let command = invocation.command.trimmingCharacters(in: .whitespaces)
            if command.isEmpty { throw ManifestError.emptyCommand(label) }
            // A relative command must stay inside the plugin. `..` is rejected
            // outright: `resolveExecutable` also refuses to run an escaped
            // path, but validation previously *claimed* containment while
            // checking nothing, and `"../../../../../../bin/sh"` standardised
            // straight to `/bin/sh`.
            if !command.hasPrefix("/"),
               command.split(separator: "/").contains("..") {
                throw ManifestError.escapesPlugin(label, command)
            }
        }
    }

    var resolvedDocExtensions: Set<String> {
        guard let docExtensions, !docExtensions.isEmpty else {
            return DocExtensions.markdownAndText
        }
        return Set(docExtensions.map { $0.lowercased() })
    }
}
