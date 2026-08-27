import Testing
@testable import LlmIdeMacLib

@Suite("IngestTemplateRenderer")
struct IngestTemplateRendererTests {

    @Test("meeting template substitutes placeholders")
    func meetingRender() {
        let summary = MeetingSummary(
            gist: "Quick sync on launch.",
            tldr: ["Ship Friday", "Fix auth bug"],
            full: "## Summary\n\nWe aligned on launch.",
            actions: [MeetingSummary.Action(owner: "Aki", text: "Send recap", due: "Friday")],
            decisions: [MeetingSummary.Decision(text: "Go with option B")],
            blockers: [MeetingSummary.Blocker(text: "CI flaky")],
            model: "claude",
            generatedAt: Date(timeIntervalSince1970: 0))
        let started = Date(timeIntervalSince1970: 1_700_000_000)
        let md = IngestTemplateRenderer.renderMeetingNote(
            projectRoot: URL(fileURLWithPath: "/tmp/project"),
            summary: summary,
            title: "Standup",
            startedAt: started,
            durationSeconds: 1800,
            participants: ["Aki", "Ben"],
            transcript: "Aki: hello\nBen: hi",
            rawFile: "meetings/2026/08/foo.md")

        #expect(md.contains("# Standup"))
        #expect(md.contains("Quick sync on launch."))
        #expect(md.contains("- [ ] Send recap (@Aki)"))
        #expect(!md.contains("Aki: hello"))
        #expect(!md.contains("Go with option B"))
        #expect(md.hasSuffix(".md") == false)
        #expect(md.contains("source: meeting"))
    }

    @Test("email template substitutes placeholders")
    func emailRender() {
        let todo = LlmIdeAPIClient.EmailTodo(title: "Review PR", detail: "Before EOD", due: "2026-08-25", priority: "high")
        let classification = LlmIdeAPIClient.EmailClassification(
            category: "action_request",
            noteWorthy: true,
            summary: "Please review the PR.",
            todos: [todo])
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let md = IngestTemplateRenderer.renderEmailNote(
            projectRoot: URL(fileURLWithPath: "/tmp/project"),
            from: "aki@example.com",
            date: date,
            subject: "PR review",
            classification: classification,
            originalBody: "Can you review?",
            sourceHash: "abc123",
            rawFile: "emails/2026/08/raw.txt")

        #expect(md.contains("# PR review"))
        #expect(md.contains("Please review the PR."))
        #expect(md.contains("- [ ] Review PR"))
        #expect(!md.contains("Can you review?"))
        #expect(md.contains("source: email"))
        #expect(md.contains("issue: null"))
    }

    @Test("quotes in from and title stay valid YAML")
    func yamlEscaping() {
        let classification = LlmIdeAPIClient.EmailClassification(
            category: "info", noteWorthy: true, summary: "s", todos: [])
        let emailVars = IngestTemplateRenderer.emailVariables(
            from: "\"Malla, Dinesh\" <d@example.com>",
            date: Date(timeIntervalSince1970: 0),
            subject: "Hi",
            classification: classification,
            originalBody: "",
            sourceHash: "abc",
            rawFile: "emails/2026/08/raw.txt")
        #expect(emailVars["from_yaml"] == "\\\"Malla, Dinesh\\\" <d@example.com>")
        #expect(emailVars["from"] == "\"Malla, Dinesh\" <d@example.com>")

        let summary = MeetingSummary(
            gist: "g", tldr: [], full: "", actions: [], decisions: [], blockers: [],
            model: "m", generatedAt: Date(timeIntervalSince1970: 0))
        let meetingVars = IngestTemplateRenderer.meetingVariables(
            summary: summary,
            title: "Sync: \"Q3\" roadmap",
            startedAt: Date(timeIntervalSince1970: 0),
            durationSeconds: nil,
            participants: [],
            transcript: "",
            rawFile: "meetings/2026/08/raw.md")
        #expect(meetingVars["title_yaml"] == "Sync: \\\"Q3\\\" roadmap")
    }

    @Test("render is single-pass: placeholders inside values are not re-substituted")
    func renderSinglePass() {
        let rendered = IngestTemplateRenderer.render(
            "{{body}} / {{summary}}",
            variables: ["body": "forwarded template: {{summary}}", "summary": "REAL"])
        #expect(rendered == "forwarded template: {{summary}} / REAL")
    }

    @Test("render leaves unknown placeholders intact")
    func renderUnknownPlaceholder() {
        let rendered = IngestTemplateRenderer.render(
            "a {{known}} b {{unknown}} c",
            variables: ["known": "X"])
        #expect(rendered == "a X b {{unknown}} c")
    }

    @Test("loads project template file when present")
    func loadFromDisk() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ingest-template-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let dir = ProjectLayout(root: root).templateDir(named: "email-note")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let custom = "# {{subject}}\n\nCUSTOM {{summary}}\n"
        try custom.write(to: dir.appendingPathComponent("template.md"), atomically: true, encoding: .utf8)

        let loaded = IngestTemplateRenderer.loadTemplate(kind: .emailNote, projectRoot: root)
        #expect(loaded == custom)

        let rendered = IngestTemplateRenderer.render(loaded, variables: [
            "subject": "Hello",
            "summary": "World",
        ])
        #expect(rendered.contains("# Hello"))
        #expect(rendered.contains("CUSTOM World"))
    }
}
