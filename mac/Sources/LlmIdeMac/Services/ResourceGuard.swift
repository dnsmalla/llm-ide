import Foundation
import os

/// Stops long-running local work when the MACHINE is genuinely in danger, which
/// is now the only condition that stops it at all.
///
/// Why this exists: every wall-clock deadline that used to bound AI work and
/// spawned processes has been removed (see `BashService`, `CodeWorkflowService`,
/// `AutoCodeUpdateService+CLI`, and the server's `loop.mjs`). Those clocks were
/// killing legitimate work — a real multi-step turn or a real `swift build`
/// outruns any number you can pick, and the user lost the result and had to
/// start over. But "no limits at all" is not the goal either: the actual failure
/// people care about is the machine becoming unusable, and elapsed time was
/// never a proxy for that.
///
/// So the rule is resource-based, and deliberately narrow:
///
///   * **Memory pressure, sustained.** macOS itself publishes the signal via
///     `DispatchSource.makeMemoryPressureSource`; `.critical` means the kernel is
///     already compressing and swapping hard, i.e. the point where the UI starts
///     beachballing. We require it to persist (default 30 s) so a brief spike
///     during a link step doesn't kill a build that was about to finish.
///
///   * **CPU is NOT a trigger, on purpose.** A healthy `swift build` or
///     `npm test` pegs every core at 100% — that is what a build looks like, not
///     a fault. Killing on CPU would kill exactly the work this app exists to
///     run. High CPU alone never stops anything here.
///
/// Registered work is asked to stop, newest first: the most recently started job
/// is the one most likely to be responsible for the spike, and stopping one may
/// be enough to recover, so we re-check between stops rather than killing
/// everything at once.
final class ResourceGuardService: @unchecked Sendable {

    static let shared = ResourceGuardService()

    /// How long pressure must stay at/above the abort level before we act.
    static let defaultSustainedSeconds: TimeInterval = 30

    /// Called when the guard decides this job must stop. Receives a
    /// user-presentable reason. Invoked on an internal queue, never the main
    /// actor, and at most once per registration.
    typealias StopHandler = @Sendable (String) -> Void

    /// Handle returned by `register`. Work MUST hold it for its lifetime and let
    /// it deinit (or call `cancel()`) when it finishes — otherwise the guard
    /// keeps a stale handler and may try to stop a job that is already gone.
    final class Registration: @unchecked Sendable {
        private let id: UInt64
        private weak var guardService: ResourceGuardService?
        init(id: UInt64, guardService: ResourceGuardService) {
            self.id = id
            self.guardService = guardService
        }
        func cancel() { guardService?.deregister(id) }
        deinit { guardService?.deregister(id) }
    }

    private struct Job {
        let id: UInt64
        let label: String
        let startedAt: Date
        let stop: StopHandler
    }

    private let lock = NSLock()
    private var jobs: [Job] = []
    private var nextId: UInt64 = 1
    private var tracker: MemoryPressureTracker
    /// The window this instance was configured with. Kept alongside the tracker
    /// so the user-facing reason states the REAL threshold — reading the static
    /// default here reported 30 s for an instance configured with anything else.
    private let sustainedSeconds: TimeInterval
    private var source: DispatchSourceMemoryPressure?
    private var pollTimer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "com.llmide.resourceguard")
    private let log = Logger(subsystem: "com.llmide.macapp", category: "ResourceGuard")

    /// Latest observed pressure. Guarded by `lock` — the poll timer reads it from
    /// its own queue while the dispatch source's handler writes it from another.
    private var lastLevel: MemoryPressure = .normal

    /// Latest observed pressure, for the UI to show why work stopped.
    var currentLevel: MemoryPressure {
        lock.lock(); defer { lock.unlock() }
        return lastLevel
    }

    init(sustainedSeconds: TimeInterval = ResourceGuardService.defaultSustainedSeconds) {
        self.sustainedSeconds = sustainedSeconds
        self.tracker = MemoryPressureTracker(abortAt: .critical, sustainedFor: sustainedSeconds)
    }

    // MARK: - Registration

    /// Register a cancellable unit of work. Monitoring starts with the first
    /// registration and stops when the last one goes away, so an idle app pays
    /// nothing.
    func register(label: String, onStop: @escaping StopHandler) -> Registration {
        // Everything — mutating `jobs` AND deciding whether monitoring should be
        // running — happens under one lock hold. Deciding outside it allowed a
        // concurrent finish-then-start interleaving where the source was
        // cancelled after a new job had already registered, leaving that job
        // unmonitored for its entire life: the guard looked armed and would never
        // fire. Start/stop are cheap (activate/cancel two dispatch sources), and
        // their handlers run on `queue`, so holding the lock across them cannot
        // deadlock.
        lock.lock(); defer { lock.unlock() }
        let id = nextId
        nextId += 1
        jobs.append(Job(id: id, label: label, startedAt: Date(), stop: onStop))
        startMonitoringLocked()
        return Registration(id: id, guardService: self)
    }

    private func deregister(_ id: UInt64) {
        lock.lock(); defer { lock.unlock() }
        jobs.removeAll { $0.id == id }
        if jobs.isEmpty { stopMonitoringLocked() }
    }

    // MARK: - Monitoring

    /// Caller MUST hold `lock`.
    private func startMonitoringLocked() {
        guard source == nil else { return }
        let src = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical],
                                                          queue: queue)
        src.setEventHandler { [weak self] in
            guard let self else { return }
            self.observe(Self.level(from: src.data))
        }
        src.activate()
        source = src

        // The dispatch source only fires on TRANSITIONS. Sustained pressure that
        // never changes level would therefore never re-notify, and the
        // "held for 30 s" rule would never come due. A slow tick re-feeds the
        // current level so elapsed time is actually evaluated.
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            // Re-feed whatever level is current, read under the lock inside
            // observe() rather than here — the source's handler writes it from a
            // different thread.
            self.observeCurrent()
        }
        timer.activate()
        pollTimer = timer
    }

    /// Caller MUST hold `lock`.
    private func stopMonitoringLocked() {
        source?.cancel()
        source = nil
        pollTimer?.cancel()
        pollTimer = nil
        tracker.reset()
        lastLevel = .normal
    }

    /// Translate a dispatch source's raw event mask into our level.
    static func level(from data: UInt) -> MemoryPressure {
        let flags = DispatchSource.MemoryPressureEvent(rawValue: data)
        if flags.contains(.critical) { return .critical }
        if flags.contains(.warning) { return .warning }
        return .normal
    }

    /// Re-evaluate the last known level (the poll tick). The dispatch source only
    /// fires on TRANSITIONS, so pressure that stays critical would never
    /// re-notify and the "held for N seconds" rule would never come due.
    private func observeCurrent() {
        lock.lock()
        let level = lastLevel
        lock.unlock()
        observe(level)
    }

    private func observe(_ level: MemoryPressure) {
        lock.lock()
        lastLevel = level
        let shouldAbort = tracker.observe(level, at: Date())
        let victim = shouldAbort ? jobs.last : nil        // newest first
        if let victim { jobs.removeAll { $0.id == victim.id } }
        let remaining = jobs.count
        if shouldAbort { tracker.reset() }                // re-arm; re-check before the next kill
        lock.unlock()

        guard let victim else { return }
        let held = Int(Date().timeIntervalSince(victim.startedAt))
        log.warning("""
            stopping \(victim.label, privacy: .public) after \(held, privacy: .public)s — \
            system memory pressure critical (\(remaining, privacy: .public) job(s) still registered)
            """)
        // Wording matters here: this text reaches the chat and the run log, and
        // the whole point of removing the deadlines is that work is never
        // punished for its duration. So the reason names the machine's state and
        // says explicitly that no time limit was involved.
        victim.stop("stopped to protect the system — macOS reported critical memory pressure "
                    + "continuously for \(Int(sustainedSeconds))s or more. This was not a time limit; "
                    + "the run is safe to start again once memory frees up.")
    }

    // MARK: - Test seam

    /// Feed a level directly, bypassing the dispatch source. Tests only.
    func _observeForTesting(_ level: MemoryPressure) { observe(level) }

    /// Number of currently registered jobs. Tests only.
    var _registeredCountForTesting: Int {
        lock.lock(); defer { lock.unlock() }
        return jobs.count
    }
}

/// System memory-pressure level, ordered so `>=` comparisons read naturally.
enum MemoryPressure: Int, Sendable, Comparable, CustomStringConvertible {
    case normal = 0
    case warning = 1
    case critical = 2

    static func < (lhs: MemoryPressure, rhs: MemoryPressure) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    var description: String {
        switch self {
        case .normal: return "normal"
        case .warning: return "warning"
        case .critical: return "critical"
        }
    }
}

/// The decision logic, with no timers, no dispatch sources, and no system calls —
/// feed it levels and timestamps and it says whether to stop work. Pure so the
/// "must be sustained" rule is actually testable; getting that rule wrong in
/// either direction is expensive (kill a good build, or let the machine die).
struct MemoryPressureTracker: Sendable {
    let abortAt: MemoryPressure
    let sustainedFor: TimeInterval
    /// When pressure first reached `abortAt` in the current episode.
    private var episodeStart: Date?

    init(abortAt: MemoryPressure = .critical, sustainedFor: TimeInterval = 30) {
        self.abortAt = abortAt
        self.sustainedFor = sustainedFor
    }

    /// Returns true when `level` has been at/above `abortAt` continuously for
    /// `sustainedFor`. Dropping below the threshold at any point clears the
    /// episode, so pressure that comes and goes never accumulates toward a kill.
    mutating func observe(_ level: MemoryPressure, at now: Date) -> Bool {
        guard level >= abortAt else {
            episodeStart = nil
            return false
        }
        guard let start = episodeStart else {
            episodeStart = now
            return false                     // first sighting is never enough
        }
        return now.timeIntervalSince(start) >= sustainedFor
    }

    mutating func reset() { episodeStart = nil }

    /// Whether an episode is currently building, for diagnostics.
    var isUnderPressure: Bool { episodeStart != nil }
}
