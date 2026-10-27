import Foundation
import Testing
@testable import LlmIdeMacLib

/// `ServerDocFiles`, `DocFilesWithFallback`, the `/kb/docs/*` client and the
/// stores' server branches (docs-kit K1b), against a scripted wire. The wire is
/// `LlmIdeAPIClient`'s `fetchOverride` seam, so nothing leaves the process. The
/// preference is a suite `UserDefaults`, and the refresh token is never written
/// to the Keychain.
@MainActor
@Suite("Doc Gen server files", .serialized)
struct ServerDocFilesTests {

    // MARK: - Scripted wire

    /// Records every request and answers each one from `answer`.
    final class Wire: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [URLRequest] = []
        private let answer: @Sendable (URLRequest) throws -> (status: Int, body: Data)

        /// A throwing answer stands for a transport failure (no HTTP response).
        init(_ answer: @escaping @Sendable (URLRequest) throws -> (status: Int, body: Data)) {
            self.answer = answer
        }

        var requests: [URLRequest] {
            lock.lock(); defer { lock.unlock() }
            return seen
        }

        /// "METHOD path?query" for each request, in order.
        var lines: [String] {
            requests.map { request in
                let url = request.url
                let query = url?.query.map { "?\($0)" } ?? ""
                return "\(request.httpMethod ?? "GET") \(url?.path ?? "")\(query)"
            }
        }

        /// Forgets the requests seen so far, so a test can look at one step at a time.
        func reset() {
            lock.lock(); seen.removeAll(); lock.unlock()
        }

        var fetch: LlmIdeAPIClient.DataFetcher {
            { [self] request in
                lock.lock()
                seen.append(request)
                lock.unlock()
                let (status, body) = try answer(request)
                let url = request.url ?? URL(string: "http://test.invalid")!
                let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                               headerFields: ["Content-Type": "application/json"])!
                return (body, response)
            }
        }
    }

    /// A counter a wire answer can read, to script "first call fails, second works".
    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        /// Increments and returns the new count (1 on the first call).
        func next() -> Int {
            lock.lock(); defer { lock.unlock() }
            value += 1
            return value
        }
    }

    // MARK: - Fixtures

    nonisolated static func templateJSON(folder: String, name: String) -> String {
        ##"{"id":"65A8ADFC-2236-44D5-A676-C0DA368BBC91","name":"\##(name)","sections":["Went well"],"rawContent":"# \##(name)\n\n<!-- llmide:doc-template -->\n\n## Went well\n","isBuiltin":false,"folderName":"\##(folder)","isProjectTemplate":true,"surface":"doc"}"##
    }

    nonisolated static func listJSON(folder: String = "retro", name: String = "Retro") -> String {
        #"{"templates":["# + templateJSON(folder: folder, name: name) + #"],"count":1,"truncated":false,"scannedFolders":1}"#
    }

    nonisolated static let truncatedListJSON = #"{"templates":[],"count":0,"truncated":true,"scannedFolders":2000}"#
    nonisolated static let commandsListJSON = #"{"commands":[],"count":0,"truncated":false,"scannedFolders":0}"#
    nonisolated static let registerJSON = #"{"id":"alpha","root":"/x"}"#
    nonisolated static let deletedJSON = #"{"deleted":true,"folderName":"retro","folderRemoved":true}"#
    nonisolated static let seedJSON = #"{"written":["templates/README.md"],"count":1}"#
    nonisolated static let flatFeatureDisabled = #"{"error":"feature_disabled","feature":"doc_gen"}"#

    nonisolated static func body(_ json: String) -> Data { Data(json.utf8) }

    /// Answers every Doc Gen route with success. `overrides` answers a matching
    /// "METHOD path" first, as (status, JSON).
    static func happyWire(overrides: [String: (Int, String)] = [:]) -> Wire {
        Wire { request in
            let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
            if let override = overrides[key] { return (override.0, body(override.1)) }
            if key == "POST /kb/projects/register" { return (200, body(registerJSON)) }
            if key == "GET /kb/docs/templates" { return (200, body(listJSON())) }
            if key == "GET /kb/docs/commands" { return (200, body(commandsListJSON)) }
            if key.hasPrefix("PUT /kb/docs/templates/") {
                let folder = String(key.dropFirst("PUT /kb/docs/templates/".count))
                return (200, body(#"{"template":"# + templateJSON(folder: folder, name: "Saved") + #"}"#))
            }
            if key.hasPrefix("DELETE /kb/docs/") { return (200, body(deletedJSON)) }
            if key == "POST /kb/docs/seed" { return (200, body(seedJSON)) }
            return (404, body(#"{"error":{"code":"NOT_FOUND","message":"no route"}}"#))
        }
    }

    static func session() throws -> SessionStore {
        let store = SessionStore(server: "http://test-\(UUID().uuidString.lowercased()).invalid")
        store.persistRefreshToken = { _, _ in true }
        store.adopt(session: try JSONDecoder().decode(
            SessionResponse.self,
            from: Data(#"{"accessToken":"tok","refreshToken":"rt","accessTokenTTLSec":900}"#.utf8)))
        return store
    }

    // MARK: - Harness

    /// One app's worth of wiring for a test: the session, the client on the
    /// wire, the server path, and the two stores attached to it.
    @MainActor
    final class Harness {
        let root: URL
        let session: SessionStore
        let wire: Wire
        let defaults: UserDefaults
        let suite: String
        let server: ServerDocFiles
        let templates: DocTemplateStore
        let commands: DocCommandStore
        let provider: DocGenProvider

        init(serverOn: Bool, wire: Wire) throws {
            root = try DocGenServerStoreParityTests.buildProject()
            session = try ServerDocFilesTests.session()
            self.wire = wire
            suite = "docgen-test-\(UUID().uuidString.lowercased())"
            defaults = UserDefaults(suiteName: suite)!
            defaults.set(serverOn, forKey: DocGenServerStorePreference.key)
            let api = LlmIdeAPIClient(baseURL: "http://test.invalid", sessionStore: session,
                                      fetchOverride: wire.fetch)
            server = ServerDocFiles(api: api, preference: DocGenServerStorePreference(defaults: defaults))
            templates = DocTemplateStore(storeURL: root.appendingPathComponent("app-support/doc-templates.json"))
            commands = DocCommandStore()
            templates.attachServer(server)
            commands.attachServer(server)
            provider = DocGenProvider(templates: templates, commands: commands, server: server)
        }

        /// Opens the project the way AppShell does: activate, then load the files.
        func open(id: String = "alpha") async {
            provider.activateProject(id: id, root: root)
            provider.reloadProjectFiles(at: root)
            await server.drain()
        }

        func cleanup() {
            try? FileManager.default.removeItem(at: root)
            defaults.removePersistentDomain(forName: suite)
        }

        func fileExists(_ path: String) -> Bool {
            FileManager.default.fileExists(atPath: root.appendingPathComponent(path).path)
        }
    }

    static func weekly() -> DocTemplate {
        DocTemplate(id: UUID(), name: "Weekly", sections: ["Done", "Next"], rawContent: nil,
                    isBuiltin: false, folderName: "weekly", surface: .doc)
    }

    // MARK: - Preference off

    @Test func preferenceOffMakesNoRequestAtAll() async throws {
        let wire = Self.happyWire()
        let h = try Harness(serverOn: false, wire: wire)
        defer { h.cleanup() }

        // A full open, list, save, delete and seed, all on the local path.
        await h.open()
        h.templates.add(Self.weekly())
        let weekly = try #require(h.templates.templates(for: .doc).first { $0.folderName == "weekly" })
        h.templates.delete(id: weekly.id)
        h.provider.seedProjectFiles(at: h.root)
        await h.server.drain()

        #expect(wire.requests.isEmpty, "requests: \(wire.lines)")
        #expect(h.server.serves(h.root) == false)
        #expect(h.fileExists("templates/v0-bare/template.md"))
    }

    @Test func preferenceOffWritesLocallyAsBefore() async throws {
        let wire = Self.happyWire()
        let h = try Harness(serverOn: false, wire: wire)
        defer { h.cleanup() }

        await h.open()
        h.templates.add(Self.weekly())
        #expect(h.fileExists("templates/weekly/template.md"))
        #expect(wire.requests.isEmpty)
    }

    // MARK: - Preference on: list, write, delete, seed

    @Test func listingRegistersThenReadsAndKeepsSymlinkedFolders() async throws {
        let wire = Self.happyWire()
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        // A real folder whose template.md is a link: the server cannot read it.
        let linkedFolder = h.root.appendingPathComponent("templates/linkedfile", isDirectory: true)
        try FileManager.default.createDirectory(at: linkedFolder, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: linkedFolder.appendingPathComponent("template.md"),
            withDestinationURL: h.root.appendingPathComponent("templates/v0-bare/template.md"))

        await h.open()

        #expect(wire.lines == [
            "POST /kb/projects/register",
            "GET /kb/docs/templates?project=alpha",
            "GET /kb/docs/commands?project=alpha",
        ], "\(wire.lines)")
        let names = h.templates.templates(for: .doc).compactMap(\.folderName).sorted()
        // The server's "retro" plus the linked file "linkedfile" from the local pass.
        #expect(names == ["linkedfile", "retro"])
    }

    @Test func savePutsTheRenderedFileTextAndRefreshes() async throws {
        let wire = Self.happyWire()
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open()
        wire.reset()

        h.templates.add(Self.weekly())
        await h.server.drain()

        #expect(wire.lines.first == "PUT /kb/docs/templates/weekly?project=alpha", "\(wire.lines)")
        #expect(wire.lines.last == "GET /kb/docs/templates?project=alpha", "\(wire.lines)")
        let put = try #require(wire.requests.first)
        let sent = try #require(JSONSerialization.jsonObject(with: put.httpBody ?? Data()) as? [String: Any])
        #expect(sent["rawContent"] as? String == Self.weekly().renderedMarkdown())
        #expect(sent["surface"] as? String == "doc")
        // Write-through (docs-kit §8, K1b review): the same bytes are on disk too.
        #expect(h.fileExists("templates/weekly/template.md"))
    }

    @Test func deleteSendsOnlyTheFolder() async throws {
        let wire = Self.happyWire()
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open()
        wire.reset()

        let retro = try #require(h.templates.templates(for: .doc).first { $0.folderName == "retro" })
        h.templates.delete(id: retro.id)
        await h.server.drain()

        #expect(wire.lines.first == "DELETE /kb/docs/templates/retro?project=alpha", "\(wire.lines)")
    }

    @Test func seedGoesToTheServerAndIngestStaysLocal() async throws {
        let wire = Self.happyWire()
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open()
        wire.reset()

        h.provider.seedProjectFiles(at: h.root)
        await h.server.drain()

        #expect(wire.lines.first == "POST /kb/docs/seed?project=alpha", "\(wire.lines)")
        // The ingest templates are app machinery and stay local.
        #expect(h.fileExists("templates/meeting-note/template.md"))
    }

    // MARK: - Registration

    @Test func registrationHappensOnceAcrossCalls() async throws {
        let wire = Self.happyWire()
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open()
        h.provider.reloadProjectFiles(at: h.root)
        await h.server.drain()

        let registers = wire.lines.filter { $0 == "POST /kb/projects/register" }
        #expect(registers.count == 1, "\(wire.lines)")
    }

    @Test func aLostRegistrationIsRepeatedOnceThenTheCallSucceeds() async throws {
        let listCalls = Counter()
        let wire = Wire { request in
            let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
            if key == "POST /kb/projects/register" { return (200, Self.body(Self.registerJSON)) }
            if key == "GET /kb/docs/templates" {
                // The first list says the server forgot the project; the retry works.
                return listCalls.next() == 1
                    ? (404, Self.body(#"{"error":{"code":"PROJECT_NOT_REGISTERED","message":"unknown project"}}"#))
                    : (200, Self.body(Self.listJSON()))
            }
            return (200, Self.body(Self.commandsListJSON))
        }
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open()

        let registers = wire.lines.filter { $0 == "POST /kb/projects/register" }.count
        #expect(registers == 2, "\(wire.lines)")
        #expect(listCalls.next() == 3, "two list calls, then this one")
        #expect(h.templates.templates(for: .doc).contains { $0.folderName == "retro" })
    }

    @Test func aRefusedFolderIsRememberedForTheSession() async throws {
        let wire = Self.happyWire(overrides: [
            "POST /kb/projects/register": (400, #"{"error":{"code":"INVALID_ROOT","message":"refused"}}"#),
        ])
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open()
        h.provider.reloadProjectFiles(at: h.root)
        h.templates.add(Self.weekly())
        await h.server.drain()

        // One registration attempt, and no Doc Gen request after the refusal.
        #expect(wire.lines == ["POST /kb/projects/register"], "\(wire.lines)")
        #expect(!h.server.serves(h.root))
        // The write stayed local: the server refused the folder.
        #expect(h.fileExists("templates/weekly/template.md"))
    }

    @Test func aProjectIdTheServerWouldRefuseNeverLeavesTheMac() async throws {
        let wire = Self.happyWire()
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open(id: "not valid/id")

        #expect(wire.requests.isEmpty, "\(wire.lines)")
        #expect(!h.server.serves(h.root))
    }

    // MARK: - Fallback

    @Test func featureOffFallsBackToTheLocalFilesAndLosesNoWrite() async throws {
        let wire = Self.happyWire(overrides: [
            "POST /kb/projects/register": (404, Self.flatFeatureDisabled),
        ])
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }

        await h.open()
        // The list answers from disk.
        #expect(h.templates.templates(for: .doc).contains { $0.folderName == "v0-bare" })
        // A save while the server is off lands on disk.
        h.templates.add(Self.weekly())
        await h.server.drain()
        #expect(h.fileExists("templates/weekly/template.md"))
        // A delete removes the entry, and the folder too since it is then empty.
        let weekly = try #require(h.templates.templates(for: .doc).first { $0.folderName == "weekly" })
        h.templates.delete(id: weekly.id)
        await h.server.drain()
        #expect(!h.fileExists("templates/weekly"))
    }

    @Test func aTruncatedServerListingFallsBackToTheFullLocalListing() async throws {
        let wire = Self.happyWire(overrides: [
            "GET /kb/docs/templates": (200, Self.truncatedListJSON),
        ])
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open()

        #expect(h.templates.templates(for: .doc).contains { $0.folderName == "v0-bare" })
    }

    @Test func deleteFallbackKeepsTheUsersExtraFiles() async throws {
        // The server lists the folder the Mac has on disk, then refuses the delete.
        let wire = Self.happyWire(overrides: [
            "GET /kb/docs/templates": (200, Self.listJSON(folder: "v0-bare", name: "Summary")),
            "DELETE /kb/docs/templates/v0-bare": (404, #"{"error":{"code":"NOT_FOUND","message":"no such folder"}}"#),
        ])
        let h = try Harness(serverOn: true, wire: wire)
        defer { h.cleanup() }
        await h.open()
        // The user keeps a note next to the template.
        let note = h.root.appendingPathComponent("templates/v0-bare/notes.txt")
        try "keep me".write(to: note, atomically: true, encoding: .utf8)

        let v0 = try #require(h.templates.templates(for: .doc).first { $0.folderName == "v0-bare" })
        h.templates.delete(id: v0.id)
        await h.server.drain()

        #expect(!h.fileExists("templates/v0-bare/template.md"))
        #expect(h.fileExists("templates/v0-bare/notes.txt"))
    }

    // MARK: - Client error mapping

    @Test func clientMapsTheDocsErrorsToNamedCases() async throws {
        let cases: [(Int, String, String, DocFilesServerError)] = [
            (404, "PROJECT_NOT_REGISTERED", "unknown project", .projectNotRegistered),
            (400, "INVALID_ROOT", "refused", .invalidRoot),
            (409, "TOO_MANY_PROJECTS", "cap", .tooManyProjects),
            (409, "RESERVED_FOLDER", "this folder holds an ingest layout", .reservedFolder("this folder holds an ingest layout")),
            (400, "UNSAFE_PATH", "outside", .unsafePath),
            (400, "INVALID_FOLDER", "name", .invalidFolder),
            (413, "TOO_LARGE", "big", .tooLarge),
        ]
        for (status, code, message, expected) in cases {
            let wire = Self.happyWire(overrides: [
                "GET /kb/docs/templates": (status, #"{"error":{"code":"\#(code)","message":"\#(message)"}}"#),
            ])
            // The client holds its session weakly, so the test keeps this one alive.
            let session = try Self.session()
            let api = LlmIdeAPIClient(baseURL: "http://test.invalid", sessionStore: session,
                                      fetchOverride: wire.fetch)
            do {
                _ = try await api.listDocTemplates(project: "alpha")
                Issue.record("expected \(code) to throw")
            } catch let error as DocFilesServerError {
                #expect(error == expected, "\(code): got \(error)")
            }
            withExtendedLifetime(session) {}
        }
    }

    @Test func aFlatFeatureDisabledAnswerIsNamed() async throws {
        let wire = Self.happyWire(overrides: [
            "GET /kb/docs/templates": (404, Self.flatFeatureDisabled),
        ])
        // The client holds its session weakly, so the test keeps this one alive.
        let session = try Self.session()
        let api = LlmIdeAPIClient(baseURL: "http://test.invalid", sessionStore: session,
                                  fetchOverride: wire.fetch)
        do {
            _ = try await api.listDocTemplates(project: "alpha")
            Issue.record("expected feature_disabled to throw")
        } catch let error as DocFilesServerError {
            #expect(error == .featureDisabled)
            #expect(error.errorDescription == "The connected server has Doc Gen turned off.")
        }
        withExtendedLifetime(session) {}
    }
}
