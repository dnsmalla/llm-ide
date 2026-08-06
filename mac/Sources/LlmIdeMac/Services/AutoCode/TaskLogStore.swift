import Foundation
import Combine

/// Per-task live log buffer for the Auto Task page. Each of the 8 tasks gets
/// an independent ring buffer of timestamped lines that ACCUMULATE ACROSS
/// RUNS (never auto-cleared) so repeated runs are visible. The `.log` file on
/// disk remains the permanent record; this is the live, capped, on-screen view.
@MainActor
final class TaskLogStore: ObservableObject {

    enum Level: String { case info, error }

    struct LogLine: Identifiable, Equatable {
        let id: UUID
        let timestamp: Date
        let level: Level
        let text: String
    }

    /// Per-task cap. Oldest lines are dropped once exceeded.
    static let maxLinesPerTask = 2_000

    @Published private(set) var buffers: [String: [LogLine]] = [:]

    func append(_ task: AutoTask, _ text: String, level: Level = .info) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var lines = buffers[task.rawValue] ?? []
        lines.append(LogLine(id: UUID(), timestamp: Date(), level: level, text: trimmed))
        if lines.count > Self.maxLinesPerTask {
            lines.removeFirst(lines.count - Self.maxLinesPerTask)
        }
        buffers[task.rawValue] = lines
    }

    func clear(_ task: AutoTask) {
        buffers[task.rawValue] = []
    }

    func clearAll() {
        buffers = [:]
    }

    func lines(for task: AutoTask) -> [LogLine] {
        buffers[task.rawValue] ?? []
    }
}

/// Pure line splitter for streaming subprocess output. Feed it decoded
/// chunks; it emits complete lines and retains any trailing partial line
/// until the next chunk (or `flush()` at EOF). A value type — not
/// actor-isolated, fully testable off the main actor. Used by the `Pipe`
/// `readabilityHandler` in `AutoCodeUpdateService.runCLI`.
struct LineAccumulator: Equatable {
    private var pending = ""

    mutating func feed(_ chunk: String) -> [String] {
        pending += chunk
        var out: [String] = []
        while let nl = pending.firstIndex(of: "\n") {
            out.append(String(pending[..<nl]))
            pending = String(pending[pending.index(after: nl)...])
        }
        return out
    }

    /// Call at EOF: returns any trailing partial line, or nil if none.
    mutating func flush() -> String? {
        guard !pending.isEmpty else { return nil }
        let rest = pending
        pending = ""
        return rest
    }
}
