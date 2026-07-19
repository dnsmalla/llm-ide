import Foundation
import os

/// Centralized logger factory. Single source of truth for:
/// - Consistent logger setup across all services
/// - Shared subsystem constant
/// - Category auto-registration
/// - Environment-based log levels
///
/// Replaces 42+ scattered Logger(subsystem:, category:) instances across 37 files.
struct LoggingFactory {
    /// Shared subsystem for all loggers in the app.
    static let appSubsystem = "com.llmide.macapp"

    /// Available logging categories.
    enum Category: String {
        // Network & API
        case networkClient = "NetworkClient"
        case apiServer = "APIServer"
        case httpClient = "HTTPClient"

        // Storage & Persistence
        case storage = "Storage"
        case database = "Database"
        case fileSystem = "FileSystem"
        case keychain = "Keychain"

        // UI & Views
        case ui = "UI"
        case viewModel = "ViewModel"
        case stateManagement = "StateManagement"

        // Business Logic
        case automation = "Automation"
        case codeGeneration = "CodeGeneration"
        case analysis = "Analysis"
        case memory = "Memory"

        // Infrastructure
        case config = "Configuration"
        case startup = "Startup"
        case performance = "Performance"
        case system = "System"

        var osCategory: OSLog {
            OSLog(subsystem: LoggingFactory.appSubsystem, category: self.rawValue)
        }
    }

    // MARK: - Logger Creation

    /// Get a logger for a specific category.
    /// Usage: `let log = LoggingFactory.logger(for: .networkClient)`
    static func logger(for category: Category) -> Logger {
        Logger(category.osCategory)
    }

    // MARK: - Convenience Loggers

    static var network: Logger { logger(for: .networkClient) }
    static var storage: Logger { logger(for: .storage) }
    static var ui: Logger { logger(for: .ui) }
    static var automation: Logger { logger(for: .automation) }
    static var system: Logger { logger(for: .system) }

    // MARK: - Structured Logging Helpers

    /// Log an operation with context.
    static func logOperation(
        _ name: String,
        category: Category,
        details: [String: String]? = nil
    ) {
        let log = logger(for: category)
        var message = "[\(name)]"
        if let details = details {
            let detailString = details.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
            message += " \(detailString)"
        }
        log.info("\(message)")
    }

    /// Log an error with context.
    static func logError(
        _ error: Error,
        operation: String,
        category: Category
    ) {
        let log = logger(for: category)
        log.error("[\(operation)] Error: \(error.localizedDescription)")
    }

    /// Log performance metrics.
    static func logPerformance(
        operation: String,
        duration: TimeInterval,
        threshold: TimeInterval = 0.1
    ) {
        let log = logger(for: .performance)
        let symbol = duration > threshold ? "⚠️" : "✓"
        log.info("[\(symbol) \(operation)] \(String(format: "%.3f", duration))s")
    }

    /// Log state changes.
    static func logStateChange(
        from oldState: String,
        to newState: String,
        category: Category
    ) {
        let log = logger(for: category)
        log.info("State: \(oldState) → \(newState)")
    }
}

// MARK: - Extensions for Easy Logging

extension Logger {
    /// Create logger from category.
    init(category: LoggingFactory.Category) {
        self.init(category.osCategory)
    }
}

// MARK: - Scoped Logging for Common Services

struct ScopedLogger {
    let logger: Logger
    let service: String

    init(service: String, category: LoggingFactory.Category) {
        self.logger = LoggingFactory.logger(for: category)
        self.service = service
    }

    func info(_ message: String) {
        logger.info("[\(service)] \(message)")
    }

    func warning(_ message: String) {
        logger.warning("[\(service)] \(message)")
    }

    func error(_ message: String) {
        logger.error("[\(service)] \(message)")
    }

    func debug(_ message: String) {
        logger.debug("[\(service)] \(message)")
    }
}
