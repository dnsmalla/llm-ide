import Testing
import Foundation
@testable import LlmIdeMacLib

/// The repair guard exempts a protected file only while it still holds exactly
/// what the app last wrote — an agent's edit must never pass as the app's.
@Suite("App-written files", .serialized)
struct AppWrittenFilesTests {
    private func tempFile() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("appwritten-\(UUID().uuidString).json")
        return url
    }

    @Test func unchangedSinceAppWriteIsRecognised() throws {
        let url = try tempFile()
        defer { try? FileManager.default.removeItem(at: url) }
        let data = Data("{\"a\":1}".utf8)
        try data.write(to: url)
        AppWrittenFiles.recordWrite(of: data, to: url)
        #expect(AppWrittenFiles.isUnchangedSinceAppWrite(url))
    }

    @Test func anyLaterEditIsNotTheApps() throws {
        let url = try tempFile()
        defer { try? FileManager.default.removeItem(at: url) }
        let data = Data("{\"a\":1}".utf8)
        try data.write(to: url)
        AppWrittenFiles.recordWrite(of: data, to: url)
        try Data("{\"a\":2}".utf8).write(to: url)
        #expect(!AppWrittenFiles.isUnchangedSinceAppWrite(url))
    }

    @Test func aFileTheAppNeverWroteIsNeverExempt() throws {
        let url = try tempFile()
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("x".utf8).write(to: url)
        #expect(!AppWrittenFiles.isUnchangedSinceAppWrite(url))
        #expect(!AppWrittenFiles.isUnchangedSinceAppWrite(url.appendingPathExtension("missing")))
    }
}
