import Foundation

/// Per-file structural facts produced by an extractor, before import
/// resolution. `rawImports` are unresolved targets (Python dotted modules,
/// or quoted import paths for TS/JS). `StructureScanner` resolves them to
/// internal file paths and assembles the final `ScanResult`.
public struct RawFileStructure: Codable, Equatable, Sendable {
    public let path: String          // relative to repo root
    public let language: String      // python | typescript | javascript | swift | other
    public let loc: Int
    public let rawImports: [RawImport]
    public let symbols: [ScanResult.Symbol]

    public init(path: String, language: String, loc: Int,
                rawImports: [RawImport], symbols: [ScanResult.Symbol]) {
        self.path = path
        self.language = language
        self.loc = loc
        self.rawImports = rawImports
        self.symbols = symbols
    }
}

/// An unresolved import. `module` is a dotted path (Python) or a quoted
/// import specifier (TS/JS, e.g. "./foo", "../bar"). `name` is the
/// specifically-imported symbol when known (Python `from a import b`).
public struct RawImport: Codable, Equatable, Sendable {
    public let module: String
    public let name: String?
    public init(module: String, name: String? = nil) {
        self.module = module
        self.name = name
    }
}
