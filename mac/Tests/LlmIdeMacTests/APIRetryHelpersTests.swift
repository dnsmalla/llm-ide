import Testing
import Foundation
@testable import LlmIdeMac

/// Covers the bounded-retry helpers added to LlmIdeAPIClient: which network
/// errors are considered transient, exponential backoff growth, and Retry-After
/// parsing/capping.
struct APIRetryHelpersTests {

    @Test func transientNetworkErrorsAreRetryable() {
        #expect(LlmIdeAPIClient.isTransient(URLError(.timedOut)))
        #expect(LlmIdeAPIClient.isTransient(URLError(.cannotConnectToHost)))
        #expect(LlmIdeAPIClient.isTransient(URLError(.networkConnectionLost)))
        #expect(LlmIdeAPIClient.isTransient(URLError(.dnsLookupFailed)))
    }

    @Test func nonTransientErrorsAreNotRetryable() {
        // A permanent TLS failure must not be retried.
        #expect(!LlmIdeAPIClient.isTransient(URLError(.serverCertificateUntrusted)))
        // Non-URL errors are never transient.
        #expect(!LlmIdeAPIClient.isTransient(
            NSError(domain: "Other", code: 1)))
    }

    @Test func backoffGrowsExponentiallyAndCaps() {
        let a1 = LlmIdeAPIClient.backoffNanos(1)
        let a2 = LlmIdeAPIClient.backoffNanos(2)
        let a3 = LlmIdeAPIClient.backoffNanos(3)
        #expect(a1 == UInt64(0.4 * 1_000_000_000))
        #expect(a2 == UInt64(0.8 * 1_000_000_000))
        #expect(a2 > a1 && a3 > a2)
        // Caps at 5s no matter how large the attempt.
        #expect(LlmIdeAPIClient.backoffNanos(50) == UInt64(5.0 * 1_000_000_000))
    }

    @Test func retryAfterIsParsedAndCapped() throws {
        let url = URL(string: "https://example.com")!
        func resp(_ headers: [String: String]) -> HTTPURLResponse {
            HTTPURLResponse(url: url, statusCode: 429, httpVersion: nil, headerFields: headers)!
        }
        #expect(LlmIdeAPIClient.retryAfterNanos(resp(["Retry-After": "2"]))
                == UInt64(2.0 * 1_000_000_000))
        // Capped at 10s.
        #expect(LlmIdeAPIClient.retryAfterNanos(resp(["Retry-After": "9999"]))
                == UInt64(10.0 * 1_000_000_000))
        // Absent / malformed → nil (caller falls back to exponential backoff).
        #expect(LlmIdeAPIClient.retryAfterNanos(resp([:])) == nil)
        #expect(LlmIdeAPIClient.retryAfterNanos(resp(["Retry-After": "soon"])) == nil)
    }
}
