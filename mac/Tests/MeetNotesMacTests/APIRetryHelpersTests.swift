import Testing
import Foundation
@testable import MeetNotesMac

/// Covers the bounded-retry helpers added to MeetNotesAPIClient: which network
/// errors are considered transient, exponential backoff growth, and Retry-After
/// parsing/capping.
struct APIRetryHelpersTests {

    @Test func transientNetworkErrorsAreRetryable() {
        #expect(MeetNotesAPIClient.isTransient(URLError(.timedOut)))
        #expect(MeetNotesAPIClient.isTransient(URLError(.cannotConnectToHost)))
        #expect(MeetNotesAPIClient.isTransient(URLError(.networkConnectionLost)))
        #expect(MeetNotesAPIClient.isTransient(URLError(.dnsLookupFailed)))
    }

    @Test func nonTransientErrorsAreNotRetryable() {
        // A permanent TLS failure must not be retried.
        #expect(!MeetNotesAPIClient.isTransient(URLError(.serverCertificateUntrusted)))
        // Non-URL errors are never transient.
        #expect(!MeetNotesAPIClient.isTransient(
            NSError(domain: "Other", code: 1)))
    }

    @Test func backoffGrowsExponentiallyAndCaps() {
        let a1 = MeetNotesAPIClient.backoffNanos(1)
        let a2 = MeetNotesAPIClient.backoffNanos(2)
        let a3 = MeetNotesAPIClient.backoffNanos(3)
        #expect(a1 == UInt64(0.4 * 1_000_000_000))
        #expect(a2 == UInt64(0.8 * 1_000_000_000))
        #expect(a2 > a1 && a3 > a2)
        // Caps at 5s no matter how large the attempt.
        #expect(MeetNotesAPIClient.backoffNanos(50) == UInt64(5.0 * 1_000_000_000))
    }

    @Test func retryAfterIsParsedAndCapped() throws {
        let url = URL(string: "https://example.com")!
        func resp(_ headers: [String: String]) -> HTTPURLResponse {
            HTTPURLResponse(url: url, statusCode: 429, httpVersion: nil, headerFields: headers)!
        }
        #expect(MeetNotesAPIClient.retryAfterNanos(resp(["Retry-After": "2"]))
                == UInt64(2.0 * 1_000_000_000))
        // Capped at 10s.
        #expect(MeetNotesAPIClient.retryAfterNanos(resp(["Retry-After": "9999"]))
                == UInt64(10.0 * 1_000_000_000))
        // Absent / malformed → nil (caller falls back to exponential backoff).
        #expect(MeetNotesAPIClient.retryAfterNanos(resp([:])) == nil)
        #expect(MeetNotesAPIClient.retryAfterNanos(resp(["Retry-After": "soon"])) == nil)
    }
}
