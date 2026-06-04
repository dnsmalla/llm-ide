import Foundation
import Observation
import SwiftTerm
import AppKit

/// One PTY-backed shell session — owns a `LocalProcessTerminalView` for
/// the lifetime of the tab.  Created by `TerminalPanelState.addTab()`.
@Observable
@MainActor
final class TerminalSession: NSObject {

    // MARK: - State

    let id = UUID()
    var title: String
    var status: SessionStatus = .running
    var workingDirectory: URL
    private(set) var termView: LocalProcessTerminalView?
    private(set) var spawnError: String?
    /// Weak-unsafe copy used only in `deinit` (which is nonisolated).
    /// Assigned once on the main actor when the PTY starts; read only after
    /// all main-actor references are gone, so no concurrent mutation is possible.
    private nonisolated(unsafe) var termViewForDeinit: LocalProcessTerminalView?

    enum SessionStatus { case running, dead }

    // MARK: - Init

    init(number: Int, workingDirectory: URL) {
        self.title = "zsh \(number)"
        self.workingDirectory = workingDirectory
    }

    // MARK: - Lifecycle

    /// Spawn the PTY. Called once from `TerminalSessionView.makeNSView`.
    func start() {
        let shellPath: String
        if FileManager.default.fileExists(atPath: "/bin/zsh") {
            shellPath = "/bin/zsh"
        } else if FileManager.default.fileExists(atPath: "/bin/bash") {
            shellPath = "/bin/bash"
        } else {
            spawnError = "Shell not found. Check /bin/zsh or /bin/bash."
            status = .dead
            return
        }

        // Give the terminal a non-zero initial frame so SwiftTerm calculates
        // a sensible initial PTY size (cols/rows). Programs like vim and htop
        // read the terminal size at startup; a 0×0 frame causes them to
        // render incorrectly on first open.
        let tv = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
        tv.processDelegate = self

        // Curated environment — passes only the variables a user shell needs.
        // Inheriting nil (the parent env) would leak server secrets such as
        // ANTHROPIC_API_KEY, JWT_SECRET, and database paths into every tab.
        let env = Self.shellEnvironment()

        tv.startProcess(
            executable: shellPath,
            args: ["--login"],
            environment: env,
            execName: URL(fileURLWithPath: shellPath).lastPathComponent,
            currentDirectory: workingDirectory.path
        )

        self.termView = tv
        self.termViewForDeinit = tv
        self.status = .running
    }

    /// Send SIGHUP to cleanly stop the shell.
    /// Call before removing the session from `TerminalPanelState.sessions`.
    func terminate() {
        guard status == .running else { return }
        termView?.terminate()
        status = .dead
    }

    // MARK: - deinit

    deinit {
        // If the session is released while the shell is still running
        // (e.g., app quit without closing tabs), ensure the PTY is stopped
        // so we don't leave orphaned processes behind.
        termViewForDeinit?.terminate()
    }

    // MARK: - Private helpers

    /// Build a curated shell environment, excluding any server-injected secrets.
    /// Only variables a login shell legitimately needs are forwarded.
    private static func shellEnvironment() -> [String] {
        let keys: [String] = [
            "HOME", "USER", "LOGNAME", "SHELL",
            "PATH", "TMPDIR", "TERM",
            "LANG", "LC_ALL", "LC_CTYPE",
            "XDG_CONFIG_HOME", "XDG_DATA_HOME",
            "COLORTERM", "TERM_PROGRAM",
        ]
        // Default TERM so colour-capable programs work out of the box.
        var env: [String: String] = ["TERM": "xterm-256color", "COLORTERM": "truecolor"]
        let processEnv = ProcessInfo.processInfo.environment
        for key in keys {
            if let value = processEnv[key] {
                env[key] = value
            }
        }
        return env.map { "\($0.key)=\($0.value)" }
    }
}

// MARK: - LocalProcessTerminalViewDelegate

extension TerminalSession: LocalProcessTerminalViewDelegate {

    nonisolated func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {
        // SwiftTerm handles PTY TIOCSWINSZ internally; nothing extra needed.
    }

    nonisolated func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
        guard !title.isEmpty else { return }
        let newTitle = title
        Task { @MainActor [weak self] in
            self?.title = newTitle
        }
    }

    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
        guard let dir = directory, !dir.isEmpty else { return }
        let url = URL(fileURLWithPath: dir)
        Task { @MainActor [weak self] in
            self?.workingDirectory = url
        }
    }

    nonisolated func processTerminated(source: TerminalView, exitCode: Int32?) {
        Task { @MainActor [weak self] in
            self?.title = "[exited]"
            self?.status = .dead
        }
    }
}
