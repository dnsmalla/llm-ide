import Foundation
import Combine
import SwiftUI

/// Unified Auto Task settings that syncs across Settings, Menu Bar, and all UI components.
/// This single source of truth ensures changes in one place propagate everywhere automatically.
///
/// Architecture:
/// - All @Published properties auto-notify subscribers (Settings UI, Menu Bar, AutoCodeUpdateService)
/// - Changes to UserDefaults trigger Combine publishers → all views update automatically
/// - No manual cross-component syncing needed
/// - didSet guards prevent infinite recursion with UserDefaults notifications
@MainActor
final class AutoTaskSettings: ObservableObject {
    
    // MARK: - Published State

    static let defaultCron = "0 * * * *"   // hourly; used for fresh installs

    private static func cronKey(_ task: AutoTask) -> String { "autoCodeCron.\(task.rawValue)" }
    private static func nextFireKey(_ task: AutoTask) -> String { "autoCodeNextFireAt.\(task.rawValue)" }

    @Published var enabled: Bool {
        didSet(oldValue) {
            guard oldValue != enabled else { return }
            save("autoCodeUpdateEnabled", enabled)
        }
    }
    
    @Published var lookbackByDays: Bool {
        didSet(oldValue) {
            guard oldValue != lookbackByDays else { return }
            save("autoCodeLookbackByDays", lookbackByDays)
        }
    }
    
    @Published var lookbackMeetingCount: Int {
        didSet(oldValue) {
            guard oldValue != lookbackMeetingCount else { return }
            save("autoCodeUpdateLookbackCount", lookbackMeetingCount)
        }
    }
    
    @Published var lookbackDays: Int {
        didSet(oldValue) {
            guard oldValue != lookbackDays else { return }
            save("autoCodeLookbackDays", lookbackDays)
        }
    }

    @Published var autoStash: Bool {
        didSet(oldValue) {
            guard oldValue != autoStash else { return }
            save("autoCodeAutoStash", autoStash)
        }
    }
    
    @Published var runReviewCode: Bool {
        didSet(oldValue) {
            guard oldValue != runReviewCode else { return }
            save("autoCodeRunReviewCode", runReviewCode)
        }
    }
    
    @Published var runReviewDoc: Bool {
        didSet(oldValue) {
            guard oldValue != runReviewDoc else { return }
            save("autoCodeRunReviewDoc", runReviewDoc)
        }
    }
    
    @Published var runReviewConflicts: Bool {
        didSet(oldValue) {
            guard oldValue != runReviewConflicts else { return }
            save("autoCodeRunReviewConflicts", runReviewConflicts)
        }
    }
    
    @Published var runRegression: Bool {
        didSet(oldValue) {
            guard oldValue != runRegression else { return }
            save("autoCodeRunRegression", runRegression)
        }
    }
    
    @Published var runGenerateKnowledge: Bool {
        didSet(oldValue) {
            guard oldValue != runGenerateKnowledge else { return }
            save("autoCodeRunGenerateKnowledge", runGenerateKnowledge)
        }
    }
    
    @Published var runGenerateDoc: Bool {
        didSet(oldValue) {
            guard oldValue != runGenerateDoc else { return }
            save("autoCodeRunGenerateDoc", runGenerateDoc)
        }
    }
    
    @Published var runUpdateIssues: Bool {
        didSet(oldValue) {
            guard oldValue != runUpdateIssues else { return }
            save("autoCodeRunUpdateIssues", runUpdateIssues)
        }
    }
    
    @Published var runUpdatePlanStatus: Bool {
        didSet(oldValue) {
            guard oldValue != runUpdatePlanStatus else { return }
            save("autoCodeRunUpdatePlanStatus", runUpdatePlanStatus)
        }
    }

    @Published var runSourceUpdate: Bool {
        didSet(oldValue) {
            guard oldValue != runSourceUpdate else { return }
            save("autoCodeRunSourceUpdate", runSourceUpdate)
        }
    }

    @Published var runSourcesToIssue: Bool {
        didSet(oldValue) {
            guard oldValue != runSourcesToIssue else { return }
            save("autoCodeRunSourcesToIssue", runSourcesToIssue)
        }
    }

    @Published var runImplementIssues: Bool {
        didSet(oldValue) {
            guard oldValue != runImplementIssues else { return }
            save("autoCodeRunImplementIssues", runImplementIssues)
        }
    }

    @Published var runReviewMerge: Bool {
        didSet(oldValue) {
            guard oldValue != runReviewMerge else { return }
            save("autoCodeRunReviewMerge", runReviewMerge)
        }
    }

    @Published var runLoopEngineering: Bool {
        didSet(oldValue) {
            guard oldValue != runLoopEngineering else { return }
            save("autoCodeRunLoopEngineering", runLoopEngineering)
        }
    }

    @Published var regressionAttemptRepair: Bool {
        didSet(oldValue) {
            guard oldValue != regressionAttemptRepair else { return }
            save("regressionAttemptRepair", regressionAttemptRepair)
        }
    }
    
    @Published var regressionAutoReopen: Bool {
        didSet(oldValue) {
            guard oldValue != regressionAutoReopen else { return }
            save("regressionAutoReopen", regressionAutoReopen)
        }
    }
    
    @Published var regressionVerifyTimeout: TimeInterval {
        didSet(oldValue) {
            guard oldValue != regressionVerifyTimeout else { return }
            save("regressionVerifyTimeout", regressionVerifyTimeout)
        }
    }

    /// When on, the Auto Tasks page (and the mobile mirror) hide tasks whose
    /// per-task enable flag is off, so only the active set is shown. Default
    /// off = today's "show every task" behavior. Flip off to manage all tasks.
    @Published var showOnlyEnabledTasks: Bool {
        didSet(oldValue) {
            guard oldValue != showOnlyEnabledTasks else { return }
            save("autoCodeShowOnlyEnabledTasks", showOnlyEnabledTasks)
        }
    }

    // MARK: - Computed Properties
    
    var enabledTasks: [String] {
        var tasks: [String] = []
        if runSourceUpdate { tasks.append("Source Update") }
        if runSourcesToIssue { tasks.append("Sources → Issue") }
        if runImplementIssues { tasks.append("Implement Issues") }
        if runReviewMerge { tasks.append("Review & Merge") }
        if runReviewCode { tasks.append("Review Code") }
        if runReviewDoc { tasks.append("Review Doc") }
        if runReviewConflicts { tasks.append("Review Conflicts") }
        if runRegression { tasks.append("Regression") }
        if runLoopEngineering { tasks.append("Loop Engineering") }
        if runGenerateKnowledge { tasks.append("Knowledge") }
        if runGenerateDoc { tasks.append("Generate Doc") }
        if runUpdateIssues { tasks.append("Update Issues") }
        if runUpdatePlanStatus { tasks.append("Update Plans") }
        return tasks
    }
    
    // MARK: - Per-task enable (generic accessors)

    /// True when the per-task enable checkbox is on for `task`. Lets callers
    /// (the mobile control surface, tests) read a task's enable generically
    /// without knowing each individual `@Published` flag. Mirrors the private
    /// `isTaskEnabled(_:)` on `AutoCodeUpdateService`.
    func isEnabled(task: AutoTask) -> Bool {
        switch task {
        case .sourceUpdate:      return runSourceUpdate
        case .sourcesToIssue:    return runSourcesToIssue
        case .implementIssues:   return runImplementIssues
        case .reviewMerge:       return runReviewMerge
        case .reviewCode:        return runReviewCode
        case .reviewDoc:         return runReviewDoc
        case .reviewConflicts:   return runReviewConflicts
        case .regression:        return runRegression
        case .generateKnowledge: return runGenerateKnowledge
        case .generateDoc:       return runGenerateDoc
        case .updateIssues:      return runUpdateIssues
        case .updatePlanStatus:  return runUpdatePlanStatus
        case .loopEngineering:   return runLoopEngineering
        }
    }

    /// Set the per-task enable flag. Routes through the `@Published` property
    /// so the `didSet` persists to UserDefaults and notifies subscribers
    /// (Settings UI, Menu Bar, `AutoCodeUpdateService`) exactly as a UI
    /// toggle would — no silent bypass of the single source of truth.
    func setEnabled(_ value: Bool, task: AutoTask) {
        switch task {
        case .sourceUpdate:      runSourceUpdate = value
        case .sourcesToIssue:    runSourcesToIssue = value
        case .implementIssues:   runImplementIssues = value
        case .reviewMerge:       runReviewMerge = value
        case .reviewCode:        runReviewCode = value
        case .reviewDoc:         runReviewDoc = value
        case .reviewConflicts:   runReviewConflicts = value
        case .regression:        runRegression = value
        case .generateKnowledge: runGenerateKnowledge = value
        case .generateDoc:       runGenerateDoc = value
        case .updateIssues:      runUpdateIssues = value
        case .updatePlanStatus:  runUpdatePlanStatus = value
        case .loopEngineering:   runLoopEngineering = value
        }
    }

    func cron(for task: AutoTask) -> String {
        defaults.string(forKey: Self.cronKey(task)) ?? Self.defaultCron
    }
    func setCron(_ value: String, for task: AutoTask) {
        guard CronExpression.parse(value) != nil else { return }   // refuse invalid
        defaults.set(value, forKey: Self.cronKey(task))
        recomputeNextFire(for: task, now: Date())
        objectWillChange.send()   // notify the UI
    }
    func nextFireAt(for task: AutoTask) -> Date? {
        let t = defaults.double(forKey: Self.nextFireKey(task))
        return t > 0 ? Date(timeIntervalSince1970: t) : nil
    }
    func setNextFireAt(_ date: Date?, for task: AutoTask) {
        if let date { defaults.set(date.timeIntervalSince1970, forKey: Self.nextFireKey(task)) }
        else { defaults.removeObject(forKey: Self.nextFireKey(task)) }
        objectWillChange.send()
    }
    /// Recompute the next fire strictly after `now`. No-op if cron is invalid.
    func recomputeNextFire(for task: AutoTask, now: Date) {
        guard let expr = CronExpression.parse(cron(for: task)),
              let next = expr.nextFire(after: now, now: now) else {
            setNextFireAt(nil, for: task); return
        }
        setNextFireAt(next, for: task)
    }

    var menuBarSummary: String {
        guard enabled else { return "Auto Tasks: Disabled" }
        let count = enabledTasks.count
        return "Auto Tasks: \(count) enabled"
    }
    
    var lookbackDescription: String {
        if lookbackByDays {
            return "Last \(lookbackDays) day\(lookbackDays == 1 ? "" : "s")"
        } else {
            return "Last \(lookbackMeetingCount) meeting\(lookbackMeetingCount == 1 ? "" : "s")"
        }
    }

    /// Map the legacy shared interval (minutes) to a per-task cron seed.
    static func cronFromInterval(_ minutes: Int?) -> String {
        guard let minutes else { return defaultCron }
        switch minutes {
        case ..<60:  return "*/\(max(1, minutes)) * * * *"
        case 60:     return "0 * * * *"
        case 1440:   return "0 0 * * *"
        default:     return "0 */\(max(1, minutes / 60)) * * *"
        }
    }

    // MARK: - Private State
    
    private let defaults: UserDefaults
    private var cancellables: Set<AnyCancellable> = []
    
    // MARK: - Init
    
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        
        self.enabled = defaults.object(forKey: "autoCodeUpdateEnabled") as? Bool ?? false
        self.lookbackByDays = defaults.object(forKey: "autoCodeLookbackByDays") as? Bool ?? false
        self.lookbackMeetingCount = defaults.object(forKey: "autoCodeUpdateLookbackCount") as? Int ?? 5
        self.lookbackDays = defaults.object(forKey: "autoCodeLookbackDays") as? Int ?? 7
        self.autoStash = defaults.object(forKey: "autoCodeAutoStash") as? Bool ?? false
        
        self.runReviewCode = defaults.object(forKey: "autoCodeRunReviewCode") as? Bool ?? true
        self.runReviewDoc = defaults.object(forKey: "autoCodeRunReviewDoc") as? Bool ?? true
        self.runReviewConflicts = defaults.object(forKey: "autoCodeRunReviewConflicts") as? Bool ?? false
        self.runRegression = defaults.object(forKey: "autoCodeRunRegression") as? Bool ?? false
        self.runGenerateKnowledge = defaults.object(forKey: "autoCodeRunGenerateKnowledge") as? Bool ?? true
        self.runGenerateDoc = defaults.object(forKey: "autoCodeRunGenerateDoc") as? Bool ?? true
        self.runUpdateIssues = defaults.object(forKey: "autoCodeRunUpdateIssues") as? Bool ?? false
        self.runUpdatePlanStatus = defaults.object(forKey: "autoCodeRunUpdatePlanStatus") as? Bool ?? false
        self.runSourceUpdate = defaults.object(forKey: "autoCodeRunSourceUpdate") as? Bool ?? false
        self.runSourcesToIssue = defaults.object(forKey: "autoCodeRunSourcesToIssue") as? Bool ?? true
        self.runImplementIssues = defaults.object(forKey: "autoCodeRunImplementIssues") as? Bool ?? true
        self.runReviewMerge = defaults.object(forKey: "autoCodeRunReviewMerge") as? Bool ?? false
        self.runLoopEngineering = defaults.object(forKey: "autoCodeRunLoopEngineering") as? Bool ?? false

        self.regressionAttemptRepair = defaults.object(forKey: "regressionAttemptRepair") as? Bool ?? false
        self.regressionAutoReopen = defaults.object(forKey: "regressionAutoReopen") as? Bool ?? false
        let savedTimeout = defaults.double(forKey: "regressionVerifyTimeout")
        self.regressionVerifyTimeout = savedTimeout > 0 ? savedTimeout : 120

        self.showOnlyEnabledTasks = defaults.object(forKey: "autoCodeShowOnlyEnabledTasks") as? Bool ?? false

        // --- Per-task cron migration / seeding ---
        let legacyInterval = defaults.object(forKey: "autoCodeIntervalMinutes") as? Int
        for task in AutoTask.allCases {
            if defaults.string(forKey: Self.cronKey(task)) == nil {
                let seeded = Self.cronFromInterval(legacyInterval)
                defaults.set(seeded, forKey: Self.cronKey(task))
            }
            if nextFireAt(for: task) == nil {
                recomputeNextFire(for: task, now: Date())
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(userDefaultsDidChange),
            name: UserDefaults.didChangeNotification,
            object: defaults
        )
    }
    
    deinit {
        NotificationCenter.default.removeObserver(self)
    }
    
    // MARK: - Persistence
    
    private func save(_ key: String, _ value: Any) {
        defaults.set(value, forKey: key)
    }
    
    @objc private func userDefaultsDidChange() {
        let newEnabled = defaults.object(forKey: "autoCodeUpdateEnabled") as? Bool ?? false
        if newEnabled != enabled { enabled = newEnabled }
        
        let newLookbackByDays = defaults.object(forKey: "autoCodeLookbackByDays") as? Bool ?? false
        if newLookbackByDays != lookbackByDays { lookbackByDays = newLookbackByDays }
        
        let newLookbackMeetingCount = defaults.object(forKey: "autoCodeUpdateLookbackCount") as? Int ?? 5
        if newLookbackMeetingCount != lookbackMeetingCount { lookbackMeetingCount = newLookbackMeetingCount }
        
        let newLookbackDays = defaults.object(forKey: "autoCodeLookbackDays") as? Int ?? 7
        if newLookbackDays != lookbackDays { lookbackDays = newLookbackDays }

        let newAutoStash = defaults.object(forKey: "autoCodeAutoStash") as? Bool ?? false
        if newAutoStash != autoStash { autoStash = newAutoStash }
        
        let newRunReviewCode = defaults.object(forKey: "autoCodeRunReviewCode") as? Bool ?? true
        if newRunReviewCode != runReviewCode { runReviewCode = newRunReviewCode }
        
        let newRunReviewDoc = defaults.object(forKey: "autoCodeRunReviewDoc") as? Bool ?? true
        if newRunReviewDoc != runReviewDoc { runReviewDoc = newRunReviewDoc }
        
        let newRunReviewConflicts = defaults.object(forKey: "autoCodeRunReviewConflicts") as? Bool ?? false
        if newRunReviewConflicts != runReviewConflicts { runReviewConflicts = newRunReviewConflicts }
        
        let newRunRegression = defaults.object(forKey: "autoCodeRunRegression") as? Bool ?? false
        if newRunRegression != runRegression { runRegression = newRunRegression }
        
        let newRunGenerateKnowledge = defaults.object(forKey: "autoCodeRunGenerateKnowledge") as? Bool ?? true
        if newRunGenerateKnowledge != runGenerateKnowledge { runGenerateKnowledge = newRunGenerateKnowledge }
        
        let newRunGenerateDoc = defaults.object(forKey: "autoCodeRunGenerateDoc") as? Bool ?? true
        if newRunGenerateDoc != runGenerateDoc { runGenerateDoc = newRunGenerateDoc }
        
        let newRunUpdateIssues = defaults.object(forKey: "autoCodeRunUpdateIssues") as? Bool ?? false
        if newRunUpdateIssues != runUpdateIssues { runUpdateIssues = newRunUpdateIssues }
        
        let newRunUpdatePlanStatus = defaults.object(forKey: "autoCodeRunUpdatePlanStatus") as? Bool ?? false
        if newRunUpdatePlanStatus != runUpdatePlanStatus { runUpdatePlanStatus = newRunUpdatePlanStatus }

        let newRunSourceUpdate = defaults.object(forKey: "autoCodeRunSourceUpdate") as? Bool ?? false
        if newRunSourceUpdate != runSourceUpdate { runSourceUpdate = newRunSourceUpdate }

        let newRunSourcesToIssue = defaults.object(forKey: "autoCodeRunSourcesToIssue") as? Bool ?? true
        if newRunSourcesToIssue != runSourcesToIssue { runSourcesToIssue = newRunSourcesToIssue }

        let newRunImplementIssues = defaults.object(forKey: "autoCodeRunImplementIssues") as? Bool ?? true
        if newRunImplementIssues != runImplementIssues { runImplementIssues = newRunImplementIssues }

        let newRunReviewMerge = defaults.object(forKey: "autoCodeRunReviewMerge") as? Bool ?? false
        if newRunReviewMerge != runReviewMerge { runReviewMerge = newRunReviewMerge }

        let newRunLoopEngineering = defaults.object(forKey: "autoCodeRunLoopEngineering") as? Bool ?? false
        if newRunLoopEngineering != runLoopEngineering { runLoopEngineering = newRunLoopEngineering }

        let newRegressionAttemptRepair = defaults.object(forKey: "regressionAttemptRepair") as? Bool ?? false
        if newRegressionAttemptRepair != regressionAttemptRepair { regressionAttemptRepair = newRegressionAttemptRepair }
        
        let newRegressionAutoReopen = defaults.object(forKey: "regressionAutoReopen") as? Bool ?? false
        if newRegressionAutoReopen != regressionAutoReopen { regressionAutoReopen = newRegressionAutoReopen }
        
        let newRegressionVerifyTimeout = max(1.0, defaults.double(forKey: "regressionVerifyTimeout") > 0 ? defaults.double(forKey: "regressionVerifyTimeout") : 120)
        if newRegressionVerifyTimeout != regressionVerifyTimeout { regressionVerifyTimeout = newRegressionVerifyTimeout }

        let newShowOnlyEnabledTasks = defaults.object(forKey: "autoCodeShowOnlyEnabledTasks") as? Bool ?? false
        if newShowOnlyEnabledTasks != showOnlyEnabledTasks { showOnlyEnabledTasks = newShowOnlyEnabledTasks }
    }
    
}
