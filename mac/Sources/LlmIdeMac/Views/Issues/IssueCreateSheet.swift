import SwiftUI

/// Sheet for creating a new issue in the selected project.
struct IssueCreateSheet: View {
    let gitlab: GitLabClient
    let project: GitLabProject
    let labels: [GitLabLabel]
    let milestones: [GitLabMilestone]
    let members: [GitLabUser]
    let onCreate: (GitLabIssue) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(ActivityStore.self) private var activity
    @EnvironmentObject var theme: ThemeStore

    @State private var title = ""
    @State private var description = ""
    @State private var selectedLabels: [String] = []
    @State private var selectedMilestoneId: Int? = nil
    @State private var selectedAssigneeIds: [Int] = []
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("New Issue")
                        .font(Typography.title)
                        .foregroundStyle(theme.current.text)
                    Text(project.nameWithNamespace)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(theme.current.textMuted)
                }
                .buttonStyle(.plain)
            }

            Divider().background(theme.current.border)

            // Title
            VStack(alignment: .leading, spacing: Spacing.xs) {
                SectionLabel("Title *", size: 11)
                TextField("Issue title", text: $title)
                    .textFieldStyle(.roundedBorder)
            }

            // Description
            VStack(alignment: .leading, spacing: Spacing.xs) {
                SectionLabel("Description", size: 11)
                TextEditor(text: $description)
                    .font(Typography.body)
                    .frame(minHeight: 100, maxHeight: 200)
                    .padding(6)
                    .background(theme.current.surface)
                    .cornerRadius(Radius.sm)
                    .overlay(RoundedRectangle(cornerRadius: Radius.sm)
                                .strokeBorder(theme.current.border, lineWidth: 0.5))
                    .overlay(
                        Group {
                            if description.isEmpty {
                                Text("Describe the issue…")
                                    .font(Typography.body)
                                    .foregroundStyle(theme.current.textMuted)
                                    .padding(10)
                                    .allowsHitTesting(false)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                            }
                        }
                    )
            }

            // Labels
            if !labels.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    SectionLabel("Labels", size: 11)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Spacing.xs) {
                            ForEach(labels) { lbl in
                                let on = selectedLabels.contains(lbl.name)
                                Button {
                                    if on { selectedLabels.removeAll { $0 == lbl.name } }
                                    else { selectedLabels.append(lbl.name) }
                                } label: {
                                    LabelChip(name: lbl.name, color: Color(hex: lbl.color))
                                        .opacity(on ? 1.0 : 0.5)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }

            // Milestone
            if !milestones.isEmpty {
                HStack(spacing: Spacing.md) {
                    SectionLabel("Milestone", size: 11)
                    Picker("", selection: Binding(
                        get: { selectedMilestoneId },
                        set: { selectedMilestoneId = $0 }
                    )) {
                        Text("None").tag(Optional<Int>.none)
                        ForEach(milestones) { m in
                            Text(m.title).tag(Optional(m.id))
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                }
            }

            // Assignees
            if !members.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    SectionLabel("Assignees", size: 11)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Spacing.xs) {
                            ForEach(members) { member in
                                let on = selectedAssigneeIds.contains(member.id)
                                Button {
                                    if on { selectedAssigneeIds.removeAll { $0 == member.id } }
                                    else  { selectedAssigneeIds.append(member.id) }
                                } label: {
                                    HStack(spacing: 4) {
                                        UserAvatar(user: member, size: 18)
                                        Text(member.name)
                                            .font(Typography.caption)
                                            .foregroundStyle(on ? theme.current.text : theme.current.textMuted)
                                    }
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(on ? theme.current.accent.opacity(0.12) : theme.current.surface2)
                                    .clipShape(Capsule())
                                    .overlay(Capsule().strokeBorder(
                                        on ? theme.current.accent.opacity(0.4) : Color.clear, lineWidth: 1))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }

            if let err = error {
                Text(err)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider().background(theme.current.border)

            HStack {
                Button("Cancel") { dismiss() }
                    .buttonStyle(.bordered)
                    .disabled(busy)
                Spacer()
                Button {
                    Task { await submit() }
                } label: {
                    if busy {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Creating…") }
                    } else {
                        Text("Create issue")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(Spacing.xl)
        .frame(width: 520)
        .background(theme.current.body)
    }

    private func submit() async {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let payload = GitLabIssuePayload(
                title: t,
                description: description.isEmpty ? nil : description,
                labels: selectedLabels.isEmpty ? nil : selectedLabels.joined(separator: ","),
                milestoneId: selectedMilestoneId,
                assigneeIds: selectedAssigneeIds.isEmpty ? nil : selectedAssigneeIds
            )
            let created = try await gitlab.createIssue(projectId: project.id, payload: payload)
            activity.report(
                kind: .issueCreated,
                title: "Issue created — \(created.title)",
                detail: ["title": created.title, "number": created.iid, "url": created.webUrl],
                link: created.webUrl
            )
            onCreate(created)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
