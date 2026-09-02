import Foundation

/// Feature module for `.autoTasks`: activity capture plus the cron
/// scheduler. Capture runs whenever the feature is on; the scheduler arms
/// only when the user's master toggle is on — later master-toggle flips are
/// self-managed by AutoCodeUpdateService's `$enabled` subscription, so this
/// module only mirrors the app-boot arming rule.
@MainActor
final class AutoTaskModule: AppModule {
    let feature: AppFeature = .autoTasks
    private let scheduler: any FeatureService
    private let capture: any FeatureService
    private let schedulerEnabled: () -> Bool

    init(scheduler: any FeatureService,
         capture: any FeatureService,
         schedulerEnabled: @escaping () -> Bool) {
        self.scheduler = scheduler
        self.capture = capture
        self.schedulerEnabled = schedulerEnabled
    }

    func start() {
        capture.start()
        if schedulerEnabled() { scheduler.start() }
    }

    func stop() {
        scheduler.stop()
        capture.stop()
    }
}
