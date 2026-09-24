import Testing
@testable import LlmIdeMacLib

/// Saving from the template manager keeps the template's body text. It used
/// to regenerate a bare heading skeleton over template.md.
@Suite("DocTemplate.rewriting")
struct DocTemplateRewriteTests {
    let raw = """
    # Meeting Summary

    <!-- llmide:doc-template surface=doc -->

    Write for an executive reader.

    ## Decisions
    List each decision with its owner.

    ## Risks
    Only risks with a mitigation.

    ## Next Steps
    Dated, owned.
    """

    @Test("Reordering and renaming the title keeps every section's body")
    func reorderKeepsBodies() {
        let out = DocTemplate.rewriting(raw: raw, name: "Weekly Summary", sections: ["Risks", "Decisions", "Next Steps"])
        #expect(out.hasPrefix("# Weekly Summary\n"))
        #expect(out.contains("<!-- llmide:doc-template surface=doc -->"))
        #expect(out.contains("Write for an executive reader."))
        let risks = out.range(of: "## Risks")!, decisions = out.range(of: "## Decisions")!
        #expect(risks.lowerBound < decisions.lowerBound)
        #expect(out.contains("## Risks\nOnly risks with a mitigation."))
        #expect(out.contains("## Decisions\nList each decision with its owner."))
        #expect(DocTemplate.sections(from: out) == ["Risks", "Decisions", "Next Steps"])
    }

    @Test("A removed section goes with its text; an added one is an empty heading")
    func removeAndAdd() {
        let out = DocTemplate.rewriting(raw: raw, name: "Meeting Summary", sections: ["Decisions", "Open Questions"])
        #expect(!out.contains("Risks"))
        #expect(!out.contains("mitigation"))
        #expect(out.contains("List each decision with its owner."))
        #expect(out.hasSuffix("## Open Questions\n"))
    }

    @Test("A file without ## headings keeps all its text and gets the sections appended")
    func noHeadings() {
        let plain = "# T\n\nJust prose here.\n"
        let out = DocTemplate.rewriting(raw: plain, name: "T2", sections: ["A", "B"])
        #expect(out.hasPrefix("# T2\n"))
        #expect(out.contains("Just prose here."))
        #expect(DocTemplate.sections(from: out) == ["A", "B"])
    }

    @Test("Unchanged edits reproduce the same headings and bodies")
    func roundTrip() {
        let out = DocTemplate.rewriting(raw: raw, name: "Meeting Summary", sections: ["Decisions", "Risks", "Next Steps"])
        #expect(DocTemplate.sections(from: out) == DocTemplate.sections(from: raw))
        #expect(out.contains("Dated, owned."))
    }

    @Test("A CRLF file keeps its bodies too")
    func crlf() {
        let crlf = raw.replacingOccurrences(of: "\n", with: "\r\n")
        let out = DocTemplate.rewriting(raw: crlf, name: "Meeting Summary", sections: ["Risks", "Decisions", "Next Steps"])
        #expect(out.contains("Only risks with a mitigation."))
        #expect(out.contains("List each decision with its owner."))
        #expect(DocTemplate.sections(from: out) == ["Risks", "Decisions", "Next Steps"])
    }

    @Test("Two sections with the same name keep both bodies in order")
    func duplicateHeadings() {
        let dup = "# T\n\n## Notes\nfirst\n\n## Notes\nsecond\n"
        let out = DocTemplate.rewriting(raw: dup, name: "T", sections: ["Notes", "Notes"])
        let first = out.range(of: "first")!, second = out.range(of: "second")!
        #expect(first.lowerBound < second.lowerBound)
        #expect(out.components(separatedBy: "## Notes").count == 3)
    }
}
