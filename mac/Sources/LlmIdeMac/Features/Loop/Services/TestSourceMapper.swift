import Foundation

/// Every language rule for "which test file is FOR which source file" and
/// "where a new test goes", so the structure stage, the map stage and the
/// test-gap-writer skill's contract cannot disagree.
enum TestSourceMapper {
    static let excludedDirs: Set<String> = [".git", "node_modules", ".build", "dist", "build", "Pods", "DerivedData",
                                            "vendor", ".venv", "__pycache__", ".llmide-loop-worktrees", "monaco", "monaco-src"]
    static let codeExtensions: Set<String> = ["swift", "mjs", "cjs", "js", "jsx", "ts", "tsx", "py", "go", "kt"]
    private static let testDirs: Set<String> = ["Tests", "tests", "test", "__tests__"]
    private static let manifests: Set<String> = ["Package.swift"]

    static func isSourceCandidate(_ relPath: String) -> Bool {
        let parts = relPath.split(separator: "/").map(String.init)
        guard let file = parts.last, !parts.dropLast().contains(where: { excludedDirs.contains($0) }) else { return false }
        let (_, ext) = splitExt(file)
        guard codeExtensions.contains(ext), !manifests.contains(file) else { return false }
        if parts.dropLast().contains(where: { testDirs.contains($0) }) { return false }
        return !isTestPath(relPath)
    }
    static func isTestPath(_ relPath: String) -> Bool { sourceStem(forTestPath: relPath) != nil }

    static func sourceStem(forTestPath relPath: String) -> String? {
        let parts = relPath.split(separator: "/").map(String.init)
        guard let file = parts.last else { return nil }
        let dirs = parts.dropLast()
        let (name, ext) = splitExt(file)
        guard codeExtensions.contains(ext) else { return nil }
        switch ext {
        case "swift":
            if name.hasSuffix("GapTests"), name.count > 8 { return String(name.dropLast(8)) }
            if name.hasSuffix("Tests") { return String(name.dropLast(5)) }
            if name.hasSuffix("Test") { return String(name.dropLast(4)) }
            return nil
        case "mjs", "cjs", "js", "jsx", "ts", "tsx":
            // The writer's gap files: `x.gap.test.mjs`.
            if name.hasSuffix(".gap.test") || name.hasSuffix(".gap.spec"), name.count > 9 { return String(name.dropLast(9)) }
            if name.hasSuffix(".test") || name.hasSuffix(".spec") { return String(name.dropLast(5)) }
            if dirs.contains("__tests__") || dirs.contains("tests") || dirs.contains("test") { return name }
            return nil
        case "py":
            // The writer's gap file: `test_x_gap.py`.
            if name.hasPrefix("test_"), name.hasSuffix("_gap"), name.count > 9 {
                return String(name.dropFirst(5).dropLast(4))
            }
            if name.hasPrefix("test_") { return String(name.dropFirst(5)) }
            if name.hasSuffix("_test") { return String(name.dropLast(5)) }
            return nil
        case "go": return name.hasSuffix("_test") ? String(name.dropLast(5)) : nil
        case "kt": return name.hasSuffix("Test") ? String(name.dropLast(4)) : nil
        default: return nil
        }
    }
    static func sourceStem(forSourcePath relPath: String) -> String? {
        guard let file = relPath.split(separator: "/").last.map(String.init) else { return nil }
        return splitExt(file).0.split(separator: "+").first.map(String.init)
    }
    /// File name a NEW test for `sourceRelPath` must have, by language.
    static func testFileName(forSourcePath relPath: String) -> String? {
        guard let file = relPath.split(separator: "/").last.map(String.init) else { return nil }
        let (name, ext) = splitExt(file)
        guard codeExtensions.contains(ext) else { return nil }
        let stem = name.split(separator: "+").first.map(String.init) ?? name
        switch ext {
        case "swift": return "\(stem)Tests.swift"
        case "mjs", "cjs", "js", "jsx", "ts", "tsx": return "\(stem).test.\(ext)"
        case "py": return "test_\(stem).py"
        case "go": return "\(stem)_test.go"
        case "kt": return "\(stem)Test.kt"
        default: return nil
        }
    }
    private static let markerRegex: NSRegularExpression? = try? NSRegularExpression(pattern:
        #"(^|[^A-Za-z0-9_.])(it|test|describe)\(|\bfunc test[A-Z_0-9]|@Test\b|\bdef test_|\bfunc Test[A-Z]|\bfun test[A-Z_0-9]|@org\.junit\.Test"#,
        options: [.anchorsMatchLines])
    static func containsTestMarker(_ text: String) -> Bool {
        guard let re = markerRegex else { return false }
        return re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
    private static func splitExt(_ file: String) -> (String, String) {
        guard let dot = file.lastIndex(of: ".") else { return (file, "") }
        return (String(file[..<dot]), String(file[file.index(after: dot)...]))
    }
}
