import XCTest
@testable import LlmIdeMacLib

/// `ProposedEditResolver` is the single gate between "the model proposed an
/// edit" and "bytes hit the disk". Every test here is a write it must refuse,
/// or a write it must land on exactly the right file with exactly the right
/// content — the two ways an agent edit can quietly destroy work.
final class ProposedEditResolverTests: XCTestCase {

    private typealias Known = ProposedEditResolver.KnownFile

    private func args(_ path: String,
                      content: String? = nil,
                      old: String? = nil,
                      new: String? = nil) -> PendingTool.UpdateFileArgs {
        .init(path: path, content: content, oldText: old, newText: new)
    }

    /// Resolve against an in-memory filesystem so no test touches real files.
    private func resolve(_ a: PendingTool.UpdateFileArgs,
                         attachments: [Known] = [],
                         root: URL? = URL(fileURLWithPath: "/tmp/proj"),
                         allowBasenameFallback: Bool = true,
                         files: [String: String] = [:])
        -> Result<ProposedEdit, ProposedEditError>
    {
        ProposedEditResolver.resolve(
            args: a,
            attachments: attachments,
            projectRoot: root,
            allowBasenameFallback: allowBasenameFallback,
            readFile: { path in
                guard let c = files[path] else {
                    throw CocoaError(.fileNoSuchFile)
                }
                return c
            }
        )
    }

    // MARK: - Anchored edits (the shape used for files read only in part)

    func testAnchoredEditReplacesOnlyTheMatchedRegion() throws {
        let original = "line one\nline two\nline three\n"
        let edit = try resolve(args("a.txt", old: "line two\n", new: "LINE TWO!\n"),
                               files: ["/tmp/proj/a.txt": original]).get()
        XCTAssertEqual(edit.proposed, "line one\nLINE TWO!\nline three\n")
        XCTAssertEqual(edit.original, original, "the pre-edit content must be preserved for the diff")
        XCTAssertEqual(edit.source, .workspace)
    }

    func testAnchoredEditPreservesIndentationExactly() throws {
        let original = "func f() {\n    let x = 1\n}\n"
        let edit = try resolve(args("a.swift", old: "    let x = 1\n", new: "    let x = 2\n"),
                               files: ["/tmp/proj/a.swift": original]).get()
        XCTAssertEqual(edit.proposed, "func f() {\n    let x = 2\n}\n")
    }

    func testEmptyNewTextDeletesTheBlock() throws {
        let edit = try resolve(args("a.txt", old: "gone\n", new: ""),
                               files: ["/tmp/proj/a.txt": "keep\ngone\nkeep\n"]).get()
        XCTAssertEqual(edit.proposed, "keep\nkeep\n")
    }

    func testAmbiguousAnchorIsRefusedRatherThanReplacingTheFirstMatch() {
        let original = "x = 1\ny = 2\nx = 1\n"
        let result = resolve(args("a.txt", old: "x = 1\n", new: "x = 9\n"),
                             files: ["/tmp/proj/a.txt": original])
        guard case .failure(let err) = result else {
            return XCTFail("two matches must not resolve — picking one silently is the bug")
        }
        XCTAssertEqual(err, .anchorAmbiguous(path: "a.txt", count: 2))
        XCTAssertTrue(err.message.contains("appears 2 times"))
    }

    func testMissingAnchorIsRefusedWithARetryHint() {
        let result = resolve(args("a.txt", old: "not here\n", new: "x\n"),
                            files: ["/tmp/proj/a.txt": "something else\n"])
        guard case .failure(let err) = result else { return XCTFail("expected failure") }
        XCTAssertEqual(err, .anchorNotFound(path: "a.txt"))
        // The usual cause is the file changing under the agent, so say so.
        XCTAssertTrue(err.message.contains("may have changed"))
    }

    func testAnEmptyAnchorNeverResolves() {
        // An empty needle matches at offset 0 of every file. The server rejects
        // this shape, but the resolver must not depend on that to stay safe.
        let result = resolve(args("a.txt", old: "", new: "injected\n"),
                            files: ["/tmp/proj/a.txt": "original\n"])
        guard case .failure(let err) = result else {
            return XCTFail("an empty anchor must never resolve to a write")
        }
        XCTAssertEqual(err, .anchorNotFound(path: "a.txt"))
    }

    func testAProposalWithNoEditAtAllNeverResolves() {
        // Neither shape present — must not fall through to "write the file back".
        let result = resolve(args("a.txt"), files: ["/tmp/proj/a.txt": "original\n"])
        guard case .failure = result else {
            return XCTFail("a proposal with no content and no anchor must be refused")
        }
    }

    func testOccurrenceCountingIsNonOverlapping() {
        XCTAssertEqual(ProposedEditResolver.occurrences(of: "aa", in: "aaaa"), 2)
        XCTAssertEqual(ProposedEditResolver.occurrences(of: "x", in: "abc"), 0)
        XCTAssertEqual(ProposedEditResolver.occurrences(of: "", in: "abc"), 0)
    }

    // MARK: - Whole-file rewrites

    func testWholeFileContentReplacesEverything() throws {
        let edit = try resolve(args("a.md", content: "# New\n"),
                               files: ["/tmp/proj/a.md": "# Old\nbody\n"]).get()
        XCTAssertEqual(edit.proposed, "# New\n")
    }

    func testNoOpIsDetectedSoApplyCanBeDisabled() throws {
        let same = "unchanged\n"
        let edit = try resolve(args("a.txt", content: same),
                               files: ["/tmp/proj/a.txt": same]).get()
        XCTAssertTrue(edit.isNoOp)
        XCTAssertEqual(edit.stats.added, 0)
        XCTAssertEqual(edit.stats.removed, 0)
    }

    // MARK: - Path containment

    func testWorkspaceRelativePathResolvesAgainstTheProjectRoot() throws {
        // What find-code returns. It must NOT resolve against the process cwd,
        // which for a GUI app is `/`.
        let edit = try resolve(args("extension/server.mjs", content: "x\n"),
                               files: ["/tmp/proj/extension/server.mjs": "y\n"]).get()
        XCTAssertEqual(edit.absolutePath, "/tmp/proj/extension/server.mjs")
        XCTAssertEqual(edit.displayPath, "extension/server.mjs",
                       "the card should show the project-relative path, not an absolute one")
    }

    func testDotSlashPrefixIsTolerated() throws {
        let edit = try resolve(args("./a.txt", content: "x\n"),
                               files: ["/tmp/proj/a.txt": "y\n"]).get()
        XCTAssertEqual(edit.absolutePath, "/tmp/proj/a.txt")
    }

    func testTraversalOutOfTheProjectIsRefused() {
        let result = resolve(args("../../etc/hosts", content: "pwned\n"),
                            files: ["/etc/hosts": "real\n"])
        guard case .failure(let err) = result else {
            return XCTFail("a path escaping the project must be refused")
        }
        guard case .outsideProject = err else { return XCTFail("expected outsideProject, got \(err)") }
    }

    func testAbsolutePathOutsideTheProjectIsRefused() {
        let result = resolve(args("/etc/hosts", content: "pwned\n"),
                            files: ["/etc/hosts": "real\n"])
        guard case .failure(let err) = result else { return XCTFail("expected failure") }
        guard case .outsideProject = err else { return XCTFail("expected outsideProject, got \(err)") }
    }

    func testASiblingDirectorySharingTheRootPrefixIsRefused() {
        // "/tmp/proj-backup" must not pass a "/tmp/proj" prefix check.
        let result = resolve(args("/tmp/proj-backup/a.txt", content: "x\n"),
                            files: ["/tmp/proj-backup/a.txt": "y\n"])
        guard case .failure(let err) = result else {
            return XCTFail("a sibling dir sharing the root's prefix must be refused")
        }
        guard case .outsideProject = err else { return XCTFail("expected outsideProject, got \(err)") }
    }

    func testAbsolutePathInsideTheProjectIsAllowed() throws {
        let edit = try resolve(args("/tmp/proj/a.txt", content: "x\n"),
                               files: ["/tmp/proj/a.txt": "y\n"]).get()
        XCTAssertEqual(edit.absolutePath, "/tmp/proj/a.txt")
    }

    func testNoProjectAndNoAttachmentIsRefused() {
        let result = resolve(args("a.txt", content: "x\n"), root: nil)
        guard case .failure(let err) = result else { return XCTFail("expected failure") }
        guard case .noProjectOrAttachment = err else {
            return XCTFail("expected noProjectOrAttachment, got \(err)")
        }
    }

    func testAnUnreadableFileIsReportedNotSilentlyCreated() {
        // A path inside the project that doesn't exist must fail, not resolve to
        // an empty original and then "apply" as a whole-file create.
        let result = resolve(args("missing.txt", content: "x\n"), files: [:])
        guard case .failure(let err) = result else { return XCTFail("expected failure") }
        guard case .unreadable = err else { return XCTFail("expected unreadable, got \(err)") }
    }

    // MARK: - Attachments

    func testAttachmentContentIsUsedAsTheDiffBaseline() throws {
        // The attachment is what the agent was SHOWN. Diffing against a
        // re-read of disk could hide a change made since.
        let attached = Known(path: "/tmp/proj/a.txt", content: "as the agent saw it\n")
        let edit = try resolve(args("/tmp/proj/a.txt", content: "new\n"),
                               attachments: [attached],
                               files: ["/tmp/proj/a.txt": "changed on disk\n"]).get()
        XCTAssertEqual(edit.original, "as the agent saw it\n")
        XCTAssertEqual(edit.source, .attachment)
    }

    func testAttachmentIsMatchedThroughTildeExpansion() throws {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let attached = Known(path: "~/notes.md", content: "old\n")
        let edit = try resolve(args("\(home)/notes.md", content: "new\n"),
                               attachments: [attached]).get()
        XCTAssertEqual(edit.source, .attachment)
        XCTAssertEqual(edit.absolutePath, "\(home)/notes.md")
        XCTAssertEqual(edit.displayPath, "~/notes.md", "the chip's label is what the user recognises")
    }

    func testAttachmentOutsideTheProjectStillResolves() throws {
        // Explicitly attaching a file is consent to edit it, wherever it lives.
        let attached = Known(path: "/elsewhere/notes.md", content: "old\n")
        let edit = try resolve(args("/elsewhere/notes.md", content: "new\n"),
                               attachments: [attached]).get()
        XCTAssertEqual(edit.absolutePath, "/elsewhere/notes.md")
    }

    func testBasenameFallbackMatchesAUniqueAttachment() throws {
        let attached = Known(path: "~/Developer/app/README.md", content: "old\n")
        let edit = try resolve(args("/wrong/parent/README.md", content: "new\n"),
                               attachments: [attached]).get()
        XCTAssertEqual(edit.source, .attachment)
        XCTAssertEqual(edit.displayPath, "~/Developer/app/README.md")
    }

    func testBasenameFallbackIsRefusedWhenAmbiguous() {
        let a = Known(path: "/x/one/README.md", content: "a\n")
        let b = Known(path: "/x/two/README.md", content: "b\n")
        let result = resolve(args("/wrong/README.md", content: "new\n"),
                            attachments: [a, b], root: nil)
        guard case .failure = result else {
            return XCTFail("two attachments share the basename — no safe choice")
        }
    }

    func testBasenameFallbackIsDisabledForUnreviewedWrites() {
        // Auto-edit mode passes allowBasenameFallback: false. A hallucinated
        // parent directory must not silently redirect the write onto an
        // attachment when nobody is going to review the result.
        let attached = Known(path: "/tmp/proj/README.md", content: "old\n")
        let result = resolve(args("/somewhere/else/README.md", content: "new\n"),
                            attachments: [attached],
                            allowBasenameFallback: false)
        guard case .failure(let err) = result else {
            return XCTFail("auto mode must require an exact path")
        }
        guard case .outsideProject = err else { return XCTFail("expected outsideProject, got \(err)") }
    }

    // MARK: - Wire decoding

    func testArgsDecodeFromTheServersSnakeCaseWireShape() throws {
        let json = #"{"path":"a.swift","old_text":"a\n","new_text":"b\n"}"#
        let decoded = try JSONDecoder().decode(PendingTool.UpdateFileArgs.self,
                                               from: Data(json.utf8))
        XCTAssertEqual(decoded.oldText, "a\n")
        XCTAssertEqual(decoded.newText, "b\n")
        XCTAssertNil(decoded.content)
    }

    func testWholeFileArgsStillDecode() throws {
        // The pre-existing wire shape must keep working.
        // Double-pound delimiter: the JSON body itself contains `"#`.
        let json = ##"{"path":"a.md","content":"# Hi\n"}"##
        let decoded = try JSONDecoder().decode(PendingTool.UpdateFileArgs.self,
                                               from: Data(json.utf8))
        XCTAssertEqual(decoded.content, "# Hi\n")
        XCTAssertNil(decoded.oldText)
    }
}
