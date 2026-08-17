import Foundation

/// A `save-plan` proposal resolved against the real filesystem: where it
/// would land under the open project's `llm-doc/plans/` folder. Resolution
/// happens once here so `confirmSavePlan`'s resolve step and its write step
/// can never disagree about the target.
struct ProposedPlan: Equatable {
    /// Canonical absolute path — always under `<projectRoot>/llm-doc/plans/`,
    /// never agent-supplied (this tool takes no `path` argument at all).
    let absolutePath: String
    /// Project-relative label shown to the user, e.g. `llm-doc/plans/2026-08-17-dark-mode.md`.
    let displayPath: String
    let title: String
    let content: String
}

/// Outcome of `confirmSavePlan` — save-plan has no confirmation sheet (it
/// saves automatically), so this only distinguishes success from a failure
/// message for the caller to surface.
enum SavePlanResult: Equatable {
    case success
    case failure(String)
}

enum ProposedPlanError: Error, Equatable {
    case noOpenProject
    case emptyContent

    var message: String {
        switch self {
        case .noOpenProject:
            return "There's no open project to save a plan into — open a project first."
        case .emptyContent:
            return "The plan has no content — refusing to save an empty file."
        }
    }
}

enum ProposedPlanResolver {

    /// Resolve `args` into a concrete file target under the open project's
    /// `llm-doc/plans/`. Unlike `ProposedEditResolver`, this never reads an
    /// existing file — save-plan only ever creates or overwrites-in-place,
    /// it never edits.
    static func resolve(
        args: PendingTool.SavePlanArgs,
        projectRoot: URL?
    ) -> Result<ProposedPlan, ProposedPlanError> {
        guard let projectRoot else { return .failure(.noOpenProject) }
        let content = args.content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return .failure(.emptyContent) }

        let plansDir = ProjectLayout(root: projectRoot).plansDir
        let filename = "\(datePrefix())-\(slugify(args.title)).md"
        let absolute = plansDir.appendingPathComponent(filename).path

        return .success(ProposedPlan(
            absolutePath: absolute,
            displayPath: "llm-doc/plans/\(filename)",
            title: args.title,
            content: args.content
        ))
    }

    /// "YYYY-MM-DD" for today. No id suffix (unlike ProjectExporter's DB-backed
    /// plans) — there's no database row to dedupe against, so the same title
    /// on the same day intentionally overwrites rather than duplicating.
    private static func datePrefix() -> String {
        let cal = Calendar(identifier: .gregorian)
        let now = Date()
        let y = cal.component(.year, from: now)
        let m = cal.component(.month, from: now)
        let d = cal.component(.day, from: now)
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    /// See `FilesystemSlug` for the shared slugging rules (also used by
    /// `ProjectExporter`). No id suffix here — there's no database row to
    /// dedupe against, so the same title on the same day intentionally
    /// overwrites rather than duplicating.
    private static func slugify(_ title: String) -> String {
        FilesystemSlug.make(from: title, maxLength: 60, fallback: "untitled-plan")
    }
}
