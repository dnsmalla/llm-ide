import Testing
import Foundation
@testable import LlmIdeMacLib

/// The editor's Save now goes through the same writer as Search's replace.
/// `String.write(atomically:)` — what Save used before — replaced a read-only
/// file (a rename only needs the folder writable) and split a hard link.
@Suite("Shared text-file writer")
struct TextFileWriterTests {
    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("TextFileWriterTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test("a read-only file is refused with a readable reason and left untouched")
    func refusesReadOnly() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("ro.txt")
        try "old\n".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path) }

        #expect(throws: TextFileWriter.WriteError.notWritable) {
            try TextFileWriter.write("new\n", to: file)
        }
        #expect(try String(contentsOf: file, encoding: .utf8) == "old\n")
    }

    @Test("a hard-linked file keeps sharing its contents after a write")
    func keepsHardLinks() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let first = dir.appendingPathComponent("a.txt")
        let second = dir.appendingPathComponent("b.txt")
        try "old\n".write(to: first, atomically: true, encoding: .utf8)
        try FileManager.default.linkItem(at: first, to: second)

        try TextFileWriter.write("new\n", to: first)

        #expect(try String(contentsOf: second, encoding: .utf8) == "new\n")
    }

    @Test("the exec bit survives the atomic rename")
    func keepsPermissions() throws {
        let dir = try tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let script = dir.appendingPathComponent("run.sh")
        try "echo old\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        try TextFileWriter.write("echo new\n", to: script)

        let perms = try FileManager.default.attributesOfItem(atPath: script.path)[.posixPermissions] as? NSNumber
        #expect(perms?.intValue == 0o755)
    }

    @Test("the editor cap sits above Search's per-file scan limit")
    func editorCapAboveSearchCap() {
        #expect(TextFileWriter.maxEditableBytes > SearchEngine.maxFileBytes)
    }
}

/// The confirmations added for LLM-source removal and source Disconnect.
@Suite("Library removal confirmations — sources")
struct LibrarySourceRemovalTests {
    @Test("LLM source removal warns the clone is deleted")
    func llmSourceWording() {
        let removal = LibraryRemoval.llmSource(id: "kit", name: "Agent Kit")
        #expect(removal.dialogTitle.contains("Agent Kit"))
        #expect(removal.message.contains("deleted"))
        #expect(removal.confirmLabel == "Remove")
    }

    @Test("each Disconnect names its source and is labelled Disconnect")
    func disconnectWording() {
        for (kind, name) in [(SourceLinkStore.SourceKind.email, "Email"), (.slack, "Slack"), (.box, "Box")] {
            let removal = LibraryRemoval.sourceDisconnect(kind)
            #expect(removal.dialogTitle.contains(name))
            #expect(removal.message.contains("vault"))
            #expect(removal.confirmLabel == "Disconnect")
        }
    }

    @Test("ids stay distinct across kinds")
    func distinctIds() {
        #expect(LibraryRemoval.llmSource(id: "x", name: "X").id != LibraryRemoval.connector(id: "x", name: "X").id)
        #expect(LibraryRemoval.sourceDisconnect(.email).id != LibraryRemoval.sourceDisconnect(.slack).id)
    }
}
