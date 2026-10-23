import Foundation
import Testing
@testable import LlmIdeMacLib

/// The on-demand mermaid component: integrity check, install layout, and the
/// renderer's behaviour when the script is absent. Never touches the network —
/// every installer here gets a `StubDownloader`.
///
/// NOTE: this toolchain has no XCTest, so this suite does not run locally;
/// `chat-contract-lab` asserts the integrity check and renderer fallback
/// through `MermaidConformance` / `GenerationConformance` so they still gate.
@Suite("Mermaid on-demand runtime")
struct MermaidRuntimeTests {

    private struct StubDownloader: MermaidDownloading {
        let result: Result<Data, URLError>

        func fetch(_ url: URL, maxBytes: Int,
                   progress: @escaping @Sendable (Int) -> Void) async throws -> Data {
            let data = try result.get()
            progress(data.count)
            return data
        }
    }

    private static let goodPayload = Data("window.mermaid = { initialize(){}, render(){} };".utf8)

    private static func makeRoot() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("mermaid-tests-\(UUID().uuidString)", isDirectory: true)
    }

    private static func makeInstaller(root: URL, serving result: Result<Data, URLError>,
                                      version: String = "1.2.3") -> MermaidInstaller {
        MermaidInstaller(root: root, version: version,
                         expectedSHA256: Mermaid.sha256Hex(goodPayload),
                         sourceURL: URL(string: "https://cdn.invalid/mermaid@\(version)/mermaid.min.js")!,
                         expectedBytes: goodPayload.count, maxBytes: 1024,
                         downloader: StubDownloader(result: result))
    }

    // MARK: - Integrity

    @Test("A wrong-hash download is rejected and nothing is written")
    func wrongHashRejected() async throws {
        let root = Self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = Self.makeInstaller(root: root, serving: .success(Data("evil()".utf8)))

        await #expect(throws: MermaidInstallError.self) { try await installer.install() }
        #expect(!FileManager.default.fileExists(atPath: installer.scriptURL.path))
        #expect(!FileManager.default.fileExists(atPath: installer.componentDirectory.path))
    }

    @Test("A matching download is written byte-for-byte")
    func matchingHashWritten() async throws {
        let root = Self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = Self.makeInstaller(root: root, serving: .success(Self.goodPayload))

        try await installer.install()
        #expect(try Data(contentsOf: installer.scriptURL) == Self.goodPayload)
    }

    @Test("A failed re-download leaves the good installed copy in place")
    func failedReinstallKeepsGoodCopy() async throws {
        let root = Self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try await Self.makeInstaller(root: root, serving: .success(Self.goodPayload)).install()

        let bad = Self.makeInstaller(root: root, serving: .success(Data("tampered".utf8)))
        await #expect(throws: MermaidInstallError.self) { try await bad.install() }
        #expect(try Data(contentsOf: bad.scriptURL) == Self.goodPayload)
    }

    @Test("A file edited on disk after install is not served")
    func tamperedFileNotServed() throws {
        let root = Self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = Self.makeInstaller(root: root, serving: .success(Self.goodPayload))
        try installer.commit(Self.goodPayload)
        try Data("evil()".utf8).write(to: installer.scriptURL)

        let cache = MermaidScriptCache(expectedSHA256: installer.expectedSHA256,
                                       candidates: { [installer.scriptURL] })
        #expect(cache.script() == nil)
    }

    @Test("The pinned hash and URL name one exact release")
    func pinIsExact() {
        #expect(Mermaid.sha256.count == 64)
        #expect(Mermaid.downloadURL.absoluteString
                == "https://cdn.jsdelivr.net/npm/mermaid@\(Mermaid.version)/dist/mermaid.min.js")
        #expect(Mermaid.version.split(separator: ".").count == 3)
    }

    // MARK: - Layout

    @Test("Installed under runtime/mermaid/<version>/mermaid.min.js")
    func pathLayout() {
        let root = URL(fileURLWithPath: "/tmp/support", isDirectory: true)
        let installer = Self.makeInstaller(root: root, serving: .success(Data()))
        #expect(installer.scriptURL.path == "/tmp/support/runtime/mermaid/1.2.3/mermaid.min.js")
        #expect(installer.componentDirectory.path == "/tmp/support/runtime/mermaid")
    }

    @Test("Installing a version prunes the previous one; remove deletes all")
    func pruneAndRemove() async throws {
        let root = Self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let old = Self.makeInstaller(root: root, serving: .success(Self.goodPayload), version: "1.0.0")
        try await old.install()
        let new = Self.makeInstaller(root: root, serving: .success(Self.goodPayload), version: "2.0.0")
        try await new.install()

        #expect(!FileManager.default.fileExists(atPath: old.versionDirectory.path))
        #expect(FileManager.default.fileExists(atPath: new.scriptURL.path))

        try new.remove()
        #expect(!FileManager.default.fileExists(atPath: new.componentDirectory.path))
        try new.remove()   // idempotent
    }

    // MARK: - Runtime state

    @Test("Runtime: notInstalled → install → installed → remove → notInstalled")
    @MainActor
    func runtimeLifecycle() async throws {
        let root = Self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = Self.makeInstaller(root: root, serving: .success(Self.goodPayload))
        let cache = MermaidScriptCache(expectedSHA256: installer.expectedSHA256,
                                       candidates: { [installer.scriptURL] })
        let runtime = MermaidRuntime(installer: installer, cache: cache)
        #expect(runtime.state == .notInstalled)

        await runtime.install()
        #expect(runtime.state == .installed)
        #expect(runtime.installedScript() == String(decoding: Self.goodPayload, as: UTF8.self))

        runtime.remove()
        #expect(runtime.state == .notInstalled)
        #expect(runtime.installedScript() == nil)
    }

    @Test("Runtime: offline install fails with a readable message and writes nothing")
    @MainActor
    func runtimeOffline() async {
        let root = Self.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let installer = Self.makeInstaller(root: root,
                                           serving: .failure(URLError(.notConnectedToInternet)))
        let cache = MermaidScriptCache(expectedSHA256: installer.expectedSHA256,
                                       candidates: { [installer.scriptURL] })
        let runtime = MermaidRuntime(installer: installer, cache: cache)

        await runtime.install()
        guard case .failed(let message) = runtime.state else {
            Issue.record("expected .failed, got \(runtime.state)")
            return
        }
        #expect(message.contains("offline"))
        #expect(!FileManager.default.fileExists(atPath: installer.scriptURL.path))
    }

    // MARK: - Renderer

    @Test("Fence detection")
    func detectsFence() {
        #expect(MarkdownRenderer.needsMermaid("```mermaid\ngraph TD\nA-->B\n```"))
        #expect(MarkdownRenderer.needsMermaid("```Mermaid\ngraph TD\n```"))
        #expect(!MarkdownRenderer.needsMermaid("```swift\nlet x = 1\n```"))
        #expect(!MarkdownRenderer.needsMermaid("mermaid is a diagram tool"))
    }

    @Test("Not installed: the fence stays a code block and no placeholder is left")
    func rendererFallback() {
        let doc = "# Plan\n\n```mermaid\ngraph TD\n  A-->B\n```\n"
        let html = MarkdownRenderer.html(for: doc, isDark: false, enableMermaid: true,
                                         mermaidScript: nil)
        #expect(!html.contains("{{mermaidJS}}"))
        #expect(!html.contains("{{mermaidTheme}}"))
        #expect(html.contains("\\`\\`\\`mermaid"))
    }

    @Test("Installed: the script ships only when opted in and fenced")
    func rendererGating() {
        let script = "/* fixture-mermaid */"
        let fenced = "```mermaid\nA-->B\n```"
        #expect(MarkdownRenderer.html(for: fenced, isDark: false, enableMermaid: true,
                                      mermaidScript: script).contains(script))
        #expect(!MarkdownRenderer.html(for: fenced, isDark: false, enableMermaid: false,
                                       mermaidScript: script).contains(script))
        #expect(!MarkdownRenderer.html(for: "no fence", isDark: false, enableMermaid: true,
                                       mermaidScript: script).contains(script))
    }

    @Test("The script lookup is skipped entirely for a document without a fence")
    func lookupIsLazy() {
        var looked = false
        func lookup() -> String? {
            looked = true
            return nil
        }
        _ = MarkdownRenderer.html(for: "plain prose", isDark: false, enableMermaid: true,
                                  mermaidScript: lookup())
        #expect(!looked)
    }
}
