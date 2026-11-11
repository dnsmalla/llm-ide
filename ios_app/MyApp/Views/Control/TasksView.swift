import SwiftUI
import SharedProtocol

/// Auto Tasks: the desktop registry, with one Run button per task and the returned status/output.
struct TasksView: View {
    @EnvironmentObject var tasks: TasksStore
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var projects: ProjectsStore
    @State private var running: HostApiTasksListResultTasksItem?

    private var grouped: [(String, [HostApiTasksListResultTasksItem])] {
        Dictionary(grouping: tasks.tasks, by: \.group)
            .map { ($0.key, $0.value.sorted { $0.label < $1.label }) }
            .sorted { $0.0 < $1.0 }
    }

    var body: some View {
        List {
            if let error = tasks.error {
                Section { Text(error).foregroundColor(DesignSystem.Colors.danger) }
            }
            if tasks.loading && tasks.tasks.isEmpty {
                Section { ProgressView("Loading tasks…") }
            } else if tasks.tasks.isEmpty {
                Section {
                    Text("No tasks are available on this desktop.").foregroundColor(DesignSystem.Colors.textSecondary)
                    Text("Update the desktop and check that Read + Compose are enabled in Phone and browser.").font(.caption).foregroundColor(DesignSystem.Colors.textTertiary)
                    Button("Refresh") { Task { await tasks.refresh() } }
                }
            }
            ForEach(grouped, id: \.0) { group, items in
                Section(group) {
                    ForEach(items, id: \.id) { task in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(task.label).font(.body.weight(.medium))
                                    Text(task.description).font(.caption).foregroundColor(DesignSystem.Colors.textSecondary)
                                }
                                Spacer()
                                Button("Run") {
                                    running = task
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(!task.available || !(projects.selectedId != nil || task.scope != "project"))
                            }
                            if !task.available {
                                Text("Not available on this desktop").font(.caption2).foregroundColor(DesignSystem.Colors.textTertiary)
                            }
                        }
                    }
                }
            }
            if !tasks.runs.isEmpty {
                Section("Recent runs") {
                    ForEach(tasks.runs) { run in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(run.taskLabel).font(.body.weight(.medium))
                                Spacer()
                                Text(run.status).font(.caption).foregroundColor(run.status == "completed" ? .green : run.status == "failed" ? .red : .secondary)
                                if run.status == "running" {
                                    Button("Cancel") { Task { await tasks.cancel(run) } }
                                }
                            }
                            if let summary = run.summary { Text(summary).font(.caption) }
                            if let error = run.error { Text(error).font(.caption).foregroundColor(DesignSystem.Colors.danger) }
                            if let output = run.output {
                                DisclosureGroup("Output") {
                                    Text(output).font(.caption.monospaced()).textSelection(.enabled)
                                }
                            }
                        }
                    }
                }
            }
        }
        .sheet(item: $running) { task in
            TaskRunSheet(task: task, projectId: projects.selectedId) { args in
                Task { await tasks.run(task, projectId: projects.selectedId, args: args) }
            }
        }
        .navigationTitle("Auto Tasks")
        .task { await tasks.refresh() }
        .refreshable { await tasks.refresh() }
    }
}


extension HostApiTasksListResultTasksItem: @retroactive Identifiable {}

private struct TaskRunSheet: View {
    let task: HostApiTasksListResultTasksItem
    let projectId: String?
    let onRun: ([String: String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: String] = [:]

    var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    Text(task.label).font(.headline)
                    Text(task.description).font(.caption).foregroundColor(.secondary)
                }
                if let args = task.args, !args.isEmpty {
                    Section("Arguments") {
                        ForEach(args, id: \.name) { arg in
                            TextField(arg.name, text: Binding(
                                get: { values[arg.name] ?? "" },
                                set: { values[arg.name] = $0 }
                            ))
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                        }
                    }
                }
                Section {
                    Button("Run on desktop") {
                        onRun(values.filter { !$0.value.isEmpty })
                        dismiss()
                    }
                    .disabled(projectId == nil && task.scope == "project")
                }
            }
            .navigationTitle("Run task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
