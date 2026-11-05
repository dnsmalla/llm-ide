import Foundation

/// A minimal MEGA API client for the dedicated sync account (design §8.3; no SDK). HTTPS only; never deletes.
@MainActor
public final class MegaClient: SyncRemoteStore {
    public struct Session: Codable, Equatable, Sendable {
        public var sid: String
        public var masterKey: Data
        public init(sid: String, masterKey: Data) { self.sid = sid; self.masterKey = masterKey }
    }
    public enum Failure: Error, Equatable, Sendable {
        case authFailed, mfaRequired, sessionExpired, accountVersion, rateLimited, quota, tooLarge, badResponse
        case http(Int), api(Int)
    }
    public typealias Transport = (URLRequest) async throws -> (Data, HTTPURLResponse)
    public typealias Sleep = (UInt64) async throws -> Void

    public static let defaultGateway = URL(string: "https://g.api.mega.co.nz/")!
    private static let urlSession = URLSession(configuration: .ephemeral)
    public static let urlSessionTransport: Transport = { request in
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.badResponse }
        return (data, http)
    }
    public static let realSleep: Sleep = { try await Task.sleep(nanoseconds: $0) }
    static let maxUpload = 131_072

    public let folder: String
    public private(set) var session: Session
    private let transport: Transport
    private let gateway: URL
    private let sleep: Sleep
    private let randomBytes: (Int) -> Data
    private var counter = UInt64.random(in: 1..<10_000_000_000)

    public init(folder: String, session: Session, transport: @escaping Transport = MegaClient.urlSessionTransport,
                gateway: URL = MegaClient.defaultGateway, sleep: @escaping Sleep = MegaClient.realSleep,
                randomBytes: @escaping (Int) -> Data = SyncCrypto.randomBytes) {
        self.folder = folder; self.session = session; self.transport = transport; self.gateway = gateway
        self.sleep = sleep; self.randomBytes = randomBytes
    }

    static func failure(_ n: Int) -> Failure {
        switch n {
        case -15: return .sessionExpired
        case -26: return .mfaRequired
        case -3, -4, -6, -18, -19: return .rateLimited
        case -17, -24: return .quota
        default: return .api(n)
        }
    }

    static func api(_ cmd: [String: Any], id: UInt64, sid: String?, transport: Transport, gateway: URL, sleep: Sleep) async throws -> Any {
        let body = try JSONSerialization.data(withJSONObject: [cmd])
        var hashcash: String?
        var challenges = 0, busy = 0
        while true {
            var c = URLComponents(url: gateway.appendingPathComponent("cs"), resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "id", value: String(id))] + (sid.map { [URLQueryItem(name: "sid", value: $0)] } ?? [])
            var req = URLRequest(url: c.url!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let hashcash { req.setValue(hashcash, forHTTPHeaderField: "X-Hashcash") }
            req.httpBody = body
            let (data, resp) = try await transport(req)
            if let challenge = resp.value(forHTTPHeaderField: "X-Hashcash"), challenges < 2 {
                challenges += 1
                hashcash = try await Task.detached(priority: .userInitiated) { try MegaCrypto.hashcash(challenge) }.value
                continue
            }
            var result: Any?
            if resp.statusCode == 200 { result = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) }
            else if resp.statusCode == 500 || resp.statusCode == 503 { result = -3 }
            else { throw Failure.http(resp.statusCode) }
            if let list = result as? [Any] { result = list.first }
            if let n = result as? Int, n < 0 {
                if n == -3, busy < 4 { busy += 1; try await sleep(UInt64(1 << busy) * 1_000_000_000); continue }
                throw failure(n)
            }
            guard let result else { throw Failure.badResponse }
            return result
        }
    }

    private func call(_ cmd: [String: Any]) async throws -> Any {
        counter += 1
        return try await Self.api(cmd, id: counter, sid: session.sid, transport: transport, gateway: gateway, sleep: sleep)
    }

    public static func login(email: String, password: String, transport: @escaping Transport = urlSessionTransport,
                             gateway: URL = defaultGateway, sleep: @escaping Sleep = realSleep) async throws -> Session {
        let user = email.lowercased()
        var id = UInt64.random(in: 1..<10_000_000_000)
        func call(_ cmd: [String: Any]) async throws -> Any {
            id += 1
            do { return try await api(cmd, id: id, sid: nil, transport: transport, gateway: gateway, sleep: sleep) }
            catch Failure.api(-9), Failure.api(-16) { throw Failure.authFailed }
        }
        guard let pre = try await call(["a": "us0", "user": user]) as? [String: Any], let v = pre["v"] as? Int else { throw Failure.badResponse }
        guard v == 2, let salt = (pre["s"] as? String).flatMap(MegaCrypto.d64) else { throw Failure.accountVersion }
        let derived = MegaCrypto.pbkdf2SHA512(password: Data(password.utf8), salt: salt)
        guard let r = try await call(["a": "us", "user": user, "uh": SyncB64.encode(Data(derived.suffix(16)))]) as? [String: Any],
              let k = (r["k"] as? String).flatMap(MegaCrypto.d64), k.count == 16,
              let csid = (r["csid"] as? String).flatMap(MegaCrypto.d64),
              let privk = (r["privk"] as? String).flatMap(MegaCrypto.d64), !privk.isEmpty, privk.count % 16 == 0
        else { throw Failure.badResponse }
        let master = MegaCrypto.ecbDecrypt(Data(derived.prefix(16)), k)
        return Session(sid: try MegaCrypto.sessionId(csid: csid, privk: MegaCrypto.ecbDecrypt(master, privk)), masterKey: master)
    }

    public func logout() async { _ = try? await call(["a": "sml"]) }

    struct Node { let h: String; let p: String?; let t: Int; let name: String?; let key: Data?; let s: Int; let ts: Int }

    private func tree() async throws -> [Node] {
        guard let r = try await call(["a": "f", "c": 1]) as? [String: Any], let f = r["f"] as? [[String: Any]] else { throw Failure.badResponse }
        return f.compactMap(node)
    }

    private func node(_ o: [String: Any]) -> Node? {
        guard let h = o["h"] as? String, let t = o["t"] as? Int else { return nil }
        var name: String?, key: Data?
        if t <= 1, let k = o["k"] as? String, let a = (o["a"] as? String).flatMap(MegaCrypto.d64) {
            for alt in k.split(separator: "/") {
                guard let part = alt.split(separator: ":").last, let enc = MegaCrypto.d64(String(part)),
                      enc.count == 16 || enc.count == 32 else { continue }
                let plain = MegaCrypto.ecbDecrypt(session.masterKey, enc)
                if let n = MegaCrypto.decryptAttributes(a, key: plain) { name = n; key = plain; break }
            }
        }
        return Node(h: h, p: o["p"] as? String, t: t, name: name, key: key, s: o["s"] as? Int ?? 0, ts: o["ts"] as? Int ?? 0)
    }

    private func folderChild(_ nodes: [Node], _ parent: String, _ name: String) -> String? {
        nodes.first { $0.p == parent && $0.t == 1 && $0.name == name }?.h
    }
    private func syncFolder(_ nodes: [Node]) -> String? {
        guard let root = nodes.first(where: { $0.t == 2 }) else { return nil }
        return folderChild(nodes, root.h, folder)
    }
    private func folderHandle(_ nodes: [Node], _ segs: [String]) -> String? {
        var h = syncFolder(nodes)
        for s in segs { h = h.flatMap { folderChild(nodes, $0, s) } }
        return h
    }
    private func newestFile(_ nodes: [Node], in dir: String, named name: String) -> Node? {
        nodes.filter { $0.p == dir && $0.t == 0 && $0.name == name }.enumerated()
            .max { ($0.element.ts, $0.offset) < ($1.element.ts, $1.offset) }?.element
    }

    public func get(_ path: String) async throws -> Data? {
        let segs = try SyncPath.check(path)
        let nodes = try await tree()
        guard let dir = folderHandle(nodes, Array(segs.dropLast())), let file = newestFile(nodes, in: dir, named: segs.last!),
              let key = file.key, key.count == 32 else { return nil }
        guard file.s <= SyncPath.maxFileBytes else { throw Failure.tooLarge }
        if file.s == 0 { return Data() }
        guard let r = try await call(["a": "g", "g": 1, "ssl": 2, "n": file.h]) as? [String: Any], let g = r["g"] as? String,
              let url = URL(string: "\(g)/0-\(file.s - 1)"), url.scheme == "https" else { throw Failure.badResponse }
        let (data, resp) = try await transport(URLRequest(url: url))
        if resp.statusCode == 509 { throw Failure.quota }
        guard resp.statusCode == 200 else { throw Failure.http(resp.statusCode) }
        guard data.count == file.s else { throw Failure.badResponse }
        let k = MegaCrypto.unmergeKeyMac(key)
        let aes = Data(k.prefix(16)), nonce = Data(k[16..<24])
        let plain = MegaCrypto.ctr(aes, nonce: nonce, data)
        guard MegaCrypto.condensedMac(key: aes, nonce: nonce, plaintext: plain) == Data(k[24..<32]) else { throw Failure.badResponse }
        return plain
    }

    public func put(_ path: String, _ bytes: Data, createFolders: Int) async throws {
        let segs = try SyncPath.check(path)
        guard !bytes.isEmpty, bytes.count <= Self.maxUpload else { throw Failure.tooLarge }
        var nodes = try await tree()
        guard var dir = syncFolder(nodes) else { throw SyncCryptoError("removed") }
        let parents = Array(segs.dropLast())
        for (i, name) in parents.enumerated() {
            if let next = folderChild(nodes, dir, name) { dir = next; continue }
            guard parents.count - i <= createFolders else { throw SyncCryptoError("removed") }
            let fk = randomBytes(16)
            guard let r = try await call(["a": "p", "t": dir, "n": [["h": "xxxxxxxx", "t": 1,
                                                                    "a": MegaCrypto.encryptAttributes(name: name, key16: fk),
                                                                    "k": SyncB64.encode(MegaCrypto.ecbEncrypt(session.masterKey, fk))]]]) as? [String: Any],
                  let h = ((r["f"] as? [[String: Any]])?.first)?["h"] as? String else { throw Failure.badResponse }
            nodes.append(Node(h: h, p: dir, t: 1, name: name, key: fk, s: 0, ts: 0))
            dir = h
        }
        let key24 = randomBytes(24)
        let aes = Data(key24.prefix(16)), nonce = Data(key24.suffix(8))
        let nodeKey = MegaCrypto.mergeKeyMac(key24, mac: MegaCrypto.condensedMac(key: aes, nonce: nonce, plaintext: bytes))
        guard let u = try await call(["a": "u", "ssl": 2, "s": bytes.count, "ms": 0, "r": 0, "e": 0, "v": 2]) as? [String: Any],
              let p = u["p"] as? String, let url = URL(string: "\(p)/0"), url.scheme == "https" else { throw Failure.badResponse }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = MegaCrypto.ctr(aes, nonce: nonce, bytes)
        let (handle, resp) = try await transport(req)
        guard resp.statusCode == 200 else { throw resp.statusCode == 509 ? Failure.quota : Failure.http(resp.statusCode) }
        if let n = Int(String(decoding: handle, as: UTF8.self)), n < 0 { throw Self.failure(n) }
        guard !handle.isEmpty else { throw Failure.badResponse }
        _ = try await call(["a": "p", "t": dir, "n": [["h": SyncB64.encode(handle), "t": 0,
                                                      "a": MegaCrypto.encryptAttributes(name: segs.last!, key16: aes),
                                                      "k": SyncB64.encode(MegaCrypto.ecbEncrypt(session.masterKey, nodeKey))]]])
    }
}
