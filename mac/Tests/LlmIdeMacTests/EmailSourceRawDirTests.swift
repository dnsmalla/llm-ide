// mac/Tests/LlmIdeMacTests/EmailSourceRawDirTests.swift
import XCTest
@testable import LlmIdeMacLib

final class EmailSourceRawDirTests: XCTestCase {
    func testRawInboxRootIsSourceEmails() {
        let sourceRoot = URL(fileURLWithPath: "/tmp/proj/source")
        XCTAssertEqual(EmailSource.rawInboxRoot(sourceRoot: sourceRoot).path,
                       "/tmp/proj/source/emails")
    }
}
