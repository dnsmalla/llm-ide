import XCTest
@testable import LlmIdeMacLib

/// `/generate-doc` answers 404 `feature_disabled` when the server has Doc Gen
/// turned off. The client names that case; every other failure keeps the
/// server's redacted message.
final class GenerateDocFailureTests: XCTestCase {

    private func failure(_ status: Int, _ body: String) -> APIError {
        LlmIdeAPIClient.generateDocFailure(status: status, body: Data(body.utf8))
    }

    func testFeatureDisabledIsNamedClearly() throws {
        let error = failure(404, #"{"error":"feature_disabled","feature":"doc_gen"}"#)
        guard case .http(let status, let code, let message, _) = error else {
            return XCTFail("expected .http, got \(error)")
        }
        XCTAssertEqual(status, 404)
        XCTAssertEqual(code, "feature_disabled")
        XCTAssertEqual(message, "The connected server has Doc Gen turned off.")
        XCTAssertEqual(error.errorDescription, "The connected server has Doc Gen turned off.")
    }

    func testOtherFeatureDisabled404IsNotMistakenForDocGen() throws {
        let error = failure(404, #"{"error":"feature_disabled","feature":"gantt_issues"}"#)
        XCTAssertNotEqual(error.code, "feature_disabled")
        XCTAssertNotEqual(error.errorDescription, "The connected server has Doc Gen turned off.")
    }

    func testStructuredServerErrorKeepsItsMessage() throws {
        let error = failure(500, #"{"error":{"code":"LLM_DOWN","message":"model unavailable"}}"#)
        XCTAssertEqual(error.code, "LLM_DOWN")
        XCTAssertEqual(error.errorDescription, "model unavailable")
    }

    func testUnparseableBodyFallsBackToGenericText() throws {
        let error = failure(502, "<html>bad gateway</html>")
        XCTAssertEqual(error.code, "GENERATE_DOC_FAILED")
        XCTAssertEqual(error.errorDescription, "Document generation failed (HTTP 502)")
    }
}
