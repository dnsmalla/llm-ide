import Foundation
import os

/// Recursively watches a repository directory and fires a debounced callback
/// when source files change — so the code graph + Graphify memory regenerate a
/// couple of seconds after an edit instead of waiting for `GraphAutoUpdater`'s
/// periodic (15-min) timer.
///
/// Feedback-loop safety: the regen itself WRITES to `system/` (graph + memory)
/// and `.code-notes/` (the scan cache). Events whose paths are *all* under a
/// generated-output / VCS / build directory are ignored, so a regenerated graph
/// or memory file can never retrigger the watcher. `graphify-out/` stays on the
/// list even though we no longer write there: it is the `/graphify` skill's
/// output tree, and its rebuilds shouldn't drive ours either. The debounce then
/// coalesces a burst of saves into one regen, and the regen is content-hash
/// incremental, so extra ticks are cheap.
///
/// Thread-safety: FSEvents delivers on `queue`; all mutable state is touched
/// only on `queue` (callback) or via `queue.sync` (stop), so the
/// `@unchecked Sendable` promise holds.
final class RepoFileWatcher: @unchecked Sendable {
    private var stream: FSEventStreamRef?
    private var pending: DispatchWorkItem?
    private let queue = DispatchQueue(label: "com.llmide.repo-watcher", qos: .utility)
    private let debounce: TimeInterval
    private let maxWait: TimeInterval?
    private let ignoredFragments: [String]
    private let onChange: @Sendable () -> Void

    /// When the current burst of events began. Touched only on `queue`.
    private var burstStart: DispatchTime?

    nonisolated private static let log = Logger(subsystem: "com.llmide.macapp", category: "RepoFileWatcher")

    // Path fragments that are regen outputs / VCS / build noise. An event batch
    // whose every path contains one of these is ignored.
    private static let ignored: [String] = [
        "/system/", "/graphify-out/", "/.code-notes/", "/.understand-anything/",
        "/.git/", "/.build/", "/node_modules/", "/.swiftpm/",
    ]

    /// Returns nil if the FSEvents stream cannot be created or started.
    ///
    /// - Parameters:
    ///   - debounce: trailing-edge quiet period before `onChange` fires.
    ///   - maxWait: cap on how long a SUSTAINED burst can keep postponing the
    ///     callback. The debounce is trailing-edge, so without this a process
    ///     writing continuously (a build) restarts the timer on every batch and
    ///     `onChange` never fires for the whole build. `nil` keeps the original
    ///     uncapped behaviour.
    ///   - additionalIgnoredDirectories: directory NAMES to treat as noise on
    ///     top of `ignored`, each matched as a `/name/` path fragment. Pass the
    ///     caller's own relevance filter (e.g. `IgnoreList.directories`) so
    ///     churn in a directory the caller does not even display cannot hold
    ///     the debounce open.
    init?(repoRoot: URL,
          debounce: TimeInterval = 2.0,
          maxWait: TimeInterval? = nil,
          additionalIgnoredDirectories: Set<String> = [],
          onChange: @escaping @Sendable () -> Void) {
        self.debounce = debounce
        self.maxWait = maxWait
        self.ignoredFragments = Self.ignored
            + additionalIgnoredDirectories.map { "/\($0)/" }
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
            !ignoredFragments.contains { path.contains($0) }
        }
        guard hasRelevant else { return }

        let now = DispatchTime.now()
        let start = burstStart ?? now
        burstStart = start

        pending?.cancel()
        var deadline = now + debounce
        // A sustained burst would otherwise postpone the callback forever;
        // fire no later than `maxWait` after the burst began.
        if let maxWait {
            let cap = start + maxWait
            if cap < deadline { deadline = cap }
        }
        let item = DispatchWorkItem { [weak self, onChange] in
            self?.burstStart = nil          // on `queue`
            onChange()
        }
        pending = item
        queue.asyncAfter(deadline: deadline, execute: item)
    }

    func stop() {
        queue.sync {
            pending?.cancel()
            pending = nil
            burstStart = nil
            guard let stream else { return }
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            self.stream = nil
        }
    }

    deinit { stop() }
}
