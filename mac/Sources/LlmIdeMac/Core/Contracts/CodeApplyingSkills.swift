import Foundation

/// The central-kit skills whose run EDITS CODE and is therefore safe only when
/// a verify stage (a blocking test/check command) runs after it.
///
/// Two features need this one list: the Loop refuses a code-applying stage
/// with no verify stage after it (`LoopStage.codeApplySkillIds`,
/// `LoopStage.lacksVerifyAfter`), and Auto Tasks never offer these skills at
/// all, since a scheduled Auto Task has no verify stage
/// (`AutoTaskSkillCatalog.excludedSkillNames`). Features may not reference
/// each other, so the list lives here and both derive from it — a new
/// code-applying skill added once is excluded from Auto Tasks automatically,
/// instead of relying on someone remembering a second hand-kept copy (which is
/// how `refactor-conform` was once offered to Auto Tasks).
enum CodeApplyingSkills {
    /// Skill ids as a Loop stage stores them (`skills/<name>`).
    static let ids: Set<String> = [
        "skills/refactor-apply", "skills/test-gap-writer", "skills/test-structure-setup",
        "skills/refactor-conform",
    ]

    /// The bare skill names (`<name>`), as they appear as folders under a
    /// project's `.claude/skills/`.
    static var names: Set<String> {
        Set(ids.map { ($0 as NSString).lastPathComponent })
    }
}
