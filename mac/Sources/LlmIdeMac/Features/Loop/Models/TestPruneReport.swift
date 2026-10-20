import Foundation

/// Why a test file or line is a deletion candidate under the company test guideline.
public enum TestPruneReason: String, Codable {
    case sourceGone, noAssertion, commentedOutTest, gapDuplicate

    var title: String {
        switch self {
        case .sourceGone: return "No matching source name (check by hand)"
        case .noAssertion: return "No assertion"
        case .commentedOutTest: return "Commented-out test"
        case .gapDuplicate: return "Gap duplicate"
        }
    }

    var explanation: String {
        switch self {
        case .sourceGone: return "No source file with a matching name exists in the package."
        case .noAssertion: return "Declares tests but never asserts; an assert-less script belongs in `analysis/`."
        case .commentedOutTest: return "A test that was commented out instead of deleted."
        case .gapDuplicate: return "A gap-writer file sits next to its regular test file; merge or drop it."
        }
    }
}

public struct TestPruneFinding: Codable, Equatable {
    public var path: String
    public var reason: TestPruneReason
    public var line: Int?

    public init(path: String, reason: TestPruneReason, line: Int? = nil) {
        self.path = path; self.reason = reason; self.line = line
    }
}

enum TestPruneReport {
    static func render(_ findings: [TestPruneFinding]) -> String {
        var out = "# Test Prune Candidates\n\n"
        out += "Review and delete by hand; the loop never deletes tests.\n"
        out += "Assert-less scripts belong in `analysis/`, not in the test tree.\n\n"
        if findings.isEmpty { return out + "No prune candidates found.\n" }
        out += "\(findings.count) candidate(s).\n"
        for reason in [TestPruneReason.sourceGone, .noAssertion, .commentedOutTest, .gapDuplicate] {
            let group = findings.filter { $0.reason == reason }
            guard !group.isEmpty else { continue }
            out += "\n## \(reason.title) (\(group.count))\n\n\(reason.explanation)\n\n"
            for finding in group {
                out += "- `\(finding.path)`" + (finding.line.map { ":\($0)" } ?? "") + "\n"
            }
        }
        return out
    }
}
