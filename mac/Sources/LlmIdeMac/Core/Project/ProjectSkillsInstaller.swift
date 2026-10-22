import Foundation

/// Wires the central skills kit into a LLM-IDE project folder so Claude,
/// Cursor, Codex, `.agents`, and Gemini all discover the same SKILL.md
/// catalogue. Called by `ProjectStore` after scaffolding (or rebuilding) a
/// project's folders.
///
/// The ONLY install path is the local server — `POST /kb/project/install-skills`
/// resolves the CENTRAL kit and runs its manifest-driven `install.sh` into
/// the project. There used to be a fallback that ran the opened project's own
/// `.skills/scripts/install.sh` via bash whenever the server call failed
/// (backend still starting at launch, an older server, a rejected path).
/// `ensureProjectScaffold` runs right after a clone and `openFolder` on every
/// switch, so cloning or opening any repository that shipped that file
/// executed its code with no confirmation. Removed: a project must never be
/// able to run code just by being opened. Best-effort and non-fatal — a
/// project works without skills; the next open or rebuild retries.
enum ProjectSkillsInstaller {

    /// Install skills into `projectPath` without throwing. Safe to call from
    /// project-open / rebuild paths where a skills failure must not block the
    /// user. Fire-and-forget: returns immediately, the work runs off the
    /// caller's flow.
    static func installBestEffort(projectPath: String, language: String, api: LlmIdeAPIClient?) {
        let path = projectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }

        Task { @MainActor in
            guard let api else {
                fputs("[ProjectSkillsInstaller] skills install skipped (no API client)\n", stderr)
                return
            }
            do {
                let result = try await api.installProjectSkills(path: path, language: language)
                if !result.ok {
                    fputs("[ProjectSkillsInstaller] skills install declined by server for \(path)\n", stderr)
                }
            } catch {
                fputs("[ProjectSkillsInstaller] skills install skipped (server unreachable: \(error.localizedDescription))\n", stderr)
            }
        }
    }
}
