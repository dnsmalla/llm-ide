import Testing
import SharedProtocol
@testable import LlmIdeMacLib

@Suite("HostApiV1Session")
struct HostApiV1SessionTests {
    let all: Set<String> = ["host", "chat", "approvals", "tool_approvals"]

    @Test("before hello only host.hello is allowed")
    func awaitingHello() {
        let s = HostApiV1Session()
        #expect(s.gate(.hostHello, served: all) == .allow)
        for c in HostApiCommand.allCases where c != .hostHello {
            #expect(s.gate(c, served: all) == .refuse(code: "auth_failed", message: "Send host.hello first."), "\(c)")
        }
    }

    @Test("after hello only pairing, token auth and ping are allowed")
    func awaitingAuth() {
        var s = HostApiV1Session()
        s.greeted(clientName: "web")
        for c in [HostApiCommand.hostAuthPair, .hostAuthToken, .hostPing] { #expect(s.gate(c, served: all) == .allow) }
        #expect(s.gate(.hostHello, served: all) == .refuse(code: "denied", message: "This connection already sent host.hello."))
        #expect(s.gate(.chatSend, served: all) == .refuse(code: "auth_failed", message: "Pair or authenticate first."))
        #expect(s.gate(.hostAuthRevoke, served: all) == .refuse(code: "auth_failed", message: "Pair or authenticate first."))
    }

    @Test("once authenticated, auth commands are refused and others need their capability")
    func authed() {
        var s = HostApiV1Session()
        s.greeted(clientName: "web")
        s.authenticated(deviceId: "h1-A")
        #expect(s.phase == .authed(deviceId: "h1-A", clientName: "web"))
        s.authenticated(deviceId: "h1-B")
        #expect(s.phase == .authed(deviceId: "h1-A", clientName: "web"))
        #expect(s.gate(.hostAuthPair, served: all) == .refuse(code: "denied", message: "This connection is already authenticated."))
        #expect(s.gate(.hostAuthToken, served: all) == .refuse(code: "denied", message: "This connection is already authenticated."))
        #expect(s.gate(.hostAuthRevoke, served: all) == .allow)
        #expect(s.gate(.chatSend, served: ["host"]) == .refuse(code: "capability_unavailable", message: "This Mac does not serve chat right now."))
        #expect(s.gate(.toolApprovalsAnswer, served: ["host", "chat", "approvals"])
                == .refuse(code: "capability_unavailable", message: "This Mac does not serve tool_approvals right now."))
        #expect(s.gate(.chatSend, served: all) == .allow)
    }

    @Test("hello must offer API version 1")
    func helloVersions() {
        #expect(HostApiV1Session.helloRefusal(apiVersions: [1, 2]) == nil)
        #expect(HostApiV1Session.helloRefusal(apiVersions: [2]) == "This Mac speaks Host API version 1 only.")
    }

    @Test("internal command ids round-trip and never look like a v2 UUID")
    func commandIds() {
        let id = HostApiV1CommandIds.internalId(session: 7, external: "c-1")
        #expect(id == "h1.7.c-1")
        #expect(HostApiV1CommandIds.parse(id)! == (7, "c-1"))
        #expect(HostApiV1CommandIds.parse("h1.7.c.1")! == (7, "c.1"))
        #expect(HostApiV1CommandIds.parse("9D2F6A1E-0000-0000-0000-000000000000") == nil)
        #expect(HostApiV1CommandIds.parse("h1.x.c-1") == nil)
        #expect(HostApiV1CommandIds.parse("h1.007.x") == nil)
        #expect(HostApiV1CommandIds.parse("h1.-1.x") == nil)
        #expect(HostApiV1CommandIds.parse("h1.+7.x") == nil)
        #expect(HostApiV1CommandIds.parse("h1.") == nil)
        #expect(HostApiV1CommandIds.parse("h1.7.") == nil)
        #expect(!HostApiV1CommandIds.isV1("llmide_chat_history"))
    }
}
