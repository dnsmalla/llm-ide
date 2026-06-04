import Foundation

final class PartialRecovery {
    struct Orphan: Codable, Equatable, Identifiable {
        let id: String
        let path: String
        let pid: Int32
        let startedAt: Date
    }
    let recoveryDir: URL
    init(root: URL) {
        self.recoveryDir = root.appendingPathComponent(".llmide/recovery", isDirectory: true)
    }

    func record(id: String, path: URL, pid: Int32 = ProcessInfo.processInfo.processIdentifier,
                startedAt: Date) throws {
        try FileManager.default.createDirectory(at: recoveryDir, withIntermediateDirectories: true)
        let record = Orphan(id: id, path: path.path, pid: pid, startedAt: startedAt)
        let data = try AppJSON.iso8601Encoder.encode(record)
        try data.write(to: recoveryDir.appendingPathComponent("\(id).json"), options: .atomic)
    }

    func cleanup(id: String) throws {
        let url = recoveryDir.appendingPathComponent("\(id).json")
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    /// Returns recovery records whose PID is no longer running.
    func scanOrphans() throws -> [Orphan] {
        guard FileManager.default.fileExists(atPath: recoveryDir.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: recoveryDir,
                                                                includingPropertiesForKeys: nil)
        var out: [Orphan] = []
        for f in files where f.pathExtension == "json" {
            guard let data = try? Data(contentsOf: f),
                  let r = try? AppJSON.iso8601Decoder.decode(Orphan.self, from: data) else { continue }
            if !isProcessAlive(r.pid) { out.append(r) }
        }
        return out
    }

    private func isProcessAlive(_ pid: Int32) -> Bool {
        // kill(pid, 0) returns 0 if signal could be sent (process exists)
        // and -1 with errno=ESRCH if not.
        return kill(pid, 0) == 0
    }
}
