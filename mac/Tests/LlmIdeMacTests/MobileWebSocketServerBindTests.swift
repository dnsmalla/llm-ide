import XCTest
import Network
import Darwin
@testable import LlmIdeMacLib

/// `MobileWebSocketServer` must surface an asynchronous listener bind failure
/// (the common case: another process — e.g. the retired computer-agent — is
/// squatting on :3006, EADDRINUSE) via `onBindFailed`. `NWListener` delivers
/// this as `.failed` on the listener's `stateUpdateHandler`, NOT as a sync
/// throw from `start()`, so without this seam the manager would report
/// `.running` + log "WebSocket listening on :3006" while the listener is dead
/// — the root cause of the "Wrong PIN" misdiagnosis (see memory
/// `mobile-wrong-pin-port3006-conflict`).
final class MobileWebSocketServerBindTests: XCTestCase {

    /// Reference-type holder so an escaping callback can store the captured
    /// error; read after the expectation synchronizes. (Package uses Swift v5
    /// mode, so plain mutation here is fine.)
    final class Box<T> { var value: T; init(_ value: T) { self.value = value } }

    /// Grab a free TCP port by binding a throwaway socket to port 0, reading
    /// the assigned port back, then closing it. Tiny inherent race window
    /// before the test rebinds it; negligible on a dev host.
    private func freeTCPPort() -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return 0 }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = 0
        var on: Int32 = 1
        _ = setsockopt(fd, Int32(SOL_SOCKET), SO_REUSEADDR, &on, socklen_t(MemoryLayout<Int32>.size))
        let bound = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { return 0 }
        var named = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named0 = withUnsafeMutablePointer(to: &named) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                getsockname(fd, sa, &len)
            }
        }
        guard named0 == 0 else { return 0 }
        return Int(UInt16(bigEndian: named.sin_port))
    }

    func testBindFailureOnBusyPortInvokesOnBindFailed() throws {
        let port = freeTCPPort()
        XCTAssertGreaterThan(port, 0, "Could not obtain a free TCP port for the test")

        // Squat on the port with a sacrificial listener (the "rogue process").
        let squat = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: UInt16(port))!)
        let squatReady = expectation(description: "squat listener is ready (holding the port)")
        squat.stateUpdateHandler = { state in
            if case .ready = state { squatReady.fulfill() }
        }
        squat.newConnectionHandler = { _ in }
        squat.start(queue: DispatchQueue.global())
        defer { squat.cancel() }
        wait(for: [squatReady], timeout: 5.0)

        // SUT: the real server tries to bind the SAME port.
        let bindFailed = expectation(description: "onBindFailed is invoked with the bind error")
        let captured = Box<Error?>(nil)
        // portCandidates: 1 pins the EXHAUSTION contract — with fallback
        // candidates the server would simply bind port+1 and succeed (that
        // path has its own test below).
        let server = MobileWebSocketServer(
            port: port,
            portCandidates: 1,
            deviceName: "test",
            validatePin: { _ in true },
            onInbound: { _ in },
            onLog: { _ in },
            onBindFailed: { error in
                captured.value = error
                bindFailed.fulfill()
            }
        )
        try server.start()
        wait(for: [bindFailed], timeout: 5.0)
        server.stop()

        XCTAssertNotNil(captured.value, "onBindFailed must deliver an error")
        if case .posix(let code)? = captured.value as? NWError {
            XCTAssertEqual(code, .EADDRINUSE, "expected EADDRINUSE for a busy port")
        } else {
            XCTFail("expected NWError.posix(EADDRINUSE), got \(String(describing: captured.value))")
        }
    }

    /// Whether `port` can be bound right now (bind + close). Used to pick a
    /// QUIET test range: `freeTCPPort()` allocates from the kernel's
    /// ephemeral counter, and the ports right after it belong to whatever
    /// outgoing connections the machine just opened — a fallback test there
    /// finds ALL its candidates genuinely busy (observed live: ten
    /// consecutive EADDRINUSE). Production is unaffected; :3006 is nowhere
    /// near the ephemeral range.
    private func canBind(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = 0
        let bound = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return bound == 0
    }

    /// A base port (well below the ephemeral range) where base AND base+1
    /// are currently free, or nil after a bounded number of random probes.
    private func freeAdjacentPortPair() -> Int? {
        for _ in 0..<40 {
            let base = Int.random(in: 21000...39000)
            if canBind(base), canBind(base + 1) { return base }
        }
        return nil
    }

    /// A squatter on the configured port must move the server to the next
    /// candidate, not kill it — and `onListening` must report the port that
    /// actually bound, because Bonjour/QR advertise that value.
    func testBusyPortFallsBackToNextCandidateAndReportsIt() throws {
        guard let port = freeAdjacentPortPair() else {
            throw XCTSkip("No free adjacent port pair found — host under unusual load")
        }

        let squat = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: UInt16(port))!)
        let squatReady = expectation(description: "squat listener holds the base port")
        squat.stateUpdateHandler = { state in
            if case .ready = state { squatReady.fulfill() }
        }
        squat.newConnectionHandler = { _ in }
        squat.start(queue: DispatchQueue.global())
        defer { squat.cancel() }
        wait(for: [squatReady], timeout: 5.0)

        let listening = expectation(description: "onListening fires with the fallback port")
        let boundPort = Box<Int?>(nil)
        let server = MobileWebSocketServer(
            port: port,
            deviceName: "test",
            validatePin: { _ in true },
            onInbound: { _ in },
            onLog: { _ in },
            onListening: { p in
                boundPort.value = p
                listening.fulfill()
            },
            onBindFailed: { error in
                XCTFail("fallback should bind, not fail: \(error)")
            }
        )
        try server.start()
        // The base port gets the release-lag retries first (4 × 0.6 s) before
        // the server concludes it is genuinely taken and slides — allow for it.
        wait(for: [listening], timeout: 10.0)
        server.stop()

        XCTAssertEqual(boundPort.value, port + 1,
                       "the first fallback candidate is base+1")
    }
}
