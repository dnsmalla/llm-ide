import SwiftUI

/// Phase 2 review panel: lists the open to-dos extracted from email notes,
/// lets the user pick a target repo and file selected to-dos as issues.
/// Issue creation goes through the allow-listed repo backend (a disabled
/// `createIssue` greys the button); on success the note's `issue:` frontmatter
/// is stamped so the to-do drops off this list.
struct EmailTodosView: View {
    @Environment(AppEnvironment.self) private var env
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var theme: ThemeStore

    @StateObject private var vm = EmailTodosViewModel()
    @State private var creating = false

    private var notesRoot: URL { env.notesConfig.currentFolder }
    private var targets: [IssueTargetOption] { IssueTargetOptions.all(config: config) }

    /// A group of open to-dos from one source email note.
    private var grouped: [(key: String, todos: [OpenTodo])] {
        Dictionary(grouping: vm.open, by: { "\($0.subject) — \($0.from)" })
            .map { (key: $0.key, todos: $0.value) }
            .sorted { $0.key < $1.key }
    }

    private var createAllowed: Bool {
        guard let t = vm.target else { return false }
        return config.isAllowed(.createIssue, provider: t.kind)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Email To-dos")
                .font(Typography.title)
                .padding(Spacing.lg)
            Divider()

            if vm.open.isEmpty {
                ContentUnavailableView {
                    Label("No open to-dos", systemImage: "checklist")
                } description: {
                    Text("Fetch email to extract to-dos — action items appear here to file as issues.")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                list
            }

            Divider()
            footer
        }
        .background(theme.current.body)
        .onAppear {
            vm.reload(notesRoot: notesRoot)
            if vm.target == nil {
                vm.target = targets.first(where: \.isActive) ?? targets.first
            }
        }
    }

    // MARK: - List

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                ForEach(grouped, id: \.key) { group in
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        Text(group.key)
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                        ForEach(group.todos) { todo in
                            todoRow(todo)
                        }
                    }
                }
            }
            .padding(Spacing.lg)
        }
    }

    private func todoRow(_ todo: OpenTodo) -> some View {
        Toggle(isOn: Binding(
            get: { vm.selected.contains(todo.id) },
            set: { on in
                if on { vm.selected.insert(todo.id) } else { vm.selected.remove(todo.id) }
            }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text(todo.title).font(Typography.body)
                if !todo.detail.isEmpty {
                    Text(todo.detail)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: Spacing.sm) {
                    if let due = todo.due {
                        Label(due, systemImage: "calendar").font(Typography.caption)
                    }
                    Text(todo.priority)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
        }
        .toggleStyle(.checkbox)
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.md) {
                Picker("Repo", selection: $vm.target) {
                    if targets.isEmpty {
                        Text("No repos configured").tag(Optional<IssueTargetOption>.none)
                    }
                    ForEach(targets) { t in
                        Text(t.label).tag(Optional(t))
                    }
                }
                .frame(maxWidth: 320)

                Spacer()

                Button(creating ? "Creating…" : "Create issues") {
                    Task {
                        creating = true
                        await vm.createSelected(config: config, notesRoot: notesRoot)
                        vm.selected.removeAll()
                        creating = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(vm.selected.isEmpty || vm.target == nil || !createAllowed || creating)
            }

            if vm.target != nil && !createAllowed {
                Text("Creating issues is disabled for this provider — enable it in the repo's operations allow-list.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
            }
            if let status = vm.status {
                Text(status)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Spacing.lg)
    }
}
