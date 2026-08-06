import XCTest
@testable import LlmIdeMacLib

@MainActor
final class TaskLogStoreTests: XCTestCase {
    func testStringAppendAndLinesRoundTrip() {
        let store = TaskLogStore()
        store.append("custom-123", "hello")
        let lines = store.lines(for: "custom-123")
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines.first?.text, "hello")
        XCTAssertEqual(lines.first?.level, .info)
    }

    func testStringClearEmptiesOnlyThatId() {
        let store = TaskLogStore()
        store.append("custom-a", "line a")
        store.append("custom-b", "line b")

        store.clear("custom-a")

        XCTAssertEqual(store.lines(for: "custom-a").count, 0)
        XCTAssertEqual(store.lines(for: "custom-b").count, 1)
    }

    func testAutoTaskAndItsRawValueShareTheSameBuffer() {
        let store = TaskLogStore()
        store.append(.reviewCode, "via enum")
        store.append("reviewCode", "via string")

        let viaEnum = store.lines(for: AutoTask.reviewCode)
        let viaString = store.lines(for: "reviewCode")
        XCTAssertEqual(viaEnum.count, 2)
        XCTAssertEqual(viaString.count, 2)
        XCTAssertEqual(viaEnum.map(\.text), viaString.map(\.text))
    }

    func testEmptyOrWhitespaceOnlyTextIsIgnored() {
        let store = TaskLogStore()
        store.append("custom-x", "   \n  ")
        XCTAssertEqual(store.lines(for: "custom-x").count, 0)
    }
}
