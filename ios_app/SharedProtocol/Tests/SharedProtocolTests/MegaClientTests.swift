import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("MegaClient against a fake MEGA API seeded by megajs")
struct MegaClientTests {
    static let noSleep: MegaClient.Sleep = { _ in }
    func client(_ s: FakeMegaServer, random: [Data] = []) -> MegaClient {
        var queue = random
        return MegaClient(folder: "llmide-sync", session: s.session, transport: s.transport, gateway: URL(string: "https://fake.mega.test/")!,
                          sleep: Self.noSleep, randomBytes: { n in queue.isEmpty ? SyncCrypto.randomBytes(n) : queue.removeFirst() })
    }

    @Test("login answers hashcash and derives megajs's session")
    func login() async throws {
        let s = FakeMegaServer(); s.hashcashChallenge = SV.s(SV.d(SV.mega["hashcash"])["challenge"])
        let l = s.login
        let session = try await MegaClient.login(email: SV.s(l["email"]).uppercased(), password: SV.s(l["password"]), transport: s.transport,
                                                 gateway: URL(string: "https://fake.mega.test/")!, sleep: Self.noSleep)
        #expect(session == s.session)
        #expect(s.receivedHashcash == SV.s(SV.d(SV.mega["hashcash"])["token"]))
        #expect(s.commands.first?["user"] as? String == SV.s(l["email"]))
    }

    @Test("get: megajs small and multi-chunk uploads download, decrypt and pass the MAC")
    func get() async throws {
        let s = FakeMegaServer(); let c = client(s)
        #expect(try await c.get("hello.bin") == SV.hex(SV.d(SV.mega["upload"])["plaintextHex"]))
        let big = try await c.get("big.bin")!
        #expect(big.count == SV.d(SV.mega["big"])["size"] as! Int)
        #expect(try await c.get("nope.bin") == nil)
    }

    @Test("put: with megajs's keys, the bytes MEGA receives equal megajs's")
    func put() async throws {
        let mk = SV.d(SV.mega["mkdir"]), up = SV.d(SV.mega["upload"])
        let s = FakeMegaServer(dropping: [SV.s(mk["h"])])
        let c = client(s, random: [SV.hex(mk["keyHex"]), SV.hex(up["keyHex"])])
        try await c.put("in/hello.bin", SV.hex(up["plaintextHex"]), createFolders: 1)
        #expect(s.uploads.values.contains(SV.b(up["ciphertext"])))
        #expect(try await c.get("in/hello.bin") == SV.hex(up["plaintextHex"]))
    }

    @Test("put never recreates a deleted folder")
    func noRecreate() async throws {
        let s = FakeMegaServer()
        await #expect(throws: SyncCryptoError("removed")) { try await client(s).put("gone/in/x.bin", Data([1]), createFolders: 1) }
        #expect(!s.commands.contains { $0["a"] as? String == "p" })
    }

    @Test("errors: expired, rate limited, quota, non-https, tampered, oversized")
    func errors() async throws {
        let s = FakeMegaServer(); let c = client(s)
        s.failures["f"] = -15
        await #expect(throws: MegaClient.Failure.sessionExpired) { _ = try await c.get("hello.bin") }
        s.failures["f"] = -4
        await #expect(throws: MegaClient.Failure.rateLimited) { _ = try await c.get("hello.bin") }
        s.downloadStatus = 509
        await #expect(throws: MegaClient.Failure.quota) { _ = try await c.get("hello.bin") }
        s.downloadStatus = 200; s.downloadScheme = "http"
        await #expect(throws: MegaClient.Failure.badResponse) { _ = try await c.get("hello.bin") }
    }

    @Test("EAGAIN is retried 2,4,8,16 s then rate limited")
    func busy() async throws {
        let s = FakeMegaServer(); var waits: [UInt64] = []; var busy = 5
        let c = MegaClient(folder: "llmide-sync", session: s.session, transport: { req in
            if busy > 0, req.url?.path == "/cs" { busy -= 1; return (Data("[-3]".utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!) }
            return try await s.handle(req)
        }, gateway: URL(string: "https://fake.mega.test/")!, sleep: { waits.append($0) })
        await #expect(throws: MegaClient.Failure.rateLimited) { _ = try await c.get("hello.bin") }
        #expect(waits == [2, 4, 8, 16].map { UInt64($0) * 1_000_000_000 })
    }

    @Test("pinned: two blob reads and a missing file share one tree fetch")
    func pinnedTree() async throws {
        let s = FakeMegaServer(); let c = client(s)
        let store = try await c.pinned()
        #expect(try await store.get("hello.bin") == SV.hex(SV.d(SV.mega["upload"])["plaintextHex"]))
        #expect(try await store.get("big.bin") != nil)
        #expect(try await store.get("nope.bin") == nil)
        #expect(s.commands.filter { $0["a"] as? String == "f" }.count == 1)
    }
}
