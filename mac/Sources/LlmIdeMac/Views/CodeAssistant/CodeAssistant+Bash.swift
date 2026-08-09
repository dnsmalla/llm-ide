import SwiftUI

extension CodeAssistantPanel {
    // MARK: - Bash Execution

    /// Execute a bash command and return the result to the chat
    @MainActor
    func runBashCommand(_ args: BashArgs?) async {
        guard let args = args else { return }

        let bashService = BashService()

        // Validate the command first
        guard bashService.validateCommand(args.command) else {
            history.append(.init(
                role: .user,
                content: "(bash blocked - command contains potentially dangerous operations)"
            ))
            await sendFollowup()
            return
        }

        let result = await bashService.execute(args.command, workingDirectory: args.workingDirectory)

        // Format the result for the chat. The header line (parsed back out by
        // CommandOutputView.parse) always carries the exit code so success and
        // failure render consistently; the command line lets the view show
        // "$ <command>" without needing a second, id-keyed channel.
        let header = result.isSuccess
            ? "(bash result - exit code: \(result.exitCode))"
            : "(bash failed - exit code: \(result.exitCode))"
        let body = result.output.isEmpty ? "(no output)" : result.output
        // Collapse embedded newlines for display only — a multi-line/heredoc
        // command must still render on a single "$ ..." line, or a future
        // parser reading this format back out (line 2 = command, everything
        // after = output) would silently swallow the command's later lines
        // into what looks like real stdout. The actual command executed
        // above is unaffected — this only touches what's shown in the chat.
        let displayCommand = args.command.replacingOccurrences(of: "\n", with: " ⏎ ")
        let output = "\(header)\n$ \(displayCommand)\n\(body)"

        history.append(.init(role: .user, content: output))
        await sendFollowup()
    }
}
