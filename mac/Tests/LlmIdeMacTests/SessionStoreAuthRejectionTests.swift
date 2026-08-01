import XCTest
@testable import LlmIdeMacLib

/// `SessionStore.isDefinitiveAuthRejection` is the guard that stops the app
/// from auto-logging-out on a *transient* refresh failure (backend
/// unreachable / timeout / 5xx). Only a real HTTP 401/403 from
/// `/auth/refresh` may count as "token is dead → log out". Regression guard
/// for the SessionStore fix.
final class SessionStoreAuthRejectionTests: XCTestCase {

    func testOnly401And403AreDefinitive() {
        XCTAssertTrue(SessionStore.isDefinitiveAuthRejection(
            APIError.http(status: 401, code: "AUTH_REQUIRED", message: "expired", details: nil)))
        XCTAssertTrue(SessionStore.isDefinitiveAuthRejection(
            APIError.http(status: 403, code: "FORBIDDEN", message: "disabled", details: nil)))
    }

    func testOtherHttpStatusesAreTransient() {
        // 5xx (server error), 429 (rate limit), 4xx-other — all must keep the session.
        for status in [400, 404, 429, 500, 502, 503, 504] {
            XCTAssertFalse(SessionStore.isDefinitiveAuthRejection(
                APIError.http(status: status, code: "X", message: "m", details: nil)),
                "expected HTTP \(status) to be transient (no logout)")
        }
    }

    func testNetworkErrorsAreTransient() {
        XCTAssertFalse(SessionStore.isDefinitiveAuthRejection(APIError.network(URLError(.cannotConnectToHost))))
        XCTAssertFalse(SessionStore.isDefinitiveAuthRejection(APIError.network(URLError(.timedOut))))
        XCTAssertFalse(SessionStore.isDefinitiveAuthRejection(APIError.network(URLError(.cannotFindHost))))
    }

    func testNonHttpAPIErrorsAreTransient() {
        XCTAssertFalse(SessionStore.isDefinitiveAuthRejection(APIError.invalidURL))
        XCTAssertFalse(SessionStore.isDefinitiveAuthRejection(APIError.noSession))
        XCTAssertFalse(SessionStore.isDefinitiveAuthRejection(APIError.agent(message: "boom")))
    }

    func testDecodingErrorIsTransient() {
        XCTAssertFalse(SessionStore.isDefinitiveAuthRejection(sampleDecodingError()))
    }

    func testNonAPIErrorIsTransient() {
        XCTAssertFalse(SessionStore.isDefinitiveAuthRejection(NSError(domain: "boom", code: 42)))
    }

    /// Capture a real `DecodingError` so the `as? APIError` path is exercised
    /// against an error that is NOT an `APIError`.
    private func sampleDecodingError() -> Error {
        struct Empty: Decodable {}
        do { _ = try JSONDecoder().decode(Empty.self, from: Data("{".utf8)); return NSError(domain: "noThrow", code: 0) }
        catch { return error }
    }
}
