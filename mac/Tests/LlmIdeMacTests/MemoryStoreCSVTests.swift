import Testing
import Foundation
@testable import LlmIdeMac

/// Tests for `MemoryStore.exportFaultsCSV` — the faults registry export.
struct MemoryStoreCSVTests {
    private func tmpRepoDir() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("memory-csv-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func fault(prompt: String, response: String = "answer",
                       severity: FaultSeverity = .major,
                       status: FaultStatus = .open,
                       agent: String = "claude_code",
                       appVersion: String = "0.1.0",
                       gitHead: String? = "abc123",
                       reportedAt: Date = Date(timeIntervalSince1970: 1_716_465_600)) -> FaultReport {
        FaultReport(
            prompt: prompt, response: response, notes: "",
            severity: severity, reportedAt: reportedAt,
            gitHead: gitHead, appVersion: appVersion, agent: agent,
            status: status, tags: []
        )
    }

    private func rows(of csv: String) -> [String] {
        // Split into logical lines. Quoted cells may contain embedded
        // newlines; for the header / simple cases the file's first line
        // is always the header regardless.
        csv.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    @Test func headerLineIsExact() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try store.writeFault(at: repo, fault(prompt: "explain auth"))

        let url = try store.exportFaultsCSV(at: repo)
        let contents = try String(contentsOf: url, encoding: .utf8)
        let header = contents.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init)
        #expect(header == "reported,severity,status,fault,answer,verify,git_head,app_version,agent,file")
    }

    @Test func returnsCSVURLUnderMemorySubdir() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try store.writeFault(at: repo, fault(prompt: "q"))

        let url = try store.exportFaultsCSV(at: repo)
        #expect(url.lastPathComponent == "faults.csv")
        let expected = repo.appendingPathComponent(".understand-anything/memory/faults.csv")
        #expect(url.standardizedFileURL.path == expected.standardizedFileURL.path)
        #expect(FileManager.default.fileExists(atPath: url.path))
    }

    @Test func includesBothFixedAndOpenFaults() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try store.writeFault(at: repo, fault(prompt: "open one", status: .open))
        _ = try store.writeFault(at: repo, fault(prompt: "fixed one", status: .fixed,
                                                 reportedAt: Date(timeIntervalSince1970: 1_716_552_000)))

        let url = try store.exportFaultsCSV(at: repo)
        let contents = try String(contentsOf: url, encoding: .utf8)
        #expect(contents.contains("open one"))
        #expect(contents.contains("fixed one"))
        // Header + 2 data rows.
        let dataLines = rows(of: contents).dropFirst().filter { !$0.isEmpty }
        #expect(dataLines.count == 2)
    }

    @Test func statusColumnReflectsTheFilesStatus() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try store.writeFault(at: repo, fault(prompt: "p", status: .fixed))

        let url = try store.exportFaultsCSV(at: repo)
        let contents = try String(contentsOf: url, encoding: .utf8)
        let dataLine = rows(of: contents).dropFirst().first { !$0.isEmpty }
        // status is the 3rd column.
        #expect(dataLine?.contains(",\"fixed\",") == true)
    }

    @Test func quotesNewlinesAndCommasInPromptAreEscaped() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try store.writeFault(at: repo,
            fault(prompt: "has \"quote\", comma\nand newline"))

        let url = try store.exportFaultsCSV(at: repo)
        let contents = try String(contentsOf: url, encoding: .utf8)
        // Internal double-quotes are doubled; whitespace (incl. newline)
        // is collapsed to single spaces, and the cell is wrapped in quotes.
        #expect(contents.contains("\"has \"\"quote\"\", comma and newline\""))
        // The collapsed cell must not introduce a raw newline mid-row.
        #expect(!contents.contains("comma\nand"))
    }

    @Test func onlyMarkdownFaultsAreCounted() throws {
        let repo = try tmpRepoDir()
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try store.writeFault(at: repo, fault(prompt: "real"))
        // Drop a non-markdown file in the faults dir — must be ignored.
        let faultsDir = repo.appendingPathComponent(".understand-anything/memory/faults")
        try "not a fault".write(to: faultsDir.appendingPathComponent("notes.txt"),
                                atomically: true, encoding: .utf8)

        let url = try store.exportFaultsCSV(at: repo)
        let contents = try String(contentsOf: url, encoding: .utf8)
        let dataLines = rows(of: contents).dropFirst().filter { !$0.isEmpty }
        #expect(dataLines.count == 1)
        #expect(contents.contains("real"))
    }
}
