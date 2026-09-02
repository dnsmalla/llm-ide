import Foundation

/// Per-task run settings shared by built-in and custom Auto Tasks: where the
/// task reads, where it writes, which agent skill it runs under, and which
/// saved prompt template says what to do.
///
/// Keyed by task id (`AutoTask.rawValue` for built-ins, `CustomAutoTask.id` for
/// custom ones) in `AutoTaskConfigStore`, so one shape covers both task kinds
/// and a new built-in task needs no new storage.
///
/// Paths are stored PROJECT-RELATIVE (e.g. `llm-doc/emails`, `code/api`) — the
/// project can move on disk, and a relative path survives that. The composer
/// resolves them against the live project root at run time.
struct AutoTaskConfig: Codable, Equatable {
    /// Folder the task should read from. nil / empty = the whole project.
    var inputPath: String?
    /// Folder the task should write its output into. nil / empty = the task
    /// decides (which for review tasks means "print to the log", since their
    /// edits are reverted).
    var outputPath: String?
    /// Display name of the selected agent skill, for the UI.
    var skillName: String?
    /// The line that actually invokes the skill in the prompt (e.g.
    /// "Use the code-review skill:"). Stored alongside the name because the
    /// catalog it came from may not be reachable at run time.
    var skillDirective: String?
    /// `AutoTaskTemplate.id`. nil = fall back to the task's own prompt (the
    /// built-in `AppConfig` template, or a custom task's inline text).
    var templateId: String?

    init(inputPath: String? = nil, outputPath: String? = nil,
         skillName: String? = nil, skillDirective: String? = nil,
         templateId: String? = nil) {
        self.inputPath = inputPath
        self.outputPath = outputPath
        self.skillName = skillName
        self.skillDirective = skillDirective
        self.templateId = templateId
    }

    /// True when nothing is configured — the store drops these rather than
    /// persisting an empty record per task the user merely opened.
    var isEmpty: Bool {
        Self.normalized(inputPath) == nil
            && Self.normalized(outputPath) == nil
            && Self.normalized(skillName) == nil
            && Self.normalized(templateId) == nil
    }

    /// Trimmed value, or nil when blank — so an emptied text field clears the
    /// setting instead of storing `""`.
    static func normalized(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// A copy with every blank string collapsed to nil.
    var trimmed: AutoTaskConfig {
        AutoTaskConfig(inputPath: Self.normalized(inputPath),
                       outputPath: Self.normalized(outputPath),
                       skillName: Self.normalized(skillName),
                       skillDirective: Self.normalized(skillDirective),
                       templateId: Self.normalized(templateId))
    }
}
