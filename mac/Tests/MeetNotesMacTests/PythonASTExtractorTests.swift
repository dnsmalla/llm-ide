import Testing
import Foundation
@testable import MeetNotesMac

struct PythonASTExtractorTests {
    @Test func parsesScriptJSONIntoRawStructures() throws {
        let json = #"""
        {
          "pkg/a.py": {
            "imports": [{"module": "pkg.b", "name": "foo"}, {"module": "os", "name": null}],
            "symbols": [{"name": "run", "kind": "function", "line": 3},
                        {"name": "Service", "kind": "class", "line": 8},
                        {"name": "Service.start", "kind": "method", "line": 9}],
            "loc": 20
          }
        }
        """#.data(using: .utf8)!
        let raws = try PythonASTExtractor.parse(json)
        #expect(raws.count == 1)
        let a = raws.first { $0.path == "pkg/a.py" }!
        #expect(a.language == "python")
        #expect(a.loc == 20)
        #expect(a.rawImports.contains(RawImport(module: "pkg.b", name: "foo")))
        #expect(a.rawImports.contains(RawImport(module: "os", name: nil)))
        #expect(a.symbols.contains(ScanResult.Symbol(name: "run", kind: "function", line: 3)))
        #expect(a.symbols.contains(ScanResult.Symbol(name: "Service.start", kind: "method", line: 9)))
    }

    @Test func emptyJSONYieldsNoStructures() throws {
        let raws = try PythonASTExtractor.parse("{}".data(using: .utf8)!)
        #expect(raws.isEmpty)
    }
}
