import Testing
import Foundation
import SharedProtocol

private func project(_ id: String, _ name: String, _ role: String) -> HostApiProjectsListResultProjectsItem {
    HostApiProjectsListResultProjectsItem(id: id, maxMode: "execute", name: name, permissions: ["self.read"],
                                          role: role, usdCapMonth: 0)
}

private func rejection(_ code: String, _ message: String) -> HostApiRejection {
    HostApiRejection(replyTo: nil, code: code, message: message)
}

/// A host whose replies the test releases one by one, so ordering races can be scripted.
@MainActor
final class FakeProjectHost: HostConnection {
    var apiVersion = 1
    var state: HostConnectionState = .connected
    var capabilities: Set<String> = ["host", "chat"]
    var onEvent: ((HostEvent) -> Void)?
    private(set) var calls: [(command: HostApiCommand, payload: Data)] = []
    private var waiting: [CheckedContinuation<Data, Error>] = []

    func send(_ command: HostApiCommand, payload: Data, id: String?) async throws -> Data {
        calls.append((command, payload))
        return try await withCheckedThrowingContinuation { waiting.append($0) }
    }
    func close() {}
    func answer<R: Encodable>(_ i: Int, _ result: R) { waiting[i].resume(returning: try! JSONEncoder().encode(result)) }
    func fail(_ i: Int, _ code: String, _ message: String) {
        waiting[i].resume(throwing: rejection(code, message))
    }
    func waitForCalls(_ n: Int) async { for _ in 0..<1000 where calls.count < n { await Task.yield() } }
    func payload<P: Decodable>(_ i: Int, as: P.Type) -> P { try! JSONDecoder().decode(P.self, from: calls[i].payload) }
}

@MainActor
@Suite("HostApiProjectController")
struct HostApiProjectControllerTests {
    let host = FakeProjectHost()

    func controller(stored: String? = nil, persist: @escaping (String?) -> Void = { _ in }) -> HostApiProjectController {
        HostApiProjectController(host: { [host] in host }, storedId: { stored }, persist: persist)
    }

    func load(_ c: HostApiProjectController, _ projects: [HostApiProjectsListResultProjectsItem]) async {
        let n = host.calls.count
        let t = Task { await c.refresh() }
        await host.waitForCalls(n + 1)
        host.answer(n, HostApiProjectsListResult(projects: projects))
        await t.value
    }

    @Test("projects.list sends an empty request, selects the first project, shows roles and persists")
    func firstProject() async {
        var saved: [String?] = []
        let c = controller(persist: { saved.append($0) })
        await load(c, [project("p-1", "Alpha", "viewer"), project("p-2", "Beta", "owner")])

        #expect(host.calls.count == 1 && host.calls[0].command == .projectsList)
        #expect(host.payload(0, as: HostApiProjectsListRequest.self) == .init())
        #expect(c.state.projects.map { [$0.id, $0.name, $0.role] } == [["p-1", "Alpha", "viewer"], ["p-2", "Beta", "owner"]])
        #expect(c.selectedId == "p-1" && c.selectedProject()?.name == "Alpha")
        #expect(saved.compactMap { $0 }.last == "p-1")
        #expect(c.state.loaded && !c.state.loading && c.state.error == nil)

        #expect(c.select("p-2"))
        #expect(c.selectedId == "p-2" && saved.compactMap { $0 }.last == "p-2")
        #expect(!c.select("p-gone"))
        #expect(c.selectedId == "p-2", "an id the host did not offer is never selected")
    }

    @Test("the stored choice wins while it exists; a gone one falls back to the first; empty keeps none")
    func storedChoice() async {
        let stored = controller(stored: "p-2")
        await load(stored, [project("p-1", "Alpha", "member"), project("p-2", "Beta", "owner")])
        #expect(stored.selectedId == "p-2")

        var saved: [String?] = []
        let gone = controller(stored: "p-gone", persist: { saved.append($0) })
        await load(gone, [project("p-11", "Gamma", "admin")])
        #expect(gone.selectedId == "p-11")
        #expect(saved.compactMap { $0 }.last == "p-11", "a stale stored id is replaced with the first project")

        let empty = controller(stored: "p-gone")
        await load(empty, [])
        #expect(empty.state.projects.isEmpty && empty.selectedId == nil)
        #expect(empty.state.loaded && empty.state.error == nil)
        #expect(HostApiProjectNotices.empty == "No projects are available to this account.")
    }

    @Test("roles decode from the contract fixture")
    func decodesFixture() throws {
        let data = try HostApiFixtures.data("fixtures/commands/projects.list.result.json")
        let result = try JSONDecoder().decode(HostApiProjectsListResult.self, from: data)
        #expect(result.projects.map(\.id) == ["p-demo"])
        #expect(result.projects.map(\.name) == ["Demo"])
        #expect(result.projects.map(\.role) == ["member"])
        #expect(result.projects.map(\.maxMode) == ["execute"])
        #expect(result.projects.map(\.usdCapMonth) == [20])
    }

    @Test("a failed list keeps the previous projects and choice and says why")
    func failedList() async {
        let c = controller()
        await load(c, [project("p-1", "Alpha", "member")])
        let n = host.calls.count
        let t = Task { await c.refresh() }
        await host.waitForCalls(n + 1)
        host.fail(n, "internal", String(repeating: "x", count: 900))
        await t.value
        #expect(c.selectedId == "p-1")
        #expect(c.state.projects.map(\.id) == ["p-1"])
        #expect(c.state.error?.count == 500 && !c.state.loading && c.state.loaded)
        #expect(HostApiProjectNotices.loadError(c.state.error ?? "").hasPrefix("Could not load projects. "))
    }

    @Test("a PROJECT_* refusal maps to the picker's reason and never takes the picker away")
    func refusals() async {
        #expect(HostApiProjectRefusal.from(rejection("denied", "Your project role no longer allows this."), selectedId: "p-1")?.code == .denied)
        #expect(HostApiProjectRefusal.from(rejection("not_found", "That project is not registered here."), selectedId: "p-1")?.code == .mismatch)
        #expect(HostApiProjectRefusal.from(rejection("denied", "Your team role no longer allows this."), selectedId: nil) == nil)
        #expect(HostApiProjectRefusal.from(rejection("invalid_payload", "PROJECT_REQUIRED: a project is required"), selectedId: nil)?.code == .required)
        #expect(HostApiProjectRefusal.from(rejection("PROJECT_DENIED", "Refused."), selectedId: nil)?.code == .denied)
        #expect(HostApiProjectRefusal.from(rejection("internal", "network down"), selectedId: "p-1") == nil)

        let c = controller()
        await load(c, [project("p-1", "Alpha", "member"), project("p-2", "Beta", "viewer")])
        c.select("p-2")
        let shown = c.noteRefusal(rejection("denied", "Your project role no longer allows this."))
        #expect(shown?.code == .denied)
        #expect(HostApiProjectNotices.refusal(shown!) == "The desktop refused this project. Your project role no longer allows this.")
        #expect(c.selectedId == "p-2" && c.state.projects.count == 2, "the picker keeps its list and choice")
        #expect(c.select("p-1"), "the picker is still usable after a refusal")
        #expect(c.state.refusal == nil, "choosing another project clears the old reason")
    }

    @Test("reset drops an in-flight reply")
    func reset() async {
        let c = controller()
        let t = Task { await c.refresh() }
        await host.waitForCalls(1)
        c.reset()
        host.answer(0, HostApiProjectsListResult(projects: [project("p-1", "Alpha", "member")]))
        await t.value
        #expect(c.state == HostApiProjectsState())
    }
}

@Suite("project-scoped frames")
struct HostApiProjectFrameTests {
    private func object<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    @Test("chat.send built by the phone's policy carries the selected projectId, and omits it when there is none")
    func sendPolicy() throws {
        guard case .send(let request) = HostApiChatSendPolicy.request(text: "hi", files: [], projectId: "p-2") else {
            Issue.record("the policy refused a valid message")
            return
        }
        #expect(request.projectId == "p-2")
        let json = try object(request)
        #expect(json["text"] as? String == "hi")
        #expect(json["projectId"] as? String == "p-2")

        guard case .send(let team) = HostApiChatSendPolicy.request(text: "hi", files: []) else {
            Issue.record("the policy refused a valid message")
            return
        }
        #expect(team.projectId == nil)
        let teamJSON = try object(team)
        #expect(teamJSON["projectId"] == nil)
    }

    @Test("every project-scoped v1 chat frame can carry projectId")
    func projectScopedFrames() throws {
        let scoped: [[String: Any]] = [
            try object(HostApiChatSnapshotRequest(limit: 50, projectId: "p-2")),
            try object(HostApiChatSessionsRequest(limit: 50, projectId: "p-2")),
            try object(HostApiChatHistoryRequest(limit: 100, projectId: "p-2", sessionId: "s")),
            try object(HostApiChatHistoryClearRequest(projectId: "p-2")),
            try object(HostApiChatCancelRequest(projectId: "p-2")),
            try object(HostApiApprovalsAnswerRequest(answers: [:], commandId: "c", projectId: "p-2", requestId: "r")),
            try object(HostApiToolApprovalsAnswerRequest(commandId: "c", decision: "deny", projectId: "p-2", requestId: "r")),
        ]
        for json in scoped { #expect(json["projectId"] as? String == "p-2") }

        // Without a project the frames stay exactly the v1 team shapes (the optional is omitted, not null).
        #expect(try object(HostApiChatSessionsRequest(limit: 50))["projectId"] == nil)
        #expect(try object(HostApiChatHistoryRequest(sessionId: "s"))["projectId"] == nil)
    }
}
