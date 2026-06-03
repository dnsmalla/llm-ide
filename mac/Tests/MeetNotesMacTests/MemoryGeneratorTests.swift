import Testing
@testable import MeetNotesMac

struct MemoryGeneratorTests {
    @Test func classifiesHeadingsByKeyword() {
        #expect(MemoryGenerator.classify(heading: "Decision: ship beta", body: "") == .noteDecision)
        #expect(MemoryGenerator.classify(heading: "Open Question?",     body: "") == .noteQuestion)
        #expect(MemoryGenerator.classify(heading: "Action items",       body: "") == .noteTask)
        #expect(MemoryGenerator.classify(heading: "How to onboard",     body: "") == .notePlaybook)
        #expect(MemoryGenerator.classify(heading: "Key fact",           body: "") == .noteFact)
        #expect(MemoryGenerator.classify(heading: "Concept: idempotence", body: "") == .noteConcept)
        #expect(MemoryGenerator.classify(heading: "Hypothesis on retention", body: "") == .noteHypothesis)
        #expect(MemoryGenerator.classify(heading: "Weekly standup",     body: "") == .noteEvent)
        #expect(MemoryGenerator.classify(heading: "Source: RFC 9110",   body: "") == .noteSource)
    }

    @Test func classifiesCheckboxBodyAsTask() {
        let body = """
        Pre-launch checklist:
        - [ ] enable feature flag
        - [x] update docs
        """
        #expect(MemoryGenerator.classify(heading: "Pre-launch", body: body) == .noteTask)
    }

    @Test func unrecognizedHeadingReturnsNil() {
        #expect(MemoryGenerator.classify(heading: "Background", body: "Just some prose.") == nil)
        #expect(MemoryGenerator.classify(heading: nil, body: "") == nil)
    }

    @Test func stripsFrontmatterAndExtractsType() {
        let input = """
        ---
        type: decision
        title: Drop free tier
        ---
        Body line 1.
        Body line 2.
        """
        let (remaining, kind, tags) = MemoryGenerator.stripFrontmatterType(input)
        #expect(kind == .noteDecision)
        #expect(tags == [])
        #expect(remaining.hasPrefix("Body line 1."))
    }

    @Test func stripsFrontmatterTolerantOfBadYaml() {
        let input = "---\ntype: playbook\n---\nHello"
        let (remaining, kind, tags) = MemoryGenerator.stripFrontmatterType(input)
        #expect(kind == .notePlaybook)
        #expect(tags == [])
        #expect(remaining == "Hello")
    }

    @Test func noFrontmatterReturnsOriginalTextAndNilKind() {
        let input = "# Just a heading\n\nbody"
        let (remaining, kind, tags) = MemoryGenerator.stripFrontmatterType(input)
        #expect(kind == nil)
        #expect(tags == [])
        #expect(remaining == input)
    }

    @Test func parsesFrontmatterTagsArrayAndString() {
        let arr = "---\ntags: [foo, bar, baz]\n---\nx"
        let (_, _, t1) = MemoryGenerator.stripFrontmatterType(arr)
        #expect(t1 == ["foo", "bar", "baz"])

        let str = "---\ntags: alpha, beta gamma\n---\nx"
        let (_, _, t2) = MemoryGenerator.stripFrontmatterType(str)
        #expect(t2.sorted() == ["alpha", "beta", "gamma"])

        // Frontmatter tags are normalised: lowercased + leading '#' stripped.
        let mixed = "---\ntags: [\"#Foo\", BAR]\n---\nx"
        let (_, _, t3) = MemoryGenerator.stripFrontmatterType(mixed)
        #expect(t3 == ["foo", "bar"])
    }

    @Test func extractsWikiLinksWithAlias() {
        let body = "See [[Foo]] and [[Bar Baz|alias]] but not [Foo] or [[].";
        let links = MemoryGenerator.extractWikiLinks(body)
        #expect(links == ["Foo", "Bar Baz"])
    }

    @Test func extractsHashtagsIgnoringPureNumbers() {
        let body = "Topic #ml-ops and #infra related to issue #42 only."
        let tags = MemoryGenerator.extractHashtags(body)
        #expect(tags == ["ml-ops", "infra"])   // "#42" rejected by leading-letter rule
    }

    @Test func mergeTagsDedupesPreservingOrder() {
        let merged = MemoryGenerator.mergeTags(["a", "b"], ["b", "c", "a"])
        #expect(merged == ["a", "b", "c"])
    }
}
