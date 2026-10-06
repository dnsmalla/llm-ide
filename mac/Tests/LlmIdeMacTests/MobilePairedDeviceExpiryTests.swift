import Testing
import Foundation
@testable import LlmIdeMacLib

@Suite("Paired device token idle expiry")
struct MobilePairedDeviceExpiryTests {
    private func store() -> MobilePairedDeviceStore {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("paired-\(UUID().uuidString).json")
        return MobilePairedDeviceStore(fileURL: url)
    }

    @Test func aRecentlyUsedTokenKeepsWorkingAndRefreshes() {
        let store = store()
        let t0 = Date()
        let token = store.issueToken(deviceId: "d1", name: "Phone", now: t0)
        // 20 days later: still valid, and the use refreshes lastSeenAt.
        let day20 = t0.addingTimeInterval(20 * 86_400)
        #expect(store.authenticate(deviceId: "d1", token: token, now: day20))
        // 20 more days after THAT use (40 from pairing) is still inside the window.
        #expect(store.authenticate(deviceId: "d1", token: token, now: day20.addingTimeInterval(20 * 86_400)))
    }

    @Test func anIdleTokenExpiresAndForgetsTheDevice() {
        let store = store()
        let t0 = Date()
        let token = store.issueToken(deviceId: "d1", name: "Phone", now: t0)
        let late = t0.addingTimeInterval(MobilePairedDeviceStore.maxIdleInterval + 60)
        #expect(!store.authenticate(deviceId: "d1", token: token, now: late))
        #expect(store.device(id: "d1") == nil)
    }
}
