import XCTest
@testable import LlmIdeMac

/// `SecretRedactor` is the Swift counterpart of the extension's shared
/// `core/redact-secrets.mjs` pattern set. It scrubs *unknown* credential shapes
/// (ones git/a remote echoes back that the caller never held as a token) out of
/// text before it surfaces in an error or log — defense-in-depth beyond the
/// known-token replacement `RepoManager.redact` already does.
final class SecretRedactorTests: XCTestCase {

    func testRedactsGitHubClassicPat() {
        let token = "ghp_" + String(repeating: "a", count: 36)
        let out = SecretRedactor.redact("remote: Bad credentials for \(token).")
        XCTAssertFalse(out.contains(token), "ghp_ token must be redacted")
        XCTAssertTrue(out.contains("[REDACTED]"))
    }

    func testRedactsAnthropicKey() {
        let key = "sk-ant-api03-" + String(repeating: "x", count: 20)
        let out = SecretRedactor.redact("invalid x-api-key: \(key)")
        XCTAssertFalse(out.contains(key))
        XCTAssertTrue(out.contains("[REDACTED]"))
    }

    func testRedactsBearerAndAwsAndSlack() {
        let bearer = "Bearer " + String(repeating: "A", count: 30)
        let aws = "AKIA" + String(repeating: "Z", count: 16)
        let slack = "xoxb-" + String(repeating: "9", count: 20)
        let out = SecretRedactor.redact("\(bearer)\n\(aws)\n\(slack)")
        XCTAssertFalse(out.contains(String(repeating: "A", count: 30)))
        XCTAssertFalse(out.contains(aws))
        XCTAssertFalse(out.contains(slack))
    }

    func testRedactsGitHubOAuthAndAppTokens() {
        // gho_/ghu_/ghs_/ghr_ share ghp_'s shape and are equally leakable.
        for prefix in ["gho_", "ghu_", "ghs_", "ghr_"] {
            let token = prefix + String(repeating: "a", count: 36)
            let out = SecretRedactor.redact("token=\(token)")
            XCTAssertFalse(out.contains(token), "\(prefix) token must be redacted")
            XCTAssertTrue(out.contains("[REDACTED]"))
        }
    }

    func testRedactsGitLabTokens() {
        let cases = [
            "glpat-" + String(repeating: "a", count: 20),
            "glrt-" + String(repeating: "b", count: 24),
            "gldt-" + String(repeating: "c", count: 24),
        ]
        for token in cases {
            let out = SecretRedactor.redact("GitLab error for \(token)")
            XCTAssertFalse(out.contains(token), "GitLab token must be redacted: \(token)")
            XCTAssertTrue(out.contains("[REDACTED]"))
        }
    }

    func testRedactsOpenAIKeys() {
        let proj = "sk-proj-" + String(repeating: "b", count: 40)
        let classic = "sk-" + String(repeating: "a", count: 48)
        let out = SecretRedactor.redact("\(proj)\n\(classic)")
        XCTAssertFalse(out.contains(proj))
        XCTAssertFalse(out.contains(classic))
    }

    func testLeavesOrdinaryTextUntouched() {
        let text = "fatal: repository not found at https://github.com/acme/widgets.git"
        XCTAssertEqual(SecretRedactor.redact(text), text)
    }
}
