import Foundation

/// Centralized HTTP client operations. Single source of truth for:
/// - Request building with standard headers
/// - Error extraction from JSON responses
/// - Exponential backoff retry logic
/// - Transient error detection
/// - Secret redaction in logs
/// - URLSession configuration
///
/// Replaces scattered error handling across 6+ HTTP clients (245+ do-catch blocks).
struct HTTPClientUtilities {
    private let logHandler: (String, LogLevel) -> Void

    enum LogLevel {
        case debug, info, warning, error, critical
    }

    enum HTTPError: LocalizedError {
        case invalidResponse(statusCode: Int, body: String?)
        case decodingFailed(Error)
        case networkError(Error)
        case timeout, unauthorized, rateLimited
        case serverError(statusCode: Int)

        var errorDescription: String? {
            switch self {
            case .invalidResponse(let code, let body):
                return "HTTP \(code)\(body.map { ": \($0)" } ?? "")"
            case .decodingFailed(let error):
                return "Decoding error: \(error.localizedDescription)"
            case .networkError(let error):
                return "Network error: \(error.localizedDescription)"
            case .timeout:
                return "Request timeout"
            case .unauthorized:
                return "Unauthorized (401)"
            case .rateLimited:
                return "Rate limited (429)"
            case .serverError(let code):
                return "Server error (\(code))"
            }
        }

        var isTransient: Bool {
            switch self {
            case .timeout, .rateLimited, .networkError:
                return true
            case .serverError(let code) where code >= 500:
                return true
            default:
                return false
            }
        }

        var retryDelay: TimeInterval {
            switch self {
            case .rateLimited:
                return 5.0  // Rate limit: wait longer
            case .timeout:
                return 2.0
            case .serverError:
                return 3.0
            case .networkError:
                return 1.0
            default:
                return 0
            }
        }
    }

    init(logHandler: ((_ message: String, _ level: LogLevel) -> Void)? = nil) {
        self.logHandler = logHandler ?? { _, _ in }
    }

    // MARK: - URLSession Configuration

    /// Create a standard URLSessionConfiguration for the app.
    /// - Timeout: 30 seconds
    /// - Waits for connectivity
    /// - Allows cellular
    static func makeSessionConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = true
        config.allowsCellularAccess = true
        return config
    }

    private func extractErrorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let fields = ["error", "message", "msg", "error_description", "detail"]
        return fields.compactMap { json[$0] as? String }.first
    }

    private func errorForStatusCode(_ statusCode: Int, body: Data?) -> HTTPError {
        let bodyText = body.flatMap(extractErrorMessage(from:))
        switch statusCode {
        case 401: return .unauthorized
        case 429: return .rateLimited
        case 400..<500: return .invalidResponse(statusCode: statusCode, body: bodyText)
        case 500...: return .serverError(statusCode: statusCode)
        default: return .invalidResponse(statusCode: statusCode, body: bodyText)
        }
    }

    // MARK: - Retry Logic

    /// Execute request with exponential backoff retry.
    func executeWithRetry<T: Decodable>(
        url: URL,
        session: URLSession,
        maxAttempts: Int = 3,
        decode: @escaping (Data) throws -> T
    ) async throws -> T {
        var lastError: HTTPError?

        for attempt in 1...maxAttempts {
            do {
                logHandler("Request attempt \(attempt): \(url.host ?? "unknown")", .debug)
                let (data, response) = try await session.data(from: url)

                guard let httpResponse = response as? HTTPURLResponse else {
                    throw HTTPError.invalidResponse(statusCode: 0, body: nil)
                }

                guard (200..<300).contains(httpResponse.statusCode) else {
                    let error = errorForStatusCode(httpResponse.statusCode, body: data)
                    throw error
                }

                let decoded = try decode(data)
                logHandler("✓ Request succeeded: \(url.host ?? "unknown")", .info)
                return decoded

            } catch let error as HTTPError {
                lastError = error
                logHandler("✗ Attempt \(attempt) failed: \(error.errorDescription ?? "unknown")", .warning)

                guard error.isTransient && attempt < maxAttempts else {
                    throw error
                }

                let delay = exponentialBackoff(attempt: attempt, baseDelay: error.retryDelay)
                logHandler("Retrying in \(String(format: "%.1f", delay))s...", .debug)
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))

            } catch let error as DecodingError {
                logHandler("Decoding failed: \(error.localizedDescription)", .error)
                throw HTTPError.decodingFailed(error)

            } catch let error as URLError {
                lastError = HTTPError.networkError(error)
                logHandler("Network error: \(error.localizedDescription)", .warning)

                guard attempt < maxAttempts else {
                    throw HTTPError.networkError(error)
                }

                let delay = exponentialBackoff(attempt: attempt, baseDelay: 1.0)
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }

        throw lastError ?? HTTPError.networkError(NSError(domain: "HTTPClientUtilities", code: -1))
    }

    /// Calculate exponential backoff with jitter.
    private func exponentialBackoff(attempt: Int, baseDelay: TimeInterval) -> TimeInterval {
        let exponent = min(Double(attempt - 1), 5.0)  // Cap at 2^5 = 32x
        let baseWait = baseDelay * pow(2.0, exponent)
        let jitter = Double.random(in: 0..<0.1) * baseWait
        return baseWait + jitter
    }

    // MARK: - Request Building

    /// Build a request with standard headers.
    static func makeRequest(
        url: URL,
        method: String = "GET",
        bearerToken: String? = nil,
        additionalHeaders: [String: String]? = nil
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method

        // Set standard headers
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("LLM-IDE/1.0", forHTTPHeaderField: "User-Agent")

        // Add bearer token if provided
        if let token = bearerToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        // Add additional headers
        if let additional = additionalHeaders {
            for (key, value) in additional {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }

        return request
    }

    // MARK: - Secret Redaction

    /// Redact sensitive information from strings for logging.
    static func redactedForLogging(_ value: String) -> String {
        guard value.count > 4 else { return "***" }
        let prefix = String(value.prefix(2))
        let suffix = String(value.suffix(2))
        return "\(prefix)...\(suffix)"
    }

    /// Redact URL for logging (remove query parameters).
    static func redactedURLForLogging(_ url: URL) -> String {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.queryItems = nil
        return components?.url?.absoluteString ?? url.absoluteString
    }
}

// MARK: - Transient Error Detection

extension URLError {
    /// Check if error is transient (can retry).
    var isTransient: Bool {
        switch code {
        case .timedOut, .networkConnectionLost, .notConnectedToInternet, .dnsLookupFailed:
            return true
        default:
            return false
        }
    }
}
