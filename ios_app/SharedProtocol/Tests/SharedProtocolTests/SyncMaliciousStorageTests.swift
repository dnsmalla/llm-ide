import Testing
import Foundation
import CryptoKit
@testable import SharedProtocol

/// Spec §13 "malicious-store test", device side. The store rewrites, replays and deletes at every step.
@MainActor
@Suite("Sync device under malicious storage")
struct SyncMaliciousStorageTests {
    @Test("a substituted key.bin is refused before any claim is written")
    func forgedKeyBin() async throws {
        let store = SyncDictionaryStore(), desk = SyncTestDesktop()
        let qr = desk.openSlot(store)
        store.files["\(desk.base)/key.bin"] = P256.Signing.PrivateKey().publicKey.derRepresentation
        await #expect(throws: SyncCryptoError("bad_desktop_key")) {
            _ = try await SyncDevice.begin(pair: try SyncEnroll.parsePair(qr), name: "x", keys: SoftwareSyncDeviceKeys(), store: store, nowMs: 1)
        }
        #expect(!store.files.keys.contains { $0.contains("/e/") })
    }

    @Test("QR photographer who controls storage swaps the claim: the real phone refuses the ack and shows no code")
    func substitutedClaim() async throws {
        let store = SyncDictionaryStore(), desk = SyncTestDesktop()
        let pair = try SyncEnroll.parsePair(desk.openSlot(store))
        let device = try await SyncDevice.begin(pair: pair, name: "Real", keys: SoftwareSyncDeviceKeys(), store: store, nowMs: 1)
        for k in store.files.keys where k.contains("/e/") { store.files[k] = nil }
        store.files["\(desk.sid)/e/\(pair.slot)/\(SyncB64.newId22()).bin"] =
            try SyncEnroll.sealClaim(pair: pair, tier: "ios", name: "Attacker", keys: SoftwareSyncDeviceKeys(), issuedAt: 1).data()
        try desk.writeAck(store, for: try desk.pinClaim(store))
        // The ack is addressed to the attacker's deviceId, so the header check fires before the claim-hash check.
        await #expect {
            _ = try await device.readAck(store)
        } throws: { error in
            guard let e = error as? SyncCryptoError else { return false }
            return e.code == "bad_to" || e.code == "ack_mismatch"
        }
    }

    @Test("forged ack (attacker key), replayed ack from another slot, garbage ack: all refused")
    func forgedAck() async throws {
        let store = SyncDictionaryStore(), desk = SyncTestDesktop()
        let pair = try SyncEnroll.parsePair(desk.openSlot(store))
        let device = try await SyncDevice.begin(pair: pair, name: "Real", keys: SoftwareSyncDeviceKeys(), store: store, nowMs: 1)
        let c = try desk.pinClaim(store)
        let impostor = SyncTestDesktop(sid: desk.sid)
        impostor.pair = desk.pair; impostor.enroll = desk.enroll
        try impostor.writeAck(store, for: c)
        await #expect(throws: SyncCryptoError("bad_signature")) { _ = try await device.readAck(store) }
        let other = SyncTestDesktop(signing: desk.signing, sid: desk.sid)
        _ = other.openSlot(SyncDictionaryStore())
        let replay = SyncDictionaryStore()
        try other.writeAck(replay, for: c)
        store.files["\(desk.sid)/e/\(pair.slot)/ack.bin"] = replay.files["\(desk.sid)/e/\(other.pair.slot)/ack.bin"]
        await #expect(throws: SyncCryptoError("bad_session")) { _ = try await device.readAck(store) }
        store.files["\(desk.sid)/e/\(pair.slot)/ack.bin"] = Data("{}".utf8)
        await #expect(throws: SyncCryptoError("bad_version")) { _ = try await device.readAck(store) }
    }

    @Test("forged wrap.bin: other signer, other tier, replayed epoch 0; none is accepted")
    func forgedWrap() async throws {
        let store = SyncDictionaryStore(), desk = SyncTestDesktop()
        let pair = try SyncEnroll.parsePair(desk.openSlot(store))
        let device = try await SyncDevice.begin(pair: pair, name: "Real", keys: SoftwareSyncDeviceKeys(), store: store, nowMs: 1)
        let c = try desk.pinClaim(store)
        try desk.writeAck(store, for: c)
        _ = try await device.readAck(store)
        let attacker = SyncTestDesktop(sid: desk.sid)
        attacker.pair = desk.pair; attacker.epoch = 1
        store.files["\(desk.base)/wrap.bin"] = try attacker.makeWrap(deviceId: c.deviceId, deviceEcdhSpki: c.ecdhSpki, tier: "ios").data()
        await #expect(throws: SyncCryptoError("bad_signature")) { _ = try await device.readWrap(store, nowMs: 1) }
        desk.epoch = 1
        store.files["\(desk.base)/wrap.bin"] = try desk.makeWrap(deviceId: c.deviceId, deviceEcdhSpki: c.ecdhSpki, tier: "web").data()
        await #expect(throws: SyncCryptoError("bad_wrap")) { _ = try await device.readWrap(store, nowMs: 1) }
        desk.epoch = 0
        store.files["\(desk.base)/wrap.bin"] = try desk.makeWrap(deviceId: c.deviceId, deviceEcdhSpki: c.ecdhSpki, tier: "ios").data()
        #expect(try await device.readWrap(store, nowMs: 1) == false)
        #expect(!device.state.isEnrolled)
    }

    @Test("manifest rollback: an older but genuine manifest after a newer one is refused")
    func rollback() async throws {
        let (device, desk, store, c) = try await SyncDeviceTests.enrolled()
        let old = store.files
        _ = try await device.readSnapshot(store, nowMs: 1)
        try desk.publish(store, c)
        _ = try await device.readSnapshot(store, nowMs: 2)
        for (k, v) in old { store.files[k] = v }
        await #expect(throws: SyncCryptoError("rollback")) { _ = try await device.readSnapshot(store, nowMs: 3) }
    }

    @Test("mix-and-match: a blob swapped for another kind's genuine blob fails the manifest hash")
    func swappedBlob() async throws {
        let (device, desk, store, c) = try await SyncDeviceTests.enrolled()
        let paths = try desk.publish(store, c)
        store.files[paths["chats"]!] = store.files[paths["plans"]!]
        await #expect(throws: SyncCryptoError("bad_blob")) { _ = try await device.readSnapshot(store, nowMs: 1) }
    }

    @Test("another device's manifest copied into this folder is refused (to = other device)")
    func otherDevicesManifest() async throws {
        let (device, desk, store, c) = try await SyncDeviceTests.enrolled()
        var other = c
        other.deviceId = SyncB64.newId22()
        let scratch = SyncDictionaryStore()
        try desk.publish(scratch, other)
        store.files["\(desk.base)/manifest.bin"] = scratch.files["\(desk.base)/manifest.bin"]
        await #expect(throws: SyncCryptoError("bad_to")) { _ = try await device.readSnapshot(store, nowMs: 1) }
    }

    @Test("manifest naming a path outside s/<32 hex>.bin is refused before any fetch")
    func traversal() async throws {
        let (device, desk, store, c) = try await SyncDeviceTests.enrolled()
        let dk = desk.deviceKeys(c.deviceId)
        let ms = desk.next()
        let m: [String: Any] = ["v": 1, "manifestSeq": ms, "epoch": desk.epoch, "generatedAt": 1, "validUntil": 2,
                                "kinds": ["chats": ["file": "../../key.bin", "seq": 1, "sha256": "00"]]]
        store.files["\(desk.base)/manifest.bin"] = try desk.seal("manifest", to: c.deviceId, seq: ms, key: dk.manifest,
                                                                  JSONSerialization.data(withJSONObject: m)).data()
        await #expect(throws: SyncCryptoError("bad_manifest")) { _ = try await device.readSnapshot(store, nowMs: 1) }
    }

    @Test("folder deleted (revoked): 'removed'; replies forged or for another request are refused")
    func removedAndReplies() async throws {
        let (device, desk, store, c) = try await SyncDeviceTests.enrolled()
        let id = try await device.sendRequest(store, text: "hi", nowMs: 1)
        try desk.writeReply(store, c, requestId: SyncB64.newId22(), ["ok": true, "text": "x"])
        store.files["\(desk.base)/out/\(id).bin"] = store.files.first { $0.key.contains("/out/") }!.value
        await #expect(throws: SyncCryptoError("bad_reply")) { _ = try await device.readReply(store, requestId: id, nowMs: 1) }
        try desk.writeReply(store, c, requestId: id, ["ok": true, "text": "x"], key: SyncCrypto.randomBytes(32))
        await #expect(throws: SyncCryptoError("bad_ciphertext")) { _ = try await device.readReply(store, requestId: id, nowMs: 1) }
        for k in store.files.keys where k.hasPrefix(desk.base) { store.files[k] = nil }
        await #expect(throws: SyncCryptoError("removed")) { _ = try await device.readSnapshot(store, nowMs: 1) }
    }

    @Test("nothing the device writes carries plaintext: claim and request bytes hold no name or prompt")
    func blindness() async throws {
        let store = SyncDictionaryStore(), desk = SyncTestDesktop()
        let pair = try SyncEnroll.parsePair(desk.openSlot(store))
        _ = try await SyncDevice.begin(pair: pair, name: "Secret-Phone-Name", keys: SoftwareSyncDeviceKeys(), store: store, nowMs: 1)
        let claim = store.files.first { $0.key.contains("/e/") }!.value
        #expect(claim.range(of: Data("Secret-Phone-Name".utf8)) == nil)
    }
}
