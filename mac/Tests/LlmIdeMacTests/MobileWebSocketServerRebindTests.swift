import XCTest
import Network
@testable import LlmIdeMacLib

/// Kill & Restart in Settings → Mobile Control failed with
/// "bind failed: … EADDRINUSE" against the app's OWN listener.
///
/// `stop()` captured `self` weakly and enqueued the teardown on a serial
/// queue, but every caller drops its reference on the next line
/// (`server?.stop(); server = nil`). The object deallocated first, the block's
/// `guard let self else { return }` bailed, and `listener.cancel()` never ran.
/// An `NWListener` released without `cancel()` holds its socket for the life
/// of the process, so the port never came back and the bounded EADDRINUSE
/// retry could not possibly win.
final class MobileWebSocketServerRebindTests: XCTestCase {

    /// A fresh high port per test, so one test's asynchronous teardown can
    /// never be mistaken for the next test's bug.
    ///
    /// Note the ~0.6s each rebind test takes is NOT cross-test interference —
    /// it reproduces at the same duration when a test runs alone. It is the
    /// in-test restart: the second bind races the first listener's `cancel()`,
    /// takes one EADDRINUSE retry, and succeeds on the 0.6s backoff. That is
    /// the behaviour under test, and it is what Kill & Restart does for real.
    private var port = 0

    private static let portLock = NSLock()
    private static var nextPortValue = 39_017
    private static func reservePort() -> Int {
        portLock.lock(); defer { portLock.unlock() }
        nextPortValue += 1
        return nextPortValue
    }

    override func setUp() {
        super.setUp()
        port = Self.reservePort()
    }

    private func makeServer(onLog: @escaping (String) -> Void,
                            onBindFailed: @escaping (Error) -> Void) -> MobileWebSocketServer {
        MobileWebSocketServer(
            port: port,
            // Exact-port mode: this suite pins the release-lag retry and the
            // genuinely-held failure contracts, both of which port fallback
            // would otherwise route around (its own coverage lives in
            // MobileWebSocketServerBindTests).
            portCandidates: 1,
            deviceName: "test-device",
            validatePin: { _ in false },
            onInbound: { _ in },
            onLog: onLog,
            onClientPaired: {},
            onClientDisconnected: {},
            onBindFailed: onBindFailed
        )
    }

    /// Waits for the "listening" log the server emits from `.ready`.
    ///
    /// Bind failure is captured in a flag rather than an inverted expectation:
    /// an inverted expectation burns its full timeout on every call even when
    /// the bind succeeds immediately, which made each test take 20s.
    private func startAndAwaitReady(
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws -> MobileWebSocketServer {
        let ready = expectation(description: "\(label) reaches .ready")
        ready.assertForOverFulfill = false
        let bindError = LockedBox<Error?>(nil)

        let server = makeServer(
            onLog: { if $0.contains("listening") { ready.fulfill() } },
            onBindFailed: { bindError.set($0) }
        )
        try server.start()
        wait(for: [ready], timeout: 10)
        if let err = bindError.get() {
            XCTFail("\(label) failed to bind: \(err)", file: file, line: line)
        }
        return server
    }

    /// Minimal thread-safe box — the callbacks fire on the server's queue.
    private final class LockedBox<T>: @unchecked Sendable {
        private var value: T
        private let lock = NSLock()
        init(_ value: T) { self.value = value }
        func set(_ newValue: T) { lock.lock(); value = newValue; lock.unlock() }
        func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    }

    /// The regression: bind, tear down the way the manager does (stop then
    /// drop the last reference), then bind the same port again.
    func testPortIsReleasedWhenTheServerIsStoppedAndImmediatelyReleased() throws {
        var first: MobileWebSocketServer? = try startAndAwaitReady("first")

        // Exactly what MobileControlManager.stop() does.
        first?.stop()
        first = nil

        // Second bind must succeed. Before the fix the port stayed held by
        // this process and every attempt returned EADDRINUSE.
        let second = try startAndAwaitReady("second")
        addTeardownBlock { second.stop() }
    }

    /// The same teardown must also hold when the server is released WITHOUT
    /// stop() — deinit is the backstop for that path.
    func testPortIsReleasedWhenTheServerIsDroppedWithoutStopping() throws {
        var first: MobileWebSocketServer? = try startAndAwaitReady("first")
        first = nil   // no stop() — only deinit can free the port

        let second = try startAndAwaitReady("second")
        addTeardownBlock { second.stop() }
    }

    /// A genuine squatter must still be reported rather than retried forever,
    /// so the "run lsof -i :3006" guidance keeps its meaning.
    func testBindFailureIsReportedWhenThePortIsGenuinelyHeld() throws {
        let squatter = try startAndAwaitReady("squatter")
        defer { squatter.stop() }

        let reported = expectation(description: "bind failure surfaces")
        reported.assertForOverFulfill = false
        let blocked = makeServer(onLog: { _ in }, onBindFailed: { _ in reported.fulfill() })
        try blocked.start()

        // Must outlast the bounded retry budget (4 attempts × 0.6s backoff).
        wait(for: [reported], timeout: 15)
        blocked.stop()
    }
}
