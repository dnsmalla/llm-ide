import Foundation

/// Resolves on-disk paths to the Node backend (`server.mjs`) and the
/// external mobile computer-agent. Used by `BackendManager`,
/// `MobileControlManager`, and the Settings screens when the user hasn't
/// pinned a path manually.
///
/// Pure filesystem search — no shelling out — and bounded so a sprawling
/// home directory can't stall app launch. Mirrors the candidate-list +
/// validate-and-repair approach `BackendManager` uses internally.
enum LaunchPathResolver {

    // MARK: - Backend (server.mjs)

    /// Broader fallback for `BackendManager.resolveLaunchPaths`: find a
    /// folder that contains `server.mjs`. `BackendManager.defaultProjectFolders()`
    /// already covers the canonical clone locations, so this walks one level
    /// under `~/Desktop` and `~/Developer` to catch renames, forks, and ad-hoc
    /// clones. Returns the **directory** containing `server.mjs`, not the file.
    static func findServerDirectory() -> String? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let roots = [
            home.appendingPathComponent("Desktop"),
            home.appendingPathComponent("Developer"),
        ]
        for root in roots {
            guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { continue }
            for name in names where !isJunk(name) {
                // <root>/<name>/extension/server.mjs  — monorepo layout (llm-ide)
                let monorepo = root
                    .appendingPathComponent(name)
                    .appendingPathComponent("extension")
                    .appendingPathComponent("server.mjs")
                if fm.fileExists(atPath: monorepo.path) {
                    return monorepo.deletingLastPathComponent().path
                }
                // <root>/<name>/server.mjs  — flat layout
                let flat = root.appendingPathComponent(name).appendingPathComponent("server.mjs")
                if fm.fileExists(atPath: flat.path) {
                    return flat.deletingLastPathComponent().path
                }
            }
        }
        return nil
    }

    // MARK: - Mobile computer-agent

    /// Validate-and-repair `config.mobileControlAgentPath`. A stored path
    /// that no longer looks like the agent (the folder moved/was renamed) is
    /// re-detected from the known `auto_swift_aicontrol` install locations
    /// rather than trusted blindly — same contract as
    /// `BackendManager.resolveLaunchPaths`.
    static func resolveMobileAgentPath(config: AppConfig) {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser

        let current = config.mobileControlAgentPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if !current.isEmpty && looksLikeAgent(current) { return }

        let candidates = [
            home.appendingPathComponent("Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent"),
            home.appendingPathComponent("Developer/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent"),
        ]
        for candidate in candidates where looksLikeAgent(candidate.path) {
            config.mobileControlAgentPath = candidate.path
            return
        }
    }

    /// True iff `dir` contains both `package.json` and `src/index.ts` — the
    /// computer-agent's entry shape. Used to validate a stored path so a
    /// moved/renamed folder is re-detected, not silently trusted.
    private static func looksLikeAgent(_ dir: String) -> Bool {
        let fm = FileManager.default
        let url = URL(fileURLWithPath: dir)
        return fm.fileExists(atPath: url.appendingPathComponent("package.json").path)
            && fm.fileExists(atPath: url.appendingPathComponent("src/index.ts").path)
    }

    /// Skip dot-dirs, build output, and dependency trees during the shallow
    /// Desktop/Developer walk.
    private static func isJunk(_ name: String) -> Bool {
        name.hasPrefix(".")
            || name == "node_modules"
            || name == ".build"
            || name == "build"
    }
}
