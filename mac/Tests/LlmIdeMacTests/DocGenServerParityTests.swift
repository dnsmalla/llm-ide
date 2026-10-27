import Testing
@testable import LlmIdeMacLib

/// Byte parity between the Swift project-folder writers and the Node server's
/// docs-kit K1 writers (`extension/kb/doc-templates.mjs`, golden literals in
/// `extension/tests/fixtures/docgen/golden.mjs`).
///
/// The rollback story (docs-kit §5a) depends on this: a file the Node server
/// writes must be byte-identical to what `renderedMarkdown()` writes for the same
/// input, so an older Mac build reads it unchanged. These expected strings are the
/// same literals the Node golden tests assert. If either side changes its bytes,
/// the other side's test fails.
@Suite("Doc Gen server parity (docs-kit K1)")
struct DocGenServerParityTests {

    @Test("visual template bytes match the Node golden")
    func visualTemplateGolden() {
        let out = DocTemplate.markdownBody(name: "Sprint Review", sections: ["Summary", "Decisions"], surface: .visual)
        #expect(out == "# Sprint Review\n\n<!-- llmide:doc-template surface=visual -->\n\n"
            + "Template for Visual. Edit the `##` sections below to change structure.\n\n"
            + "## Summary\n\n## Decisions\n")
    }

    @Test("Doc Gen template bytes use the bare marker, match the Node golden")
    func docTemplateGolden() {
        let out = DocTemplate.markdownBody(name: "Retro", sections: ["Went well", "Improve"])
        #expect(out == "# Retro\n\n<!-- llmide:doc-template -->\n\n"
            + "Template for Doc Gen. Edit the `##` sections below to change structure.\n\n"
            + "## Went well\n\n## Improve\n")
    }

    @Test("Doc Gen command bytes have no trailing newline, match the Node golden")
    func docCommandGolden() {
        let out = DocCommand.markdownBody(name: "Summarize", instruction: "Summarize the source into five bullet points.")
        #expect(out == "# Summarize\n\n<!-- llmide:doc-command -->\n\nSummarize the source into five bullet points.")
    }

    @Test("visual command bytes match the Node golden")
    func visualCommandGolden() {
        let out = DocCommand.markdownBody(name: "Visual Brief", instruction: "Describe the frame.", surface: .visual)
        #expect(out == "# Visual Brief\n\n<!-- llmide:doc-command surface=visual -->\n\nDescribe the frame.")
    }

    @Test("a kit template stamped as visual matches the Node seed bytes")
    func kitSeedGolden() {
        let body = "# Image Analysis\n\n## What It Shows\n\n## Details Worth Noting\n"
        let seeded = TemplateSurfaceMarker.ensure(in: body, base: DocTemplate.markerComment, surface: .visual)
        #expect(seeded == "# Image Analysis\n\n<!-- llmide:doc-template surface=visual -->\n\n"
            + "## What It Shows\n\n## Details Worth Noting\n")
    }

    @Test("stable ids match the Node stableId (same SHA-256 namespace and UUID formatting)")
    func stableIdParity() {
        #expect(DocTemplate.stableID(forFolder: "retro").uuidString == "65A8ADFC-2236-44D5-A676-C0DA368BBC91")
        #expect(DocCommand.stableID(forFolder: "my-command").uuidString == "8B01A3C3-E4DB-4E56-AC97-50FDE0FAFFF3")
    }

    @Test("slugs and display names match the Node helpers")
    func slugAndNameParity() {
        #expect(DocTemplate.slug(for: "Meeting  Summary!") == "meeting-summary")
        #expect(DocCommand.slug(for: "Release  Notes!") == "release-notes")
        #expect(DocCommand.displayName(from: "no heading here", folderName: "release-notes") == "Release Notes")
        #expect(DocCommand.displayName(from: "   # Indented\n\nBody.", folderName: "x") == "Indented")
    }
}
