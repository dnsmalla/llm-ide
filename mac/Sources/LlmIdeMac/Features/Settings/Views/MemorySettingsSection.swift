import SwiftUI

/// Project-scoped Settings card surfacing graph + memory state: whether a
/// graph exists, its node counts, when it was last generated, and which
/// agent-facing memory files are present. Graph-specific controls
/// (auto-update cadence, upload-truncation banner) live
/// in `Features/CodeGraph/Views/GraphSettingsSection.swift` instead — this file stays free of
/// any graph type so it (and `GraphMemoryState`) keep working when the Code
/// Graph feature is compiled out.
struct MemorySettingsSection: View {
    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject var theme: ThemeStore

    @State private var state: GraphMemoryState = .empty

    var body: some View {
        SettingsSectionCard(icon: "brain", title: "Memory") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                if !state.hasGraph && !state.anyMemoryFile {
                    Text("No graph or memory generated for this project yet. In builds that include Code Graph, open that view and generate a Code Graph / InfiniteBrain to populate it.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    statusRow("Knowledge graph", state.hasGraph ? "generated" : "not generated", ok: state.hasGraph)
                    if let counts = state.counts {
                        statusRow("Nodes", "\(counts.code) code · \(counts.doc) doc · \(counts.edges) edges", ok: true)
                    }
                    if let when = state.lastGenerated {
                        statusRow("Last generated", when, ok: true)
                    }
                    Divider().padding(.vertical, 2)
                    Text("Agent memory files (system/memory)")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    ForEach(state.memoryFiles) { f in
                        memoryFileRow(f)
                    }
                }
                Divider().padding(.vertical, 2)
                HStack {
                    Text(state.repoLabel)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button("Refresh") { refresh() }
                        .controlSize(.small)
                }
                .padding(.top, 2)
            }
        }
        .task(id: projectStore.activeProject?.bundle.id) { refresh() }
    }

    private func statusRow(_ label: String, _ value: String, ok: Bool) -> some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle")
                .font(.system(size: 11))
                .foregroundStyle(ok ? theme.current.accent : theme.current.textMuted)
            Text(label).font(Typography.body).foregroundStyle(theme.current.textMuted)
            Spacer()
            Text(value).font(Typography.body).foregroundStyle(theme.current.text)
        }
    }

    private func memoryFileRow(_ f: GraphMemoryState.MemFile) -> some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: f.present ? "doc.text.fill" : "doc")
                .font(.system(size: 10))
                .foregroundStyle(f.present ? theme.current.accent : theme.current.textMuted)
            Text(f.name).font(.system(size: 11, design: .monospaced)).foregroundStyle(theme.current.text)
            Spacer()
            Text(f.detail).font(Typography.caption).foregroundStyle(theme.current.textMuted)
        }
    }

    private func refresh() {
        let root = projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath) }
        state = GraphMemoryState.read(projectRoot: root)
    }
}
