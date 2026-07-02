import Testing
import RepoKit
import Foundation
@testable import LlmIdeMac

/// Production-hardening regressions for the GitHub/GitLab data layer:
///  - a partial update must NOT wipe the issue title (GitLab data loss),
///  - decoding must survive deleted/ghost authors (one bad row blanked the list).
struct RepoPayloadHardeningTests {

    // MARK: - GitLab title-wipe (P0)

    @Test func gitLabPayloadOmitsNilTitle() throws {
        // A label-only / state-only update carries no title; the encoded JSON
        // must omit `title` entirely so GitLab leaves the existing title intact.
        let payload = GitLabIssuePayload(title: nil, labels: "status::doing")
        let data = try JSONEncoder().encode(payload)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(!json.contains("\"title\""), "nil title must be omitted, not serialized as \"\": \(json)")
        #expect(json.contains("status::doing"))
    }

    @Test func gitLabPayloadEncodesProvidedTitle() throws {
        let payload = GitLabIssuePayload(title: "Real title")
        let json = String(data: try JSONEncoder().encode(payload), encoding: .utf8) ?? ""
        #expect(json.contains("Real title"))
    }

    // MARK: - Ghost-author decode resilience

    @Test func gitLabUserDecodesWithMissingName() throws {
        // GitLab service/deleted accounts can omit `name`; decode must not throw.
        let json = #"{"id": 7, "username": "svc"}"#.data(using: .utf8)!
        let user = try JSONDecoder().decode(GitLabUser.self, from: json)
        #expect(user.username == "svc")
        #expect(user.name == "svc")   // falls back to username
    }

    @Test func gitLabUserDecodesWithNullName() throws {
        let json = #"{"id": 7, "username": "svc", "name": null}"#.data(using: .utf8)!
        let user = try JSONDecoder().decode(GitLabUser.self, from: json)
        #expect(user.name == "svc")
    }

    @Test func repoUserGhostFallbackIsStable() {
        #expect(RepoUser.ghost.id == "ghost")
        #expect(RepoUser.ghost.displayName == "(deleted user)")
    }
}
