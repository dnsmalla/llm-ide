import Foundation

/// Bash/code execution service for running shell commands locally
final class BashService: Sendable {

    struct ExecutionResult: Sendable {
        let exitCode: Int32
        let stdout: String
        let stderr: String
        let duration: TimeInterval

        var isSuccess: Bool { exitCode == 0 }
        var output: String {
            if !stderr.isEmpty && !stdout.isEmpty {
                return "STDOUT:\n\(stdout)\n\nSTDERR:\n\(stderr)"
            } else if !stderr.isEmpty {
                return "STDERR:\n\(stderr)"
            } else {
                return stdout
            }
        }
    }

    /// Execute a shell command and return the result
    @MainActor
    func execute(_ command: String, workingDirectory: String? = nil) async -> ExecutionResult {
        let startTime = Date()

        // Create process
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-c", command]

        // Set working directory if provided
        if let workingDir = workingDirectory {
            process.currentDirectoryURL = URL(fileURLWithPath: workingDir)
        }

        // Create pipes for output
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        // Run process
        do {
            try process.run()
            process.waitUntilExit()

            // Read output
            let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()

            let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
            let stderr = String(data: stderrData, encoding: .utf8) ?? ""

            let duration = Date().timeIntervalSince(startTime)

            return ExecutionResult(
                exitCode: process.terminationStatus,
                stdout: stdout,
                stderr: stderr,
                duration: duration
            )
        } catch {
            let duration = Date().timeIntervalSince(startTime)
            return ExecutionResult(
                exitCode: -1,
                stdout: "",
                stderr: error.localizedDescription,
                duration: duration
            )
        }
    }

    /// Execute multiple commands in sequence (like a script)
    @MainActor
    func executeScript(_ commands: [String], workingDirectory: String? = nil) async -> [ExecutionResult] {
        var results: [ExecutionResult] = []

        for command in commands {
            let result = await execute(command, workingDirectory: workingDirectory)
            results.append(result)

            // Stop on first error
            if !result.isSuccess {
                break
            }
        }

        return results
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
