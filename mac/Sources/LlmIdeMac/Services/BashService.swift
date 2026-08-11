import Foundation

/// Bash/code execution service for running shell commands locally.
///
/// Three invariants keep a chat turn from dying on a command (each one is a
/// bug this class previously had):
///
///  1. **Pipes are drained CONCURRENTLY with the child process**, never after
///     it exits. A pipe holds ~64 KB; a command that writes more (any
///     repo-wide `grep`) blocks in `write()` until someone reads. Waiting for
///     exit before reading therefore deadlocked permanently — and because
///     `execute` used to be `@MainActor` and called `waitUntilExit()`, that
///     deadlock froze the whole app with the pending-action card still on
///     screen and no result ever returned.
///  2. **Nothing blocks the main actor.** The process is supervised on a
///     background queue; `execute` is a plain async function, and every
///     non-Sendable object it uses (`Process`, `Pipe`, `FileHandle`) is
///     created and consumed inside that queue.
///  3. **Every run is bounded** — wall-clock timeout, SIGTERM→SIGKILL
///     escalation, and a captured-output cap, mirroring the server-side twin
///     (`extension/llm_agent/runtime/handlers/run-bash.mjs`). Unbounded output
///     used to be appended to the chat verbatim, where it evicted the rest of
///     the conversation from the model's context.
final class BashService: Sendable {

    /// Wall-clock ceiling for one command. Deliberately larger than the
    /// server's 30 s: the commands routed here are the user's own build/test
    /// runs (`swift build`, `npm test`), which legitimately take minutes.
    static let defaultTimeout: TimeInterval = 180
    /// Grace period between SIGTERM and SIGKILL for a child that ignores the
    /// polite signal.
    private static let killGrace: TimeInterval = 2
    /// Per-stream character cap on what we hand back to the chat.
    static let maxOutputChars = 20_000
    /// Per-stream byte cap on what we retain while draining. We keep reading
    /// past this (the child must never block on a full pipe) but stop
    /// retaining, so an endless writer can't grow the app's heap.
    private static let maxCaptureBytes = 1_024 * 1_024

    struct ExecutionResult: Sendable {
        let exitCode: Int32
        let stdout: String
        let stderr: String
        let duration: TimeInterval
        /// True when the command was killed for exceeding the timeout.
        let timedOut: Bool
        /// True when either stream was clipped by a cap above.
        let truncated: Bool

        var isSuccess: Bool { exitCode == 0 && !timedOut }

        /// Chat-facing rendering. Labels the streams only when BOTH carry
        /// content — a lone stderr (the common case for a failing build) reads
        /// better unlabelled, and the caller already prefixes the exit code.
        var output: String {
            var body: String
            if !stderr.isEmpty && !stdout.isEmpty {
                body = "STDOUT:\n\(stdout)\n\nSTDERR:\n\(stderr)"
            } else if !stderr.isEmpty {
                body = stderr
            } else {
                body = stdout
            }
            if timedOut {
                let note = "(command timed out after \(Int(duration))s and was killed)"
                body = body.isEmpty ? note : "\(body)\n\n\(note)"
            } else if truncated {
                body += "\n\n(output truncated)"
            }
            return body
        }
    }

    /// Execute a shell command and return the result. Never throws; a launch
    /// failure surfaces as `exitCode == -1` with the reason on stderr.
    func execute(_ command: String,
                 workingDirectory: String? = nil,
                 timeout: TimeInterval = BashService.defaultTimeout) async -> ExecutionResult {
        let start = Date()
        // Created up front because the cancellation handler below needs a
        // handle to the child before the child exists.
        let box = ProcessBox()
        let captureBytes = Self.maxCaptureBytes
        let outputChars = Self.maxOutputChars
        let grace = Self.killGrace

        // Kill the child if the surrounding Task is cancelled (chat Stop /
        // session switch), so a runaway command can't outlive the turn that
        // started it.
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<ExecutionResult, Never>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    let process = Process()
                    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
                    process.arguments = ["-c", command]
                    if let dir = workingDirectory, !dir.isEmpty {
                        process.currentDirectoryURL =
                            URL(fileURLWithPath: (dir as NSString).expandingTildeInPath)
                    }

                    let stdoutPipe = Pipe()
                    let stderrPipe = Pipe()
                    process.standardOutput = stdoutPipe
                    process.standardError = stderrPipe
                    // Detach stdin: inheriting the app's stdin lets a command
                    // that prompts for input (a stray `read`, an unexpected
                    // credential prompt) block until the timeout instead of
                    // failing fast on EOF.
                    process.standardInput = FileHandle.nullDevice

                    let finish: (ExecutionResult) -> Void = { cont.resume(returning: $0) }

                    do {
                        try process.run()
                    } catch {
                        finish(ExecutionResult(
                            exitCode: -1, stdout: "", stderr: error.localizedDescription,
                            duration: Date().timeIntervalSince(start),
                            timedOut: false, truncated: false))
                        return
                    }
                    // Cancellation that arrived before launch completed is
                    // applied here rather than lost.
                    if !box.adopt(process) { box.terminate() }

                    // Drain both streams to EOF on their own threads, started
                    // only AFTER a successful launch (a failed `run()` never
                    // closes the write ends, so a reader started earlier would
                    // block forever on the `group.wait()` below).
                    let out = ByteSink(limit: captureBytes)
                    let err = ByteSink(limit: captureBytes)
                    let group = DispatchGroup()
                    Self.drainInBackground(HandleBox(stdoutPipe.fileHandleForReading),
                                          into: out, group: group)
                    Self.drainInBackground(HandleBox(stderrPipe.fileHandleForReading),
                                          into: err, group: group)

                    // Timeout watchdog: SIGTERM, then SIGKILL after a grace
                    // period for a child that ignores it. Either way the child
                    // dies, its write ends close, and the drains reach EOF.
                    let watchdog = DispatchWorkItem {
                        guard box.isRunning else { return }
                        box.markTimedOut()
                        box.terminate()
                        DispatchQueue.global().asyncAfter(deadline: .now() + grace) {
                            box.forceKill()
                        }
                    }
                    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)

                    process.waitUntilExit()
                    watchdog.cancel()
                    // Wait for the readers, not just the process: the tail of
                    // the output can still be in flight when the child exits.
                    group.wait()

                    let (outText, outClipped) = out.text(maxChars: outputChars)
                    let (errText, errClipped) = err.text(maxChars: outputChars)
                    finish(ExecutionResult(
                        exitCode: process.terminationStatus,
                        stdout: outText,
                        stderr: errText,
                        duration: Date().timeIntervalSince(start),
                        timedOut: box.didTimeOut,
                        truncated: outClipped || errClipped))
                }
            }
        } onCancel: {
            box.terminate()
        }
    }

    /// Read `handle` to EOF in bounded chunks on a background thread. Reading
    /// CONTINUES past the sink's retention limit on purpose — stopping early
    /// would leave the child blocked on a full pipe forever.
    private static func drainInBackground(_ handle: HandleBox,
                                          into sink: ByteSink,
                                          group: DispatchGroup) {
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            while true {
                let chunk = (try? handle.handle.read(upToCount: 64 * 1_024)) ?? nil
                guard let chunk, !chunk.isEmpty else { break }
                sink.append(chunk)
            }
            group.leave()
        }
    }

    /// Validate a command for basic safety
    func validateCommand(_ command: String) -> Bool {
        // Basic validation - prevent obvious dangerous operations
        let dangerousPatterns = [
            "rm -rf /",
            "rm -rf /*",
            ":(){ :|:& };:", // fork bomb
            "dd if=/dev/zero",
            "mkfs",
            "format",
            "> /dev/sd",  // disk writes
            "chmod 000",   // remove all permissions
        ]

        let lowercased = command.lowercased()
        for pattern in dangerousPatterns {
            if lowercased.contains(pattern) {
                return false
            }
        }

        return true
    }
}

/// Lock-guarded byte accumulator. Written from a drain thread, read once the
/// drains have finished, so the lock only has to make `append` atomic and
/// publish the bytes to the reader.
private final class ByteSink: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var clipped = false
    private let limit: Int

    init(limit: Int) { self.limit = limit }

    func append(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        let room = limit - bytes.count
        if room <= 0 { clipped = true; return }
        if chunk.count > room {
            bytes.append(chunk.prefix(room))
            clipped = true
        } else {
            bytes.append(chunk)
        }
    }

    /// Decoded text plus whether anything was dropped by either the byte cap
    /// or `maxChars`. `String.prefix` is grapheme-safe, so clipping can't
    /// split a multi-byte character.
    func text(maxChars: Int) -> (String, Bool) {
        lock.lock()
        let data = bytes
        let wasClipped = clipped
        lock.unlock()
        let decoded = String(decoding: data, as: UTF8.self)
        if decoded.count > maxChars {
            return (String(decoded.prefix(maxChars)), true)
        }
        return (decoded, wasClipped)
    }
}

/// `FileHandle` isn't `Sendable`; the drain threads own theirs exclusively for
/// the lifetime of the read loop, which this box asserts.
private final class HandleBox: @unchecked Sendable {
    let handle: FileHandle
    init(_ handle: FileHandle) { self.handle = handle }
}

/// `Process` isn't `Sendable`, but the watchdog and the cancellation handler
/// both need to signal it from other threads. This wrapper exposes only the
/// thread-safe operations we actually use, plus the timed-out flag. The
/// process is adopted after launch, so cancellation arriving before then is
/// recorded and applied by `adopt`'s return value rather than dropped.
private final class ProcessBox: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var timedOut = false
    private var cancelled = false

    /// Take ownership of the launched process. Returns false when cancellation
    /// already arrived, meaning the caller should tear it down immediately.
    func adopt(_ p: Process) -> Bool {
        lock.lock(); defer { lock.unlock() }
        process = p
        return !cancelled
    }

    var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return process?.isRunning ?? false
    }

    var didTimeOut: Bool {
        lock.lock(); defer { lock.unlock() }
        return timedOut
    }

    func markTimedOut() {
        lock.lock(); defer { lock.unlock() }
        timedOut = true
    }

    func terminate() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
        if let p = process, p.isRunning { p.terminate() }
    }

    /// SIGKILL the child, and its process group when it happens to lead one:
    /// `zsh -c "npm test"` spawns grandchildren that keep the pipe's write end
    /// open, so killing only the shell can leave the drains waiting on EOF.
    /// `kill(-pid)` is safe here — a process-group id only exists while its
    /// leader does, and that leader can only be this child (pids are unique
    /// among live processes), so the worst case is a harmless ESRCH.
    func forceKill() {
        lock.lock(); defer { lock.unlock() }
        guard let p = process, p.isRunning else { return }
        let pid = p.processIdentifier
        guard pid > 0 else { return }
        kill(-pid, SIGKILL)
        kill(pid, SIGKILL)
    }
}
