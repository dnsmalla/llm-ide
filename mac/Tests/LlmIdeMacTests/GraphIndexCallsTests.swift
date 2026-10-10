import XCTest
@testable import LlmIdeMacLib

final class GraphIndexCallsTests: XCTestCase {
    func testDecodesCallsAndRole() throws {
        let json = """
        {"version":"1.1","summary":{"totalFiles":2,"totalEdges":0,"totalCalls":1},"files":[
          {"path":"A.swift","name":"A.swift","language":"swift","loc":10,"role":"Service","imports":[],"usedBy":[],"types":[],"functions":[{"name":"run","line":1}]},
          {"path":"B.swift","name":"B.swift","language":"swift","loc":10,"role":"View","imports":[],"usedBy":[],"types":[],"functions":[{"name":"draw","line":1}]}],
         "calls":[{"from":"B.swift","to":"A.swift","symbol":"run"}]}
        """
        let idx = try JSONDecoder().decode(GraphIndex.self, from: Data(json.utf8))
        XCTAssertEqual(idx.calls.count, 1)
        XCTAssertEqual(idx.callerFiles(of: "A.swift"), ["B.swift"])
        XCTAssertEqual(idx.calleeFiles(of: "B.swift"), ["A.swift"])
        XCTAssertEqual(idx.files[0].role, "Service")
    }
    func testOldGraphWithoutCallsStillDecodes() throws {
        let json = #"{"version":"1.0","files":[{"path":"A.swift","language":"swift","loc":1,"imports":[],"usedBy":[],"types":[],"functions":[]}]}"#
        XCTAssertEqual(try JSONDecoder().decode(GraphIndex.self, from: Data(json.utf8)).calls, [])
    }
}
