import AppKit
import Foundation
import Network
import Observation

/// One log line printed by the computer-agent process.
struct MobileLogLine: Identifiable, Hashable {
    let id = UUID()
    let text: String
    let stream: Stream
    enum Stream: String { case stdout, stderr, info }
}

/// Supervises the external mobile computer-agent (`npm start` on :3006)
/// with the same start/stop/log UX as `BackendManager`. The iPhone remote
/// app connects to this agent's WebSocket server; LLM IDE launches and
/// monitors it so the user doesn't have to keep a terminal open.
///
/// Mirrors `BackendManager`'s adopt-don't-spawn contract: if something is
/// already listening on :3006 and answers `/info`, we adopt it rather than
/// spawning a duplicate. `stopIfOwned()` therefore only tears down a process
/// WE spawned — an externally-launched agent (the common case, when the user
/// runs it from their own terminal) is left strictly alone.
@MainActor
@Observable
final class MobileControlManager {

    /// Loopback port the computer-agent's WebSocket server listens on.
    nonisolated static let defaultAgentPort = 3006

    enum Status: Equatable {
        case stopped
        case starting
        case running
        case crashed(exitCode: Int32)
    }

    private(set) var status: Status = .stopped
    private(set) var pid: Int32?
    private(set) var logLines: [MobileLogLine] = []
    var lastError: String?

    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private let maxLogLines = 5_000

    /// True when `.running` was reached by adopting an already-listening
    /// agent rather than spawning our own child. `stopIfOwned()` won't touch
    /// an adopted agent — it has its own lifecycle.
    private var adoptedExternal = false

    init() {
        // Best-effort cleanup of a spawned agent child on force-quit / Cmd-Q
        // / logout, so it doesn't outlive the app. We deliberately only
        // signal — same tight-budget rationale as BackendManager.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.stopIfOwned()
            }
        }
    }

    // MARK: - Start / adopt

    func start(agentPath: String) {
        if case .running = status { return }
        if case .starting = status { return }

        let trimmed = agentPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            fail("Agent folder is empty. Browse to the computer-agent folder in Settings.")
            return
        }
        let dir = URL(fileURLWithPath: trimmed)
        guard FileManager.default.fileExists(
            atPath: dir.appendingPathComponent("package.json").path
        ) else {
            fail("package.json not found in \(dir.path) — not the computer-agent folder.")
            return
        }

        // Claim `.starting` synchronously BEFORE the first await so a second
        // concurrent caller trips the guard above instead of both spawning.
        status = .starting

        Task { [self] in
            // Adopt-don't-spawn: an agent already listening on :3006 that
            // answers /info is adopted instead of duplicated. This is the
            // common case — the user often runs the agent from a terminal.
            let portInUse = await Self.isPortInUse(port: Self.defaultAgentPort)
            if portInUse, await Self.probeInfo() {
                await MainActor.run {
                    self.append("--- Adopted existing agent on 127.0.0.1:\(Self.defaultAgentPort) ---", stream: .info)
                    self.adoptedExternal = true
                    self.pid = nil
                    self.lastError = nil
                    self.status = .running
                }
                return
            }
            // No healthy agent listening — spawn `npm start` in the folder.
            guard let npm = Self.autoDetectNpm() else {
                await MainActor.run {
                    self.fail("npm not found in /opt/homebrew/bin or /usr/local/bin. Install Node, or run the agent from a terminal.")
                }
                return
            }
            await MainActor.run { self.spawn(npm: npm, dir: dir) }
        }
    }

    private func spawn(npm: String, dir: URL) {
        status = .starting
        lastError = nil
        adoptedExternal = false

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: npm)
        proc.arguments = ["start"]
        proc.currentDirectoryURL = dir

        // Same environment allowlist as BackendManager: don't leak ambient
        // secrets (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, …) to the agent and
        // every subprocess it spawns. Keep the agent's own config overrides
        // (PORT, AGENT_PIN, DEVICE_NAME, LLMIDE_*, …) and a PATH wide enough
        // for the agent's own tool invocations.
        let base = ProcessInfo.processInfo.environment
        let exactAllow: Set<String> = [
            "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM",
            "LANG", "LC_ALL", "LC_CTYPE", "NODE_ENV", "PORT", "DEVICE_NAME",
            "XDG_CONFIG_HOME", "XDG_DATA_HOME", "APPDATA", "USERPROFILE"
        ]
        let prefixAllow = ["LLMIDE_", "MEETNOTES_", "ANTHROPIC_", "AGENT_", "LC_", "XDG_"]
        var env: [String: String] = [:]
        for (k, v) in base where exactAllow.contains(k) || prefixAllow.contains(where: { k.hasPrefix($0) }) {
            env[k] = v
        }
        env["TERM"] = "dumb"
        let home = base["HOME"] ?? NSHomeDirectory()
        let cliDirs = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin",
                       "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let inherited = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        var seenPath = Set<String>()
        env["PATH"] = (cliDirs + inherited)
            .filter { !$0.isEmpty && seenPath.insert($0).inserted }
            .joined(separator: ":")
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
                self.append("--- Agent exited (code \(exitCode)) ---", stream: .info)
                self.pid = nil
                self.process = nil
                self.stdoutPipe?.fileHandleForReading.readabilityHandler = nil
                self.stderrPipe?.fileHandleForReading.readabilityHandler = nil
                self.stdoutPipe = nil
                self.stderrPipe = nil
                if exitCode != 0 {
                    self.lastError = "Agent exited with code \(exitCode). See Settings → Mobile Control for the log."
                }
                self.status = exitCode == 0 ? .stopped : .crashed(exitCode: exitCode)
            }
        }

        do {
            try proc.run()
            self.process = proc
            self.pid = proc.processIdentifier
            self.stdoutPipe = stdOut
            self.stderrPipe = stdErr
            append("--- Agent launched (pid \(proc.processIdentifier)), waiting for /info… ---", stream: .info)
            // Stay `.starting` — proc.run() only means the OS exec'd npm; the
            // WebSocket server hasn't bound :3006 yet. Flip to `.running` only
            // once /info actually answers.
            waitForReadyThenRun(proc: proc)
        } catch {
            fail("Failed to launch agent: \(error.localizedDescription)")
        }
    }

    /// Poll `/info` until the agent answers, then flip to `.running`. Bails
    /// if the process dies first (the terminationHandler owns that transition)
    /// or if it never becomes ready within the budget.
    private func waitForReadyThenRun(proc: Process) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline {
                if !proc.isRunning { return }
                if await Self.probeInfo() {
                    guard self.process === proc, proc.isRunning else { return }
                    self.status = .running
                    self.lastError = nil
                    self.append("--- Agent ready (pid \(proc.processIdentifier)) ---", stream: .info)
                    return
                }
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            if proc.isRunning, self.process === proc {
                proc.terminate()
                self.fail("Agent started but didn't answer /info within 20s. Check Settings → Mobile Control for the log.")
            }
        }
    }

    // MARK: - Stop

    /// Stop only a process WE spawned. An adopted (externally-launched)
    /// agent is left running — the user manages its lifecycle.
    func stopIfOwned() {
        if let p = process {
            append("--- Stopping agent ---", stream: .info)
            p.terminate()
        }
    }

    func clearLog() {
        logLines.removeAll(keepingCapacity: true)
    }

    /// Log a command originating from the chat interface.
    func logChatCommand(_ command: String, payload: [String: Any] = [:]) {
        var detail = command
        if !payload.isEmpty, let json = try? JSONSerialization.data(withJSONObject: payload),
           let str = String(data: json, encoding: .utf8) {
            detail += " \(str)"
        }
        append("CHAT: \(detail)", stream: .info)
    }

    // MARK: - npm detection + probes

    /// First npm binary in well-known macOS locations. Mirrors
    /// `BackendManager.autoDetectNode()` — no shell, no login shell.
    nonisolated static func autoDetectNpm() -> String? {
        let candidates = [
            "/opt/homebrew/bin/npm",
            "/usr/local/bin/npm",
            "/usr/bin/npm",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// GET `/info` on the agent port with a 2 s budget. The computer-agent
    /// answers `{ deviceName, platform }` once its WebSocket server is up.
    nonisolated static func probeInfo() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(Self.defaultAgentPort)/info") else {
            return false
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2.0
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2.0
        config.timeoutIntervalForResource = 2.0
        let session = URLSession(configuration: config)
        do {
            let (_, response) = try await session.data(for: req)
            if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                return true
            }
            return false
        } catch {
            return false
        }
    }

    /// True iff some process is listening on `port`. A loopback TCP connect
    /// probe — reaches `.ready` within 250 ms when the port is bound, fails
    /// fast with connection-refused when it isn't.
    nonisolated static func isPortInUse(port: Int) async -> Bool {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return false }
        let host = NWEndpoint.Host("127.0.0.1")
        let params = NWParameters.tcp
        params.preferNoProxies = true
        let conn = NWConnection(host: host, port: nwPort, using: params)
        let queue = DispatchQueue.global(qos: .userInitiated)

        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
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
                case .ready:           finish(true)   // port is bound
                case .failed, .cancelled: finish(false)
                case .waiting:         finish(false)
                default: break
                }
            }
            conn.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 0.25) { finish(false) }
        }
    }

    // MARK: - Log capture

    private func attachReader(_ handle: FileHandle, stream: MobileLogLine.Stream) {
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

    private func append(_ text: String, stream: MobileLogLine.Stream) {
        logLines.append(.init(text: text, stream: stream))
        if logLines.count > maxLogLines {
            logLines.removeFirst(logLines.count - maxLogLines)
        }
    }

    private func fail(_ message: String) {
        lastError = message
        status = .stopped
        append("ERROR: \(message)", stream: .stderr)
    }
}
