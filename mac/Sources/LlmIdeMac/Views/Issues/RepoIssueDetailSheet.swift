// Issue detail sheet — backend-agnostic. Shown from RepoIssuesView when
// the user clicks an issue row. Provides:
//   • Read view: title / state / labels / body / comments timeline
//   • Comment composer (calls createNote)
//   • Close / Reopen action (calls updateIssue with stateChange)
//   • Weight editor (gated on client.supportsWeight — GitLab only)
//   • Due-date editor: native DatePicker when !usesScheduleOverlay (GitLab),
//     IssueScheduleEditorSheet when usesScheduleOverlay (GitHub)
//   • MR/PR creation (gated on client.canCreateMergeRequests)

import SwiftUI

struct RepoIssueDetailSheet: View {
    let issue: RepoIssue
    let client: RepoBackend
    let projectId: String
    /// "owner/name" — used for MR creation dedup and the schedule overlay.
    var projectFullName: String = ""
    /// Server API client for the schedule overlay (GitHub due-date editing).
    /// Nil → schedule editor button is hidden.
    var api: LlmIdeAPIClient? = nil
    var onIssueChanged: (RepoIssue) -> Void
    var onDismiss: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(ActivityStore.self) private var activity

    @State private var current: RepoIssue
    @State private var notes: [RepoNote] = []
    @State private var notesLoading = false
    @State private var notesError: String?

    @State private var newComment: String = ""
    @State private var commentBusy = false
    @State private var stateBusy = false
    @State private var topError: String?

    // Rendered-markdown body height (reported by the self-sizing web view).
    @State private var bodyHeight: CGFloat = 0

    // Inline label / milestone / assignee editors
    @State private var availableLabels: [RepoLabel] = []
    @State private var availableMilestones: [RepoMilestone] = []
    @State private var availableMembers: [RepoUser] = []
    @State private var metaBusy = false

    // Weight editor
    @State private var weightDraft: Int = 0
    @State private var weightBusy = false

    // Due-date editor (GitLab native)
    @State private var showDueDatePicker = false
    @State private var pendingDueDate: Date = Date()
    @State private var dueDateBusy = false

    // Schedule overlay editor (GitHub)
    @State private var showScheduleEditor = false
    @State private var currentSchedule: LlmIdeAPIClient.IssueSchedule? = nil

    // MR / PR creation
    @State private var showMRSheet = false
    @State private var mrBusy = false
    @State private var mrError: String?
    @State private var mrURL: String?

    init(issue: RepoIssue, client: RepoBackend, projectId: String,
         projectFullName: String = "",
         api: LlmIdeAPIClient? = nil,
         onIssueChanged: @escaping (RepoIssue) -> Void,
         onDismiss: @escaping () -> Void) {
        self.issue = issue
        self.client = client
        self.projectId = projectId
        self.projectFullName = projectFullName
        self.api = api
        self.onIssueChanged = onIssueChanged
        self.onDismiss = onDismiss
        self._current = State(initialValue: issue)
        self._weightDraft = State(initialValue: issue.weight ?? 0)
    }

    var body: some View {
        let t = theme.current
        VStack(spacing: 0) {
            header
            Divider().background(t.border)
            HStack(spacing: 0) {
                // LEFT: description + comments + the comment composer (the
                // composer belongs to the issue thread, so it stays in this
                // column — not under the settings sidebar).
                VStack(spacing: 0) {
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
                .frame(maxWidth: .infinity)
                Divider().background(t.border)
                // RIGHT: GitLab-style settings sidebar (Status / Assignees /
                // Labels / Milestone / Weight / Dates) — each editable in place.
                settingsSidebar
                    .frame(width: 264)
            }
        }
        .frame(minWidth: 900, idealWidth: 1040, minHeight: 540, idealHeight: 680)
        .background(t.body)
        .task { await loadNotes() }
        .task { await loadMeta() }
        .sheet(isPresented: $showMRSheet) { mrSheet }
        .sheet(isPresented: $showScheduleEditor) {
            if let api {
                IssueScheduleEditorSheet(
                    api: api,
                    provider: client.kind.rawValue,
                    repo: projectFullName,
                    issueNumber: current.number,
                    issueTitle: current.title,
                    existing: currentSchedule,
                    onSaved: { saved in currentSchedule = saved },
                    onDismiss: { showScheduleEditor = false }
                )
                .environmentObject(theme)
            }
        }
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
            .disabled(stateBusy || !config.isAllowed(.merge, provider: client.kind))
            .help(config.isAllowed(.merge, provider: client.kind)
                  ? ""
                  : "Enable Close / reopen in Settings → \(client.kind.displayName) → Automation & Actions")
        }
        // MR / PR creation — shown when the backend supports it
        if client.canCreateMergeRequests {
            Button {
                showMRSheet = true
            } label: {
                HStack(spacing: 4) {
                    if mrBusy {
                        ProgressView().controlSize(.small).scaleEffect(0.7)
                    } else {
                        Image(systemName: "arrow.triangle.branch").font(.system(size: 11))
                    }
                    Text(client.kind.changeRequestAbbrev).font(Typography.captionStrong)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 7).fill(t.surface2))
                .foregroundStyle(t.text)
            }
            .buttonStyle(.plain)
            .disabled(mrBusy || !config.isAllowed(.createPR, provider: client.kind))
            .help(config.isAllowed(.createPR, provider: client.kind)
                  ? "Create \(client.kind.changeRequestNoun)"
                  : "Enable Create PR / MR in Settings → \(client.kind.displayName) → Automation & Actions")
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
            // Render the description as Markdown (headings, lists, tables,
            // code, links) via the shared self-sizing web view — the same
            // renderer the Code Assistant uses — instead of a flat Text.
            Group {
                if let raw = current.body,
                   !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    SelfSizingMarkdownView(markdown: raw, isDark: t.isDark) { h in
                        if bodyHeight != h { bodyHeight = h }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: max(bodyHeight, 24))
                } else {
                    Text("No description.")
                        .font(Typography.body).foregroundStyle(t.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(Spacing.md)
            .background(RoundedRectangle(cornerRadius: Radius.md).fill(t.surface))
            .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(t.border, lineWidth: 0.5))
        }
    }

    // MARK: - Settings sidebar (GitLab-style editable fields on the right)

    private var settingsSidebar: some View {
        let t = theme.current
        return ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                // Status (state) — editable: Open ↔ Closed
                sidebarEditableSection("Status", t: t, hasEdit: client.canWriteIssues && !stateBusy, content: {
                    HStack(spacing: 5) {
                        Circle().fill(current.isOpen ? t.accent2 : t.textMuted).frame(width: 7, height: 7)
                        Text(current.isOpen ? "Open" : "Closed").font(Typography.body).foregroundStyle(t.text)
                        if stateBusy { ProgressView().controlSize(.small).scaleEffect(0.6) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }, menu: {
                    Button {
                        if !current.isOpen { Task { await toggleState() } }
                    } label: { Label("Open", systemImage: current.isOpen ? "checkmark" : "") }
                    Button {
                        if current.isOpen { Task { await toggleState() } }
                    } label: { Label("Closed", systemImage: !current.isOpen ? "checkmark" : "") }
                })

                // Assignees
                sidebarEditableSection("Assignees", t: t, hasEdit: !availableMembers.isEmpty, content: {
                    let names = current.assignees.map { $0.displayName.isEmpty ? $0.username : $0.displayName }
                    Text(names.isEmpty ? "None" : names.joined(separator: ", "))
                        .font(Typography.body).foregroundStyle(names.isEmpty ? t.textMuted : t.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }, menu: {
                    ForEach(availableMembers) { u in
                        let isOn = current.assignees.contains { $0.username == u.username }
                        Button { Task { await toggleAssignee(u) } } label: {
                            Label(u.displayName.isEmpty ? u.username : u.displayName, systemImage: isOn ? "checkmark" : "")
                        }
                    }
                })

                // Labels
                sidebarEditableSection("Labels", t: t, hasEdit: !availableLabels.isEmpty, content: {
                    Text(current.labels.isEmpty ? "None" : current.labels.joined(separator: ", "))
                        .font(Typography.body).foregroundStyle(current.labels.isEmpty ? t.textMuted : t.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }, menu: {
                    if availableLabels.isEmpty {
                        Text("No labels in this project")
                    } else {
                        ForEach(availableLabels) { l in
                            Button { Task { await toggleLabel(l.name) } } label: {
                                Label(l.name, systemImage: current.labels.contains(l.name) ? "checkmark" : "")
                            }
                        }
                    }
                })

                // Milestone
                if !availableMilestones.isEmpty {
                    sidebarEditableSection("Milestone", t: t, hasEdit: true, content: {
                        Text(current.milestone?.title ?? "None")
                            .font(Typography.body).foregroundStyle(current.milestone == nil ? t.textMuted : t.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }, menu: {
                        // "0" is the clear sentinel both backends understand:
                        // GitLab unassigns on milestone_id=0, and the GitHub
                        // bridge maps it to an explicit `milestone: null`.
                        Button { Task { await setMilestone("0") } } label: {
                            Label("None", systemImage: current.milestone == nil ? "checkmark" : "")
                        }
                        ForEach(availableMilestones) { m in
                            Button { Task { await setMilestone(m.id) } } label: {
                                Label(m.title, systemImage: current.milestone?.id == m.id ? "checkmark" : "")
                            }
                        }
                    })
                }

                // Weight (GitLab)
                if client.supportsWeight {
                    sidebarSection("Weight", t: t) {
                        HStack(spacing: Spacing.sm) {
                            Stepper(value: $weightDraft, in: 0...20) {
                                Text(weightDraft > 0 ? "\(weightDraft)" : "None")
                                    .font(Typography.body).foregroundStyle(weightDraft > 0 ? t.text : t.textMuted)
                            }
                            if weightBusy {
                                ProgressView().controlSize(.small).scaleEffect(0.7)
                            } else if weightDraft != (current.weight ?? 0) {
                                Button("Save") { Task { await saveWeight() } }.controlSize(.small)
                            }
                        }
                    }
                }

                // Dates
                sidebarSection("Dates", t: t) { dueDateControl(t) }

                Spacer(minLength: 0)
            }
            .padding(Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(t.surface.opacity(0.4))
    }

    /// A read-only sidebar field: title above, content below.
    @ViewBuilder
    private func sidebarSection<C: View>(_ title: String, t: Theme, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(Typography.captionStrong).foregroundStyle(t.textMuted)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// An editable sidebar field: title + "Edit" menu on top, value below.
    @ViewBuilder
    private func sidebarEditableSection<C: View, M: View>(
        _ title: String, t: Theme, hasEdit: Bool,
        @ViewBuilder content: () -> C, @ViewBuilder menu: () -> M
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(title).font(Typography.captionStrong).foregroundStyle(t.textMuted)
                Spacer()
                if metaBusy { ProgressView().controlSize(.small).scaleEffect(0.6) }
                if hasEdit {
                    Menu { menu() } label: {
                        Text("Edit").font(.system(size: 11, weight: .semibold)).foregroundStyle(t.accent)
                    }
                    .menuStyle(.borderlessButton).fixedSize()
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Due-date control for the Dates section (GitHub overlay vs GitLab native).
    @ViewBuilder
    private func dueDateControl(_ t: Theme) -> some View {
        if client.usesScheduleOverlay {
            HStack {
                if let due = current.dueDate {
                    Text(AppDateFormatter.dueDateDisplay(due)).font(Typography.body)
                        .foregroundStyle(AppDateFormatter.isDuePast(due) ? t.danger : t.text)
                } else {
                    Text("None").font(Typography.body).foregroundStyle(t.textMuted)
                }
                Spacer()
                if api != nil {
                    Button("Edit") { showScheduleEditor = true }.controlSize(.small)
                }
            }
        } else {
            HStack {
                Button {
                    if let d = current.dueDate, let date = AppDateFormatter.parseDateOnly(d) {
                        pendingDueDate = date
                    } else {
                        pendingDueDate = Date()
                    }
                    showDueDatePicker = true
                } label: {
                    if let due = current.dueDate {
                        Text(AppDateFormatter.dueDateDisplay(due)).font(Typography.body)
                            .foregroundStyle(AppDateFormatter.isDuePast(due) ? t.danger : t.text)
                    } else {
                        Text("Set due date").font(Typography.body).foregroundStyle(t.textMuted)
                    }
                }
                .buttonStyle(.plain)
                .popover(isPresented: $showDueDatePicker, arrowEdge: .bottom) { dueDatePickerPopover(t: t) }
                Spacer()
                if dueDateBusy { ProgressView().controlSize(.small).scaleEffect(0.7) }
            }
        }
    }

    @ViewBuilder
    private func dueDatePickerPopover(t: Theme) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Due date").font(.headline)
            DatePicker("", selection: $pendingDueDate, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .labelsHidden()
            HStack {
                if current.dueDate != nil {
                    Button("Remove") {
                        showDueDatePicker = false
                        Task { await saveDueDate(nil) }
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .foregroundStyle(t.danger)
                }
                Spacer()
                Button("Cancel") { showDueDatePicker = false }
                    .buttonStyle(.bordered).controlSize(.small)
                Button("Set") {
                    showDueDatePicker = false
                    Task { await saveDueDate(pendingDueDate) }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
            }
        }
        .padding(16)
        .frame(width: 300)
        .background(t.surface)
        .environmentObject(theme)
    }

    // MARK: - MR / PR creation sheet

    @ViewBuilder
    private var mrSheet: some View {
        MRCreationSheet(
            issue: current,
            client: client,
            projectId: projectId,
            onCreated: { mr in
                mrURL = mr.webUrl
                showMRSheet = false
            },
            onDismiss: { showMRSheet = false }
        )
        .environmentObject(theme)
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
                          newComment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                          !config.isAllowed(.commentIssue, provider: client.kind))
                .help(config.isAllowed(.commentIssue, provider: client.kind)
                      ? ""
                      : "Enable Comment on issue in Settings → \(client.kind.displayName) → Automation & Actions")
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

    private func saveWeight() async {
        weightBusy = true; topError = nil
        defer { weightBusy = false }
        do {
            let updated = try await client.updateIssue(
                projectId: projectId, number: current.number,
                payload: RepoIssuePayload(weight: weightDraft))
            current = updated
            onIssueChanged(updated)
        } catch {
            topError = error.localizedDescription
        }
    }

    /// Load the project's labels + milestones + members for the editor menus.
    private func loadMeta() async {
        async let labelsR  = try? client.listLabels(projectId: projectId)
        async let milesR   = try? client.listMilestones(projectId: projectId)
        async let membersR = try? client.listMembers(projectId: projectId)
        availableLabels     = await labelsR ?? []
        availableMilestones = await milesR ?? []
        availableMembers    = await membersR ?? []
    }

    /// Toggle an assignee. Selection is tracked by username (stable across
    /// providers); the saved ids come from the member objects so each backend
    /// gets the id form it expects (GitLab numeric / GitHub login).
    private func toggleAssignee(_ member: RepoUser) async {
        var selected = Set(current.assignees.map(\.username))
        if selected.contains(member.username) { selected.remove(member.username) }
        else { selected.insert(member.username) }
        let ids = availableMembers.filter { selected.contains($0.username) }.map(\.id)
        await applyMetaUpdate(RepoIssuePayload(assigneeIds: ids))
    }

    /// Toggle a label on/off and persist the full label set (an empty set
    /// clears all labels — GitLab/GitHub both replace on update).
    private func toggleLabel(_ name: String) async {
        var names = current.labels
        if let i = names.firstIndex(of: name) { names.remove(at: i) } else { names.append(name) }
        await applyMetaUpdate(RepoIssuePayload(labels: names))
    }

    private func setMilestone(_ id: String) async {
        await applyMetaUpdate(RepoIssuePayload(milestoneId: id))
    }

    private func applyMetaUpdate(_ payload: RepoIssuePayload) async {
        metaBusy = true; topError = nil
        defer { metaBusy = false }
        do {
            let updated = try await client.updateIssue(
                projectId: projectId, number: current.number, payload: payload)
            current = updated
            onIssueChanged(updated)
        } catch {
            topError = error.localizedDescription
        }
    }

    private func saveDueDate(_ date: Date?) async {
        dueDateBusy = true; topError = nil
        defer { dueDateBusy = false }
        let str: String?
        if let d = date { str = AppDateFormatter.dateOnly(d) } else { str = "" }
        do {
            let updated = try await client.updateIssue(
                projectId: projectId, number: current.number,
                payload: RepoIssuePayload(dueDate: str))
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

// MARK: - MR / PR creation sheet

private struct MRCreationSheet: View {
    let issue: RepoIssue
    let client: RepoBackend
    let projectId: String
    var onCreated: (RepoMergeRequest) -> Void
    var onDismiss: () -> Void

    @EnvironmentObject var theme: ThemeStore

    @State private var branchName: String = ""
    @State private var targetBranch: String = "main"
    @State private var draft = false
    @State private var busy = false
    @State private var error: String?
    @State private var existingMR: RepoMergeRequest?

    private var noun: String { client.kind.changeRequestNoun }
    private var abbrev: String { client.kind.changeRequestAbbrev }

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                Text("Create \(noun)")
                    .font(Typography.title).foregroundStyle(t.text)
                Spacer()
                Button { onDismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(t.textMuted)
                        .frame(width: 26, height: 26)
                        .background(RoundedRectangle(cornerRadius: 6).fill(t.surface2.opacity(0.8)))
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
            }

            if let mr = existingMR {
                HStack(spacing: 8) {
                    Image(systemName: "info.circle").foregroundStyle(t.accent)
                    Text("Open \(abbrev) #\(mr.number) already exists for this branch.")
                        .font(Typography.body).foregroundStyle(t.text)
                    Button("View") {
                        if let url = URL(string: mr.webUrl) { NSWorkspace.shared.open(url) }
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                }
                .padding(Spacing.sm)
                .background(RoundedRectangle(cornerRadius: 7).fill(t.accent.opacity(0.08)))
            }

            LabeledContent("Branch name") {
                TextField("feature/issue-\(issue.number)", text: $branchName)
                    .textFieldStyle(.roundedBorder)
            }
            LabeledContent("Target branch") {
                TextField("main", text: $targetBranch)
                    .textFieldStyle(.roundedBorder)
            }
            Toggle("Draft", isOn: $draft)

            if let err = error {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(Typography.caption).foregroundStyle(t.danger)
            }

            HStack {
                Spacer()
                Button("Cancel") { onDismiss() }
                    .buttonStyle(.bordered).disabled(busy)
                Button(busy ? "Creating…" : "Create \(abbrev)") {
                    Task { await create() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || branchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(Spacing.lg)
        .frame(minWidth: 460, idealWidth: 500)
        .background(t.body)
        .task {
            // Pre-fill branch name from issue title (slugified)
            if branchName.isEmpty {
                let slug = issue.title
                    .lowercased()
                    .components(separatedBy: .alphanumerics.inverted)
                    .filter { !$0.isEmpty }
                    .prefix(6)
                    .joined(separator: "-")
                branchName = "\(issue.number)-\(slug)"
            }
        }
    }

    private func create() async {
        let branch = branchName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty else { return }
        busy = true; error = nil; existingMR = nil
        defer { busy = false }
        do {
            // 1. Dedup — check for an already-open MR/PR on this branch.
            let opens = try await client.listOpenMergeRequests(projectId: projectId)
            if let existing = opens.first(where: { $0.sourceBranch == branch }) {
                existingMR = existing
                return
            }
            // 2. Create branch (idempotent — returns false if already exists).
            _ = try await client.createBranch(
                projectId: projectId, name: branch, ref: targetBranch)
            // 3. Create the MR / PR.
            let mrPayload = RepoMergeRequestPayload(
                title: "\(issue.title) (#\(issue.number))",
                sourceBranch: branch,
                targetBranch: targetBranch,
                draft: draft
            )
            let mr = try await client.createMergeRequest(projectId: projectId, payload: mrPayload)
            onCreated(mr)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
