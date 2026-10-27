import XCTest
@testable import LlmIdeMacLib

/// The System page's file bridge (G3): the `openFile` message, the native `file`
/// call, the confinement of both to the project's graph repo, the bounded and
/// lossy read, the language map, and the `open` targets Explorer and the code
/// graph add. Confinement runs against a real temp-dir fixture, symlinks included.
@MainActor
final class SystemBridgeFileTests: XCTestCase {

    // MARK: openFile decode

    func testOpenFileDecodesPathAndLine() {
        XCTAssertEqual(
            SystemBridgeInbound.decode(["type": "openFile", "path": "src/a.swift", "line": 12]),
            .openFile(SystemOpenFileRequest(path: "src/a.swift", line: 12)))
    }

    func testOpenFileWithoutALineOrWithANullLineHasNoLine() {
        XCTAssertEqual(
            SystemBridgeInbound.decode(["type": "openFile", "path": "src/a.swift"]),
            .openFile(SystemOpenFileRequest(path: "src/a.swift", line: nil)))
        XCTAssertEqual(
            SystemBridgeInbound.decode(["type": "openFile", "path": "src/a.swift", "line": NSNull()]),
            .openFile(SystemOpenFileRequest(path: "src/a.swift", line: nil)))
    }

    func testOpenFileRefusesBadPathsAndIsIgnored() {
        let refused: [[String: Any]] = [
            ["type": "openFile"],
            ["type": "openFile", "path": ""],
            ["type": "openFile", "path": 3],
            ["type": "openFile", "path": "/etc/passwd"],
            ["type": "openFile", "path": "../secret.txt"],
            ["type": "openFile", "path": "src/../../secret.txt"],
            ["type": "openFile", "path": "a\u{0}b.swift"],
            ["type": "openFile", "path": String(repeating: "a", count: 1025)],
        ]
        for body in refused {
            XCTAssertNil(SystemBridgeInbound.decode(body), "\(body) must be ignored")
        }
    }

    func testOpenFileRefusesBadLines() {
        let refused: [Any] = [0, -1, 10_000_001, 2.5, "3", true, [1]]
        for line in refused {
            XCTAssertNil(SystemBridgeInbound.decode(["type": "openFile", "path": "a.swift", "line": line]),
                         "line \(line) must be ignored")
        }
        // The top of the range is allowed.
        XCTAssertEqual(
            SystemBridgeInbound.decode(["type": "openFile", "path": "a.swift", "line": 10_000_000]),
            .openFile(SystemOpenFileRequest(path: "a.swift", line: 10_000_000)))
    }

    func testOpenFileIgnoresUnknownKeys() {
        XCTAssertEqual(
            SystemBridgeInbound.decode(["type": "openFile", "path": "a.swift", "extra": ["x": 1], "root": "/"]),
            .openFile(SystemOpenFileRequest(path: "a.swift", line: nil)))
    }

    // MARK: path validation

    func testPathLengthIsCountedInUTF8Bytes() {
        XCTAssertEqual(SystemBridge.validRelativePath(String(repeating: "a", count: 1024)),
                       String(repeating: "a", count: 1024))
        XCTAssertNil(SystemBridge.validRelativePath(String(repeating: "a", count: 1025)))
        // "é" is two bytes: 512 of them fit exactly, 513 do not.
        XCTAssertNotNil(SystemBridge.validRelativePath(String(repeating: "é", count: 512)))
        XCTAssertNil(SystemBridge.validRelativePath(String(repeating: "é", count: 513)))
    }

    func testPathValidationRefusesEscapesAndKeepsDotsInNames() {
        XCTAssertNil(SystemBridge.validRelativePath(""))
        XCTAssertNil(SystemBridge.validRelativePath("/abs"))
        XCTAssertNil(SystemBridge.validRelativePath(".."))
        XCTAssertNil(SystemBridge.validRelativePath("a/.."))
        XCTAssertEqual(SystemBridge.validRelativePath("a/..b/c..d.swift"), "a/..b/c..d.swift")
        XCTAssertEqual(SystemBridge.validRelativePath("./a.swift"), "./a.swift")
    }

    // MARK: native file decode

    func testNativeFileDecodesTheValidatedPath() {
        XCTAssertEqual(
            SystemBridgeInbound.decode(["type": "native", "id": "f1", "name": "file", "path": "src/a.swift", "extra": 1]),
            .native(SystemBridgeNativeRequest(id: "f1", call: .file(path: "src/a.swift"))))
    }

    func testNativeFileWithABadPathIsRefusedWithItsId() {
        let refused: [[String: Any]] = [
            ["type": "native", "id": "f2", "name": "file"],
            ["type": "native", "id": "f2", "name": "file", "path": "/etc/hosts"],
            ["type": "native", "id": "f2", "name": "file", "path": "../x"],
            ["type": "native", "id": "f2", "name": "file", "path": "a\u{0}"],
            ["type": "native", "id": "f2", "name": "file", "path": String(repeating: "a", count: 1025)],
        ]
        for body in refused {
            XCTAssertEqual(SystemBridgeInbound.decode(body), .native(SystemBridgeNativeRequest(id: "f2", call: nil)),
                           "\(body) must be refused with its id")
        }
    }

    // MARK: confinement and the file reply

    private var root: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("g3-\(UUID().uuidString)", isDirectory: true)
        root = base.appendingPathComponent("repo", isDirectory: true)
        let outside = base.appendingPathComponent("outside", isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("src"), withIntermediateDirectories: true)
        try fm.createDirectory(at: outside, withIntermediateDirectories: true)

        try Data("let a = 1\nlet b = 2\n".utf8).write(to: root.appendingPathComponent("src/a.swift"))
        try Data("secret\n".utf8).write(to: outside.appendingPathComponent("secret.txt"))
        // A symlink inside the root (allowed) and two that escape it (refused).
        try fm.createSymbolicLink(at: root.appendingPathComponent("link-in.swift"),
                                  withDestinationURL: root.appendingPathComponent("src/a.swift"))
        try fm.createSymbolicLink(at: root.appendingPathComponent("link-out.txt"),
                                  withDestinationURL: outside.appendingPathComponent("secret.txt"))
        try fm.createSymbolicLink(at: root.appendingPathComponent("linkdir"), withDestinationURL: outside)
        try fm.createDirectory(at: root.appendingPathComponent("dir"), withIntermediateDirectories: true)
        // A binary file: a NUL inside the first 8 KiB.
        try Data([0x50, 0x4B, 0x00, 0x03, 0x14]).write(to: root.appendingPathComponent("bin.dat"))
        // A file that is text until a NUL past the 8 KiB sniff window: still text.
        var late = Data(repeating: 0x61, count: 9_000)
        late.append(0)
        try late.write(to: root.appendingPathComponent("late-nul.txt"))
        // Invalid UTF-8 (0xFF, a lone continuation byte), decoded leniently.
        try Data([0x6F, 0x6B, 0xFF, 0x20, 0x80, 0x0A]).write(to: root.appendingPathComponent("bad.txt"))
        // Larger than the 256 KiB read cap.
        try Data(repeating: 0x61, count: 300 * 1024).write(to: root.appendingPathComponent("big.txt"))
    }

    override func tearDownWithError() throws {
        if let root {
            try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
        }
        try super.tearDownWithError()
    }

    func testConfinementAllowsRegularFilesInsideTheRoot() throws {
        let direct = try XCTUnwrap(SystemBridge.confinedFile(relativePath: "src/a.swift", repoRoot: root))
        XCTAssertEqual(direct.lastPathComponent, "a.swift")
        // A symlink whose target stays inside the root resolves to that target.
        let viaLink = try XCTUnwrap(SystemBridge.confinedFile(relativePath: "link-in.swift", repoRoot: root))
        XCTAssertEqual(viaLink.resolvingSymlinksInPath().path, direct.resolvingSymlinksInPath().path)
    }

    func testConfinementRefusesEscapesDirectoriesMissingAndNonRegularFiles() {
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "link-out.txt", repoRoot: root), "symlink out of the root")
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "linkdir/secret.txt", repoRoot: root), "dir symlink out")
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "dir", repoRoot: root), "a directory")
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "missing.swift", repoRoot: root), "missing")
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "../outside/secret.txt", repoRoot: root), "dot-dot")
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "", repoRoot: root), "the root itself")
    }

    private func replyObject(_ reply: SystemBridge.NativeReply) throws -> [String: Any] {
        let data = try XCTUnwrap(reply.bodyJSON.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testTextFileReplyCarriesTextSizeAndLanguage() throws {
        let reply = SystemBridge.fileNativeReply(relativePath: "src/a.swift", repoRoot: root)
        XCTAssertEqual(reply.status, 200)
        XCTAssertNil(reply.error)
        let body = try replyObject(reply)
        XCTAssertEqual(body["path"] as? String, "src/a.swift")
        XCTAssertEqual(body["text"] as? String, "let a = 1\nlet b = 2\n")
        XCTAssertEqual(body["truncated"] as? Bool, false)
        XCTAssertEqual(body["bytes"] as? Int, 20)
        XCTAssertEqual(body["language"] as? String, "swift")
    }

    func testAFileOverTheCapIsTruncatedAndReportsItsTotalSize() throws {
        let reply = SystemBridge.fileNativeReply(relativePath: "big.txt", repoRoot: root)
        XCTAssertEqual(reply.status, 200)
        let body = try replyObject(reply)
        XCTAssertEqual(body["truncated"] as? Bool, true)
        XCTAssertEqual(body["bytes"] as? Int, 300 * 1024)
        XCTAssertEqual((body["text"] as? String)?.utf8.count, SystemBridge.maxFileReadBytes)
        XCTAssertNil(body["binary"])
    }

    func testABinaryFileIsMarkedAndCarriesNoText() throws {
        let reply = SystemBridge.fileNativeReply(relativePath: "bin.dat", repoRoot: root)
        XCTAssertEqual(reply.status, 200)
        let body = try replyObject(reply)
        XCTAssertEqual(body["binary"] as? Bool, true)
        XCTAssertEqual(body["bytes"] as? Int, 5)
        XCTAssertNil(body["text"])
        XCTAssertNil(body["truncated"])
    }

    func testANulPastTheSniffWindowDoesNotMakeAFileBinary() throws {
        let body = try replyObject(SystemBridge.fileNativeReply(relativePath: "late-nul.txt", repoRoot: root))
        XCTAssertNil(body["binary"])
        XCTAssertNotNil(body["text"])
    }

    func testInvalidUTF8IsDecodedLeniently() throws {
        let reply = SystemBridge.fileNativeReply(relativePath: "bad.txt", repoRoot: root)
        XCTAssertEqual(reply.status, 200)
        let text = try XCTUnwrap(try replyObject(reply)["text"] as? String)
        XCTAssertTrue(text.hasPrefix("ok"))
        XCTAssertTrue(text.contains("\u{FFFD}"), "invalid bytes become U+FFFD, not a failure")
        XCTAssertTrue(text.hasSuffix("\n"))
    }

    func testRefusedAndMissingFilesAreNotFound() throws {
        for path in ["link-out.txt", "linkdir/secret.txt", "dir", "missing.swift"] {
            let reply = SystemBridge.fileNativeReply(relativePath: path, repoRoot: root)
            XCTAssertEqual(reply.status, 404, path)
            XCTAssertEqual(reply.error, "not_found", path)
            XCTAssertEqual(reply.bodyJSON, "null", path)
        }
        let noProject = SystemBridge.fileNativeReply(relativePath: "src/a.swift", repoRoot: nil)
        XCTAssertEqual(noProject.status, 404)
    }

    func testLanguageComesFromTheExtensionOrIsNull() throws {
        let samples: [(name: String, language: String?)] = [
            ("x.swift", "swift"), ("x.tsx", "typescript"), ("x.ts", "typescript"),
            ("x.mjs", "javascript"), ("x.h", "c"), ("x.yml", "yaml"), ("x.SH", "shell"),
            ("x.kt", "kotlin"), ("x.unknown", nil), ("Makefile", nil),
        ]
        for sample in samples {
            try Data("x\n".utf8).write(to: root.appendingPathComponent(sample.name))
            let body = try replyObject(SystemBridge.fileNativeReply(relativePath: sample.name, repoRoot: root))
            if let language = sample.language {
                XCTAssertEqual(body["language"] as? String, language, sample.name)
            } else {
                XCTAssertTrue(body["language"] is NSNull, sample.name)
            }
        }
    }

    // MARK: open targets

    func testExplorerAndCodeGraphOpenTheirSections() {
        let on: (AppFeature) -> Bool = { _ in true }
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "explorer", isEnabled: on), .explorer)
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "codeGraph", isEnabled: on), .codeGraph)
    }

    func testExplorerAndCodeGraphRespectDisabledFeatures() {
        XCTAssertNil(SystemBridge.section(forOpenTarget: "explorer", isEnabled: { _ in false }))
        XCTAssertNil(SystemBridge.section(forOpenTarget: "codeGraph", isEnabled: { _ in false }))
        // Each is gated by its own feature.
        XCTAssertNil(SystemBridge.section(forOpenTarget: "explorer", isEnabled: { $0 != .fileExplorer }))
        XCTAssertEqual(SystemBridge.section(forOpenTarget: "explorer", isEnabled: { $0 != .codeGraph3D }), .explorer)
    }

    func testUnknownTargetsStayNil() {
        let on: (AppFeature) -> Bool = { _ in true }
        XCTAssertNil(SystemBridge.section(forOpenTarget: "Explorer", isEnabled: on))
        XCTAssertNil(SystemBridge.section(forOpenTarget: "graph", isEnabled: on))
    }

    // MARK: Explorer handoff

    func testPendingOpenFileIsTakenOnce() throws {
        let shell = ShellState()
        XCTAssertNil(shell.pendingOpenFile)
        let url = root.appendingPathComponent("src/a.swift")
        shell.pendingOpenFile = ShellState.PendingOpenFile(url: url, line: 2)
        let taken = try XCTUnwrap(shell.takePendingOpenFile())
        XCTAssertEqual(taken.url, url)
        XCTAssertEqual(taken.line, 2)
        XCTAssertNil(shell.pendingOpenFile, "a consumed handoff must not re-apply")
        XCTAssertNil(shell.takePendingOpenFile())
    }

    func testTwoRequestsForTheSameFileAreDistinct() {
        let url = URL(fileURLWithPath: "/tmp/a.swift")
        let first = ShellState.PendingOpenFile(url: url, line: nil)
        let second = ShellState.PendingOpenFile(url: url, line: nil)
        XCTAssertNotEqual(first, second, "each request has its own id, so onChange fires for each")
    }

    func testLeavingExplorerDropsAnUnconsumedHandoff() {
        let shell = ShellState()
        shell.section = .explorer
        shell.pendingOpenFile = ShellState.PendingOpenFile(url: root.appendingPathComponent("src/a.swift"), line: 1)
        shell.section = .library
        XCTAssertNil(shell.pendingOpenFile, "a handoff must not survive a visit elsewhere")
        XCTAssertNil(shell.takePendingOpenFile())
    }

    func testSettingExplorerKeepsTheHandoffForExplorer() {
        let shell = ShellState()
        shell.pendingOpenFile = ShellState.PendingOpenFile(url: root.appendingPathComponent("src/a.swift"), line: nil)
        shell.section = .explorer
        XCTAssertNotNil(shell.pendingOpenFile)
    }

    func testDiscardDropsTheHandoff() {
        let shell = ShellState()
        shell.pendingOpenFile = ShellState.PendingOpenFile(url: root.appendingPathComponent("src/a.swift"), line: nil)
        shell.discardPendingOpenFile()
        XCTAssertNil(shell.takePendingOpenFile())
    }

    // MARK: sensitive-file denylist

    private func makeFile(_ relative: String, _ text: String = "x\n") throws {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    func testSecretNamesAreRefusedForBothCalls() throws {
        let names = [
            ".git/config", ".GIT/CONFIG", "src/.git/config", "a/b/.Git/HEAD",
            ".ssh/known_hosts", ".gnupg/pubring.kbx", ".aws/credentials", ".kube/config",
            ".docker/config.json", ".Docker/x",
            ".env", "src/.env.local", "src/.ENV.Production",
            "keys/server.pem", "cert.KEY", "a.p12", "a.pfx",
            "id_rsa", "id_rsa.pub", "id_ed25519", "id_ecdsa-sk", "id_dsa", "ID_RSA.PUB",
            "login.keychain-db", "x.keychain",
            ".netrc", ".npmrc", ".pypirc", "credentials", "credentials.json", "app.mobileprovision",
        ]
        for (index, name) in names.enumerated() {
            let dir = "case\(index)"
            try makeFile("\(dir)/\(name)")
            try makeFile("\(dir)/plain.txt")
            let path = "\(dir)/\(name)"
            XCTAssertNotNil(SystemBridge.confinedFile(relativePath: "\(dir)/plain.txt", repoRoot: root),
                            "control for \(dir) must be allowed")
            XCTAssertNil(SystemBridge.confinedFile(relativePath: path, repoRoot: root), "openFile must refuse \(path)")
            XCTAssertNil(SystemBridge.confinedFile(relativePath: path, repoRoot: root, forText: true),
                         "file must refuse \(path)")
            let reply = SystemBridge.fileNativeReply(relativePath: path, repoRoot: root)
            XCTAssertEqual(reply.status, 404, path)
            XCTAssertEqual(reply.error, "not_found", path)
            XCTAssertEqual(reply.bodyJSON, "null", path)
        }
    }

    func testSecretFragmentsAreRefusedForTheFileCallOnly() throws {
        let names = ["docs/my-token.txt", "config/secrets.md", "client-SECRET.json", "tokens.txt"]
        for (index, name) in names.enumerated() {
            try makeFile("frag\(index)/\(name)")
            XCTAssertNotNil(SystemBridge.confinedFile(relativePath: "frag\(index)/\(name)", repoRoot: root),
                            "openFile does not apply the fragment rule: \(name)")
            XCTAssertNil(SystemBridge.confinedFile(relativePath: "frag\(index)/\(name)", repoRoot: root, forText: true),
                         "file refuses \(name)")
        }
        XCTAssertEqual(SystemBridge.fileNativeReply(relativePath: "docs/my-token.txt", repoRoot: root).status, 404)
    }

    func testOrdinaryNamesThatLookSimilarAreStillAllowed() throws {
        let names = ["src/environment.txt", "src/keyboard.swift", "src/idle.txt", "docs/readme.md", "src/key.swift"]
        for name in names {
            try makeFile(name)
            XCTAssertNotNil(SystemBridge.confinedFile(relativePath: name, repoRoot: root), name)
            XCTAssertNotNil(SystemBridge.confinedFile(relativePath: name, repoRoot: root, forText: true), name)
        }
    }

    func testASymlinkIntoASensitivePathIsRefused() throws {
        try makeFile(".git/config")
        try makeFile(".env.local")
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("notes.txt"),
                                                   withDestinationURL: root.appendingPathComponent(".git/config"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link-env.txt"),
                                                   withDestinationURL: root.appendingPathComponent(".env.local"))
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "notes.txt", repoRoot: root))
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "link-env.txt", repoRoot: root, forText: true))
    }

    // MARK: root refusal

    func testOverBroadRootsAreRefused() throws {
        let home = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().standardizedFileURL
        var roots = [URL(fileURLWithPath: "/"), home, home.deletingLastPathComponent()]
        roots += ["/Users", "/Volumes", "/private", "/System", "/Library", "/Applications"].map { URL(fileURLWithPath: $0) }
        for candidate in roots {
            XCTAssertNil(SystemBridge.confinedFile(relativePath: "src/a.swift", repoRoot: candidate), candidate.path)
            XCTAssertEqual(SystemBridge.fileNativeReply(relativePath: "src/a.swift", repoRoot: candidate).status, 404,
                           candidate.path)
        }
    }

    func testOverBroadRootRulesInIsolation() {
        let home = "/Users/someone"
        XCTAssertTrue(SystemBridge.isOverBroadRoot("/", home: home))
        XCTAssertTrue(SystemBridge.isOverBroadRoot("/Users/someone", home: home))
        XCTAssertTrue(SystemBridge.isOverBroadRoot("/Users", home: home))
        XCTAssertTrue(SystemBridge.isOverBroadRoot("/Volumes", home: home))
        XCTAssertTrue(SystemBridge.isOverBroadRoot("/private", home: home))
        XCTAssertFalse(SystemBridge.isOverBroadRoot("/Users/someone/code/repo", home: home), "inside home is fine")
        XCTAssertFalse(SystemBridge.isOverBroadRoot("/Users/someone2", home: home), "a sibling is not an ancestor")
        XCTAssertFalse(SystemBridge.isOverBroadRoot("/private/var/folders/x/repo", home: home))
        XCTAssertFalse(SystemBridge.isOverBroadRoot("/tmp/repo", home: home))
    }

    func testASymlinkedRootIsRefusedAndTheRealRootStillWorks() throws {
        let link = root.deletingLastPathComponent().appendingPathComponent("linked-repo")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root)
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "src/a.swift", repoRoot: link), "a symlinked root")
        XCTAssertEqual(SystemBridge.fileNativeReply(relativePath: "src/a.swift", repoRoot: link).status, 404)
        XCTAssertNotNil(SystemBridge.confinedFile(relativePath: "src/a.swift", repoRoot: root), "control")
    }

    // MARK: open without following links, and never blocking

    func testAFifoIsRefusedQuicklyAndNeverBlocks() throws {
        let fifo = root.appendingPathComponent("pipe.fifo")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        let started = Date()
        XCTAssertNil(SystemBridge.confinedFile(relativePath: "pipe.fifo", repoRoot: root), "not a regular file")
        XCTAssertNil(SystemBridge.openRegularFile(at: fifo), "the descriptor is not regular")
        XCTAssertEqual(SystemBridge.fileNativeReply(relativePath: "pipe.fifo", repoRoot: root).status, 404)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "a FIFO must not block the open")
    }

    func testARegularFileOpensWithItsSize() throws {
        let url = try XCTUnwrap(SystemBridge.confinedFile(relativePath: "src/a.swift", repoRoot: root))
        let opened = try XCTUnwrap(SystemBridge.openRegularFile(at: url))
        XCTAssertEqual(opened.size, 20)
        XCTAssertEqual(try opened.handle.readToEnd()?.count, 20)
    }

    func testAFileSwappedForASymlinkAfterValidationIsRefusedAtOpen() throws {
        let url = try XCTUnwrap(SystemBridge.confinedFile(relativePath: "src/a.swift", repoRoot: root))
        XCTAssertNotNil(SystemBridge.openRegularFile(at: url), "control: the file opens before the swap")
        let secret = root.deletingLastPathComponent().appendingPathComponent("outside/secret.txt")
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: secret)
        XCTAssertNil(SystemBridge.openRegularFile(at: url), "O_NOFOLLOW refuses the swapped-in link")
    }
}
