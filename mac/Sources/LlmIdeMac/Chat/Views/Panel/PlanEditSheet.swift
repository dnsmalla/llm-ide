import SwiftUI

/// The plan the "Edit" action opened for hand-editing, identified by the
/// assistant message it came from. Carried on `CodeAssistantSheetState` so the
/// sheet is driven by `.sheet(item:)` — a nil target IS the dismissed state,
/// so a stale draft can never be re-presented against a different message.
struct PlanEditTarget: Identifiable, Equatable {
    /// The v2 assistant RESULT message the plan text came from. The
    /// `planSaved` flag is written back on THIS id, so the Save/Edit/Refine
    /// row retires for the same message the user acted on.
    let messageId: UUID
    /// Title derived from the reply (`CodeAssistantPanel.planTitle(from:)`),
    /// pre-filled and editable.
    let title: String
    /// The reply body, verbatim — the plan as the agent wrote it.
    let content: String

    var id: UUID { messageId }
}

/// Pure rules behind the plan-edit affordances, kept out of the View so
/// `chat-contract-lab` can assert them (this toolchain has no XCTest; see
/// `Sources/ChatContractLab/main.swift`). Public for the same reason: the lab
/// is a separate target and sees only public symbols.
public enum PlanEditPolicy {

    /// Composer seed for "Refine in chat" — the plan is named, because a
    /// transcript can hold several and a bare "Revise the plan:" would read
    /// as the latest one.
    public static func refineSeed(title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Revise the plan: " : "Revise the plan \"\(trimmed)\": "
    }

    /// Whether the edit sheet's Save may fire. Only the body matters: a blank
    /// title falls back to the derived one (and the resolver slugifies an
    /// empty title to "untitled-plan"), but an empty body would write an
    /// empty plan file.
    public static func canSave(content: String) -> Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Title actually written: the user's edit when they left something, else
    /// the title derived from the reply.
    public static func resolvedTitle(edited: String, derived: String) -> String {
        let trimmed = edited.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? derived : trimmed
    }

    /// Why a plan write was refused, or `nil` when it may proceed. The two
    /// guards every plan save shares, as a value: a pending legacy proposal
    /// owns the turn, this plan is already on disk, or the message it belongs
    /// to is no longer in the live transcript (the edit sheet outlived its
    /// session) — in which case the `planSaved` flag has nowhere to land and
    /// a write would be unrecorded, so a second one could follow.
    public enum WriteRefusal: Equatable {
        case pendingTool
        case alreadySaved
        case messageGone
    }

    public static func refusal(hasPendingTool: Bool,
                               alreadySaved: Bool,
                               messageInTranscript: Bool) -> WriteRefusal? {
        if hasPendingTool { return .pendingTool }
        if alreadySaved { return .alreadySaved }
        if !messageInTranscript { return .messageGone }
        return nil
    }
}

/// Hand-edit a generated plan before it is written to `llm-doc/plans/`.
///
/// The counterpart to "Refine in chat": that one asks the agent for another
/// revision, this one lets the user fix the text themselves. Only the SAVED
/// FILE carries the edits — the assistant message stays exactly as the agent
/// wrote it, so the transcript keeps agreeing with the v2 engine's
/// server-side history.
///
/// The sheet never writes to disk; the panel does that in `onSave`, which
/// keeps the write next to the `planSaved` bookkeeping it must stay atomic
/// with.
struct PlanEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var theme: ThemeStore

    let target: PlanEditTarget
    /// Wraps `CodeAssistantPanel.savePlanEdits(_:title:content:)`.
    let onSave: (String, String) async -> SavePlanResult

    @State private var title: String
    @State private var content: String
    @State private var submitting = false
    @State private var errorMessage: String?

    init(target: PlanEditTarget, onSave: @escaping (String, String) async -> SavePlanResult) {
        self.target = target
        self.onSave = onSave
        _title = State(initialValue: target.title)
        _content = State(initialValue: target.content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Title")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                TextField("Plan title", text: $title)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Plan (Markdown, editable)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                TextEditor(text: $content)
                    .font(.system(size: 12, design: .monospaced))
                    .frame(minHeight: 320)
                    .overlay(RoundedRectangle(cornerRadius: 4)
                                .stroke(Color.secondary.opacity(0.3)))
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Text("Saves to llm-doc/plans/ in the open project")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(submitting)
                // The Task is formed HERE, inside the @MainActor body, so the
                // @State writes in submit() stay on the main actor (the
                // pattern UpdateIssueSheet uses).
                Button("Save Plan") { Task { await submit() } }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting || !PlanEditPolicy.canSave(content: content))
            }
        }
        .padding(20)
        .frame(minWidth: 680, minHeight: 560)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Edit plan").font(.title3.bold())
            Text("Your edits are written to the plan file; the chat reply is left as the agent wrote it.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @MainActor
    private func submit() async {
        // Two fast Returns can both reach here before `submitting` re-renders
        // the disabled state, so the flag is also read as a guard.
        guard !submitting, PlanEditPolicy.canSave(content: content) else { return }
        submitting = true
        defer { submitting = false }
        errorMessage = nil
        let finalTitle = PlanEditPolicy.resolvedTitle(edited: title, derived: target.title)
        switch await onSave(finalTitle, content) {
        case .success:
            dismiss()
        case .failure(let message):
            errorMessage = message
        }
    }
}
