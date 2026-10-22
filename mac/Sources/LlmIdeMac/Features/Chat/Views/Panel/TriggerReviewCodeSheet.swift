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
                if let target = activeTarget {
                    field(label: "Project") {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(target.displayName.isEmpty ? "project" : target.displayName)
                                .font(.system(size: 12, weight: .medium))
                            Label(target.kind.displayName, systemImage: target.kind.sfSymbol)
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if activeTarget == nil {
                Text("No active, cloned repo. Add and clone one in Settings → GitLab or GitHub.")
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
                .disabled(!CodeWorkflowTarget.hasActive(config: config)
                          || editedPlan.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 560)
        .onAppear {
            if editedPlan.isEmpty { editedPlan = plan }
        }
        .sheet(isPresented: $presentingWorkflow, onDismiss: { dismiss() }) {
            if let target = activeTarget {
                CodeWorkflowSheet(
                    api: api,
                    target: target,
                    prefill: (number: iid, plan: editedPlan)
                )
                .environmentObject(config)
            }
        }
        .sheet(isPresented: $presentingQuickFix, onDismiss: { dismiss() }) {
            if let target = activeTarget {
                QuickFixSheet(
                    api: api,
                    target: target,
                    prefill: (number: iid, plan: editedPlan)
                )
                .environmentObject(config)
            }
        }
    }

    /// Active+cloned repo (GitLab or GitHub) the code workflow can run against.
    private var activeTarget: CodeWorkflowTarget? {
        CodeWorkflowTarget.resolveActive(config: config)
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
