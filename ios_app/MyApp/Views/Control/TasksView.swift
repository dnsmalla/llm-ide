import SwiftUI
import SharedProtocol

/// Auto Tasks: the desktop registry, with one Run button per task and the returned status/output.
struct TasksView: View {
    @EnvironmentObject var tasks: TasksStore
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var projects: ProjectsStore

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
            if tasks.tasks.isEmpty && !tasks.loading {
                Section { Text("No tasks are available on this desktop.").foregroundColor(DesignSystem.Colors.textSecondary) }
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
                                    Task { await tasks.run(task, projectId: projects.selectedId) }
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
        .navigationTitle("Auto Tasks")
        .task { await tasks.refresh() }
        .refreshable { await tasks.refresh() }
    }
}
