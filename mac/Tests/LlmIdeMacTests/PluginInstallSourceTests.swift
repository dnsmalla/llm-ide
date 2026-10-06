// Provenance sent with a plugin install: the header encoding the server
// decodes, and the client-side mirror of its validation (a value the server
// would refuse is not sent, so it can never fail an install).
import Testing
import Foundation
@testable import LlmIdeMacLib

private let sha = String(repeating: "a", count: 40)

private func decodeHeader(_ value: String) throws -> [String: Any] {
    var b64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    let data = try #require(Data(base64Encoded: b64))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Test func headerIsBase64URLJSONWithoutNils() throws {
    let s = PluginInstallSource.git(url: "https://github.com/o/r.git", ref: nil, commit: sha)
    let v = try s.headerValue()
    #expect(!v.contains("=") && !v.contains("+") && !v.contains("/"))
    let obj = try decodeHeader(v)
    #expect(obj["kind"] as? String == "git")
    #expect(obj["url"] as? String == "https://github.com/o/r.git")
    #expect(obj["ref"] == nil)
}

@Test func headerNeverCarriesInstalledAt() throws {
    var s = PluginInstallSource.zip(fileName: "x.zip")
    s.installedAt = "2026-10-06T00:00:00Z"
    let obj = try decodeHeader(try s.headerValue())
    #expect(obj["installedAt"] == nil)
    #expect(obj["fileName"] as? String == "x.zip")
}

@Test func decodesInstallSourceOnPluginInfo() throws {
    let s = try JSONDecoder().decode(PluginInstallSource.self, from: Data(#"{"kind":"zip","fileName":"x.zip","installedAt":"t"}"#.utf8))
    #expect(s.kind == "zip" && s.fileName == "x.zip")
}

@Test func marketplaceSourceIsAcceptable() {
    let s = PluginInstallSource.marketplace(url: "git@github.com:o/m.git", ref: "main", commit: sha,
                                            entry: "my-plugin", path: "plugins/my-plugin", tree: sha,
                                            version: "1.2.0")
    #expect(s.isServerAcceptable)
}

@Test(arguments: [
    "http://github.com/o/r",            // not https
    "https://user:pw@github.com/o/r",   // credentials
    "https://github.com/o/r?x=1",       // query
    "https://127.0.0.1/o/r",            // IP literal
    "https://localhost/o/r",
    "https://box.local/o/r",
    "git@10.0.0.1:o/r.git",
])
func refusedURLsAreNotSent(url: String) {
    #expect(!PluginInstallSource.git(url: url, ref: nil, commit: sha).isServerAcceptable)
}

@Test func refusedFieldsAreNotSent() {
    #expect(!PluginInstallSource.git(url: "https://github.com/o/r", ref: "-x", commit: sha).isServerAcceptable)
    #expect(!PluginInstallSource.git(url: "https://github.com/o/r", ref: nil, commit: "abc").isServerAcceptable)
    #expect(!PluginInstallSource.zip(fileName: "a/b.zip").isServerAcceptable)
    #expect(!PluginInstallSource.zip(fileName: "プラグイン.zip").isServerAcceptable)
    let badEntry = PluginInstallSource.marketplace(url: "https://github.com/o/m", ref: nil, commit: sha,
                                                   entry: "My_Plugin", path: "p", tree: sha, version: nil)
    #expect(!badEntry.isServerAcceptable)
}

@Test func recordablePathStripsAndRefusesRoot() {
    #expect(PluginMarketplace.recordablePath("./plugins/x") == "plugins/x")
    #expect(PluginMarketplace.recordablePath("plugins/x/") == "plugins/x")
    #expect(PluginMarketplace.recordablePath(".") == nil)
    #expect(PluginMarketplace.recordablePath("") == nil)
    #expect(PluginMarketplace.recordablePath("a//b") == nil)
}

@Test func stagedSourceUsesPrecomputedTree() throws {
    let entry = PluginMarketplace.Entry(name: "my-plugin", description: "", version: "1.0.0",
                                        relativePath: "plugins/my-plugin")
    let staged = PluginMarketplace.Staged(marketplaceName: "m", entries: [entry], skipped: [],
                                          repoRoot: URL(fileURLWithPath: "/nonexistent"), cleanup: {},
                                          url: "https://github.com/o/m", ref: "", commit: sha,
                                          trees: ["plugins/my-plugin": sha])
    let source = try staged.source(for: entry)
    #expect(source.kind == "marketplace" && source.path == "plugins/my-plugin" && source.tree == sha)
    #expect(source.ref == nil)
    let rootEntry = PluginMarketplace.Entry(name: "root", description: "", version: nil, relativePath: ".")
    #expect(throws: (any Error).self) { try staged.source(for: rootEntry) }
}

@Test func invalidVersionIsDroppedButRecordKept() throws {
    let entry = PluginMarketplace.Entry(name: "my-plugin", description: "", version: "1.0\n",
                                        relativePath: "plugins/my-plugin")
    let staged = PluginMarketplace.Staged(marketplaceName: "m", entries: [entry], skipped: [],
                                          repoRoot: URL(fileURLWithPath: "/nonexistent"), cleanup: {},
                                          url: "https://github.com/o/m", ref: nil, commit: sha,
                                          trees: ["plugins/my-plugin": sha])
    let source = try staged.source(for: entry)
    #expect(source.version == nil && source.tree == sha && source.commit == sha)
}
