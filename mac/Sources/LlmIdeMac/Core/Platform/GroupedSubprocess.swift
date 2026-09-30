// One subprocess primitive for commands whose whole tree must be stoppable
// and whose output must be kept bounded: Loop shell stages and verifiers
// (`ShellFaultVerifier`). Four rules, each a bug the old `Process`-based
// verifier had:
//
//  1. **The child leads its own process group** (`posix_spawn` with
//     `POSIX_SPAWN_SETPGROUP`; `Process` cannot do this). Stop, timeout and the
//     ResourceGuard signal the GROUP — SIGTERM, then SIGKILL after a grace — so
//     `sh -c 'swift test'` no longer leaves `swift-build`/`xctest` running after
//     `/bin/sh` is killed. Descendants that left the group (setsid) are still
//     reached through a `ProcessTree` snapshot.
//  2. **Output is read incrementally into a capped head+tail buffer**, never
//     `readDataToEndOfFile`. A backgrounded grandchild that keeps the pipe open
//     used to leave the result EMPTY (the one-shot read never returned); now
//     everything read so far is kept, and leftovers are stopped once the shell
//     has exited and the pipe stays open past a short drain window.
//  3. **Decoding never fails**: `String(decoding:as: UTF8.self)` — one stray
//     non-UTF-8 byte used to turn the whole output into "".
//  4. **Nothing here touches SIGPIPE process-wide.** We only ever READ from the
//     pipe (stdin is /dev/null), so the per-fd `F_SETNOSIGPIPE` rule used for
//     pipes the app writes to does not come into play.

import Darwin
import Foundation

/// Bounded capture: the first `headLimit` bytes and the last `tailLimit` bytes,
/// with an elision marker naming how much was dropped between them. The head
/// keeps the build's first error; the tail keeps the test summary.
final class CappedOutputBuffer: @unchecked Sendable {
    static let defaultHeadLimit = 64 * 1_024
    static let defaultTailLimit = 192 * 1_024

    private let lock = NSLock()
    private let headLimit: Int
    private let tailLimit: Int
    private var head = Data()
    private var tail = Data()
    private var total = 0

    init(headLimit: Int = CappedOutputBuffer.defaultHeadLimit,
         tailLimit: Int = CappedOutputBuffer.defaultTailLimit) {
        self.headLimit = headLimit
        self.tailLimit = tailLimit
    }

    func append(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        total += chunk.count
        var rest = chunk[...]
        let room = headLimit - head.count
        if room > 0 {
            head.append(rest.prefix(room))
            rest = rest.dropFirst(room)
        }
        guard !rest.isEmpty else { return }
        tail.append(contentsOf: rest)
        // Amortised trim: let the tail grow to twice its limit before cutting,
        // so a chatty writer does not pay a copy per chunk.
        if tail.count > tailLimit * 2 { tail = Data(tail.suffix(tailLimit)) }
    }

    /// Bytes received in total, retained or not.
    var totalBytes: Int { lock.lock(); defer { lock.unlock() }; return total }

    /// True when some bytes were dropped between head and tail.
    var wasElided: Bool {
        lock.lock(); defer { lock.unlock() }
        return total > head.count + min(tail.count, tailLimit)
    }

    /// The captured text. Never fails on invalid UTF-8 — bad bytes become U+FFFD.
    func text() -> String {
        lock.lock()
        let h = head
        let t = Data(tail.suffix(tailLimit))
        let dropped = total - h.count - t.count
        lock.unlock()
        guard dropped > 0 else {
            // Nothing elided: decode as one piece so a character split across
            // the head/tail boundary is not mangled.
            return String(decoding: h + t, as: UTF8.self)
        }
        return String(decoding: h, as: UTF8.self)
            + "\n\n… [\(dropped) bytes of output elided] …\n\n"
            + String(decoding: t, as: UTF8.self)
    }
}

/// A launched child that leads its own process group, plus the threads that
/// drain its output and reap it. All members are thread-safe.
final class GroupedSubprocess: @unchecked Sendable {
    enum LaunchError: Error, LocalizedError {
        case failed(String)
        var errorDescription: String? {
            switch self { case .failed(let reason): return reason }
        }
    }

    /// pid of the shell — also the process-group id.
    let pid: pid_t
    let output: CappedOutputBuffer

    private let lock = NSLock()
    private var status: Int32?
    private var readerDone = false
    private var stopReading = false
    /// Descendants seen at the first signal: once the shell exits they are
    /// re-parented to launchd and a fresh walk from its pid cannot find them.
    private var tree: ProcessTree.Snapshot = [:]

    private init(pid: pid_t, output: CappedOutputBuffer) {
        self.pid = pid
        self.output = output
    }

    /// Exit status of the shell once it has been reaped (128+N for signal N).
    var exitStatus: Int32? { lock.lock(); defer { lock.unlock() }; return status }
    var hasExited: Bool { exitStatus != nil }
    /// True once the reader hit EOF (every holder of the pipe closed it) or
    /// was told to stop.
    var outputComplete: Bool { lock.lock(); defer { lock.unlock() }; return readerDone }

    /// Runs `command` under `/bin/sh -c` in `directory`, stdin from /dev/null,
    /// stdout+stderr into one capped buffer.
    static func launch(shellCommand command: String, directory: URL,
                       output: CappedOutputBuffer = CappedOutputBuffer()) throws -> GroupedSubprocess {
        var fds: [Int32] = [0, 0]
        guard pipe(&fds) == 0 else { throw LaunchError.failed("pipe: \(String(cString: strerror(errno)))") }
        let (readFd, writeFd) = (fds[0], fds[1])
        // Close-on-exec on both ends, so a process some OTHER thread spawns
        // meanwhile cannot inherit the write end and hold the pipe open.
        _ = fcntl(readFd, F_SETFD, FD_CLOEXEC)
        _ = fcntl(writeFd, F_SETFD, FD_CLOEXEC)

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, writeFd, 1)
        posix_spawn_file_actions_adddup2(&actions, writeFd, 2)
        posix_spawn_file_actions_addchdir_np(&actions, directory.path)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Own process group (pgid = child pid); inherit ONLY fds 0-2; default
        // dispositions and an empty mask for the signals a shell cares about,
        // whatever this app did to its own.
        let flags = POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT
            | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK
        posix_spawnattr_setflags(&attr, Int16(flags))
        posix_spawnattr_setpgroup(&attr, 0)
        var defaults = sigset_t()
        sigemptyset(&defaults)
        for sig in [SIGPIPE, SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGCHLD, SIGALRM, SIGUSR1, SIGUSR2] {
            sigaddset(&defaults, sig)
        }
        posix_spawnattr_setsigdefault(&attr, &defaults)
        var mask = sigset_t()
        sigemptyset(&mask)
        posix_spawnattr_setsigmask(&attr, &mask)

        let argv: [UnsafeMutablePointer<CChar>?] = [strdup("/bin/sh"), strdup("-c"), strdup(command), nil]
        defer { argv.forEach { free($0) } }
        var child: pid_t = 0
        let rc = posix_spawn(&child, "/bin/sh", &actions, &attr, argv, environ)
        close(writeFd)   // the child has its own copy; ours would block EOF forever
        guard rc == 0 else {
            close(readFd)
            throw LaunchError.failed("posix_spawn: \(String(cString: strerror(rc)))")
        }
        let proc = GroupedSubprocess(pid: child, output: output)
        proc.startReader(readFd)
        proc.startReaper()
        return proc
    }

    // MARK: - Draining and reaping

    /// Reads in chunks as output arrives. `poll` with a short timeout, not a
    /// bare blocking `read`, so `stopReading` can end the loop even while some
    /// escaped descendant still holds the write end.
    private func startReader(_ fd: Int32) {
        let thread = Thread { [self] in
            var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            while true {
                if shouldStopReading { break }
                pfd.revents = 0
                let ready = poll(&pfd, 1, 100)
                if ready < 0 { if errno == EINTR { continue }; break }
                if ready == 0 { continue }
                let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
                if n > 0 { output.append(Data(buffer[0..<n])); continue }
                if n < 0, errno == EINTR || errno == EAGAIN { continue }
                break   // EOF (n == 0) or a real error
            }
            close(fd)
            lock.lock(); readerDone = true; lock.unlock()
        }
        thread.name = "GroupedSubprocess.reader"
        thread.start()
    }

    private var shouldStopReading: Bool { lock.lock(); defer { lock.unlock() }; return stopReading }
    private func requestStopReading() { lock.lock(); stopReading = true; lock.unlock() }

    /// Blocking `waitpid` on a thread of its own, so the child is ALWAYS
    /// reaped — whatever path the caller leaves by (cancellation included).
    private func startReaper() {
        let thread = Thread { [self] in
            var raw: Int32 = 0
            while waitpid(pid, &raw, 0) < 0 && errno == EINTR {}
            // WIFEXITED / WEXITSTATUS / WTERMSIG are C macros Swift cannot import.
            let sig = raw & 0x7f
            let code: Int32 = sig == 0 ? (raw >> 8) & 0xff : 128 + sig
            lock.lock(); status = code; lock.unlock()
        }
        thread.name = "GroupedSubprocess.reaper"
        thread.start()
    }

    // MARK: - Signalling

    /// Sends `sig` to the whole process group, plus every descendant seen so
    /// far that left the group. Signalling the group after the shell has been
    /// reaped is safe: the kernel does not reuse a pid as long as a process
    /// group with that id still has members, and an empty group is ESRCH.
    func signalTree(_ sig: Int32) {
        lock.lock(); defer { lock.unlock() }
        if status == nil {
            tree.merge(ProcessTree.snapshot(descendantsOfAny: [pid])) { old, _ in old }
        }
        let alive = ProcessTree.stillAlive(tree)
        tree = alive
        // Re-walk from survivors: they may have spawned more after the shell died.
        tree.merge(ProcessTree.snapshot(descendantsOfAny: Set(alive.keys))) { old, _ in old }
        kill(-pid, sig)
        ProcessTree.signal(tree, sig)
    }

    /// SIGTERM the tree now, SIGKILL whatever is left after `grace`. Returns
    /// immediately — usable from a `defer` or a cancellation handler.
    func terminateTree(grace: TimeInterval = 1.0) {
        signalTree(SIGTERM)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + grace) { [self] in
            signalTree(SIGKILL)
        }
    }

    /// Polls until the shell has exited. Cancellation-aware via `Task.sleep`.
    func waitForExit(pollInterval: UInt64 = 25_000_000) async throws {
        while !hasExited { try await Task.sleep(nanoseconds: pollInterval) }
    }

    /// A sleep that cancellation cannot cut short. `try? await Task.sleep`
    /// returns IMMEDIATELY in a cancelled task, which turned the bounded
    /// drain waits below into busy-spins after a Stop.
    static func pause(nanoseconds: UInt64) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .utility)
                .asyncAfter(deadline: .now() + .nanoseconds(Int(nanoseconds))) { done.resume() }
        }
    }

    /// The output, once the shell has exited. Waits up to `drainWindow` for
    /// EOF; if something the shell left behind still holds the pipe after
    /// that, stops that leftover tree and returns what was captured —
    /// never an empty result because of it.
    func collectOutput(drainWindow: TimeInterval = 2.0) async -> String {
        let deadline = Date().addingTimeInterval(drainWindow)
        while !outputComplete, Date() < deadline { await Self.pause(nanoseconds: 10_000_000) }
        if !outputComplete {
            // Killing the leftovers closes their write ends, so the reader
            // normally reaches EOF on its own; only a holder that escaped
            // every signal makes the reader give up instead.
            terminateTree(grace: 0.5)
            let eofBy = Date().addingTimeInterval(1.0)
            while !outputComplete, Date() < eofBy { await Self.pause(nanoseconds: 10_000_000) }
            requestStopReading()
            let stopBy = Date().addingTimeInterval(0.5)
            while !outputComplete, Date() < stopBy { await Self.pause(nanoseconds: 10_000_000) }
        }
        return output.text()
    }
}
