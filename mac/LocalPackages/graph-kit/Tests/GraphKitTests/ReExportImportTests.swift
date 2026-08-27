import XCTest
@testable import GraphKit

final class ReExportImportTests: XCTestCase {
    private func spec(_ line: String) -> String? {
        FileStructureExtractor.importSpecifier(fromLine: line, language: "javascript")
    }

    func testNamedReExportIsCaptured() {
        XCTAssertEqual(spec("export { revokeJti, isJtiRevoked } from './user.mjs';"),
                       "./user.mjs")
    }

    func testStarReExportIsCaptured() {
        XCTAssertEqual(spec("export * from \"./meetings.mjs\";"), "./meetings.mjs")
    }

    func testPlainExportConstIsNotAnImport() {
        XCTAssertNil(spec("export const from = 'somewhere';"),
                     "export without a module specifier context must not match")
        XCTAssertNil(spec("export function backupTo(targetPath) {"))
    }

    func testExistingImportBehaviorUnchanged() {
        XCTAssertEqual(spec("import { getDb } from './db.mjs';"), "./db.mjs")
        XCTAssertEqual(spec("const x = require('better-sqlite3');"), "better-sqlite3")
        XCTAssertEqual(spec("const m = await import('./kb/db.mjs');"), "./kb/db.mjs")
        XCTAssertNil(spec("// just a comment about exporting"))
    }

    func testMultiLineReExportClosingLineIsCaptured() {
        // The opening line has no specifier yet — must return nil.
        XCTAssertNil(spec("export {"))
        // The closing line carries the specifier and must be captured.
        XCTAssertEqual(spec("} from './meetings.mjs';"), "./meetings.mjs")
    }

    func testTypeOnlyReExportIsCaptured() {
        XCTAssertEqual(spec("export type { UserRow } from './types.mjs';"), "./types.mjs")
    }

    func testPlainClosingBraceWithoutFromStillReturnsNil() {
        XCTAssertNil(spec("}"))
        XCTAssertNil(spec("  } // end of function"))
    }
}
