import SwiftUI

extension CodeAssistantPanel {
    // MARK: - Bash Execution

    /// Execute a bash command and return the result to the chat.
    ///
    /// Reached two ways: the user tapping the pending-action card (`busy` is
    /// false), and `autoChainPendingAction` in Bypass mode (`busy` is TRUE,
    /// because we're still inside the turn that proposed the command). Both
    /// finish through `acknowledge(_:followUp: .forceUnblock)` — `.ifIdle`
    /// (plain `sendFollowup()`) would hit its own `guard !busy` and silently
    /// drop the output on the auto path, ending the turn with no conclusion.
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
            // Fields mirror what `ToolResultPayload.legacyContent()` needs to
            // reconstruct the exact legacy wire text for the "blocked" case
            // (see its doc comment): `output` is the message with the leading
            // "(bash " and trailing ")" already stripped, NOT the full
            // wrapped string — pinned by
            // `ChatEngineMessageTests.blockedBashIsNotDoubleWrapped`.
            let payload = ChatMessage.ToolResultPayload(
                kind: .bash,
                summary: "(bash blocked - command contains potentially dangerous operations)",
                exitCode: nil, command: nil,
                output: "blocked - command contains potentially dangerous operations",
                url: nil, isFailure: true
            )
            await engine.acknowledge(payload, followUp: .forceUnblock)
            return
        }

        let result = await bashService.execute(args.command, workingDirectory: args.workingDirectory)

        // The header line always carries the exit code so success and failure
        // render consistently; `command` is collapsed to a single line for
        // display only (a multi-line/heredoc command must still render on one
        // "$ ..." line) — the actual command executed above is unaffected.
        let body = result.output.isEmpty ? "(no output)" : result.output
        let displayCommand = args.command.replacingOccurrences(of: "\n", with: " ⏎ ")
        let payload = ChatMessage.ToolResultPayload(
            kind: .bash,
            summary: result.isSuccess
                ? "(bash result - exit code: \(result.exitCode))"
                : "(bash failed - exit code: \(result.exitCode))",
            exitCode: Int(result.exitCode),
            command: displayCommand,
            output: body,
            url: nil,
            isFailure: !result.isSuccess
        )
        await engine.acknowledge(payload, followUp: .forceUnblock)
    }
}
