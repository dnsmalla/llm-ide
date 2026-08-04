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

        // Format the result for the chat
        let output: String
        if result.isSuccess {
            if result.output.isEmpty {
                output = "(bash completed successfully - no output)"
            } else {
                output = "(bash result - exit code: \(result.exitCode))\n\(result.output)"
            }
        } else {
            output = "(bash failed - exit code: \(result.exitCode))\n\(result.output)"
        }

        history.append(.init(role: .user, content: output))
        await sendFollowup()
    }
}
