import Foundation
import Observation
import os

/// Detects and (on request) installs `rtk` (https://github.com/rtk-ai/rtk),
/// which cuts the tokens Claude Code spends on shell output.
///
/// Installs the binary only — never registers rtk's Claude Code hook. That
/// hook answers `permissionDecision: allow` for every command it rewrites
/// (`git push --force` included), so enabling it is left to the user.
@MainActor
enum RtkProvisioner {
    /// Install progress the Settings view can OBSERVE. App-wide, not view
    /// state: the Settings view is rebuilt on section switch, and a second
    /// `brew install` would fail on brew's lock. This used to be a plain
    /// static Bool, which SwiftUI cannot track — leaving Settings mid-install
    /// and coming back showed an enabled Install button, no spinner, and a
    /// stale "Not installed" after the install finished.
    @MainActor
    @Observable
    final class InstallState {
        fileprivate(set) var isInstalling = false
        /// Outcome of the most recent install, so a view built after it
        /// finished can still show the message.
        fileprivate(set) var lastResult: InstallResult?
        /// Bumped when an install finishes; views re-read `status()` on change.
        fileprivate(set) var completedInstalls = 0
    }

    static let installState = InstallState()

    static var isInstalling: Bool { installState.isInstalling }

    enum Status: Equatable {
        case installed(version: String)
        case notInstalled(canInstall: Bool)
    }

    struct InstallResult: Equatable {
        let ok: Bool
        let message: String
    }

    private static let log = Logger(subsystem: "com.llmide.macapp", category: "RtkProvisioner")
    private static let bash = BashService()
    private static let installTimeout: TimeInterval = 300

    // A Finder-launched app inherits a minimal PATH without Homebrew, so look
    // at the standard install locations directly.
    private static var rtkCandidates: [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        // ~/.cargo/bin: rtk is also distributed via `cargo install`.
        return ["\(home)/.local/bin/rtk", "\(home)/.cargo/bin/rtk",
                "/opt/homebrew/bin/rtk", "/usr/local/bin/rtk"]
    }
    private static let brewCandidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]

    static func status() async -> Status {
        if let rtk = firstExecutable(rtkCandidates) {
            let result = await bash.execute("'\(rtk)' --version")
            var version = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            if version.hasPrefix("rtk ") { version.removeFirst(4) }
            return .installed(version: version.isEmpty ? "unknown version" : version)
        }
        return .notInstalled(canInstall: firstExecutable(brewCandidates) != nil)
    }

    static func install() async -> InstallResult {
        guard !installState.isInstalling else {
            return InstallResult(ok: false, message: "An install is already running.")
        }
        installState.isInstalling = true
        installState.lastResult = nil
        let result = await runBrewInstall()
        installState.lastResult = result
        installState.isInstalling = false
        installState.completedInstalls += 1
        return result
    }

    private static func runBrewInstall() async -> InstallResult {
        guard let brew = firstExecutable(brewCandidates) else {
            return InstallResult(ok: false, message: "Homebrew isn't installed. Install it from brew.sh, then try again.")
        }
        // HOMEBREW_NO_AUTO_UPDATE: brew's implicit `brew update` before an
        // install can take minutes on its own and eat the whole timeout for a
        // single-formula install the user is watching a spinner for.
        let result = await bash.execute("HOMEBREW_NO_AUTO_UPDATE=1 '\(brew)' install rtk",
                                        timeout: installTimeout)
        if result.isSuccess {
            log.info("rtk installed via brew")
            return InstallResult(ok: true, message: "rtk installed.")
        }
        let detail = (result.stderr.isEmpty ? result.stdout : result.stderr)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        log.error("brew install rtk failed: \(detail, privacy: .public)")
        let reason = result.timedOut ? "timed out" : String(detail.suffix(400))
        return InstallResult(ok: false, message: "brew install rtk failed: \(reason)")
    }

    private static func firstExecutable(_ paths: [String]) -> String? {
        paths.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}
