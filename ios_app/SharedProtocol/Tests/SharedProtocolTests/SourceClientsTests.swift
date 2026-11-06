import Testing
import Foundation
@testable import SharedProtocol

@MainActor
@Suite("GitLab and Box read clients against fake APIs")
struct SourceClientsTests {
    let proj = SourceProjectRef(id: 7, ref: "main", webURL: URL(string: "https://gitlab.com/dee/demo")!)
    func f(_ path: String) -> SourceEntry { SourceEntry(id: "7:\(path)", name: String(path.split(separator: "/").last!), kind: .file, path: path, size: nil, detail: nil, project: proj) }
    func box(_ id: String, _ name: String, dir: Bool = false) -> SourceEntry { SourceEntry(id: id, name: name, kind: dir ? .dir : .file, path: name, size: nil, detail: nil, project: nil) }

    @Test("GitLab: projects (bad rows dropped), tree with paging, submodules skipped, files by kind, search, web URLs")
    func gitlab() async throws {
        let s = FakeSourceServer(); let c = GitLabReadClient(session: s.session(.gitlab))
        let projects = try await c.list(nil, cursor: nil).entries
        #expect(projects.map(\.path) == ["dee/demo", "dee/empty"])
        #expect(try await c.list(projects[1], cursor: nil).entries.isEmpty, "no default branch: nothing to list")
        let root = try await c.list(projects[0], cursor: nil)
        #expect(root.entries.map(\.name) == ["src", "README.md"]); #expect(root.next == "2")
        let app = try await c.open(try await c.list(root.entries[0], cursor: nil).entries[0])
        #expect(app.text == "export const x = 1;\n"); #expect(app.kind == .text)
        #expect(try await c.open(f("logo.bin")).reason == .type, "a binary extension is not fetched")
        let big = try await c.open(f("big.txt"))
        #expect(big.truncated); #expect(big.text?.count == SourcePreview.textCap)
        let hits = try await c.search(" x ", within: projects[0]).entries
        #expect(hits.map(\.path) == ["src/app.ts"]); #expect(hits[0].detail == "export const x = 1;")
        #expect(try await c.search("dem", within: nil).entries.map(\.path) == ["dee/demo"])
        #expect(c.webURL(f("src/app.ts"))?.absoluteString == "https://gitlab.com/dee/demo/-/blob/main/src/app.ts")
        #expect(s.requests.allSatisfy { ($0.httpMethod ?? "GET") == "GET" })
    }

    @Test("Box: folders (web links dropped), page-length paging, content, extracted text after one poll, missing text, search")
    func boxClient() async throws {
        let s = FakeSourceServer(); var polls: [UInt64] = []
        let c = BoxReadClient(session: s.session(.box), pollSleep: { polls.append($0) })
        let root = try await c.list(nil, cursor: nil)
        #expect(root.entries.map(\.name) == ["Specs", "notes.md"]); #expect(root.next == nil)
        let p1 = try await c.list(box("12", "Many", dir: true), cursor: nil)
        #expect(p1.entries.count == 100); #expect(p1.next == "100")
        #expect(try await c.list(box("12", "Many", dir: true), cursor: "100").next == nil)
        #expect(try await c.open(box("21", "notes.md")).text == "# Notes\n")
        #expect(try await c.open(box("23", "deck.pdf")).data?.count == 9)
        let plan = try await c.open(box("22", "plan.docx"))
        #expect(plan.kind == .extracted); #expect(plan.text == "Plan text from Box"); #expect(polls == [1_500_000_000])
        #expect(s.requests.first { $0.url!.path == "/2.0/files/22" }?.value(forHTTPHeaderField: "X-Rep-Hints") == "[extracted_text]")
        #expect(try await c.open(box("25", "scan.docx")).reason == .noText)
        let hits = try await c.search("plan", within: box("11", "Specs", dir: true))
        #expect(hits.entries.map(\.path) == ["Specs/plan.docx"])
        #expect(s.requests.last!.url!.query!.contains("ancestor_folder_ids=11"))
        await #expect(throws: SourceError.badResponse) { _ = try await c.list(box("1/../2", "x", dir: true), cursor: nil) }
        #expect(c.webURL(box("22", "plan.docx"))?.absoluteString == "https://app.box.com/file/22")
    }

    @Test("Box: 202 not ready is retried with Retry-After, then reported")
    func notReady() async throws {
        let s = FakeSourceServer()
        for _ in 0..<3 { s.canned.append(("https://api.box.com/2.0/files/21/content", 202, ["Retry-After": "2"])) }
        await #expect(throws: SourceError.notReady) { _ = try await BoxReadClient(session: s.session(.box)).open(box("21", "notes.md")) }
    }
}
