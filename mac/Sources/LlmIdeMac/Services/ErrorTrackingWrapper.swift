import Foundation

/// Centralized error tracking for silent failures. Single source of truth for:
/// - Tracking suppressed errors (try? operations)
/// - Consistent error logging
/// - Error classification
/// - Recovery suggestions
///
/// Replaces 301+ scattered try? calls across 100 files that mask failures.
struct ErrorTrackingWrapper {
    private let logHandler: (String, ErrorLevel) -> Void
    private let errorCollector: ((TrackedError) -> Void)?

    enum ErrorLevel {
        case info, warning, error, critical
    }

    init(
        logHandler: ((_ message: String, _ level: ErrorLevel) -> Void)? = nil,
        errorCollector: ((_ error: TrackedError) -> Void)? = nil
    ) {
        self.logHandler = logHandler ?? { _, _ in }
        self.errorCollector = errorCollector
    }

    // MARK: - Tracked Try Operations

    /// Execute operation and track any error (instead of silent try?).
    /// Returns result if successful, nil if failed (same as try? but logs).
    func track<T>(
        _ operation: @escaping () throws -> T,
        context: String,
        fallback: T? = nil
    ) -> T? {
        do {
            let result = try operation()
            logHandler("✓ \(context)", .info)
            return result
        } catch {
            let trackedError = TrackedError(
                operation: context,
                error: error,
                level: .warning,
                timestamp: Date()
            )
            logHandler("✗ \(context): \(error.localizedDescription)", .warning)
            errorCollector?(trackedError)
            return fallback
        }
    }

    /// Execute operation asynchronously and track errors.
    func trackAsync<T>(
        _ operation: @escaping () async throws -> T,
        context: String,
        fallback: T? = nil
    ) async -> T? {
        do {
            let result = try await operation()
            logHandler("✓ \(context)", .info)
            return result
        } catch {
            let trackedError = TrackedError(
                operation: context,
                error: error,
                level: .warning,
                timestamp: Date()
            )
            logHandler("✗ \(context): \(error.localizedDescription)", .warning)
            errorCollector?(trackedError)
            return fallback
        }
    }

    // MARK: - Common Patterns

    func decodeSafely<T: Decodable>(
        _ data: Data,
        as type: T.Type,
        context: String = "JSON decode"
    ) -> T? {
        track({ try JSONDecoder().decode(type, from: data) }, context: context)
    }

    func loadFileSafely(at url: URL, context: String = "File load") -> Data? {
        track({ try Data(contentsOf: url) }, context: "\(context): \(url.lastPathComponent)")
    }

    /// Execute task and log critical failures (don't suppress).
    func executeWithLogging<T>(
        _ operation: @escaping () throws -> T,
        context: String
    ) -> T? {
        do {
            return try operation()
        } catch {
            let trackedError = TrackedError(
                operation: context,
                error: error,
                level: .critical,
                timestamp: Date()
            )
            logHandler("🚨 CRITICAL: \(context): \(error.localizedDescription)", .critical)
            errorCollector?(trackedError)
            return nil
        }
    }

    // MARK: - Error Classification

    /// Classify error as transient (can retry) or permanent (cannot fix by retry).
    static func isTransientError(_ error: Error) -> Bool {
        // Network errors
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut, .networkConnectionLost, .notConnectedToInternet:
                return true
            default:
                return false
            }
        }

        // HTTP 429 (rate limit) or 503 (service unavailable)
        let nsError = error as NSError
        if nsError.code == 429 || nsError.code == 503 {
            return true
        }

        return false
    }

    /// Get retry suggestion for an error.
    static func retryStrategy(for error: Error) -> RetryStrategy {
        if isTransientError(error) {
            return .retryWithBackoff(baseDelay: 1.0, maxAttempts: 3)
        }
        return .doNotRetry
    }

    enum RetryStrategy {
        case doNotRetry
        case retryImmediate
        case retryWithBackoff(baseDelay: TimeInterval, maxAttempts: Int)
    }
}

// MARK: - Tracked Error Type

struct TrackedError: Equatable {
    let operation: String
    let error: Error
    let level: ErrorTrackingWrapper.ErrorLevel
    let timestamp: Date

    static func == (lhs: TrackedError, rhs: TrackedError) -> Bool {
        lhs.operation == rhs.operation &&
        lhs.error.localizedDescription == rhs.error.localizedDescription &&
        lhs.timestamp == rhs.timestamp
    }

    var summary: String {
        "[\(level)] \(operation): \(error.localizedDescription)"
    }
}

// MARK: - Extensions for Common Types

extension ErrorTrackingWrapper.ErrorLevel: CustomStringConvertible {
    var description: String {
        switch self {
        case .info: return "ℹ️"
        case .warning: return "⚠️"
        case .error: return "❌"
        case .critical: return "🚨"
        }
    }
}
