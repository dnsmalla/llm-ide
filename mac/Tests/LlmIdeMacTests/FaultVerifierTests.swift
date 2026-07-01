import Testing
import Foundation
@testable import LlmIdeMac

struct FaultVerifierTests {
    private func tmpRepo() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("verify-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func passingCommandReturnsZeroExit() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let out = try await ShellFaultVerifier().verify(command: "true", repoRoot: repo, timeout: 10)
        #expect(out.exitCode == 0)
    }

    @Test func failingCommandReturnsNonZeroExit() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let out = try await ShellFaultVerifier().verify(command: "false", repoRoot: repo, timeout: 10)
        #expect(out.exitCode != 0)
    }

    @Test func capturesOutput() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let out = try await ShellFaultVerifier().verify(command: "echo hello-verify", repoRoot: repo, timeout: 10)
        #expect(out.output.contains("hello-verify"))
    }

    @Test func timeoutKillsAndThrows() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        await #expect(throws: VerifyError.self) {
            _ = try await ShellFaultVerifier().verify(command: "sleep 5", repoRoot: repo, timeout: 1)
        }
    }
}
