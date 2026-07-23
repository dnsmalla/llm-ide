import Foundation

/// Resolves on-disk paths to the Node backend (`server.mjs`). Used by
/// `BackendManager` and the Settings screens when the user hasn't pinned
/// a path manually.
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

    /// Skip dot-dirs, build output, and dependency trees during the shallow
    /// Desktop/Developer walk.
    private static func isJunk(_ name: String) -> Bool {
        name.hasPrefix(".")
            || name == "node_modules"
            || name == ".build"
            || name == "build"
    }
}
