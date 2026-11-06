import Foundation

/// The user's own sync server (design §8.1): plain HTTPS GET/PUT to `https://<host>/sync/<path>`. nginx serves only this
/// device's folder, and the random folder names in the path are the capability, so there is no login. No cookies, no
/// cache, redirects refused. `createFolders` is ignored: the desktop creates every folder a device writes into.
@MainActor
public final class SyncHttpsClient: SyncRemoteStore {
    public enum Failure: Error, Equatable, Sendable { case rateLimited, tooLarge, missing, badHost, http(Int) }
    public typealias Transport = (URLRequest) async throws -> (Data, HTTPURLResponse)
    static let putMax = 65_536  // nginx client_max_body_size 64k

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    private static let urlSession: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 30; c.timeoutIntervalForResource = 60
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        return URLSession(configuration: c, delegate: NoRedirect(), delegateQueue: nil)
    }()
    public static let urlSessionTransport: Transport = { request in
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.http(0) }
        return (data, http)
    }

    public let host: String
    private let transport: Transport

    public init(host: String, transport: @escaping Transport = SyncHttpsClient.urlSessionTransport) throws {
        guard SyncEnroll.isOwnServerHost(host) else { throw Failure.badHost }
        self.host = host; self.transport = transport
    }

    static func failure(_ status: Int) -> Failure {
        switch status {
        case 429, 503: return .rateLimited
        case 413: return .tooLarge
        case 409: return .missing
        default: return .http(status)
        }
    }
    private func request(_ segs: [String], _ method: String) -> URLRequest {
        var r = URLRequest(url: URL(string: "https://\(host)/sync/\(segs.joined(separator: "/"))")!)
        r.httpMethod = method
        return r
    }

    public func get(_ path: String) async throws -> Data? {
        let segs = try SyncPath.check(path)
        let (data, resp) = try await transport(request(segs, "GET"))
        if resp.statusCode == 404 { return nil }
        guard resp.statusCode == 200 else { throw Self.failure(resp.statusCode) }
        guard data.count <= SyncPath.maxFileBytes else { throw Failure.tooLarge }
        return data
    }

    public func put(_ path: String, _ bytes: Data, createFolders: Int) async throws {
        let segs = try SyncPath.check(path)
        guard bytes.count <= Self.putMax else { throw Failure.tooLarge }
        var r = request(segs, "PUT")
        r.httpBody = bytes
        let (_, resp) = try await transport(r)
        guard resp.statusCode == 201 || resp.statusCode == 204 else { throw Self.failure(resp.statusCode) }
    }
}
