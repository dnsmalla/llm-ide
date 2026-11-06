import Foundation

/// Box documents at the source (design §9, Q11): folder items, content or extracted text, search. root_readonly only.
/// The app creates it with SourceSession(perMinute: 240). Shapes follow extension/connectors/box.mjs.
@MainActor
public final class BoxReadClient: SourceReadClient {
    public let provider = SourceProvider.box
    static let api = "https://api.box.com/2.0"
    static let fields = "id,type,name,size,modified_at,extension"
    static let page = 100
    let http: SourceSession
    let pollSleep: SourceSession.Sleep
    public init(session: SourceSession, pollSleep: @escaping SourceSession.Sleep = { try await Task.sleep(nanoseconds: $0) }) {
        http = session; self.pollSleep = pollSleep
    }

    static func validId(_ id: String) -> Bool { id.range(of: #"^\d{1,20}$"#, options: .regularExpression) != nil }
    func object(_ s: String, headers: [String: String] = [:]) async throws -> [String: Any] {
        guard let url = URL(string: s) else { throw SourceError.badResponse }
        let (data, _, truncated) = try await http.get(url, cap: SourcePreview.jsonCap, headers: headers)
        if truncated { throw SourceError.tooLarge }
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw SourceError.badResponse }
        return o
    }
    static func entry(_ o: [String: Any], parentPath: String) -> SourceEntry? {
        guard let type = o["type"] as? String, type == "file" || type == "folder", let id = o["id"] as? String, validId(id),
              let name = o["name"] as? String, !name.isEmpty, name.count <= 255 else { return nil }
        let size = (o["size"] as? Int).flatMap { $0 >= 0 ? $0 : nil }
        return SourceEntry(id: id, name: name, kind: type == "folder" ? .dir : .file, path: parentPath.isEmpty ? name : "\(parentPath)/\(name)",
                           size: size, detail: nil, project: nil)
    }

    public func list(_ dir: SourceEntry?, cursor: String?) async throws -> SourcePage {
        let offset = cursor.flatMap { $0.range(of: #"^\d{1,7}$"#, options: .regularExpression) != nil ? Int($0) : nil } ?? 0
        let id = dir?.id ?? "0"
        guard Self.validId(id) else { throw SourceError.badResponse }
        let o = try await object("\(Self.api)/folders/\(id)/items?fields=\(Self.fields)&limit=\(Self.page)&offset=\(offset)")
        let raw = o["entries"] as? [[String: Any]] ?? []
        // Page length is the end signal (box.mjs B4): total_count can be missing.
        return SourcePage(entries: raw.compactMap { Self.entry($0, parentPath: dir?.path ?? "") }, next: raw.count == Self.page ? String(offset + Self.page) : nil)
    }

    func extractedTextURL(_ id: String) async throws -> URL? {
        let o = try await object("\(Self.api)/files/\(id)?fields=representations", headers: ["X-Rep-Hints": "[extracted_text]"])
        let reps = (o["representations"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []
        guard let rep = reps.first(where: { $0["representation"] as? String == "extracted_text" }) else { return nil }
        var state = (rep["status"] as? [String: Any])?["state"] as? String
        var template = (rep["content"] as? [String: Any])?["url_template"] as? String
        let info = (rep["info"] as? [String: Any])?["url"] as? String
        var tries = 0
        while state == "pending" || state == "none", let info, tries < 3 {
            tries += 1
            try await pollSleep(1_500_000_000)
            let p = try await object(info)
            state = (p["status"] as? [String: Any])?["state"] as? String
            template = ((p["content"] as? [String: Any])?["url_template"] as? String) ?? template
        }
        guard state == "success", let t = template else { return nil }
        return URL(string: t.replacingOccurrences(of: "{+asset_path}", with: ""))
    }

    public func open(_ file: SourceEntry) async throws -> SourceOpened {
        guard Self.validId(file.id) else { throw SourceError.badResponse }
        let (kind, lang) = SourcePreview.kind(file.name, provider: .box)
        let web = webURL(file)
        if kind == .extracted {
            guard let url = try await extractedTextURL(file.id) else {
                return SourceOpened(entry: file, kind: .unsupported, language: lang, text: nil, data: nil, truncated: false, webURL: web, reason: .noText)
            }
            return try await SourcePreview.load(file, kind: kind, language: lang, webURL: web) { cap in try await self.http.get(url, cap: cap) }
        }
        let url = URL(string: "\(Self.api)/files/\(file.id)/content")!
        return try await SourcePreview.load(file, kind: kind, language: lang, webURL: web) { cap in try await self.http.get(url, cap: cap) }
    }

    public func search(_ q: String, within: SourceEntry?) async throws -> SourcePage {
        let t = try SourcePreview.query(q)
        var s = "\(Self.api)/search?query=\(SourceHTTP.enc(t))&type=file&limit=20&fields=\(Self.fields),path_collection"
        if let w = within, w.kind == .dir { guard Self.validId(w.id) else { throw SourceError.badResponse }; s += "&ancestor_folder_ids=\(w.id)" }
        let raw = try await object(s)["entries"] as? [[String: Any]] ?? []
        let entries = raw.compactMap { e -> SourceEntry? in
            let parents = ((e["path_collection"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }.filter { $0 != "All Files" }
            return Self.entry(e, parentPath: parents.joined(separator: "/"))
        }
        return SourcePage(entries: SourcePreview.dedupe(entries), next: nil)
    }

    public func webURL(_ e: SourceEntry) -> URL? { URL(string: "https://app.box.com/\(e.kind == .dir ? "folder" : "file")/\(e.id)") }
}
