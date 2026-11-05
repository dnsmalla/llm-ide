import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("SyncDevice: enrollment, snapshot, queue and reply (device contract 4-6)")
struct SyncDeviceTests {
    static func enrolled() async throws -> (SyncDevice, SyncTestDesktop, SyncDictionaryStore, SyncClaimFields) {
        let store = SyncDictionaryStore()
        let desk = SyncTestDesktop()
        let qr = desk.openSlot(store)
        let device = try await SyncDevice.begin(pair: try SyncEnroll.parsePair(qr), name: "Test iPhone", keys: SoftwareSyncDeviceKeys(),
                                                store: store, nowMs: 1_762_300_000_100)
        #expect(try await device.readAck(store) == nil, "no ack yet")
        let c = try desk.pinClaim(store)
        let desktopSas = try desk.writeAck(store, for: c)
        #expect(try await device.readAck(store) == desktopSas, "both screens show the same code")
        #expect(try await device.readWrap(store, nowMs: 1) == false, "no wrap until the user confirms")
        try desk.confirm(store, c)
        #expect(try await device.readWrap(store, nowMs: 1))
        return (device, desk, store, c)
    }

    @Test("happy path: enrolled device erases es, reads all four kinds, and the freshness is current")
    func happy() async throws {
        let (device, _, store, _) = try await Self.enrolled()
        #expect(device.state.pair.es == "" && device.state.epoch == 1 && device.state.isEnrolled)
        let s = try await device.readSnapshot(store, nowMs: 1_762_300_060_000)
        #expect(s.chats.map(\.id) == ["c1", "c2"])
        #expect(s.sessions.first { $0.id == "c2" }?.phoneChat == true)
        #expect(s.chats[0].messages.map(\.content) == ["hi", "hello"])
        #expect(s.meetings.first?.notes.count == 2 && s.truncated == ["meetings"])
        #expect(s.plans.first?.tasks.first?.status == "doing")
        #expect(s.usageState?.models.first?.name == "claude-sonnet")
        #expect(SyncFreshness(s.manifest, nowMs: 1_762_300_060_000) == .current(lastUpdatedMs: 1_762_300_000_000))
        #expect(SyncFreshness(s.manifest, nowMs: 1_762_300_000_000 + 2_700_001) == .withheld(lastUpdatedMs: 1_762_300_000_000))
    }

    @Test("queue: a chat.send request the desktop can open; the reply comes back to this device")
    func queue() async throws {
        let (device, desk, store, c) = try await Self.enrolled()
        let id = try await device.sendRequest(store, text: "What changed today?", nowMs: 1_762_300_000_123)
        let reqs = try desk.readRequests(store, c)
        #expect(reqs.count == 1)
        #expect(reqs[0].name == "1762300000123-\(id).bin")
        #expect(Set(reqs[0].plain.keys) == ["v", "requestId", "class", "text"])
        #expect(reqs[0].plain["class"] as? String == "chat.send" && reqs[0].plain["text"] as? String == "What changed today?")
        let raw = store.files.first { $0.key.contains("/in/") }!.value
        #expect(raw.range(of: Data("What changed".utf8)) == nil, "the store never sees the prompt")
        #expect(try await device.readReply(store, requestId: id, nowMs: 1) == nil)
        try desk.writeReply(store, c, requestId: id, ["ok": true, "text": "Two PRs merged.", "finishedAt": 5])
        #expect(try await device.readReply(store, requestId: id, nowMs: 1) == .answered(text: "Two PRs merged.", finishedAt: 5))
    }

    @Test("prompt limits: empty and over 4,000 UTF-16 units are refused before anything is written")
    func limits() async throws {
        let (device, _, store, _) = try await Self.enrolled()
        await #expect(throws: SyncCryptoError("empty")) { _ = try await device.sendRequest(store, text: "", nowMs: 1) }
        await #expect(throws: SyncCryptoError("too_long")) { _ = try await device.sendRequest(store, text: String(repeating: "a", count: 4001), nowMs: 1) }
        await #expect(throws: SyncCryptoError("too_long")) { _ = try await device.sendRequest(store, text: String(repeating: "\u{1}", count: 4000), nowMs: 1) }
        #expect(!store.files.keys.contains { $0.contains("/in/") })
    }

    @Test("rotation: a higher-epoch manifest pulls the new wrap; an old-epoch stale_epoch reply opens under the kept key")
    func rotation() async throws {
        let (device, desk, store, c) = try await Self.enrolled()
        let id = try await device.sendRequest(store, text: "hi", nowMs: 1)
        desk.epoch = 2
        store.files["\(desk.base)/wrap.bin"] = try desk.makeWrap(deviceId: c.deviceId, deviceEcdhSpki: c.ecdhSpki, tier: "ios").data()
        try desk.publish(store, c)
        _ = try await device.readSnapshot(store, nowMs: 10)
        #expect(device.state.epoch == 2 && device.state.prevReply?.epoch == 1)
        try desk.writeReply(store, c, requestId: id, ["ok": false, "code": "stale_epoch"], epoch: 1)
        #expect(try await device.readReply(store, requestId: id, nowMs: 11) == .failed(code: "stale_epoch"))
        await #expect(throws: SyncCryptoError("bad_epoch"), "the old key lives 24 h only") {
            _ = try await device.readReply(store, requestId: id, nowMs: 11 + SyncDevice.prevReplyMs)
        }
    }

    @Test("a blob deleted between manifest and fetch: one manifest refetch, then 'updating'")
    func blobGone() async throws {
        let (device, _, store, _) = try await Self.enrolled()
        for k in store.files.keys where k.contains("/s/") { store.files[k] = nil }
        await #expect(throws: SyncCryptoError("updating")) { _ = try await device.readSnapshot(store, nowMs: 1) }
    }

    @Test("restore from saved state reads the same snapshot; the recording store captures exactly what was fetched")
    func restore() async throws {
        let (device, _, store, _) = try await Self.enrolled()
        let state = try JSONDecoder().decode(SyncDeviceState.self, from: JSONEncoder().encode(device.state))
        let again = try SyncDevice(state: state, keys: device.keys)
        let rec = SyncRecordingStore(remote: store)
        let s = try await again.readSnapshot(rec, nowMs: 1)
        #expect(rec.fetched.count == 5, "manifest + four blobs")
        let cached = try await SyncDevice(state: again.state, keys: device.keys).readSnapshot(SyncDictionaryStore(files: rec.fetched), nowMs: 1)
        #expect(cached == s)
    }
}
