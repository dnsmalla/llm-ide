import Foundation
@testable import SharedProtocol

/// Fake gitlab.com and Box APIs behind one SourceTransport (no network), mirroring web/tests/helpers/fake-sources.mjs.
@MainActor
final class FakeSourceServer {
    var tokens = ["gitlab": "gitlab-access-1", "box": "box-access-1"]
    var requests: [URLRequest] = []
    var canned: [(prefix: String, status: Int, headers: [String: String])] = []
    var transport: SourceTransport { { [unowned self] req, cap in await self.handle(req, cap) } }
    let rep = "https://dl.boxcloud.com/api/2.0/internal_files/22/versions/1/representations/extracted_text/content/{+asset_path}"

    func reply(_ url: URL, _ status: Int, _ body: Data, _ headers: [String: String] = [:], _ cap: Int) -> (Data, HTTPURLResponse, Bool) {
        (Data(body.prefix(cap)), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)!, body.count > cap)
    }
    func json(_ url: URL, _ o: Any, _ cap: Int, _ status: Int = 200, _ headers: [String: String] = [:]) -> (Data, HTTPURLResponse, Bool) {
        reply(url, status, try! JSONSerialization.data(withJSONObject: o), headers, cap)
    }

    func handle(_ req: URLRequest, _ cap: Int) -> (Data, HTTPURLResponse, Bool) {
        requests.append(req)
        let url = req.url!
        if let i = canned.firstIndex(where: { url.absoluteString.hasPrefix($0.prefix) }) { let c = canned.remove(at: i); return reply(url, c.status, Data(), c.headers, cap) }
        let host = url.host ?? ""
        let provider = host == "gitlab.com" ? "gitlab" : "box"
        guard req.value(forHTTPHeaderField: "Authorization") == "Bearer \(tokens[provider]!)" else { return json(url, ["message": "401"], cap, 401) }
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)!.percentEncodedPath
        let q = Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        let project: [String: Any] = ["id": 7, "name": "demo", "path_with_namespace": "dee/demo", "default_branch": "main", "web_url": "https://gitlab.com/dee/demo"]
        switch (host, path) {
        case ("gitlab.com", "/api/v4/projects"):
            let all: [[String: Any]] = [project, ["id": 8, "name": "empty", "path_with_namespace": "dee/empty", "web_url": "https://gitlab.com/dee/empty"], ["id": "bad"]]
            return json(url, q["search"].map { s in all.filter { ($0["name"] as? String)?.contains(s) == true } } ?? all, cap, 200, ["X-Next-Page": ""])
        case ("gitlab.com", "/api/v4/projects/7/repository/tree"):
            if q["path"] == "src" { return json(url, [["name": "app.ts", "type": "blob", "path": "src/app.ts"]], cap) }
            return json(url, [["name": "src", "type": "tree", "path": "src"], ["name": "README.md", "type": "blob", "path": "README.md"], ["name": "vendor", "type": "commit", "path": "vendor"]], cap, 200, ["X-Next-Page": "2"])
        case ("gitlab.com", "/api/v4/projects/7/repository/files/src%2Fapp.ts/raw"): return reply(url, 200, Data("export const x = 1;\n".utf8), [:], cap)
        case ("gitlab.com", "/api/v4/projects/7/repository/files/logo.bin/raw"): return reply(url, 200, Data([1, 0, 2]), [:], cap)
        case ("gitlab.com", "/api/v4/projects/7/repository/files/big.txt/raw"): return reply(url, 200, Data(repeating: 97, count: SourcePreview.textCap + 5), [:], cap)
        case ("gitlab.com", "/api/v4/projects/7/search"):
            return json(url, [["path": "src/app.ts", "data": "export const x = 1;"], ["path": "src/app.ts", "data": "again"]], cap)
        case ("api.box.com", "/2.0/folders/0/items"):
            return json(url, ["entries": [["type": "folder", "id": "11", "name": "Specs"], ["type": "file", "id": "21", "name": "notes.md", "size": 8], ["type": "web_link", "id": "31", "name": "Link"]]], cap)
        case ("api.box.com", "/2.0/folders/12/items"):
            let off = Int(q["offset"] ?? "0") ?? 0
            return json(url, ["entries": (0..<(off == 0 ? 100 : 3)).map { ["type": "file", "id": String(1000 + off + $0), "name": "f\(off + $0).txt"] }], cap)
        case ("api.box.com", "/2.0/files/21/content"): return reply(url, 200, Data("# Notes\n".utf8), [:], cap)
        case ("api.box.com", "/2.0/files/23/content"): return reply(url, 200, Data("%PDF-1.4\n".utf8), [:], cap)
        case ("api.box.com", "/2.0/files/22"):
            return json(url, ["representations": ["entries": [["representation": "extracted_text", "status": ["state": "pending"],
                "info": ["url": "https://api.box.com/2.0/internal_files/22/versions/1/representations/extracted_text"], "content": ["url_template": rep]]]]], cap)
        case ("api.box.com", "/2.0/internal_files/22/versions/1/representations/extracted_text"):
            return json(url, ["status": ["state": "success"], "content": ["url_template": rep]], cap)
        case ("api.box.com", "/2.0/files/25"): return json(url, ["representations": ["entries": [Any]()]], cap)
        case ("dl.boxcloud.com", "/api/2.0/internal_files/22/versions/1/representations/extracted_text/content/"): return reply(url, 200, Data("Plan text from Box".utf8), [:], cap)
        case ("api.box.com", "/2.0/search"):
            return json(url, ["entries": [["type": "file", "id": "22", "name": "plan.docx", "path_collection": ["entries": [["name": "All Files"], ["name": "Specs"]]]]]], cap)
        default: return json(url, ["message": "404"], cap, 404)
        }
    }

    func session(_ p: SourceProvider) -> SourceSession {
        SourceSession(perMinute: 60_000, token: { [unowned self] in self.tokens[p.rawValue]! }, refresh: { nil }, transport: transport, sleep: { _ in }, nowMs: { 0 })
    }
}
