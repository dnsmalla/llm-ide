import AppKit
import Combine
import Foundation

/// Drives an in-place feature-selected rebuild: stage a release build with a
/// chosen `AppFeature` set into Application Support, then hand off to
/// `rebuild-swap.sh` (a detached helper) which waits for this process to
/// exit, installs the staged bundle over the running one, and relaunches.
///
/// This is core chrome, not a toggleable feature — it is never registered
/// with `FeatureRegistry` and has no `AppModule` conformance.
@MainActor
final class FeatureRebuildService: ObservableObject {
    enum Phase: Equatable {
        case idle
        case building
        case readyToSwap
        /// Entered the instant `swapAndRelaunch()` spawns the helper, before
        /// `NSApp.terminate` actually tears the process down — closes the
        /// window between "staged, ready" and "gone" during which a second
        /// tap on the same button must be a no-op, not a second
        /// `rebuild-swap.sh` racing the first.
        case swapping
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    /// Last ~20 stdout/stderr lines from `rebuild-features.sh`, in order —
    /// what the Settings card renders. Derived from `logBuffer` (below) on
    /// every append, so it's always that buffer's tail.
    @Published private(set) var logTail: [String] = []
    /// Cached result of the `xcrun --find swift` probe kicked off from
    /// `init`. Nil until the probe completes; the card must not appear
    /// before it resolves `true`, so `isEligible` treats nil as "not yet
    /// eligible" rather than optimistically true.
    @Published private(set) var toolchainAvailable: Bool = false

    /// Nil when this Mac can't rebuild (no checkout at the recorded path, or
    /// this bundle wasn't built with `LLMIDESourceRoot` set at all — e.g. a
    /// distributed release). Non-nil = the `mac/` directory of the checkout.
    let sourceRoot: URL?
    /// The `.app` bundle to replace (`Bundle.main.bundleURL` when it ends in
    /// `.app`; nil for a bare executable, e.g. under `swift run`).
    let installTarget: URL?

    /// Single source of truth for whether the Settings card should render at
    /// all: a checkout (`sourceRoot`), an installable target (`installTarget`),
    /// AND a working toolchain (`toolchainAvailable`, published — starts
    /// `false` until the async `xcrun --find swift` probe kicked off from
    /// `init` resolves) must all be present. `startRebuild()` re-checks the
    /// toolchain itself at run time (`toolchainIsAvailable()`) as a
    /// defense-in-depth guard independent of this cached flag.
    var isEligible: Bool { sourceRoot != nil && installTarget != nil && toolchainAvailable }

    /// Features this binary was compiled with vs what's active now — drives
    /// the "drift" hint in Settings. Read live off `FeatureRegistry.shared`
    /// rather than snapshotted at init, so it stays current as the user
    /// toggles features.
    var compiledSet: Set<AppFeature> { FeatureRegistry.shared.compiledFeatures }
    /// `FeatureRegistry.shared.activeFeatures` as the CSV `rebuild-features.sh` expects.
    var desiredCSV: String { Self.featureCSV(for: FeatureRegistry.shared.activeFeatures) }

    /// True when this build's code signature is stable across rebuilds — a
    /// real identity via `LLMIDE_SIGN_IDENTITY`, or a local dev cert minted
    /// by `Scripts/make-dev-cert.sh` and recorded at `Scripts/.sign-identity`
    /// (see `Scripts/sign.sh`). False means `sign.sh` falls back to ad-hoc
    /// signing (`-`), which mints a fresh, content-derived identity on every
    /// rebuild — the confirmation dialog warns about that when this is false.
    var hasStableSignIdentity: Bool {
        if ProcessInfo.processInfo.environment["LLMIDE_SIGN_IDENTITY"]?.isEmpty == false {
            return true
        }
        guard let sourceRoot else { return false }
        let signIdentityFile = sourceRoot.appendingPathComponent("Scripts/.sign-identity").path
        return FileManager.default.fileExists(atPath: signIdentityFile)
    }

    /// Informational: the `LLMIDEFeatures` this bundle's Info.plist recorded
    /// at build time (`Scripts/build.sh`'s `LLMIDE_FEATURES`, or "all").
    /// Surfaced in the Settings card as "Built with: <csv|all>".
    let builtFeaturesRaw: String?
    private var stagedAppURL: URL?
    private var cachedToolchainAvailable: Bool?
    /// Full stdout/stderr history from the current `rebuild-features.sh` run,
    /// capped at 200 lines. `logTail` (published) mirrors just the last 20
    /// for display; a `.failed` message is built from `logTail`, which is
    /// always this buffer's own tail.
    private var logBuffer: [String] = []

    init(bundle: Bundle = .main) {
        let plistSourceRoot = bundle.object(forInfoDictionaryKey: "LLMIDESourceRoot") as? String
        self.sourceRoot = Self.detectSourceRoot(
            plistValue: plistSourceRoot,
            fileExists: FileManager.default.fileExists(atPath:)
        )
        self.installTarget = Self.detectInstallTarget(bundleURL: bundle.bundleURL)
        self.builtFeaturesRaw = bundle.object(forInfoDictionaryKey: "LLMIDEFeatures") as? String

        // A previous install attempt may have died mid-swap (rebuild-swap.sh
        // aborts before touching the running app, but the relaunched app has
        // no other way to learn why it's still the old build) — surface that
        // breadcrumb now, then consume it so it doesn't resurface on the
        // next launch too.
        let errorFile = AppIdentity.applicationSupportRoot()
            .appendingPathComponent("rebuild-staging", isDirectory: true)
            .appendingPathComponent("last-swap-error.txt")
        if let data = try? Data(contentsOf: errorFile),
           let reason = String(data: data, encoding: .utf8)?
               .trimmingCharacters(in: .whitespacesAndNewlines),
           !reason.isEmpty {
            try? FileManager.default.removeItem(at: errorFile)
            self.phase = .failed("Previous install attempt failed: \(reason)")
        }

        // Cheap but still a subprocess spawn, so it happens once,
        // asynchronously, off the critical init path — the card stays
        // hidden (isEligible false) until this resolves.
        Task { [weak self] in
            guard let self else { return }
            let available = await self.toolchainIsAvailable()
            await MainActor.run { self.toolchainAvailable = available }
        }
    }

    // MARK: - Pure helpers (unit-tested directly, no Process/Bundle touched)

    static func featureCSV(for features: Set<AppFeature>) -> String {
        features.map(\.rawValue).sorted().joined(separator: ",")
    }

    static func detectSourceRoot(plistValue: String?, fileExists: (String) -> Bool) -> URL? {
        guard let plistValue, !plistValue.isEmpty else { return nil }
        let root = URL(fileURLWithPath: plistValue)
        let packageSwift = root.appendingPathComponent("Package.swift").path
        guard fileExists(packageSwift) else { return nil }
        return root
    }

    static func detectInstallTarget(bundleURL: URL) -> URL? {
        guard bundleURL.pathExtension == "app" else { return nil }
        return bundleURL
    }

    /// True when the runtime feature set and this binary's compiled-in set
    /// disagree on any build-time-switchable feature — i.e. a rebuild would
    /// actually change what's compiled in, not just what's toggled at
    /// runtime.
    static func hasDrift(compiled: Set<AppFeature>, active: Set<AppFeature>) -> Bool {
        !active.symmetricDifference(compiled).intersection(AppFeature.buildTimeExcludable).isEmpty
    }

    // MARK: - Rebuild

    /// Wipes the staging dir, runs `rebuild-features.sh` for `desiredCSV`
    /// (staging is the script's only mode — swap is always a separate,
    /// later step), and streams its output into `logTail`. The actual
    /// `Process` work happens off the main thread (a detached `Task`);
    /// `phase`/`logTail` updates are hopped back onto the main actor.
    func startRebuild() {
        guard isEligible, let sourceRoot else { return }
        switch phase {
        case .idle, .failed: break
        case .building, .readyToSwap, .swapping: return
        }

        phase = .building
        logBuffer = []
        logTail = []
        stagedAppURL = nil

        let csv = desiredCSV
        let stageDir = AppIdentity.applicationSupportRoot()
            .appendingPathComponent("rebuild-staging", isDirectory: true)
        let scriptPath = sourceRoot.appendingPathComponent("Scripts/rebuild-features.sh").path

        Task.detached { [weak self] in
            guard let self else { return }

            let fm = FileManager.default
            try? fm.removeItem(at: stageDir)
            do {
                try fm.createDirectory(at: stageDir, withIntermediateDirectories: true)
            } catch {
                await MainActor.run {
                    self.phase = .failed("Could not prepare staging dir: \(error.localizedDescription)")
                }
                return
            }

            guard await self.toolchainIsAvailable() else {
                await MainActor.run {
                    self.phase = .failed("Xcode command line tools not found (xcrun --find swift).")
                }
                return
            }

            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/bin/bash")
            proc.arguments = [scriptPath, "--features", csv, "--stage-dir", stageDir.path]

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            proc.standardOutput = stdoutPipe
            proc.standardError = stderrPipe

            // Chunk boundaries from a readabilityHandler don't respect UTF-8
            // character or line boundaries — a multibyte character (or a
            // long line) can split across two callbacks. `LineSplitter`
            // buffers undecoded bytes across calls and only ever decodes
            // complete lines (split on the newline BYTE, 0x0A), so a split
            // character never gets silently dropped or mis-decoded; the
            // remainder is flushed once at the final drain below. Each pipe
            // gets its own splitter — stdout/stderr bytes must never mix.
            let stdoutSplitter = LineSplitter()
            let stderrSplitter = LineSplitter()

            func attach(_ handle: FileHandle, splitter: LineSplitter) {
                handle.readabilityHandler = { fh in
                    let data = fh.availableData
                    if data.isEmpty {
                        fh.readabilityHandler = nil
                        return
                    }
                    let lines = splitter.feed(data)
                    guard !lines.isEmpty else { return }
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        for line in lines { self.appendLogLine(line) }
                    }
                }
            }
            attach(stdoutPipe.fileHandleForReading, splitter: stdoutSplitter)
            attach(stderrPipe.fileHandleForReading, splitter: stderrSplitter)

            do {
                try proc.run()
            } catch {
                stdoutPipe.fileHandleForReading.readabilityHandler = nil
                stderrPipe.fileHandleForReading.readabilityHandler = nil
                await MainActor.run {
                    self.phase = .failed("Failed to launch rebuild-features.sh: \(error.localizedDescription)")
                }
                return
            }

            proc.waitUntilExit()

            // A readability handler is edge-triggered via GCD and can race
            // waitUntilExit(): the final chunk — often exactly the failure's
            // causal error line — can still be sitting in the pipe's kernel
            // buffer with no further callback ever firing once the process
            // has already exited. Stop async notifications FIRST, then drain
            // synchronously so nothing written right before exit is lost,
            // and do it before classifying the phase so a failure message
            // built from `logTail` includes that tail.
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            let remainingStdout = try? stdoutPipe.fileHandleForReading.readToEnd()
            let remainingStderr = try? stderrPipe.fileHandleForReading.readToEnd()
            let status = proc.terminationStatus

            // Final drain: feed whatever's left, then flush each splitter's
            // residual bytes even without a trailing newline — nothing more
            // is coming after this point.
            var finalLines = stdoutSplitter.feed(remainingStdout ?? Data())
            finalLines += stdoutSplitter.flush()
            finalLines += stderrSplitter.feed(remainingStderr ?? Data())
            finalLines += stderrSplitter.flush()

            await MainActor.run {
                for line in finalLines {
                    self.appendLogLine(line)
                }
                if status == 0 {
                    self.stagedAppURL = stageDir.appendingPathComponent("LlmIdeMac.app")
                    self.phase = .readyToSwap
                } else {
                    let tail = self.logTail.joined(separator: "\n")
                    self.phase = .failed(
                        tail.isEmpty ? "rebuild-features.sh exited with status \(status)" : tail
                    )
                }
            }
        }
    }

    /// Spawns `rebuild-swap.sh` detached (survives this process exiting),
    /// then quits — the swap helper waits for this pid, installs the staged
    /// bundle over `installTarget`, and relaunches it.
    ///
    /// Guarded against reentrancy: only fires from `.readyToSwap`, and flips
    /// to `.swapping` before spawning anything, so a second tap (e.g. a
    /// double-click, or `NSApp.terminate` taking a moment to actually quit)
    /// can never spawn a second `rebuild-swap.sh` racing the first.
    func swapAndRelaunch() {
        guard phase == .readyToSwap,
              let stagedAppURL,
              let installTarget,
              let sourceRoot
        else { return }

        phase = .swapping

        let scriptPath = sourceRoot.appendingPathComponent("Scripts/rebuild-swap.sh").path
        let pid = String(ProcessInfo.processInfo.processIdentifier)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/nohup")
        proc.arguments = ["bash", scriptPath, stagedAppURL.path, installTarget.path, pid]
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
        } catch {
            phase = .failed("Failed to launch swap helper: \(error.localizedDescription)")
            return
        }

        // NSApp.terminate(nil) below is a request, not a guarantee — if
        // something blocks quit (a stuck termination handler, a modal),
        // the app is left showing "Restarting…" forever while
        // rebuild-swap.sh waits on a pid that never dies. Surface that
        // instead of hanging silently; a no-op once the process really did
        // exit (nothing left to update).
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard let self, self.phase == .swapping else { return }
            self.phase = .failed("The app did not terminate; install aborted — see the rebuild log.")
        }

        NSApp.terminate(nil)
    }

    // MARK: - Private

    /// `xcrun --find swift` is cheap but still a subprocess spawn, so it's
    /// only run the first time it's needed (lazily, off the main thread) and
    /// cached for the life of this instance.
    private func toolchainIsAvailable() async -> Bool {
        if let cached = cachedToolchainAvailable { return cached }
        let available = await Task.detached(priority: .utility) { () -> Bool in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
            proc.arguments = ["--find", "swift"]
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            do {
                try proc.run()
                proc.waitUntilExit()
                return proc.terminationStatus == 0
            } catch {
                return false
            }
        }.value
        cachedToolchainAvailable = available
        return available
    }

    /// `rebuild-features.sh` and its children (`swift build`, `codesign`,
    /// etc.) may write ANSI color codes; strip them before a raw escape
    /// sequence ends up rendered literally in the Settings card's log view.
    private static func stripANSI(_ line: String) -> String {
        line.replacingOccurrences(
            of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression
        )
    }

    private func appendLogLine(_ line: String) {
        let stripped = Self.stripANSI(line)
        guard !stripped.isEmpty else { return }
        logBuffer.append(stripped)
        if logBuffer.count > 200 {
            logBuffer.removeFirst(logBuffer.count - 200)
        }
        logTail = Array(logBuffer.suffix(20))
    }
}

/// Buffers undecoded bytes across `FileHandle.readabilityHandler` callbacks
/// so a chunk boundary that lands mid-line — or mid-UTF-8-character — never
/// produces a dropped or garbled line. Not thread-safe by design: each
/// instance is fed only from one pipe's readability callbacks, which GCD
/// serializes against themselves, plus one final synchronous call at drain
/// time after that pipe's handler has been nil'd out.
private final class LineSplitter {
    private var residual = Data()

    /// Appends `data`, then returns every complete line (split on the
    /// newline BYTE, 0x0A, not a decoded `\n`) found so far. Undecoded bytes
    /// after the last newline stay buffered for the next call.
    func feed(_ data: Data) -> [String] {
        guard !data.isEmpty else { return [] }
        residual.append(data)
        var lines: [String] = []
        while let newlineIndex = residual.firstIndex(of: 0x0A) {
            let lineData = residual[residual.startIndex..<newlineIndex]
            if let text = String(data: lineData, encoding: .utf8) {
                lines.append(text)
            }
            residual.removeSubrange(residual.startIndex...newlineIndex)
        }
        return lines
    }

    /// Flushes any trailing bytes with no terminating newline — call once,
    /// only when no more data is coming (the process has exited and the
    /// pipe has been fully drained).
    func flush() -> [String] {
        guard !residual.isEmpty else { return [] }
        defer { residual.removeAll() }
        guard let text = String(data: residual, encoding: .utf8) else { return [] }
        return [text]
    }
}
