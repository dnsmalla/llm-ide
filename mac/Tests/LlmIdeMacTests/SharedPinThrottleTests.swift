import Testing
import Foundation
@testable import LlmIdeMacLib

/// The v2 link (`MobileWebSocketServer.pinAttempt`) and the Host API v1 gateway share ONE PIN throttle,
/// so a guesser gets one budget, not two. Token throttles stay per path.
@MainActor
@Suite("SharedPinThrottle", .serialized)
final class SharedPinThrottleTests {
    let shared = LockedPairingThrottle()
    var sent: [[String: Any]] = []
    var clock = Date(timeIntervalSince1970: 1_000_000)
    let pin = "123456"
    var session = 0

    func gateway() -> HostApiV1Gateway {
        let store = MobilePairedDeviceStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("h1-shared-\(UUID().uuidString)/devices.json"))
        var deps = HostApiV1Gateway.Dependencies(
            hostName: { "Test Mac" },
            validatePin: { [unowned self] in $0 == self.pin },
            pinConsumed: {},
            issueToken: { [store] id, name, scopes in store.issueToken(deviceId: id, name: name, scopes: scopes) },
            authenticate: { [store] in store.authenticate(token: $0) },
            scopes: { [store] in store.scopes(deviceId: $0) },
            revoke: { [store] in store.revoke(id: $0) },
            capabilities: { ["host"] },
            tierRefusal: { _ in nil },
            forward: { _ in },
            history: { _ in .lines([]) },
            clear: { .cleared },
            cancel: { _ in },
            log: { _ in },
            certificateFingerprint: { nil },
            now: { [unowned self] in self.clock })
        deps.pinThrottle = shared
        let g = HostApiV1Gateway(dependencies: deps)
        g.send = { [unowned self] _, d in self.sent.append(try! JSONSerialization.jsonObject(with: d) as! [String: Any]) }
        return g
    }

    func request(_ id: String, _ command: String, _ payload: String) -> Data {
        Data(#"{"apiVersion":1,"id":"\#(id)","type":"request","command":"\#(command)","payload":\#(payload),"ts":1}"#.utf8)
    }

    /// One v1 pairing attempt from `peer`; returns the error message, nil on success.
    func v1(_ g: HostApiV1Gateway, _ peer: String, _ tried: String) async -> String? {
        session += 1
        g.opened(session: session, peer: peer)
        await g.receive(session: session, data: request("c-h", "host.hello",
                                                        #"{"clientName":"t","clientVersion":"1","platform":"web","apiVersions":[1]}"#))
        await g.receive(session: session, data: request("c-p", "host.auth.pair", #"{"pin":"\#(tried)"}"#))
        g.closed(session: session)
        return (sent.last?["error"] as? [String: Any])?["message"] as? String
    }

    /// One v2 pairing attempt from `peer`, keyed the way the v2 server keys it.
    func v2(_ peer: String, _ tried: String) -> MobileWebSocketServer.PinAttempt {
        MobileWebSocketServer.pinAttempt(tried, host: PairingThrottle.peerKey(peer), throttle: shared,
                                         validate: { [pin] in $0 == pin }, now: clock)
    }

    func tick() { clock = clock.addingTimeInterval(200) }   // past every escalating delay (cap 120 s)

    @Test("8 wrong PINs split across v2 and v1 from one /64 lock out the 9th on either path")
    func splitLockout() async {
        let g = gateway()
        for n in 1...4 {
            #expect(v2("2001:db8:1:2::\(n)", "000000") == .wrong); tick()
            #expect(await v1(g, "2001:db8:1:2::\(n + 10)", "000000") == "Wrong PIN."); tick()
        }
        #expect(await v1(g, "2001:db8:1:2::99", pin) == "Too many wrong PINs — locked out for 15 minutes.")
        #expect(v2("2001:db8:1:2::98", pin) == .throttled(.lockedOut))
    }

    @Test("a correct PIN on v1 clears the v2 record, and the reverse")
    func successClearsOtherPath() async {
        let g = gateway()
        for _ in 0..<7 { #expect(v2("10.0.0.7", "000000") == .wrong); tick() }
        #expect(await v1(g, "10.0.0.7", pin) == nil)
        tick()
        // Without the clear this would be failure 8, and the next attempt locked out.
        #expect(v2("10.0.0.7", "000000") == .wrong); tick()
        #expect(v2("10.0.0.7", pin) == .ok)

        for _ in 0..<7 { #expect(await v1(g, "10.0.0.8", "000000") == "Wrong PIN."); tick() }
        #expect(v2("10.0.0.8", pin) == .ok)
        tick()
        #expect(await v1(g, "10.0.0.8", "000000") == "Wrong PIN."); tick()
        #expect(await v1(g, "10.0.0.8", pin) == nil)
    }

    @Test("the manager hands its one PIN throttle to the v1 gateway")
    func managerInjectsShared() {
        let manager = MobileControlManager()
        #expect(manager.makeHostApiDependencies().pinThrottle === manager.pinThrottle)
    }

    @Test("the global budget is one cap across both paths")
    func sharedGlobalBudget() async {
        let g = gateway()
        for n in 0..<(PairingThrottle.globalThreshold / 2) {
            #expect(v2("10.1.0.\(n)", "000000") == .wrong)
            #expect(await v1(g, "10.2.0.\(n)", "000000") == "Wrong PIN.")
        }
        #expect(v2("10.3.0.1", pin) == .throttled(.serverThrottled))
        #expect(await v1(g, "10.3.0.2", pin) == "This Mac is refusing new pairings for a few minutes.")
    }
}
