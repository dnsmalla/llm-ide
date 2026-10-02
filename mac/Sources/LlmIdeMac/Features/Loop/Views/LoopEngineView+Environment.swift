// Loop Engineering detail pane — the read-only ENVIRONMENT section: what the
// project's environment looks like BEFORE a run, so a missing tool or a broken
// dependency is seen here instead of as a failed stage. Storage lives in
// LoopEngineView.swift (a SwiftUI extension cannot declare it).

import SwiftUI

extension LoopEngineView {

    // MARK: - Environment

    @ViewBuilder
    var environmentSection: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                SectionLabel("ENVIRONMENT")
                Spacer()
                if isInspectingEnvironment { ProgressView().controlSize(.small) }
                Button("Refresh") { Task { @MainActor in await refreshEnvironmentStatus() } }
                    .controlSize(.small)
                    .disabled(isInspectingEnvironment || activeGitRootURL == nil)
            }

            if let status = environmentStatus {
                Label(readinessText(status.readiness), systemImage: readinessSymbol(status.readiness))
                    .font(Typography.bodyStrong)
                    .foregroundStyle(readinessColor(status.readiness))
                if let command = status.recommendedTestCommand {
                    Text("Recommended test command: \(command)")
                        .font(Typography.body)
                        .foregroundStyle(t.text)
                }
                ForEach(Array(status.findings.enumerated()), id: \.offset) { _, finding in
                    Label(finding.message, systemImage: findingSymbol(finding.severity))
                        .font(Typography.caption)
                        .foregroundStyle(findingColor(finding.severity))
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if !isInspectingEnvironment {
                Text("Not inspected yet.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
            Text("Read-only: nothing is installed or changed.")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
        }
    }

    /// Re-inspects the active project. `@MainActor` because this view is not
    /// main-actor isolated and the results are written to @State.
    @MainActor
    func refreshEnvironmentStatus(clearing: Bool = false) async {
        if clearing { environmentStatus = nil }
        guard let gitRoot = activeGitRootURL else {
            environmentInspectionToken += 1
            isInspectingEnvironment = false
            environmentStatus = nil
            return
        }
        environmentInspectionToken += 1
        let token = environmentInspectionToken
        isInspectingEnvironment = true
        let facts = await ProjectEnvironmentInspector.inspect(repoRoot: gitRoot)
        // A newer run owns the in-progress flag and the result.
        guard token == environmentInspectionToken else { return }
        isInspectingEnvironment = false
        // The user may have switched project (or this task been cancelled)
        // while the commands ran: a stale answer must not be shown under
        // another project.
        guard !Task.isCancelled, activeGitRootURL == gitRoot else { return }
        environmentStatus = ProjectEnvironmentAssessor.assess(facts)
    }

    private func readinessText(_ readiness: ProjectEnvironmentStatus.Readiness) -> String {
        switch readiness {
        case .ready: return "Ready to run"
        case .needsSetup: return "Needs setup"
        case .unknown: return "Could not fully check"
        }
    }

    private func readinessSymbol(_ readiness: ProjectEnvironmentStatus.Readiness) -> String {
        switch readiness {
        case .ready: return "checkmark.circle.fill"
        case .needsSetup: return "exclamationmark.triangle.fill"
        case .unknown: return "questionmark.circle"
        }
    }

    private func readinessColor(_ readiness: ProjectEnvironmentStatus.Readiness) -> Color {
        switch readiness {
        case .ready: return .green
        case .needsSetup: return .orange
        case .unknown: return theme.current.textMuted
        }
    }

    private func findingSymbol(_ severity: ProjectEnvironmentStatus.Finding.Severity) -> String {
        switch severity {
        case .blocking: return "xmark.octagon.fill"
        case .warning: return "exclamationmark.triangle"
        case .info: return "info.circle"
        }
    }

    private func findingColor(_ severity: ProjectEnvironmentStatus.Finding.Severity) -> Color {
        switch severity {
        case .blocking: return .red
        case .warning: return .orange
        case .info: return theme.current.textMuted
        }
    }
}
