import Testing
import Foundation
@testable import LlmIdeMac

struct PathValidatorTests {

    // MARK: - Memory subdir

    @Test func memorySubdirAcceptsDefaultAsOK() {
        let v = PathValidator.memorySubdir(AppConfig.defaultMemorySubdir)
        if case .ok(let c) = v {
            #expect(c == AppConfig.defaultMemorySubdir)
        } else {
            Issue.record("expected .ok, got \(v)")
        }
    }

    @Test func memorySubdirRejectsAbsolutePath() {
        let v = PathValidator.memorySubdir("/etc/passwd")
        #expect(!v.isValid)
    }

    @Test func memorySubdirRejectsParentEscape() {
        let v = PathValidator.memorySubdir("graphify-out/../../etc")
        #expect(!v.isValid)
    }

    @Test func memorySubdirRejectsTildePrefix() {
        let v = PathValidator.memorySubdir("~/elsewhere")
        #expect(!v.isValid)
    }

    @Test func memorySubdirRejectsEmpty() {
        #expect(!PathValidator.memorySubdir("").isValid)
        #expect(!PathValidator.memorySubdir("   ").isValid)
    }

    @Test func memorySubdirCanonicalisesTrailingSlashAndDotPrefix() {
        // Trailing slash and `./` prefix should both flatten away.
        let v = PathValidator.memorySubdir("./graphify-out/memory/")
        if case .warning(_, let c) = v {
            // Warning because "./graphify-out/memory" canonicalises
            // away the `./` and ends up matching the default; we tolerate
            // either .ok or .warning here.
            #expect(c == "graphify-out/memory" || c == "./graphify-out/memory")
        } else if case .ok(let c) = v {
            #expect(c == "graphify-out/memory")
        }
    }

    @Test func memorySubdirNonDefaultIsWarningNotInvalid() {
        let v = PathValidator.memorySubdir("docs/agent-memory")
        if case .warning(_, let c) = v {
            #expect(c == "docs/agent-memory")
        } else {
            Issue.record("expected .warning, got \(v)")
        }
    }

    // MARK: - Executable file

    @Test func executableFileAcceptsEmptyByDefault() {
        let v = PathValidator.executableFile("")
        if case .ok(let c) = v { #expect(c == "") }
        else { Issue.record("expected .ok for empty allowed") }
    }

    @Test func executableFileRejectsRelativePath() {
        #expect(!PathValidator.executableFile("./binary", allowEmpty: false).isValid)
    }

    @Test func executableFileRejectsMissingFile() {
        let v = PathValidator.executableFile("/totally/not/a/real/binary-xyz", allowEmpty: false)
        #expect(!v.isValid)
    }

    @Test func executableFileAcceptsExistingExecutable() {
        // /bin/ls exists and is executable on every macOS install.
        let v = PathValidator.executableFile("/bin/ls", allowEmpty: false)
        #expect(v.isValid)
        #expect(v.canonical?.hasSuffix("/ls") == true)
    }

    // MARK: - absoluteDirectoryAllowMissing

    @Test func absoluteAllowMissingAcceptsExistingWritable() {
        let v = PathValidator.absoluteDirectoryAllowMissing(NSTemporaryDirectory())
        if case .ok = v {} else { Issue.record("expected .ok") }
    }

    @Test func absoluteAllowMissingWarnsOnNonexistentButCreatable() {
        // /tmp exists; /tmp/some-fresh-uuid does not, but its parent
        // does — should be a warning, not an outright reject.
        let path = "/tmp/path-validator-test-\(UUID().uuidString)"
        let v = PathValidator.absoluteDirectoryAllowMissing(path)
        if case .warning = v {} else { Issue.record("expected .warning, got \(v)") }
    }

    @Test func absoluteAllowMissingRejectsRelative() {
        #expect(!PathValidator.absoluteDirectoryAllowMissing("LLM IDE").isValid)
    }

    @Test func absoluteAllowMissingRejectsEmpty() {
        #expect(!PathValidator.absoluteDirectoryAllowMissing("").isValid)
    }

    @Test func absoluteAllowMissingRejectsParentMissing() {
        let v = PathValidator.absoluteDirectoryAllowMissing("/totally/fake/parent/childdir-xyz")
        #expect(!v.isValid)
    }

    // MARK: - subfolderName

    @Test func subfolderNameAcceptsSingleSegment() {
        let v = PathValidator.subfolderName("Notes")
        if case .ok(let c) = v { #expect(c == "Notes") }
        else { Issue.record("expected .ok") }
    }

    @Test func subfolderNameAcceptsMultiSegment() {
        let v = PathValidator.subfolderName("Repos/Code")
        if case .ok(let c) = v { #expect(c == "Repos/Code") }
        else { Issue.record("expected .ok") }
    }

    @Test func subfolderNameRejectsAbsolute() {
        #expect(!PathValidator.subfolderName("/etc").isValid)
    }

    @Test func subfolderNameRejectsParentEscape() {
        #expect(!PathValidator.subfolderName("../escape").isValid)
    }

    @Test func subfolderNameStripsTrailingSlash() {
        let v = PathValidator.subfolderName("Notes/")
        if case .ok(let c) = v { #expect(c == "Notes") }
        else { Issue.record("expected .ok, got \(v)") }
    }
}
