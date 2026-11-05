import Foundation
@testable import SharedProtocol

@MainActor
final class FakeMegaServer {
    var nodes: [[String: Any]]
    var blobs: [String: Data]
    var uploads: [String: Data] = [:]
    var commands: [[String: Any]] = []
    var hashcashChallenge: String?
    var receivedHashcash: String?
    var failures: [String: Int] = [:]
    var downloadStatus = 200
    var downloadScheme = "https"
    private var n = 0
    let login = SV.d(SV.mega["login"])

    init(dropping drop: Set<String> = []) {
        nodes = (SV.mega["nodes"] as! [[String: Any]]).filter { !drop.contains($0["h"] as! String) }
        blobs = (SV.mega["blobs"] as! [String: String]).mapValues { SyncB64.decode($0)! }
    }

    var transport: MegaClient.Transport { { [unowned self] req in try await self.handle(req) } }
    var session: MegaClient.Session { .init(sid: SV.s(login["sid"]), masterKey: SV.hex(login["masterKeyHex"])) }

    private func reply(_ body: Any, status: Int = 200, headers: [String: String] = [:]) -> (Data, HTTPURLResponse) {
        let data = (body as? Data) ?? (try! JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]))
        return (data, HTTPURLResponse(url: URL(string: "https://fake.mega.test")!, statusCode: status, httpVersion: nil, headerFields: headers)!)
    }

    func handle(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = req.url!
        let parts = url.path.split(separator: "/").map(String.init)
        if url.path == "/cs" {
            if let ch = hashcashChallenge { hashcashChallenge = nil; return reply([-3], headers: ["X-Hashcash": ch]) }
            if let h = req.value(forHTTPHeaderField: "X-Hashcash") { receivedHashcash = h }
            let cmd = (try JSONSerialization.jsonObject(with: req.httpBody!) as! [[String: Any]])[0]
            commands.append(cmd)
            let a = cmd["a"] as! String
            if let e = failures.removeValue(forKey: a) { return reply([e]) }
            let sid = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "sid" }?.value
            if !["us0", "us"].contains(a), sid != SV.s(login["sid"]) { return reply(-15) }
            switch a {
            case "us0": return reply([["v": 2, "s": login["salt"]!]])
            case "us":
                let ok: [String: Any] = ["k": login["k"]!, "csid": login["csid"]!, "privk": login["privk"]!, "u": "USERHNDL"]
                return reply([cmd["uh"] as? String == SV.s(login["uh"]) ? ok as Any : -9 as Any])
            case "f": return reply([["f": nodes, "ok": [Any]()]])
            case "g":
                let node = nodes.first { $0["h"] as? String == cmd["n"] as? String }!
                return reply([["g": "\(downloadScheme)://fake.mega.test/dl/\(node["h"]!)", "s": node["s"]!]])
            case "u": n += 1; return reply([["p": "https://fake.mega.test/ul/T\(n)"]])
            case "p":
                let out = (cmd["n"] as! [[String: Any]]).map { x -> [String: Any] in
                    n += 1; let h = "SWFT\(n)"; let t = x["t"] as! Int
                    var node: [String: Any] = ["h": h, "p": cmd["t"]!, "t": t, "a": x["a"]!, "k": "USERHNDL:\(x["k"]!)", "ts": 1_762_400_000 + n, "u": "USERHNDL", "s": 0]
                    if t == 0 { let tok = String(decoding: SyncB64.decode(x["h"] as! String)!, as: UTF8.self); blobs[h] = uploads[tok]; node["s"] = uploads[tok]!.count }
                    nodes.append(node); return node
                }
                return reply([["f": out]])
            case "sml": return reply([0])
            default: return reply([-2])
            }
        }
        if parts.first == "ul" { uploads[parts[1]] = req.httpBody; return reply(Data(parts[1].utf8)) }
        if parts.first == "dl" { return reply(blobs[parts[1]] ?? Data(), status: downloadStatus) }
        throw URLError(.badURL)
    }
}
