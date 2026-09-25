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
            argsBody
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
            Image(systemName: Self.icon(toolName: state.approval.toolName))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(Self.title(toolName: state.approval.toolName))
                .font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 0)
        }
    }

    /// Delegating shims: the per-SDK-tool wording (which names exist, what
    /// they mean to a user) is Claude-linker knowledge — see
    /// `ClaudeLink/ClaudeToolPresentation.swift`. Pure so they stay
    /// unit-testable without standing up the view.
    static func title(toolName: String?) -> String {
        ClaudeToolPresentation.approvalTitle(toolName: toolName)
    }

    static func icon(toolName: String?) -> String {
        ClaudeToolPresentation.approvalIcon(toolName: toolName)
    }

    /// Per-tool rendering of `state.approval.args` (Task 5's structured
    /// payload) when the server sent it, falling back to the plain
    /// `argsSummary` text an older server would have sent instead — the
    /// same back-compat contract `AgentV2Approval.args` decodes under.
    @ViewBuilder
    private var argsBody: some View {
        if let args = state.approval.args {
            structuredArgsBody(args)
        } else if let summary = state.approval.argsSummary, !summary.isEmpty {
            Text(summary)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func structuredArgsBody(_ args: AgentV2ApprovalArgs) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if args.oldString != nil || args.newString != nil {
                editDiffBody(args)
            } else if let preview = args.contentPreview {
                writePreviewBody(args, preview: preview)
            } else if let command = args.command {
                Text(command)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if args.truncated == true {
                Text("(preview truncated)")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Edit is an exact-string replacement, so the old/new strings ARE the
    /// diff — no line-level diff algorithm is needed, just two labeled
    /// blocks in the tool's before/after colors.
    private func editDiffBody(_ args: AgentV2ApprovalArgs) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let filePath = args.filePath {
                Text(filePath)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    if let oldString = args.oldString {
                        diffBlock(caption: "− removed", text: oldString, background: Color.red.opacity(0.12))
                    }
                    if let newString = args.newString {
                        diffBlock(caption: "+ replacement", text: newString, background: Color.green.opacity(0.12))
                    }
                }
            }
            .frame(maxHeight: 220)
            // A global replace touches EVERY occurrence, not just the one
            // shown above — call that out so approving isn't mistaken for a
            // single-site edit (final whole-branch review, I4).
            if args.replaceAll == true {
                Text("Replaces ALL occurrences")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.orange)
            }
        }
    }

    private func writePreviewBody(_ args: AgentV2ApprovalArgs, preview: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let filePath = args.filePath {
                Text(filePath)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            ScrollView {
                Text(preview)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 220)
            // A write that overwrites an existing file is a strictly more
            // dangerous case than creating a new one — say so instead of the
            // same neutral caption either way (final whole-branch review, I5).
            Text(args.exists == true
                 ? "Overwriting existing file · \(args.totalChars ?? 0) chars"
                 : "New file content · \(args.totalChars ?? 0) chars")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
    }

    private func diffBlock(caption: String, text: String, background: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(caption)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 4).fill(background))
        }
    }

    private func errorHint(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(Color.orange)
            // `isExpired` means the requestId is permanently gone server-side
            // (see AgentV2ApprovalState) — the buttons are disabled and no
            // retry can succeed, so don't promise one. Otherwise a failed
            // submit KEEPS the card up with the same three actions to retry.
            Text(state.isExpired ? message : "\(message) Choose again to retry.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Buttons lock on `submitted` (answered) AND `isExpired` (the server
    /// registry entry is gone — `submitToolDecision` would no-op anyway, and
    /// an enabled button that silently does nothing reads as a frozen app).
    private var actionsDisabled: Bool {
        state.submitted || state.isExpired || state.isSubmitting
    }

    /// Claude Code's three answers: "Yes", "Yes, and don't ask again for
    /// <rule>", "No, and tell it what to do instead". The middle one appears
    /// only when the server offered a rule (`suggestion`) — a compound
    /// command can't be generalised safely, so it is "once" or nothing.
    @ViewBuilder
    private var actionRow: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button(state.submitted ? "Allowed" : "Allow Once") { Task { await onDecide("allow") } }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .keyboardShortcut(.defaultAction)
                    .disabled(actionsDisabled)
                if let label = Self.alwaysAllowLabel(suggestion: state.approval.suggestion) {
                    // LocalizedStringKey so the `pattern` renders as code,
                    // not as literal backticks (a plain String is shown verbatim).
                    Button(LocalizedStringKey(label)) { Task { await onDecide("always-allow") } }
                        .controlSize(.small)
                        .disabled(actionsDisabled)
                        .help(Self.alwaysAllowHelp(suggestion: state.approval.suggestion))
                }
                Button(state.submitted ? "Denied" : "Deny") { Task { await onDecide("deny") } }
                    .controlSize(.small)
                    .disabled(actionsDisabled)
                if state.isExpired {
                    Text("Expired")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
            }
            TextField("Or tell it what to do instead, then Deny (optional)", text: $state.denyFeedback)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11))
                .disabled(actionsDisabled)
                .onSubmit {
                    guard !state.denyFeedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    Task { await onDecide("deny") }
                }
        }
    }

    /// The "don't ask again" button's title, from the rule the server
    /// offered; nil hides the button.
    static func alwaysAllowLabel(suggestion: AgentV2ApprovalSuggestion?) -> String? {
        ClaudeToolPresentation.alwaysAllowLabel(suggestion: suggestion)
    }

    /// Says exactly what is being granted, and where — the card shows ONE
    /// call, the rule covers more.
    static func alwaysAllowHelp(suggestion: AgentV2ApprovalSuggestion?) -> String {
        guard let s = suggestion else { return "" }
        if s.scope == "session" {
            return "Stop asking about file edits for the rest of this chat. Other chats still ask."
        }
        let what = (s.pattern?.isEmpty == false) ? "`\(s.pattern!)` commands" : (s.toolName ?? "this tool")
        return "Stop asking for \(what) in this project. Other projects still ask. "
            + "Revoke it in Settings → Tool permissions."
    }
}
