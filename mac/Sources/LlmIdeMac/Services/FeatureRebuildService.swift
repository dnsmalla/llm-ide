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
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    /// Last ~20 stdout/stderr lines from `rebuild-features.sh`, in order.
    @Published private(set) var logTail: [String] = []

    /// Nil when this Mac can't rebuild (no checkout at the recorded path, or
    /// this bundle wasn't built with `LLMIDESourceRoot` set at all — e.g. a
    /// distributed release). Non-nil = the `mac/` directory of the checkout.
    let sourceRoot: URL?
    /// The `.app` bundle to replace (`Bundle.main.bundleURL` when it ends in
    /// `.app`; nil for a bare executable, e.g. under `swift run`).
    let installTarget: URL?

    var isEligible: Bool { sourceRoot != nil && installTarget != nil }

    /// Features this binary was compiled with vs what's active now — drives
    /// the "drift" hint in Settings. Read live off `FeatureRegistry.shared`
    /// rather than snapshotted at init, so it stays current as the user
    /// toggles features.
    var compiledSet: Set<AppFeature> { FeatureRegistry.shared.compiledFeatures }
    /// `FeatureRegistry.shared.activeFeatures` as the CSV `rebuild-features.sh` expects.
    var desiredCSV: String { Self.featureCSV(for: FeatureRegistry.shared.activeFeatures) }

    /// Features whose build-time inclusion is switchable at all — mirrors
    /// Package.swift's `includedFeatures` key list (the env-gated set;
    /// everything else is always compiled in). Only these can ever differ
    /// between `compiledSet` and the runtime `activeFeatures`, so drift
    /// detection is scoped to this set.
    static let buildTimeExcludable: Set<AppFeature> = [
        .codeGraph3D, .fileExplorer, .ganttIssues, .docGen, .terminal,
    ]

    /// Informational: the `LLMIDEFeatures` this bundle's Info.plist recorded
    /// at build time (`Scripts/build.sh`'s `LLMIDE_FEATURES`, or "all").
    private let builtFeaturesRaw: String?
    private var stagedAppURL: URL?
    private var cachedToolchainAvailable: Bool?

    init(bundle: Bundle = .main) {
        let plistSourceRoot = bundle.object(forInfoDictionaryKey: "LLMIDESourceRoot") as? String
        self.sourceRoot = Self.detectSourceRoot(
            plistValue: plistSourceRoot,
            fileExists: FileManager.default.fileExists(atPath:)
        )
        self.installTarget = Self.detectInstallTarget(bundleURL: bundle.bundleURL)
        self.builtFeaturesRaw = bundle.object(forInfoDictionaryKey: "LLMIDEFeatures") as? String
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
        !active.symmetricDifference(compiled).intersection(buildTimeExcludable).isEmpty
    }

    // MARK: - Rebuild

    /// Wipes the staging dir, runs `rebuild-features.sh --stage-only` for
    /// `desiredCSV`, and streams its output into `logTail`. The actual
    /// `Process` work happens off the main thread (a detached `Task`);
    /// `phase`/`logTail` updates are hopped back onto the main actor.
    func startRebuild() {
        guard isEligible, let sourceRoot else { return }
        switch phase {
        case .idle, .failed: break
        case .building, .readyToSwap: return
        }

        phase = .building
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
            proc.arguments = [scriptPath, "--features", csv, "--stage-dir", stageDir.path, "--stage-only"]

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            proc.standardOutput = stdoutPipe
            proc.standardError = stderrPipe

            func attach(_ handle: FileHandle) {
                handle.readabilityHandler = { fh in
                    let data = fh.availableData
                    if data.isEmpty {
                        fh.readabilityHandler = nil
                        return
                    }
                    guard let text = String(data: data, encoding: .utf8) else { return }
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
                            self.appendLogLine(String(line))
                        }
                    }
                }
            }
            attach(stdoutPipe.fileHandleForReading)
            attach(stderrPipe.fileHandleForReading)

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
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            let status = proc.terminationStatus

            await MainActor.run {
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
    func swapAndRelaunch() {
        guard case .readyToSwap = phase,
              let stagedAppURL,
              let installTarget,
              let sourceRoot
        else { return }

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

    private func appendLogLine(_ line: String) {
        guard !line.isEmpty else { return }
        logTail.append(line)
        if logTail.count > 20 {
            logTail.removeFirst(logTail.count - 20)
        }
    }
}
