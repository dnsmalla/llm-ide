import Testing
import Foundation
import CoreGraphics
import CoreText
@testable import LlmIdeMacLib

/// Regressions from the 2026-09 chat review (F4, composer attachments).
@Suite("Chat attachment reader")
struct ChatAttachmentReaderTests {
    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("attach-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func makePDF(at url: URL, text: String?) throws {
        var box = CGRect(x: 0, y: 0, width: 300, height: 200)
        let ctx = try #require(CGContext(url as CFURL, mediaBox: &box, nil))
        ctx.beginPDFPage(nil)
        if let text {
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text))
            ctx.textPosition = CGPoint(x: 20, y: 100)
            CTLineDraw(line, ctx)
        }
        ctx.endPDFPage()
        ctx.closePDF()
    }

    @Test("A PDF is attached as its text, not as base64 the model can't read")
    func pdfTextExtracted() throws {
        let url = try tempDir().appendingPathComponent("spec.pdf")
        try makePDF(at: url, text: "Quarterly roadmap")
        guard case .content(let content) = ChatAttachmentReader.read(url) else {
            Issue.record("expected content"); return
        }
        #expect(content.contains("Quarterly roadmap"))
        #expect(!content.contains("[binary:application/pdf]"))
    }

    @Test("A PDF with no text layer is refused with a reason")
    func scannedPDFRefused() throws {
        let url = try tempDir().appendingPathComponent("scan.pdf")
        try makePDF(at: url, text: nil)
        guard case .refused(let reason) = ChatAttachmentReader.read(url) else {
            Issue.record("expected refusal"); return
        }
        #expect(reason.contains("no text layer"))
    }

    @Test("Oversized files are refused before being loaded")
    func tooLargeRefused() throws {
        let dir = try tempDir()
        let big = dir.appendingPathComponent("huge.log")
        FileManager.default.createFile(atPath: big.path, contents: nil)
        let h = try FileHandle(forWritingTo: big)
        try h.truncate(atOffset: UInt64(ChatAttachmentReader.maxFileBytes + 1))   // sparse
        try h.close()
        guard case .refused = ChatAttachmentReader.read(big) else { Issue.record("expected refusal"); return }

        let image = dir.appendingPathComponent("photo.png")
        try Data(count: ChatAttachmentReader.maxImageBytes + 1).write(to: image)
        guard case .refused(let reason) = ChatAttachmentReader.read(image) else {
            Issue.record("expected image refusal"); return
        }
        #expect(reason.contains("images over"))
    }

    @Test("A small image still becomes a binary image attachment")
    func imageAttached() throws {
        let url = try tempDir().appendingPathComponent("a.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: url)
        guard case .content(let content) = ChatAttachmentReader.read(url) else { Issue.record("expected content"); return }
        #expect(content.hasPrefix("[binary:image/png]\n"))
    }

    @Test("Shift-JIS and UTF-16 text files are read, not refused as binary")
    func otherEncodings() throws {
        let dir = try tempDir()
        let sjis = dir.appendingPathComponent("memo.txt")
        try #require("会議のメモ".data(using: .shiftJIS)).write(to: sjis)
        #expect(ChatAttachmentReader.read(sjis) == .content("会議のメモ"))

        let utf16 = dir.appendingPathComponent("notes.txt")
        try #require("hello".data(using: .utf16)).write(to: utf16)     // carries a BOM
        #expect(ChatAttachmentReader.read(utf16) == .content("hello"))
    }

    @Test("A real binary file is still refused")
    func binaryRefused() throws {
        let url = try tempDir().appendingPathComponent("blob.bin")
        try Data([0x00, 0x01, 0x00, 0x02, 0x00, 0x03]).write(to: url)
        #expect(ChatAttachmentReader.read(url) == .notText)
    }
}
