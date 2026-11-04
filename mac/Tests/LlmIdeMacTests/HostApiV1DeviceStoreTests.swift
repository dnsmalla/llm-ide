import Testing
import Foundation
@testable import LlmIdeMacLib

@Suite("Host API v1 token-only auth", .serialized)
struct HostApiV1DeviceStoreTests {
    private func store() -> MobilePairedDeviceStore {
        MobilePairedDeviceStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("h1-devices-\(UUID().uuidString)/devices.json"))
    }

    @Test("a token finds exactly its own device")
    func findsDevice() {
        let s = store()
        let a = s.issueToken(deviceId: "h1-A", name: "web")
        let b = s.issueToken(deviceId: "h1-B", name: "ios")
        #expect(s.authenticate(token: a) == "h1-A")
        #expect(s.authenticate(token: b) == "h1-B")
        #expect(s.authenticate(token: a + "x") == nil)
        #expect(s.authenticate(token: "") == nil)
    }

    @Test("revoking or re-pairing retires the old token")
    func revocation() {
        let s = store()
        let old = s.issueToken(deviceId: "h1-A", name: "web")
        _ = s.issueToken(deviceId: "h1-A", name: "web")
        #expect(s.authenticate(token: old) == nil)
        let live = s.issueToken(deviceId: "h1-C", name: "web")
        s.revoke(id: "h1-C")
        #expect(s.authenticate(token: live) == nil)
    }

    @Test("an idle token expires like the device-id path")
    func expiry() {
        let s = store()
        let t = s.issueToken(deviceId: "h1-A", name: "web", now: Date(timeIntervalSince1970: 0))
        #expect(s.authenticate(token: t, now: Date(timeIntervalSince1970: MobilePairedDeviceStore.maxIdleInterval + 1)) == nil)
        #expect(s.device(id: "h1-A") == nil, "an expired device is forgotten")
    }
}
