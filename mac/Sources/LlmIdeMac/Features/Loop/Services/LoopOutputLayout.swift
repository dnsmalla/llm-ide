import Foundation

/// Where each default loop writes what it GENERATES, and where it wrote it
/// before revision 2 of its stages.
///
/// Generated output lives under `llm-doc/loop/<loop key>/`, one folder per loop,
/// so everything a loop produces is in one place and never mixes with notes,
/// meetings or plans written by other features. `llm-doc/plans/` is NOT loop
/// output: chat's "Save Plan" and the knowledge-base export write plans there,
/// and the Plan loop reads them from there as its INPUT — so it does not move.
///
/// One source for the default stages, the templates, the revision history and
/// the file migration (`LoopOutputMigration`), so they cannot drift apart.
enum LoopOutputLayout {
    /// `llm-doc/loop/` also holds the dated run-summary notes
    /// (`llm-doc/loop/<yyyy>/<MM>/`); loop keys are never four digits, so the
    /// two cannot collide.
    static let root = "llm-doc/loop"

    // MARK: Current layout (stage revision 2)

    static let planIndex = "llm-doc/loop/plan/INDEX.md"
    static let planMaster = "llm-doc/loop/plan/PLAN.md"
    static let planAreasDir = "llm-doc/loop/plan/areas"
    static let refactorPlan = "llm-doc/loop/refactor/REFACTOR.md"
    static let docsDir = "llm-doc/loop/docs"
    static let docsIndex = "llm-doc/loop/docs/INDEX.md"

    /// The Plan loop's INPUT: plans collected from elsewhere. Unchanged.
    static let collectedPlansDir = "llm-doc/plans"

    // MARK: Previous layout (stage revision 1)

    enum Legacy {
        static let planIndex = "llm-doc/plans/INDEX.md"
        static let planMaster = "llm-doc/plans/PLAN.md"
        static let planAreasDir = "llm-doc/plans/areas"
        static let refactorPlan = "llm-doc/refactor/REFACTOR.md"
        static let docsDir = "llm-doc/docs"
        static let docsIndex = "llm-doc/docs/INDEX.md"
    }

    /// The revision that introduced the `llm-doc/loop/<key>/` layout.
    static let revision = 2

    /// The default stages whose Input/Output moved in `revision`.
    static let movedStageKeys = [
        "plan-structure-index", "plan-director", "refactor-plan", "refactor-apply",
        "doc-index", "doc-writer",
    ]
}
