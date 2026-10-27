import Foundation
import Testing
@testable import LlmIdeMacLib

/// Doc Gen server writes under the preference (docs-kit K1b review): unique
/// folder names under queued writes (H1), the refresh epoch (M2), the
/// fallback classes for validation answers (L4), write-through to disk (L5),
/// the stray-entry delete rule (M3), and the pref-off no-request guarantee
/// across import, update and commands (L6).
@MainActor
@Suite("Doc Gen server writes", .serialized)
struct DocGenServerWriteTests {
    typealias Harness = ServerDocFilesTests.Harness
    typealias Wire = ServerDocFilesTests.Wire

    /// A small server with state: PUT stores a folder, GET lists what is stored,
    /// DELETE removes it. Needed where a refresh must see earlier writes.
    final class FakeDocsServer: @unchecked Sendable {
        private let lock = NSLock()
        private var templates: [String: String] = [:]
        private var commands: [String: String] = [:]

        private static let commandId = "65A8ADFC-2236-44D5-A676-C0DA368BBC91"

        func answer(_ request: URLRequest) -> (status: Int, body: Data) {
            lock.lock(); defer { lock.unlock() }
            let method = request.httpMethod ?? "GET"
            let path = request.url?.path ?? ""
            let json = (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
            if method == "POST", path == "/kb/projects/register" {
                return (200, Data(ServerDocFilesTests.registerJSON.utf8))
            }
            if method == "GET", path == "/kb/docs/templates" {
                let items = templates.sorted { $0.key < $1.key }.map {
                    ServerDocFilesTests.templateJSON(folder: $0.key, name: $0.value)
                }
                return (200, Data(#"{"templates":[\#(items.joined(separator: ","))],"count":\#(items.count),"truncated":false,"scannedFolders":\#(items.count)}"#.utf8))
            }
            if method == "GET", path == "/kb/docs/commands" {
                let items = commands.sorted { $0.key < $1.key }.map { Self.commandJSON(folder: $0.key, name: $0.value) }
                return (200, Data(#"{"commands":[\#(items.joined(separator: ","))],"count":\#(items.count),"truncated":false,"scannedFolders":\#(items.count)}"#.utf8))
            }
            if method == "PUT", path.hasPrefix("/kb/docs/templates/") {
                let folder = String(path.dropFirst("/kb/docs/templates/".count))
                let name = json["name"] as? String ?? folder
                templates[folder] = name
                return (200, Data(#"{"template":\#(ServerDocFilesTests.templateJSON(folder: folder, name: name))}"#.utf8))
            }
            if method == "PUT", path.hasPrefix("/kb/docs/commands/") {
                let folder = String(path.dropFirst("/kb/docs/commands/".count))
                let name = json["name"] as? String ?? folder
                commands[folder] = name
                return (200, Data(#"{"command":\#(Self.commandJSON(folder: folder, name: name))}"#.utf8))
            }
            if method == "DELETE", path.hasPrefix("/kb/docs/templates/") {
                let folder = String(path.dropFirst("/kb/docs/templates/".count))
                guard templates.removeValue(forKey: folder) != nil else {
                    return (404, Data(#"{"error":{"code":"NOT_FOUND","message":"no such folder"}}"#.utf8))
                }
                return (200, Data(ServerDocFilesTests.deletedJSON.utf8))
            }
            if method == "DELETE", path.hasPrefix("/kb/docs/commands/") {
                let folder = String(path.dropFirst("/kb/docs/commands/".count))
                guard commands.removeValue(forKey: folder) != nil else {
                    return (404, Data(#"{"error":{"code":"NOT_FOUND","message":"no such folder"}}"#.utf8))
                }
                return (200, Data(ServerDocFilesTests.deletedJSON.utf8))
            }
            return (404, Data(#"{"error":{"code":"NOT_FOUND","message":"no route"}}"#.utf8))
        }

        static func commandJSON(folder: String, name: String) -> String {
            ##"{"id":"\#(commandId)","name":"\#(name)","instruction":"Do it.","rawContent":"# \#(name)\n\n<!-- llmide:doc-command -->\n\nDo it.","isBuiltin":false,"folderName":"\#(folder)","isProjectCommand":true,"surface":"doc"}"##
        }

        func wire() -> Wire { Wire { [self] in answer($0) } }
    }

    static func tempMarkdown(_ text: String, name: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("docgen-md-\(UUID().uuidString.lowercased())", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("\(name).md")
        try text.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    // MARK: - Preference off (L6): no request for import, update or commands

    @Test func preferenceOffMakesNoRequestForImportUpdateAndCommands() async throws {
        let wire = ServerDocFilesTests.happyWire()
        let h = try Harness(serverOn: false, wire: wire)
        defer { h.cleanup() }
        await h.open()

        let md = try Self.tempMarkdown("# Imported\n\n## A\n", name: "imported")
        let imported = try #require(h.templates.importMarkdownFile(at: md))
        var edited = imported
        edited.name = "Imported Again"
        h.templates.update(edited)

        let cmdMd = try Self.tempMarkdown("# Summarize\n\nDo it.\n", name: "summarize")
        let command = try #require(h.commands.importMarkdownFile(at: cmdMd))
        h.commands.delete(id: command.id)
        h.templates.delete(id: imported.id)
        await h.server.drain()

        #expect(wire.requests.isEmpty, "requests: \(wire.lines)")
        #expect(!h.fileExists("templates/imported"))
    }

    // MARK: - H1: unique folder names under queued writes

    @Test func twoQuickSavesOfOneNameGetTwoFoldersAndBothSurvive() async throws {
        let fake = FakeDocsServer()
        let h = try Harness(serverOn: true, wire: fake.wire())
        defer { h.cleanup() }
        await h.open()

        h.templates.add(ServerDocFilesTests.weekly())
        h.templates.add(ServerDocFilesTests.weekly())
        await h.server.drain()

        let folders = h.templates.templates(for: .doc).compactMap(\.folderName).sorted()
        #expect(folders == ["weekly", "weekly-2"], "\(folders)")
        #expect(h.fileExists("templates/weekly/template.md"))
        #expect(h.fileExists("templates/weekly-2/template.md"))
    }

    @Test func twoQuickImportsOfOneCommandGetTwoFoldersAndBothSurvive() async throws {
        let fake = FakeDocsServer()
        let h = try Harness(serverOn: true, wire: fake.wire())
        defer { h.cleanup() }
        await h.open()

        let md = try Self.tempMarkdown("# Summarize\n\nDo it.\n", name: "summarize")
        _ = h.commands.importMarkdownFile(at: md)
        _ = h.commands.importMarkdownFile(at: md)
        await h.server.drain()

        // The kit seeds other commands too; only the two imports are counted.
        let folders = h.commands.projectCommands.compactMap { $0.folderName }.filter { $0.hasPrefix("summarize") }.sorted()
        #expect(folders == ["summarize", "summarize-2"], "\(folders)")
        #expect(h.fileExists("commands/summarize/command.md"))
        #expect(h.fileExists("commands/summarize-2/command.md"))
    }

    // MARK: - M2: a refresh queued before a mutation does not revert it

    @Test func aRefreshQueuedBeforeAnOptimisticSaveDoesNotRevertIt() async throws {
        let fake = FakeDocsServer()
        let h = try Harness(serverOn: true, wire: fake.wire())
        defer { h.cleanup() }
        await h.open()

        let (gate, release) = AsyncStream<Void>.makeStream()
        h.server.enqueue { for await _ in gate { break } }
        h.templates.reloadProjectTemplates(at: h.root)          // refresh queued, epoch E
        var seenAfterRefresh: Bool?
        h.server.enqueue {                                       // runs after that refresh
            seenAfterRefresh = h.templates.templates(for: .doc).contains { $0.folderName == "weekly" }
        }
        h.templates.add(ServerDocFilesTests.weekly())            // optimistic save, epoch E+1
        release.yield(())
        release.finish()
        await h.server.drain()

        #expect(seenAfterRefresh == true, "the stale refresh replaced the optimistic list")
        #expect(h.templates.templates(for: .doc).contains { $0.folderName == "weekly" })
    }

    // MARK: - L4: fallback classes

    enum PutAnswer {
        case transport
        case status(Int, String)
    }

    /// The register answer and the PUT answer, with everything else answered as the server would.
    static func wire(register: (Int, String) = (200, ServerDocFilesTests.registerJSON),
                     put: PutAnswer) -> Wire {
        Wire { request in
            let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
            if key == "POST /kb/projects/register" { return (register.0, ServerDocFilesTests.body(register.1)) }
            if key == "GET /kb/docs/templates" { return (200, ServerDocFilesTests.body(ServerDocFilesTests.listJSON())) }
            if key == "GET /kb/docs/commands" { return (200, ServerDocFilesTests.body(ServerDocFilesTests.commandsListJSON)) }
            if key.hasPrefix("PUT /kb/docs/templates/") {
                switch put {
                case .transport: throw URLError(.notConnectedToInternet)
                case .status(let status, let body): return (status, ServerDocFilesTests.body(body))
                }
            }
            return (404, ServerDocFilesTests.body(#"{"error":{"code":"NOT_FOUND","message":"no route"}}"#))
        }
    }

    enum Expectation {
        case answeredLocally
        case thrown(DocFilesServerError)
    }

    static let rows: [(label: String, register: (Int, String), put: PutAnswer, expect: Expectation)] = [
        ("transport failure", (200, ServerDocFilesTests.registerJSON), .transport, .answeredLocally),
        ("500", (200, ServerDocFilesTests.registerJSON), .status(500, #"{"error":{"code":"INTERNAL","message":"boom"}}"#), .answeredLocally),
        ("503", (200, ServerDocFilesTests.registerJSON), .status(503, #"{"error":{"code":"UNAVAILABLE","message":"busy"}}"#), .answeredLocally),
        ("feature off", (200, ServerDocFilesTests.registerJSON), .status(404, ServerDocFilesTests.flatFeatureDisabled), .answeredLocally),
        ("project not registered", (200, ServerDocFilesTests.registerJSON), .status(404, #"{"error":{"code":"PROJECT_NOT_REGISTERED","message":"unknown project"}}"#), .answeredLocally),
        ("folder refused at registration", (400, #"{"error":{"code":"INVALID_ROOT","message":"refused"}}"#), .status(200, "{}"), .answeredLocally),
        ("too large", (200, ServerDocFilesTests.registerJSON), .status(413, #"{"error":{"code":"TOO_LARGE","message":"big"}}"#), .thrown(.tooLarge)),
        ("invalid folder", (200, ServerDocFilesTests.registerJSON), .status(400, #"{"error":{"code":"INVALID_FOLDER","message":"name"}}"#), .thrown(.invalidFolder)),
        ("reserved folder", (200, ServerDocFilesTests.registerJSON), .status(409, #"{"error":{"code":"RESERVED_FOLDER","message":"ingest layout"}}"#), .thrown(.reservedFolder("ingest layout"))),
        ("unsafe path", (200, ServerDocFilesTests.registerJSON), .status(400, #"{"error":{"code":"UNSAFE_PATH","message":"outside"}}"#), .thrown(.unsafePath)),
        ("other 4xx", (200, ServerDocFilesTests.registerJSON), .status(400, #"{"error":{"code":"BAD_BODY","message":"nope"}}"#), .thrown(.other(status: 400, code: "BAD_BODY", message: "nope"))),
        ("unrecoverable 401 (not signed in)", (200, ServerDocFilesTests.registerJSON), .status(401, #"{"error":{"code":"UNAUTHORIZED","message":"sign in"}}"#), .answeredLocally),
    ]

    @Test func eachFailureClassFallsBackOrSurfacesAsItsRowSays() async throws {
        for row in Self.rows {
            let wire = Self.wire(register: row.register, put: row.put)
            let h = try Harness(serverOn: true, wire: wire)
            defer { h.cleanup() }
            await h.open()
            wire.reset()

            let backend = DocFilesWithFallback(server: h.server, local: LocalDocFiles())
            let weekly = ServerDocFilesTests.weekly()
            switch row.expect {
            case .answeredLocally:
                do {
                    try await backend.saveTemplate(weekly, folderName: "weekly", root: h.root)
                } catch {
                    Issue.record("\(row.label): expected a local answer, got \(error)")
                }
                #expect(h.fileExists("templates/weekly/template.md"), "\(row.label): the local write is missing")
            case .thrown(let expected):
                do {
                    try await backend.saveTemplate(weekly, folderName: "weekly", root: h.root)
                    Issue.record("\(row.label): expected \(expected) to be thrown")
                } catch let error as DocFilesServerError {
                    #expect(error == expected, "\(row.label): got \(error)")
                } catch {
                    Issue.record("\(row.label): expected a typed error, got \(error)")
                }
                #expect(!h.fileExists("templates/weekly/template.md"), "\(row.label): a refused write reached the disk")
            }
        }
    }

    @Test func aValidationAnswerThroughTheStoreIsUndoneAndShown() async throws {
        let fake = FakeDocsServer()
        let refusing = Wire { request in
            if request.httpMethod == "PUT", request.url?.path.hasPrefix("/kb/docs/templates/") == true {
                return (413, ServerDocFilesTests.body(#"{"error":{"code":"TOO_LARGE","message":"big"}}"#))
            }
            return fake.answer(request)
        }
        let h = try Harness(serverOn: true, wire: refusing)
        defer { h.cleanup() }
        await h.open()

        h.templates.add(ServerDocFilesTests.weekly())
        await h.server.drain()

        #expect(h.templates.serverError == DocFilesServerError.tooLarge.errorDescription)
        #expect(!h.fileExists("templates/weekly/template.md"), "the refused write was not undone")
        #expect(!h.templates.templates(for: .doc).contains { $0.folderName == "weekly" })
    }

    // MARK: - L5: write-through

    @Test func aSaveIsOnDiskBeforeTheQueueRuns() async throws {
        let fake = FakeDocsServer()
        let h = try Harness(serverOn: true, wire: fake.wire())
        defer { h.cleanup() }
        await h.open()

        h.templates.add(ServerDocFilesTests.weekly())
        // Nothing has drained: a quit here must keep the edit.
        #expect(h.fileExists("templates/weekly/template.md"))
        await h.server.drain()
        #expect(h.fileExists("templates/weekly/template.md"))
    }

    @Test func aDeleteIsOnDiskBeforeTheQueueRuns() async throws {
        let fake = FakeDocsServer()
        let h = try Harness(serverOn: true, wire: fake.wire())
        defer { h.cleanup() }
        await h.open()
        h.templates.add(ServerDocFilesTests.weekly())
        await h.server.drain()

        let weekly = try #require(h.templates.templates(for: .doc).first { $0.folderName == "weekly" })
        h.templates.delete(id: weekly.id)
        #expect(!h.fileExists("templates/weekly"))
        await h.server.drain()
        #expect(!h.fileExists("templates/weekly"))
    }

    // MARK: - M3: the delete removes the entry the scan lists

    @Test func localDeleteRemovesAStrayEntryAndItsFolder() throws {
        let root = try DocGenServerStoreParityTests.buildProject()
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("templates/stray", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "# Stray\n\n## A\n".write(to: folder.appendingPathComponent("notes.md"), atomically: true, encoding: .utf8)
        #expect(LocalDocFiles.scanTemplates(at: root).contains { $0.folderName == "stray" })

        try LocalDocFiles.removeTemplateEntry(folderName: "stray", at: root)

        #expect(!FileManager.default.fileExists(atPath: folder.path))
        #expect(!LocalDocFiles.scanTemplates(at: root).contains { $0.folderName == "stray" })
    }

    @Test func localDeleteKeepsOtherFilesBesideTemplateMd() throws {
        let root = try DocGenServerStoreParityTests.buildProject()
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("templates/v0-bare", isDirectory: true)
        try "my notes\n".write(to: folder.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)

        try LocalDocFiles.removeTemplateEntry(folderName: "v0-bare", at: root)

        #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("template.md").path))
        #expect(try String(contentsOf: folder.appendingPathComponent("README.md"), encoding: .utf8) == "my notes\n")
    }

    // MARK: - Page fields are optional (the wire answer)

    @Test func aListWithoutTruncatedOrScannedFoldersIsServedNotFallenBack() async throws {
        let wire = ServerDocFilesTests.happyWire(overrides: [
            "GET /kb/docs/templates": (200,
                #"{"templates":["# + ServerDocFilesTests.templateJSON(folder: "retro", name: "Retro") + #"],"count":1}"#),
        ])
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open()

        // The server's list, not the full local listing (v0-bare, v2-visual).
        #expect(h.templates.templates(for: .doc).compactMap { $0.folderName }.sorted() == ["retro"])
    }
}
