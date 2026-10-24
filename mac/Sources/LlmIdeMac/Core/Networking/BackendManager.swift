import AppKit
import Foundation
import Network
import Observation

/// One log line printed by the backend process.
struct BackendLogLine: Identifiable, Hashable {
    let id = UUID()
    let timestamp: Date
    let text: String
    let stream: Stream
    enum Stream: String { case stdout, stderr, info }
}

/// Reassembles lines from a pipe's arbitrary byte chunks.
///
/// A pipe read ends wherever the kernel buffer did, not at a line or even a
/// character boundary. Decoding each chunk on its own dropped any chunk that
/// split a multi-byte UTF-8 character (`String(data:encoding:)` returns nil),
/// and a line split across two reads became two log lines — feeding broken
/// fragments to `ServerStderrIncidentParser`. Splitting on the `\n` byte is
/// safe: 0x0A never occurs inside a multi-byte UTF-8 sequence.
struct PipeLineAccumulator: Sendable {
    /// A line longer than this with no newline is emitted as-is, so a
    /// runaway writer cannot grow the buffer without bound.
    static let maxPendingBytes = 256 * 1_024

    private var pending: [UInt8] = []

    /// Appends `chunk` and returns every line it completed (without the
    /// trailing `\n` / `\r\n`). Empty lines are returned too.
    mutating func feed(_ chunk: Data) -> [String] {
        pending.append(contentsOf: chunk)
        var lines: [String] = []
        var start = 0
        while let newline = pending[start...].firstIndex(of: 0x0A) {
            lines.append(Self.decode(pending[start..<newline]))
            start = newline + 1
        }
        pending.removeFirst(start)
        if pending.count > Self.maxPendingBytes {
            lines.append(Self.decode(pending[...]))
            pending.removeAll(keepingCapacity: true)
        }
        return lines
    }

    /// Returns the unterminated remainder (if any) and clears it — call at EOF.
    mutating func finish() -> [String] {
        guard !pending.isEmpty else { return [] }
        defer { pending.removeAll() }
        return [Self.decode(pending[...])]
    }

    /// Lossy decode: an invalid sequence becomes U+FFFD instead of
    /// discarding the whole line.
    private static func decode(_ bytes: ArraySlice<UInt8>) -> String {
        var line = bytes
        if line.last == 0x0D { line = line.dropLast() }
        return String(decoding: line, as: UTF8.self)
    }
}

/// Lock-guarded `PipeLineAccumulator` shared between a pipe's
/// `readabilityHandler` (background queue) and the termination handler's
/// final flush (main actor).
final class PipeLineBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var accumulator = PipeLineAccumulator()

    func feed(_ chunk: Data) -> [String] {
        lock.lock(); defer { lock.unlock() }
        return accumulator.feed(chunk)
    }

    func finish() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return accumulator.finish()
    }
}

/// Supervises the local Node `server.mjs` process and exposes its
/// stdout/stderr as a capped, scrollable log buffer that the Settings
/// UI can render directly.
@MainActor
@Observable
final class BackendManager {
    /// The loopback port the Node backend listens on. Single source of truth.
    nonisolated static let defaultBackendPort = 3456

    /// The environment variable the Node server reads to decide which
    /// feature route groups to load (comma-separated `AppFeature` raw values;
    /// unset/empty → all, the same semantics as `mac/Package.swift`).
    nonisolated static let featuresEnvKey = "LLMIDE_FEATURES"

    /// Returns the ENABLED feature keys to hand the spawned server, or nil to
    /// leave `LLMIDE_FEATURES` unset (the server then loads every group).
    /// Never return `[]` to mean "none": an empty value also reads as "all".
    ///
    /// A seam rather than a direct `FeatureRegistry` read because Core is a
    /// leaf and may not name Shell types; Shell installs the real provider in
    /// `LlmIdeMacApp.init`, before any `start`. The default (nil) is what a
    /// run without Shell's boot — tests, labs — should get: a full server.
    ///
    /// Read on every spawn (start, restart, auto-restart), so a feature-set
    /// change made in Settings takes effect at the NEXT backend start. The app
    /// never restarts the backend just because the set changed: that would
    /// kill in-flight Loop / agent work for a cosmetic reconfiguration. An
    /// ADOPTED external server is not affected at all — it keeps whatever
    /// environment it was launched with.
    static var featureKeysProvider: @MainActor () -> [String]? = { nil }

    enum Status: Equatable {
        case stopped
        case starting
        case running
        case crashed(exitCode: Int32)
    }

    private(set) var status: Status = .stopped
    private(set) var pid: Int32?
    private(set) var log: [BackendLogLine] = []
    var lastError: String?
    /// `apiVersion` reported by the live server's `/health`, once probed.
    private(set) var serverApiVersion: Int?
    /// Set when the reachable server is OLDER than this client can talk to.
    ///
    /// This is the case the app used to be blind to: `probeHealthDetail`
    /// computed `versionTooOld` and NOTHING read it — `probeHealth()` threw
    /// everything but `.ok` away — so a stale `node server.mjs` left running
    /// from an earlier checkout was adopted as perfectly healthy. Every
    /// endpoint added since that process started then 404'd with no
    /// explanation anywhere in the UI (observed: repeated 404s on
    /// `POST /kb/ingest-code-graph`, i.e. the Mac code graph silently never
    /// reaching the server).
    private(set) var serverVersionTooOld = false

    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private let maxLogLines = 5_000

    // Auto-restart bookkeeping. When the spawned node exits non-zero
    // we retry up to MAX_RESTARTS with exponential backoff. If the
    // user explicitly stop()'d, we DO NOT auto-restart — the
    // `userInitiatedStop` flag short-circuits the loop. Retry count
    // resets after 60 seconds of stable up-time.
    private static let maxRestarts = 3
    private static let restartBackoffsSec: [TimeInterval] = [1, 5, 30]
    private var restartCount = 0
    private var lastSuccessfulStartAt: Date?
    private var userInitiatedStop = false
    private var pendingRestartTask: Task<Void, Never>?
    private var lastStartArgs: (nodePath: String, workingDirectory: String)?
    /// Set by `restart(...)`: start again once the spawned child has exited.
    private var startAfterExit: (nodePath: String, workingDirectory: String)?
    /// PID of a child we terminated because it never answered `/health`.
    /// Its exit (SIGTERM, 15) is otherwise indistinguishable from a crash:
    /// the exit handler overwrote the timeout message with the last stderr
    /// line and auto-restarted a server that will most likely hang again —
    /// three more 20 s waits before the user saw anything actionable.
    private var startTimedOutPID: Int32?
    /// One retry after a start timeout: a cold start on a busy (swapping)
    /// machine or a slow migration can exceed the 20 s /health window and
    /// usually succeeds warm. Reset once a start reaches /health.
    private var startTimeoutRetryUsed = false

    init() {
        // Best-effort cleanup so a spawned node child doesn't outlive
        // the app on force-quit / cmd-Q / logout. We deliberately only
        // signal — no async wait — because willTerminate runs on the
        // main thread with a tight budget before the OS reaps us.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // We're already on the main thread (queue: .main), and the
            // class is @MainActor; assumeIsolated lets us call the
            // synchronous terminate helper without hopping to a Task.
            MainActor.assumeIsolated {
                self?.terminateSpawnedBackend()
            }
        }
    }

    /// How long quit waits for the spawned server to exit on SIGTERM before
    /// SIGKILL. See `terminateSpawnedBackend()`.
    nonisolated static let quitGraceSeconds: TimeInterval = 5.0

    /// Synchronously SIGTERM (then SIGKILL after up to `quitGraceSeconds`) the node child we
    /// spawned. Adopted external backends are left alone — they have
    /// their own lifecycle and `stop()` is the path that touches them.
    func terminateSpawnedBackend() {
        guard let p = process, p.isRunning else { return }
        let childPID = p.processIdentifier
        kill(childPID, SIGTERM)
        // Wait for it to go, then SIGKILL a straggler — here, synchronously. The
        // escalation used to be scheduled with `asyncAfter` on a global queue, but
        // this runs from `willTerminate`: the process exits right after, so that
        // block never fired and a node that ignored SIGTERM was orphaned (and then
        // adopted, stale, by the next launch). `kill(pid, 0)` probes existence
        // without signalling; a zombie reads as alive and the SIGKILL is harmless.
        // The grace is 5 s, not 1 s: server.mjs's SIGTERM handler drains
        // in-flight requests, then saves rate-limit buckets and closes SQLite
        // (WAL checkpoint) — SIGKILLing it after 1 s routinely skipped both.
        // The loop returns as soon as the child exits, so a healthy shutdown
        // still quits in well under a second; only a stuck one costs the full
        // grace, and the server's own 10 s hard timeout is longer than we wait.
        let deadline = Date().addingTimeInterval(Self.quitGraceSeconds)
        while Date() < deadline, kill(childPID, 0) == 0 {
            usleep(50_000)
        }
        if kill(childPID, 0) == 0 {
            kill(childPID, SIGKILL)
        }
    }

    /// True when `status == .running` was reached by adopting an
    /// already-listening external server (probe found /health alive)
    /// rather than spawning our own child. Used by `stop()` to decide
    /// whether we have any process to terminate.
    private var adoptedExternal: Bool = false

    /// Returns the first node binary found in well-known macOS locations.
    /// Does NOT shell out — we don't want to launch a login shell from
    /// inside the app process. Users with nvm-only installs are expected
    /// to paste the full path manually.
    static func autoDetectNode() -> String? {
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Project-folder guesses for the server's working directory, in
    /// order of likelihood. Single source of truth — app launch and the
    /// login screen both resolve through here.
    ///   - current repo layout (llm-ide), then legacy clones (meet-notes)
    ///   - sibling of the running app bundle: handy when the app is run
    ///     from inside the repo (e.g., via mac/build_app.sh)
    static func defaultProjectFolders() -> [URL] {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        var out: [URL] = [
            home.appendingPathComponent("llm-ide/extension"),
            home.appendingPathComponent("Developer/llm-ide/extension"),
            home.appendingPathComponent("Desktop/llm-ide/extension"),
            home.appendingPathComponent("Desktop/meet-notes/extension"),
            home.appendingPathComponent("Developer/meet-notes/extension"),
            home.appendingPathComponent("Developer/llm-ide/notes-extension/extension"),
        ]
        let bundleParent = Bundle.main.bundleURL.deletingLastPathComponent()
        out.append(bundleParent.deletingLastPathComponent().appendingPathComponent("extension"))
        return out
    }

    /// Validate-and-repair the configured backend paths in place.
    ///
    /// A stored `backendWorkingDir` that no longer contains `server.mjs`
    /// (the repo moved or was renamed — e.g. the meet-notes → llm-ide
    /// rename) previously broke auto-start forever: the launch path only
    /// filled paths when EMPTY, so a stale value was never re-detected
    /// and every start attempt failed at the "server.mjs not found"
    /// guard. Same idea for a node binary that is no longer executable.
    @MainActor
    static func resolveLaunchPaths(config: AppConfig) {
        let fm = FileManager.default
        if config.backendNodePath.isEmpty || !fm.isExecutableFile(atPath: config.backendNodePath) {
            if let detected = autoDetectNode() {
                config.backendNodePath = detected
            }
        }
        let hasServer = { (dir: String) -> Bool in
            !dir.isEmpty && fm.fileExists(
                atPath: URL(fileURLWithPath: dir).appendingPathComponent("server.mjs").path)
        }
        if !hasServer(config.backendWorkingDir) {
            // Same layout check as the Desktop/Developer scan: the found dir
            // is persisted and then EXECUTED, and `defaultProjectFolders()`
            // includes `<app>/../../extension`, which for an app copied
            // anywhere can be any folder that happens to hold a server.mjs.
            if let found = defaultProjectFolders().first(where: {
                hasServer($0.path) && LaunchPathResolver.looksLikeLlmIdeServer($0)
            }) {
                config.backendWorkingDir = found.path
            } else if let found = LaunchPathResolver.findServerDirectory() {
                config.backendWorkingDir = found
            }
        }
    }

    func start(nodePath: String, workingDirectory: String) {
        if case .running = status { return }
        if case .starting = status { return }

        let trimmedNode = nodePath.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedDir = workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedNode.isEmpty else {
            fail("Node path is empty. Pick the node binary in Settings.")
            return
        }
        guard !trimmedDir.isEmpty else {
            fail("Working directory is empty. Pick the folder containing server.mjs.")
            return
        }
        let workURL = URL(fileURLWithPath: trimmedDir)
        let scriptURL = workURL.appendingPathComponent("server.mjs")
        guard FileManager.default.fileExists(atPath: scriptURL.path) else {
            fail("server.mjs not found in \(workURL.path)")
            return
        }
        guard FileManager.default.isExecutableFile(atPath: trimmedNode) else {
            fail("Node binary missing or not executable: \(trimmedNode)")
            return
        }

        // Adopt-don't-spawn: if a backend is already listening on the
        // configured port AND answers /health within 2s, adopt it.
        // Otherwise (no listener OR listener is hung) kill whatever is
        // squatting on the port and spawn a fresh child. Previously we
        // adopted *any* listener — a hung node would hold the port and
        // every request would block for the full URLSession timeout,
        // surfacing as a 4-minute login spinner after relaunch.
        // Claim `.starting` synchronously NOW — before the Task's first
        // `await` — so a second concurrent caller (e.g. app-launch
        // autoStartBackend racing the LoginView Start button) trips the
        // `.starting` guard above instead of both passing it, both probing the
        // not-yet-bound port, and both spawning a node child. start() is
        // @MainActor, so this set completes before control returns to any
        // other main-actor caller.
        status = .starting

        // BackendManager is singleton-lifetime (held by @State in the app),
        // so a strong capture is correct and avoids re-guarding self across
        // each await boundary.
        Task { [self] in
            let portInUse = await Self.isPortInUse(port: Self.defaultBackendPort)
            if !portInUse {
                await MainActor.run { self.spawn(nodePath: trimmedNode, workURL: workURL) }
                return
            }
            // Adoption is THE stale-server path: an already-listening node is
            // whatever code it was started with, which may predate half the
            // endpoints this client calls. Probe for detail, not just
            // reachability, so a version mismatch is recorded and surfaced
            // instead of silently 404ing every newer route.
            let health = await Self.probeHealthDetail()
            if health.ok {
                await MainActor.run {
                    self.append("--- Adopted existing backend on 127.0.0.1:\(Self.defaultBackendPort) ---", stream: .info)
                    self.adoptedExternal = true
                    self.pid = nil
                    self.status = .running
                    self.recordServerVersion(health, adopted: true)
                }
            } else {
                await MainActor.run {
                    self.append("--- Stale backend on :\(Self.defaultBackendPort) did not answer /health in 2s — killing and respawning ---", stream: .info)
                }
                let signalled = Self.killExternalListener(port: Self.defaultBackendPort)
                // killExternalListener refuses any PID whose command line lacks
                // server.mjs (a foreign process). If it signalled nothing and the
                // port is held, refuse at once. If it signalled our own server,
                // poll up to 3 s for it to exit (SQLite/WAL close can be slow).
                // A spawn onto a held port would crash-loop via auto-restart.
                var stillHeld = true
                let attempts = signalled ? 12 : 1
                for _ in 0..<attempts {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    stillHeld = await Self.isPortInUse(port: Self.defaultBackendPort)
                    if !stillHeld { break }
                }
                switch Self.startDecision(healthy: false, stillHeld: stillHeld) {
                case .refuseOccupied:
                    await MainActor.run {
                        self.fail(signalled
                            ? Self.staleServerMessage(port: Self.defaultBackendPort)
                            : Self.portOccupiedMessage(port: Self.defaultBackendPort))
                    }
                default:
                    await MainActor.run { self.spawn(nodePath: trimmedNode, workURL: workURL) }
                }
            }
        }
    }

    /// What `start()` should do once it has probed the port (and, if the
    /// listener was unhealthy, attempted to kill it).
    enum StartDecision: Equatable {
        case adopt            // healthy listener already there
        case spawn            // port free: start our own child
        case refuseOccupied   // unhealthy listener we could not/would not kill
    }

    /// Pure decision: `healthy` = a listener answered /health; `stillHeld` =
    /// the port is still bound after the kill attempt.
    nonisolated static func startDecision(healthy: Bool, stillHeld: Bool) -> StartDecision {
        if healthy { return .adopt }
        return stillHeld ? .refuseOccupied : .spawn
    }

    nonisolated static func portOccupiedMessage(port: Int) -> String {
        "Port \(port) is in use by another process that is not the LLM-IDE server, so the backend was not started. "
            + "Find it with `lsof -ti :\(port)` and stop it (e.g. `kill $(lsof -ti :\(port))`), then click Start."
    }

    nonisolated static func staleServerMessage(port: Int) -> String {
        "The previous LLM-IDE server on port \(port) did not exit within 3 s, so the backend was not started. "
            + "Click Start again, or stop it with `kill $(lsof -ti :\(port))`."
    }

    /// Re-probe `/health` and reconcile a STALE `.running` status. An adopted
    /// external server (or any backend) that dies has no terminationHandler to
    /// flip us out of `.running`, so a live connection failure can contradict
    /// the cached status — which is how the login screen ends up showing
    /// "Could not reach the server" and "Server is running" at the same time.
    /// Callers invoke this when they observe the server as unreachable. Only
    /// downgrades from `.running`; never touches a `.starting`/spawning backend.
    func reconcileHealthAfterFailure() async {
        guard case .running = status else { return }
        // Detail, not just reachability: this probe is also the one chance to
        // notice that the server answering on :3456 is no longer the one whose
        // `apiVersion` we cached (a terminal restart from an older checkout,
        // say). A cached version outliving its server is what lets the `ask`
        // gate stay stale-OPEN — see `refreshServerApiVersion()`.
        let health = await Self.probeHealthDetail()
        if health.ok {
            recordServerVersionIfChanged(health)
            return
        }
        append("--- /health re-probe failed; backend marked stopped (was stale .running) ---", stream: .info)
        adoptedExternal = false
        pid = nil
        status = .stopped
        forgetServerApiVersion()
    }

    /// Build the backend child's environment from `base` (the app's own
    /// environment) and the enabled feature keys. Pure, so it is testable
    /// without spawning node.
    ///
    /// - Postcondition: only allowlisted variables from `base` survive;
    ///   `LLMIDE_FEATURES` is present iff `featureKeys` is non-nil, and then
    ///   holds the keys sorted and comma-joined — never the inherited value.
    nonisolated static func childEnvironment(base: [String: String],
                                             featureKeys: [String]?) -> [String: String] {
        // Build the child environment from an allowlist instead of inheriting
        // the full shell env. Passing the full inherited env would expose
        // unrelated ambient secrets (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, etc.)
        // to the Node server and every subprocess it spawns (claude, git, …).
        // We preserve exactly what the server legitimately needs: standard
        // POSIX vars, locale/XDG, NODE_ENV, and our own config prefixes.
        let exactAllow: Set<String> = [
            "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM",
            "LANG", "LC_ALL", "LC_CTYPE", "NODE_ENV",
            "XDG_CONFIG_HOME", "XDG_DATA_HOME", "APPDATA", "USERPROFILE"
        ]
        let prefixAllow = ["LLMIDE_", "MEETNOTES_", "ANTHROPIC_", "LC_", "XDG_"]
        var env: [String: String] = [:]
        for (k, v) in base where exactAllow.contains(k) || prefixAllow.contains(where: { k.hasPrefix($0) }) {
            env[k] = v
        }
        // The `LLMIDE_` prefix would otherwise pass through whatever feature
        // list the app happened to be launched with (a leftover from a
        // `LLMIDE_FEATURES=… swift build` shell, say). The server's route set
        // must follow the user's ACTIVE toggles, so the inherited value is
        // always dropped and only the app's own state is written back.
        env.removeValue(forKey: featuresEnvKey)
        if let featureKeys {
            env[featuresEnvKey] = featureKeys.sorted().joined(separator: ",")
        }
        env["TERM"] = "dumb"
        env["MEETNOTES_LOG_JSON"] = env["MEETNOTES_LOG_JSON"] ?? "0"
        // macOS GUI apps (launched via Finder/launchd) inherit a minimal PATH
        // (`/usr/bin:/bin:…`) that omits the user CLI dirs the LLM tools install
        // to — `~/.local/bin` (the `claude` CLI), Homebrew, etc. Without this the
        // spawned Node server can't find `claude`/`codex`/`gemini` (or `git`),
        // so every CLI-backed AI call fails with ENOENT and the user sees a
        // generic "assistant unavailable". Prepend the standard CLI locations to
        // whatever PATH we inherited, deduped, so the tools are resolvable.
        let home = base["HOME"] ?? NSHomeDirectory()
        let cliDirs = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin",
                       "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let inherited = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        var seenPath = Set<String>()
        env["PATH"] = (cliDirs + inherited)
            .filter { !$0.isEmpty && seenPath.insert($0).inserted }
            .joined(separator: ":")
        return env
    }

    private func spawn(nodePath: String, workURL: URL) {
        status = .starting
        lastError = nil
        adoptedExternal = false

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = ["server.mjs"]
        proc.currentDirectoryURL = workURL
        proc.environment = Self.childEnvironment(
            base: ProcessInfo.processInfo.environment,
            featureKeys: Self.featureKeysProvider())

        let stdOut = Pipe()
        let stdErr = Pipe()
        proc.standardOutput = stdOut
        proc.standardError = stdErr
        let stdOutLines = attachReader(stdOut.fileHandleForReading, stream: .stdout)
        let stdErrLines = attachReader(stdErr.fileHandleForReading, stream: .stderr)

        proc.terminationHandler = { [weak self] finished in
            let exitCode = finished.terminationStatus
            let exitedPID = finished.processIdentifier
            Task { @MainActor [weak self] in
                guard let self else { return }
                // The readers are cleared below, possibly before they saw
                // EOF: emit any final line that had no trailing newline (a
                // crash message often doesn't). A no-op if EOF already flushed.
                self.appendLines(stdOutLines.finish(), stream: .stdout)
                self.appendLines(stdErrLines.finish(), stream: .stderr)
                self.append("--- Server exited (code \(exitCode)) ---", stream: .info)
                // A superseded child (e.g. the start-timeout victim still
                // draining after the user pressed Start and spawned its
                // successor) must not touch the successor's pid/pipes/status
                // or consume its retry. Its own one-shot timeout flag dies here.
                guard self.process === finished else {
                    if self.startTimedOutPID == exitedPID { self.startTimedOutPID = nil }
                    return
                }
                self.pid = nil
                self.process = nil
                self.stdoutPipe?.fileHandleForReading.readabilityHandler = nil
                self.stderrPipe?.fileHandleForReading.readabilityHandler = nil
                self.stdoutPipe = nil
                self.stderrPipe = nil
                // If node dies on startup (before /health ever answered)
                // surface the tail of its output — a missing dependency,
                // a syntax error, a port clash — so the reason shows on
                // the login screen instead of looking like a silent no-op.
                // A deliberate Stop ends the child with SIGTERM (15): that is a
                // stop, not a crash, and must not show "exited with code 15".
                let stoppedByUser = self.userInitiatedStop && exitCode == Int32(SIGTERM)
                let killedForStartTimeout = self.startTimedOutPID == exitedPID
                if killedForStartTimeout { self.startTimedOutPID = nil }
                // The start-timeout path already wrote the real reason via
                // fail(); the SIGTERM exit it caused must not replace it.
                if exitCode != 0 && !stoppedByUser && !killedForStartTimeout {
                    self.lastError = self.recentErrorSummary()
                        ?? "Server exited with code \(exitCode). See Settings → Backend for the log."
                }
                self.status = (exitCode == 0 || stoppedByUser || killedForStartTimeout)
                    ? .stopped : .crashed(exitCode: exitCode)
                if let next = self.startAfterExit {
                    // An intentional restart, not a crash: no auto-restart,
                    // no budget spent, no lingering "crashed" error.
                    self.startAfterExit = nil
                    self.userInitiatedStop = false
                    self.lastError = nil
                    self.status = .stopped
                    self.start(nodePath: next.nodePath, workingDirectory: next.workingDirectory)
                    return
                }
                if killedForStartTimeout {
                    // Retry once (see `startTimeoutRetryUsed`); a second hang
                    // is not transient, and looping would repeat the 20 s
                    // wait for ever. Then it is left for the user's Start.
                    // Not after a user Stop that landed while the timed-out
                    // server was draining: Stop means stop.
                    if self.userInitiatedStop {
                        self.userInitiatedStop = false
                        return
                    }
                    if !self.startTimeoutRetryUsed, let args = self.lastStartArgs {
                        self.startTimeoutRetryUsed = true
                        self.append("--- Retrying once: a cold start can exceed the /health window ---", stream: .info)
                        self.start(nodePath: args.nodePath, workingDirectory: args.workingDirectory)
                        return
                    }
                    self.append("--- Not auto-restarting: server was stopped for not answering /health ---", stream: .info)
                    return
                }
                self.scheduleAutoRestartIfNeeded(exitCode: exitCode)
            }
        }

        do {
            try proc.run()
            self.process = proc
            self.pid = proc.processIdentifier
            self.stdoutPipe = stdOut
            self.stderrPipe = stdErr
            self.lastStartArgs = (nodePath: nodePath, workingDirectory: workURL.path)
            // Stay .starting — NOT .running. proc.run() only means the OS
            // exec'd node; the HTTP server hasn't loaded its modules, run
            // migrations, or bound the port yet. Declaring .running here
            // races the login screen's auto-retry: it fires on the
            // .running transition, hits a port that isn't listening, fails
            // with connection-refused, and never retries because the
            // status doesn't change again. Instead poll /health and only
            // flip to .running once the server actually answers — same
            // contract the adopt path above already honours.
            append("--- Server launched (pid \(proc.processIdentifier)), waiting for /health… ---", stream: .info)
            waitForReadyThenRun(proc: proc, nodePath: nodePath, workURL: workURL)
        } catch {
            fail("Failed to launch: \(error.localizedDescription)")
        }
    }

    /// After spawning, poll `/health` until the server answers, then flip
    /// to `.running` (which unblocks the login screen's auto-retry). Bails
    /// out if the process dies first — the terminationHandler owns the
    /// `.crashed` transition and error surfacing — or if the server never
    /// becomes ready within the budget.
    private func waitForReadyThenRun(proc: Process, nodePath: String, workURL: URL) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline {
                // Process died during startup — terminationHandler handles
                // the .crashed transition and error. Stop polling.
                if !proc.isRunning { return }
                let health = await Self.probeHealthDetail()
                if health.ok {
                    // Make sure we're still the live process and weren't
                    // stop()'d or replaced while the probe was in flight.
                    guard self.process === proc, proc.isRunning else { return }
                    // A server we spawned ourselves can still be too old — the
                    // configured server.mjs may live in an older checkout.
                    self.recordServerVersion(health, adopted: false)
                    self.startTimeoutRetryUsed = false
                    self.markRunning(nodePath: nodePath, workURL: workURL, proc: proc)
                    return
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            // Timed out. A live-but-unresponsive process is wedged —
            // terminate it and report so the user isn't stuck on a spinner.
            if proc.isRunning, self.process === proc {
                self.startTimedOutPID = proc.processIdentifier
                proc.terminate()
                self.fail("Server started but didn't answer /health within 20s. Check Settings → Backend for the log.")
            }
        }
    }

    /// Promote a freshly-spawned, now-healthy server to `.running` and arm
    /// the stable-uptime restart-budget reset.
    private func markRunning(nodePath: String, workURL: URL, proc: Process) {
        status = .running
        clearLastErrorUnlessVersionTooOld()
        lastSuccessfulStartAt = Date()
        lastStartArgs = (nodePath: nodePath, workingDirectory: workURL.path)
        append("--- Server ready (pid \(proc.processIdentifier)) ---", stream: .info)
        // Stable up-time gate: once we've been healthy for 60s, reset the
        // restart counter so a recoverable hiccup hours into a session
        // still gets its full retry budget.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            guard let self else { return }
            if case .running = self.status,
               let started = self.lastSuccessfulStartAt,
               Date().timeIntervalSince(started) >= 60 {
                self.restartCount = 0
            }
        }
    }

    /// Best-effort: the most useful stderr line the spawned node emitted,
    /// for surfacing a startup-failure reason on the login screen. Prefers
    /// a line containing "Error" (the message line of a Node stack trace)
    /// and falls back to the last stderr line.
    private func recentErrorSummary() -> String? {
        let errs = log.suffix(40).filter { $0.stream == .stderr && !$0.text.hasPrefix("---") }
        if let errLine = errs.last(where: { $0.text.contains("Error") }) {
            return errLine.text.trimmingCharacters(in: .whitespaces)
        }
        return errs.last?.text.trimmingCharacters(in: .whitespaces)
    }

    // Auto-restart with exponential backoff. Skips the loop when the
    // user explicitly stopped or when we've exceeded maxRestarts. Hard
    // failures after the retry budget put the manager in `.crashed`
    // state so Settings → Backend shows the exit code and the user can
    // click Start manually.
    private func scheduleAutoRestartIfNeeded(exitCode: Int32) {
        if userInitiatedStop {
            userInitiatedStop = false
            return
        }
        if exitCode == 0 { return } // clean exit, no restart
        guard let args = lastStartArgs else { return }
        if restartCount >= Self.maxRestarts {
            append("--- Auto-restart budget exhausted (\(Self.maxRestarts) attempts). Click Start in Settings to retry. ---", stream: .info)
            return
        }
        let backoff = Self.restartBackoffsSec[min(restartCount, Self.restartBackoffsSec.count - 1)]
        restartCount += 1
        append("--- Auto-restart \(restartCount)/\(Self.maxRestarts) in \(Int(backoff))s… ---", stream: .info)
        pendingRestartTask?.cancel()
        pendingRestartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            guard let self else { return }
            if Task.isCancelled { return }
            // Only restart if still in a crashed state — if the user
            // already started it manually we don't double-spawn.
            if case .crashed = self.status {
                self.start(nodePath: args.nodePath, workingDirectory: args.workingDirectory)
            }
        }
    }

    /// Settings → Kill & Restart. Previously the button killed the port
    /// listener and called `start` 0.5 s later — which returned early (still
    /// `.running`), so the restart actually happened via the CRASH path: it
    /// spent an auto-restart attempt each time (three clicks exhausted the
    /// budget for the next real crash) and briefly showed "crashed".
    func restart(nodePath: String, workingDirectory: String) {
        restartCount = 0
        if process != nil {
            stop()
            // After stop(), which clears it: the exit handler runs on a later
            // main-actor turn, so this is still in place when it does.
            startAfterExit = (nodePath, workingDirectory)
            return
        }
        // Adopted (or unknown) listener: kill it, wait, then spawn fresh —
        // unless a Stop cleared `startAfterExit` in the meantime.
        stop()
        startAfterExit = (nodePath, workingDirectory)
        Task { @MainActor [weak self] in
            let signalled = await Task.detached { Self.killExternalListener(port: Self.defaultBackendPort) }.value
            if !signalled {
                self?.append("--- listener on port \(Self.defaultBackendPort) is not server.mjs; re-adopting it ---", stream: .info)
            }
            // Wait for the port to actually FREE, not a fixed 500 ms: a node that is
            // still draining keeps answering /health, and `start()` would adopt the
            // dying server as `.running` — then it exits and the status goes stale.
            // Bounded (about 4 s); after that `start()` copes with whatever is there.
            for _ in 0..<20 {
                if !(await Self.isPortInUse(port: Self.defaultBackendPort)) { break }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            guard let self, self.startAfterExit != nil, self.process == nil else { return }
            self.startAfterExit = nil
            self.userInitiatedStop = false
            self.status = .stopped
            self.start(nodePath: nodePath, workingDirectory: workingDirectory)
        }
    }

    func stop() {
        // Signal the terminationHandler to skip auto-restart. Cleared
        // back to false once the next non-clean exit is handled, or
        // immediately when the user starts the backend again.
        // Only a CHILD we spawned has an exit handler to consume this flag. Set
        // for an adopted listener, nothing ever cleared it, so the next real
        // crash of a later-spawned child skipped its first auto-restart.
        userInitiatedStop = process != nil
        // A Stop after Kill & Restart (node slow to exit) wins: the exit
        // must not relaunch against it.
        startAfterExit = nil
        // The server we measured is going away on both paths below, so the
        // cached `apiVersion` stops describing anything. Keeping it is what
        // lets `QuickChatContext.serverSupportsAsk` answer "yes, v47" for a
        // server that has been replaced by an older one — the one place in
        // the quick chat where a stale answer is a safety problem, not a
        // cosmetic one.
        forgetServerApiVersion()
        pendingRestartTask?.cancel()
        pendingRestartTask = nil
        if let p = process {
            append("--- Stopping server ---", stream: .info)
            p.terminate()
            // The terminationHandler will reset status when the process actually exits.
            return
        }
        if adoptedExternal {
            // We adopted a server we didn't spawn (probably started
            // outside the app or in a prior session). Try to find the
            // listener via lsof and SIGTERM it so app-lifetime matches
            // backend-lifetime as the user expects.
            append("--- Stopping adopted backend ---", stream: .info)
            adoptedExternal = false
            status = .stopped
            pid = nil
            Task.detached { Self.killExternalListener(port: Self.defaultBackendPort) }
        }
    }

    /// SIGTERM only the process(es) actually listening on the backend port.
    ///
    /// Previously this used `pkill -f "node.*server.mjs"`, which would kill
    /// ANY node process matching that pattern anywhere on the system —
    /// catastrophic for users running unrelated node servers. We now use
    /// `lsof -ti :<port>` to find the listener PID(s) and kill only those.
    /// Public instance method to kill external listeners on a port (used by UI).
    @discardableResult
    func killExternalListener(port: Int) -> Bool {
        Self.killExternalListener(port: port)
    }

    /// Returns true iff at least one PID was sent SIGTERM (false: no listener,
    /// or every listener was skipped as foreign).
    @discardableResult
    nonisolated static func killExternalListener(port: Int) -> Bool {
        // 1. Find PIDs listening on the port.
        let lsof = Process()
        lsof.launchPath = "/usr/sbin/lsof"
        lsof.arguments = ["-ti", ":\(port)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        lsof.standardOutput = pipe
        lsof.standardError = Pipe() // swallow stderr
        do { try lsof.run() } catch { return false }
        lsof.waitUntilExit()
        guard let data = try? pipe.fileHandleForReading.readToEnd(),
              let raw = String(data: data, encoding: .utf8) else { return false }
        let pids = raw
            .split(whereSeparator: { $0.isNewline })
            .compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
        guard !pids.isEmpty else { return false }

        // 2. For each PID, verify it is our Node/server.mjs process before
        // sending SIGTERM. This prevents friendly-fire on unrelated dev
        // servers that happen to be listening on the same port.
        var signalled = false
        for pid in pids {
            let cmd = Process()
            cmd.launchPath = "/bin/ps"
            cmd.arguments = ["-p", "\(pid)", "-o", "command="]
            let cmdPipe = Pipe()
            cmd.standardOutput = cmdPipe
            cmd.standardError = Pipe()
            guard (try? cmd.run()) != nil else { continue }
            cmd.waitUntilExit()
            let cmdData = (try? cmdPipe.fileHandleForReading.readToEnd()) ?? Data()
            let cmdStr = String(data: cmdData, encoding: .utf8) ?? ""
            // Confirm the process references our Node backend.
            // Match on `server.mjs` only: "node" + "server" also matched any
            // unrelated `node dev-server.js` on the port, which we then killed.
            guard cmdStr.contains("server.mjs") else {
                // Log to stderr — not ideal in a nonisolated static, but avoids
                // pulling in a logger dependency here.
                fputs("[BackendManager] Skipping PID \(pid) on port \(port): '\(cmdStr.trimmingCharacters(in: .whitespacesAndNewlines))' does not look like our server\n", stderr)
                continue
            }
            kill(pid, SIGTERM)
            signalled = true
        }
        return signalled
    }

    /// Minimum server `apiVersion` this client knows how to talk to.
    ///
    /// The old policy ("bump only on a wire-shape BREAK, a 404 on a new
    /// endpoint is tolerated") left this floor at 20 while the server moved
    /// to 42 — making the guard inert for the failure it exists to catch:
    /// an ORPHANED old `node server.mjs` still on :3456 that a freshly
    /// pulled app silently adopts, then fails confusingly (v2 chat 404s
    /// mid-feature instead of a clear banner). The app and server ship from
    /// the same checkout, so the honest floor is the version whose chat
    /// wire this app was actually built against.
    ///
    /// Keep in LOCKSTEP: when `SERVER_API_VERSION` (extension/server.mjs)
    /// bumps for anything the chat path consumes, raise this too.
    /// 42 = tasks_progress on the legacy /code-assist stream + the
    /// per-turn chat identity stamp the 409 fix relies on.
    /// 43 = `provider` on /agent/v2/stream (Anthropic-compatible custom
    /// providers on the Agent engine). An older server ignores the field
    /// and would run a GLM turn on the user's Claude credentials.
    /// v44 deliberately did NOT raise this floor: it removed default_sources
    /// and added llm-sources discovery fields (Library-pane surface, not the
    /// chat wire this floor guards), and refresh-default now 404s cleanly
    /// instead of misbehaving — no chat-path capability silently degrades
    /// against an older server.
    ///
    /// v45 (generate-doc `command`/`prompt`) and v46 (GET/DELETE
    /// /kb/agent/tool-approvals) also deliberately did NOT raise it, for the
    /// same reason: both are additive and off the chat wire this floor
    /// guards. Nothing runs with the wrong credentials and no chat capability
    /// silently degrades, which is the bar for raising the floor.
    ///
    /// The cost of not raising it, stated honestly: against a v45 server the
    /// Settings → Tool permissions card shows a generic "Couldn't load tool
    /// permissions" (it discards the server's own message) and only inside a
    /// card that is collapsed by default — so a user on a stale server gets
    /// no clear "restart the server" signal there. That is acceptable for a
    /// settings surface the user has to go looking for; it would not be for
    /// the chat path.
    ///
    /// v47 (the `ask` mode: menu-bar quick chat + the LLM Chat sheet, unified
    /// onto the code pipeline) also deliberately does NOT raise this floor —
    /// a first pass here raised it and that was wrong. An older server does
    /// not recognize `ask` and silently resolves it to `execute`, which IS a
    /// safety degradation (full act tools in a window whose approvals may
    /// have nothing to render them), but the non-additive part is narrow: it
    /// is confined to the three surfaces that actually send `ask`
    /// (`MenuBarChatView`, `LlmChatSheet`, and `MobileControlManager`'s
    /// `llmide_chat` handler), so the gate belongs there —
    /// `QuickChatContext.serverSupportsAsk` — not at this app-wide floor.
    /// Raising the floor instead was tried and found decorative: this
    /// property's `serverVersionTooOld` flag is only ever rendered by
    /// `LoginView`, `ReconnectView` and `BackendSettingsSection` — a
    /// logged-in user with an already-authenticated session sails straight
    /// past all three into `AppShell` (`ContentView`'s routing never
    /// consults it), and `MenuBarExtra` mounts `MenuBarChatView` in a
    /// separate scene that never touches `ContentView`'s routing at all — so
    /// raising the floor changes no code path that could actually stop an
    /// `ask` request from going out.
    ///
    /// The server reports its version via `/health.apiVersion`; a live server
    /// below this floor sets `serverVersionTooOld` and writes an actionable
    /// `lastError` (see `recordServerVersion`), which Settings → Backend,
    /// LoginView and ReconnectView already render.
    nonisolated static let minimumServerApiVersion = 43

    struct HealthProbeResult {
        let ok: Bool
        let apiVersion: Int?
        /// Set when the server is reachable but too old.
        let versionTooOld: Bool
    }

    /// One session for every `/health` probe. A session per probe was never
    /// invalidated, and a URLSession retains its delegate queue and connection
    /// pool until `invalidateAndCancel()` — with the probe polled every few
    /// seconds that leaked steadily for the life of the app.
    private nonisolated static let healthSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2.0
        config.timeoutIntervalForResource = 2.0
        return URLSession(configuration: config)
    }()

    /// GET `/health` with a 2 s budget. Returns the parsed apiVersion
    /// alongside reachability so callers can distinguish "not running"
    /// from "running but incompatible".
    nonisolated static func probeHealthDetail() async -> HealthProbeResult {
        guard let url = URL(string: "http://127.0.0.1:\(Self.defaultBackendPort)/health") else {
            return HealthProbeResult(ok: false, apiVersion: nil, versionTooOld: false)
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2.0
        do {
            let (data, response) = try await healthSession.data(for: req)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                return HealthProbeResult(ok: false, apiVersion: nil, versionTooOld: false)
            }
            let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let apiVer = parsed?["apiVersion"] as? Int
            return HealthProbeResult(ok: true, apiVersion: apiVer,
                                     versionTooOld: isVersionTooOld(apiVer))
        } catch {
            return HealthProbeResult(ok: false, apiVersion: nil, versionTooOld: false)
        }
    }

    /// Whether a reported `/health.apiVersion` is below what this client needs.
    /// A MISSING version counts as too old — it means a server from before the
    /// field existed, which is older than any floor. Pure, so the rule is
    /// testable without standing up a server; inverting it silently re-blinds
    /// the app to stale backends.
    nonisolated static func isVersionTooOld(_ apiVersion: Int?) -> Bool {
        guard let apiVersion else { return true }
        return apiVersion < minimumServerApiVersion
    }

    /// Back-compat wrapper: true when `/health` returns 2xx. Does NOT check
    /// API version — a too-old server still answers `/health`. Prefer
    /// `probeHealthUsable()` when deciding whether chat/KB/mobile features
    /// can run; keep this for reachability-only checks (e.g. "did the
    /// process die?" in `reconcileHealthAfterFailure`).
    nonisolated static func probeHealth() async -> Bool {
        await probeHealthDetail().ok
    }

    /// True when `/health` answers AND the reported API version meets
    /// `minimumServerApiVersion`. Use for status surfaces that mean
    /// "backend features will work", not merely "something is listening".
    nonisolated static func probeHealthUsable() async -> Bool {
        let health = await probeHealthDetail()
        return health.ok && !health.versionTooOld
    }

    /// Clears a stale startup error when promoting to `.running`. Skipped when
    /// `recordServerVersion` just flagged a too-old server — the spawn path
    /// calls this immediately after that, and wiping `lastError` there was the
    /// bug that hid the version mismatch banner.
    internal func clearLastErrorUnlessVersionTooOld() {
        if !serverVersionTooOld {
            lastError = nil
        }
    }

    /// Record a probe's version verdict and, when the server is too old, say so
    /// where the user will actually see it: the backend log pane plus
    /// `lastError` (already rendered by Settings → Backend, LoginView and
    /// ReconnectView). Without this the mismatch was detected and dropped.
    @MainActor
    func recordServerVersion(_ health: HealthProbeResult, adopted: Bool) {
        serverApiVersion = health.apiVersion
        serverVersionTooOld = health.versionTooOld
        guard health.versionTooOld else {
            // A version that moved UPWARD without a start() — a current server
            // started from a terminal replacing an old one — cleared the flag
            // but left the previous "Backend is too old" text in `lastError`,
            // which Settings → Backend renders unconditionally. Only that
            // message is ours to retract; any other error stays.
            if lastError?.hasPrefix(Self.tooOldErrorPrefix) == true {
                lastError = nil
            }
            return
        }
        let running = health.apiVersion.map(String.init) ?? "unknown"
        let hint = adopted
            ? "It was already running, so the app adopted it instead of starting its own."
            : "It started from the configured server.mjs, which may be an older checkout."
        let message = "\(Self.tooOldErrorPrefix)\(running), this app needs v\(Self.minimumServerApiVersion). "
            + hint
            + " Restart it (Settings → Backend → Restart) or newer features will fail with 404s."
        append("--- \(message) ---", stream: .info)
        lastError = message
    }

    /// Record a probe that came from a REPEATED check (the `ask`-gate refresh
    /// below, the post-failure reconcile) rather than from a start/adopt.
    ///
    /// Same recording, minus the noise: `recordServerVersion` appends a log
    /// line and overwrites `lastError` whenever the server is too old, which
    /// is right once per start and wrong every 5 seconds while a surface
    /// polls. An UNCHANGED version therefore records nothing at all — the
    /// verdict already on screen is the same verdict.
    private func recordServerVersionIfChanged(_ health: HealthProbeResult) {
        guard health.apiVersion != serverApiVersion else { return }
        recordServerVersion(health, adopted: adoptedExternal)
    }

    /// Drop the cached `/health.apiVersion`, so anything gating on it (the
    /// quick chat's `ask` mode) fails closed again rather than answering for
    /// a server that is gone. Deliberately leaves `serverVersionTooOld`/
    /// `lastError` alone: those are a rendered verdict about the last server
    /// seen, cleared by the next successful start.
    private func forgetServerApiVersion() {
        // `@Observable` invalidates on every set, equal or not, and the
        // closed-state poll calls through here every few seconds while a
        // surface waits for a server — so only publish an actual change.
        guard serverApiVersion != nil else { return }
        serverApiVersion = nil
    }

    /// One `/health` probe whose only job is to (re)establish
    /// `serverApiVersion`.
    ///
    /// The version used to be recorded on exactly two paths — `start()`'s
    /// adopt branch and the spawn path — which left the gate broken in both
    /// directions. Stale-OPEN: nothing re-probed while the app ran, so a
    /// server swapped out from a terminal (never through `start()`) kept
    /// answering "v47" from cache. Stuck-CLOSED: with `backendAutoStart`
    /// off — the flow `CLAUDE.md` documents (`cd extension && node
    /// server.mjs`) — `start()` never runs for a logged-in user at all, so
    /// the version stayed `nil` forever and all three `ask` surfaces were
    /// dead against a perfectly good v47 server.
    ///
    /// Callable from anywhere that wants a fresh answer (the two Mac
    /// surfaces poll it while they render the closed state; the phone runs
    /// one before declining). An unreachable server clears the cache instead
    /// of leaving it: no answer must not read as the last answer.
    func refreshServerApiVersion() async {
        let health = await Self.probeHealthDetail()
        guard health.ok else {
            forgetServerApiVersion()
            return
        }
        recordServerVersionIfChanged(health)
    }

    /// One fresh probe for a caller that is about to SEND, reporting whether
    /// the server answered at all and, if so, the version it named.
    ///
    /// Same probe as `refreshServerApiVersion`, minus the cache clearing. The
    /// send path wants a different trade: a healthy-but-busy server that
    /// misses the 2 s budget must not blank the composer out from under a
    /// half-typed message — the send is refused either way, so nothing
    /// unsafe reaches an unknown server, and the surface stays usable when
    /// the next probe answers. A server that ANSWERS with an older version is
    /// still recorded, so the gate closes the composer as it should.
    /// `answered` distinguishes "no reply" from "replied without a version":
    /// a 2xx `/health` with no `apiVersion` is a server that IS there and is
    /// too old to name itself, not an unreachable one, and the caller must be
    /// able to say so.
    func probeServerApiVersionPreservingCache() async -> (answered: Bool, apiVersion: Int?) {
        let health = await Self.probeHealthDetail()
        guard health.ok else { return (false, nil) }
        recordServerVersionIfChanged(health)
        return (true, health.apiVersion)
    }

    /// Returns true iff some process is currently listening on the
    /// given port. Independent of /health so we can tell "no backend"
    /// from "stale backend".
    ///
    /// Implementation: open a TCP connection to 127.0.0.1:<port>.  If
    /// it reaches `.ready` within 250 ms, the port is bound; if it
    /// fails with connection-refused (no listener), the kernel rejects
    /// the SYN immediately and we return false.  Beats `lsof -ti :<port>`
    /// — which forks a process, links libproc, and parses output — by
    /// roughly 30-80 ms per call on warm systems, which is the path
    /// the app takes on every launch before adopt-or-spawn.
    nonisolated static func isPortInUse(port: Int) async -> Bool {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return false }
        let host = NWEndpoint.Host("127.0.0.1")
        let params = NWParameters.tcp
        // Skip Bonjour/proxy resolution — we're hitting loopback only.
        params.preferNoProxies = true
        let conn = NWConnection(host: host, port: nwPort, using: params)
        let queue = DispatchQueue.global(qos: .userInitiated)

        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            // Guard against double-resume — Network framework can fire
            // multiple state callbacks (e.g. .preparing → .failed) and
            // the timeout race would otherwise resume twice.
            let resumedLock = NSLock()
            nonisolated(unsafe) var resumed = false
            let finish: @Sendable (Bool) -> Void = { result in
                resumedLock.lock()
                let already = resumed
                resumed = true
                resumedLock.unlock()
                if already { return }
                conn.cancel()
                cont.resume(returning: result)
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(true)        // port is bound — something is listening
                case .failed, .cancelled:
                    finish(false)       // connection-refused / unreachable → no listener
                case .waiting:
                    // .waiting means the kernel told us "no route / refused";
                    // for loopback this is effectively "closed."
                    finish(false)
                default:
                    break
                }
            }
            conn.start(queue: queue)
            // Hard ceiling so a hostile firewall rule can't stall startup.
            queue.asyncAfter(deadline: .now() + 0.25) {
                finish(false)
            }
        }
    }

    func clearLog() {
        log.removeAll(keepingCapacity: true)
    }

    /// Returns the line buffer so the termination handler can flush a final
    /// unterminated line if it clears the handler before EOF is read.
    private func attachReader(_ handle: FileHandle, stream: BackendLogLine.Stream) -> PipeLineBuffer {
        let buffer = PipeLineBuffer()
        handle.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            let lines: [String]
            if data.isEmpty {
                fh.readabilityHandler = nil
                lines = buffer.finish()
            } else {
                lines = buffer.feed(data)
            }
            guard !lines.isEmpty else { return }
            Task { @MainActor [weak self] in
                self?.appendLines(lines, stream: stream)
            }
        }
        return buffer
    }

    private func appendLines(_ lines: [String], stream: BackendLogLine.Stream) {
        for line in lines where !line.isEmpty {
            append(line, stream: stream)
        }
    }

    private var stderrParser = ServerStderrIncidentParser()
    private var stderrFlush: Task<Void, Never>?

    private func append(_ text: String, stream: BackendLogLine.Stream) {
        log.append(.init(timestamp: Date(), text: text, stream: stream))
        if log.count > maxLogLines {
            log.removeFirst(log.count - maxLogLines)
        }
        guard stream == .stderr else { return }
        for report in stderrParser.feed(text) {
            IncidentRecorder.record(source: .server, category: "server", message: report.message, stack: report.stack)
        }
        // A trace's last frame has no following line to close it; settle after 2 s of quiet.
        stderrFlush?.cancel()
        stderrFlush = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            for report in self.stderrParser.flush() {
                IncidentRecorder.record(source: .server, category: "server", message: report.message, stack: report.stack)
            }
        }
    }

    private func fail(_ message: String) {
        lastError = message
        status = .stopped
        append("ERROR: \(message)", stream: .stderr)
    }
}

extension BackendManager {
    /// User-facing text when `/health` reports an API below
    /// `minimumServerApiVersion`. Prefer the detailed message from
    /// `recordServerVersion`; synthesize a fallback when the flag is set but
    /// `lastError` was cleared elsewhere. Shared by Settings, Login, and
    /// Reconnect so a version mismatch is never visible in only one place.
    /// Shared head of every "too old" message, so `recordServerVersion` can
    /// recognise — and retract — its own text once a newer server answers.
    static let tooOldErrorPrefix = "Backend is too old: API v"

    var versionMismatchBannerText: String? {
        if let err = lastError, !err.isEmpty { return err }
        guard serverVersionTooOld else { return nil }
        let running = serverApiVersion.map(String.init) ?? "unknown"
        return "\(Self.tooOldErrorPrefix)\(running), this app needs v\(Self.minimumServerApiVersion). "
            + "Restart from a current checkout (Settings → Backend → Kill & Restart)."
    }
}
