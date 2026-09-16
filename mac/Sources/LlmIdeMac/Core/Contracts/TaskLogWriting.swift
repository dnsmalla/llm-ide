import Foundation

/// Severity a task log line carries. Promoted out of `TaskLogStore` (was a
/// nested `TaskLogStore.Level`) so `TaskLogWriting` can name it without
/// naming `TaskLogStore` itself. Exactly the two cases `TaskLogStore` already
/// had — `LoopEngineRunner`'s own log lines carry a third, `.warn`, but every
/// caller that mirrors one into a task log already collapses `.warn` to
/// `.info` (see `LoopEngineRunner.logLevel(for:)`'s doc comment), so no case
/// was added here to avoid inventing behavior this seam does not need.
enum TaskLogLevel: String {
    case info
    case error
}

/// A per-task log buffer a long-running job can mirror its output into.
/// Loop writes through this so it never names AutoTask's `TaskLogStore`.
@MainActor
protocol TaskLogWriting: AnyObject {
    func append(_ task: String, _ text: String, level: TaskLogLevel)
}
