import Foundation
import CryptoKit
@testable import SharedProtocol

/// The shared vectors, read straight from the repo so Swift judges the same bytes as Node.
enum SV {
    static let repo: URL = {
        var u = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { u.deleteLastPathComponent() }
        return u
    }()
    static func load(_ rel: String) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent(rel))) as! [String: Any]
    }
    static let sync = load("schema/sync/v1/vectors/v1.json")
    static let relay = load("schema/relay/v1/vectors/v1.json")
    static let mega = load("ios_app/SharedProtocol/Tests/SharedProtocolTests/Fixtures/mega-client.json")
    static var keys: [String: Any] { d(sync["keys"]) }

    static func d(_ x: Any?) -> [String: Any] { x as! [String: Any] }
    static func s(_ x: Any?) -> String { x as! String }
    static func i(_ x: Any?) -> Int { x as! Int }
    static func b(_ x: Any?) -> Data { SyncB64.decode(x as! String)! }
    static func hex(_ x: Any?) -> Data {
        let c = Array((x as! String).utf8)
        return Data(stride(from: 0, to: c.count, by: 2).map { UInt8(String(decoding: c[$0..<$0 + 2], as: UTF8.self), radix: 16)! })
    }
    static func json(_ o: Any?) -> Data { try! JSONSerialization.data(withJSONObject: o!) }
    static func env(_ o: Any?) throws -> SyncEnvelope { try SyncEnvelope.parse(json(o)) }
    static func headerValue(_ x: Any?) -> SyncHeaderValue { (x as? String).map(SyncHeaderValue.s) ?? .i(x as! Int) }

    static func mutate(_ env: [String: Any], _ m: [String: Any]) -> [String: Any] {
        var e = env
        let field = m["field"] as? String ?? ""
        switch m["op"] as? String {
        case "flip": var x = [UInt8](b(e[field])); x[0] ^= 1; e[field] = SyncB64.encode(Data(x))
        case "truncate": e[field] = SyncB64.encode(Data(b(e[field]).dropLast()))
        case "set": e[field] = m["value"]
        default: break
        }
        return e
    }

    static func desktopSigning() throws -> P256.Signing.PrivateKey { try .init(derRepresentation: b(keys["desktopSigningPkcs8"])) }
    static func desktopVerify() throws -> P256.Signing.PublicKey { try SyncSpki.signingKey(b(keys["desktopSigningSpki"])) }
    static func deviceKeys() throws -> SoftwareSyncDeviceKeys {
        try .init(signingPkcs8: b(keys["deviceSigningPkcs8"]), ecdhPkcs8: b(keys["deviceEcdhPkcs8"]))
    }
    static var wrapKeys: SyncWrapKeys {
        .init(request: hex(sync["requestKeyHex"]), reply: hex(sync["replyKeyHex"]),
              snapshot: hex(sync["snapshotKeyHex"]), manifest: hex(sync["manifestKeyHex"]))
    }
}
