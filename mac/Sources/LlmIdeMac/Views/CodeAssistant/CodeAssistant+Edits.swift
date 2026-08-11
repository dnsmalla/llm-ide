import Foundation

/// The chat's file-edit flow: resolve an `update-file` proposal against the
/// filesystem, then apply it, review it, or skip it.
///
/// Apply / Review / Skip all resolve through the SAME `resolveEdit` call, so
/// the change the user sees in the card is by construction the change the
/// write performs.
extension CodeAssistantPanel {

    /// Attachments in the resolver's own currency, so `ProposedEditResolver`
    /// stays independent of the API client's types.
    var editableAttachments: [ProposedEditResolver.KnownFile] {
        attachmentState.attachments.map { .init(path: $0.path, content: $0.content) }
    }

    /// Resolve a proposal against the attachment list and the open project.
    ///
    /// The basename fallback is disabled in auto-edit mode for the same reason
    /// it always was: with no confirmation step, a hallucinated parent
    /// directory that happens to share a basename with an attachment would
    /// silently redirect the write onto that file.
    func resolveEdit(_ args: PendingTool.UpdateFileArgs) -> Result<ProposedEdit, ProposedEditError> {
        ProposedEditResolver.resolve(
            args: args,
            attachments: editableAttachments,
            projectRoot: activeRepoRoot,
            allowBasenameFallback: editMode != .auto
        )
    }

    /// The currently proposed edit, or nil when there isn't one / it can't be
    /// resolved. Failures surface their message when the user actually tries to
    /// apply (or opens the sheet), not as a render-time error.
    ///
    /// This performs I/O — call it from an event, never from `body`. The chat
    /// card reads the cached `pendingEditPreview` instead.
    var pendingEdit: ProposedEdit? {
        guard let args = agent.pendingTool?.updateFileArgs else { return nil }
        return try? resolveEdit(args).get()
    }

    /// Refresh the cached resolution. Driven by `pendingTool` changing, so the
    /// file is read once per proposal rather than once per render.
    @MainActor
    func refreshPendingEditPreview() {
        pendingEditPreview = pendingEdit
    }

    /// Why the pending edit couldn't be resolved, for the unavailable-sheet
    /// fallback. The specific reason (anchor missed / outside the project /
    /// unreadable) is what tells the user whether to retry or rephrase, so it's
    /// shown instead of a generic "path didn't match".
    var pendingEditFailureReason: String? {
        guard let args = agent.pendingTool?.updateFileArgs else { return nil }
        if case .failure(let err) = resolveEdit(args) { return err.message }
        return nil
    }

    /// Apply from the chat card, with no sheet — the Cursor-style one-click
    /// path. Same write as the sheet's Apply button, minus the review step the
    /// user chose to skip.
    @MainActor
    func applyPendingEdit() async {
        guard let args = agent.pendingTool?.updateFileArgs else { return }
        switch resolveEdit(args) {
        case .failure(let err):
            // Don't clear pendingTool: the card stays up so the user can open
            // the sheet and see the detail, or ask the agent to retry.
            error = err.message
        case .success(let edit):
            let result = await confirmUpdateFile(args, finalContent: edit.proposed)
            if case .failure(let message) = result { error = message }
        }
    }

    /// Decline the proposed edit. Tells the AGENT it was declined as well as
    /// dropping the card — otherwise the loop is left holding an unanswered
    /// write and the next turn re-proposes the same change.
    @MainActor
    func skipPendingEdit() async {
        guard let args = agent.pendingTool?.updateFileArgs else { return }
        agent.pendingTool = nil
        sheets.showingUpdateFileSheet = false
        let name = (args.path as NSString).lastPathComponent
        history.append(.init(
            role: .user,
            content: "(skipped the proposed edit to \(name) — do not apply it or propose it again unless I ask; continue with anything else outstanding)"
        ))
        await unblockAndFollowUp()
    }
}
