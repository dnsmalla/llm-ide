import Foundation

/// Wires the central skills kit into a LLM IDE project folder so Claude,
/// Cursor, Codex, `.agents`, and Gemini all discover the same SKILL.md
/// catalogue. Called by `ProjectStore` after scaffolding (or rebuilding) a
/// project's folders.
///
/// Tries the local server first — `POST /kb/project/install-skills` resolves
/// the central kit and runs its manifest-driven `install.sh` into the project
/// — then falls back to a project-local `.skills/scripts/install.sh` when the
/// project ships its own kit (e.g. the llm-ide repo itself). Always
/// best-effort and non-fatal: a project works without skills, so any failure
/// is logged to stderr and never propagates to the caller.
enum ProjectSkillsInstaller {

    /// Install skills into `projectPath` without throwing. Safe to call from
    /// project-open / rebuild paths where a skills failure must not block the
    /// user. Fire-and-forget: returns immediately, the work runs off the
    /// caller's flow.
    static func installBestEffort(projectPath: String, language: String, api: LlmIdeAPIClient?) {
        let path = projectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }

        Task { @MainActor in
            if let api,
               let result = try? await api.installProjectSkills(path: path, language: language),
               result.ok {
                return
            }
            // Server unavailable, rejected the path, or not wired up yet —
            // try a project-local install.sh before giving up entirely.
            if !runLocalInstallFallback(projectPath: path) {
                fputs("[ProjectSkillsInstaller] skills install skipped (server unreachable, no local kit)\n", stderr)
            }
        }
    }

    /// Best-effort: run `<projectPath>/.skills/scripts/install.sh` directly
    /// when the project ships its own central kit. Detached and unbuffered so
    /// it can never stall project-open on a full pipe. Returns true iff a
    /// fallback was actually launched.
    @discardableResult
    private static func runLocalInstallFallback(projectPath: String) -> Bool {
        let dir = URL(fileURLWithPath: projectPath)
        let installer = dir.appendingPathComponent(".skills/scripts/install.sh")
        guard FileManager.default.isExecutableFile(atPath: installer.path) else { return false }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = [installer.path]
        proc.currentDirectoryURL = dir
        // Discard output — a detached best-effort install must never block on
        // a full pipe buffer, and the canonical install path is the server.
        let devnull = FileHandle(forWritingAtPath: "/dev/null")
        proc.standardOutput = devnull
        proc.standardError = devnull
        do {
            try proc.run()
            return true
        } catch {
            fputs("[ProjectSkillsInstaller] local install.sh failed to launch: \(error.localizedDescription)\n", stderr)
            return false
        }
    }
}
