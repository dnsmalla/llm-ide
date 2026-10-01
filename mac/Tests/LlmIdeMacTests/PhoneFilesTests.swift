import XCTest
import SharedProtocol
@testable import LlmIdeMacLib

final class PhoneFilesTests: XCTestCase {
    private var tmp: URL!
    private var root: URL!

    private func write(_ rel: String, _ text: String) throws {
        let url = root.appendingPathComponent(rel)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    override func setUpWithError() throws {
        tmp = FileManager.default.temporaryDirectory.appendingPathComponent("phonefiles-\(UUID().uuidString)")
        root = tmp.appendingPathComponent("proj")
        try write("src/main.swift", "let token: String = \"abc\"\nprint(1)\n")
        try write("README.md", "# hi\n")
        try write(".env", "SECRET=1\n")
        try write(".git/config", "[core]\n")
        try write(".aws/credentials", "aws_secret=1\n")
        try write("node_modules/pkg/index.js", "x\n")
        try write("keys/server.pem", "-----BEGIN-----\n")
        try write("keys/id_rsa", "-----BEGIN-----\n")
        try write("keys/ok.txt", "fine\n")
        try write("leak-target.txt", "outside\n")
        try FileManager.default.moveItem(at: root.appendingPathComponent("leak-target.txt"), to: tmp.appendingPathComponent("outside.txt"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link.txt"),
                                                   withDestinationURL: tmp.appendingPathComponent("outside.txt"))
        try Data([0x00, 0x01, 0x02, 0x03]).write(to: root.appendingPathComponent("blob.bin"))
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: tmp) }

    func testListingHidesDotfilesSecretsAndBuildFolders() {
        let names = PhoneFiles.list(root: root, relative: "").entries.map(\.name)
        XCTAssertTrue(names.contains("src") && names.contains("README.md"))
        for hidden in [".env", ".git", ".aws", "node_modules", "link.txt"] where hidden != "link.txt" {
            XCTAssertFalse(names.contains(hidden), "\(hidden) must not be listed")
        }
        let keys = PhoneFiles.list(root: root, relative: "keys").entries.map(\.name)
        XCTAssertEqual(keys, ["ok.txt"], "pem and id_rsa are denied")
    }

    func testNothingHiddenCanBeReadByNameEither() {
        for path in [".env", ".git/config", ".aws/credentials", "node_modules/pkg/index.js", "keys/server.pem", "keys/id_rsa"] {
            let f = PhoneFiles.read(root: root, relative: path)
            XCTAssertNil(f.text, path)
            XCTAssertNotNil(f.error, path)
        }
    }

    func testEscapesAreRefused() {
        for bad in ["../outside.txt", "src/../../outside.txt", "/etc/passwd", "link.txt"] {
            let f = PhoneFiles.read(root: root, relative: bad)
            XCTAssertNil(f.text, bad)
        }
        XCTAssertNotNil(PhoneFiles.list(root: root, relative: "..").error)
    }

    func testCodeIsShownVerbatimExceptKnownTokenShapes() throws {
        let f = PhoneFiles.read(root: root, relative: "src/main.swift")
        XCTAssertTrue(f.text?.contains("let token: String") == true, "ordinary code must not be mangled")
        try write("src/leak.swift", "let k = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\"\n")
        let leak = PhoneFiles.read(root: root, relative: "src/leak.swift")
        XCTAssertFalse(leak.text?.contains("ghp_abcdefghijklmnopqrstuvwxyz") == true)
    }

    func testBinaryAndOversizedFiles() throws {
        XCTAssertEqual(PhoneFiles.read(root: root, relative: "blob.bin").error, "Binary file — not shown.")
        try write("big.txt", String(repeating: "line of text\n", count: 40_000))
        let big = PhoneFiles.read(root: root, relative: "big.txt")
        XCTAssertTrue(big.truncated)
        XCTAssertLessThanOrEqual(big.text?.utf8.count ?? 0, PhoneFiles.maxReadBytes + 100)
    }

    func testAnEnormousUnbrokenLineIsBoundedAndFast() throws {
        try write("min.js", String(repeating: "x", count: 190_000))
        let started = Date()
        let f = PhoneFiles.read(root: root, relative: "min.js")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertTrue(f.truncated)
    }

    func testASymlinkToAHiddenTargetIsNotServedOrListed() throws {
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("notes.txt"),
                                                   withDestinationURL: root.appendingPathComponent(".env"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("cfg"),
                                                   withDestinationURL: root.appendingPathComponent(".git"))
        XCTAssertNil(PhoneFiles.read(root: root, relative: "notes.txt").text, "notes.txt -> .env must not leak")
        XCTAssertNil(PhoneFiles.read(root: root, relative: "cfg/config").text, "cfg -> .git must not leak")
        let names = PhoneFiles.list(root: root, relative: "").entries.map(\.name)
        XCTAssertFalse(names.contains("notes.txt") || names.contains("cfg"))
    }

    func testSecretNamesAreDeniedInAnyCase() throws {
        try write("keys/ID_RSA", "-----BEGIN-----\n")
        try write("keys/Server.PEM", "x\n")
        try write("deploy/prod.tfstate", "{}\n")
        for path in ["keys/ID_RSA", "keys/Server.PEM", "deploy/prod.tfstate"] {
            XCTAssertNotNil(PhoneFiles.read(root: root, relative: path).error, path)
        }
        XCTAssertFalse(PhoneFiles.list(root: root, relative: "keys").entries.map(\.name).contains("ID_RSA"))
    }

    func testPrivateKeyBlocksAreRedactedEvenInAnOrdinaryFile() throws {
        try write("src/embedded.txt", "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef\n-----END RSA PRIVATE KEY-----\nafter\n")
        let text = PhoneFiles.read(root: root, relative: "src/embedded.txt").text ?? ""
        XCTAssertTrue(text.contains("before") && text.contains("after"))
        XCTAssertTrue(text.contains("[REDACTED PRIVATE KEY]"))
        XCTAssertFalse(text.contains("MIIEabc"))
    }

    func testRegularFilesOnly() throws {
        let fifo = root.appendingPathComponent("pipe.txt").path
        XCTAssertEqual(mkfifo(fifo, 0o600), 0)
        let started = Date()
        let f = PhoneFiles.read(root: root, relative: "pipe.txt")     // would block forever on open() if attempted
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        XCTAssertNil(f.text)
    }
}
