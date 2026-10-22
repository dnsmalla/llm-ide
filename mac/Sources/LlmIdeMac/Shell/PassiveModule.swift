import Foundation

/// No-op module for view-only features (Explorer, Gantt, DocGen, Terminal):
/// they have no background work today, but registering them keeps the
/// registry's coverage total — Phase 2 (SPM split) requires every feature
/// to have a module, and future background work gets an obvious home.
@MainActor
final class PassiveModule: AppModule {
    let feature: AppFeature
    init(feature: AppFeature) { self.feature = feature }
    func start() {}
    func stop() {}
}
