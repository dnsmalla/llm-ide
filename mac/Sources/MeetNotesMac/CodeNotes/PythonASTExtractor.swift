import Foundation

/// Extracts structure from `.py` files by running the bundled stdlib-`ast`
/// scanner via python3. Pure parsing of the script's JSON is separated out
/// (`parse`) for testability; `run` handles process invocation.
public final class PythonASTExtractor {
    private let launcher: ProcessLauncher
    private let pythonURL: URL?
    private let scriptURL: URL?

    public init(launcher: ProcessLauncher,
                pythonURL: URL? = PythonASTExtractor.resolvePython(),
                scriptURL: URL? = PythonASTExtractor.bundledScriptURL()) {
        self.launcher = launcher
        self.pythonURL = pythonURL
        self.scriptURL = scriptURL
    }

    /// Locate python3 on PATH / common locations. Returns nil if absent.
    public static func resolvePython() -> URL? {
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                let cand = URL(fileURLWithPath: String(dir)).appendingPathComponent("python3")
                if FileManager.default.isExecutableFile(atPath: cand.path) { return cand }
            }
        }
        for p in ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
            if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }

    /// The bundled scanner script inside the app bundle.
    public static func bundledScriptURL() -> URL? {
        Bundle.main.url(forResource: "code_ast_scan", withExtension: "py")
    }

    /// Run the scanner over `repoRoot`. Returns [] if python3 or the script
    /// is unavailable (Python files still appear via ripgrep enumeration).
    public func run(repoRoot: URL) async -> [RawFileStructure] {
        guard let python = pythonURL, let script = scriptURL else { return [] }
        do {
            let (exit, stdout, _) = try await launcher.run(
                executable: python,
                arguments: [script.path, repoRoot.path],
                currentDirectory: repoRoot,
                environment: nil)
            guard exit == 0 else { return [] }
            return (try? Self.parse(stdout)) ?? []
        } catch {
            return []
        }
    }

    /// Decode the script's JSON into RawFileStructure values.
    public static func parse(_ data: Data) throws -> [RawFileStructure] {
        struct RawSym: Decodable { let name: String; let kind: String; let line: Int }
        struct RawImp: Decodable { let module: String; let name: String? }
        struct RawFile: Decodable { let imports: [RawImp]; let symbols: [RawSym]; let loc: Int }
        let map = try JSONDecoder().decode([String: RawFile].self, from: data)
        return map.map { (path, f) in
            RawFileStructure(
                path: path,
                language: "python",
                loc: f.loc,
                rawImports: f.imports.map { RawImport(module: $0.module, name: $0.name) },
                symbols: f.symbols.map { ScanResult.Symbol(name: $0.name, kind: $0.kind, line: $0.line) })
        }.sorted { $0.path < $1.path }
    }
}
