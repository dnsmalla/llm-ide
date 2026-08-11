import SwiftUI

/// Compact card rendered under the assistant bubble when the agent
/// proposes a write tool. Shows enough of the action for the user to
/// recognise it; tapping opens the editable confirm sheet.
///
/// One card type per write-tool variant (matched on
/// `pendingTool.name`). Today only `create-gitlab-issue` exists.
struct PendingActionCard: View {
    let pendingTool: PendingTool
    /// Precomputed diff stats for the `update-file` variant — nil for every
    /// other tool, or when the proposal didn't resolve to a file (the card
    /// still shows, just without the preview, and Apply is disabled; Review
    /// opens the sheet, which explains why).
    var diffPreview: DiffStats?
    let onOpen: () -> Void

    /// Inline decision buttons for a file edit — the Cursor-style
    /// Apply / Review / Skip row. Supplied only for `update-file`: every other
    /// pending tool needs its own sheet to gather arguments, so a one-click
    /// Apply would have nothing to apply. `nil` keeps the tap-to-open card.
    struct EditActions {
        let apply: () async -> Void
        let skip: () async -> Void
        /// False when the proposal resolves to no change, or doesn't resolve at
        /// all — Review still opens so the user can see why.
        let canApply: Bool
    }
    var editActions: EditActions?

    /// True when this card should show the inline decision row instead of
    /// behaving as one big "open the sheet" button.
    private var showsInlineActions: Bool {
        pendingTool.kind == .updateFile && editActions != nil
    }

    var body: some View {
        if showsInlineActions {
            // NOT wrapped in a Button: an outer Button would swallow the taps
            // meant for Apply / Review / Skip.
            VStack(alignment: .leading, spacing: 8) {
                cardFace
                actionRow
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.35), lineWidth: 1))
        } else {
            Button(action: onOpen) {
                cardFace
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.35), lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Inline actions

    @ViewBuilder
    private var actionRow: some View {
        if let actions = editActions {
            HStack(spacing: 8) {
                // Deliberately NO .keyboardShortcut(.defaultAction): this card
                // sits above a focused text composer, and claiming Return would
                // apply a file edit the moment the user pressed it to send a
                // message. Applying is a click.
                Button("Apply") { Task { await actions.apply() } }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(!actions.canApply)
                Button("Review diff", action: onOpen)
                    .controlSize(.small)
                Button("Skip") { Task { await actions.skip() } }
                    .controlSize(.small)
                Spacer(minLength: 0)
            }
        }
    }

    private var cardFace: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.shield")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.orange)
                .frame(width: 16, alignment: .center)
            VStack(alignment: .leading, spacing: 4) {
                Text(headline)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                if let args = pendingTool.createIssueArgs {
                    Text(args.title)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(2)
                    if !args.description.isEmpty {
                        Text(descriptionPreview(args.description))
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    if let labels = args.labels, !labels.isEmpty {
                        HStack(spacing: 4) {
                            ForEach(labels.prefix(4), id: \.self) { label in
                                Text(label)
                                    .font(.system(size: 10, weight: .medium))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
                            }
                        }
                    }
                } else if let args = pendingTool.triggerReviewCodeArgs {
                    Text("→ Review Code for #\(args.iid)")
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    if !args.plan.isEmpty {
                        Text(descriptionPreview(args.plan))
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                } else if let args = pendingTool.updateFileArgs {
                    Text(filenameSuffix(args.path))
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(editShapeSummary(args))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let diff = diffPreview {
                        Text("+\(diff.added) −\(diff.removed)")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.secondary)
                        ForEach(Array(diff.previewLines.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(line.hasPrefix("+") ? .green : (line.hasPrefix("-") ? .red : .secondary))
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                } else if let args = pendingTool.commentIssueArgs {
                    Text("On issue #\(args.iid)")
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    if !args.body.isEmpty {
                        Text(descriptionPreview(args.body))
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                } else if let args = pendingTool.gitOpArgs {
                    Text(args.op.rawValue.uppercased())
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    // Show message for commit, branch for branch ops
                    if let message = args.message, !message.isEmpty {
                        Text(descriptionPreview(message))
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    } else if let branch = args.branch, !branch.isEmpty {
                        Text("branch: \(branch)")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    } else if let ref = args.ref, !ref.isEmpty {
                        Text("ref: \(ref)")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                } else if let args = pendingTool.getIssueArgs {
                    Text("Read issue #\(args.iid)")
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    Text("Show full issue details")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if let args = pendingTool.updateIssueArgs {
                    Text("Update issue #\(args.iid)")
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    if let title = args.title, !title.isEmpty {
                        Text(descriptionPreview(title))
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    } else if let state = args.state, !state.isEmpty {
                        Text("State: \(state)")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                } else if let args = pendingTool.listIssuesArgs {
                    Text("Search issues")
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    if let search = args.search, !search.isEmpty {
                        Text("Search: \(search)")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    } else if let state = args.state, !state.isEmpty {
                        Text("Filter: \(state)")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    } else if let label = args.label, !label.isEmpty {
                        Text("Label: \(label)")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                } else if let args = pendingTool.createBranchArgs {
                    Text("Create branch")
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    Text(args.branch)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let startPoint = args.startPoint, !startPoint.isEmpty {
                        Text("from: \(startPoint)")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                } else if let args = pendingTool.createPRArgs {
                    Text("Create merge request")
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    Text(args.title)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Text("\(args.sourceBranch) → \(args.targetBranch)")
                        .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                } else if let args = pendingTool.bashArgs {
                    // The command IS the action here — without it the card
                    // said nothing but "bash". Rendered monospaced over up
                    // to 3 lines so a short pipeline stays readable and a
                    // heredoc/multi-line command is visibly truncated
                    // rather than silently reduced to its first line.
                    Text(args.command)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                        .lineLimit(3)
                        .truncationMode(.tail)
                    if let cwd = args.workingDirectory, !cwd.isEmpty {
                        Text("in \(filenameSuffix(cwd))")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                } else {
                    Text(pendingTool.name)
                        .font(.system(size: 13, weight: .regular))
                }
                if !showsInlineActions {
                    Text(callToAction)
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var headline: String {
        switch pendingTool.kind {
        case .createIssue: return "WILL CREATE ISSUE"
        case .commentIssue: return "WILL COMMENT ON ISSUE"
        case .getIssue: return "WILL READ ISSUE"
        case .updateIssue: return "WILL UPDATE ISSUE"
        case .listIssues: return "WILL LIST ISSUES"
        case .createBranch: return "WILL CREATE BRANCH"
        case .createPR: return "WILL CREATE MERGE REQUEST"
        case .triggerReviewCode: return "WILL OPEN REVIEW CODE WORKFLOW"
        case .updateFile: return "WILL UPDATE FILE"
        case .gitOp: return "WILL RUN GIT OPERATION"
        case .bash: return "WILL RUN COMMAND"
        case nil: return "PENDING ACTION: \(pendingTool.name.uppercased())"
        }
    }

    /// Tapping this card does NOT always open a confirmation sheet: `bash` and
    /// a read-tier `git-op` execute immediately on tap (see ChatMessageList's
    /// dispatch switch). Saying "review and confirm" for those promised a
    /// review step that never existed, so each gets wording that matches what
    /// the tap actually does.
    private var callToAction: String {
        switch pendingTool.kind {
        case .bash: return "Tap to run it"
        case .gitOp where pendingTool.gitOpArgs?.op.tier == .read: return "Tap to run it"
        default: return "Tap to review and confirm"
        }
    }

    /// One line describing WHAT kind of edit this is, which is the difference
    /// the user most needs to see before clicking Apply: a whole-file rewrite
    /// replaces everything, an anchored edit touches one region. The +/− stats
    /// underneath quantify it; this names it.
    private func editShapeSummary(_ args: PendingTool.UpdateFileArgs) -> String {
        if let content = args.content {
            return "replaces the whole file — \(lineCount(content)) lines"
        }
        if let old = args.oldText {
            let lines = lineCount(old)
            return lines == 1 ? "edits 1 line in place" : "edits \(lines) lines in place"
        }
        return "proposed edit"
    }

    /// Lines of text, NOT components. Both an anchor and a file body normally
    /// end in a newline, and `components(separatedBy:)` yields a trailing empty
    /// element for that — which reported every count one too high.
    private func lineCount(_ s: String) -> Int {
        var parts = s.components(separatedBy: "\n")
        if parts.last == "" { parts.removeLast() }
        return max(parts.count, 1)
    }

    /// Show last two path components so the user can disambiguate
    /// `Foo/README.md` from `Bar/README.md` without wasting width on
    /// the full absolute path.
    private func filenameSuffix(_ path: String) -> String {
        let parts = path.split(separator: "/")
        if parts.count >= 2 { return parts.suffix(2).joined(separator: "/") }
        return path
    }

    /// Trim the description to a one-line teaser without slicing inside
    /// a multibyte UTF-8 character. String.prefix(_:) is grapheme-safe.
    private func descriptionPreview(_ s: String) -> String {
        let limit = 200
        if s.count <= limit { return s }
        return String(s.prefix(limit)) + "…"
    }
}
