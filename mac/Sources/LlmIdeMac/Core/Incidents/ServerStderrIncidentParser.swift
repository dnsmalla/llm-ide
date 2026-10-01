import Foundation

/// Groups a backend stderr error line with the stack-trace frames that follow
/// it, so one JS exception becomes one `IncidentRecorder` call instead of N.
public struct ServerStderrIncidentParser {
    public struct Report: Equatable, Sendable {
        public var message: String
        public var stack: String?
    }

    private var pending: Report?
    private static let maxFrames = 30

    public init() {}

    public mutating func feed(_ line: String) -> [Report] {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("at "), var report = pending {
            let frames = (report.stack.map { $0 + "\n" } ?? "") + line
            report.stack = frames
            pending = report
            return frames.split(separator: "\n").count >= Self.maxFrames ? flush() : []
        }
        let done = flush()
        if Self.isErrorStart(trimmed) {
            pending = Report(message: trimmed, stack: nil)
        }
        return done
    }

    public mutating func flush() -> [Report] {
        defer { pending = nil }
        return pending.map { [$0] } ?? []
    }

    private static func isErrorStart(_ line: String) -> Bool {
        line.hasPrefix("ERROR:") || line.hasPrefix("Uncaught") || line.contains("Error:")
            || line.range(of: #"^\w*Error\b"#, options: .regularExpression) != nil
    }
}
