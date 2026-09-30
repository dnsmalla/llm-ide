import XCTest
@testable import LlmIdeMacLib

/// Records every confined agent run instead of calling the server.
final class RecordingLoopAgent: LoopAgentRunning, @unchecked Sendable {
    struct Call: Equatable {
        let message: String
        let skills: [String]
        let repoRoot: URL
        let timeout: TimeInterval?
    }
    private(set) var calls: [Call] = []
    /// What each call returns; the default is a clean, successful run.
    var result: ([String]) -> LoopAgentResult = { skills in
        LoopAgentResult(reply: "done", resolvedSkills: skills)
    }

    func run(message: String, skills: [String], repoRoot: URL,
             timeout: TimeInterval?) async throws -> LoopAgentResult {
        calls.append(Call(message: message, skills: skills, repoRoot: repoRoot, timeout: timeout))
        return result(skills)
    }
}

/// `POST /kb/loop/agent-run` wire contract (extension/routes/loop-agent.mjs)
/// and the three production adapters that use it.
@MainActor
final class LoopAgentRunningTests: XCTestCase {

    private func jsonObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testRequestEncodingUsesServerFieldNames() throws {
        let body = LlmIdeAPIClient.loopAgentRunRequest(
            message: "fix it", skills: ["superpowers/tdd"],
            repoRoot: URL(fileURLWithPath: "/tmp/repo/./sub/.."),
            language: "ja", model: "claude-x", timeout: 90)
        let json = try jsonObject(body)

        XCTAssertEqual(Set(json.keys),
                       ["message", "skills", "repoRoot", "language", "model", "timeoutMs"])
        XCTAssertEqual(json["message"] as? String, "fix it")
        XCTAssertEqual(json["skills"] as? [String], ["superpowers/tdd"])
        XCTAssertEqual(json["repoRoot"] as? String, "/tmp/repo", "absolute, standardized path")
        XCTAssertEqual(json["language"] as? String, "ja")
        XCTAssertEqual(json["model"] as? String, "claude-x")
        XCTAssertEqual(json["timeoutMs"] as? Int, 90_000, "seconds → milliseconds")
    }

    func testRequestOmitsUnsetOptionalsSoServerDefaultsApply() throws {
        let body = LlmIdeAPIClient.loopAgentRunRequest(
            message: "m", skills: [], repoRoot: URL(fileURLWithPath: "/tmp/repo"),
            language: nil, model: nil, timeout: nil)
        let json = try jsonObject(body)
        XCTAssertEqual(Set(json.keys), ["message", "skills", "repoRoot"])
    }

    func testRequestTimeoutSitsAboveTheServerBudget() {
        XCTAssertGreaterThan(LlmIdeAPIClient.loopAgentRequestTimeout(for: 90), 90)
        // nil → the server's 30-minute default, which is longer than the
        // URLSession default of 60 s the request would otherwise get.
        XCTAssertGreaterThan(LlmIdeAPIClient.loopAgentRequestTimeout(for: nil), 30 * 60)
        // Above the 2 h session idle breaker for a long budget, capped at the
        // server's 4 h maximum.
        let capped = LlmIdeAPIClient.loopAgentRequestTimeout(for: 10 * 60 * 60)
        XCTAssertGreaterThan(capped, 4 * 60 * 60)
        XCTAssertLessThan(capped, 4 * 60 * 60 + 10 * 60)
    }

    func testResponseDecodesServerShape() throws {
        let json = """
        {"reply":"edited","changedPaths":["src/a.swift"],
         "usage":{"inputTokens":10,"outputTokens":5,"cacheReadTokens":0,"cacheCreationTokens":0,
                  "costUsd":0.01,"numTurns":3,"durationMs":1200},
         "resolvedSkills":["a/b"],"unresolvedSkills":[],"truncatedSkills":[],
         "ran":true,"resultSubtype":"success",
         "denied":[{"toolName":"Bash","reason":"shell is not available"}]}
        """
        let decoded = try JSONDecoder().decode(LlmIdeAPIClient.LoopAgentRunResponse.self,
                                               from: Data(json.utf8)).result
        XCTAssertEqual(decoded.reply, "edited")
        XCTAssertEqual(decoded.changedPaths, ["src/a.swift"])
        XCTAssertEqual(decoded.usage?.numTurns, 3)
        XCTAssertEqual(decoded.resolvedSkills, ["a/b"])
        XCTAssertTrue(decoded.ran)
        XCTAssertEqual(decoded.denied, [.init(toolName: "Bash", reason: "shell is not available")])
    }

    func testResponseWithUnresolvedSkillDidNotRun() throws {
        let json = #"{"reply":"","changedPaths":[],"unresolvedSkills":["x/y"],"ran":false,"resultSubtype":null}"#
        let decoded = try JSONDecoder().decode(LlmIdeAPIClient.LoopAgentRunResponse.self,
                                               from: Data(json.utf8)).result
        XCTAssertEqual(decoded.unresolvedSkills, ["x/y"])
        XCTAssertFalse(decoded.ran)
        XCTAssertNil(decoded.resultSubtype)
    }

    // MARK: - Adapters

    func testSkillExecutorSendsSkillAndRootAndReturnsResult() async throws {
        let agent = RecordingLoopAgent()
        let root = URL(fileURLWithPath: "/tmp/wt-\(UUID().uuidString)")
        let result = try await AgentLoopSkillExecutor(agent: agent)
            .execute(skillId: "fam/dir", targetPath: "src", message: "go", repoRoot: root)
        XCTAssertEqual(agent.calls, [.init(message: "go", skills: ["fam/dir"], repoRoot: root, timeout: nil)])
        XCTAssertEqual(result.reply, "done")
    }

    func testStageRepairerSendsRootAndReturnsResult() async throws {
        let agent = RecordingLoopAgent()
        let root = URL(fileURLWithPath: "/tmp/wt-\(UUID().uuidString)")
        let result = try await AgentLoopStageRepairer(agent: agent).repair(
            stageName: "Test", command: "swift test", failureOutput: "boom",
            evidence: nil, repoRoot: root)
        XCTAssertEqual(agent.calls.count, 1)
        XCTAssertEqual(agent.calls.first?.repoRoot, root)
        XCTAssertEqual(agent.calls.first?.skills, [])
        XCTAssertTrue(agent.calls.first?.message.contains("boom") == true)
        XCTAssertEqual(result.reply, "done")
    }

    func testFaultRepairerSendsRootAndReturnsResult() async throws {
        let agent = RecordingLoopAgent()
        let root = URL(fileURLWithPath: "/tmp/wt-\(UUID().uuidString)")
        let fault = FaultReport(prompt: "the prompt", response: "the fix", notes: "",
                                severity: .info, reportedAt: Date(), appVersion: "test",
                                agent: "claude_code", status: .fixed, tags: [])
        let result = try await AgentFaultRepairer(agent: agent)
            .repair(fault: fault, failureOutput: "still failing", repoRoot: root)
        XCTAssertEqual(agent.calls.count, 1)
        XCTAssertEqual(agent.calls.first?.repoRoot, root)
        XCTAssertTrue(agent.calls.first?.message.contains("the prompt") == true)
        XCTAssertEqual(result.reply, "done")
    }
}
