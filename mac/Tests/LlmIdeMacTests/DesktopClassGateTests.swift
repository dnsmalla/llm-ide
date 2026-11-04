import XCTest
import Network
import SharedProtocol
@testable import LlmIdeMacLib

/// Security review (bridge-3006) I1/I3: the desktop class on `:3006` is host-granted at pairing, stored on the device
/// record, and honoured only for that record from a loopback peer. These tests exercise the gate itself.
final class DesktopClassGateTests: XCTestCase {

    // MARK: - Loopback decision on the real peer address (not the throttle key)

    func testLoopbackTable() {
        let cases: [(String, Bool)] = [
            ("127.0.0.1", true), ("127.0.0.2", true), ("127.255.255.254", true),
            ("::1", true), ("::ffff:127.0.0.1", true), ("::ffff:127.9.9.9", true),
            ("fe80::1%lo0", false), ("192.168.1.20", false), ("10.0.0.1", false), ("0.0.0.0", false),
            ("2001:db8::1", false), ("::ffff:192.168.1.20", false), ("::", false), ("fe80::1", false),
        ]
        for (text, expected) in cases {
            let host = NWEndpoint.Host(text)
            XCTAssertEqual(MobileWebSocketServer.isLoopback(host), expected, text)
        }
        XCTAssertFalse(MobileWebSocketServer.isLoopback(.name("localhost", nil)), "a name is never trusted")
    }

    func testSessionClassNeedsTheStoredDesktopRecordAndALoopbackPeer() {
        XCTAssertEqual(MobileWebSocketServer.sessionClass(stored: "desktop", peerIsLoopback: true), "desktop")
        XCTAssertNil(MobileWebSocketServer.sessionClass(stored: "desktop", peerIsLoopback: false),
                     "a desktop token from a non-loopback peer is a phone")
        XCTAssertNil(MobileWebSocketServer.sessionClass(stored: nil, peerIsLoopback: true),
                     "a phone token that claims desktop is a phone")
        XCTAssertNil(MobileWebSocketServer.sessionClass(stored: "phone", peerIsLoopback: true))
    }

    // MARK: - The device record carries the class

    private func tempStore() -> MobilePairedDeviceStore {
        MobilePairedDeviceStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("desktop-class-\(UUID().uuidString).json"))
    }

    func testRecordsDefaultToPhoneAndOnlyAGrantMakesThemDesktop() {
        let store = tempStore()
        let t1 = store.issueToken(deviceId: "d1", name: "LLM-IDE Desktop")
        XCTAssertNil(store.clientClass(deviceId: "d1"), "a fresh record is a phone")
        XCTAssertTrue(store.grantDesktopClass(deviceId: "d1", tokenHash: MobilePairedDeviceStore.hash(t1)))
        XCTAssertEqual(store.clientClass(deviceId: "d1"), "desktop")
        _ = store.issueToken(deviceId: "d1", name: "LLM-IDE Desktop")
        XCTAssertNil(store.clientClass(deviceId: "d1"), "pairing again resets to phone until approved again")
        XCTAssertFalse(store.grantDesktopClass(deviceId: "nope", tokenHash: MobilePairedDeviceStore.hash(t1)))
    }

    /// Re-review m1: a re-pair of the same id while the dialog is open must not inherit the owner's Allow.
    func testAGrantIsBoundToTheTokenItWasRequestedWith() {
        let store = tempStore()
        let requested = MobilePairedDeviceStore.hash(store.issueToken(deviceId: "d1", name: "LLM-IDE Desktop"))
        _ = store.issueToken(deviceId: "d1", name: "someone else")   // re-pair during the dialog
        XCTAssertFalse(store.grantDesktopClass(deviceId: "d1", tokenHash: requested))
        XCTAssertNil(store.clientClass(deviceId: "d1"), "the new record stays a phone")
    }

    func testAnOldRecordWithoutAClassLoadsAsPhone() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-class-old-\(UUID().uuidString).json")
        try Data(#"[{"id":"d1","name":"x","tokenHash":"ab","pairedAt":"2026-11-01T00:00:00Z","lastSeenAt":"2026-11-01T00:00:00Z"}]"#.utf8)
            .write(to: url)
        let store = MobilePairedDeviceStore(fileURL: url)
        XCTAssertEqual(store.all.count, 1)
        XCTAssertNil(store.clientClass(deviceId: "d1"))
    }

    // MARK: - End to end on a loopback socket

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _classes: [String?] = []
        private var _requested: [(String, String)] = []
        private var _port: Int?
        func frame(_ cls: String?) { lock.lock(); _classes.append(cls); lock.unlock() }
        func request(_ id: String, _ hash: String) { lock.lock(); _requested.append((id, hash)); lock.unlock() }
        func bound(_ p: Int) { lock.lock(); _port = p; lock.unlock() }
        var classes: [String?] { lock.lock(); defer { lock.unlock() }; return _classes }
        var requested: [(String, String)] { lock.lock(); defer { lock.unlock() }; return _requested }
        var port: Int? { lock.lock(); defer { lock.unlock() }; return _port }
    }

    private func waitUntil(_ cond: () -> Bool) {
        for _ in 0..<250 where !cond() { Thread.sleep(forTimeInterval: 0.02) }
    }

    private func makeServer(store: MobilePairedDeviceStore, rec: Recorder) throws -> MobileWebSocketServer {
        let server = MobileWebSocketServer(
            port: 41_000 + Int.random(in: 0...2_000), deviceName: "test",
            validatePin: { $0 == "123456" },
            authenticateToken: { store.authenticate(deviceId: $0, token: $1) },
            issueToken: { store.issueToken(deviceId: $0, name: $1) },
            storedClientClass: { store.clientClass(deviceId: $0) },
            onInbound: { _, cls in rec.frame(cls) },
            onLog: { _ in },
            onDesktopClassRequested: { rec.request($0, $1) },
            onListening: { rec.bound($0) })
        try server.start()
        waitUntil { rec.port != nil }
        return server
    }

    /// Pair, then send one app frame; returns the socket so the caller can close it.
    private func pairAndSend(port: Int, pin: String = "", token: String?, deviceId: String) -> URLSessionWebSocketTask {
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        var pairing: [String: String] = ["type": "pairing", "pin": pin, "deviceId": deviceId, "clientClass": "desktop"]
        if let token { pairing["token"] = token }
        let data = try! JSONSerialization.data(withJSONObject: pairing)
        task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
        let connected = expectation(description: "connected")
        task.receive { _ in connected.fulfill() }
        wait(for: [connected], timeout: 5)
        task.send(.string(#"{"type":"auto_task_list"}"#)) { _ in }
        return task
    }

    func testAPhoneTokenThatClaimsDesktopIsAPhone() throws {
        let store = tempStore(), rec = Recorder()
        let token = store.issueToken(deviceId: "phone-1", name: "iPhone")
        let server = try makeServer(store: store, rec: rec)
        defer { server.stop() }
        let task = pairAndSend(port: rec.port!, token: token, deviceId: "phone-1")
        defer { task.cancel() }
        waitUntil { !rec.classes.isEmpty }
        XCTAssertEqual(rec.classes, [nil])
        XCTAssertTrue(rec.requested.isEmpty, "a token reconnect never asks for the class")
    }

    func testADesktopTokenFromLoopbackGetsTheDesktopClass() throws {
        let store = tempStore(), rec = Recorder()
        let token = store.issueToken(deviceId: "desk-1", name: "LLM-IDE Desktop")
        XCTAssertTrue(store.grantDesktopClass(deviceId: "desk-1", tokenHash: MobilePairedDeviceStore.hash(token)))
        let server = try makeServer(store: store, rec: rec)
        defer { server.stop() }
        let task = pairAndSend(port: rec.port!, token: token, deviceId: "desk-1")
        defer { task.cancel() }
        waitUntil { !rec.classes.isEmpty }
        XCTAssertEqual(rec.classes, ["desktop"])
    }

    func testAPinPairingThatClaimsDesktopIsAPhoneUntilTheMacGrantsIt() throws {
        let store = tempStore(), rec = Recorder()
        let server = try makeServer(store: store, rec: rec)
        defer { server.stop() }
        let task = pairAndSend(port: rec.port!, pin: "123456", token: nil, deviceId: "desk-2")
        defer { task.cancel() }
        waitUntil { !rec.classes.isEmpty }
        XCTAssertEqual(rec.classes, [nil], "the PIN alone never grants the desktop class")
        XCTAssertEqual(rec.requested.map(\.0), ["desk-2"], "the Mac is asked")
        XCTAssertNil(store.clientClass(deviceId: "desk-2"))
        // The owner allows it: the record and the live loopback session become desktop.
        XCTAssertTrue(store.grantDesktopClass(deviceId: "desk-2", tokenHash: rec.requested[0].1),
                      "the request carries the issued token's hash")
        server.grantDesktopClass(deviceId: "desk-2")
        task.send(.string(#"{"type":"auto_task_list"}"#)) { _ in }
        waitUntil { rec.classes.count >= 2 }
        XCTAssertEqual(rec.classes.last, "desktop")
    }
}
