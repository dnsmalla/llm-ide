import Foundation

/// Directory names the file walkers below must never descend into: the usual
/// vendor/build noise, plus the indexer's OWN generated-knowledge output
/// (`.code-notes`, `.understand-anything`, `graphify-out`, `system` — i.e.
/// `system/graph/…`).
///
/// Walking the generated-output directories re-discovers the indexer's own
/// previous output as new input. For a project under git, `git ls-files`
/// already excludes them via `.gitignore` and this set is never consulted —
/// but every walker here also has a plain-`FileManager` fallback for when git
/// is unavailable (no `.git`, no `git` binary, `git ls-files` fails), and
/// that fallback is the ONLY listing mechanism for a non-git project. Missing
/// this exclusion there means each indexing run re-mirrors the previous run's
/// output one level deeper — `system/graph/system/graph/…` — an unbounded,
/// self-referential blow-up with no cap, confirmed in the field at 22 levels
/// deep / 644 files for a non-git project.
///
/// One shared set so a fix can't land in one walker and miss the others —
/// this previously existed as three near-identical copies that had already
/// diverged (two of the three were missing `graphify-out` and `system`).
public enum ExcludedDirs {
    public static let names: Set<String> = [
        ".git", "node_modules", ".build", "dist", "build",
        ".venv", "venv", "__pycache__", ".mypy_cache",
        ".code-notes", ".understand-anything", "graphify-out", "system",
    ]
}
