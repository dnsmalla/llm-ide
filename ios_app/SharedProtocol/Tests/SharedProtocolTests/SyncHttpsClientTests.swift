import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("SyncHttpsClient against a fake nginx /sync/ endpoint")
struct SyncHttpsClientTests {
    @MainActor final class Fake {
        var requests: [URLRequest] = []
        var replies: [(Int, Data)] = []
        var transport: SyncHttpsClient.Transport { { [unowned self] req in
            self.requests.append(req)
            let (status, body) = self.replies.isEmpty ? (404, Data()) : self.replies.removeFirst()
            return (body, HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        } }
    }
    static let id = String(repeating: "A", count: 22)

    @Test("GET: 200 is the bytes, 404 is nil; the URL is https://<host>/sync/<path>")
    func get() async throws {
        let f = Fake(); f.replies = [(200, Data([1, 2])), (404, Data())]
        let c = try SyncHttpsClient(host: "llm-ide.com", transport: f.transport)
        #expect(try await c.get("\(Self.id)/d/\(Self.id)/key.bin") == Data([1, 2]))
        #expect(try await c.get("\(Self.id)/d/\(Self.id)/wrap.bin") == nil)
        #expect(f.requests[0].url?.absoluteString == "https://llm-ide.com/sync/\(Self.id)/d/\(Self.id)/key.bin")
        #expect(f.requests[0].httpMethod == "GET")
    }

    @Test("PUT: 201 and 204 succeed; 409, 413, 429, 500 map to failures; big bodies never leave")
    func put() async throws {
        let f = Fake(); f.replies = [(201, Data()), (204, Data()), (409, Data()), (413, Data()), (429, Data()), (500, Data())]
        let c = try SyncHttpsClient(host: "llm-ide.com", transport: f.transport)
        let p = "\(Self.id)/d/\(Self.id)/in/0000000000001-\(Self.id).bin"
        try await c.put(p, Data([1]), createFolders: 1)
        try await c.put(p, Data([1]), createFolders: 1)
        await #expect(throws: SyncHttpsClient.Failure.missing) { try await c.put(p, Data([1]), createFolders: 1) }
        await #expect(throws: SyncHttpsClient.Failure.tooLarge) { try await c.put(p, Data([1]), createFolders: 1) }
        await #expect(throws: SyncHttpsClient.Failure.rateLimited) { try await c.put(p, Data([1]), createFolders: 1) }
        await #expect(throws: SyncHttpsClient.Failure.http(500)) { try await c.put(p, Data([1]), createFolders: 1) }
        #expect(f.requests[0].httpMethod == "PUT" && f.requests[0].httpBody == Data([1]))
        let sent = f.requests.count
        await #expect(throws: SyncHttpsClient.Failure.tooLarge) { try await c.put(p, Data(count: 65_537), createFolders: 1) }
        #expect(f.requests.count == sent)
    }

    @Test("hosts and paths are checked before any request")
    func refusals() async throws {
        let f = Fake()
        for h in ["LLM-IDE.com", "localhost", "llm-ide.com:8443", "72.62.76.92", "evil.com/x"] {
            #expect(throws: SyncHttpsClient.Failure.badHost) { _ = try SyncHttpsClient(host: h, transport: f.transport) }
        }
        let c = try SyncHttpsClient(host: "llm-ide.com", transport: f.transport)
        await #expect(throws: (any Error).self) { _ = try await c.get("../x") }
        #expect(f.requests.isEmpty)
    }

    @Test("pairing accepts sftp:<lower-case DNS host> only")
    func storeDescriptor() {
        #expect(SyncEnroll.isStore("sftp:llm-ide.com"))
        #expect(SyncEnroll.isStore("mega:llmide-sync"))
        for st in ["sftp:", "sftp:LLM-IDE.com", "sftp:localhost", "sftp:llm-ide.com:8443", "sftp:72.62.76.92", "sftp:a-.com"] { #expect(!SyncEnroll.isStore(st)) }
    }
}
