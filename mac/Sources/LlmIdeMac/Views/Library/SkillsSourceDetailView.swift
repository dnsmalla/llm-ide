import SwiftUI

/// Detail pane for a skills source: version/location/ref, and the
/// Update / Reveal / Remove actions the design doc calls for. The builtin
/// source shows "Install" instead of "Update" when its submodule isn't
/// checked out (the only source kind with a real re-fetch path when
/// missing — a local/git source with a missing directory can't be revived
/// by "Update" either, since fetch/checkout both need the dir to exist; the
/// fix there is Remove + re-add). Remove never shows for builtin — the
/// server rejects it anyway, this just avoids a pointless round trip.
///
/// Mutations here don't push a refresh back to the sidebar's own `[SkillsSourceInfo]`
/// state — matching `PluginDetailView`, which has the same gap (toggling a
/// plugin's enabled state in its detail pane doesn't refresh `LibraryView.plugins`
/// either). The sidebar catches up on the next full Library reload.
struct SkillsSourceDetailView: View {
    @EnvironmentObject private var theme: ThemeStore
    let api: LlmIdeAPIClient
    let sourceId: String

    @State private var source: LlmIdeAPIClient.SkillsSourceInfo?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var busy = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Divider()
                if !loaded {
                    ProgressView().controlSize(.small)
                } else if let err = loadError {
                    Text(err).foregroundStyle(theme.current.danger).font(.callout)
                } else if let source {
                    infoBlock(source)
                    actionsRow(source)
                } else {
                    Text("Source not found — it may have been removed.")
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: sourceId) { await load() }
    }

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "books.vertical.fill")
                .font(.system(size: 28))
                .foregroundStyle(source?.enabled == true ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(source?.name ?? sourceId).font(.title2.bold())
                if let source, let v = source.version, !v.isEmpty {
                    Text("v\(v)").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let source {
                Toggle("Enabled", isOn: Binding(
                    get: { source.enabled },
                    set: { newValue in Task { await toggle(newValue) } }
                ))
                .toggleStyle(.switch)
                .disabled(busy)
            }
        }
    }

    @ViewBuilder
    private func infoBlock(_ s: LlmIdeAPIClient.SkillsSourceInfo) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Details").font(.headline)
            LabeledContent("Origin", value: s.origin)
            if let loc = s.location { LabeledContent("Location", value: loc) }
            if let ref = s.ref { LabeledContent("Ref", value: ref) }
            LabeledContent("Skills", value: "\(s.skillCount)")
            if !s.installed {
                Text(s.builtin
                     ? "The bundled .skills submodule isn't checked out. Install to fetch it."
                     : "This source's directory is missing on disk. Remove and re-add it.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func actionsRow(_ s: LlmIdeAPIClient.SkillsSourceInfo) -> some View {
        HStack(spacing: 10) {
            Button(s.builtin && !s.installed ? "Install" : "Update") { Task { await update() } }
                .disabled(busy || (!s.builtin && !s.installed))
            if s.location != nil, s.installed {
                Button("Reveal in Finder") { reveal(s) }
                    .disabled(busy)
            }
            if !s.builtin {
                Button("Remove", role: .destructive) { Task { await remove() } }
                    .disabled(busy)
            }
        }
    }

    // MARK: - Data + actions

    private func load() async {
        loaded = false
        loadError = nil
        do {
            let sources = try await api.listSkillsSources()
            self.source = sources.first { $0.id == sourceId }
        } catch {
            self.loadError = error.localizedDescription
        }
        loaded = true
    }

    private func toggle(_ enabled: Bool) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.toggleSkillsSource(id: sourceId, enabled: enabled)
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func update() async {
        busy = true
        defer { busy = false }
        do {
            _ = try await api.updateSkillsSource(id: sourceId)
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func remove() async {
        busy = true
        defer { busy = false }
        do {
            try await api.removeSkillsSource(id: sourceId)
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func reveal(_ s: LlmIdeAPIClient.SkillsSourceInfo) {
        guard let loc = s.location else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: loc, isDirectory: true)])
    }
}
