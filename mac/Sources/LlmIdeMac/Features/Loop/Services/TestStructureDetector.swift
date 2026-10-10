import Foundation

/// Finds where the repo's tests live (depth <= 2 below the git root) and
/// writes TEST-STRUCTURE.md/.json. Never creates test directories.
struct TestStructureDetector {
    var gitRoot: URL

    func detect() -> TestStructure {
        var roots: [TestRoot] = []
        var notes: [String] = []
        for pkg in packageDirs() {
            detectSwift(pkg, &roots, &notes)
            detectNode(pkg, &roots, &notes)
            detectPython(pkg, &roots, &notes)
            detectGo(pkg, &roots)
            detectCargo(pkg, &roots)
        }
        return TestStructure(generatedAt: Date(), roots: roots, status: roots.isEmpty ? "missing" : "ok", notes: notes)
    }

    @discardableResult
    func write(_ s: TestStructure, outputRoot: URL? = nil) throws -> URL {
        let out = outputRoot ?? gitRoot
        let dir = out.appendingPathComponent(LoopOutputLayout.testDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let md = out.appendingPathComponent(LoopOutputLayout.testStructureMD)
        try s.render().write(to: md, atomically: true, encoding: .utf8)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        enc.dateEncodingStrategy = .iso8601
        try enc.encode(s).write(to: out.appendingPathComponent(LoopOutputLayout.testStructureJSON), options: .atomic)
        return md
    }

    // MARK: - Walk

    /// "" (root), then every directory at depth 1 and 2, sorted, excluded dirs skipped.
    private func packageDirs() -> [String] {
        var out = [""]
        func children(_ rel: String) -> [String] {
            let url = rel.isEmpty ? gitRoot : gitRoot.appendingPathComponent(rel)
            let names = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
            return names.sorted().filter { name in
                guard !TestSourceMapper.excludedDirs.contains(name) else { return false }
                var isDir: ObjCBool = false
                return FileManager.default.fileExists(atPath: url.appendingPathComponent(name).path, isDirectory: &isDir) && isDir.boolValue
            }
        }
        for d1 in children("") {
            out.append(d1)
            for d2 in children(d1) { out.append("\(d1)/\(d2)") }
        }
        return out
    }

    private func join(_ pkg: String, _ rest: String) -> String { pkg.isEmpty ? rest : "\(pkg)/\(rest)" }
    private func exists(_ rel: String) -> Bool { FileManager.default.fileExists(atPath: gitRoot.appendingPathComponent(rel).path) }
    private func read(_ rel: String) -> String? { try? String(contentsOf: gitRoot.appendingPathComponent(rel), encoding: .utf8) }
    private func label(_ pkg: String) -> String { pkg.isEmpty ? "." : pkg }
    private func cd(_ pkg: String, _ cmd: String) -> String { pkg.isEmpty ? cmd : "cd \(VerifyCommandBuilder.shellWord(pkg)) && \(cmd)" }
    private func firstExisting(_ pkg: String, _ candidates: [String]) -> String? {
        candidates.map { join(pkg, $0) }.first(where: exists)
    }
    private func naming(_ languages: [String]) -> String {
        languages.compactMap { ext in
            TestSourceMapper.testFileName(forSourcePath: "Foo.\(ext)").map { "Foo.\(ext) → \($0)" }
        }.joined(separator: "; ")
    }
    private func root(_ pkg: String, _ testDir: String, _ runner: TestRunner, _ command: String, _ langs: [String]) -> TestRoot {
        TestRoot(packageDir: pkg, testDir: testDir, runner: runner, command: command, namingRule: naming(langs), languages: langs)
    }

    // MARK: - Detectors

    private func detectSwift(_ pkg: String, _ roots: inout [TestRoot], _ notes: inout [String]) {
        guard let text = read(join(pkg, "Package.swift")) else { return }
        guard text.contains(".testTarget(") else {
            notes.append("\(label(pkg)): Package.swift has no testTarget"); return
        }
        let names = matches(#"\.testTarget\(\s*name:\s*"([^"]+)""#, in: text)
        guard let dir = firstExisting(pkg, names.map { "Tests/\($0)" }) else {
            notes.append("\(label(pkg)): no test directory found for Package.swift"); return
        }
        roots.append(root(pkg, dir, .xctest, cd(pkg, "swift test"), ["swift"]))
    }

    private func detectNode(_ pkg: String, _ roots: inout [TestRoot], _ notes: inout [String]) {
        guard let text = read(join(pkg, "package.json")),
              let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let script = (obj["scripts"] as? [String: Any])?["test"] as? String,
              LoopStageDetector.isRunnableNpmTestScript(script) else { return }
        guard let dir = firstExisting(pkg, ["tests", "test", "__tests__", "src/__tests__"]) else {
            notes.append("\(label(pkg)): no test directory found for package.json"); return
        }
        // `.nodeTest` only for a plain `node --test [path]`: its single-test verify
        // command assumes `tests/` and no flags, so any other script (flags, globs,
        // a loader) is `.npm` and falls back to the suite command.
        let trimmed = script.trimmingCharacters(in: .whitespaces)
        let plainNodeTest = trimmed.range(of: #"^node --test( +[^- ][^ ]*)?$"#, options: .regularExpression) != nil
        let runner: TestRunner = script.contains("jest") ? .jest : (plainNodeTest ? .nodeTest : .npm)
        roots.append(root(pkg, dir, runner, cd(pkg, "npm test"), ["mjs", "js"]))
    }

    private func detectPython(_ pkg: String, _ roots: inout [TestRoot], _ notes: inout [String]) {
        let mentions = exists(join(pkg, "pytest.ini"))
            || ["pyproject.toml", "setup.cfg"].contains { (read(join(pkg, $0)) ?? "").contains("pytest") }
        guard mentions else { return }
        guard let dir = firstExisting(pkg, ["tests", "test"]) else {
            notes.append("\(label(pkg)): no test directory found for pytest"); return
        }
        roots.append(root(pkg, dir, .pytest, cd(pkg, "pytest"), ["py"]))
    }

    private func detectGo(_ pkg: String, _ roots: inout [TestRoot]) {
        guard exists(join(pkg, "go.mod")) else { return }
        roots.append(root(pkg, pkg, .goTest, cd(pkg, "go test ./..."), ["go"]))
    }

    private func detectCargo(_ pkg: String, _ roots: inout [TestRoot]) {
        guard exists(join(pkg, "Cargo.toml")) else { return }
        let dir = exists(join(pkg, "tests")) ? join(pkg, "tests") : pkg
        roots.append(root(pkg, dir, .cargo, cd(pkg, "cargo test"), ["rs"]))
    }

    private func matches(_ pattern: String, in text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
    }
}
