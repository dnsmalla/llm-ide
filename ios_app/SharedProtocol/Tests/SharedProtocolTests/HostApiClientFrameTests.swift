import Testing
import Foundation
@testable import SharedProtocol

@Suite("HostApiFrame client side")
struct HostApiClientFrameTests {
    private func obj(_ d: Data) -> [String: Any] { try! JSONSerialization.jsonObject(with: d) as! [String: Any] }

    @Test("every command's request fixture builds a frame the host codec accepts")
    func requestsRoundTripThroughHostCodec() throws {
        for command in HostApiCommand.allCases {
            let payload = try JSONDecoder().decode(HostApiJSONValue.self,
                from: HostApiFixtures.data("fixtures/commands/\(command.rawValue).request.json"))
            let id = HostApiFrame.newClientId()
            let frame = try HostApiFrame.request(id: id, command: command, payload: payload)
            let parsed = try HostApiFrame.parseRequest(frame).get()
            #expect(parsed.command == command)
            #expect(parsed.id == id)
        }
    }

    @Test("a payload that breaks its schema is refused before anything is sent")
    func invalidPayload() {
        #expect(throws: HostApiRejection.self) {
            _ = try HostApiFrame.request(id: "c-1", command: .chatSend, payload: HostApiChatSendRequest(text: ""))
        }
        #expect(throws: HostApiRejection.self) {
            _ = try HostApiFrame.request(id: "bad id!", command: .hostPing, payload: HostApiHostPingRequest())
        }
    }

    @Test("client ids fit the envelope id pattern")
    func clientIds() {
        let id = HostApiFrame.newClientId()
        #expect(HostApiSchemaValidator.matches(id, "^[A-Za-z0-9_-]{1,64}$"))
    }

    @Test("valid response, event and error fixtures parse with their rev")
    func parsesValidFixtures() throws {
        guard case .response(let replyTo, let command, _, let rev) = try HostApiFrame.parseInbound(HostApiFixtures.data("fixtures/valid/response.json")).get()
        else { Issue.record("expected a response"); return }
        #expect(replyTo == "c-1"); #expect(command == .hostPing); #expect(rev == 1)

        guard case .event(let event, let payload, _, let erev) = try HostApiFrame.parseInbound(HostApiFixtures.data("fixtures/valid/event.json")).get()
        else { Issue.record("expected an event"); return }
        #expect(event == .chatDelta); #expect(erev == 2)
        #expect(try JSONDecoder().decode(HostApiChatDeltaEvent.self, from: payload).text == "hi")

        guard case .error(let ereplyTo, let rejection, let xrev) = try HostApiFrame.parseInbound(HostApiFixtures.data("fixtures/valid/error.json")).get()
        else { Issue.record("expected an error"); return }
        #expect(ereplyTo == "c-1"); #expect(rejection.code == "denied"); #expect(rejection.retryable == false); #expect(xrev == nil)
    }

    @Test("every event fixture parses as its generated event name, and the enum lists exactly the fixtures")
    func eventFixtures() throws {
        let names = try HostApiFixtures.names("fixtures/events").map { String($0.dropLast(5)) }
        #expect(Set(names) == Set(HostApiEvent.allCases.map(\.rawValue)))
        for name in names {
            guard case .event(let event, _, _, _) = try HostApiFrame.parseInbound(HostApiFixtures.data("fixtures/events/\(name).json")).get()
            else { Issue.record("\(name) did not parse as an event"); continue }
            #expect(event.rawValue == name)
        }
    }

    @Test("host-built frames parse back, retryable and retryAfterMs included")
    func hostBuiltFrames() throws {
        let r = try HostApiFrame.response(replyTo: "c-9", command: .chatCancel, result: HostApiChatCancelResult(cancelled: true), rev: 7)
        guard case .response(_, .chatCancel, let result, 7) = try HostApiFrame.parseInbound(r).get() else { Issue.record("response"); return }
        #expect(try JSONDecoder().decode(HostApiChatCancelResult.self, from: result).cancelled)
        let e = HostApiFrame.error(replyTo: "c-9", code: "rate_limited", message: "slow down", retryable: true, retryAfterMs: 500, rev: 7)
        guard case .error(_, let rejection, _) = try HostApiFrame.parseInbound(e).get() else { Issue.record("error"); return }
        #expect(rejection == HostApiRejection(replyTo: "c-9", code: "rate_limited", message: "slow down", retryable: true, retryAfterMs: 500))
    }

    @Test("v2 frames, unknown events, bad results and oversize frames are refused, never crash")
    func refusals() {
        #expect(HostApiFrame.parseInbound(Data(#"{"type":"connected","deviceName":"Mac"}"#.utf8)).failure != nil)
        #expect(HostApiFrame.parseInbound(Data(#"{"apiVersion":1,"id":"e-1","type":"event","command":"chat.progress","payload":{},"ts":1,"rev":1}"#.utf8)).failure != nil)
        #expect(HostApiFrame.parseInbound(Data(#"{"apiVersion":1,"id":"s-1","replyTo":"c-1","type":"response","command":"host.ping","result":{"x":1},"ts":1,"rev":1}"#.utf8)).failure != nil)
        #expect(HostApiFrame.parseInbound(Data("not json".utf8)).failure != nil)
        #expect(HostApiFrame.parseInbound(Data(repeating: 0x20, count: HostApi.limits.maxFrameBytes + 1)).failure != nil)
    }
}

private extension Result {
    var failure: Failure? { if case .failure(let f) = self { return f }; return nil }
}
