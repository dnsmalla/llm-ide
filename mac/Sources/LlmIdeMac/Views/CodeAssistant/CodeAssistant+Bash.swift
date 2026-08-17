import SwiftUI

extension CodeAssistantPanel {
    // MARK: - Bash Execution

    /// Execute a bash command and return the result to the chat.
    ///
    /// Reached two ways: the user tapping the pending-action card (`busy` is
    /// false), and `autoChainPendingAction` in Bypass mode (`busy` is TRUE,
    /// because we're still inside the turn that proposed the command). Both
    /// finish through `unblockAndFollowUp()` — a plain `sendFollowup()` would
    /// hit its own `guard !busy` and silently drop the output on the auto path,
    /// ending the turn with no conclusion.
    @MainActor
    func runBashCommand(_ args: BashArgs?) async {
        guard let args = args else { return }

        let bashService = BashService()
        // Drop the card as soon as we commit to running: it's no longer
        // actionable, and leaving it up invites a second tap that would run the
        // same command again.
        engine.agent.pendingTool = nil

        // Validate the command first
        guard bashService.validateCommand(args.command) else {
            let blocked = "(bash blocked - command contains potentially dangerous operations)"
            // `ToolResultPayload.parse` owns the "blocked" single-line special
            // case (no exit code, no command, the header IS the whole
            // message) — reused here rather than hand-building the payload so
            // there is exactly one place that knows that shape.
            if let payload = ChatMessage.ToolResultPayload.parse(content: blocked) {
                await engine.acknowledge(payload, followUp: true)
            }
            return
        }

        let result = await bashService.execute(args.command, workingDirectory: args.workingDirectory)

        // Format the result for the chat. The header line always carries the
        // exit code so success and failure render consistently; the command
        // line lets the view show "$ <command>" without needing a second,
        // id-keyed channel.
        let header = result.isSuccess
            ? "(bash result - exit code: \(result.exitCode))"
            : "(bash failed - exit code: \(result.exitCode))"
        let body = result.output.isEmpty ? "(no output)" : result.output
        // Collapse embedded newlines for display only — a multi-line/heredoc
        // command must still render on a single "$ ..." line, or the parser
        // reading this format back out (line 2 = command, everything after =
        // output) would silently swallow the command's later lines into what
        // looks like real stdout. The actual command executed above is
        // unaffected — this only touches what's shown in the chat.
        let displayCommand = args.command.replacingOccurrences(of: "\n", with: " ⏎ ")
        let output = "\(header)\n$ \(displayCommand)\n\(body)"

        // Same reasoning as the blocked branch above: `parse` is the one place
        // that knows how to split header/command/output, so it builds the
        // payload rather than this call site re-deriving the same fields.
        if let payload = ChatMessage.ToolResultPayload.parse(content: output) {
            await engine.acknowledge(payload, followUp: true)
        }
    }
}
