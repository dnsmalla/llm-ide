import Foundation
import Yams

enum FrontmatterCoder {
    enum Failure: LocalizedError {
        case decodeFailed(String)
        case encodeFailed(String)
        var errorDescription: String? {
            switch self {
            case .decodeFailed(let msg): return "YAML decode failed: \(msg)"
            case .encodeFailed(let msg): return "YAML encode failed: \(msg)"
            }
        }
    }

    static func decode(_ yaml: String) throws -> MeetingFrontmatter {
        let decoder = YAMLDecoder()
        do {
            return try decoder.decode(MeetingFrontmatter.self, from: yaml)
        } catch {
            throw Failure.decodeFailed("\(error)")
        }
    }

    static func encode(_ fm: MeetingFrontmatter) throws -> String {
        let encoder = YAMLEncoder()
        encoder.options.sortKeys = false
        do {
            return try encoder.encode(fm)
        } catch {
            throw Failure.encodeFailed("\(error)")
        }
    }

    /// Extracts the frontmatter block from a full .md file.  Returns
    /// (yaml, bodyStartIndex) so callers can re-stitch after editing.
    static func split(file contents: String) -> (yaml: String, bodyStart: String.Index)? {
        guard contents.hasPrefix("---\n") else { return nil }
        let afterOpener = contents.index(contents.startIndex, offsetBy: 4)
        guard let closer = contents.range(of: "\n---\n", range: afterOpener..<contents.endIndex) else { return nil }
        let yaml = String(contents[afterOpener..<closer.lowerBound])
        return (yaml, closer.upperBound)
    }
}
