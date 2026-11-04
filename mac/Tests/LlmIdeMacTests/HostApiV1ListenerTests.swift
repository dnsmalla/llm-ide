import Testing
import Foundation
@testable import LlmIdeMacLib

@Suite("HostApiV1Listener", .serialized)
struct HostApiV1ListenerTests {
    @Test("the development listener needs a DEBUG build AND the explicit flag")
    func devGate() {
        #expect(HostApiV1Listener.devListenerAllowed(environment: ["LLMIDE_HOST_API_DEV": "1"], isDebugBuild: true))
        #expect(!HostApiV1Listener.devListenerAllowed(environment: ["LLMIDE_HOST_API_DEV": "1"], isDebugBuild: false))
        #expect(!HostApiV1Listener.devListenerAllowed(environment: [:], isDebugBuild: true))
        #expect(!HostApiV1Listener.devListenerAllowed(environment: ["LLMIDE_HOST_API_DEV": "true"], isDebugBuild: true))
    }

    @Test("a handshake carrying Origin is refused, whatever its case")
    func origin() {
        #expect(HostApiV1Listener.refusesHandshake(headers: [("Origin", "https://evil.example")]))
        #expect(HostApiV1Listener.refusesHandshake(headers: [("origin", "null")]))
        #expect(!HostApiV1Listener.refusesHandshake(headers: [("Host", "127.0.0.1:3016")]))
    }

    @Test("listener events drain in yield order from one stream")
    func eventOrder() async {
        let (events, c) = AsyncStream<HostApiV1ListenerEvent>.makeStream()
        c.yield(.opened(1, "p")); c.yield(.frame(1, Data("a".utf8))); c.yield(.frame(1, Data("b".utf8))); c.yield(.closed(1)); c.finish()
        var seen: [String] = []
        for await e in events {
            switch e {
            case .opened: seen.append("o")
            case .frame(_, let d): seen.append(String(decoding: d, as: UTF8.self))
            case .closed: seen.append("c")
            }
        }
        #expect(seen == ["o", "a", "b", "c"])
    }

    @Test("a loopback client can open a socket and its frames reach the gateway")
    func loopbackRoundTrip() async throws {
        let port = 3016 + Int.random(in: 200...900)
        let frames = FrameBox()
        let listener = HostApiV1Listener(basePort: port, candidates: 3,
                                         onOpen: { _, _ in }, onFrame: { s, d in frames.add(s, d) }, onClose: { _ in },
                                         onListening: { frames.bound($0) }, onLog: { _ in })
        try listener.start()
        defer { listener.stop() }
        let bound = try await frames.waitForBind()
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(bound)")!)
        task.resume()
        try await task.send(.string(#"{"apiVersion":1,"id":"c-1","type":"request","command":"host.ping","payload":{},"ts":1}"#))
        let got = try await frames.waitForFrame()
        #expect(String(decoding: got, as: UTF8.self).contains("host.ping"))
        task.cancel(with: .goingAway, reason: nil)
    }
}

final class FrameBox: @unchecked Sendable {
    private let lock = NSLock()
    private var port: Int?
    private var frames: [Data] = []
    func bound(_ p: Int) { lock.lock(); port = p; lock.unlock() }
    func add(_ s: Int, _ d: Data) { lock.lock(); frames.append(d); lock.unlock() }
    func waitForBind() async throws -> Int {
        for _ in 0..<100 { lock.lock(); let p = port; lock.unlock(); if let p { return p }; try await Task.sleep(nanoseconds: 20_000_000) }
        throw CancellationError()
    }
    func waitForFrame() async throws -> Data {
        for _ in 0..<100 { lock.lock(); let f = frames.first; lock.unlock(); if let f { return f }; try await Task.sleep(nanoseconds: 20_000_000) }
        throw CancellationError()
    }
}
