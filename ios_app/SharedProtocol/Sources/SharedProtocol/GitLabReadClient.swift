import Foundation

/// GitLab code at the source (design §9, Q12): member projects, repository tree, one raw file, blob search.
/// gitlab.com only (decision D1). The app creates it with SourceSession(perMinute: 60): the Free burst is 100/min.
@MainActor
public final class GitLabReadClient: SourceReadClient {
    public let provider = SourceProvider.gitlab
    static let api = "https://gitlab.com/api/v4"
    let http: SourceSession
    public init(session: SourceSession) { http = session }

    func array(_ s: String) async throws -> ([[String: Any]], String?) {
        guard let url = URL(string: s) else { throw SourceError.badResponse }
        let (data, resp, truncated) = try await http.get(url, cap: SourcePreview.jsonCap)
        if truncated { throw SourceError.tooLarge }
        guard let arr = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else { throw SourceError.badResponse }
        let n = resp.value(forHTTPHeaderField: "X-Next-Page") ?? ""
        return (arr.compactMap { $0 as? [String: Any] }, n.range(of: #"^\d{1,6}$"#, options: .regularExpression) != nil ? n : nil)
    }
    static func str(_ v: Any?, _ max: Int = 1024) -> String? { (v as? String).flatMap { !$0.isEmpty && $0.count <= max ? $0 : nil } }
    static func project(_ o: [String: Any]) -> SourceEntry? {
        guard let id = o["id"] as? Int, id > 0, let path = str(o["path_with_namespace"]), let name = str(o["name"], 255),
              let web = str(o["web_url"]).flatMap(URL.init(string:)), web.scheme == "https", web.host == "gitlab.com" else { return nil }
        let ref = str(o["default_branch"], 255) ?? ""
        return SourceEntry(id: "p\(id)", name: name, kind: .project, path: path, size: nil, detail: ref.isEmpty ? "Empty project" : nil,
                           project: SourceProjectRef(id: id, ref: ref, webURL: web))
    }
    func projects(_ query: String?, page: String) async throws -> SourcePage {
        var s = "\(Self.api)/projects?membership=true&simple=true&archived=false&order_by=last_activity_at&per_page=50&page=\(page)"
        if let query { s += "&search=\(SourceHTTP.enc(query))" }
        let (items, next) = try await array(s)
        return SourcePage(entries: SourcePreview.dedupe(items.compactMap(Self.project)), next: next)
    }
    static func file(_ p: SourceProjectRef, _ path: String, kind: SourceEntry.Kind, detail: String? = nil) -> SourceEntry {
        SourceEntry(id: "\(p.id):\(path)", name: String(path.split(separator: "/").last ?? Substring(path)), kind: kind, path: path, size: nil, detail: detail, project: p)
    }

    public func list(_ dir: SourceEntry?, cursor: String?) async throws -> SourcePage {
        let page = cursor.flatMap { $0.range(of: #"^\d{1,6}$"#, options: .regularExpression) != nil ? $0 : nil } ?? "1"
        guard let dir else { return try await projects(nil, page: page) }
        guard let p = dir.project else { throw SourceError.badResponse }
        if p.ref.isEmpty { return SourcePage(entries: [], next: nil) }
        var s = "\(Self.api)/projects/\(p.id)/repository/tree?ref=\(SourceHTTP.enc(p.ref))&per_page=100&page=\(page)"
        if dir.kind == .dir { s += "&path=\(SourceHTTP.enc(dir.path))" }
        let (items, next) = try await array(s)
        // "commit" rows are submodules: another repository, not shown.
        let entries = items.compactMap { o -> SourceEntry? in
            guard let path = Self.str(o["path"]), let type = o["type"] as? String, type == "tree" || type == "blob" else { return nil }
            return Self.file(p, path, kind: type == "tree" ? .dir : .file)
        }
        return SourcePage(entries: entries, next: next)
    }

    public func open(_ file: SourceEntry) async throws -> SourceOpened {
        guard let p = file.project,
              let url = URL(string: "\(Self.api)/projects/\(p.id)/repository/files/\(SourceHTTP.enc(file.path))/raw?ref=\(SourceHTTP.enc(p.ref))") else { throw SourceError.badResponse }
        let (kind, lang) = SourcePreview.kind(file.name, provider: .gitlab)
        return try await SourcePreview.load(file, kind: kind, language: lang, webURL: webURL(file)) { cap in try await self.http.get(url, cap: cap) }
    }

    public func search(_ q: String, within: SourceEntry?) async throws -> SourcePage {
        let t = try SourcePreview.query(q)
        guard let p = within?.project else { return try await projects(t, page: "1") }
        if p.ref.isEmpty { return SourcePage(entries: [], next: nil) }
        let (items, _) = try await array("\(Self.api)/projects/\(p.id)/search?scope=blobs&search=\(SourceHTTP.enc(t))&ref=\(SourceHTTP.enc(p.ref))&per_page=20")
        let entries = items.compactMap { o -> SourceEntry? in
            guard let path = Self.str(o["path"]) ?? Self.str(o["filename"]) else { return nil }
            return Self.file(p, path, kind: .file, detail: (o["data"] as? String).map { String($0.prefix(300)) })
        }
        return SourcePage(entries: SourcePreview.dedupe(entries), next: nil)
    }

    public func webURL(_ e: SourceEntry) -> URL? {
        guard let p = e.project else { return nil }
        if e.kind == .project { return p.webURL }
        let path = e.path.split(separator: "/").map { SourceHTTP.enc(String($0)) }.joined(separator: "/")
        return URL(string: "\(p.webURL.absoluteString)/-/\(e.kind == .dir ? "tree" : "blob")/\(SourceHTTP.enc(p.ref))/\(path)")
    }
}
