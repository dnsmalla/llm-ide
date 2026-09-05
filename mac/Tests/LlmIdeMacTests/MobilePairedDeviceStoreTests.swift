import Testing
import Foundation
@testable import LlmIdeMacLib

/// The paired-device registry behind Mobile Control's token pairing. What has
/// to hold: a token authenticates exactly the device it was issued to, re-pairing
/// or revoking retires the old token immediately, the file on disk never
/// contains a token in plain text, and a fresh process reads the same registry.
@Suite("MobilePairedDeviceStore", .serialized)
struct MobilePairedDeviceStoreTests {
    private func tempFile() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("paired-devices-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("devices.json")
    }

    @Test("an issued token authenticates its device and nothing else")
    func issueAndAuthenticate() {
        let store = MobilePairedDeviceStore(fileURL: tempFile())
        let token = store.issueToken(deviceId: "phone-A", name: "Dinesh's iPhone")
        #expect(token.count >= 40)
        #expect(store.authenticate(deviceId: "phone-A", token: token))
        #expect(!store.authenticate(deviceId: "phone-A", token: token + "x"))
        #expect(!store.authenticate(deviceId: "phone-B", token: token), "another device id must not borrow the token")
        #expect(!store.authenticate(deviceId: "phone-A", token: ""))
        #expect(!store.authenticate(deviceId: "", token: token))
    }

    @Test("re-pairing the same device retires the previous token")
    func rePairReplaces() {
        let store = MobilePairedDeviceStore(fileURL: tempFile())
        let first = store.issueToken(deviceId: "phone-A", name: "iPhone")
        let second = store.issueToken(deviceId: "phone-A", name: "iPhone (new)")
        #expect(first != second)
        #expect(!store.authenticate(deviceId: "phone-A", token: first))
        #expect(store.authenticate(deviceId: "phone-A", token: second))
        #expect(store.all.count == 1)
        #expect(store.all.first?.name == "iPhone (new)")
    }

    @Test("revoke refuses the token from then on and drops the record")
    func revoke() {
        let store = MobilePairedDeviceStore(fileURL: tempFile())
        let token = store.issueToken(deviceId: "phone-A", name: "iPhone")
        store.revoke(id: "phone-A")
        #expect(!store.authenticate(deviceId: "phone-A", token: token))
        #expect(store.all.isEmpty)
        store.revoke(id: "never-existed")   // harmless
    }

    @Test("the registry survives a restart, and the file holds hashes, not tokens")
    func persistence() throws {
        let url = tempFile()
        let token = MobilePairedDeviceStore(fileURL: url).issueToken(deviceId: "phone-A", name: "iPhone")
        let onDisk = try String(contentsOf: url, encoding: .utf8)
        #expect(!onDisk.contains(token), "a token must never be written to disk")
        #expect(onDisk.contains(MobilePairedDeviceStore.hash(token)))
        let reloaded = MobilePairedDeviceStore(fileURL: url)
        #expect(reloaded.authenticate(deviceId: "phone-A", token: token))
        #expect(reloaded.all.first?.name == "iPhone")
    }

    @Test("authenticate stamps lastSeenAt and `all` lists most recently seen first")
    func lastSeenOrdering() {
        let store = MobilePairedDeviceStore(fileURL: tempFile())
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        let a = store.issueToken(deviceId: "A", name: "A", now: t0)
        _ = store.issueToken(deviceId: "B", name: "B", now: t0.addingTimeInterval(10))
        #expect(store.all.map(\.id) == ["B", "A"])
        #expect(store.authenticate(deviceId: "A", token: a, now: t0.addingTimeInterval(20)))
        #expect(store.all.map(\.id) == ["A", "B"])
        #expect(store.device(id: "A")?.lastSeenAt == t0.addingTimeInterval(20))
    }

    @Test("the registry is bounded — the least recently seen device is dropped past the cap")
    func boundedRegistry() {
        let store = MobilePairedDeviceStore(fileURL: tempFile())
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        var tokens: [String: String] = [:]
        for i in 0..<(MobilePairedDeviceStore.maxDevices + 1) {
            tokens["d\(i)"] = store.issueToken(deviceId: "d\(i)", name: "d\(i)", now: t0.addingTimeInterval(Double(i)))
        }
        #expect(store.all.count == MobilePairedDeviceStore.maxDevices)
        #expect(store.device(id: "d0") == nil, "the oldest record is the one evicted")
        #expect(!store.authenticate(deviceId: "d0", token: tokens["d0"]!))
        #expect(store.authenticate(deviceId: "d1", token: tokens["d1"]!))
    }

    @Test("a blank device name falls back rather than storing an empty label")
    func nameFallback() {
        let store = MobilePairedDeviceStore(fileURL: tempFile())
        _ = store.issueToken(deviceId: "A", name: "   ")
        #expect(store.device(id: "A")?.name == "iPhone")
    }
}
