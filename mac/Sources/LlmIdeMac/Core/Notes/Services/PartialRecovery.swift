import Foundation

final class PartialRecovery {
    struct Orphan: Codable, Equatable, Identifiable {
        let id: String
        let path: String
        let pid: Int32
        let startedAt: Date
        /// Recorder's process start time (µs, `ProcessTree.startTime`). Guards
        /// against PID reuse; nil on legacy records (pid-only liveness).
        var pidStartTime: UInt64? = nil
    }
    let recoveryDir: URL

    /// `notesFolder` is the active notes/source folder (`notesConfig.currentFolder`).
    /// When a project is open it is `<project>/source`, so recovery records belong
    /// under the project's `system/` tree — not as a stray `.llmide` beside the
    /// user's content. With no active project (a legacy notes folder that isn't a
    /// project's `source/`) we keep the original local `.llmide/recovery` location.
    init(notesFolder: URL) {
        if notesFolder.lastPathComponent == "source" {
            let projectRoot = notesFolder.deletingLastPathComponent()
            let layout = ProjectLayout(root: projectRoot)
            if FileManager.default.fileExists(atPath: layout.projectJSON.path) {
                self.recoveryDir = layout.cacheDir.appendingPathComponent("recovery", isDirectory: true)
                return
            }
        }
        self.recoveryDir = notesFolder.appendingPathComponent(".llmide/recovery", isDirectory: true)
    }

    func record(id: String, path: URL, pid: Int32 = ProcessInfo.processInfo.processIdentifier,
                startedAt: Date,
                pidStartTime: UInt64? = nil) throws {
        try FileManager.default.createDirectory(at: recoveryDir, withIntermediateDirectories: true)
        let record = Orphan(id: id, path: path.path, pid: pid, startedAt: startedAt,
                            pidStartTime: pidStartTime ?? ProcessTree.startTime(of: pid))
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
            if !Self.isOwnerAlive(pid: r.pid, startTime: r.pidStartTime) { out.append(r) }
        }
        return out
    }

    /// The recorder is alive only if the pid exists AND (when a start time was
    /// recorded) it is still the same process — a recycled pid has a different
    /// start time. Legacy records without a start time keep pid-only behaviour.
    static func isOwnerAlive(pid: Int32, startTime: UInt64?) -> Bool {
        // kill(pid, 0) returns 0 if the process exists (EPERM also means it exists).
        let exists = kill(pid, 0) == 0 || errno == EPERM
        guard exists else { return false }
        guard let startTime else { return true }
        guard let current = ProcessTree.startTime(of: pid) else { return false }
        return current == startTime
    }
}
