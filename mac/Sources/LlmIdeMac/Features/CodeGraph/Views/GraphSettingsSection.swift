import SwiftUI

/// Project-scoped Settings card for the graph the app maintains in the
/// background: the auto-update cadence control and the truncation banner
/// from its most recent upload. Split out of the old combined
/// GraphMemorySettingsSection so this is the only Settings surface that
/// depends on GraphAutoUpdater — the memory-file listing itself lives in the
/// graph-agnostic `Views/Settings/MemorySettingsSection.swift`. Generation
/// itself happens in the Code Graph view; this card only exposes the
/// schedule + last-upload status.
struct GraphSettingsSection: View {
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var graphAutoUpdater: GraphAutoUpdater

    @State private var state: GraphMemoryState = .empty

    var body: some View {
        SettingsSectionCard(icon: "cube.transparent", title: "Code Graph") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack {
                    Text("Auto-update every")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    Spacer()
                    Stepper(value: Binding(
                        get: { config.graphAutoUpdateMinutes },
                        set: { v in
                            let m = max(5, v)
                            config.graphAutoUpdateMinutes = m
                            graphAutoUpdater.setIntervalMinutes(m)   // live reschedule
                        }
                    ), in: 5...120, step: 5) {
                        Text("\(config.graphAutoUpdateMinutes) min")
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundStyle(theme.current.text)
                    }
                    .frame(maxWidth: 170)
                }

                if let truncation = graphAutoUpdater.lastUploadTruncation,
                   truncation.repoPath == state.repoPath,
                   truncation.didTruncate {
                    StatusBanner(severity: .warning, message: truncation.summary)
                }
            }
        }
        .task(id: projectStore.activeProject?.bundle.id) { refresh() }
    }

    private func refresh() {
        let root = projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath) }
        state = GraphMemoryState.read(projectRoot: root)
    }
}
