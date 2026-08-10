import SwiftUI

/// One of the fixed, built-in Auto Tasks. Extracted from AutoCodeView so the
/// domain model doesn't live inside a View file — see also CustomAutoTask
/// for the user-created, runtime-open counterpart to this closed enum.
enum AutoTask: String, CaseIterable, Identifiable {
    /// Fetch email + Slack into the meeting library and re-index.
    case sourceUpdate
    /// Extract action items from recent notes and create upstream issues.
    case sourcesToIssue
    /// Run the CLI against pending registry entries (local fix branches).
    case implementIssues
    /// Push local fix/* branches and open MR/PRs (no auto-merge).
    case reviewMerge
    case reviewCode
    case reviewDoc
    case reviewConflicts
    /// Re-asks past `status: fixed` FaultReports and flips regressed
    /// ones back to `status: open`. Has no editable prompt template
    /// because the prompts come from the saved fault reports themselves.
    case regression
    /// Knowledge generation (code graph + agent memory + search index). The
    /// generation itself is automatic (GraphAutoUpdater on open/edit + the
    /// auto code-index); this task surfaces the current state for the user to
    /// REVIEW. Structural — no editable prompt template.
    case generateKnowledge
    /// Documentation generation from code changes. Generates comprehensive
    /// docs for new APIs, data structures, config changes, and migration guides.
    case generateDoc
    /// Issue creation and updates from code review findings and meeting
    /// action items. Creates or updates GitHub/GitLab issues.
    case updateIssues
    /// Plan status updates from external outcome trackers (GitHub/GitLab/Linear/Backlog).
    /// Polls external providers and updates plan task statuses. Structural — no editable prompt.
    case updatePlanStatus
    /// Multi-stage, multi-iteration loop (Regression -> Test -> ...) with
    /// auto-fix retry. Additive to `.regression`, which keeps its existing
    /// single-attempt behavior unchanged. Structural — configured via
    /// LoopEngineView, not a text template.
    case loopEngineering

    var id: String { rawValue }

    /// Shared "EEE HH:mm" formatter for next-fire timestamps (CronField + menu bar).
    static let fireFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateFormat = "EEE HH:mm"
        return f
    }()

    var label: String {
        switch self {
        case .sourceUpdate:      return "Source Update"
        case .sourcesToIssue:    return "Sources → Issue"
        case .implementIssues:   return "Implement Issues"
        case .reviewMerge:       return "Review & Merge"
        case .reviewCode:        return "Review Code"
        case .reviewDoc:         return "Review Doc"
        case .reviewConflicts:   return "Review Conflicts"
        case .regression:        return "Regression"
        case .generateKnowledge: return "Knowledge"
        case .generateDoc:       return "Generate Documentation"
        case .updateIssues:      return "Update Issues"
        case .updatePlanStatus:  return "Update Plan Status"
        case .loopEngineering:   return "Loop"
        }
    }

    var icon: String {
        switch self {
        case .sourceUpdate:      return "tray.and.arrow.down"
        case .sourcesToIssue:    return "arrow.right.doc.on.clipboard"
        case .implementIssues:   return "hammer"
        case .reviewMerge:       return "arrow.triangle.merge"
        case .reviewCode:        return "checkmark.shield"
        case .reviewDoc:         return "doc.text.magnifyingglass"
        case .reviewConflicts:   return "exclamationmark.triangle"
        case .regression:        return "arrow.uturn.backward.circle"
        case .generateKnowledge: return "brain"
        case .generateDoc:       return "wand.and.stars"
        case .updateIssues:      return "checklist"
        case .updatePlanStatus:  return "chart.bar.doc.horizontal"
        case .loopEngineering:   return "repeat.circle"
        }
    }

    /// Log-file suffix used by `runCLI(prompt:)`, `logTail`, and error hints.
    var logSuffix: String {
        switch self {
        case .sourceUpdate:      return "source-update"
        case .sourcesToIssue:    return "sources-to-issue"
        case .implementIssues:   return "implement-issues"
        case .reviewMerge:       return "review-merge"
        case .reviewCode:        return "review-code"
        case .reviewDoc:         return "review-doc"
        case .reviewConflicts:   return "review-conflicts"
        case .regression:        return "regression"
        case .generateKnowledge: return "knowledge"
        case .generateDoc:       return "generate-doc"
        case .updateIssues:      return "update-issues"
        case .updatePlanStatus:  return "update-plan-status"
        case .loopEngineering:   return "loop-engineering"
        }
    }

    /// Structural tasks (regression, generateKnowledge) don't have a user-
    /// editable prompt template. Callers should hide the template editor when
    /// this returns nil.
    func templateBinding(config: AppConfig) -> Binding<String>? {
        switch self {
        case .reviewCode:      return Binding(get: { config.autoTaskTemplateReviewCode },
                                              set: { config.autoTaskTemplateReviewCode = $0 })
        case .reviewDoc:       return Binding(get: { config.autoTaskTemplateReviewDoc },
                                              set: { config.autoTaskTemplateReviewDoc = $0 })
        case .reviewConflicts: return Binding(get: { config.autoTaskTemplateReviewConflicts },
                                              set: { config.autoTaskTemplateReviewConflicts = $0 })
        case .generateDoc:     return Binding(get: { config.autoTaskTemplateGenerateDoc },
                                              set: { config.autoTaskTemplateGenerateDoc = $0 })
        case .updateIssues:    return Binding(get: { config.autoTaskTemplateUpdateIssues },
                                              set: { config.autoTaskTemplateUpdateIssues = $0 })
        case .updatePlanStatus: return nil
        case .sourceUpdate, .sourcesToIssue, .implementIssues, .reviewMerge,
             .regression, .generateKnowledge, .loopEngineering: return nil
        }
    }

    /// Pipeline + maintenance tasks that run without an editable prompt.
    var isStructural: Bool {
        switch self {
        case .reviewCode, .reviewDoc, .reviewConflicts, .generateDoc, .updateIssues:
            return false
        default:
            return true
        }
    }

    func resetTemplate(config: AppConfig) {
        switch self {
        case .reviewCode:      config.autoTaskTemplateReviewCode = AppConfig.defaultTemplateReviewCode
        case .reviewDoc:       config.autoTaskTemplateReviewDoc = AppConfig.defaultTemplateReviewDoc
        case .reviewConflicts: config.autoTaskTemplateReviewConflicts = AppConfig.defaultTemplateReviewConflicts
        case .generateDoc:     config.autoTaskTemplateGenerateDoc = AppConfig.defaultTemplateGenerateDoc
        case .updateIssues:    config.autoTaskTemplateUpdateIssues = AppConfig.defaultTemplateUpdateIssues
        case .updatePlanStatus: break       // no template to reset
        case .sourceUpdate, .sourcesToIssue, .implementIssues, .reviewMerge,
             .regression, .generateKnowledge, .loopEngineering: break
        }
    }

    /// True when the task needs a linked git clone + repo token (not source ingest).
    var requiresLinkedRepo: Bool {
        switch self {
        case .sourceUpdate: return false
        default:            return true
        }
    }
}
