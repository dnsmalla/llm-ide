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
        await engine.runningLegacyTool { await runBashCommandBody(args) }
    }

    private func runBashCommandBody(_ args: BashArgs) async {
        // Pin the chat this command belongs to. `self.engine` is the panel's
        // CURRENT engine: switching chats while the command ran made the
        // result (and its forced follow-up turn) land in the other chat, and
        // the proposing agent never got its answer.
        let engine = self.engine
        let sessionID = engine.currentSessionIDString

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

        let directory: URL
        switch ChatBashDirectory.resolve(args.workingDirectory, repoRoot: activeRepoRoot) {
        case .success(let url):
            directory = url
        case .failure(let refusal):
            let payload = ChatMessage.ToolResultPayload(
                kind: .bash,
                summary: "(bash \(refusal.message))",
                exitCode: nil, command: nil,
                output: refusal.message,
                url: nil, isFailure: true
            )
            await engine.acknowledge(payload, followUp: .forceUnblock)
            return
        }

        let result = await bashService.execute(args.command, workingDirectory: directory.path)
        // The engine itself may have been re-pointed at another session.
        guard engine.currentSessionIDString == sessionID else {
            engine.logDroppedLegacyResult("bash")
            return
        }

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
