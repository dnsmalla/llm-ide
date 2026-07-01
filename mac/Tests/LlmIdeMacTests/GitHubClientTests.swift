import Testing
@testable import LlmIdeMac

struct GitHubClientTests {
    @Test func parsesHttpsURL() {
        let parsed = GitHubClient.ownerAndName(from: "https://github.com/acme/widget")
        #expect(parsed?.0 == "acme")
        #expect(parsed?.1 == "widget")
    }

    @Test func parsesHttpsURLWithDotGit() {
        let parsed = GitHubClient.ownerAndName(from: "https://github.com/acme/widget.git")
        #expect(parsed?.0 == "acme")
        #expect(parsed?.1 == "widget")
    }

    @Test func parsesShorthand() {
        let parsed = GitHubClient.ownerAndName(from: "acme/widget")
        #expect(parsed?.0 == "acme")
        #expect(parsed?.1 == "widget")
    }

    @Test func rejectsNonGithubHost() {
        // v1 doesn't support GitHub Enterprise; fail closed on other hosts
        // so a typo doesn't silently route to api.github.com against the
        // wrong owner/name pair.
        #expect(GitHubClient.ownerAndName(from: "https://gitlab.com/acme/widget") == nil)
        #expect(GitHubClient.ownerAndName(from: "https://example.com/acme/widget") == nil)
    }

    @Test func rejectsMalformedInputs() {
        #expect(GitHubClient.ownerAndName(from: "") == nil)
        #expect(GitHubClient.ownerAndName(from: "owner-only") == nil)
        #expect(GitHubClient.ownerAndName(from: "https://github.com/acme") == nil)
        #expect(GitHubClient.ownerAndName(from: "https://github.com/") == nil)
    }

    @Test func permission403TranslatesToActionableHint() {
        // GitHub's "Resource not accessible by personal access token" is opaque;
        // the client should explain it's a token-permission problem.
        let msg = GitHubClient.GitHubError
            .httpError(403, "Resource not accessible by personal access token")
            .errorDescription ?? ""
        #expect(msg.contains("permission"))
        #expect(msg.localizedCaseInsensitiveContains("Issues"))
        #expect(msg.contains("Settings → GitHub"))
    }

    @Test func otherHttpErrorsKeepRawMessage() {
        // A 404 (or any non-permission status) should pass GitHub's message through.
        let msg = GitHubClient.GitHubError.httpError(404, "Not Found").errorDescription ?? ""
        #expect(msg.contains("404"))
        #expect(msg.contains("Not Found"))
    }

    @Test func handlesTrailingSlashesAndExtraPath() {
        // Extra path segments after owner/name (e.g. /tree/main) are
        // tolerated — we only consume the first two segments.
        let parsed = GitHubClient.ownerAndName(from: "https://github.com/acme/widget/tree/main")
        #expect(parsed?.0 == "acme")
        #expect(parsed?.1 == "widget")
        let trailing = GitHubClient.ownerAndName(from: "acme/widget/")
        #expect(trailing?.0 == "acme")
        #expect(trailing?.1 == "widget")
    }
}
