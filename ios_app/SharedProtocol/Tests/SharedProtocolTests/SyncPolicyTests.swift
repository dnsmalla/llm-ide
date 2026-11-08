import Testing
import Foundation
@testable import SharedProtocol

/// C5: the shared `devicePolicy` rows are executable here, not just copied into Swift. Node's
/// `extension/tests/sync-policy.test.mjs` and `scripts/sync-vectors.mjs` read the same file.
@Suite("Device lifetime policy against the shared vectors")
struct SyncPolicyTests {
    private var policy: [String: Any] { SV.d(SV.sync["devicePolicy"]) }
    private var manifest: [String: Any] { SV.d(policy["manifest"]) }
    private var deviceToken: [String: Any] { SV.d(policy["deviceToken"]) }

    @Test("the vector numbers are the Swift constants")
    func constants() {
        #expect(SV.i(manifest["staleAfterMs"]) == SyncPolicy.staleManifestAfterMs)
        #expect(SV.i(manifest["staleAfterMs"]) == 7 * 86_400_000)
        #expect(SV.i(deviceToken["maxLifetimeMs"]) == SyncPolicy.deviceTokenMaxLifetimeMs)
        #expect(SV.i(deviceToken["maxLifetimeMs"]) == 90 * 86_400_000)
    }

    @Test("manifest: fresh inside validUntil, withheld after it, stale_manifest past the 7-day grace")
    func manifestCases() {
        let validUntil = SV.i(manifest["validUntil"])
        for c in manifest["cases"] as! [[String: Any]] {
            let got = SyncPolicy.manifestState(validUntil: validUntil, nowMs: SV.i(c["nowMs"]))
            #expect(got.rawValue == SV.s(c["expect"]), "manifest \(SV.s(c["name"]))")
        }
    }

    @Test("device token: live through exactly 90 days from pairing, expired 1 ms later")
    func deviceTokenCases() {
        let pairedAt = SV.i(deviceToken["pairedAt"])
        for c in deviceToken["cases"] as! [[String: Any]] {
            let got = SyncPolicy.deviceTokenState(pairedAt: pairedAt, nowMs: SV.i(c["nowMs"]))
            #expect(got.rawValue == SV.s(c["expect"]), "token \(SV.s(c["name"]))")
        }
    }
}
