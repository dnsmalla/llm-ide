import SwiftUI

/// Compact card rendered under the assistant bubble when the agent
/// proposes a write tool. Shows enough of the action for the user to
/// recognise it; tapping opens the editable confirm sheet.
///
/// One card type per write-tool variant (matched on
/// `pendingTool.name`). Today only `create-gitlab-issue` exists.
struct PendingActionCard: View {
    let pendingTool: PendingTool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
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
                        Text("\(args.content.components(separatedBy: "\n").count) lines proposed")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
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
                    } else {
                        Text(pendingTool.name)
                            .font(.system(size: 13, weight: .regular))
                    }
                    Text("Tap to review and confirm")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var headline: String {
        switch pendingTool.name {
        case "create-gitlab-issue", "create-issue": return "WILL CREATE ISSUE"
        case "comment-gitlab-issue", "comment-issue": return "WILL COMMENT ON ISSUE"
        case "get-issue": return "WILL READ ISSUE"
        case "update-issue": return "WILL UPDATE ISSUE"
        case "list-issues": return "WILL LIST ISSUES"
        case "create-branch": return "WILL CREATE BRANCH"
        case "create-gitlab-mr", "create-pr": return "WILL CREATE MERGE REQUEST"
        case "trigger-review-code": return "WILL OPEN REVIEW CODE WORKFLOW"
        case "update-file": return "WILL UPDATE FILE"
        case "git-op": return "WILL RUN GIT OPERATION"
        default: return "PENDING ACTION: \(pendingTool.name.uppercased())"
        }
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
