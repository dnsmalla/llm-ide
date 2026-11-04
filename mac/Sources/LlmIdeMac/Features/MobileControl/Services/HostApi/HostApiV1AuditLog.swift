import Foundation

struct HostApiV1AuditEvent: Codable, Equatable {
    let ts: Date
    let event: String
    let peer: String
    let deviceId: String?
    let detail: String?
}

/// Host API v1 audit log (plan decision 8): append-only JSONL in Application Support, mode 0600, rotated to
/// `.1` past `maxBytes`. Event names are shared with `extension/routes/host-api/audit.mjs`. Never pass a token,
/// PIN, key or frame text: `detail` is a short reason, clamped to `detailMax` characters.
final class HostApiV1AuditLog: @unchecked Sendable {
    static let dedupeWindow: TimeInterval = 60
    static let detailMax = 200
    static let maxDedupeKeys = 1024
    /// Hard cap per event type across all peers, so a flood of distinct peers/origins cannot churn the log.
    static let eventCapPerMinute = 60

    private let fileURL: URL
    private let maxBytes: Int
    private let echo: (String) -> Void
    private let queue = DispatchQueue(label: "llmide.hostapi.audit")
    // Only touched on `queue`.
    private var lastWrite: [String: Date] = [:]   // "event\0dedupeKey" -> time
    private var perEvent: [String: (start: Date, rows: Int, dropped: Int)] = [:]   // keyed by the fixed event names
    private var dropped = 0

    /// `~/Library/Application Support/llm-ide/host-api-audit.jsonl`, next to `mobile-paired-devices.json`.
    static func defaultFileURL() -> URL {
        MobilePairedDeviceStore.defaultFileURL().deletingLastPathComponent().appendingPathComponent("host-api-audit.jsonl")
    }

    init(fileURL: URL = defaultFileURL(), maxBytes: Int = 512 * 1024, echo: @escaping (String) -> Void = { _ in }) {
        self.fileURL = fileURL; self.maxBytes = maxBytes; self.echo = echo
    }

    func record(_ event: String, peer: String, deviceId: String? = nil, detail: String? = nil,
                dedupeKey: String? = nil, now: Date = Date()) {
        let row = HostApiV1AuditEvent(ts: now, event: event, peer: String(peer.prefix(Self.detailMax)), deviceId: deviceId,
                                      detail: detail.map { String($0.prefix(Self.detailMax)) })
        queue.async {
            if let dedupeKey {
                let key = event + "\0" + dedupeKey
                if let t = self.lastWrite[key], now.timeIntervalSince(t) < Self.dedupeWindow { return }
                if self.lastWrite.count >= Self.maxDedupeKeys {
                    self.lastWrite = self.lastWrite.filter { now.timeIntervalSince($0.value) < Self.dedupeWindow }
                    // shortcut: a flood of distinct keys resets de-dup (same as the desktop); rotation still bounds the file
                    if self.lastWrite.count >= Self.maxDedupeKeys { self.lastWrite.removeAll() }
                }
                self.lastWrite[key] = now
            }
            guard self.admit(event, now) else { return }
            self.append(row)
            self.echo("Host API v1 audit \(event) from \(row.peer)")
        }
    }

    /// True when this event type still has room in its window. A closed window that dropped rows writes one
    /// `<event>_suppressed` summary row, lazily, on the first record after it (the desktop's `admit`; no timer).
    private func admit(_ event: String, _ now: Date) -> Bool {
        var w = perEvent[event] ?? (now, 0, 0)
        if now.timeIntervalSince(w.start) >= Self.dedupeWindow {
            if w.dropped > 0 {
                append(HostApiV1AuditEvent(ts: now, event: event + "_suppressed", peer: "-", deviceId: nil,
                                           detail: "\(w.dropped) more \(event) rows dropped in one minute"))
            }
            w = (now, 0, 0)
        }
        defer { perEvent[event] = w }
        if w.rows >= Self.eventCapPerMinute { w.dropped += 1; dropped += 1; return false }
        w.rows += 1
        return true
    }

    /// Events not written because their type was over `eventCapPerMinute`.
    var droppedCount: Int { queue.sync { dropped } }

    func recent(limit: Int) -> [HostApiV1AuditEvent] {
        queue.sync {
            let decoder = Self.decoder()
            let rotated = fileURL.appendingPathExtension("1")
            let lines = [rotated, fileURL].flatMap { url -> [Substring] in
                ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n")
            }
            return lines.suffix(max(0, limit)).compactMap { try? decoder.decode(HostApiV1AuditEvent.self, from: Data($0.utf8)) }
        }
    }

    private func append(_ row: HostApiV1AuditEvent) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard var line = try? encoder.encode(row) else { return }
        line.append(0x0A)
        let fm = FileManager.default
        try? fm.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let size = (try? fm.attributesOfItem(atPath: fileURL.path)[.size] as? Int) ?? 0
        if size > 0, size + line.count > maxBytes {
            let rotated = fileURL.appendingPathExtension("1")
            try? fm.removeItem(at: rotated)
            try? fm.moveItem(at: fileURL, to: rotated)
        }
        if !fm.fileExists(atPath: fileURL.path) {
            fm.createFile(atPath: fileURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: fileURL) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: line)
    }

    private static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
