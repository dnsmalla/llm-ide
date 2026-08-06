import XCTest
@testable import LlmIdeMacLib

/// AuthRedirectGuard.redirectRequest decides whether a redirected request
/// keeps its auth headers. Getting this wrong either leaks a PAT to a
/// third-party host on a cross-host redirect, or breaks legitimate
/// same-host redirects (e.g. GitHub's /user -> /users/<login> bounce) by
/// stripping credentials that should have stayed.
final class AuthRedirectGuardTests: XCTestCase {
    private func request(to urlString: String, headers: [String: String] = [:]) -> URLRequest {
        var req = URLRequest(url: URL(string: urlString)!)
        for (key, value) in headers {
            req.setValue(value, forHTTPHeaderField: key)
        }
        return req
    }

    func testSameHostKeepsHeaders() {
        let req = request(to: "https://api.github.com/users/octocat",
                           headers: ["Authorization": "token secret"])
        let result = AuthRedirectGuard.redirectRequest(
            originalHost: "api.github.com", newRequest: req, strippingHeaders: ["Authorization"])
        XCTAssertEqual(result.value(forHTTPHeaderField: "Authorization"), "token secret")
    }

    func testSameHostIsCaseInsensitive() {
        let req = request(to: "https://API.GitHub.com/users/octocat",
                           headers: ["Authorization": "token secret"])
        let result = AuthRedirectGuard.redirectRequest(
            originalHost: "api.github.com", newRequest: req, strippingHeaders: ["Authorization"])
        XCTAssertEqual(result.value(forHTTPHeaderField: "Authorization"), "token secret")
    }

    func testCrossHostStripsHeader() {
        let req = request(to: "https://evil.example/steal",
                           headers: ["Authorization": "token secret"])
        let result = AuthRedirectGuard.redirectRequest(
            originalHost: "api.github.com", newRequest: req, strippingHeaders: ["Authorization"])
        XCTAssertNil(result.value(forHTTPHeaderField: "Authorization"))
    }

    func testCrossHostStripsMultipleHeaders() {
        let req = request(to: "https://evil.example/steal",
                           headers: ["Authorization": "Bearer secret", "PRIVATE-TOKEN": "glpat-secret"])
        let result = AuthRedirectGuard.redirectRequest(
            originalHost: "gitlab.example.com", newRequest: req,
            strippingHeaders: ["Authorization", "PRIVATE-TOKEN"])
        XCTAssertNil(result.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(result.value(forHTTPHeaderField: "PRIVATE-TOKEN"))
    }

    func testStrippingAnAbsentHeaderIsSafe() {
        let req = request(to: "https://evil.example/steal", headers: ["Authorization": "token secret"])
        let result = AuthRedirectGuard.redirectRequest(
            originalHost: "api.github.com", newRequest: req,
            strippingHeaders: ["Authorization", "PRIVATE-TOKEN"])
        XCTAssertNil(result.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(result.value(forHTTPHeaderField: "PRIVATE-TOKEN"))
    }

    /// No original host (task.originalRequest was nil) must fail safe —
    /// treated as cross-host, not as "no check needed."
    func testNilOriginalHostStripsHeader() {
        let req = request(to: "https://api.github.com/users/octocat",
                           headers: ["Authorization": "token secret"])
        let result = AuthRedirectGuard.redirectRequest(
            originalHost: nil, newRequest: req, strippingHeaders: ["Authorization"])
        XCTAssertNil(result.value(forHTTPHeaderField: "Authorization"))
    }

    func testUnrelatedHeadersSurviveCrossHostStrip() {
        let req = request(to: "https://evil.example/steal",
                           headers: ["Authorization": "token secret", "Accept": "application/json"])
        let result = AuthRedirectGuard.redirectRequest(
            originalHost: "api.github.com", newRequest: req, strippingHeaders: ["Authorization"])
        XCTAssertEqual(result.value(forHTTPHeaderField: "Accept"), "application/json")
    }
}
