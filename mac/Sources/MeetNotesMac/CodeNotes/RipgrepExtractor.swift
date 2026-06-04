import Foundation

/// Stateless line-level parsers for structural facts the code-graph scanner
/// needs: a file's language (by extension), an import line's target specifier,
/// and a symbol definition's name. Kept pure so they're cheap to unit-test and
/// reusable from both the ripgrep-driven scan and ad-hoc parsing.
public enum RipgrepExtractor {
    public struct Symbol: Equatable {
        public let name: String
        public let kind: String
        public let line: Int

        public init(name: String, kind: String, line: Int) {
            self.name = name
            self.kind = kind
            self.line = line
        }
    }

    public static func language(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "ts", "tsx":               return "typescript"
        case "js", "jsx", "mjs", "cjs": return "javascript"
        case "swift":                   return "swift"
        case "py":                      return "python"
        default:                        return "other"
        }
    }

    public static func importSpecifier(fromLine line: String, language: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        switch language {
        case "typescript", "javascript":
            // `import ... from '<spec>'` / `import ... from "<spec>"`
            if let spec = firstCaptureGroup(in: trimmed,
                pattern: #"\bfrom\s+['"]([^'"]+)['"]"#) {
                return spec
            }
            // `const x = require('<spec>')`
            if let spec = firstCaptureGroup(in: trimmed,
                pattern: #"\brequire\(\s*['"]([^'"]+)['"]\s*\)"#) {
                return spec
            }
            // bare `import '<spec>'` (side-effect import)
            return firstCaptureGroup(in: trimmed, pattern: #"^import\s+['"]([^'"]+)['"]"#)
        case "swift":
            return firstCaptureGroup(in: trimmed, pattern: #"^import\s+([A-Za-z_][A-Za-z0-9_.]*)"#)
        default:
            return nil
        }
    }

    public static func symbol(fromLine line: String, language: String) -> Symbol? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.hasPrefix("//") else { return nil }

        if let name = firstCaptureGroup(in: trimmed,
            pattern: #"\b(?:func|function)\s+([A-Za-z_][A-Za-z0-9_]*)"#) {
            return Symbol(name: name, kind: "function", line: 0)
        }
        if let name = firstCaptureGroup(in: trimmed,
            pattern: #"\b(?:class|struct|enum|protocol|interface)\s+([A-Za-z_][A-Za-z0-9_]*)"#) {
            return Symbol(name: name, kind: "class", line: 0)
        }
        return nil
    }

    // MARK: - Helpers

    private static func firstCaptureGroup(in string: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(string.startIndex..., in: string)
        guard let match = regex.firstMatch(in: string, range: range),
              match.numberOfRanges > 1,
              let groupRange = Range(match.range(at: 1), in: string) else { return nil }
        return String(string[groupRange])
    }
}
