import Testing
import Foundation
@testable import MeetNotesMac

@Test func agentContextEncodesEmptyFieldsAsAbsentAndEmptyArray() throws {
    // Swift's default JSONEncoder omits nil-valued Optional keys
    // entirely rather than emitting `null`. Pin that contract here
    // — the server is fine with absent keys, but if any consumer
    // ever starts requiring explicit nulls we'll need a custom
    // `encode(to:)` on AgentContext. Updating this test on its own
    // would silently weaken the contract.
    let ctx = AgentContext(activeProject: nil, indexedRepos: [])
    let data = try JSONEncoder().encode(ctx)
    let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    #expect(json["activeProject"] == nil)
    #expect((json["indexedRepos"] as? [Any])?.isEmpty == true)
}

@Test func agentContextEncodesActiveProject() throws {
    let ctx = AgentContext(
        activeProject: .init(name: "notes-extension", url: "https://gitlab.com/x/notes", defaultBranch: "main"),
        indexedRepos: [.init(name: "notes-extension", path: "~/Developer/MeetNotes/notes-extension")]
    )
    let data = try JSONEncoder().encode(ctx)
    let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let proj = json["activeProject"] as! [String: Any]
    #expect(proj["name"] as? String == "notes-extension")
    #expect(proj["defaultBranch"] as? String == "main")
}

@Test func pendingToolDecodesCreateGitLabIssue() throws {
    let json = """
    {"name":"create-gitlab-issue","arguments":{"title":"x","description":"y","labels":["a"]}}
    """.data(using: .utf8)!
    let pt = try JSONDecoder().decode(PendingTool.self, from: json)
    #expect(pt.name == "create-gitlab-issue")
    #expect(pt.createIssueArgs?.title == "x")
    #expect(pt.createIssueArgs?.description == "y")
    #expect(pt.createIssueArgs?.labels == ["a"])
}

@Test func pendingToolDecodesAssigneeOptional() throws {
    let json = """
    {"name":"create-gitlab-issue","arguments":{"title":"x","description":"y"}}
    """.data(using: .utf8)!
    let pt = try JSONDecoder().decode(PendingTool.self, from: json)
    #expect(pt.createIssueArgs?.assignee == nil)
    #expect(pt.createIssueArgs?.labels == nil)
}
