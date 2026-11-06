import Foundation
@testable import SharedProtocol

/// A fake Box API for BoxClient tests (no network): token (single-use refresh), folders, multipart upload, content with a
/// download redirect, revoke. Mirrors extension/tests/helpers/fake-box.mjs closely enough for the device's calls.
@MainActor
final class FakeBoxServer {
    struct Node { var id: String; var type: String; var name: String; var parent: String?; var data = Data() }
    let app = BoxClient.App(clientId: "cid0123456789abcdef", clientSecret: "csec0123456789abcdef")
    var nodes: [String: Node] = ["0": Node(id: "0", type: "folder", name: "All Files", parent: nil)]
    var access: Set<String> = []; var refresh: Set<String> = []; var codes: Set<String> = []
    var uploads = 0; var revoked: [String] = []; var failNext: [String: Int] = [:]; var bearerAtDownload = false
    var refreshCalls = 0
    /// Awaited inside a token call before it answers (lets a test act while a refresh is in flight).
    var tokenGate: (() async -> Void)?
    private var n = 100
    private func next() -> String { n += 1; return String(n) }

    var transport: BoxClient.Transport { { [unowned self] req in try await self.handle(req) } }
    func issueCode() -> String { let c = "code\(next())"; codes.insert(c); return c }
    func grant() -> BoxClient.Tokens { let t = BoxClient.Tokens(access: "at\(next())", refresh: "rt\(next())"); access.insert(t.access); refresh.insert(t.refresh); return t }
    func children(_ id: String) -> [Node] { nodes.values.filter { $0.parent == id }.sorted { $0.id < $1.id } }
    @discardableResult func mkdirs(_ path: String) -> String {
        var cur = "0"
        for name in path.split(separator: "/").map(String.init) {
            if let c = children(cur).first(where: { $0.name == name && $0.type == "folder" }) { cur = c.id; continue }
            let id = next(); nodes[id] = Node(id: id, type: "folder", name: name, parent: cur); cur = id
        }
        return cur
    }
    func seed(_ path: String, _ data: Data) {
        let parts = path.split(separator: "/").map(String.init)
        let dir = mkdirs(parts.dropLast().joined(separator: "/"))
        let id = next(); nodes[id] = Node(id: id, type: "file", name: parts.last!, parent: dir, data: data)
    }

    private func reply(_ body: Any, _ status: Int = 200, _ headers: [String: String] = [:]) -> (Data, HTTPURLResponse) {
        let data = (body as? Data) ?? (try! JSONSerialization.data(withJSONObject: body))
        return (data, HTTPURLResponse(url: URL(string: "https://api.box.com")!, statusCode: status, httpVersion: nil, headerFields: headers)!)
    }
    private func form(_ req: URLRequest) -> [String: String] {
        var out: [String: String] = [:]
        for kv in String(decoding: req.httpBody ?? Data(), as: UTF8.self).split(separator: "&") {
            let p = kv.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? "" }
            out[p[0]] = p.count > 1 ? p[1] : ""
        }
        return out
    }
    private func entry(_ x: Node) -> [String: Any] { ["type": x.type, "id": x.id, "name": x.name, "size": x.data.count] }

    func handle(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        await Task.yield()  // a real request suspends; let concurrent callers interleave
        let url = req.url!, path = url.path, method = req.httpMethod ?? "GET"
        if let s = failNext.removeValue(forKey: "\(method) \(path)") { return reply(["code": "injected"], s, ["retry-after": "30"]) }
        if path == "/oauth2/token" {
            let f = form(req)
            guard f["client_id"] == app.clientId, f["client_secret"] == app.clientSecret else { return reply(["error": "invalid_client"], 400) }
            if f["grant_type"] == "refresh_token" { refreshCalls += 1 }
            let ok = f["grant_type"] == "authorization_code" ? codes.remove(f["code"] ?? "") != nil : refresh.remove(f["refresh_token"] ?? "") != nil
            guard ok else { return reply(["error": "invalid_grant"], 400) }
            if let g = tokenGate { await g() }  // the grant is spent; the answer is still on its way
            let t = grant(); return reply(["access_token": t.access, "refresh_token": t.refresh])
        }
        if path == "/oauth2/revoke" { let t = form(req)["token"] ?? ""; revoked.append(t); refresh.remove(t); return reply([:]) }
        if url.host == "dl.boxcloud.com" {
            if req.value(forHTTPHeaderField: "Authorization") != nil { bearerAtDownload = true }
            return reply(nodes[url.lastPathComponent]?.data ?? Data())
        }
        guard let b = req.value(forHTTPHeaderField: "Authorization")?.replacingOccurrences(of: "Bearer ", with: ""), access.contains(b) else { return reply(["code": "unauthorized"], 401) }
        let parts = path.split(separator: "/").map(String.init)
        if method == "GET", parts.count == 4, parts[1] == "folders", parts[3] == "items" {
            guard nodes[parts[2]]?.type == "folder" else { return reply(["code": "not_found"], 404) }
            return reply(["entries": children(parts[2]).map(entry)])
        }
        if method == "POST", path == "/2.0/folders" {
            let j = try JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as! [String: Any]
            let name = j["name"] as! String, parent = (j["parent"] as! [String: Any])["id"] as! String
            if let dup = children(parent).first(where: { $0.name == name }) { return reply(["code": "item_name_in_use", "context_info": ["conflicts": [entry(dup)]]], 409) }
            let id = next(); nodes[id] = Node(id: id, type: "folder", name: name, parent: parent); return reply(entry(nodes[id]!), 201)
        }
        if method == "POST", url.host == "upload.box.com" {
            let body = req.httpBody ?? Data()
            let text = String(decoding: body, as: UTF8.self)
            let attrs = text.components(separatedBy: "name=\"attributes\"\r\n\r\n")[1].components(separatedBy: "\r\n--")[0]
            let j = try JSONSerialization.jsonObject(with: Data(attrs.utf8)) as! [String: Any]
            let marker = Data("Content-Type: application/octet-stream\r\n\r\n".utf8)
            let start = body.range(of: marker)!.upperBound
            let end = body.range(of: Data("\r\n--".utf8), options: .backwards)!.lowerBound
            let name = j["name"] as! String, parent = (j["parent"] as! [String: Any])["id"] as! String
            if let dup = children(parent).first(where: { $0.name == name }) { return reply(["code": "item_name_in_use", "context_info": ["conflicts": entry(dup)]], 409) }
            let id = next(); nodes[id] = Node(id: id, type: "file", name: name, parent: parent, data: body.subdata(in: start..<end)); uploads += 1
            return reply(["entries": [entry(nodes[id]!)]], 201)
        }
        if method == "GET", parts.count == 4, parts[1] == "files", parts[3] == "content" {
            guard nodes[parts[2]] != nil else { return reply(["code": "not_found"], 404) }
            // URLSession follows redirects itself, and SourceRedirectGuard drops the bearer on the hop to another host.
            return try await handle(URLRequest(url: URL(string: "https://dl.boxcloud.com/d/1/\(parts[2])")!))
        }
        return reply(["code": "not_found"], 404)
    }
}
