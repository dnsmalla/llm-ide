import Foundation
import os

/// Recursively watches a repository directory and fires a debounced callback
/// when source files change — so the code graph + Graphify memory regenerate a
/// couple of seconds after an edit instead of waiting for `GraphAutoUpdater`'s
/// periodic (15-min) timer.
///
/// Feedback-loop safety: the regen itself WRITES to `system/`, `graphify-out/`,
/// and `.code-notes/`. Events whose paths are *all* under a regen-output / VCS /
/// build directory are ignored, so a regenerated graph or memory file can never
/// retrigger the watcher. The debounce then coalesces a burst of saves into one
/// regen, and the regen is content-hash incremental, so extra ticks are cheap.
///
/// Thread-safety: FSEvents delivers on `queue`; all mutable state is touched
/// only on `queue` (callback) or via `queue.sync` (stop), so the
/// `@unchecked Sendable` promise holds.
final class RepoFileWatcher: @unchecked Sendable {
    private var stream: FSEventStreamRef?
    private var pending: DispatchWorkItem?
    private let queue = DispatchQueue(label: "com.llmide.repo-watcher", qos: .utility)
    private let debounce: TimeInterval
    private let onChange: @Sendable () -> Void

    nonisolated private static let log = Logger(subsystem: "com.llmide.macapp", category: "RepoFileWatcher")

    // Path fragments that are regen outputs / VCS / build noise. An event batch
    // whose every path contains one of these is ignored.
    private static let ignored: [String] = [
        "/system/", "/graphify-out/", "/.code-notes/", "/.understand-anything/",
        "/.git/", "/.build/", "/node_modules/", "/.swiftpm/",
    ]

    /// Returns nil if the FSEvents stream cannot be created or started.
    init?(repoRoot: URL, debounce: TimeInterval = 2.0, onChange: @escaping @Sendable () -> Void) {
        self.debounce = debounce
        self.onChange = onChange

        let root = repoRoot.standardizedFileURL.path
        var context = FSEventStreamContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil)
        context.info = Unmanaged.passUnretained(self).toOpaque()

        // UseCFTypes is REQUIRED: without it FSEvents delivers `eventPaths` as a
        // C `char **`, but the callback bridges it as a CFArray/NSArray of String
        // (line below). With this flag `eventPaths` is a real CFArray<CFString>,
        // so the `unsafeBitCast(... to: NSArray.self) as? [String]` bridge is
        // valid; without it the cast reinterprets a `char**` as an object pointer
        // and crashes (EXC_BAD_ACCESS) the moment any path is delivered.
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagFileEvents
            | kFSEventStreamCreateFlagNoDefer
            | kFSEventStreamCreateFlagUseCFTypes
        )
        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            { _, info, _, eventPaths, _, _ in
                guard let info else { return }
                let watcher = Unmanaged<RepoFileWatcher>.fromOpaque(info).takeUnretainedValue()
                let paths = unsafeBitCast(eventPaths, to: NSArray.self) as? [String] ?? []
                watcher.handle(paths: paths)
            },
            &context,
            [root] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.5,                      // server coalescing latency (seconds)
            flags
        ) else {
            Self.log.warning("FSEventStreamCreate failed for \(root, privacy: .public)")
            return nil
        }

        self.stream = stream
        FSEventStreamSetDispatchQueue(stream, queue)
        guard FSEventStreamStart(stream) else {
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            self.stream = nil
            Self.log.warning("FSEventStreamStart failed for \(root, privacy: .public)")
            return nil
        }
    }

    // Runs on `queue`.
    private func handle(paths: [String]) {
        let hasRelevant = paths.contains { path in
            !Self.ignored.contains { path.contains($0) }
        }
        guard hasRelevant else { return }
        pending?.cancel()
        let item = DispatchWorkItem { [onChange] in onChange() }
        pending = item
        queue.asyncAfter(deadline: .now() + debounce, execute: item)
    }

    func stop() {
        queue.sync {
            pending?.cancel()
            pending = nil
            guard let stream else { return }
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            self.stream = nil
        }
    }

    deinit { stop() }
}
