import Testing
import Foundation
import SharedProtocol

@Suite("HostApiFrame")
struct HostApiFrameTests {
    private func frame(_ json: String) -> Data { Data(json.utf8) }
    private var defs: [String: Any] { HostApiSchemas.envelope["$defs"] as? [String: Any] ?? [:] }
    private func object(_ d: Data) -> [String: Any] { try! JSONSerialization.jsonObject(with: d) as! [String: Any] }

    @Test("a valid request parses into command and payload")
    func parsesRequest() throws {
        let r = try HostApiFrame.parseRequest(HostApiFixtures.data("fixtures/valid/request.json")).get()
        #expect(r.command.rawValue == (object(try HostApiFixtures.data("fixtures/valid/request.json"))["command"] as! String))
    }

    @Test("oversize, non-JSON, bad envelope, unknown command and bad payload are each refused with their code")
    func refusals() {
        let big = Data(repeating: 0x20, count: HostApi.limits.maxFrameBytes + 1)
        #expect(HostApiFrame.parseRequest(big).failure?.code == "invalid_payload")
        #expect(HostApiFrame.parseRequest(frame("not json")).failure?.code == "invalid_payload")
        let unknownField = frame(#"{"apiVersion":1,"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1,"surprise":true}"#)
        #expect(HostApiFrame.parseRequest(unknownField).failure == HostApiRejection(replyTo: "c-1", code: "invalid_payload", message: "The frame does not match the Host API envelope (.surprise)."))
        let unknown = frame(#"{"apiVersion":1,"id":"c-2","type":"request","command":"files.write","payload":{},"ts":1}"#)
        #expect(HostApiFrame.parseRequest(unknown).failure?.code == "unknown_command")
        #expect(HostApiFrame.parseRequest(unknown).failure?.replyTo == "c-2")
        let badPayload = frame(#"{"apiVersion":1,"id":"c-3","type":"request","command":"chat.send","payload":{"text":""},"ts":1}"#)
        #expect(HostApiFrame.parseRequest(badPayload).failure == HostApiRejection(replyTo: "c-3", code: "invalid_payload", message: "The payload does not match chat.send (.text)."))
    }

    @Test("a response is a valid Response frame and a bad result is refused, not sent")
    func response() throws {
        let data = try HostApiFrame.response(replyTo: "c-1", command: .hostPing, result: HostApiHostPingResult(), rev: 3)
        #expect(HostApiSchemaValidator.validate(defs["Response"]!, object(data), defs: defs).isEmpty)
        #expect(object(data)["rev"] as? Int == 3)
        #expect(throws: HostApiRejection.self) {
            _ = try HostApiFrame.response(replyTo: "c-1", command: .hostAuthPair,
                                          result: HostApiHostAuthPairResult(capabilities: [], token: "short"), rev: 0)
        }
    }

    @Test("an event is a valid Event frame")
    func event() throws {
        let data = try HostApiFrame.event("chat.delta", payload: HostApiChatDeltaEvent(text: "hi"), rev: 9, replyTo: "c-7")
        #expect(HostApiSchemaValidator.validate(defs["Event"]!, object(data), defs: defs).isEmpty)
        #expect(throws: HostApiRejection.self) {
            _ = try HostApiFrame.event("chat.delta", payload: HostApiChatDeltaEvent(text: String(repeating: "x", count: 100_001)), rev: 1)
        }
    }

    @Test("an error frame is always valid: long messages are clamped, unknown codes become internal")
    func errorFrames() {
        let long = HostApiFrame.error(replyTo: "c-1", code: "denied", message: String(repeating: "é", count: 900), retryable: false, rev: 1)
        #expect(HostApiSchemaValidator.validate(defs["ErrorFrame"]!, object(long), defs: defs).isEmpty)
        let odd = HostApiFrame.error(replyTo: nil, code: "nope", message: "", retryable: true, retryAfterMs: 500, rev: 1)
        let err = object(odd)["error"] as! [String: Any]
        #expect(err["code"] as? String == "internal")
        #expect((err["details"] as? [String: Any])?["retryAfterMs"] as? Int == 500)
        #expect(HostApiSchemaValidator.validate(defs["ErrorFrame"]!, object(odd), defs: defs).isEmpty)
    }

    @Test("clamp cuts on character boundaries and keeps UTF-16 length within the cap")
    func clamp() {
        #expect(HostApiFrame.clamp("😀😀😀", maxUTF16: 5) == "😀😀")
        #expect(HostApiFrame.clamp("abc", maxUTF16: 10) == "abc")
    }
}

private extension Result {
    var failure: Failure? { if case .failure(let f) = self { return f }; return nil }
}
