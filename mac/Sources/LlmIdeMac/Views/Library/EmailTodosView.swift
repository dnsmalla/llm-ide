import SwiftUI

struct EmailTodosView: View {
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var theme: ThemeStore
    @State private var vm = EmailTodosViewModel()

    private var emailsRoot: URL? {
        guard let project = projectStore.activeProject else { return nil }
        return ProjectLayout(root: URL(fileURLWithPath: project.localPath)).notesDir
            .appendingPathComponent("emails", isDirectory: true)
    }

    private var targetOptions: [IssueTargetOption] {
        IssueTargetOptions.all(config: config)
    }

    private var createAllowed: Bool {
        guard let target = vm.target else { return false }
        return config.isAllowed(.createIssue, provider: target.kind)
    }

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: 0) {
            header(t: t)
            Divider()
            content(t: t)
        }
        .background(t.body)
        .onAppear { refresh() }
        .onChange(of: projectStore.activeProject?.localPath) { _, _ in refresh() }
    }

    @ViewBuilder
    private func header(t: Theme) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Email To-dos")
                .font(Typography.title)
                .foregroundStyle(t.text)
            Text("Open action items extracted from generated email notes. Creating an issue writes the URL back into the note.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
            if targetOptions.isEmpty {
                Text("Connect GitLab or GitHub in Settings to create issues.")
                    .font(Typography.caption)
                    .foregroundStyle(t.danger)
            } else {
                Picker("Target repo", selection: $vm.target) {
                    Text("Choose a repo…").tag(IssueTargetOption?.none)
                    ForEach(targetOptions) { option in
                        Text(option.label).tag(IssueTargetOption?.some(option))
                    }
                }
                .labelsHidden()
            }
        }
        .padding(Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(t.surface)
    }

    @ViewBuilder
    private func content(t: Theme) -> some View {
        if projectStore.activeProject == nil {
            ContentUnavailableView {
                Label("No Project Open", systemImage: "folder.badge.questionmark")
            } description: {
                Text("Open a project to review email to-dos from its llm-doc/emails folder.")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if vm.open.isEmpty {
            ContentUnavailableView {
                Label("No Open To-dos", systemImage: "checklist")
            } description: {
                Text("Fetch actionable email in Settings → Connections, or add notes under llm-doc/emails/.")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List(vm.open) { todo in
                todoRow(todo, t: t)
            }
            .listStyle(.inset(alternatesRowBackgrounds: true))
        }

        footer(t: t)
    }

    @ViewBuilder
    private func todoRow(_ todo: OpenTodo, t: Theme) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Toggle(isOn: binding(for: todo.id)) {
                EmptyView()
            }
            .toggleStyle(.checkbox)
            VStack(alignment: .leading, spacing: 4) {
                Text(todo.title)
                    .font(Typography.bodyStrong)
                if !todo.detail.isEmpty {
                    Text(todo.detail)
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                }
                HStack(spacing: 8) {
                    Text(todo.from).font(Typography.caption).foregroundStyle(t.textMuted)
                    Text("·").foregroundStyle(t.textMuted)
                    Text(todo.subject).font(Typography.caption).foregroundStyle(t.textMuted)
                    if let due = todo.due, !due.isEmpty {
                        Text("· due \(due)").font(Typography.caption).foregroundStyle(t.accent2)
                    }
                    Text("· \(todo.priority)").font(Typography.caption).foregroundStyle(t.textMuted)
                }
                Button("Show note") {
                    NSWorkspace.shared.activateFileViewerSelecting([todo.file])
                }
                .buttonStyle(.link)
                .font(Typography.caption)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func footer(t: Theme) -> some View {
        HStack(spacing: 12) {
            Button {
                guard let root = emailsRoot else { return }
                Task { await vm.createSelected(config: config, emailsRoot: root) }
            } label: {
                if vm.busy {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Create issues")
                }
            }
            .disabled(vm.selected.isEmpty || vm.target == nil || !createAllowed || vm.busy || emailsRoot == nil)
            .help(createAllowed
                  ? "Create issues for the selected to-dos"
                  : "Enable Create issue in Settings → \(vm.target?.kind.displayName ?? "GitLab/GitHub") → Automation & Actions")

            if let status = vm.status {
                Text(status)
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .lineLimit(3)
            }
            Spacer()
            Button("Refresh") { refresh() }
                .disabled(emailsRoot == nil)
        }
        .padding(Spacing.lg)
        .background(t.surface)
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding(
            get: { vm.selected.contains(id) },
            set: { on in
                if on { vm.selected.insert(id) } else { vm.selected.remove(id) }
            }
        )
    }

    private func refresh() {
        guard let root = emailsRoot else {
            vm.clear()
            return
        }
        vm.reload(emailsRoot: root)
        if vm.target == nil {
            vm.target = targetOptions.first(where: \.isActive) ?? targetOptions.first
        }
    }
}
