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
