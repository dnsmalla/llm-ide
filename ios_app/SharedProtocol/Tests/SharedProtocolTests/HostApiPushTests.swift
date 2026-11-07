import Testing
import Foundation
import SharedProtocol

@Suite("HostApiPush")
struct HostApiPushTests {
    @Test("on only when the host granted push; never optimistic")
    func gate() {
        #expect(HostApiPush.isOn(capabilities: ["host", "chat", "push"]))
        #expect(!HostApiPush.isOn(capabilities: ["host", "chat"]))
        #expect(!HostApiPush.isOn(capabilities: nil))
    }

    @Test("the token is lowercase hex, the environment follows the build, and the payload passes the contract")
    func payload() throws {
        let token = Data((0..<32).map { UInt8(($0 * 37 + 171) & 0xff) })
        let r = HostApiPush.registerRequest(token: token, isDebug: true)
        #expect(r.kind == "apns")
        #expect(r.environment == "sandbox")
        #expect(r.token?.count == 64)
        #expect(r.token == r.token?.lowercased())
        #expect(r.endpoint == nil && r.p256dh == nil && r.auth == nil)
        #expect(HostApiPush.registerRequest(token: token, isDebug: false).environment == "production")
        #expect(HostApiPush.tokenHex(Data([0x00, 0x0f, 0xff])) == "000fff")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(r))
        #expect(HostApiSchemaValidator.validate(HostApiSchemas.request(for: .pushRegister), json, defs: [:]).isEmpty)
    }
}
