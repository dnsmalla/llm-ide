import SwiftUI

/// Detail pane for a selected connector: what it ingests, how it
/// authenticates, whether its pipeline exists yet, a link to the provider's
/// docs, and Remove. Mirrors `McpPluginDetailView`'s load/act/remove shape.
///
/// Reads the catalog rather than the selected-list so the entry (and its
/// `selected` flag) is still resolvable the moment after a Remove, and so an
/// id the catalog dropped reports "not found" instead of rendering blank.
///
/// Like `McpPluginDetailView`, a mutation here doesn't push a refresh back to
/// the sidebar's own state — the sidebar catches up on the next Library load
/// or refresh.
struct ConnectorDetailView: View {
    @EnvironmentObject private var theme: ThemeStore
    let api: LlmIdeAPIClient
    let connectorId: String

    @State private var entry: ConnectorCatalogEntry?
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
                } else if let entry {
                    infoBlock(entry)
                    actionsRow(entry)
                } else {
                    Text("Connector not found — it may have been removed from the catalog.")
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: connectorId) { await load() }
    }

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: entry?.icon ?? "point.3.connected.trianglepath.dotted")
                .font(.system(size: 28))
                .foregroundStyle(entry?.pipelineReady == true ? theme.current.info : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry?.name ?? connectorId).font(.title2.bold())
                if let entry {
                    Text(entry.description).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func infoBlock(_ e: ConnectorCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Details").font(.headline)
            LabeledContent("Identifier", value: e.id)
            LabeledContent("Authentication", value: e.authKind)
            LabeledContent("Status", value: e.pipelineReady ? "Ready" : "Pipeline coming soon")
            if !e.docsUrl.isEmpty, let url = URL(string: e.docsUrl) {
                Link("Provider documentation", destination: url)
                    .font(.callout)
            }
            if e.pipelineReady {
                Text("Configure credentials and what to ingest in Settings → Connections.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Selected connectors show a card in Settings → Connections. This one's fetch pipeline lands in an upcoming update — nothing is ingested yet.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func actionsRow(_ e: ConnectorCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Button("Remove", role: .destructive) { Task { await remove() } }
                    .disabled(busy || !e.selected)
                if !e.selected {
                    Text("Not currently added.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Text("Removing hides this connector's card. Files, notes, and credentials it already produced are kept.")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Data + actions

    private func load() async {
        loaded = false
        loadError = nil
        do {
            let catalog = try await api.fetchConnectorCatalog()
            self.entry = catalog.first { $0.id == connectorId }
        } catch {
            self.loadError = error.localizedDescription
        }
        loaded = true
    }

    private func remove() async {
        busy = true
        defer { busy = false }
        do {
            try await api.removeConnector(id: connectorId)
            await load()
        } catch {
            loadError = error.localizedDescription
        }
    }
}
