// User-saved Q&A pair. Persisted as markdown with YAML frontmatter
// under <repo>/.understand-anything/memory/q&a/<slug>.md, alongside bug
// reports. Phase C's repeated-command detection writes these.
//
// We share slugify + the ISO formatter with BugReport — both files
// live in the same module so there's no visibility concern.

import Foundation
import Yams

struct QAEntry: Equatable {
    var question: String
    var answer: String
    var savedAt: Date
    var askCount: Int
    /// `AICliTool.rawValue` of the agent that produced the answer.
    var agent: String

    func toMarkdown() throws -> String {
        let fm: [String: Any] = [
            "question": question,
            "answer": answer,
            "saved_at": BugReport.isoFormatter.string(from: savedAt),
            "ask_count": askCount,
            "agent": agent
        ]
        let yaml = try Yams.dump(object: fm)
        // No notes body — Q&A is purely the (question, answer) pair.
        return "---\n\(yaml)---\n"
    }

    func suggestedFileName() -> String {
        let ts = BugReport.fsTimestampFormatter.string(from: savedAt)
        return "\(ts)-\(BugReport.slugify(question)).md"
    }
}
