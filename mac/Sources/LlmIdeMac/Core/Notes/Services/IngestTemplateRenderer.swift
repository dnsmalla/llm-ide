import Foundation

/// Loads `<project>/templates/<kind>/template.md` and renders ingest notes
/// (meetings, emails) into llm-doc `.md` files.
enum IngestTemplateKind: String, Sendable {
    case meetingNote = "meeting-note"
    case emailNote = "email-note"

    var folderName: String { rawValue }
}

enum IngestTemplateRenderer {

    // MARK: - Load

    static func loadTemplate(kind: IngestTemplateKind, projectRoot: URL) -> String {
        let url = ProjectLayout(root: projectRoot)
            .templateDir(named: kind.folderName)
            .appendingPathComponent("template.md")
        if let content = try? String(contentsOf: url, encoding: .utf8), !content.isEmpty {
            return content
        }
        return defaultTemplate(kind)
    }

    /// Single-pass substitution: values are never re-scanned, so placeholder-like
    /// text inside a transcript or email body cannot trigger a second replacement.
    static func render(_ template: String, variables: [String: String]) -> String {
        var result = ""
        var pos = template.startIndex
        for match in template.matches(of: #/\{\{(\w+)\}\}/#) {
            result += template[pos..<match.range.lowerBound]
            result += variables[String(match.1)] ?? String(template[match.range])
            pos = match.range.upperBound
        }
        result += template[pos...]
        return result
    }

    // MARK: - Meeting

    static func renderMeetingNote(
        projectRoot: URL,
        summary: MeetingSummary,
        title: String,
        startedAt: Date,
        durationSeconds: Int?,
        participants: [String],
        transcript: String,
        rawFile: String
    ) -> String {
        let template = loadTemplate(kind: .meetingNote, projectRoot: projectRoot)
        let vars = meetingVariables(
            summary: summary,
            title: title,
            startedAt: startedAt,
            durationSeconds: durationSeconds,
            participants: participants,
            transcript: transcript,
            rawFile: rawFile)
        return render(template, variables: vars)
    }

    static func meetingVariables(
        summary: MeetingSummary,
        title: String,
        startedAt: Date,
        durationSeconds: Int?,
        participants: [String],
        transcript: String,
        rawFile: String
    ) -> [String: String] {
        let dateISO = AppDateFormatter.isoString(startedAt)
        let dateDisplay = AppDateFormatter.absoluteMedium(startedAt)
        let duration = durationSeconds.map { formatDuration($0) } ?? ""
        let safeTitle = title.isEmpty ? "Meeting" : title
        return [
            "title": safeTitle,
            "title_yaml": yamlEscape(safeTitle),
            "gist": summary.gist,
            "date": dateISO,
            "date_display": dateDisplay,
            "duration": duration,
            "participants": participants.joined(separator: ", "),
            "participants_yaml": yamlStringList(participants),
            "tldr": bulletList(summary.tldr),
            "full": summary.full.isEmpty ? summary.gist : summary.full,
            "decisions": bulletList(summary.decisions.map(\.text)),
            "actions": checkboxActions(summary.actions),
            "blockers": bulletList(summary.blockers.map(\.text)),
            "transcript": transcript.trimmingCharacters(in: .whitespacesAndNewlines),
            "raw_file": rawFile,
            "model": summary.model,
        ]
    }

    // MARK: - Email

    static func renderEmailNote(
        projectRoot: URL,
        from: String,
        date: Date,
        subject: String,
        classification c: LlmIdeAPIClient.EmailClassification,
        originalBody: String,
        sourceHash: String,
        rawFile: String
    ) -> String {
        let template = loadTemplate(kind: .emailNote, projectRoot: projectRoot)
        let vars = emailVariables(
            from: from,
            date: date,
            subject: subject,
            classification: c,
            originalBody: originalBody,
            sourceHash: sourceHash,
            rawFile: rawFile)
        return render(template, variables: vars)
    }

    static func renderSkippedEmailNote(
        projectRoot: URL,
        from: String,
        date: Date,
        subject: String,
        category: String,
        originalBody: String,
        sourceHash: String,
        rawFile: String
    ) -> String {
        let template = loadTemplate(kind: .emailNote, projectRoot: projectRoot)
        let vars: [String: String] = [
            "from": from,
            "from_yaml": yamlEscape(from),
            "date": AppDateFormatter.isoString(date),
            "subject": subject.isEmpty ? "Email" : subject,
            "category": category,
            "note_worthy": "false",
            "summary": "_Skipped — \(category)_",
            "todos": "_No action items._",
            "todos_yaml": "  []",
            "original_body": originalBody,
            "source_hash": yamlEscape(sourceHash),
            "raw_file": rawFile,
        ]
        return render(template, variables: vars)
    }

    static func emailVariables(
        from: String,
        date: Date,
        subject: String,
        classification c: LlmIdeAPIClient.EmailClassification,
        originalBody: String,
        sourceHash: String,
        rawFile: String
    ) -> [String: String] {
        [
            "from": from,
            "from_yaml": yamlEscape(from),
            "date": AppDateFormatter.isoString(date),
            "subject": subject.isEmpty ? "Email" : subject,
            "category": c.category,
            "note_worthy": c.noteWorthy ? "true" : "false",
            "summary": c.summary,
            "todos": emailTodosMarkdown(c.todos),
            "todos_yaml": emailTodosYAML(c.todos),
            "original_body": originalBody,
            "source_hash": yamlEscape(sourceHash),
            "raw_file": rawFile,
        ]
    }

    // MARK: - Defaults

    static func defaultTemplate(_ kind: IngestTemplateKind) -> String {
        switch kind {
        case .meetingNote:
            return """
            ---
            source: meeting
            title: "{{title_yaml}}"
            date: {{date}}
            rawFile: {{raw_file}}
            ---

            # {{title}}

            <!-- llmide:ingest-template source=meeting -->

            ## Summary

            {{gist}}

            ## Action items

            {{actions}}
            """
        case .emailNote:
            return """
            ---
            source: email
            platform: email
            from: "{{from_yaml}}"
            date: {{date}}
            category: {{category}}
            noteWorthy: {{note_worthy}}
            sourceHash: "{{source_hash}}"
            rawFile: {{raw_file}}
            todos:
            {{todos_yaml}}
            ---

            # {{subject}}

            <!-- llmide:ingest-template source=email -->

            ## Summary

            {{summary}}

            ## To-dos

            {{todos}}
            """
        }
    }

    // MARK: - Formatting helpers

    private static func bulletList(_ items: [String]) -> String {
        guard !items.isEmpty else { return "_None._" }
        return items.map { "- \($0)" }.joined(separator: "\n")
    }

    private static func checkboxActions(_ actions: [MeetingSummary.Action]) -> String {
        guard !actions.isEmpty else { return "_No action items._" }
        return actions.map { action in
            var line = "- [ ] \(action.text)"
            if let owner = action.owner, !owner.isEmpty { line += " (@\(owner))" }
            if let due = action.due, !due.isEmpty { line += " — due \(due)" }
            return line
        }.joined(separator: "\n")
    }

    private static func emailTodosMarkdown(_ todos: [LlmIdeAPIClient.EmailTodo]) -> String {
        guard !todos.isEmpty else { return "_No action items._" }
        return todos.map { todo in
            let due = todo.due.map { " — due \($0)" } ?? ""
            return "- [ ] \(todo.title)\(due) (\(todo.priority))"
        }.joined(separator: "\n")
    }

    private static func emailTodosYAML(_ todos: [LlmIdeAPIClient.EmailTodo]) -> String {
        guard !todos.isEmpty else { return "  []" }
        return todos.map { todo in
            let due = todo.due.map { "\"\($0)\"" } ?? "null"
            return """
              - title: "\(yamlEscape(todo.title))"
                detail: "\(yamlEscape(todo.detail))"
                due: \(due)
                priority: \(todo.priority)
                issue: null
            """
        }.joined(separator: "\n")
    }

    private static func yamlStringList(_ items: [String]) -> String {
        guard !items.isEmpty else { return "  []" }
        return items.map { "  - \"\(yamlEscape($0))\"" }.joined(separator: "\n")
    }

    private static func yamlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func formatDuration(_ seconds: Int) -> String {
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }
}
