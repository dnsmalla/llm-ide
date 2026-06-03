import Testing
@testable import MeetNotesMac

struct RipgrepExtractorTests {
    @Test func detectsLanguageByExtension() {
        #expect(RipgrepExtractor.language(for: "a.ts") == "typescript")
        #expect(RipgrepExtractor.language(for: "a.tsx") == "typescript")
        #expect(RipgrepExtractor.language(for: "a.js") == "javascript")
        #expect(RipgrepExtractor.language(for: "a.jsx") == "javascript")
        #expect(RipgrepExtractor.language(for: "Foo.swift") == "swift")
        #expect(RipgrepExtractor.language(for: "a.py") == "python")
        #expect(RipgrepExtractor.language(for: "README.md") == "other")
    }

    @Test func parsesTSImportSpecifier() {
        #expect(RipgrepExtractor.importSpecifier(fromLine: "import { x } from './foo'", language: "typescript") == "./foo")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "import y from \"../bar/baz\"", language: "typescript") == "../bar/baz")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "const z = require('./q')", language: "javascript") == "./q")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "import React from 'react'", language: "typescript") == "react")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "let a = 1", language: "typescript") == nil)
    }

    @Test func parsesSwiftImportModule() {
        #expect(RipgrepExtractor.importSpecifier(fromLine: "import Foundation", language: "swift") == "Foundation")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "  import SwiftUI", language: "swift") == "SwiftUI")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "func foo() {}", language: "swift") == nil)
    }

    @Test func parsesSymbolDefinitions() {
        #expect(RipgrepExtractor.symbol(fromLine: "export function doThing(x) {", language: "typescript")?.name == "doThing")
        #expect(RipgrepExtractor.symbol(fromLine: "class Widget {", language: "typescript")?.name == "Widget")
        #expect(RipgrepExtractor.symbol(fromLine: "struct Point {", language: "swift")?.name == "Point")
        #expect(RipgrepExtractor.symbol(fromLine: "func render() -> some View {", language: "swift")?.name == "render")
        #expect(RipgrepExtractor.symbol(fromLine: "// just a comment", language: "swift") == nil)
    }
}
