// User-saved Q&A pair. Persisted as markdown with YAML frontmatter
// under <repo>/system/faults/q&a/<slug>.md, alongside fault
// reports. Phase C's repeated-command detection writes these.
//
// We share slugify + the ISO formatter with FaultReport — both files
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
            "saved_at": FaultReport.isoFormatter.string(from: savedAt),
            "ask_count": askCount,
            "agent": agent
        ]
        let yaml = try Yams.dump(object: fm)
        // No notes body — Q&A is purely the (question, answer) pair.
        return "---\n\(yaml)---\n"
    }

    func suggestedFileName() -> String {
        let ts = FaultReport.fsTimestampFormatter.string(from: savedAt)
        return "\(ts)-\(FaultReport.slugify(question)).md"
    }
}
