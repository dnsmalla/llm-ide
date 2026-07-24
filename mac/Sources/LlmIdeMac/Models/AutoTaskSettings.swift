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
    
    @Published var intervalMinutes: Int {
        didSet(oldValue) {
            guard oldValue != intervalMinutes else { return }
            save("autoCodeIntervalMinutes", intervalMinutes)
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
    
    // MARK: - Computed Properties
    
    var enabledTasks: [String] {
        var tasks: [String] = []
        if runReviewCode { tasks.append("Review Code") }
        if runReviewDoc { tasks.append("Review Doc") }
        if runReviewConflicts { tasks.append("Review Conflicts") }
        if runRegression { tasks.append("Regression") }
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
        case .reviewCode:        return runReviewCode
        case .reviewDoc:         return runReviewDoc
        case .reviewConflicts:   return runReviewConflicts
        case .regression:        return runRegression
        case .generateKnowledge: return runGenerateKnowledge
        case .generateDoc:       return runGenerateDoc
        case .updateIssues:      return runUpdateIssues
        case .updatePlanStatus:  return runUpdatePlanStatus
        }
    }

    /// Set the per-task enable flag. Routes through the `@Published` property
    /// so the `didSet` persists to UserDefaults and notifies subscribers
    /// (Settings UI, Menu Bar, `AutoCodeUpdateService`) exactly as a UI
    /// toggle would — no silent bypass of the single source of truth.
    func setEnabled(_ value: Bool, task: AutoTask) {
        switch task {
        case .reviewCode:        runReviewCode = value
        case .reviewDoc:         runReviewDoc = value
        case .reviewConflicts:   runReviewConflicts = value
        case .regression:        runRegression = value
        case .generateKnowledge: runGenerateKnowledge = value
        case .generateDoc:       runGenerateDoc = value
        case .updateIssues:      runUpdateIssues = value
        case .updatePlanStatus:  runUpdatePlanStatus = value
        }
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
    
    var intervalDescription: String {
        switch intervalMinutes {
        case ..<60:  return "every \(intervalMinutes) min"
        case 60:     return "every hour"
        case 1440:   return "every 24 hours"
        default:
            let h = intervalMinutes / 60
            return "every \(h) hour\(h == 1 ? "" : "s")"
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
        self.intervalMinutes = defaults.object(forKey: "autoCodeIntervalMinutes") as? Int ?? 60
        self.autoStash = defaults.object(forKey: "autoCodeAutoStash") as? Bool ?? false
        
        self.runReviewCode = defaults.object(forKey: "autoCodeRunReviewCode") as? Bool ?? true
        self.runReviewDoc = defaults.object(forKey: "autoCodeRunReviewDoc") as? Bool ?? true
        self.runReviewConflicts = defaults.object(forKey: "autoCodeRunReviewConflicts") as? Bool ?? false
        self.runRegression = defaults.object(forKey: "autoCodeRunRegression") as? Bool ?? false
        self.runGenerateKnowledge = defaults.object(forKey: "autoCodeRunGenerateKnowledge") as? Bool ?? true
        self.runGenerateDoc = defaults.object(forKey: "autoCodeRunGenerateDoc") as? Bool ?? true
        self.runUpdateIssues = defaults.object(forKey: "autoCodeRunUpdateIssues") as? Bool ?? false
        self.runUpdatePlanStatus = defaults.object(forKey: "autoCodeRunUpdatePlanStatus") as? Bool ?? false
        
        self.regressionAttemptRepair = defaults.object(forKey: "regressionAttemptRepair") as? Bool ?? false
        self.regressionAutoReopen = defaults.object(forKey: "regressionAutoReopen") as? Bool ?? false
        let savedTimeout = defaults.double(forKey: "regressionVerifyTimeout")
        self.regressionVerifyTimeout = savedTimeout > 0 ? savedTimeout : 120
        
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
        
        let newIntervalMinutes = defaults.object(forKey: "autoCodeIntervalMinutes") as? Int ?? 60
        if newIntervalMinutes != intervalMinutes { intervalMinutes = newIntervalMinutes }
        
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
        
        let newRegressionAttemptRepair = defaults.object(forKey: "regressionAttemptRepair") as? Bool ?? false
        if newRegressionAttemptRepair != regressionAttemptRepair { regressionAttemptRepair = newRegressionAttemptRepair }
        
        let newRegressionAutoReopen = defaults.object(forKey: "regressionAutoReopen") as? Bool ?? false
        if newRegressionAutoReopen != regressionAutoReopen { regressionAutoReopen = newRegressionAutoReopen }
        
        let newRegressionVerifyTimeout = max(1.0, defaults.double(forKey: "regressionVerifyTimeout") > 0 ? defaults.double(forKey: "regressionVerifyTimeout") : 120)
        if newRegressionVerifyTimeout != regressionVerifyTimeout { regressionVerifyTimeout = newRegressionVerifyTimeout }
    }
    
    func resetToDefaults() {
        enabled = false
        lookbackByDays = false
        lookbackMeetingCount = 5
        lookbackDays = 7
        intervalMinutes = 60
        autoStash = false
        runReviewCode = true
        runReviewDoc = true
        runReviewConflicts = false
        runRegression = false
        runGenerateKnowledge = true
        runGenerateDoc = true
        runUpdateIssues = false
        runUpdatePlanStatus = false
        regressionAttemptRepair = false
        regressionAutoReopen = false
        regressionVerifyTimeout = 120
        
        let keys = ["autoCodeUpdateEnabled", "autoCodeLookbackByDays", "autoCodeUpdateLookbackCount",
                    "autoCodeLookbackDays", "autoCodeIntervalMinutes", "autoCodeAutoStash",
                    "autoCodeRunReviewCode", "autoCodeRunReviewDoc", "autoCodeRunReviewConflicts",
                    "autoCodeRunRegression", "autoCodeRunGenerateKnowledge", "autoCodeRunGenerateDoc",
                    "autoCodeRunUpdateIssues", "autoCodeRunUpdatePlanStatus", "regressionAttemptRepair",
                    "regressionAutoReopen", "regressionVerifyTimeout"]
        for key in keys {
            defaults.removeObject(forKey: key)
        }
    }
}
