// Issue detail sheet — backend-agnostic. Shown from RepoIssuesView when
// the user clicks an issue row. Provides:
//   • Read view: title / state / labels / body / comments timeline
//   • Comment composer (calls createNote)
//   • Close / Reopen action (calls updateIssue with stateChange)
//
// Edits to title / labels / assignees / milestone / due-date aren't
// surfaced here yet — the legacy GitLab IssueDetailPanel still owns
// the full edit form. We could fold that in later; this sheet covers
// the "I want to comment on a GitHub issue" use case that didn't
// exist at all before.

import SwiftUI

struct RepoIssueDetailSheet: View {
    let issue: RepoIssue
    let client: RepoBackend
    let projectId: String
    var onIssueChanged: (RepoIssue) -> Void
    var onDismiss: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @Environment(ActivityStore.self) private var activity

    @State private var current: RepoIssue
    @State private var notes: [RepoNote] = []
    @State private var notesLoading = false
    @State private var notesError: String?

    @State private var newComment: String = ""
    @State private var commentBusy = false
    @State private var stateBusy = false
    @State private var topError: String?

    init(issue: RepoIssue, client: RepoBackend, projectId: String,
         onIssueChanged: @escaping (RepoIssue) -> Void,
         onDismiss: @escaping () -> Void) {
        self.issue = issue
        self.client = client
        self.projectId = projectId
        self.onIssueChanged = onIssueChanged
        self.onDismiss = onDismiss
        self._current = State(initialValue: issue)
    }

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            header
            Divider().background(t.border)
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    body_
                    commentsSection
                }
                .padding(Spacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if client.canWriteIssues {
                Divider().background(t.border)
                composer
            }
        }
        .frame(minWidth: 620, idealWidth: 720, minHeight: 520, idealHeight: 620)
        .background(t.body)
        .task { await loadNotes() }
    }

    // MARK: - Header

    private var header: some View {
        let t = theme.current
        return HStack(alignment: .center, spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text("#\(current.number)").font(Typography.mono).foregroundStyle(t.textMuted)
                    stateBadge
                    Text(current.title)
                        .font(Typography.title).foregroundStyle(t.text)
                        .lineLimit(2)
                }
                if !current.labels.isEmpty {
                    HStack(spacing: 5) {
                        ForEach(current.labels.prefix(8), id: \.self) { name in
                            Text(name)
                                .font(.system(size: 10, weight: .semibold))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Capsule().fill(t.surface2))
                                .foregroundStyle(t.textMuted)
                        }
                    }
                }
            }
            Spacer()
            actionButtons
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(t.textMuted)
                    .frame(width: 26, height: 26)
                    .background(RoundedRectangle(cornerRadius: 6).fill(t.surface2.opacity(0.8)))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(Spacing.md)
        .background(t.surface)
    }

    private var stateBadge: some View {
        let t = theme.current
        let isOpen = current.isOpen
        return HStack(spacing: 4) {
            Circle().fill(isOpen ? t.accent3 : t.textMuted).frame(width: 6, height: 6)
            Text(isOpen ? "OPEN" : "CLOSED")
                .font(.system(size: 9, weight: .heavy, design: .rounded))
                .foregroundStyle(isOpen ? t.accent3 : t.textMuted)
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(Capsule().fill((isOpen ? t.accent3 : t.textMuted).opacity(0.12)))
    }

    @ViewBuilder
    private var actionButtons: some View {
        let t = theme.current
        if client.canWriteIssues {
            Button {
                Task { await toggleState() }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: current.isOpen ? "xmark.circle" : "arrow.counterclockwise.circle")
                        .font(.system(size: 11))
                    Text(current.isOpen ? "Close" : "Reopen").font(Typography.captionStrong)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(t.surface2))
                .foregroundStyle(t.text)
            }
            .buttonStyle(.plain)
            .disabled(stateBusy)
        }
        Button {
            if let url = URL(string: current.webUrl) { NSWorkspace.shared.open(url) }
        } label: {
            Image(systemName: "arrow.up.right.square")
                .font(.system(size: 12)).foregroundStyle(t.textMuted)
                .frame(width: 28, height: 28)
        }
        .buttonStyle(.plain)
        .help("Open on \(client.kind.displayName)")
    }

    // MARK: - Body

    @ViewBuilder
    private var body_: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 14)).foregroundStyle(t.textMuted)
                Text(current.author.displayName).font(Typography.bodyStrong).foregroundStyle(t.text)
                Text("opened this issue").font(Typography.caption).foregroundStyle(t.textMuted)
                Text(relativeDate(current.createdAt)).font(Typography.caption).foregroundStyle(t.textMuted)
            }
            Text(current.body ?? "")
                .font(Typography.body).foregroundStyle(t.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Spacing.md)
                .background(RoundedRectangle(cornerRadius: Radius.md).fill(t.surface))
                .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(t.border, lineWidth: 0.5))
        }
    }

    // MARK: - Comments

    @ViewBuilder
    private var commentsSection: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: 6) {
                SectionLabel("COMMENTS")
                if !notes.isEmpty {
                    Text("\(notes.count)").font(Typography.caption).foregroundStyle(t.textMuted)
                }
                if notesLoading {
                    ProgressView().controlSize(.small).scaleEffect(0.7)
                }
                Spacer()
            }
            if let err = notesError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption).foregroundStyle(t.danger)
            }
            if notes.isEmpty, !notesLoading {
                Text("No comments yet.").font(Typography.caption).foregroundStyle(t.textMuted)
            }
            ForEach(notes) { note in
                noteRow(note)
            }
        }
    }

    @ViewBuilder
    private func noteRow(_ note: RepoNote) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: note.isSystem ? "gearshape.fill" : "person.crop.circle")
                    .font(.system(size: 11))
                    .foregroundStyle(note.isSystem ? t.textMuted.opacity(0.7) : t.accent2)
                Text(note.author.displayName)
                    .font(Typography.captionStrong).foregroundStyle(t.text)
                Text(relativeDate(note.createdAt))
                    .font(Typography.caption).foregroundStyle(t.textMuted)
                if note.isSystem {
                    Text("system").font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(t.textMuted.opacity(0.7))
                }
            }
            Text(note.body)
                .font(Typography.body)
                .foregroundStyle(note.isSystem ? t.textMuted : t.text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Spacing.md)
        .background(RoundedRectangle(cornerRadius: Radius.md).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(t.border, lineWidth: 0.5))
    }

    // MARK: - Composer

    private var composer: some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: Spacing.sm) {
            TextEditor(text: $newComment)
                .font(Typography.body)
                .frame(minHeight: 80, maxHeight: 160)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(t.border, lineWidth: 1))
            HStack {
                if let err = topError {
                    Label(err, systemImage: "exclamationmark.triangle.fill")
                        .font(Typography.caption).foregroundStyle(t.danger)
                        .lineLimit(2).truncationMode(.tail)
                }
                Spacer()
                Button(commentBusy ? "Posting…" : "Comment") {
                    Task { await submitComment() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(commentBusy ||
                          newComment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(Spacing.md)
        .background(t.surface)
    }

    // MARK: - Data

    private func loadNotes() async {
        notesLoading = true; notesError = nil
        defer { notesLoading = false }
        do {
            notes = try await client.listNotes(projectId: projectId, number: current.number)
        } catch {
            notesError = error.localizedDescription
        }
    }

    private func submitComment() async {
        let trimmed = newComment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        commentBusy = true; topError = nil
        defer { commentBusy = false }
        do {
            let note = try await client.createNote(projectId: projectId, number: current.number, body: trimmed)
            notes.append(note)
            newComment = ""
            // Bump commentCount on the cached issue so the row in the
            // list reflects the new total without another round trip.
            current = current.bumping(commentCount: 1)
            onIssueChanged(current)
            activity.report(
                kind: .commentAdded,
                title: "Comment added to issue #\(current.number)",
                detail: ["iid": current.number, "url": current.webUrl],
                link: current.webUrl
            )
        } catch {
            topError = error.localizedDescription
        }
    }

    private func toggleState() async {
        stateBusy = true; topError = nil
        defer { stateBusy = false }
        do {
            let change: RepoIssuePayload.StateChange = current.isOpen ? .close : .reopen
            let updated = try await client.updateIssue(
                projectId: projectId, number: current.number,
                payload: RepoIssuePayload(stateChange: change))
            current = updated
            onIssueChanged(updated)
        } catch {
            topError = error.localizedDescription
        }
    }

    // MARK: - Helpers

    /// Format ISO-8601 timestamps as "3 days ago" / fallback to the raw
    /// string if parsing fails.
    private func relativeDate(_ iso: String) -> String {
        guard let d = AppDateFormatter.parseISO(iso) else { return iso }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .short
        return rel.localizedString(for: d, relativeTo: Date())
    }
}
