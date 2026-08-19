import SwiftUI

/// Interactive card for a parked act-tool approval (`kind == "ToolApproval"`)
/// — the run-bash gate's 'prompt' tier, on EITHER chat engine (the v2
/// Agent-SDK engine's `canUseTool`, or the legacy engine's gated
/// `run-bash` registry entry). Sibling to `ApprovalQuestionCard`
/// (`kind == "AskUserQuestion"`): same placement (under the last assistant
/// message, keyed by `requestId`), same styling, but three fixed actions
/// instead of a question form — there is nothing to select, only whether to
/// let the command run.
struct ToolApprovalCard: View {
    let state: AgentV2ApprovalState
    /// Posts the user's decision — wired to `ChatEngine.submitToolDecision(action:)`.
    /// `action` is one of "deny" | "allow" | "always-allow" (the server's
    /// `answerDecision` action vocabulary — see `sdk/decisions.mjs`).
    let onDecide: (_ action: String) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if let summary = state.approval.argsSummary, !summary.isEmpty {
                Text(summary)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = state.lastError {
                errorHint(error)
            }
            actionRow
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor.opacity(0.4), lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "terminal.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text("Run \(state.approval.toolName ?? "tool")")
                .font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 0)
        }
    }

    private func errorHint(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(Color.orange)
            // A failed submit KEEPS the card up (see AgentV2ApprovalState),
            // so the same three actions are still there to retry.
            Text("\(message) Choose again to retry.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var actionRow: some View {
        HStack(spacing: 8) {
            Button(state.submitted ? "Denied" : "Deny") { Task { await onDecide("deny") } }
                .controlSize(.small)
                .disabled(state.submitted)
            Button(state.submitted ? "Allowed" : "Allow Once") { Task { await onDecide("allow") } }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(state.submitted)
            Button("Always Allow") { Task { await onDecide("always-allow") } }
                .controlSize(.small)
                .disabled(state.submitted)
            Spacer(minLength: 0)
        }
    }
}
