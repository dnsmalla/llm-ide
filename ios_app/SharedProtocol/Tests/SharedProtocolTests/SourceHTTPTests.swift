import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("SourceSession and preview rules")
struct SourceHTTPTests {
    func ok(_ req: URLRequest, _ status: Int = 200, _ body: String = "x", _ headers: [String: String] = [:]) -> (Data, HTTPURLResponse, Bool) {
        (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: headers)!, false)
    }

    @Test("allow-list: https, exact hosts, no credentials, port 443")
    func hosts() {
        for s in ["https://gitlab.com/api/v4/x", "https://api.box.com/2.0/x", "https://dl.boxcloud.com/d", "https://public.boxcloud.com/x"] { #expect(SourceHTTP.isAllowed(URL(string: s)!), "\(s)") }
        for s in ["http://gitlab.com/", "https://gitlab.com.evil.example/", "https://u:p@gitlab.com/", "https://gitlab.com:8443/", "https://account.box.com/"] { #expect(!SourceHTTP.isAllowed(URL(string: s)!), "\(s)") }
    }

    @Test("401 refreshes once and retries; 429 waits Retry-After up to twice; offline and refused hosts map")
    func session() async throws {
        var sleeps: [UInt64] = []
        var token = "t1"; var refreshes = 0; var n = 0; var seen: [String] = []
        let s = SourceSession(perMinute: 60_000, token: { token }, refresh: { refreshes += 1; token = "t2"; return token },
                              transport: { req, _ in seen.append(req.value(forHTTPHeaderField: "Authorization") ?? ""); n += 1
                                  switch n { case 1: return self.ok(req, 401); case 2: return self.ok(req, 429, "", ["Retry-After": "3"]); default: return self.ok(req) } },
                              sleep: { sleeps.append($0) }, nowMs: { 0 })
        let (d, _, _) = try await s.get(URL(string: "https://gitlab.com/api/v4/x")!, cap: 10)
        #expect(String(decoding: d, as: UTF8.self) == "x")
        #expect(seen == ["Bearer t1", "Bearer t2", "Bearer t2"]); #expect(refreshes == 1)
        #expect(sleeps.contains(3_000_000_000))
        let limited = SourceSession(perMinute: 60_000, token: { "t" }, refresh: { nil }, transport: { req, _ in self.ok(req, 429, "", ["Retry-After": "999"]) }, sleep: { _ in }, nowMs: { 0 })
        await #expect(throws: SourceError.rateLimited(60)) { _ = try await limited.get(URL(string: "https://api.box.com/x")!, cap: 10) }
        let off = SourceSession(perMinute: 60_000, token: { "t" }, refresh: { nil }, transport: { _, _ in throw URLError(.notConnectedToInternet) }, sleep: { _ in }, nowMs: { 0 })
        await #expect(throws: SourceError.offline) { _ = try await off.get(URL(string: "https://api.box.com/x")!, cap: 10) }
        await #expect(throws: SourceError.refusedHost) { _ = try await off.get(URL(string: "https://evil.example/x")!, cap: 10) }
        let landed = SourceSession(perMinute: 60_000, token: { "t" }, refresh: { nil },
                                   transport: { _, _ in (Data(), HTTPURLResponse(url: URL(string: "https://evil.example/")!, statusCode: 200, httpVersion: nil, headerFields: nil)!, false) }, sleep: { _ in }, nowMs: { 0 })
        await #expect(throws: SourceError.refusedHost) { _ = try await landed.get(URL(string: "https://api.box.com/2.0/files/1/content")!, cap: 10) }
        let gone = SourceSession(perMinute: 60_000, token: { "t" }, refresh: { nil }, transport: { req, _ in self.ok(req, 401) }, sleep: { _ in }, nowMs: { 0 })
        await #expect(throws: SourceError.signedOut) { _ = try await gone.get(URL(string: "https://api.box.com/x")!, cap: 10) }
    }

    @Test("pace: request starts are spaced by 60000/perMinute ms")
    func pace() async throws {
        var sleeps: [UInt64] = []
        let s = SourceSession(perMinute: 60, token: { "t" }, refresh: { nil }, transport: { req, _ in self.ok(req) }, sleep: { sleeps.append($0) }, nowMs: { 0 })
        for _ in 0..<3 { _ = try await s.get(URL(string: "https://gitlab.com/x")!, cap: 10) }
        #expect(sleeps == [1_000_000_000, 2_000_000_000])
    }

    @Test("preview rules and text decoding")
    func preview() async throws {
        #expect(SourcePreview.kind("a.ts", provider: .gitlab).0 == .text)
        #expect(SourcePreview.kind("README.md", provider: .gitlab).0 == .markdown)
        #expect(SourcePreview.kind("deck.PDF", provider: .box).0 == .pdf)
        #expect(SourcePreview.kind("plan.docx", provider: .box).0 == .extracted)
        #expect(SourcePreview.kind("plan.docx", provider: .gitlab).0 == .unsupported)
        #expect(SourcePreview.kind("logo.png", provider: .box).0 == .unsupported)
        #expect(SourcePreview.kind("index.html", provider: .gitlab).0 == .text, "HTML is shown as source text")
        #expect(SourcePreview.decodeText(Data([104, 105])) == "hi")
        #expect(SourcePreview.decodeText(Data([104, 0, 105])) == nil)
        #expect(throws: SourceError.badQuery) { try SourcePreview.query("  ") }
        let e = SourceEntry(id: "1", name: "a.txt", kind: .file, path: "a.txt", size: nil, detail: nil, project: nil)
        let t = try await SourcePreview.load(e, kind: .text, language: "TXT", webURL: nil) { _ in (Data("hi".utf8), HTTPURLResponse(), true) }
        #expect(t.text == "hi"); #expect(t.truncated)
        let p = try await SourcePreview.load(e, kind: .pdf, language: "PDF", webURL: nil) { _ in (Data(), HTTPURLResponse(), true) }
        #expect(p.reason == .tooLarge)
        var fetched = false
        let u = try await SourcePreview.load(e, kind: .unsupported, language: "PNG", webURL: nil) { _ in fetched = true; return (Data(), HTTPURLResponse(), false) }
        #expect(u.reason == .type); #expect(!fetched)
    }
}
