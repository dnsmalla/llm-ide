import SwiftUI
import SharedProtocol

/// Loop: Factory runs started from this phone for open issues. Each run waits for the desktop's approval, then the
/// desktop works in an isolated worktree and stops at "Ready to ship" (shipping is a desktop click).
struct LoopView: View {
    @EnvironmentObject var loop: LoopStore
    @EnvironmentObject var projects: ProjectsStore
    @EnvironmentObject var connection: ConnectionService
    @State private var picking = false

    private func isActive(_ state: String) -> Bool { ["awaiting_approval", "queued", "running"].contains(state) }

    private func label(_ state: String) -> String {
        switch state {
        case "awaiting_approval": return "Waiting for desktop approval"
        case "queued": return "Queued"
        case "running": return "Running"
        case "succeeded": return "Finished"
        case "failed": return "Failed"
        case "cancelled": return "Cancelled"
        case "interrupted": return "Interrupted"
        case "denied": return "Denied on desktop"
        case "expired": return "Expired"
        default: return state
        }
    }

    var body: some View {
        List {
            if let error = loop.error {
                Section { Text(error).foregroundColor(DesignSystem.Colors.danger) }
            }
            if projects.selectedId == nil {
                Section {
                    Text(projects.state.loaded && projects.state.projects.isEmpty
                         ? "No project is registered on the desktop yet. Open a project in the desktop app first."
                         : "Choose a project on the Chat tab first.")
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }
            } else if loop.runs.isEmpty {
                Section {
                    Text("No runs from this phone yet.").foregroundColor(DesignSystem.Colors.textSecondary)
                    Text("Start one for open issues; approve it on the desktop.").font(.caption).foregroundColor(DesignSystem.Colors.textTertiary)
                }
            }
            ForEach(loop.runs, id: \.id) { run in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("\(run.issueCount) issue\(run.issueCount == 1 ? "" : "s")").font(.body.weight(.medium))
                        Spacer()
                        Text(label(run.state)).font(.caption)
                            .foregroundColor(run.state == "succeeded" ? .green : ["failed", "denied", "expired"].contains(run.state) ? .red : .secondary)
                    }
                    if let step = run.step, isActive(run.state) { Text(step).font(.caption).foregroundColor(DesignSystem.Colors.textSecondary) }
                    if run.readyToShip == true { Text("Ready to ship on the desktop").font(.caption).foregroundColor(.green) }
                    if let summary = run.summary, !summary.isEmpty { Text(summary).font(.caption) }
                    if isActive(run.state) {
                        Button("Cancel", role: .destructive) { Task { await loop.cancel(run, projectId: projects.selectedId) } }
                            .font(.caption)
                    }
                }
            }
            if !loop.history.isEmpty {
                Section("Desktop Loop history") {
                    ForEach(loop.history, id: \.id) { h in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(h.loopName).font(.body.weight(.medium))
                                Spacer()
                                Text(h.statusCode).font(.caption)
                                    .foregroundColor(h.statusCode == "success" ? .green : h.statusCode.isEmpty ? .secondary : .red)
                            }
                            Text(h.startedAt).font(.caption2).foregroundColor(DesignSystem.Colors.textTertiary)
                            if let summary = h.statusSummary, !summary.isEmpty { Text(summary).font(.caption).foregroundColor(DesignSystem.Colors.textSecondary) }
                        }
                    }
                }
            }
        }
        .navigationTitle("Loop")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { picking = true } label: { Image(systemName: "plus") }
                    .disabled(projects.selectedId == nil || connection.connectionStatus != .connected)
                    .accessibilityLabel("Start a run")
            }
        }
        .sheet(isPresented: $picking) {
            IssuePickerSheet(projectId: projects.selectedId)
        }
        // Poll while the tab is on screen; the task ends when it leaves.
        .task(id: projects.selectedId) {
            while !Task.isCancelled {
                await loop.refresh(projectId: projects.selectedId)
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
        .refreshable { await loop.refresh(projectId: projects.selectedId) }
    }
}

private struct IssuePickerSheet: View {
    let projectId: String?
    @EnvironmentObject var loop: LoopStore
    @Environment(\.dismiss) private var dismiss
    @State private var chosen: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                if loop.loading && loop.issues.isEmpty { ProgressView("Loading issues…") }
                else if loop.issues.isEmpty {
                    Text("No open issues are cached on the desktop. Sync issues there first.").foregroundColor(DesignSystem.Colors.textSecondary)
                }
                ForEach(loop.issues, id: \.id) { issue in
                    Button {
                        if chosen.contains(issue.id) { chosen.remove(issue.id) } else if chosen.count < 20 { chosen.insert(issue.id) }
                    } label: {
                        HStack {
                            Image(systemName: chosen.contains(issue.id) ? "checkmark.circle.fill" : "circle")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(issue.title).font(.body)
                                Text([issue.repo, issue.number.map { "#\($0)" }].compactMap { $0 }.joined(separator: " "))
                                    .font(.caption).foregroundColor(DesignSystem.Colors.textSecondary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .navigationTitle("Pick issues")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start (\(chosen.count))") {
                        guard let projectId else { return }
                        Task { if await loop.start(issueIds: Array(chosen), projectId: projectId) { dismiss() } }
                    }
                    .disabled(chosen.isEmpty || projectId == nil)
                }
            }
            .task { await loop.loadIssues(projectId: projectId) }
        }
    }
}
