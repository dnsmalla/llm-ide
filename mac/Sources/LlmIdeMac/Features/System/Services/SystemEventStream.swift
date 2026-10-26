import Foundation

/// One change event from `GET /kb/os/stream`. Only the type and the time are
/// kept: the page re-fetches on any change and never reads a payload.
struct SystemFeedEvent: Equatable {
    let type: String
    let at: String?
}

/// Parses Server-Sent Events from raw bytes. Input may be split anywhere (even
/// inside a multi-byte character or a CRLF). Comment lines (`:heartbeat`) and
/// fields other than `data` are ignored. A blank line dispatches the event, and
/// only when it carries data. A data payload must be a JSON object with a
/// string `type`; anything else is dropped.
struct SystemSSEParser {
    private var pending: [UInt8] = []
    private var dataLines: [String] = []
    private var hasData = false

    /// Feeds bytes and returns the events they complete, in order.
    mutating func feed(bytes: some Sequence<UInt8>) -> [SystemFeedEvent] {
        pending.append(contentsOf: bytes)
        var events: [SystemFeedEvent] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            var line = pending[..<newline]
            if line.last == 0x0D { line = line.dropLast() }
            let text = String(decoding: line, as: UTF8.self)
            pending.removeSubrange(...newline)
            if let event = consume(line: text) { events.append(event) }
        }
        return events
    }

    /// Feeds one line that has no terminator. Returns an event when a blank line completes one.
    mutating func consume(line: String) -> SystemFeedEvent? {
        if line.isEmpty {
            defer {
                dataLines = []
                hasData = false
            }
            guard hasData else { return nil }
            return Self.event(fromData: dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.first == " " { value = value.dropFirst() }
        } else {
            field = line[...]
            value = ""
        }
        if field == "data" {
            dataLines.append(String(value))
            hasData = true
        }
        return nil
    }

    /// The event a data payload carries, or nil when it is not `{"type": "..."}`.
    static func event(fromData data: String) -> SystemFeedEvent? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any],
              let type = object["type"] as? String, !type.isEmpty else { return nil }
        return SystemFeedEvent(type: type, at: object["at"] as? String)
    }
}

/// Reconnect delay for the feed, in seconds. Ordinary drops back off 1 s -> 30 s.
/// A 429 (too many open views) backs off much longer: 60 s, doubling, capped at 5 min.
enum SystemStreamBackoff {
    static func seconds(attempt: Int, rateLimited: Bool) -> Int {
        let step = max(0, attempt)
        if rateLimited {
            return min(60 << min(step, 3), 300)
        }
        return min(1 << min(step, 5), 30)
    }
}

/// Holds the change feed for the System view: one stream per view, opened with
/// the session's token by `LlmIdeAPIClient` (which refreshes on 401), parsed by
/// `SystemSSEParser`, and reconnected with `SystemStreamBackoff`. Runs on the main
/// actor; only the byte reads suspend. Callers stop it on unsubscribe, when the
/// view goes away, and when the project or the session changes.
@MainActor
final class SystemEventStream {
    static let path = "/kb/os/stream"

    private let client: LlmIdeAPIClient
    private let onStatus: @MainActor (_ status: String, _ detail: String?) -> Void
    private let onEvent: @MainActor (SystemFeedEvent) -> Void
    private var task: Task<Void, Never>?

    init(client: LlmIdeAPIClient,
         onStatus: @escaping @MainActor (_ status: String, _ detail: String?) -> Void,
         onEvent: @escaping @MainActor (SystemFeedEvent) -> Void) {
        self.client = client
        self.onStatus = onStatus
        self.onEvent = onEvent
    }

    var isRunning: Bool { task != nil }

    /// Starts the feed. A second call while running is a no-op (one stream per view).
    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            await self?.run()
        }
    }

    /// Cancels the feed and any pending reconnect.
    func stop() {
        task?.cancel()
        task = nil
    }

    /// Stops and starts again, so the next connect uses the current session.
    func restart() {
        stop()
        start()
    }

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            var rateLimited = false
            onStatus(attempt == 0 ? "connecting" : "reconnecting", nil)
            do {
                let (status, bytes) = try await client.openStream(path: Self.path)
                if Task.isCancelled { return }
                if status == 401 {
                    // The session is gone even after a refresh: stop, do not retry.
                    onStatus("stopped", "Sign in to LLM-IDE again")
                    task = nil
                    return
                }
                if status == 429 {
                    rateLimited = true
                } else if (200..<300).contains(status) {
                    attempt = 0
                    onStatus("live", nil)
                    var parser = SystemSSEParser()
                    for try await byte in bytes {
                        if Task.isCancelled { return }
                        for event in parser.feed(bytes: [byte]) { onEvent(event) }
                    }
                }
            } catch APIError.noSession {
                onStatus("stopped", "Sign in to LLM-IDE again")
                task = nil
                return
            } catch {
                if Task.isCancelled { return }
            }
            if Task.isCancelled { return }
            let seconds = SystemStreamBackoff.seconds(attempt: attempt, rateLimited: rateLimited)
            attempt += 1
            onStatus("reconnecting", rateLimited ? "Too many System views are open; retrying later" : nil)
            try? await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
        }
    }
}
