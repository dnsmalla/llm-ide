import SwiftUI

/// Cursor-style editable confirmation sheet for the `update-file`
/// write tool. The agent proposes a change to a file — attached to the chat or
/// anywhere in the open project; this sheet renders a unified diff against the
/// current file content and lets the user tweak the proposal before applying.
///
/// Both sides of the diff arrive already resolved (see `ProposedEdit`): the
/// sheet does not know or care whether the agent sent a whole-file rewrite or
/// an anchored old_text/new_text edit, which keeps that decision in exactly one
/// place.
///
/// The sheet itself never writes to disk — the owner does that on
/// Apply via `onConfirm`. This keeps file I/O in the panel where the
/// in-memory attachment list also lives, so a successful write can
/// refresh that list atomically.
struct UpdateFileSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var theme: ThemeStore

    enum ConfirmResult {
        case success
        case failure(String)
    }

    /// The current content of the file the agent is proposing to edit — the
    /// attachment's in-memory copy, or what was just read from disk. Used as
    /// the LHS of the diff.
    let originalContent: String
    /// Display path — the attachment chip's label, or the project-relative
    /// path. Surfaced verbatim so the user recognises which file they're editing.
    let displayPath: String
    let onConfirm: (String) async -> ConfirmResult

    @State private var proposedContent: String
    @State private var submitting: Bool = false
    @State private var errorMessage: String?

    /// `proposedContent` is the RESULT of the agent's edit, already applied to
    /// `originalContent` by `ProposedEdit` — not the raw tool arguments. The
    /// sheet then treats it as an editable starting point.
    init(proposedContent: String,
         originalContent: String,
         displayPath: String,
         onConfirm: @escaping (String) async -> ConfirmResult) {
        self.originalContent = originalContent
        self.displayPath = displayPath
        self.onConfirm = onConfirm
        _proposedContent = State(initialValue: proposedContent)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Divider()

            diffPane

            VStack(alignment: .leading, spacing: 6) {
                Text("Proposed content (editable)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                TextEditor(text: $proposedContent)
                    .font(.system(size: 11, design: .monospaced))
                    .frame(minHeight: 140, maxHeight: 240)
                    .overlay(RoundedRectangle(cornerRadius: 4)
                                .stroke(Color.secondary.opacity(0.3)))
            }

            if let err = errorMessage {
                Text(err)
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Text(changeSummary)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(submitting)
                Button("Apply") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting || proposedContent == originalContent)
            }
        }
        .padding(20)
        .frame(minWidth: 720, minHeight: 560)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Update file").font(.title3.bold())
            Text(displayPath)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    // MARK: - Diff

    private var diffLanguage: String {
        MonacoLanguageMap.id(for: (displayPath as NSString).pathExtension)
    }

    @ViewBuilder
    private var diffPane: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Diff vs current file")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            MonacoDiffView(original: originalContent, modified: proposedContent, language: diffLanguage)
                .frame(minHeight: 240, maxHeight: 380)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
        }
    }

    /// "+12 −3" summary chip. Drives nothing functional but gives the
    /// user a quick at-a-glance read of the size of the change. Reuses
    /// `DiffStats.compute` (the SAME `CollectionDifference` technique this
    /// file's own diff used to compute independently) rather than keeping
    /// a second copy of the same line-diffing logic.
    private var changeSummary: String {
        let stats = DiffStats.compute(old: originalContent, new: proposedContent)
        return "+\(stats.added) −\(stats.removed) lines"
    }

    private func submit() {
        let toApply = proposedContent
        Task {
            submitting = true
            defer { submitting = false }
            errorMessage = nil
            let outcome = await onConfirm(toApply)
            switch outcome {
            case .success:
                dismiss()
            case .failure(let msg):
                errorMessage = msg
            }
        }
    }
}
