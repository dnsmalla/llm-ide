import SwiftUI
import AppKit

/// Launcher sheet for the `trigger-review-code` write tool.
///
/// Lets the user review (and tweak) the agent-proposed plan, then
/// hands off to `CodeWorkflowSheet` with the issue + plan pre-filled
/// so the workflow starts at the Create-Branch step.
struct TriggerReviewCodeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var config: AppConfig

    let plan: String
    let iid: Int
    let issueTitle: String?
    let api: LlmIdeAPIClient

    @State private var editedPlan: String = ""
    @State private var presentingWorkflow: Bool = false
    @State private var presentingQuickFix: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Review code for #\(iid)").font(.title3.bold())
            Divider()

            VStack(alignment: .leading, spacing: 12) {
                field(label: "Issue") {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("#\(iid)\(issueTitle.map { " — \($0)" } ?? "")")
                            .font(.system(size: 12, weight: .medium))
                        Text("The Review Code workflow will attach a branch and MR to this issue.")
                            .font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                }
                field(label: "Plan") {
                    TextEditor(text: $editedPlan)
                        .font(.system(size: 12, design: .monospaced))
                        .frame(minHeight: 180, maxHeight: 320)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
                }
                if let proj = activeProject {
                    field(label: "Project") {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(proj.displayName.isEmpty ? "project" : proj.displayName)
                                .font(.system(size: 12, weight: .medium))
                            Text(proj.url).font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if activeProject == nil {
                Text("No active GitLab project. Add one in Settings → GitLab.")
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                let isShort = editedPlan.count < 300
                Menu {
                    Button {
                        presentingQuickFix = true
                    } label: {
                        Label("Quick Fix\(isShort ? " (recommended)" : "")",
                              systemImage: "bolt.fill")
                    }
                    Button {
                        presentingWorkflow = true
                    } label: {
                        Label("Guided", systemImage: "list.bullet.rectangle")
                    }
                } label: {
                    Text("Start Code Update")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(activeProject == nil || editedPlan.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 560)
        .onAppear {
            if editedPlan.isEmpty { editedPlan = plan }
        }
        .sheet(isPresented: $presentingWorkflow, onDismiss: { dismiss() }) {
            if let proj = activeProject {
                CodeWorkflowSheet(
                    api: api,
                    project: proj,
                    prefill: (number: iid, plan: editedPlan)
                )
                .environmentObject(config)
            }
        }
        .sheet(isPresented: $presentingQuickFix, onDismiss: { dismiss() }) {
            if let proj = activeProject {
                QuickFixSheet(
                    api: api,
                    project: proj,
                    prefill: (number: iid, plan: editedPlan)
                )
                .environmentObject(config)
            }
        }
    }

    private var activeProject: SavedGitLabProject? {
        config.gitLabSavedProjects.first(where: { $0.isActive })
    }

    @ViewBuilder
    private func field<Content: View>(label: String, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 80, alignment: .trailing)
                .foregroundStyle(.secondary)
            content()
        }
    }
}
