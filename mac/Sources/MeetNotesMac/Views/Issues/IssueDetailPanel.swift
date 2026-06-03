import SwiftUI

struct IssueDetailPanel: View {
    let issue: GitLabIssue?
    let gitlab: GitLabClient
    let project: GitLabProject?
    let labels: [GitLabLabel]
    let milestones: [GitLabMilestone]
    let members: [GitLabUser]
    let onUpdate: (GitLabIssue) -> Void

    @EnvironmentObject var theme: ThemeStore

    // Notes / comments
    @State private var notes: [GitLabNote] = []
    @State private var notesLoading = false
    @State private var commentDraft = ""
    @State private var commentBusy = false

    // Inline title editing
    @State private var editingTitle = false
    @State private var titleDraft = ""
    @FocusState private var titleFocused: Bool

    // Inline description editing
    @State private var editingDescription = false
    @State private var descDraft = ""

    // Sidebar pickers
    @State private var showLabelPicker = false
    @State private var showAssigneePicker = false
    @State private var showMilestonePicker = false
    @State private var showDueDatePicker = false
    @State private var pendingLabels: [String] = []
    @State private var pendingAssigneeIds: Set<Int> = []
    @State private var pendingDueDate: Date? = nil

    // Saving state per field
    @State private var savingTitle = false
    @State private var savingDescription = false
    @State private var savingLabels = false
    @State private var savingAssignees = false
    @State private var savingMilestone = false
    @State private var savingDueDate = false
    @State private var savingState = false

    @State private var saveError: String?

    var body: some View {
        if let issue {
            HStack(spacing: 0) {
                // ── Main scrollable area ────────────────────────────────
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        headerSection(issue)
                        Divider().background(theme.current.border).padding(.vertical, 4)
                        descriptionSection(issue)
                        Divider().background(theme.current.border).padding(.vertical, 4)
                        activitySection(issue)
                    }
                    .padding(20)
                }
                .background(theme.current.body)
                .frame(maxWidth: .infinity)

                // ── Right sidebar ───────────────────────────────────────
                Divider().background(theme.current.border)
                sidebarView(issue)
            }
            .id(issue.id)
            .task(id: issue.id) { await loadNotes(issue) }
            .onChange(of: issue.id) { _, _ in resetEditState(issue) }
        } else {
            EmptyStateView(
                icon: "doc.text",
                title: "Select an issue",
                message: "Click any issue card to view and edit details."
            )
        }
    }

    // MARK: - Header

    @ViewBuilder
    private func headerSection(_ issue: GitLabIssue) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 12) {

            // Row: state badge + #iid + Open in GitLab
            HStack(spacing: 8) {
                stateBadge(issue, t: t)
                Text("#\(issue.iid)")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(t.surface2)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                Spacer()
                if let err = saveError {
                    Text(err).font(.system(size: 10)).foregroundStyle(t.danger).lineLimit(1)
                }
                Button {
                    if let url = URL(string: issue.webUrl) { NSWorkspace.shared.open(url) }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.up.right.square").font(.system(size: 10))
                        Text("Open in GitLab").font(.system(size: 11))
                    }
                    .foregroundStyle(t.accent2)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(t.accent2.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 5))
            }

            // Inline-editable title
            if editingTitle {
                HStack(spacing: 8) {
                    TextField("Issue title", text: $titleDraft)
                        .font(.system(size: 18, weight: .semibold))
                        .textFieldStyle(.roundedBorder)
                        .focused($titleFocused)
                        .onSubmit { Task { await saveTitle(issue) } }
                        .onExitCommand { editingTitle = false; titleDraft = "" }
                    if savingTitle {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Save") { Task { await saveTitle(issue) } }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                            .disabled(titleDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                        Button("Cancel") { editingTitle = false }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
            } else {
                HStack(alignment: .top, spacing: 8) {
                    Text(issue.title)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(t.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button { startEditTitle(issue) } label: {
                        Image(systemName: "pencil")
                            .font(.system(size: 11))
                            .foregroundStyle(t.textMuted)
                    }
                    .buttonStyle(.plain)
                    .help("Edit title")
                }
            }

            // Label chips + add label
            labelChipsRow(issue)
        }
        .padding(.bottom, 16)
    }

    @ViewBuilder
    private func stateBadge(_ issue: GitLabIssue, t: Theme) -> some View {
        let color: Color = issue.isOpen ? t.accent3 : t.textMuted
        HStack(spacing: 5) {
            Image(systemName: issue.isOpen ? "circle" : "checkmark.circle.fill")
                .font(.system(size: 10))
            Text(issue.isOpen ? "Open" : "Closed")
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(color.opacity(0.12))
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(color.opacity(0.25), lineWidth: 1))
    }

    @ViewBuilder
    private func labelChipsRow(_ issue: GitLabIssue) -> some View {
        let t = theme.current
        FlowLayout(spacing: 5) {
            ForEach(issue.labels, id: \.self) { lbl in
                LabelChip(name: lbl)
            }
            // Add label button
            Button {
                pendingLabels = issue.labels
                showLabelPicker = true
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "plus").font(.system(size: 9, weight: .bold))
                    Text(issue.labels.isEmpty ? "Add label" : "Edit")
                        .font(.system(size: 10, weight: .medium))
                }
                .foregroundStyle(t.textMuted)
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background(t.surface2)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(t.border, lineWidth: 0.5))
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showLabelPicker, arrowEdge: .bottom) {
                labelPickerPopover(issue)
            }
            .disabled(savingLabels)
            .overlay(savingLabels ? AnyView(ProgressView().controlSize(.mini).scaleEffect(0.7)) : AnyView(EmptyView()))
        }
    }

    // MARK: - Description

    @ViewBuilder
    private func descriptionSection(_ issue: GitLabIssue) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionLabel("DESCRIPTION")
                Spacer()
                if editingDescription {
                    if savingDescription {
                        ProgressView().controlSize(.mini)
                    } else {
                        Button("Save") { Task { await saveDescription(issue) } }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                            .disabled(savingDescription)
                        Button("Cancel") { editingDescription = false }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                } else {
                    Button {
                        descDraft = issue.description ?? ""
                        editingDescription = true
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "pencil").font(.system(size: 10))
                            Text("Edit").font(.system(size: 11))
                        }
                        .foregroundStyle(t.textMuted)
                    }
                    .buttonStyle(.plain)
                }
            }

            if editingDescription {
                TextEditor(text: $descDraft)
                    .font(.system(size: 13, design: .monospaced))
                    .frame(minHeight: 160, maxHeight: 400)
                    .padding(8)
                    .scrollContentBackground(.hidden)
                    .background(t.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(t.accent.opacity(0.4), lineWidth: 1))
            } else if let desc = issue.description, !desc.isEmpty {
                Text(desc)
                    .font(.system(size: 13))
                    .foregroundStyle(t.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(t.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(t.border, lineWidth: 0.5))
            } else {
                Button {
                    descDraft = ""
                    editingDescription = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus.circle").font(.system(size: 12))
                        Text("Add description")
                            .font(.system(size: 13))
                    }
                    .foregroundStyle(t.textMuted)
                    .italic()
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(t.surface.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(t.border.opacity(0.5), lineWidth: 0.5))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.bottom, 20)
    }

    // MARK: - Activity

    @ViewBuilder
    private func activitySection(_ issue: GitLabIssue) -> some View {
        let t = theme.current
        let userNotes = notes.filter { !$0.system }
        let sysNotes  = notes.filter { $0.system }

        VStack(alignment: .leading, spacing: 14) {
            HStack {
                sectionLabel("ACTIVITY")
                if !userNotes.isEmpty {
                    Text("· \(userNotes.count) comment\(userNotes.count == 1 ? "" : "s")")
                        .font(.system(size: 10)).foregroundStyle(t.textMuted)
                }
                Spacer()
                if notesLoading { ProgressView().controlSize(.mini) }
            }

            // System event timeline
            if !sysNotes.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(sysNotes) { n in
                        HStack(spacing: 8) {
                            Circle().fill(t.border).frame(width: 5, height: 5)
                            Text(n.author.name)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(t.textMuted)
                            Text(n.body)
                                .font(.system(size: 10))
                                .foregroundStyle(t.textMuted)
                                .lineLimit(2)
                            Spacer()
                            Text(AppDateFormatter.relativeVerbose(n.createdAt))
                                .font(.system(size: 9))
                                .foregroundStyle(t.textMuted.opacity(0.7))
                        }
                    }
                }
                .padding(10)
                .background(t.surface.opacity(0.6))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            // User comments
            ForEach(userNotes) { n in
                commentBubble(n, t: t)
            }

            // Comment composer
            commentComposer(issue, t: t)
        }
    }

    @ViewBuilder
    private func commentBubble(_ note: GitLabNote, t: Theme) -> some View {
        let color = ColorPalette.color(for: note.author.id)
        HStack(alignment: .top, spacing: 10) {
            ZStack {
                Circle().fill(color.opacity(0.18)).frame(width: 30, height: 30)
                Text(String(note.author.name.prefix(1)).uppercased())
                    .font(.system(size: 12, weight: .bold)).foregroundStyle(color)
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(note.author.name)
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(t.text)
                    Text(AppDateFormatter.relativeVerbose(note.createdAt))
                        .font(.system(size: 10)).foregroundStyle(t.textMuted)
                }
                Text(note.body)
                    .font(.system(size: 12)).foregroundStyle(t.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(t.surface)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(t.border, lineWidth: 0.5))
        }
    }

    @ViewBuilder
    private func commentComposer(_ issue: GitLabIssue, t: Theme) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $commentDraft)
                    .font(.system(size: 13))
                    .frame(minHeight: 80, maxHeight: 160)
                    .padding(8)
                    .scrollContentBackground(.hidden)
                    .background(t.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(commentDraft.isEmpty ? t.border : t.accent.opacity(0.4), lineWidth: 1))
                if commentDraft.isEmpty {
                    Text("Leave a comment…")
                        .font(.system(size: 13)).foregroundStyle(t.textMuted)
                        .padding(EdgeInsets(top: 14, leading: 12, bottom: 0, trailing: 0))
                        .allowsHitTesting(false)
                }
            }
            HStack {
                Spacer()
                Button(commentBusy ? "Posting…" : "Comment") {
                    if let project { Task { await postComment(issue: issue, project: project) } }
                }
                .buttonStyle(.borderedProminent).controlSize(.regular)
                .disabled(commentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || commentBusy || project == nil)
            }
        }
    }

    // MARK: - Sidebar

    @ViewBuilder
    private func sidebarView(_ issue: GitLabIssue) -> some View {
        let t = theme.current
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // ── State ──────────────────────────────────────────────
                sidebarSection("Details") {
                    stateToggleButton(issue, t: t)

                    // Assignees (editable)
                    editableMetaRow(
                        icon: "person.2.fill",
                        label: "Assignees",
                        isSaving: savingAssignees,
                        t: t
                    ) {
                        Button {
                            pendingAssigneeIds = Set(issue.assignees.map { $0.id })
                            showAssigneePicker = true
                        } label: {
                            assigneeContent(issue, t: t)
                        }
                        .buttonStyle(.plain)
                        .popover(isPresented: $showAssigneePicker, arrowEdge: .trailing) {
                            assigneePickerPopover(issue)
                        }
                    }

                    // Milestone (editable)
                    editableMetaRow(
                        icon: "flag.fill",
                        label: "Milestone",
                        isSaving: savingMilestone,
                        t: t
                    ) {
                        Menu {
                            Button("None") { Task { await saveMilestone(nil, issue: issue) } }
                            if !milestones.isEmpty { Divider() }
                            ForEach(milestones) { m in
                                Button(m.title) { Task { await saveMilestone(m.id, issue: issue) } }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                if let ms = issue.milestone {
                                    Text(ms.title)
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(t.accent)
                                } else {
                                    Text("None").font(.system(size: 11)).foregroundStyle(t.textMuted)
                                }
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.system(size: 8)).foregroundStyle(t.textMuted)
                            }
                        }
                        .menuStyle(.borderlessButton)
                    }

                    // Due date (editable)
                    editableMetaRow(
                        icon: "calendar",
                        label: "Due date",
                        isSaving: savingDueDate,
                        t: t
                    ) {
                        Button {
                            if let d = issue.dueDate, let date = parseDateOnly(d) {
                                pendingDueDate = date
                            } else {
                                pendingDueDate = Date()
                            }
                            showDueDatePicker = true
                        } label: {
                            HStack(spacing: 4) {
                                if let due = issue.dueDate {
                                    Text(AppDateFormatter.dueDateDisplay(due))
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(AppDateFormatter.isDuePast(due) ? t.danger : t.text)
                                } else {
                                    Text("Set due date").font(.system(size: 11)).foregroundStyle(t.textMuted)
                                }
                                Image(systemName: "calendar.badge.plus")
                                    .font(.system(size: 9)).foregroundStyle(t.textMuted)
                            }
                        }
                        .buttonStyle(.plain)
                        .popover(isPresented: $showDueDatePicker, arrowEdge: .trailing) {
                            dueDatePickerPopover(issue)
                        }
                    }

                    // Author (read-only)
                    metaRow(icon: "person.circle.fill", label: "Author", t: t) {
                        HStack(spacing: 5) {
                            UserAvatar(user: issue.author, size: 18)
                            Text(issue.author.name)
                                .font(.system(size: 11, weight: .medium)).foregroundStyle(t.text)
                        }
                    }

                    if let weight = issue.weight {
                        metaRow(icon: "scalemass", label: "Weight", t: t) {
                            Text("\(weight)").font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(t.text)
                        }
                    }
                }

                Divider().background(t.border)

                // ── Labels (editable) ──────────────────────────────────
                sidebarSection("Labels") {
                    HStack(alignment: .top) {
                        FlowLayout(spacing: 5) {
                            if issue.labels.isEmpty {
                                Text("None").font(.system(size: 11)).foregroundStyle(t.textMuted)
                            } else {
                                ForEach(issue.labels, id: \.self) { lbl in LabelChip(name: lbl) }
                            }
                        }
                        Spacer(minLength: 4)
                        Button {
                            pendingLabels = issue.labels
                            showLabelPicker = true
                        } label: {
                            Image(systemName: "pencil").font(.system(size: 10)).foregroundStyle(t.textMuted)
                        }
                        .buttonStyle(.plain)
                        .popover(isPresented: $showLabelPicker, arrowEdge: .trailing) {
                            labelPickerPopover(issue)
                        }
                        if savingLabels { ProgressView().controlSize(.mini) }
                    }
                }

                Divider().background(t.border)

                // ── Dates ─────────────────────────────────────────────
                sidebarSection("Dates") {
                    metaRow(icon: "plus.circle", label: "Created", t: t) {
                        Text(AppDateFormatter.absoluteMedium(issue.createdAt))
                            .font(.system(size: 11)).foregroundStyle(t.textMuted)
                    }
                    metaRow(icon: "pencil.circle", label: "Updated", t: t) {
                        Text(AppDateFormatter.absoluteMedium(issue.updatedAt))
                            .font(.system(size: 11)).foregroundStyle(t.textMuted)
                    }
                    if let closed = issue.closedAt {
                        metaRow(icon: "checkmark.circle", label: "Closed", t: t) {
                            Text(AppDateFormatter.absoluteMedium(closed))
                                .font(.system(size: 11)).foregroundStyle(t.textMuted)
                        }
                    }
                }

                Divider().background(t.border)

                // ── Reactions ─────────────────────────────────────────
                sidebarSection("Reactions") {
                    HStack(spacing: 14) {
                        reactionChip(icon: "hand.thumbsup", count: issue.upvotes, t: t)
                        reactionChip(icon: "hand.thumbsdown", count: issue.downvotes, t: t)
                    }
                }
            }
        }
        .frame(width: 230)
        .background(theme.current.surface)
    }

    @ViewBuilder
    private func stateToggleButton(_ issue: GitLabIssue, t: Theme) -> some View {
        let isOpen = issue.isOpen
        let color: Color = isOpen ? t.danger : t.accent3
        Button {
            if let project { Task { await toggleState(issue: issue, project: project) } }
        } label: {
            HStack(spacing: 6) {
                if savingState {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: isOpen ? "xmark.circle" : "arrow.uturn.left.circle")
                        .font(.system(size: 12))
                }
                Text(isOpen ? "Close issue" : "Reopen issue")
                    .font(.system(size: 12, weight: .medium))
                Spacer()
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(color)
        .padding(9)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(color.opacity(0.2), lineWidth: 1))
        .disabled(savingState || project == nil)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private func assigneeContent(_ issue: GitLabIssue, t: Theme) -> some View {
        if issue.assignees.isEmpty {
            HStack(spacing: 4) {
                Text("Assign").font(.system(size: 11)).foregroundStyle(t.textMuted)
                Image(systemName: "person.badge.plus").font(.system(size: 10)).foregroundStyle(t.textMuted)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(issue.assignees) { a in
                    HStack(spacing: 5) {
                        UserAvatar(user: a, size: 18)
                        Text(a.name).font(.system(size: 11, weight: .medium)).foregroundStyle(t.text).lineLimit(1)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func reactionChip(icon: String, count: Int, t: Theme) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 11)).foregroundStyle(t.textMuted)
            Text("\(count)").font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(t.textMuted)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(t.surface2)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // MARK: - Popovers

    @ViewBuilder
    private func labelPickerPopover(_ issue: GitLabIssue) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 12) {
            Text("Labels").font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(labels) { lbl in
                        let on = pendingLabels.contains(lbl.name)
                        let color = Color(hex: lbl.color) ?? t.accent
                        Button {
                            if on { pendingLabels.removeAll { $0 == lbl.name } }
                            else  { pendingLabels.append(lbl.name) }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: on ? "checkmark.square.fill" : "square")
                                    .font(.system(size: 13))
                                    .foregroundStyle(on ? color : t.textMuted)
                                Circle().fill(color).frame(width: 8, height: 8)
                                Text(lbl.name).font(.system(size: 12))
                                    .foregroundStyle(t.text)
                                    .lineLimit(1)
                                Spacer()
                            }
                            .padding(.horizontal, 6).padding(.vertical, 4)
                            .background(on ? color.opacity(0.08) : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 280)

            HStack {
                Button("Cancel") { showLabelPicker = false }
                    .buttonStyle(.bordered).controlSize(.small)
                Spacer()
                Button("Apply") {
                    showLabelPicker = false
                    if let project { Task { await saveLabels(pendingLabels, issue: issue, project: project) } }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                .disabled(savingLabels)
            }
        }
        .padding(14)
        .frame(width: 260)
        .background(t.surface)
        .environmentObject(theme)
    }

    @ViewBuilder
    private func assigneePickerPopover(_ issue: GitLabIssue) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 12) {
            Text("Assignees").font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(members) { m in
                        let on = pendingAssigneeIds.contains(m.id)
                        Button {
                            if on { pendingAssigneeIds.remove(m.id) }
                            else  { pendingAssigneeIds.insert(m.id) }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 13))
                                    .foregroundStyle(on ? t.accent : t.textMuted)
                                UserAvatar(user: m, size: 20)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(m.name).font(.system(size: 12, weight: .medium)).foregroundStyle(t.text)
                                    Text("@\(m.username)").font(.system(size: 10)).foregroundStyle(t.textMuted)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 6).padding(.vertical, 4)
                            .background(on ? t.accent.opacity(0.08) : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxHeight: 260)

            HStack {
                Button("Cancel") { showAssigneePicker = false }
                    .buttonStyle(.bordered).controlSize(.small)
                Spacer()
                Button("Apply") {
                    showAssigneePicker = false
                    if let project {
                        Task { await saveAssignees(Array(pendingAssigneeIds), issue: issue, project: project) }
                    }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
                .disabled(savingAssignees)
            }
        }
        .padding(14)
        .frame(width: 260)
        .background(t.surface)
        .environmentObject(theme)
    }

    @ViewBuilder
    private func dueDatePickerPopover(_ issue: GitLabIssue) -> some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 14) {
            Text("Due date").font(.headline)
            DatePicker("", selection: Binding(
                get: { pendingDueDate ?? Date() },
                set: { pendingDueDate = $0 }
            ), displayedComponents: .date)
            .datePickerStyle(.graphical)
            .labelsHidden()

            HStack {
                if issue.dueDate != nil {
                    Button("Remove") {
                        showDueDatePicker = false
                        if let project { Task { await saveDueDate(nil, issue: issue, project: project) } }
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .foregroundStyle(t.danger)
                }
                Spacer()
                Button("Cancel") { showDueDatePicker = false }
                    .buttonStyle(.bordered).controlSize(.small)
                Button("Set") {
                    showDueDatePicker = false
                    if let project { Task { await saveDueDate(pendingDueDate, issue: issue, project: project) } }
                }
                .buttonStyle(.borderedProminent).controlSize(.small)
            }
        }
        .padding(16)
        .frame(width: 300)
        .background(t.surface)
        .environmentObject(theme)
    }

    // MARK: - Layout helpers

    private func sectionLabel(_ text: String) -> some View {
        SectionLabel(text)
    }

    @ViewBuilder
    private func sidebarSection<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(title)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func metaRow<C: View>(icon: String, label: String, t: Theme, @ViewBuilder value: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 9)).foregroundStyle(t.textMuted)
                Text(label).font(.system(size: 10)).foregroundStyle(t.textMuted)
            }
            value().padding(.leading, 2)
        }
    }

    @ViewBuilder
    private func editableMetaRow<C: View>(
        icon: String, label: String, isSaving: Bool, t: Theme,
        @ViewBuilder value: () -> C
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 9)).foregroundStyle(t.textMuted)
                Text(label).font(.system(size: 10)).foregroundStyle(t.textMuted)
                if isSaving { ProgressView().controlSize(.mini).scaleEffect(0.7) }
            }
            value().padding(.leading, 2)
        }
    }

    // MARK: - State management

    private func resetEditState(_ issue: GitLabIssue) {
        editingTitle = false
        editingDescription = false
        showLabelPicker = false
        showAssigneePicker = false
        showDueDatePicker = false
        saveError = nil
    }

    private func startEditTitle(_ issue: GitLabIssue) {
        titleDraft = issue.title
        editingTitle = true
        titleFocused = true
    }

    // MARK: - Data loading

    private func loadNotes(_ issue: GitLabIssue) async {
        guard let project else { return }
        notesLoading = true
        defer { notesLoading = false }
        notes = (try? await gitlab.listNotes(projectId: project.id, iid: issue.iid)) ?? []
    }

    // MARK: - Save helpers

    private func saveTitle(_ issue: GitLabIssue) async {
        let t = titleDraft.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, let project else { editingTitle = false; return }
        savingTitle = true; saveError = nil; defer { savingTitle = false }
        do {
            let payload = GitLabIssuePayload(title: t)
            let updated = try await gitlab.updateIssue(projectId: project.id, iid: issue.iid, payload: payload)
            editingTitle = false
            onUpdate(updated)
        } catch { saveError = error.localizedDescription }
    }

    private func saveDescription(_ issue: GitLabIssue) async {
        guard let project else { editingDescription = false; return }
        savingDescription = true; saveError = nil; defer { savingDescription = false }
        do {
            let payload = GitLabIssuePayload(title: issue.title, description: descDraft.isEmpty ? nil : descDraft)
            let updated = try await gitlab.updateIssue(projectId: project.id, iid: issue.iid, payload: payload)
            editingDescription = false
            onUpdate(updated)
        } catch { saveError = error.localizedDescription }
    }

    private func saveLabels(_ lbls: [String], issue: GitLabIssue, project: GitLabProject) async {
        savingLabels = true; saveError = nil; defer { savingLabels = false }
        do {
            let payload = GitLabIssuePayload(title: issue.title, labels: lbls.joined(separator: ","))
            let updated = try await gitlab.updateIssue(projectId: project.id, iid: issue.iid, payload: payload)
            onUpdate(updated)
        } catch { saveError = error.localizedDescription }
    }

    private func saveAssignees(_ ids: [Int], issue: GitLabIssue, project: GitLabProject) async {
        savingAssignees = true; saveError = nil; defer { savingAssignees = false }
        do {
            let payload = GitLabIssuePayload(title: issue.title, assigneeIds: ids)
            let updated = try await gitlab.updateIssue(projectId: project.id, iid: issue.iid, payload: payload)
            onUpdate(updated)
        } catch { saveError = error.localizedDescription }
    }

    private func saveMilestone(_ id: Int?, issue: GitLabIssue) async {
        guard let project else { return }
        savingMilestone = true; saveError = nil; defer { savingMilestone = false }
        do {
            // GitLab clears the milestone when milestone_id == 0. Passing nil would
            // omit the key entirely (Swift's encodeIfPresent behaviour), leaving the
            // existing milestone unchanged.
            let payload = GitLabIssuePayload(title: issue.title, milestoneId: id ?? 0)
            let updated = try await gitlab.updateIssue(projectId: project.id, iid: issue.iid, payload: payload)
            onUpdate(updated)
        } catch { saveError = error.localizedDescription }
    }

    private func saveDueDate(_ date: Date?, issue: GitLabIssue, project: GitLabProject) async {
        savingDueDate = true; saveError = nil; defer { savingDueDate = false }
        let str: String?
        if let d = date {
            str = AppDateFormatter.dateOnly(d)
        } else { str = "" }
        do {
            let payload = GitLabIssuePayload(title: issue.title, dueDate: str)
            let updated = try await gitlab.updateIssue(projectId: project.id, iid: issue.iid, payload: payload)
            onUpdate(updated)
        } catch { saveError = error.localizedDescription }
    }

    private func toggleState(issue: GitLabIssue, project: GitLabProject) async {
        savingState = true; defer { savingState = false }
        do {
            let payload = GitLabIssuePayload(
                title: issue.title,
                stateEvent: issue.isOpen ? "close" : "reopen"
            )
            let updated = try await gitlab.updateIssue(projectId: project.id, iid: issue.iid, payload: payload)
            onUpdate(updated)
        } catch { saveError = error.localizedDescription }
    }

    private func postComment(issue: GitLabIssue, project: GitLabProject) async {
        let text = commentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        commentBusy = true; defer { commentBusy = false }
        do {
            let note = try await gitlab.createNote(projectId: project.id, iid: issue.iid, body: text)
            notes.append(note); commentDraft = ""
        } catch { saveError = error.localizedDescription }
    }

    private func parseDateOnly(_ s: String) -> Date? {
        AppDateFormatter.parseDateOnly(s)
    }
}
