import Foundation
import LlmIdeMacLib

// api-contract-lab (Phase 1 P12): decodes every 2xx HTTP contract fixture
// (schema/http/fixtures) with the Codable model the Mac client really uses
// for that endpoint (Routes.swift), and reports
//   - decode failures — a fixture the Mac cannot decode (always fails), and
//   - dropped keys — top-level response keys the Swift model does not keep
//     (fails unless schema/http/swift-decode-allowlist.json lists the key
//     with a reason). Only checked when the model is Encodable.
//
// An executable rather than a test for the same reason as chat-contract-lab:
// a Command-Line-Tools toolchain has no XCTest, and `swift run` works on both.
// A separate target sees only `public` symbols, so the routed models are public.

let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // APIContractLab
    .deletingLastPathComponent() // Sources
    .deletingLastPathComponent() // mac
    .deletingLastPathComponent()
let fixturesDir = repoRoot.appendingPathComponent("schema/http/fixtures")
let allowlistURL = repoRoot.appendingPathComponent("schema/http/swift-decode-allowlist.json")

struct AllowEntry: Decodable {
    let endpoint: String
    let key: String
    let reason: String
}

var failures: [String] = []
func fail(_ msg: String) {
    failures.append(msg)
    print("  FAIL \(msg)")
}

let allowlist: [AllowEntry]
do {
    allowlist = try JSONDecoder().decode([AllowEntry].self, from: Data(contentsOf: allowlistURL))
} catch {
    print("api-contract-lab: cannot read \(allowlistURL.path): \(error)")
    exit(2)
}
var unusedAllow = Set(allowlist.map { "\($0.endpoint) \($0.key)" })
for entry in allowlist where entry.reason.trimmingCharacters(in: .whitespaces).isEmpty {
    fail("allowlist entry \(entry.endpoint) \(entry.key) has no reason")
}

let routesByEndpoint = Dictionary(grouping: apiRoutes, by: \.endpoint)
let skipped = Set(apiSkipped.map(\.endpoint))
for endpoint in routesByEndpoint.keys where skipped.contains(endpoint) {
    fail("\(endpoint) is both routed and skipped")
}

/// Top-level keys of a response that carry a value: an object's keys, or the
/// union over an array's objects. A null value is skipped — Swift's synthesized
/// encoder omits a nil optional, so it would read as "dropped" when it is not.
func topLevelKeys(_ json: Any) -> Set<String> {
    func valued(_ obj: [String: Any]) -> Set<String> { Set(obj.filter { !($0.value is NSNull) }.keys) }
    if let obj = json as? [String: Any] { return valued(obj) }
    if let arr = json as? [Any] {
        return arr.reduce(into: Set<String>()) { acc, el in
            if let obj = el as? [String: Any] { acc.formUnion(valued(obj)) }
        }
    }
    return []
}

let groups = (try? FileManager.default.contentsOfDirectory(atPath: fixturesDir.path))?.sorted() ?? []
var decoded = 0
var dropChecked = 0
var notEncodable = Set<String>()
var seenEndpoints = Set<String>()
var unrouted = Set<String>()

print("api-contract-lab")
for group in groups {
    let dir = fixturesDir.appendingPathComponent(group)
    let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
        .filter { $0.hasSuffix(".json") }.sorted()
    for file in files {
        let url = dir.appendingPathComponent(file)
        guard let raw = try? Data(contentsOf: url),
              let fixture = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let endpoint = fixture["endpoint"] as? String,
              let status = fixture["status"] as? Int,
              (200..<300).contains(status),
              let response = fixture["response"] else { continue }
        seenEndpoints.insert(endpoint)
        guard let routes = routesByEndpoint[endpoint] else {
            if !skipped.contains(endpoint) { unrouted.insert(endpoint) }
            continue
        }
        guard JSONSerialization.isValidJSONObject(response) || response is NSNull
                || response is String || response is NSNumber,
              let body = try? JSONSerialization.data(withJSONObject: response, options: [.fragmentsAllowed]) else {
            fail("\(group)/\(file): response is not JSON")
            continue
        }
        for route in routes {
            do {
                let reencoded = try route.decode(body)
                decoded += 1
                guard let reencoded else { notEncodable.insert(route.model); continue }
                dropChecked += 1
                let kept = topLevelKeys(try JSONSerialization.jsonObject(with: reencoded, options: [.fragmentsAllowed]))
                for key in topLevelKeys(response).subtracting(kept).sorted() {
                    let id = "\(endpoint) \(key)"
                    if unusedAllow.remove(id) != nil || allowlist.contains(where: { "\($0.endpoint) \($0.key)" == id }) {
                        continue
                    }
                    fail("\(group)/\(file): \(route.model) drops key \"\(key)\" (allowlist it with a reason, or decode it)")
                }
            } catch {
                fail("\(group)/\(file): \(route.model) cannot decode — \(error)")
            }
        }
    }
}

for endpoint in routesByEndpoint.keys.sorted() where !seenEndpoints.contains(endpoint) {
    fail("route \(endpoint) has no 2xx fixture (typo, or the fixture was removed)")
}
for endpoint in unrouted.sorted() {
    fail("\(endpoint) has a 2xx fixture but is neither routed nor skipped in Routes.swift")
}
for stale in unusedAllow.sorted() {
    fail("allowlist entry \"\(stale)\" matches no dropped key (remove it)")
}

print("  decoded \(decoded) fixture bodies over \(routesByEndpoint.count) routed endpoints; " +
      "drop-checked \(dropChecked); skipped endpoints \(apiSkipped.count)")
if !notEncodable.isEmpty {
    print("  not drop-checked (Decodable only): \(notEncodable.sorted().joined(separator: ", "))")
}
if failures.isEmpty {
    print("api-contract-lab: PASS")
    exit(0)
}
print("api-contract-lab: \(failures.count) failure(s)")
exit(1)
