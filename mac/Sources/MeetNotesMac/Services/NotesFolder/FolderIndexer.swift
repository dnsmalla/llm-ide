import Foundation
import Dispatch

// Notification.Name extensions moved to Services/NotificationNames.swift

final class FolderIndexer {
    let root: URL
    let index: MeetingIndex
    private var source: DispatchSourceFileSystemObject?
    private var watchFD: CInt = -1
    /// Serialization gate for `fullScan`. The kqueue watcher fires on
    /// `DispatchQueue.global(.utility)` while `AppEnvironment.init` and
    /// manual settings actions can also drive a scan — without this
    /// lock the read-then-delete reap loop could observe a row added
    /// by one in-flight scan and delete it because another, older
    /// scan's `foundIDs` snapshot predated it. Result: missing rows in
    /// the index until the next watcher fire.
    private let scanLock = NSLock()

    init(root: URL, index: MeetingIndex) {
        self.root = root
        self.index = index
    }

    deinit { stopWatching() }

    /// Full re-scan of the notes folder.  Upserts every .md found,
    /// deletes index rows for files no longer on disk.
    ///
    /// Serialized via `scanLock`: at most one fullScan runs at a time.
    /// If a second caller arrives while one is in progress it blocks
    /// briefly — preferable to interleaving with the reap step.
    func fullScan() throws {
        scanLock.lock()
        defer { scanLock.unlock() }
        let fm = FileManager.default
        var foundIDs = Set<String>()
        if let enumerator = fm.enumerator(at: root,
                                          includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
                                          options: [.skipsHiddenFiles]) {
            for case let url as URL in enumerator {
                let name = url.lastPathComponent
                guard name.hasSuffix(".md"), !name.hasSuffix(".partial.md") else { continue }
                if let id = try? upsert(fileAt: url) {
                    foundIDs.insert(id)
                }
            }
        }
        // Reap deletions.
        let existing = try index.list().map(\.id)
        for id in existing where !foundIDs.contains(id) {
            try index.delete(id: id)
        }
        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
    }

    @discardableResult
    private func upsert(fileAt url: URL) throws -> String? {
        let contents = try String(contentsOf: url, encoding: .utf8)
        guard let split = FrontmatterCoder.split(file: contents) else { return nil }
        let fm = try FrontmatterCoder.decode(split.yaml)
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        let mtime = Int64(((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000)
        let size = (attrs[.size] as? Int64) ?? 0
        let body = String(contents[split.bodyStart...])

        let relative = url.path.replacingOccurrences(of: root.path + "/", with: "")
        let tldrJSON: String?
        if !fm.tldr.isEmpty,
           let data = try? AppJSON.encoder.encode(fm.tldr),
           let s = String(data: data, encoding: .utf8) {
            tldrJSON = s
        } else { tldrJSON = nil }

        let actionsCount = countListItems(in: body, under: "## Actions")
        let decisionsCount = countListItems(in: body, under: "## Decisions")
        let blockersCount = countListItems(in: body, under: "## Blockers")

        try index.upsert(MeetingIndex.Row(
            id: fm.id, path: relative, title: fm.title,
            startedAt: Int64(fm.startedAt.timeIntervalSince1970 * 1000),
            endedAt: fm.endedAt.map { Int64($0.timeIntervalSince1970 * 1000) },
            durationSec: fm.durationSeconds,
            gist: fm.gist, tldrJSON: tldrJSON,
            actionsCount: actionsCount,
            decisionsCount: decisionsCount,
            blockersCount: blockersCount,
            fileMtime: mtime, fileSize: size,
            indexedAt: Int64(Date().timeIntervalSince1970 * 1000)
        ))
        return fm.id
    }

    private func countListItems(in body: String, under heading: String) -> Int {
        guard let r = body.range(of: heading) else { return 0 }
        let after = String(body[r.upperBound...])
        let nextHeading = after.range(of: "\n## ")?.lowerBound ?? after.endIndex
        let section = after[..<nextHeading]
        return section.split(separator: "\n").filter { $0.hasPrefix("- ") }.count
    }

    // MARK: kqueue watching

    func startWatching(onChange: @escaping () -> Void) {
        stopWatching()
        watchFD = open(root.path, O_EVTONLY)
        guard watchFD >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: watchFD,
            eventMask: [.write, .extend, .rename, .delete],
            queue: DispatchQueue.global(qos: .utility))
        src.setEventHandler { onChange() }
        src.setCancelHandler { [fd = watchFD] in close(fd) }
        src.resume()
        source = src
    }

    func stopWatching() {
        source?.cancel(); source = nil
        if watchFD >= 0 { watchFD = -1 }
    }
}
