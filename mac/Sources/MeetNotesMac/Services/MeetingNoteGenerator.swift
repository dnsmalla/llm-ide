import Foundation
import os.log

/// Generates a filled `.docx` meeting note from an AI summary.
///
/// Delegates to the bundled Python script (`generate_meeting_note.py`)
/// which manipulates `note_template.docx` via stdlib zipfile + regex so
/// no third-party pip packages are required.
///
/// All methods are `static` (no state) and safe to call from a background
/// `Task.detached` context.
enum MeetingNoteGenerator {

    private static let log = Logger(
        subsystem: "com.meetnotes.macapp",
        category: "NoteGen")

    /// Locate python3 — try the user's PATH first (covers conda, pyenv,
    /// nix, asdf, etc.) and fall back to well-known system locations.
    private static func findPython3() -> String {
        // `which` respects the user's PATH even when launched from an app
        // bundle, because macOS inherits the login shell's PATH via
        // launchd. This handles virtual envs and version managers that
        // the hardcoded list below would miss.
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        which.arguments = ["python3"]
        which.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = FileHandle.nullDevice
        if let _ = try? which.run() {
            which.waitUntilExit()
            if which.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let path = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !path.isEmpty && FileManager.default.isExecutableFile(atPath: path) {
                    return path
                }
            }
        }
        return ["/usr/bin/python3", "/usr/local/bin/python3",
                "/opt/homebrew/bin/python3"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
            ?? "/usr/bin/python3"
    }

    /// Write a `.docx` note to `outputURL` using the bundled template.
    ///
    /// - Parameters:
    ///   - summary:    AI-generated meeting summary.
    ///   - title:      Human-readable meeting title.
    ///   - startedAt:  Meeting start timestamp (drives date fields).
    ///   - participants: Ordered list of participant names.
    ///   - outputURL:  Destination path for the generated `.docx`.
    ///
    /// Fails silently — logs errors to Console.app and returns without
    /// throwing so the caller's raw transcript file is always preserved.
    static func generateDocx(
        summary: MeetingSummary,
        title: String,
        startedAt: Date,
        participants: [String],
        outputURL: URL
    ) {
        guard
            let scriptURL   = Bundle.main.url(forResource: "generate_meeting_note", withExtension: "py"),
            let templateURL = Bundle.main.url(forResource: "note_template", withExtension: "docx")
        else {
            log.error("bundled resources not found — skipping .docx generation")
            return
        }

        // Build the JSON payload matching generate_meeting_note.py's schema.
        let todos: [[String: String]] = summary.actions.map { action in
            var t: [String: String] = ["task": action.text]
            if let o = action.owner { t["owner"] = o }
            if let d = action.due   { t["due"]   = d }
            return t
        }
        let qa: [[String: String]] = summary.blockers.map {
            ["q": $0.text, "a": ""]
        }
        let payload: [String: Any] = [
            "title":        title,
            "date":         AppDateFormatter.absoluteMedium(startedAt),
            "date_created": AppDateFormatter.dateOnlyLocal(startedAt),
            "participants": participants,
            "decisions":    summary.decisions.map { $0.text },
            "todos":        todos,
            "content":      summary.full.isEmpty ? summary.gist : summary.full,
            "agenda":       summary.tldr,
            "qa":           qa,
        ]

        guard
            let jsonData   = try? JSONSerialization.data(withJSONObject: payload),
            let jsonString = String(data: jsonData, encoding: .utf8)
        else {
            log.error("failed to serialise payload JSON — skipping .docx generation")
            return
        }

        let python = Self.findPython3()

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: python)
        proc.arguments = [
            scriptURL.path,
            templateURL.path,
            outputURL.path,
            jsonString,
        ]
        // Redirect stdin to /dev/null so the Python script never blocks
        // waiting for input from the app's inherited file descriptor.
        proc.standardInput = FileHandle.nullDevice
        // Drain stdout to /dev/null — unread pipe buffers deadlock waitUntilExit().
        proc.standardOutput = FileHandle.nullDevice
        // Capture stderr so errors appear in Console.app under the NoteGen category.
        let errPipe = Pipe()
        proc.standardError = errPipe

        do {
            try proc.run()

            // Wait up to 60 s — enough for any realistic template + content
            // size. If the script still hasn't exited, kill it and log.
            let deadline = DispatchTime.now() + .seconds(60)
            let timedOut = DispatchSemaphore(value: 0)
            proc.terminationHandler = { _ in timedOut.signal() }
            if timedOut.wait(timeout: deadline) == .timedOut {
                proc.terminate()
                log.error("python script timed out after 60 s — killed")
                return
            }

            if proc.terminationStatus != 0 {
                let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                let msg = String(data: errData, encoding: .utf8) ?? "(no stderr)"
                log.error("python script failed (status \(proc.terminationStatus, privacy: .public)): \(msg, privacy: .public)")
            } else {
                log.info(".docx written → \(outputURL.path, privacy: .public)")
            }
        } catch {
            log.error("failed to launch python: \(error.localizedDescription, privacy: .public)")
        }
    }
}
