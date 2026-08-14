import SwiftUI

/// The four Loop budget steppers, shared by every surface that edits a
/// `LoopEngineConfig`'s budgets — the Loop page's SETTINGS section, the New
/// Loop wizard, and Settings → Loop. One component instead of three hand-kept
/// copies, so a new budget (or a changed range) cannot ship on one surface and
/// silently not the others.
///
/// Bindings are scalar (not a `Binding<LoopEngineConfig>`) because the Loop
/// page holds its config as individual `@State` scalars; callers that do hold
/// a whole config bind with `$config.maxIterations` etc. and
/// `LoopBudgetsEditor.wallClockMinutes($config)`.
struct LoopBudgetsEditor: View {
    @Binding var maxIterations: Int
    @Binding var consecutiveFailureStop: Int
    /// 0 means "no wall-clock limit" — a Stepper cannot express `nil`. The
    /// mapping to `LoopEngineConfig.wallClockBudgetSeconds` is the caller's
    /// (see `wallClockMinutes(_:)` for config-backed callers).
    @Binding var wallClockMinutes: Int
    @Binding var maxRepairsPerStage: Int

    var body: some View {
        Stepper("Max iterations: \(maxIterations)", value: $maxIterations, in: 1...20)
        Stepper("Stop after \(consecutiveFailureStop) non-improving failures",
                value: $consecutiveFailureStop, in: 1...10)
        Stepper(wallClockMinutes == 0 ? "Time budget: none" : "Time budget: \(wallClockMinutes) min",
                value: $wallClockMinutes, in: 0...480, step: 15)
        Stepper("Max repairs per stage: \(maxRepairsPerStage)", value: $maxRepairsPerStage, in: 1...10)
    }

    /// The 0-means-nil minutes view over a config's `wallClockBudgetSeconds` —
    /// the one conversion previously re-implemented at every call site.
    static func wallClockMinutes(_ config: Binding<LoopEngineConfig>) -> Binding<Int> {
        Binding(
            get: { minutes(fromSeconds: config.wrappedValue.wallClockBudgetSeconds) },
            set: { config.wrappedValue.wallClockBudgetSeconds = seconds(fromMinutes: $0) }
        )
    }

    /// Scalar halves of the same conversion, for callers that hold the minutes
    /// as plain state (the Loop page) rather than a config binding. Changing
    /// the sentinel or unit is now one edit here, not five across three files.
    static func minutes(fromSeconds seconds: Double?) -> Int {
        seconds.map { Int($0 / 60) } ?? 0
    }

    static func seconds(fromMinutes minutes: Int) -> Double? {
        minutes == 0 ? nil : Double(minutes) * 60
    }
}
