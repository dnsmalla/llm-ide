import Foundation

/// A minimal Box API client for the sync folder (design §8.2, SP6; no SDK). The user's OWN Box app (client id + secret
/// from the pairing QR, SP6 D2). Box refresh tokens are single use, so every rotation is reported through `onTokens`
/// before the new access token is used (the app saves it in the Keychain). HTTPS only; creates only new files; never
/// deletes. PKCE is sent on authorize and exchange (undocumented by Box: accepted or ignored).
@MainActor
public final class BoxClient: SyncRemoteStore {
    public struct App: Codable, Equatable, Sendable {
        public var clientId: String; public var clientSecret: String
        public init(clientId: String, clientSecret: String) { self.clientId = clientId; self.clientSecret = clientSecret }
    }
    public struct Tokens: Codable, Equatable, Sendable {
        public var access: String; public var refresh: String
        public init(access: String, refresh: String) { self.access = access; self.refresh = refresh }
    }
    public enum Failure: Error, Equatable, Sendable { case authFailed, badClient, rateLimited, quota, tooLarge, missing, badResponse, http(Int) }
    public typealias Transport = (URLRequest) async throws -> (Data, HTTPURLResponse)

    public static let redirectURI = "llmide-box://oauth"
    static let api = "https://api.box.com/2.0"
    static let uploadURL = URL(string: "https://upload.box.com/api/2.0/files/content")!
    static let tokenURL = URL(string: "https://api.box.com/oauth2/token")!
    static let revokeURL = URL(string: "https://api.box.com/oauth2/revoke")!
    static let authorizeBase = URL(string: "https://account.box.com/api/oauth2/authorize")!

    /// URLSession follows Box's download redirect itself; this keeps it on https and drops the bearer off the API host.
    nonisolated static func redirected(_ req: URLRequest, from original: URLRequest?) -> URLRequest? {
        guard req.url?.scheme == "https" else { return nil }
        var next = req
        if req.url?.host != original?.url?.host { next.setValue(nil, forHTTPHeaderField: "Authorization") }
        return next
    }
    final class RedirectGuard: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? {
            BoxClient.redirected(request, from: task.originalRequest)
        }
    }
    private static let urlSession = URLSession(configuration: .ephemeral)
    private static let redirectGuard = RedirectGuard()
    public static let urlSessionTransport: Transport = { request in
        let (data, response) = try await urlSession.data(for: request, delegate: redirectGuard)
        guard let http = response as? HTTPURLResponse else { throw Failure.badResponse }
        return (data, http)
    }

    public let folder: String
    public let app: App
    public private(set) var tokens: Tokens
    public var onTokens: ((Tokens) -> Void)?
    private let transport: Transport
    private var ids: [String: String] = [:]  // folder path below the sync folder ("" = the sync folder) -> Box id

    public init(folder: String, app: App, tokens: Tokens, transport: @escaping Transport = BoxClient.urlSessionTransport) {
        self.folder = folder; self.app = app; self.tokens = tokens; self.transport = transport
    }

    public static func pkce() -> (verifier: String, challenge: String) {
        let v = SyncB64.encode(SyncCrypto.randomBytes(32))
        return (v, SyncB64.encode(SyncCrypto.sha256(Data(v.utf8))))
    }
    public static func authorizeURL(app: App, state: String, challenge: String, redirectURI: String = BoxClient.redirectURI) -> URL {
        var c = URLComponents(url: authorizeBase, resolvingAgainstBaseURL: false)!
        c.percentEncodedQuery = String(decoding: form([("response_type", "code"), ("client_id", app.clientId), ("redirect_uri", redirectURI),
                                                        ("state", state), ("code_challenge", challenge), ("code_challenge_method", "S256")]), as: UTF8.self)
        return c.url!
    }
    static func form(_ items: [(String, String)]) -> Data {
        let ok = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return Data(items.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: ok) ?? "")" }.joined(separator: "&").utf8)
    }
    static func token(_ items: [(String, String)], app: App, transport: Transport) async throws -> Tokens {
        var req = URLRequest(url: tokenURL); req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = form(items + [("client_id", app.clientId), ("client_secret", app.clientSecret)])
        let (data, resp) = try await transport(req)
        if resp.statusCode == 429 { throw Failure.rateLimited }
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard resp.statusCode == 200, let a = j["access_token"] as? String, let r = j["refresh_token"] as? String else {
            throw (j["error"] as? String) == "invalid_client" ? Failure.badClient : Failure.authFailed
        }
        return Tokens(access: a, refresh: r)
    }
    public static func exchange(code: String, verifier: String, app: App, redirectURI: String = BoxClient.redirectURI,
                                transport: @escaping Transport = BoxClient.urlSessionTransport) async throws -> Tokens {
        try await token([("grant_type", "authorization_code"), ("code", code), ("redirect_uri", redirectURI), ("code_verifier", verifier)], app: app, transport: transport)
    }

    private func send(_ build: () -> URLRequest) async throws -> (Data, HTTPURLResponse) {
        var refreshed = false
        while true {
            var req = build()
            req.setValue("Bearer \(tokens.access)", forHTTPHeaderField: "Authorization")
            let (data, resp) = try await transport(req)
            if resp.statusCode == 401, !refreshed {
                refreshed = true
                tokens = try await Self.token([("grant_type", "refresh_token"), ("refresh_token", tokens.refresh)], app: app, transport: transport)
                onTokens?(tokens)  // single use: saved before the new access token is used
                continue
            }
            if resp.statusCode == 401 { throw Failure.authFailed }
            if resp.statusCode == 429 { throw Failure.rateLimited }
            return (data, resp)
        }
    }
    private func items(_ id: String) async throws -> [[String: Any]]? {
        let (data, resp) = try await send { URLRequest(url: URL(string: "\(Self.api)/folders/\(id)/items?fields=id,name,type,size&limit=1000")!) }
        if resp.statusCode == 404 { return nil }
        guard resp.statusCode == 200, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.http(resp.statusCode) }
        return j["entries"] as? [[String: Any]] ?? []
    }
    private func mkdir(_ parent: String, _ name: String) async throws -> String {
        let (data, resp) = try await send {
            var r = URLRequest(url: URL(string: "\(Self.api)/folders")!); r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name, "parent": ["id": parent]])
            return r
        }
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if (200...201).contains(resp.statusCode), let id = j["id"] as? String { return id }
        let c = (j["context_info"] as? [String: Any])?["conflicts"]
        if resp.statusCode == 409, let id = ((c as? [[String: Any]])?.first?["id"] ?? (c as? [String: Any])?["id"]) as? String { return id }
        throw Failure.http(resp.statusCode)
    }
    /// Folders below the sync folder; segments at index >= createFrom may be created, the rest must exist.
    private func walk(_ segs: [String], createFrom: Int) async throws -> String? {
        var id = ids[""]
        if id == nil {
            guard let f = try await items("0")?.first(where: { $0["type"] as? String == "folder" && $0["name"] as? String == folder }),
                  let fid = f["id"] as? String else { return nil }  // the desktop creates the sync folder; a device never does
            id = fid; ids[""] = fid
        }
        var key = ""
        for (i, name) in segs.enumerated() {
            key = key.isEmpty ? name : "\(key)/\(name)"
            if let known = ids[key] { id = known; continue }
            guard let kids = try await items(id!) else { ids.removeAll(); return nil }
            let next: String
            if let f = kids.first(where: { $0["type"] as? String == "folder" && $0["name"] as? String == name }), let fid = f["id"] as? String { next = fid }
            else if i >= createFrom { next = try await mkdir(id!, name) }
            else { return nil }
            ids[key] = next; id = next
        }
        return id
    }

    public func get(_ path: String) async throws -> Data? {
        let segs = try SyncPath.check(path)
        guard let dir = try await walk(Array(segs.dropLast()), createFrom: .max), let kids = try await items(dir) else { return nil }
        guard let f = kids.first(where: { $0["type"] as? String == "file" && $0["name"] as? String == segs.last }), let fid = f["id"] as? String else { return nil }
        if (f["size"] as? Int ?? 0) > SyncPath.maxFileBytes { throw Failure.tooLarge }
        let (data, resp) = try await send { URLRequest(url: URL(string: "\(Self.api)/files/\(fid)/content")!) }
        if resp.statusCode == 404 { return nil }
        guard resp.statusCode == 200 else { throw Failure.http(resp.statusCode) }
        guard data.count <= SyncPath.maxFileBytes else { throw Failure.tooLarge }
        return data
    }

    public func put(_ path: String, _ bytes: Data, createFolders: Int) async throws {
        let segs = try SyncPath.check(path)
        guard bytes.count <= SyncPath.maxFileBytes else { throw Failure.tooLarge }
        guard let dir = try await walk(Array(segs.dropLast()), createFrom: createFolders) else { throw Failure.missing }
        let boundary = "llmide\(SyncB64.encode(SyncCrypto.randomBytes(12)).replacingOccurrences(of: "-", with: "x").replacingOccurrences(of: "_", with: "x"))"
        let attrs = String(decoding: try JSONSerialization.data(withJSONObject: ["name": segs.last!, "parent": ["id": dir]]), as: UTF8.self)
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"attributes\"\r\n\r\n\(attrs)\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"blob\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8)
        body.append(bytes); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let (data, resp) = try await send {
            var r = URLRequest(url: Self.uploadURL); r.httpMethod = "POST"
            r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type"); r.httpBody = body
            return r
        }
        if (200...201).contains(resp.statusCode) || resp.statusCode == 409 { return }  // 409: a retry of a write that landed
        if resp.statusCode == 404 { ids.removeAll(); throw Failure.missing }
        let code = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["code"] as? String
        throw code == "storage_limit_exceeded" ? Failure.quota : Failure.http(resp.statusCode)
    }

    /// Ends this device's Box session (Remove from this iPhone).
    public func revoke() async {
        var req = URLRequest(url: Self.revokeURL); req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Self.form([("client_id", app.clientId), ("client_secret", app.clientSecret), ("token", tokens.refresh)])
        _ = try? await transport(req)
    }
}
