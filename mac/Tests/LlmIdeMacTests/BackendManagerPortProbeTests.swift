import XCTest
import Darwin
@testable import LlmIdeMacLib

final class BackendManagerPortProbeTests: XCTestCase {
    /// Bind + listen on an ephemeral loopback port; returns (fd, port).
    private func listener() throws -> (Int32, Int) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(fd, 0)
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(listen(fd, 8), 0)
        var out = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &out) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        return (fd, Int(UInt16(bigEndian: out.sin_port)))
    }

    func testListeningPortReportedInUse() async throws {
        let (fd, port) = try listener()
        defer { close(fd) }
        let probe = await BackendManager.probePort(port: port)
        XCTAssertEqual(probe, .listening)
        let inUse = await BackendManager.isPortInUse(port: port)
        XCTAssertTrue(inUse)
    }

    func testCleanRefusalStaysFastAndFree() async throws {
        let (fd, port) = try listener()
        close(fd)
        let probe = await BackendManager.probePort(port: port)
        XCTAssertEqual(probe, .refused)
        let inUse = await BackendManager.isPortInUse(port: port)
        XCTAssertFalse(inUse)
    }
}
