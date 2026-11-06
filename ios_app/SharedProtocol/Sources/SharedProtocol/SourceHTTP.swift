import Foundation

/// The guarded HTTP layer for direct reads (design §9, §10): https to four exact hosts, a byte cap, a redirect guard,
/// a per-provider pace, 401 -> one refresh, 429/202 -> Retry-After (at most 2 waits of at most 60 s). GET only.
public typealias SourceTransport = (URLRequest, Int) async throws -> (Data, HTTPURLResponse, Bool)

public enum SourceError: Error, Equatable, Sendable {
    case offline, unreachable, timeout, signedOut, forbidden, notFound, rateLimited(Int), tooLarge, notReady, refusedHost, badResponse, providerError, badQuery
}

final class SourceRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let u = request.url, SourceHTTP.isAllowed(u) else { completionHandler(nil); return }
        var next = request
        // The token never leaves the host it was sent to; Box's pre-signed download URLs need none.
        if u.host != task.originalRequest?.url?.host { next.setValue(nil, forHTTPHeaderField: "Authorization") }
        completionHandler(next)
    }
}

public enum SourceHTTP {
    public static let allowedHosts: Set<String> = ["gitlab.com", "api.box.com", "dl.boxcloud.com", "public.boxcloud.com"]
    public static func isAllowed(_ u: URL) -> Bool {
        u.scheme == "https" && u.user == nil && u.password == nil && (u.port == nil || u.port == 443) && allowedHosts.contains(u.host ?? "")
    }
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    /// encodeURIComponent, stricter: only RFC 3986 unreserved characters stay as they are.
    public static func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "" }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 20
        c.timeoutIntervalForResource = 60
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpCookieStorage = nil
        return URLSession(configuration: c, delegate: SourceRedirectGuard(), delegateQueue: nil)
    }()
    public static let urlSessionTransport: SourceTransport = { req, cap in
        let (bytes, resp) = try await session.bytes(for: req)
        guard let http = resp as? HTTPURLResponse else { throw SourceError.badResponse }
        var data = Data()
        for try await b in bytes {
            if data.count == cap { return (data, http, true) }
            data.append(b)
        }
        return (data, http, false)
    }
    public static func map(_ e: URLError) -> SourceError {
        switch e.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff: return .offline
        case .timedOut: return .timeout
        default: return .unreachable
        }
    }
}

@MainActor
public final class SourceSession {
    public typealias Sleep = (UInt64) async throws -> Void
    let transport: SourceTransport
    let sleep: Sleep
    let nowMs: () -> Int
    let gapMs: Int
    let token: () async throws -> String
    let refresh: () async -> String?
    private var nextAtMs = 0

    public init(perMinute: Int, token: @escaping () async throws -> String, refresh: @escaping () async -> String?,
                transport: @escaping SourceTransport = SourceHTTP.urlSessionTransport,
                sleep: @escaping Sleep = { try await Task.sleep(nanoseconds: $0) },
                nowMs: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }) {
        self.gapMs = max(1, 60_000 / perMinute); self.token = token; self.refresh = refresh
        self.transport = transport; self.sleep = sleep; self.nowMs = nowMs
    }

    public func get(_ url: URL, cap: Int, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse, Bool) {
        guard SourceHTTP.isAllowed(url) else { throw SourceError.refusedHost }
        var refreshed = false
        var waits = 0
        while true {
            let now = nowMs(); let at = max(now, nextAtMs); nextAtMs = at + gapMs
            if at > now { try await sleep(UInt64(at - now) * 1_000_000) }
            let bearer = try await token()
            var req = URLRequest(url: url)
            req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
            let data: Data, resp: HTTPURLResponse, truncated: Bool
            do { (data, resp, truncated) = try await transport(req, cap) } catch let e as URLError { throw SourceHTTP.map(e) }
            if let landed = resp.url, !SourceHTTP.isAllowed(landed) { throw SourceError.refusedHost }
            switch resp.statusCode {
            case 429, 202:
                let sec = min(max(Int(resp.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 2, 1), 60)
                if waits < 2 { waits += 1; try await sleep(UInt64(sec) * 1_000_000_000); continue }
                throw resp.statusCode == 202 ? SourceError.notReady : SourceError.rateLimited(sec)
            case 200..<300: return (data, resp, truncated)
            case 401 where !refreshed:
                refreshed = true
                guard await refresh() != nil else { throw SourceError.signedOut }
                continue
            case 401: throw SourceError.signedOut
            case 403: throw SourceError.forbidden
            case 404: throw SourceError.notFound
            case 300..<400: throw SourceError.refusedHost
            default: throw SourceError.providerError
            }
        }
    }
}

public struct SourceProjectRef: Hashable, Sendable { public let id: Int; public let ref: String; public let webURL: URL }

public struct SourceEntry: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable { case project, dir, file }
    public let id: String
    public let name: String
    public let kind: Kind
    public let path: String
    public let size: Int?
    public let detail: String?
    public let project: SourceProjectRef?
    public init(id: String, name: String, kind: Kind, path: String, size: Int?, detail: String?, project: SourceProjectRef?) {
        self.id = id; self.name = name; self.kind = kind; self.path = path; self.size = size; self.detail = detail; self.project = project
    }
}

public struct SourcePage: Sendable { public let entries: [SourceEntry]; public let next: String? }

public enum SourcePreviewKind: String, Sendable { case text, markdown, pdf, extracted, unsupported }

public struct SourceOpened: Sendable {
    public enum Reason: String, Sendable { case binary, type, tooLarge, noText }
    public let entry: SourceEntry
    public let kind: SourcePreviewKind
    public let language: String
    public let text: String?
    public let data: Data?
    public let truncated: Bool
    public let webURL: URL?
    public let reason: Reason?
    public init(entry: SourceEntry, kind: SourcePreviewKind, language: String, text: String?, data: Data?, truncated: Bool, webURL: URL?, reason: Reason?) {
        self.entry = entry; self.kind = kind; self.language = language; self.text = text; self.data = data
        self.truncated = truncated; self.webURL = webURL; self.reason = reason
    }
}

@MainActor
public protocol SourceReadClient: AnyObject {
    var provider: SourceProvider { get }
    func list(_ dir: SourceEntry?, cursor: String?) async throws -> SourcePage
    func open(_ file: SourceEntry) async throws -> SourceOpened
    func search(_ q: String, within: SourceEntry?) async throws -> SourcePage
    func webURL(_ e: SourceEntry) -> URL?
}

/// How a file is shown on iOS (decision D2): text (code included, HTML as source), PDF in PDFKit, Office files via
/// Box's extracted text, everything else "not shown". Markdown is shown as its source text on iOS.
public enum SourcePreview {
    public static let textCap = 1_048_576, extractedCap = 2_097_152, pdfCap = 20_971_520, jsonCap = 2_097_152
    static let extractExt: Set<String> = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key"]
    static let binaryExt: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff", "ico", "zip", "gz", "tgz", "tar", "7z", "rar", "jar", "war",
        "mp3", "mp4", "mov", "wav", "m4a", "avi", "mkv", "woff", "woff2", "ttf", "otf", "eot", "exe", "dll", "so", "dylib", "bin", "dmg", "iso",
        "class", "o", "a", "wasm", "pyc", "sqlite", "db"]

    public static func kind(_ name: String, provider: SourceProvider) -> (SourcePreviewKind, String) {
        let lower = name.lowercased()
        let ext = lower.lastIndex(of: ".").map { String(lower[lower.index(after: $0)...]) } ?? ""
        if ext == "pdf" { return (.pdf, "PDF") }
        if extractExt.contains(ext) { return (provider == .box ? .extracted : .unsupported, ext.uppercased()) }
        if binaryExt.contains(ext) { return (.unsupported, ext.uppercased()) }
        if ["md", "markdown", "mdx"].contains(ext) { return (.markdown, "Markdown") }
        return (.text, ext.isEmpty ? "Text" : ext.uppercased())
    }
    /// nil when the first 8 KiB hold a NUL byte (binary).
    public static func decodeText(_ d: Data) -> String? { d.prefix(8192).contains(0) ? nil : String(decoding: d, as: UTF8.self) }
    public static func query(_ q: String) throws -> String {
        let t = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...200).contains(t.count) else { throw SourceError.badQuery }
        return t
    }
    public static func dedupe(_ es: [SourceEntry]) -> [SourceEntry] { var seen = Set<String>(); return es.filter { seen.insert($0.id).inserted } }

    public static func load(_ e: SourceEntry, kind: SourcePreviewKind, language: String, webURL: URL?,
                            fetch: (Int) async throws -> (Data, HTTPURLResponse, Bool)) async throws -> SourceOpened {
        func out(_ k: SourcePreviewKind, text: String? = nil, data: Data? = nil, truncated: Bool = false, reason: SourceOpened.Reason? = nil) -> SourceOpened {
            SourceOpened(entry: e, kind: k, language: language, text: text, data: data, truncated: truncated, webURL: webURL, reason: reason)
        }
        if kind == .unsupported { return out(.unsupported, reason: .type) }
        if kind == .pdf {
            let (d, _, t) = try await fetch(pdfCap)
            return t ? out(.pdf, reason: .tooLarge) : out(.pdf, data: d)
        }
        let (d, _, t) = try await fetch(kind == .extracted ? extractedCap : textCap)
        guard let text = decodeText(d) else { return out(.unsupported, reason: .binary) }
        return out(kind, text: text, truncated: t)
    }
}
