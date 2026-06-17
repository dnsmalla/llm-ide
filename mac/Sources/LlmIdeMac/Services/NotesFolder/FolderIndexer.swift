import Foundation
import Dispatch

// Notification.Name extensions moved to Services/NotificationNames.swift

/// Thread-safe by design: `fullScan` is serialized by `scanLock`, the watcher
/// state (`source`/`watchFD`/`pendingScan`) is mutated only on its serial
/// event-handler queue after a one-time `startWatching`, and `index` is itself
/// `Sendable`. `@unchecked Sendable` formalizes the cross-thread use that
/// `AppEnvironment` already relies on.
final class FolderIndexer: @unchecked Sendable {
    let root: URL
    let index: MeetingIndex
    private var source: DispatchSourceFileSystemObject?
    private var watchFD: CInt = -1
    /// Trailing-debounce of watcher events: a burst of writes (e.g. live caption
    /// appends) collapses into a single scan instead of one per event. Mutated
    /// only from the source's serial event-handler queue, so no extra lock.
    private var pendingScan: DispatchWorkItem?
    private let debounceInterval: TimeInterval = 0.6
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
        // One transaction for the whole scan + reap: a crash/throw mid-scan
        // rolls back rather than leaving the index half-updated (ghost/missing
        // rows), and collapses N autocommit fsyncs into one.
        try index.transaction {
            // Index existing rows by path so we can skip unchanged files: a full
            // scan otherwise re-reads + re-parses every .md on every event. With
            // mtime+size matching, an unchanged file costs one stat, not a read.
            let existingRows = try index.list()
            var byPath: [String: MeetingIndex.Row] = [:]
            for r in existingRows { byPath[r.path] = r }

            if let enumerator = fm.enumerator(at: root,
                                              includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
                                              options: [.skipsHiddenFiles]) {
                for case let url as URL in enumerator {
                    let name = url.lastPathComponent
                    guard name.hasSuffix(".md"), !name.hasSuffix(".partial.md") else { continue }
                    let relative = url.path.replacingOccurrences(of: root.path + "/", with: "")
                    // Unchanged (same mtime AND size) → skip the read/parse/upsert.
                    if let row = byPath[relative],
                       let rv = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]),
                       let mdate = rv.contentModificationDate, let fsize = rv.fileSize,
                       Int64(mdate.timeIntervalSince1970 * 1000) == row.fileMtime,
                       Int64(fsize) == row.fileSize {
                        foundIDs.insert(row.id)
                        continue
                    }
                    if let id = try? upsert(fileAt: url) {
                        foundIDs.insert(id)
                    }
                }
            }
            // Reap deletions (reuse the rows we already loaded).
            for r in existingRows where !foundIDs.contains(r.id) {
                try index.delete(id: r.id)
            }
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
        src.setEventHandler { [weak self] in
            guard let self else { return }
            self.pendingScan?.cancel()
            let item = DispatchWorkItem { onChange() }
            self.pendingScan = item
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + self.debounceInterval, execute: item)
        }
        src.setCancelHandler { [fd = watchFD] in close(fd) }
        src.resume()
        source = src
    }

    func stopWatching() {
        source?.cancel(); source = nil
        if watchFD >= 0 { watchFD = -1 }
    }
}
