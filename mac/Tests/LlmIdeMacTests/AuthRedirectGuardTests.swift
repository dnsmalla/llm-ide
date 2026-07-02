import XCTest
@testable import LlmIdeMac

final class AuthRedirectGuardTests: XCTestCase {
    private func request(host: String, headers: [String: String]) -> URLRequest {
        var r = URLRequest(url: URL(string: "https://\(host)/path")!)
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    func testSameHostKeepsAuthHeaders() {
        let new = request(host: "api.github.com", headers: ["Authorization": "Bearer x"])
        let out = AuthRedirectGuard.redirectRequest(
            originalHost: "api.github.com", newRequest: new, strippingHeaders: ["Authorization"])
        XCTAssertEqual(out.value(forHTTPHeaderField: "Authorization"), "Bearer x")
    }

    func testHostComparisonIsCaseInsensitive() {
        let new = request(host: "API.GitHub.com", headers: ["Authorization": "Bearer x"])
        let out = AuthRedirectGuard.redirectRequest(
            originalHost: "api.github.com", newRequest: new, strippingHeaders: ["Authorization"])
        XCTAssertEqual(out.value(forHTTPHeaderField: "Authorization"), "Bearer x")
    }

    func testCrossHostStripsOnlyListedHeaders() {
        let new = request(host: "evil.example.com",
                          headers: ["Authorization": "Bearer x",
                                    "PRIVATE-TOKEN": "glpat-x",
                                    "Accept": "application/json"])
        let out = AuthRedirectGuard.redirectRequest(
            originalHost: "gitlab.example.com", newRequest: new,
            strippingHeaders: ["PRIVATE-TOKEN", "Authorization"])
        XCTAssertNil(out.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(out.value(forHTTPHeaderField: "PRIVATE-TOKEN"))
        XCTAssertEqual(out.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    func testNilOriginalHostIsTreatedAsCrossHost() {
        let new = request(host: "somewhere.com", headers: ["Authorization": "Bearer x"])
        let out = AuthRedirectGuard.redirectRequest(
            originalHost: nil, newRequest: new, strippingHeaders: ["Authorization"])
        XCTAssertNil(out.value(forHTTPHeaderField: "Authorization"))
    }
}
