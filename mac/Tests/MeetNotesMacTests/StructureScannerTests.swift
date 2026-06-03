import Testing
import Foundation
@testable import MeetNotesMac

struct StructureScannerTests {
    @Test func assemblesScanResultAndResolvesImports() {
        let raws: [RawFileStructure] = [
            RawFileStructure(path: "pkg/a.py", language: "python", loc: 10,
                             rawImports: [RawImport(module: "pkg.b", name: "x"),
                                          RawImport(module: "os", name: nil)],
                             symbols: [.init(name: "run", kind: "function", line: 1)]),
            RawFileStructure(path: "pkg/b.py", language: "python", loc: 4,
                             rawImports: [], symbols: []),
        ]
        let scan = StructureScanner.assemble(raws)
        #expect(scan.files.count == 2)
        #expect(scan.imports["pkg/a.py"] == ["pkg/b.py"])   // pkg.b resolved, os dropped
        #expect(scan.symbols["pkg/a.py"]?.first?.name == "run")
    }

    @Test func mergesPythonAndRipgrepResultsByPath() {
        let py = [RawFileStructure(path: "a.py", language: "python", loc: 1, rawImports: [], symbols: [])]
        let rg = [RawFileStructure(path: "b.ts", language: "typescript", loc: 1, rawImports: [], symbols: [])]
        let scan = StructureScanner.assemble(py + rg)
        #expect(Set(scan.files.map { $0.path }) == ["a.py", "b.ts"])
    }
}
