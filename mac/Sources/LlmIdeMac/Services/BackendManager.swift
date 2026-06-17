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

/// Supervises the local Node `server.mjs` process and exposes its
/// stdout/stderr as a capped, scrollable log buffer that the Settings
/// UI can render directly.
@MainActor
@Observable
final class BackendManager {
    /// The loopback port the Node backend listens on. Single source of truth.
    nonisolated static let defaultBackendPort = 3456

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

    /// Synchronously SIGTERM (then SIGKILL after 1s) the node child we
    /// spawned. Adopted external backends are left alone — they have
    /// their own lifecycle and `stop()` is the path that touches them.
    func terminateSpawnedBackend() {
        guard let p = process, p.isRunning else { return }
        let childPID = p.processIdentifier
        kill(childPID, SIGTERM)
        // Escalate on a utility queue so we don't block willTerminate.
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.0) {
            // Send SIGKILL unconditionally — if the process is already
            // gone, kill() returns ESRCH and that's fine.
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
            home.appendingPathComponent("Developer/LLM IDE/notes-extension/extension"),
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
            if let found = defaultProjectFolders().first(where: { hasServer($0.path) }) {
                config.backendWorkingDir = found.path
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
        Task { [weak self] in
            guard let self else { return }
            let portInUse = await Self.isPortInUse(port: Self.defaultBackendPort)
            if !portInUse {
                await MainActor.run { self.spawn(nodePath: trimmedNode, workURL: workURL) }
                return
            }
            if await Self.probeHealth() {
                await MainActor.run {
                    self.append("--- Adopted existing backend on 127.0.0.1:\(Self.defaultBackendPort) ---", stream: .info)
                    self.adoptedExternal = true
                    self.pid = nil
                    self.status = .running
                }
            } else {
                await MainActor.run {
                    self.append("--- Stale backend on :\(Self.defaultBackendPort) did not answer /health in 2s — killing and respawning ---", stream: .info)
                }
                Self.killExternalListener(port: Self.defaultBackendPort)
                // Give the kernel a beat to release the port before we
                // bind it. 250ms is plenty for SIGTERM-on-loopback.
                try? await Task.sleep(nanoseconds: 250_000_000)
                await MainActor.run { self.spawn(nodePath: trimmedNode, workURL: workURL) }
            }
        }
    }

    private func spawn(nodePath: String, workURL: URL) {
        status = .starting
        lastError = nil
        adoptedExternal = false

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = ["server.mjs"]
        proc.currentDirectoryURL = workURL
        // Pass the parent's environment through so `claude`, `git`, and
        // anything else the server shells out to resolve correctly. We
        // also force a sensible TERM so colour codes don't show up as
        // escape sequences in the log pane.
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "dumb"
        env["MEETNOTES_LOG_JSON"] = env["MEETNOTES_LOG_JSON"] ?? "0"
        proc.environment = env

        let stdOut = Pipe()
        let stdErr = Pipe()
        proc.standardOutput = stdOut
        proc.standardError = stdErr
        attachReader(stdOut.fileHandleForReading, stream: .stdout)
        attachReader(stdErr.fileHandleForReading, stream: .stderr)

        proc.terminationHandler = { [weak self] finished in
            let exitCode = finished.terminationStatus
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.append("--- Server exited (code \(exitCode)) ---", stream: .info)
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
                if exitCode != 0 {
                    self.lastError = self.recentErrorSummary()
                        ?? "Server exited with code \(exitCode). See Settings → Backend for the log."
                }
                self.status = exitCode == 0 ? .stopped : .crashed(exitCode: exitCode)
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
                if await Self.probeHealth() {
                    // Make sure we're still the live process and weren't
                    // stop()'d or replaced while the probe was in flight.
                    guard self.process === proc, proc.isRunning else { return }
                    self.markRunning(nodePath: nodePath, workURL: workURL, proc: proc)
                    return
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            // Timed out. A live-but-unresponsive process is wedged —
            // terminate it and report so the user isn't stuck on a spinner.
            if proc.isRunning, self.process === proc {
                proc.terminate()
                self.fail("Server started but didn't answer /health within 20s. Check Settings → Backend for the log.")
            }
        }
    }

    /// Promote a freshly-spawned, now-healthy server to `.running` and arm
    /// the stable-uptime restart-budget reset.
    private func markRunning(nodePath: String, workURL: URL, proc: Process) {
        status = .running
        lastError = nil
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

    func stop() {
        // Signal the terminationHandler to skip auto-restart. Cleared
        // back to false once the next non-clean exit is handled, or
        // immediately when the user starts the backend again.
        userInitiatedStop = true
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
    nonisolated static func killExternalListener(port: Int) {
        // 1. Find PIDs listening on the port.
        let lsof = Process()
        lsof.launchPath = "/usr/sbin/lsof"
        lsof.arguments = ["-ti", ":\(port)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        lsof.standardOutput = pipe
        lsof.standardError = Pipe() // swallow stderr
        do { try lsof.run() } catch { return }
        lsof.waitUntilExit()
        guard let data = try? pipe.fileHandleForReading.readToEnd(),
              let raw = String(data: data, encoding: .utf8) else { return }
        let pids = raw
            .split(whereSeparator: { $0.isNewline })
            .compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
        guard !pids.isEmpty else { return }

        // 2. SIGTERM each PID individually. We trust lsof's port filter:
        // anyone listening on our configured backend port is, by
        // definition, the listener we want to replace.
        for pid in pids {
            kill(pid, SIGTERM)
        }
    }

    /// Minimum server `apiVersion` this client knows how to talk to.
    /// Bumped when a server-side change breaks the wire shape (e.g.
    /// renamed response fields, removed endpoints). Server reports
    /// its version via /health.apiVersion; if the live server is
    /// older than this, the Mac app surfaces an "update your server"
    /// banner instead of hitting silent 4xx/5xx.
    nonisolated static let minimumServerApiVersion = 18

    struct HealthProbeResult {
        let ok: Bool
        let apiVersion: Int?
        /// Set when the server is reachable but too old.
        let versionTooOld: Bool
    }

    /// GET `/health` with a 2 s budget. Returns the parsed apiVersion
    /// alongside reachability so callers can distinguish "not running"
    /// from "running but incompatible".
    nonisolated static func probeHealthDetail() async -> HealthProbeResult {
        guard let url = URL(string: "http://127.0.0.1:\(Self.defaultBackendPort)/health") else {
            return HealthProbeResult(ok: false, apiVersion: nil, versionTooOld: false)
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2.0
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2.0
        config.timeoutIntervalForResource = 2.0
        let session = URLSession(configuration: config)
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                return HealthProbeResult(ok: false, apiVersion: nil, versionTooOld: false)
            }
            // Parse apiVersion best-effort; absent or unparseable
            // means "old server that didn't surface a version" which
            // we treat as too-old.
            let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let apiVer = parsed?["apiVersion"] as? Int
            let tooOld = apiVer == nil || (apiVer ?? 0) < Self.minimumServerApiVersion
            return HealthProbeResult(ok: true, apiVersion: apiVer, versionTooOld: tooOld)
        } catch {
            return HealthProbeResult(ok: false, apiVersion: nil, versionTooOld: false)
        }
    }

    /// Back-compat wrapper for callers that only need reachability.
    nonisolated static func probeHealth() async -> Bool {
        await probeHealthDetail().ok
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

    private func attachReader(_ handle: FileHandle, stream: BackendLogLine.Stream) {
        handle.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            if data.isEmpty {
                fh.readabilityHandler = nil
                return
            }
            guard let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                    let str = String(line)
                    if !str.isEmpty {
                        self.append(str, stream: stream)
                    }
                }
            }
        }
    }

    private func append(_ text: String, stream: BackendLogLine.Stream) {
        log.append(.init(timestamp: Date(), text: text, stream: stream))
        if log.count > maxLogLines {
            log.removeFirst(log.count - maxLogLines)
        }
    }

    private func fail(_ message: String) {
        lastError = message
        status = .stopped
        append("ERROR: \(message)", stream: .stderr)
    }
}
