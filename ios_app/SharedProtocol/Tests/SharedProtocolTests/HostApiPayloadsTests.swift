import Testing
import Foundation
import SharedProtocol

/// Every contract fixture decodes into its generated struct and re-encodes to the same JSON.
/// A schema change regenerates the structs, so a fixture that stops decoding is caught here.
@Suite("HostApiPayloads")
struct HostApiPayloadsTests {
    private func roundTrip<T: Codable & Equatable>(_ type: T.Type, _ relative: String) throws {
        let data = try HostApiFixtures.data(relative)
        let decoded = try JSONDecoder().decode(T.self, from: data)
        let reencoded = try JSONEncoder().encode(decoded)
        let a = try JSONSerialization.jsonObject(with: data) as! NSDictionary
        let b = try JSONSerialization.jsonObject(with: reencoded) as! NSDictionary
        #expect(a == b, "\(relative)")
    }

    @Test("every command fixture round-trips")
    func commands() throws {
        try roundTrip(HostApiHostHelloRequest.self, "fixtures/commands/host.hello.request.json")
        try roundTrip(HostApiHostHelloResult.self, "fixtures/commands/host.hello.result.json")
        try roundTrip(HostApiHostAuthPairRequest.self, "fixtures/commands/host.auth.pair.request.json")
        try roundTrip(HostApiHostAuthPairResult.self, "fixtures/commands/host.auth.pair.result.json")
        try roundTrip(HostApiHostAuthTokenRequest.self, "fixtures/commands/host.auth.token.request.json")
        try roundTrip(HostApiHostAuthTokenResult.self, "fixtures/commands/host.auth.token.result.json")
        try roundTrip(HostApiHostAuthRevokeRequest.self, "fixtures/commands/host.auth.revoke.request.json")
        try roundTrip(HostApiHostAuthRevokeResult.self, "fixtures/commands/host.auth.revoke.result.json")
        try roundTrip(HostApiHostPingRequest.self, "fixtures/commands/host.ping.request.json")
        try roundTrip(HostApiHostPingResult.self, "fixtures/commands/host.ping.result.json")
        try roundTrip(HostApiHostSnapshotRequest.self, "fixtures/commands/host.snapshot.request.json")
        try roundTrip(HostApiHostSnapshotResult.self, "fixtures/commands/host.snapshot.result.json")
        try roundTrip(HostApiChatSnapshotRequest.self, "fixtures/commands/chat.snapshot.request.json")
        try roundTrip(HostApiChatSnapshotResult.self, "fixtures/commands/chat.snapshot.result.json")
        try roundTrip(HostApiChatSendRequest.self, "fixtures/commands/chat.send.request.json")
        try roundTrip(HostApiChatSendResult.self, "fixtures/commands/chat.send.result.json")
        try roundTrip(HostApiChatCancelRequest.self, "fixtures/commands/chat.cancel.request.json")
        try roundTrip(HostApiChatCancelResult.self, "fixtures/commands/chat.cancel.result.json")
        try roundTrip(HostApiChatHistoryClearRequest.self, "fixtures/commands/chat.history.clear.request.json")
        try roundTrip(HostApiChatHistoryClearResult.self, "fixtures/commands/chat.history.clear.result.json")
        try roundTrip(HostApiApprovalsAnswerRequest.self, "fixtures/commands/approvals.answer.request.json")
        try roundTrip(HostApiApprovalsAnswerResult.self, "fixtures/commands/approvals.answer.result.json")
        try roundTrip(HostApiToolApprovalsAnswerRequest.self, "fixtures/commands/toolApprovals.answer.request.json")
        try roundTrip(HostApiToolApprovalsAnswerResult.self, "fixtures/commands/toolApprovals.answer.result.json")
        try roundTrip(HostApiProjectsListRequest.self, "fixtures/commands/projects.list.request.json")
        try roundTrip(HostApiProjectsListResult.self, "fixtures/commands/projects.list.result.json")
    }

    @Test("every event fixture payload round-trips")
    func events() throws {
        func payload<T: Codable & Equatable>(_ type: T.Type, _ name: String) throws {
            let frame = try HostApiFixtures.json("fixtures/events/\(name).json") as! [String: Any]
            let data = try JSONSerialization.data(withJSONObject: frame["payload"]!)
            let decoded = try JSONDecoder().decode(T.self, from: data)
            let back = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as! NSDictionary
            #expect(back == (frame["payload"] as! NSDictionary), "\(name)")
        }
        try payload(HostApiChatDeltaEvent.self, "chat.delta")
        try payload(HostApiChatDoneEvent.self, "chat.done")
        try payload(HostApiChatErrorEvent.self, "chat.error")
        try payload(HostApiApprovalRequestEvent.self, "approval.request")
        try payload(HostApiApprovalClearedEvent.self, "approval.cleared")
        try payload(HostApiToolApprovalRequestEvent.self, "toolApproval.request")
        try payload(HostApiHostCapabilitiesEvent.self, "host.capabilities")
    }

    @Test("optional fields are omitted, not encoded as null")
    func optionalsOmitted() throws {
        let data = try JSONEncoder().encode(HostApiChatSendResult(accepted: true))
        #expect(String(decoding: data, as: UTF8.self) == #"{"accepted":true}"#)
    }
}
